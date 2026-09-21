import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session as DB, joinedload

from ..config import DATA_DIR, is_demo
from ..db import get_db
from ..filesafe import MAX_DEMO_SESSIONS, safe_filename, save_upload
from ..models import Lap, Layout, Sector, Session, Vehicle
from ..ingest import enrich_channel_units
from ..process import process_session, reprocess
from ..reset import reset_database
from ..serialize import session_out

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _purge_session(db: DB, session_id: int) -> None:
    lap_ids = [r[0] for r in db.query(Lap.id).filter(Lap.session_id == session_id).all()]
    if lap_ids:
        db.query(Sector).filter(Sector.lap_id.in_(lap_ids)).delete(synchronize_session=False)
        db.query(Lap).filter(Lap.id.in_(lap_ids)).delete(synchronize_session=False)
    s = db.get(Session, session_id)
    if s:
        db.delete(s)
    db.commit()
    folder = DATA_DIR / "sessions" / str(session_id)
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)


LOG_SHEET_TEXT = {
    "weather": 40,
    "wind": 40,
    "tyre_set": 80,
    "tyre_health": 40,
    "fuel": 40,
    "wing": 80,
    "setup": 400,
}
LOG_SHEET_NUM = ("ambient_f", "track_temp_f", "pressure_fl", "pressure_fr", "pressure_rl", "pressure_rr")


def remember_vehicle(db: DB, name: str) -> str:
    name = (name or "").strip()[:120]
    if not name:
        return ""
    existing = db.query(Vehicle).filter(func.lower(Vehicle.name) == name.lower()).first()
    if existing:
        return existing.name
    db.add(Vehicle(name=name))
    db.flush()
    return name


def list_vehicle_names(db: DB) -> list[str]:
    rows = db.query(Vehicle.name).order_by(func.lower(Vehicle.name)).all()
    return [r[0] for r in rows]


def clean_log_sheet(raw: dict | None) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, lim in LOG_SHEET_TEXT.items():
        if k not in raw:
            continue
        v = raw[k]
        if v is None:
            continue
        s = str(v).strip()
        if s:
            out[k] = s[:lim]
    for k in LOG_SHEET_NUM:
        if k not in raw:
            continue
        v = raw[k]
        if v is None or v == "":
            continue
        try:
            out[k] = round(float(v), 2)
        except (TypeError, ValueError):
            continue
    return out


def clean_analysis_settings(raw: dict | None) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    plotted = raw.get("plotted")
    if isinstance(plotted, list):
        out["plotted"] = [str(x)[:80] for x in plotted if x][:40]
    scale = raw.get("chScale")
    if isinstance(scale, dict):
        cleaned: dict = {}
        for k, v in list(scale.items())[:40]:
            if not isinstance(v, dict):
                continue
            mn, mx = v.get("min"), v.get("max")
            try:
                cleaned[str(k)[:80]] = {
                    "min": None if mn is None else float(mn),
                    "max": None if mx is None else float(mx),
                }
            except (TypeError, ValueError):
                continue
        out["chScale"] = cleaned
    try:
        w = int(raw.get("mapWidth"))
        if 180 <= w <= 900:
            out["mapWidth"] = w
    except (TypeError, ValueError):
        pass
    mc = raw.get("mapColor")
    if isinstance(mc, str) and mc[:40]:
        out["mapColor"] = mc[:40]
    units = raw.get("units")
    if units in ("metric", "imperial"):
        out["units"] = units
    gp = raw.get("gatePreset")
    if isinstance(gp, str) and gp[:24]:
        out["gatePreset"] = gp[:24]
    gates = raw.get("gates")
    if isinstance(gates, list):
        cleaned_g = []
        for g in gates[:8]:
            if not isinstance(g, dict):
                continue
            ch, op = str(g.get("channel") or "")[:40], str(g.get("op") or "")[:4]
            if op not in (">", ">=", "<", "<="):
                continue
            try:
                cleaned_g.append({"channel": ch, "op": op, "value": float(g.get("value"))})
            except (TypeError, ValueError):
                continue
        out["gates"] = cleaned_g
    return out


class SessionPatch(BaseModel):
    vehicle: str | None = None
    notes: str | None = None
    layout_id: int | None = None
    log_sheet: dict | None = None
    analysis_settings: dict | None = None


