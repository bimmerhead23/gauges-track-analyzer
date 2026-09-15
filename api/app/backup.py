"""Library backup / restore (.gsbak zip).

    python -m app.backup export /path/library.gsbak
    python -m app.backup restore /path/library.gsbak
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DB, joinedload

from .config import DATA_DIR
from .db import SessionLocal
from .filesafe import MAX_ARCHIVE_BYTES, MAX_UPLOAD_BYTES, check_zip, safe_filename
from .models import Lap, Layout, MathChannel, Sector, Session, Track, Vehicle
from .process import process_session
from .reset import reset_database
from .seed import DEFAULT_MATH

FORMAT = 1
MANIFEST = "manifest.json"


def _dt(v: datetime | None) -> str | None:
    if v is None:
        return None
    if v.tzinfo is None:
        return v.isoformat()
    return v.astimezone(timezone.utc).isoformat()


def _parse_dt(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _layout_key(track: str, name: str) -> tuple[str, str]:
    return ((track or "").strip().lower(), (name or "").strip().lower())


def _find_layout(db: DB, track_name: str, layout_name: str) -> Layout | None:
    want_t, want_l = _layout_key(track_name, layout_name)
    if not want_t or not want_l:
        return None
    for lay in db.query(Layout).options(joinedload(Layout.track)).all():
        t = lay.track.name if lay.track else ""
        if _layout_key(t, lay.name) == (want_t, want_l):
            return lay
    return None


def _safe_zip_name(name: str) -> str:
    p = Path(name)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError(f"unsafe path in archive: {name}")
    return name.replace("\\", "/")


def write_backup(db: DB, dest: Path) -> dict:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    sessions = (
        db.execute(
            select(Session)
            .options(
                joinedload(Session.layout).joinedload(Layout.track),
                joinedload(Session.laps).joinedload(Lap.sectors),
            )
            .order_by(Session.id)
        )
        .unique()
        .scalars()
        .all()
    )
    layouts = db.query(Layout).options(joinedload(Layout.track)).all()
    vehicles = [r[0] for r in db.query(Vehicle.name).order_by(Vehicle.name).all()]
    math_rows = db.query(MathChannel).order_by(MathChannel.id).all()

    layout_dump = []
    for lay in layouts:
        track_name = lay.track.name if lay.track else ""
        layout_dump.append(
            {
                "track": track_name,
                "name": lay.name,
                "sf_gate": lay.sf_gate,
                "sectors": lay.sectors or [],
                "pit_polygon": lay.pit_polygon,
            }
        )

    math_dump = [
        {
            "name": m.name,
            "expression": m.expression,
            "unit": m.unit,
            "color": m.color,
            "enabled": m.enabled,
        }
        for m in math_rows
    ]

    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            MANIFEST,
            json.dumps(
                {
                    "format": FORMAT,
                    "app": "gauge-s-track-analyzer",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "session_count": len(sessions),
                },
                indent=2,
            ),
        )
        zf.writestr("vehicles.json", json.dumps(vehicles, indent=2))
        zf.writestr("math_channels.json", json.dumps(math_dump, indent=2))
        zf.writestr("layouts.json", json.dumps(layout_dump, indent=2))

        for i, s in enumerate(sessions, start=1):
            prefix = f"sessions/{i:04d}"
            lay = s.layout
            csv_name = None
            parquet_name = None
            raw = Path(s.raw_csv_path or "")
            if raw.is_file():
                csv_name = "original.csv"
                zf.write(raw, f"{prefix}/{csv_name}")
            pq = Path(s.parquet_path or "")
            if pq.is_file():
                parquet_name = "samples.parquet"
                zf.write(pq, f"{prefix}/{parquet_name}")
            meta = {
                "filename": s.filename,
                "started_at": _dt(s.started_at),
                "created_at": _dt(s.created_at),
                "duration_ms": s.duration_ms,
                "vehicle": s.vehicle,
                "track": lay.track.name if lay and lay.track else None,
                "layout": lay.name if lay else None,
                "sample_count": s.sample_count,
                "status": s.status,
                "error": s.error,
                "notes": s.notes,
                "log_sheet": s.log_sheet or {},
                "analysis_settings": s.analysis_settings or {},
                "channels": s.channels or [],
                "bbox": s.bbox,
                "files": {"csv": csv_name, "parquet": parquet_name},
            }
            zf.writestr(f"{prefix}/meta.json", json.dumps(meta, indent=2))
            laps = []
            for lap in sorted(s.laps, key=lambda x: x.number):
                laps.append(
                    {
                        "number": lap.number,
                        "t_start_ms": lap.t_start_ms,
                        "t_end_ms": lap.t_end_ms,
                        "time_ms": lap.time_ms,
                        "distance_m": lap.distance_m,
                        "kind": lap.kind,
                        "is_best": lap.is_best,
                        "sectors": [
                            {
                                "index": sec.index,
                                "time_ms": sec.time_ms,
                                "distance_m": sec.distance_m,
                            }
                            for sec in sorted(lap.sectors, key=lambda x: x.index)
                        ],
                    }
                )
            zf.writestr(f"{prefix}/laps.json", json.dumps(laps, indent=2))

    return {"ok": True, "path": str(dest), "sessions": len(sessions)}


def restore_backup(db: DB, src: Path) -> dict:
    src = Path(src)
    if not src.is_file():
        raise FileNotFoundError(src)
    if src.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Backup file is too large")
    with zipfile.ZipFile(src, "r") as zf:
        check_zip(zf)
        names = {_safe_zip_name(n) for n in zf.namelist() if not n.endswith("/")}
        if MANIFEST not in names:
            raise ValueError("Not a Gauge.S library backup (missing manifest.json)")
        manifest = json.loads(zf.read(MANIFEST))
        fmt = int(manifest.get("format") or 0)
        if fmt != FORMAT:
            raise ValueError(f"Unsupported backup format {fmt}")

        def load_json(name: str, default):
            if name not in names:
                return default
            return json.loads(zf.read(name))

        vehicles = load_json("vehicles.json", [])
        math_dump = load_json("math_channels.json", [])
        layout_dump = load_json("layouts.json", [])
        session_dirs = sorted(
            {n.split("/")[1] for n in names if n.startswith("sessions/") and len(n.split("/")) >= 3}
        )

        reset_database(db)

        for spec in layout_dump:
            lay = _find_layout(db, spec.get("track") or "", spec.get("name") or "")
            if not lay:
                continue
            if spec.get("sf_gate"):
                lay.sf_gate = spec["sf_gate"]
            if spec.get("sectors"):
                lay.sectors = spec["sectors"]
            if spec.get("pit_polygon") is not None:
                lay.pit_polygon = spec["pit_polygon"]

        for name in vehicles:
            n = str(name).strip()[:120]
            if not n:
                continue
            if not db.query(Vehicle).filter(Vehicle.name == n).first():
                db.add(Vehicle(name=n))

        db.execute(delete(MathChannel))
        rows = math_dump or list(DEFAULT_MATH)
        for m in rows:
            expr = str(m.get("expression") or "")[:200]
            if not re.fullmatch(r"[0-9A-Za-z_ \t.+\-*/()><=,&|]*", expr):
                continue
            db.add(
                MathChannel(
                    name=str(m.get("name") or "Channel")[:80],
                    expression=expr,
                    unit=str(m.get("unit") or "")[:24],
                    color=str(m.get("color") or "#d29922")[:16],
                    enabled=bool(m.get("enabled", True)),
                )
            )
        db.commit()

        restored = 0
        for folder in session_dirs:
            prefix = f"sessions/{folder}"
            meta_name = f"{prefix}/meta.json"
            if meta_name not in names:
                continue
            meta = json.loads(zf.read(meta_name))
            session = Session(
                filename=str(meta.get("filename") or f"{folder}.csv")[:255],
                started_at=_parse_dt(meta.get("started_at")),
                duration_ms=int(meta.get("duration_ms") or 0),
                vehicle=str(meta.get("vehicle") or "")[:120],
                sample_count=int(meta.get("sample_count") or 0),
                status=str(meta.get("status") or "ready")[:24],
                error=str(meta.get("error") or ""),
                notes=str(meta.get("notes") or ""),
                log_sheet=meta.get("log_sheet") if isinstance(meta.get("log_sheet"), dict) else {},
                analysis_settings=meta.get("analysis_settings")
                if isinstance(meta.get("analysis_settings"), dict)
                else {},
                channels=meta.get("channels") if isinstance(meta.get("channels"), list) else [],
                bbox=meta.get("bbox") if isinstance(meta.get("bbox"), dict) else None,
                created_at=_parse_dt(meta.get("created_at")) or datetime.utcnow(),
            )
            lay = _find_layout(db, meta.get("track") or "", meta.get("layout") or "")
            if lay:
                session.layout_id = lay.id
            db.add(session)
            db.commit()
            db.refresh(session)

            dest_dir = DATA_DIR / "sessions" / str(session.id)
            dest_dir.mkdir(parents=True, exist_ok=True)
            files = meta.get("files") or {}
            csv_arc = files.get("csv")
            raw_path = None
            if csv_arc and f"{prefix}/{csv_arc}" in names:
                blob = zf.read(f"{prefix}/{csv_arc}")
                if len(blob) > MAX_UPLOAD_BYTES:
                    raise ValueError("CSV in archive is too large")
                raw_path = dest_dir / safe_filename(meta.get("filename") or csv_arc)
                raw_path.write_bytes(blob)
                session.raw_csv_path = str(raw_path)
            if raw_path:
                try:
                    process_session(db, session, raw_path)
                except Exception as exc:
                    session.status = "error"
                    session.error = str(exc)
                    db.commit()
            else:
                session.status = "error"
                session.error = "Backup session had no CSV"
                db.commit()
            restored += 1

    return {
        "ok": True,
        "sessions": db.query(Session).count(),
        "restored": restored,
        "tracks": db.query(Track).count(),
        "layouts": db.query(Layout).count(),
    }


def export_to_temp(db: DB) -> Path:
    fd, name = tempfile.mkstemp(prefix="gauges-library-", suffix=".gsbak")
    os.close(fd)
    path = Path(name)
    try:
        write_backup(db, path)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def main(argv: list[str] | None = None) -> None:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2 or args[0] not in ("export", "restore"):
        raise SystemExit("usage: python -m app.backup export|restore <file.gsbak>")
    cmd, path = args[0], Path(args[1])
    db = SessionLocal()
    try:
        if cmd == "export":
            result = write_backup(db, path)
            print(f"Wrote {result['sessions']} sessions to {path}")
        else:
            result = restore_backup(db, path)
            print(
                "Restored",
                f"{result['restored']} sessions,",
                f"{result['tracks']} tracks,",
                f"{result['layouts']} layouts.",
            )
    finally:
        db.close()


if __name__ == "__main__":
    main()
