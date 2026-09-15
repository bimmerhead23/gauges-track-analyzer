from pathlib import Path

from .models import Lap, Layout, MathChannel, Sector, Session, Track


def sector_out(s: Sector) -> dict:
    return {"id": s.id, "index": s.index, "time_ms": s.time_ms, "distance_m": s.distance_m}


def lap_out(l: Lap, include_sectors: bool = True) -> dict:
    d = {
        "id": l.id,
        "session_id": l.session_id,
        "number": l.number,
        "t_start_ms": l.t_start_ms,
        "t_end_ms": l.t_end_ms,
        "time_ms": l.time_ms,
        "distance_m": round(l.distance_m, 1),
        "kind": l.kind,
        "is_best": l.is_best,
    }
    if include_sectors:
        d["sectors"] = [sector_out(s) for s in sorted(l.sectors, key=lambda x: x.index)]
    return d


def layout_out(lay: Layout | None) -> dict | None:
    if not lay:
        return None
    return {
        "id": lay.id,
        "track_id": lay.track_id,
        "name": lay.name,
        "direction": lay.direction,
        "length_m": lay.length_m,
        "centroid_lat": lay.centroid_lat,
        "centroid_lon": lay.centroid_lon,
        "match_radius_m": lay.match_radius_m,
        "sf_gate": lay.sf_gate,
        "sectors": lay.sectors or [],
        "pit_polygon": lay.pit_polygon,
        "turns": lay.turns or {},
        "track_name": lay.track.name if lay.track else None,
        "venue": lay.track.venue if lay.track else None,
    }


def session_out(s: Session, include_laps: bool = False) -> dict:
    best = next((l for l in s.laps if l.is_best), None)
    valid = [l for l in s.laps if l.kind == "valid"]
    d = {
        "id": s.id,
        "filename": s.filename,
        "started_at": s.started_at.isoformat() if s.started_at else None,
        "duration_ms": s.duration_ms,
        "vehicle": s.vehicle,
        "layout_id": s.layout_id,
        "layout": layout_out(s.layout),
        "sample_count": s.sample_count,
        "status": s.status,
        "error": s.error,
        "notes": s.notes,
        "log_sheet": s.log_sheet or {},
        "analysis_settings": s.analysis_settings or {},
        "has_original": bool(s.raw_csv_path and Path(s.raw_csv_path).is_file()),
        "channels": s.channels or [],
        "bbox": s.bbox,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "lap_count": len(valid),
        "best_time_ms": best.time_ms if best else None,
    }
    if include_laps:
        d["laps"] = [lap_out(l) for l in sorted(s.laps, key=lambda x: x.number)]
    return d


def track_out(t: Track) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "venue": t.venue,
        "notes": t.notes,
        "layouts": [layout_out(l) for l in t.layouts],
    }


def math_out(m: MathChannel) -> dict:
    return {
        "id": m.id,
        "name": m.name,
        "key": m.name.lower().replace(" ", "_"),
        "expression": m.expression,
        "unit": m.unit,
        "color": m.color,
        "enabled": m.enabled,
    }