@router.post("/reset")
def reset_all(db: DB = Depends(get_db)):
    """Delete every session, lap, and stored file; restore the track catalog."""
    if is_demo():
        raise HTTPException(403, "Public demo — the library resets nightly.")
    return reset_database(db)


@router.get("")
def list_sessions(db: DB = Depends(get_db)):
    rows = (
        db.query(Session)
        .options(joinedload(Session.layout).joinedload(Layout.track), joinedload(Session.laps))
        .order_by(Session.started_at.is_(None), Session.started_at.desc(), Session.id.desc())
        .all()
    )
    return [session_out(s) for s in rows]


@router.get("/vehicles")
def vehicles(db: DB = Depends(get_db)):
    return {"vehicles": list_vehicle_names(db)}


@router.get("/{session_id}")
def get_session(session_id: int, db: DB = Depends(get_db)):
    s = (
        db.query(Session)
        .options(
            joinedload(Session.layout).joinedload(Layout.track),
            joinedload(Session.laps),
        )
        .filter(Session.id == session_id)
        .first()
    )
    if not s:
        raise HTTPException(404, "Session not found")
    if enrich_channel_units(s):
        db.commit()
    return session_out(s, include_laps=True)


@router.get("/{session_id}/original.csv")
def original_csv(session_id: int, db: DB = Depends(get_db)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    path = Path(s.raw_csv_path or "")
    if not path.is_file():
        raise HTTPException(404, "Original CSV is not stored for this session")
    name = safe_filename(s.filename or path.name)
    return FileResponse(path, media_type="text/csv", filename=name)


@router.post("/upload")
async def upload(file: UploadFile = File(...), db: DB = Depends(get_db)):
    name = safe_filename(file.filename or "")
    if not name.lower().endswith(".csv"):
        raise HTTPException(400, "Upload a Gauge.S .csv file")
    if is_demo() and db.query(Session).count() >= MAX_DEMO_SESSIONS:
        raise HTTPException(429, "Demo library is full until the nightly reset")
    tmp = DATA_DIR / "incoming"
    dest = tmp / f"{uuid4().hex}.csv"
    await save_upload(file, dest)
    session = Session(filename=name, status="processing")
    db.add(session)
    db.commit()
    db.refresh(session)
    sid = session.id
    try:
        try:
            process_session(db, session, dest)
        except HTTPException:
            _purge_session(db, sid)
            raise
        except Exception as exc:
            _purge_session(db, sid)
            raise HTTPException(400, f"Ingest failed: {exc}") from exc
    finally:
        dest.unlink(missing_ok=True)
    s = (
        db.query(Session)
        .options(joinedload(Session.layout).joinedload(Layout.track), joinedload(Session.laps))
        .filter(Session.id == sid)
        .first()
    )
    known = bool(s and s.layout_id)
    if not s or not known:
        _purge_session(db, sid)
        raise HTTPException(422, "Not enough GPS to place this log on a track")
    return session_out(s, include_laps=True)


@router.patch("/{session_id}")
def patch_session(session_id: int, body: SessionPatch, db: DB = Depends(get_db)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if body.vehicle is not None:
        s.vehicle = remember_vehicle(db, body.vehicle)
    if body.notes is not None:
        s.notes = str(body.notes)[:2000]
    if body.log_sheet is not None:
        s.log_sheet = clean_log_sheet(body.log_sheet)
    if body.analysis_settings is not None:
        s.analysis_settings = clean_analysis_settings(body.analysis_settings)
    if body.layout_id is not None:
        s.layout_id = body.layout_id
    db.commit()
    return session_out(s, include_laps=True)


@router.post("/{session_id}/reprocess")
def reprocess_session(session_id: int, db: DB = Depends(get_db)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    try:
        reprocess(db, s)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    s = (
        db.query(Session)
        .options(joinedload(Session.layout).joinedload(Layout.track), joinedload(Session.laps))
        .filter(Session.id == session_id)
        .first()
    )
    return session_out(s, include_laps=True)


@router.delete("/{session_id}")
def delete_session(session_id: int, db: DB = Depends(get_db)):
    if is_demo():
        raise HTTPException(403, "Public demo — the library resets nightly.")
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    folder = DATA_DIR / "sessions" / str(s.id)
    db.delete(s)
    db.commit()
    if folder.exists():
        import shutil

        shutil.rmtree(folder, ignore_errors=True)
    return {"ok": True}
