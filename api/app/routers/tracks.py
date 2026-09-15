from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DB, joinedload

from ..db import get_db
from ..geo import propose_start_finish
from ..ingest import load_samples
from ..models import Layout, Session, Track
from ..serialize import layout_out, track_out

router = APIRouter(prefix="/tracks", tags=["tracks"])


class LayoutPatch(BaseModel):
    name: str | None = None
    direction: str | None = None
    length_m: float | None = None
    sf_gate: dict | None = None
    sectors: list | None = None
    pit_polygon: list | None = None
    centroid_lat: float | None = None
    centroid_lon: float | None = None
    reprocess: bool | None = None


class ProposeBody(BaseModel):
    session_id: int


@router.get("")
def list_tracks(db: DB = Depends(get_db)):
    rows = db.query(Track).options(joinedload(Track.layouts)).order_by(Track.name).all()
    return [track_out(t) for t in rows]


@router.patch("/layouts/{layout_id}")
def patch_layout(layout_id: int, body: LayoutPatch, db: DB = Depends(get_db)):
    lay = db.get(Layout, layout_id)
    if not lay:
        raise HTTPException(404, "Layout not found")
    data = body.model_dump(exclude_unset=True)
    data.pop("reprocess", None)
    for k, v in data.items():
        setattr(lay, k, v)
    db.commit()
    db.refresh(lay)
    session_ids = [
        sid
        for (sid,) in db.query(Session.id)
        .filter(Session.layout_id == lay.id, Session.raw_csv_path.isnot(None))
        .all()
    ]
    out = layout_out(lay)
    out["session_ids"] = session_ids
    return out


@router.post("/layouts/{layout_id}/propose-sf")
def propose_sf(layout_id: int, body: ProposeBody, db: DB = Depends(get_db)):
    lay = db.get(Layout, layout_id)
    sess = db.get(Session, body.session_id)
    if not lay or not sess or not sess.parquet_path:
        raise HTTPException(404, "Layout or session not found")
    df = load_samples(sess.parquet_path)
    import numpy as np

    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    hdg = df["heading_deg"].to_numpy(dtype=float)
    if "gps_speed" in df.columns:
        speed = df["gps_speed"].to_numpy(dtype=float) / 3.6
    else:
        speed = np.zeros(len(df))
    gate = propose_start_finish(lat, lon, hdg, speed)
    if not gate:
        raise HTTPException(400, "Could not propose a start/finish from this session")
    lay.sf_gate = gate
    db.commit()
    return layout_out(lay)
