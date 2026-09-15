from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session as DB

from .ingest import channel_catalog, gps_bbox, parse_gauge_s, write_session_files
from .laps import _speed_mps, match_layout, persist_laps
from .models import Lap, Layout, Session


def process_session(db: DB, session: Session, csv_path: Path) -> Session:
    session.status = "processing"
    session.error = ""
    db.commit()
    try:
        df = parse_gauge_s(csv_path)
        parquet, raw = write_session_files(session.id, csv_path, df)
        session.parquet_path = str(parquet)
        session.raw_csv_path = str(raw)
        session.sample_count = int(len(df))
        session.duration_ms = int(df["t_ms"].iloc[-1] - df["t_ms"].iloc[0]) if len(df) else 0
        session.started_at = _parse_started(df, session.filename)
        session.channels = channel_catalog(df)
        bbox = gps_bbox(df)
        session.bbox = bbox

        layout = session.layout
        if layout is None and bbox:
            lat = df["lat"].to_numpy(dtype=float)
            lon = df["lon"].to_numpy(dtype=float)
            speed = _speed_mps(df)
            dist = df["dist_m"].to_numpy(dtype=float)
            layout = match_layout(db, lat, lon, speed, dist)
            if layout:
                session.layout_id = layout.id

        gate = persist_laps(db, session, df, layout)
        flying_n = (
            db.query(Lap)
            .filter(Lap.session_id == session.id, Lap.kind == "valid")
            .count()
        )
        if flying_n and layout and not layout.sf_gate and gate:
            layout.sf_gate = gate

        session.status = "ready"
        db.commit()
        db.refresh(session)
        return session
    except Exception as exc:
        db.rollback()
        session.status = "error"
        session.error = str(exc)
        db.commit()
        raise


def _parse_started(df, filename):
    from .ingest import _parse_started_at

    return _parse_started_at(df, filename)


def reprocess(db: DB, session: Session) -> Session:
    if not session.raw_csv_path:
        raise ValueError("No raw CSV stored")
    return process_session(db, session, Path(session.raw_csv_path))
