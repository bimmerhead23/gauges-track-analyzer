from __future__ import annotations

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session as DB, joinedload

from ..db import get_db
from ..ingest import load_samples
from ..coach import briefing_hash, build_briefing, coach_available, laps_on_same_track, run_coach
from ..config import COACH_MODEL, COACH_PROVIDER
from ..models import CoachReport, Lap, Layout, MathChannel, Session
from ..channels import DISPLAY
from ..serialize import lap_out, math_out, sector_out
from ..traces import (
    align_lap_distance,
    apply_gates,
    downsample_xy,
    eclectic_best,
    interpolate_at_distance,
    lap_slice,
    mini_sectors,
    operating_map,
    parse_gates,
    range_stats,
    sector_distance_windows,
    series_for,
    stats,
    time_delta,
)
from ..turns import build_turns

router = APIRouter(tags=["analysis"])


def _gates(spec: str | None):
    try:
        return parse_gates(spec)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _laps(db: DB, ids: list[int]) -> list[Lap]:
    if not ids:
        return []
    rows = (
        db.query(Lap)
        .options(
            joinedload(Lap.session).joinedload(Session.layout).joinedload(Layout.track),
            joinedload(Lap.sectors),
        )
        .filter(Lap.id.in_(ids))
        .all()
    )
    by = {l.id: l for l in rows}
    missing = [i for i in ids if i not in by]
    if missing:
        raise HTTPException(404, f"Unknown laps: {missing}")
    return [by[i] for i in ids]


def _df_cache(laps: list[Lap]) -> dict[int, object]:
    cache = {}
    for lap in laps:
        sid = lap.session_id
        if sid not in cache:
            if not lap.session.parquet_path:
                raise HTTPException(400, f"Session {sid} has no samples")
            cache[sid] = load_samples(lap.session.parquet_path)
    return cache


def _aligned(laps: list[Lap], cache: dict, ref_lap_id: int | None):
    """Sector-align every lap onto the reference so overlay x is shared."""
    ref = next((l for l in laps if ref_lap_id and l.id == ref_lap_id), None)
    if ref is None and laps:
        flying = [l for l in laps if l.kind == "valid"]
        ref = min(flying or laps, key=lambda l: l.time_ms)
    ref_sl = lap_slice(cache[ref.session_id], ref) if ref is not None else None
    out = {}
    for lap in laps:
        sl = lap_slice(cache[lap.session_id], lap)
        if ref is not None and ref_sl is not None and lap.id != ref.id:
            sl = align_lap_distance(sl, lap, ref_sl, ref)
        out[lap.id] = sl
    return out, ref, ref_sl


@router.get("/laps")
def get_laps(ids: str = Query(""), session_id: int | None = None, db: DB = Depends(get_db)):
    if ids:
        parsed = [int(x) for x in ids.split(",") if x]
        return [lap_out(l) for l in _laps(db, parsed)]
    if session_id:
        rows = (
            db.query(Lap)
            .options(joinedload(Lap.sectors))
            .filter(Lap.session_id == session_id)
            .order_by(Lap.number)
            .all()
        )
        return [lap_out(l) for l in rows]
    raise HTTPException(400, "ids or session_id required")


class LapPatch(BaseModel):
    kind: str | None = None


@router.patch("/laps/{lap_id}")
def patch_lap(lap_id: int, body: LapPatch, db: DB = Depends(get_db)):
    lap = db.get(Lap, lap_id)
    if not lap:
        raise HTTPException(404, "Lap not found")
    if body.kind:
        if body.kind not in {"valid", "out", "in", "pit", "invalid"}:
            raise HTTPException(400, "kind must be valid, out, in, pit, or invalid")
        from ..config import is_demo

        if is_demo():
            raise HTTPException(403, "Public demo — lap labels are read-only")
        lap.kind = body.kind
        # recompute best
        sibs = db.query(Lap).filter(Lap.session_id == lap.session_id).all()
        valid = [l for l in sibs if l.kind == "valid"]
        best = min((l.time_ms for l in valid), default=None)
        for l in sibs:
            l.is_best = bool(best is not None and l.kind == "valid" and l.time_ms == best)
    db.commit()
    db.refresh(lap)
    return lap_out(lap)


@router.get("/traces")
def traces(
    lap_ids: str,
    channels: str = "gps_speed_mph,rpm,tps,brake,gps_long_g,gps_lat_g",
    max_points: int = 2500,
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    cache = _df_cache(laps)
    slices, ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    out = []
    for lap in laps:
        sl = slices[lap.id]
        x = sl["lap_dist_m"].to_numpy(dtype=float) if not sl.empty else []
        series = {}
        for k in keys:
            y = series_for(sl, k, math) if not sl.empty else None
            if y is None:
                series[k] = {"x": [], "y": []}
                continue
            xs, ys = downsample_xy(x, y, max_points)
            series[k] = {"x": xs, "y": ys}
        out.append({
            "lap_id": lap.id,
            "session_id": lap.session_id,
            "number": lap.number,
            "time_ms": lap.time_ms,
            "kind": lap.kind,
            "is_best": lap.is_best,
            "series": series,
        })
    return out


@router.get("/cursor")
def cursor(
    lap_ids: str,
    dist_m: float,
    channels: str = "gps_speed_mph,rpm,tps,brake,gps_long_g,gps_lat_g,speed_mph,oil_temp,coolant,afr",
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    cache = _df_cache(laps)
    slices, _ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    values = []
    for lap in laps:
        sl = slices[lap.id]
        values.append({"lap_id": lap.id, **interpolate_at_distance(sl, dist_m, keys, math)})
    return {"dist_m": dist_m, "values": values}


@router.get("/ab")
def ab_range(
    lap_ids: str,
    dist_a: float,
    dist_b: float,
    channels: str = "gps_speed_mph,tps,brake",
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    cache = _df_cache(laps)
    slices, _ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    rows = []
    for lap in laps:
        sl = slices[lap.id]
        stats_row = range_stats(sl, dist_a, dist_b, keys, math)
        if stats_row is None:
            continue
        rows.append({"lap_id": lap.id, "number": lap.number, **stats_row})
    return {
        "dist_a": min(dist_a, dist_b),
        "dist_b": max(dist_a, dist_b),
        "delta_m": abs(dist_b - dist_a),
        "laps": rows,
    }


@router.get("/delta")
def delta(ref_lap_id: int, lap_ids: str, db: DB = Depends(get_db)):
    ids = [int(x) for x in lap_ids.split(",") if x]
    if ref_lap_id not in ids:
        ids = [ref_lap_id] + ids
    laps = _laps(db, ids)
    cache = _df_cache(laps)
    slices, ref_lap, ref_sl = _aligned(laps, cache, ref_lap_id)
    if ref_sl is None:
        ref_sl = slices[ref_lap_id]
    series = []
    for lap in laps:
        series.append({"lap_id": lap.id, **time_delta(ref_sl, slices[lap.id])})
    return {"ref_lap_id": ref_lap.id if ref_lap is not None else ref_lap_id, "aligned": True, "series": series}


def _json_floats(arr: np.ndarray) -> list:
    return [None if v is None or not np.isfinite(v) else float(v) for v in arr]


@router.get("/map")
def map_traces(
    lap_ids: str,
    max_points: int = 2000,
    channels: str = "gps_speed_mph,tps,brake,afr",
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    cache = _df_cache(laps)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all() if keys else []
    slices, ref, ref_sl = _aligned(laps, cache, ref_lap_id)
    out = []
    for lap in laps:
        sl = slices[lap.id]
        if sl.empty or "lat" not in sl.columns:
            out.append({"lap_id": lap.id, "lat": [], "lon": [], "dist": [], "values": {}})
            continue
        lat = sl["lat"].to_numpy(dtype=float)
        lon = sl["lon"].to_numpy(dtype=float)
        dist = sl["lap_dist_m"].to_numpy(dtype=float)
        n = min(len(lat), len(lon), len(dist))
        lat, lon, dist = lat[:n], lon[:n], dist[:n]
        # A GPS gap is NaN. One NaN fails the whole response (JSON has no NaN),
        # which blanks the map for every lap in the selection.
        good = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(dist)
        if int(good.sum()) < 2:
            out.append({"lap_id": lap.id, "lat": [], "lon": [], "dist": [], "values": {}})
            continue
        lat, lon, dist = lat[good], lon[good], dist[good]
        step = max(1, len(lat) // max_points)
        values: dict[str, list] = {}
        for k in keys:
            y = series_for(sl, k, math)
            if y is None or len(y) < n:
                values[k] = []
                continue
            y = np.asarray(y[:n], dtype=float)[good]
            values[k] = _json_floats(np.asarray(y[::step], dtype=float))
        out.append({
            "lap_id": lap.id,
            "lat": _json_floats(lat[::step]),
            "lon": _json_floats(lon[::step]),
            "dist": _json_floats(dist[::step]),
            "values": values,
        })
    turns = []
    if ref is not None and ref_sl is not None and not getattr(ref_sl, "empty", True):
        length = float(ref.distance_m or 0)
        if "lap_dist_m" in ref_sl.columns and len(ref_sl):
            length = max(length, float(ref_sl["lap_dist_m"].iloc[-1]))
        layout = ref.session.layout if ref.session else None
        turns = build_turns(ref_sl, layout, length or 1.0)
    return {"laps": out, "turns": turns, "ref_lap_id": ref.id if ref else None}


def _sector_channel_stats(sl, lap, keys, math) -> dict[int, dict]:
    if sl is None or sl.empty or not keys:
        return {}
    out: dict[int, dict] = {}
    for w in sector_distance_windows(lap, sl):
        st = range_stats(sl, w["d0"], w["d1"], keys, math) or {}
        out[int(w["index"])] = {
            "d0_m": round(w["d0"], 1),
            "d1_m": round(w["d1"], 1),
            "channels": st.get("channels") or {},
        }
    return out


@router.get("/splits")
def splits(
    lap_ids: str,
    channels: str = "gps_speed_mph,tps,brake,gps_long_g,afr",
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    cache = _df_cache(laps)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all() if keys else []
    length = 0.0
    for lap in laps:
        if lap.session.layout:
            length = max(length, lap.session.layout.length_m)
        length = max(length, lap.distance_m)
    length = length or 5000
    rows = []
    all_minis = []
    slices: list[tuple] = []
    for lap in laps:
        sl = lap_slice(cache[lap.session_id], lap)
        slices.append((lap, sl))
        minis = mini_sectors(sl, length)
        all_minis.append(minis)
        ch_stats = _sector_channel_stats(sl, lap, keys, math)
        sectors = []
        for s in sorted(lap.sectors, key=lambda x: x.index):
            extra = ch_stats.get(s.index) or {}
            sectors.append({**sector_out(s), **extra})
        rows.append({
            **lap_out(lap, include_sectors=False),
            "sectors": sectors,
            "mini": minis,
            "session_started_at": lap.session.started_at.isoformat() if lap.session.started_at else None,
            "filename": lap.session.filename,
        })
    # purple = fastest mini index across selection (mini-bar only)
    purple = []
    if all_minis:
        n = min(len(m) for m in all_minis) if all_minis else 0
        for i in range(n):
            best = min(m[i]["time_ms"] for m in all_minis if len(m) > i)
            purple.append(best)
    virtual = eclectic_best(slices)
    rolling_ms = min((r["time_ms"] for r in rows if r["kind"] == "valid"), default=None)
    return {
        "laps": rows,
        "purple_ms": purple,
        "virtual": virtual,
        "theoretical_ms": virtual["time_ms"] if virtual else None,
        "rolling_ms": rolling_ms,
        "length_m": length,
    }


@router.get("/report")
def report(
    lap_ids: str,
    channels: str = "gps_speed_mph,rpm,tps,brake,gps_long_g,gps_lat_g,oil_temp,coolant,oil_psi,afr,battery",
    gates: str | None = None,
    dist_min: float | None = None,
    dist_max: float | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    keys = [c.strip() for c in channels.split(",") if c.strip()]
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    parsed = _gates(gates)
    cache = _df_cache(laps)
    rows = []
    for lap in laps:
        sl = lap_slice(cache[lap.session_id], lap)
        mask = apply_gates(sl, math, parsed, dist_min, dist_max)
        ch = {k: stats(sl, k, math, mask) for k in keys}
        n = int(mask.sum()) if len(mask) else 0
        frac = float(mask.mean()) if len(mask) else 0.0
        rows.append({
            **lap_out(lap, include_sectors=False),
            "channels": ch,
            "gate_n": n,
            "gate_frac": frac,
        })
    return rows


@router.get("/scatter")
def scatter(
    lap_ids: str,
    x: str = "gps_lat_g",
    y: str = "gps_long_g",
    max_points: int = 2500,
    gates: str | None = None,
    dist_min: float | None = None,
    dist_max: float | None = None,
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    ids = [int(k) for k in lap_ids.split(",") if k]
    laps = _laps(db, ids)
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    parsed = _gates(gates)
    cache = _df_cache(laps)
    slices, _ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    out = []
    for lap in laps:
        sl = slices[lap.id]
        xv = series_for(sl, x, math)
        yv = series_for(sl, y, math)
        if xv is None or yv is None or sl.empty:
            out.append({"lap_id": lap.id, "x": [], "y": [], "dist": []})
            continue
        d = sl["lap_dist_m"].to_numpy(dtype=float)
        mask = apply_gates(sl, math, parsed, dist_min, dist_max)
        n = min(len(xv), len(yv), len(d), len(mask))
        xv, yv, d, mask = xv[:n], yv[:n], d[:n], mask[:n]
        xv, yv, d = xv[mask], yv[mask], d[mask]
        if len(xv) == 0:
            out.append({"lap_id": lap.id, "x": [], "y": [], "dist": []})
            continue
        step = max(1, len(xv) // max_points)
        out.append({
            "lap_id": lap.id,
            "dist": d[::step].astype(float).tolist(),
            "x": xv[::step].astype(float).tolist(),
            "y": yv[::step].astype(float).tolist(),
        })
    return {"x": x, "y": y, "series": out, "gates": gates or ""}


@router.get("/histogram")
def histogram(
    lap_ids: str,
    channel: str = "gps_speed_mph",
    bins: int = 24,
    dist_min: float | None = None,
    dist_max: float | None = None,
    threshold: float | None = None,
    gates: str | None = None,
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    """Time-weighted histogram with shared bins across laps.

    Bars are seconds (and % of the window), not sample counts, so low-speed
    sections are not over-represented. Optional dist_min/dist_max clip to an
    overlay zoom window. Optional gates (e.g. brake>10) keep only matching samples.
    """
    ids = [int(k) for k in lap_ids.split(",") if k]
    laps = _laps(db, ids)
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    parsed = _gates(gates)
    cache = _df_cache(laps)
    slices, _ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    import numpy as np

    bins = int(min(60, max(8, bins)))
    prepared: list[tuple[int, np.ndarray, np.ndarray]] = []
    all_y: list[np.ndarray] = []
    for lap in laps:
        sl = slices[lap.id]
        y = series_for(sl, channel, math)
        if y is None or sl.empty:
            continue
        y = np.asarray(y, dtype=float)
        t = sl["t_ms"].to_numpy(dtype=float)
        n = min(len(y), len(t))
        y, t = y[:n], t[:n]
        dt = np.empty(n, dtype=float)
        if n > 1:
            dt[:-1] = np.diff(t) / 1000.0
            dt[-1] = dt[-2]
        else:
            dt[:] = 0.05
        dt = np.clip(dt, 0.0, 0.25)
        mask = apply_gates(sl, math, parsed, dist_min, dist_max)[:n]
        ok = np.isfinite(y) & np.isfinite(t) & mask
        y, dt = y[ok], dt[ok]
        if len(y) < 4:
            continue
        prepared.append((lap.id, y, dt))
        all_y.append(y)

    if not all_y:
        return {
            "channel": channel,
            "edges": [],
            "threshold": threshold,
            "gates": gates or "",
            "series": [],
        }

    cat = np.concatenate(all_y)
    lo = float(np.nanpercentile(cat, 0.5))
    hi = float(np.nanpercentile(cat, 99.5))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo = float(np.nanmin(cat))
        hi = float(np.nanmax(cat))
    if hi <= lo:
        hi = lo + 1.0
    edges = np.linspace(lo, hi, bins + 1)

    series = []
    for lap_id, y, dt in prepared:
        seconds, _ = np.histogram(y, bins=edges, weights=dt)
        total = float(seconds.sum()) or 1e-9
        tw_mean = float(np.average(y, weights=dt))
        order = np.argsort(y)
        cdf = np.cumsum(dt[order])
        cdf /= cdf[-1] if cdf[-1] else 1.0
        median = float(y[order][np.searchsorted(cdf, 0.5, side="left").clip(0, len(order) - 1)])
        above_s = None
        if threshold is not None and np.isfinite(threshold):
            above_s = float(dt[y >= threshold].sum())
        series.append({
            "lap_id": lap_id,
            "seconds": seconds.astype(float).tolist(),
            "pct": (100.0 * seconds / total).astype(float).tolist(),
            "stats": {
                "min": float(np.nanmin(y)),
                "max": float(np.nanmax(y)),
                "mean": tw_mean,
                "median": median,
                "total_s": float(seconds.sum()),
                "above_s": above_s,
            },
        })
    return {
        "channel": channel,
        "edges": edges.astype(float).tolist(),
        "threshold": threshold,
        "gates": gates or "",
        "window": {"dist_min": dist_min, "dist_max": dist_max},
        "series": series,
    }


@router.get("/afr-map")
def afr_map(
    lap_ids: str,
    gates: str | None = None,
    dist_min: float | None = None,
    dist_max: float | None = None,
    ref_lap_id: int | None = None,
    db: DB = Depends(get_db),
):
    """Mean AFR in RPM × throttle bins. Empty cells were never visited."""
    ids = [int(k) for k in lap_ids.split(",") if k]
    laps = _laps(db, ids)
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    parsed = _gates(gates)
    cache = _df_cache(laps)
    slices, _ref, _ref_sl = _aligned(laps, cache, ref_lap_id)
    items = [(lap, slices[lap.id]) for lap in laps]
    out = operating_map(
        items,
        math,
        x_key="rpm",
        y_key="tps",
        z_key="afr",
        gates=parsed,
        dist_min=dist_min,
        dist_max=dist_max,
    )
    out["gates"] = gates or ""
    out["window"] = {"dist_min": dist_min, "dist_max": dist_max}
    return out


_SKIP_EXPORT_COLS = {"date_raw"}
_LEAD_EXPORT = ["session_id", "filename", "vehicle", "lap", "kind", "lap_time_ms", "lap_t_ms", "lap_dist_m"]


def _export_col_name(key: str) -> str:
    meta = DISPLAY.get(key)
    if not meta:
        return key
    name, unit = meta
    return f"{name} ({unit})" if unit else name


@router.get("/export/laps.csv")
def export_laps_csv(lap_ids: str, db: DB = Depends(get_db)):
    """Full-rate analysis CSV of selected laps (our channel names, not the downsampled overlay)."""
    ids = [int(k) for k in lap_ids.split(",") if k]
    laps = _laps(db, ids)
    if not laps:
        raise HTTPException(400, "No laps")
    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    cache = _df_cache(laps)
    frames = []
    for lap in laps:
        sl = lap_slice(cache[lap.session_id], lap)
        if sl.empty:
            continue
        out = sl.copy()
        sess = lap.session
        out["session_id"] = lap.session_id
        out["filename"] = sess.filename if sess else ""
        out["vehicle"] = (sess.vehicle if sess else "") or ""
        out["lap"] = lap.number
        out["kind"] = lap.kind
        out["lap_time_ms"] = lap.time_ms
        for mc in math:
            key = mc.name.lower().replace(" ", "_")
            y = series_for(out, key, math)
            if y is not None and key not in out.columns:
                out[key] = y
        drop = [c for c in _SKIP_EXPORT_COLS if c in out.columns]
        if drop:
            out = out.drop(columns=drop)
        frames.append(out)

    if not frames:
        raise HTTPException(404, "No samples for those laps")

    import pandas as pd

    df = pd.concat(frames, ignore_index=True)
    lead = [c for c in _LEAD_EXPORT if c in df.columns]
    rest = [c for c in df.columns if c not in lead]
    df = df[lead + rest]
    rename = {c: _export_col_name(c) for c in df.columns if c not in lead}
    # keep identity columns as-is
    df = df.rename(columns=rename)
    csv = df.to_csv(index=False)
    track = ""
    if laps[0].session and laps[0].session.layout and laps[0].session.layout.track:
        track = laps[0].session.layout.track.name.replace(" ", "_")
    nums = "-".join(f"L{l.number}" for l in laps[:8])
    fname = f"{track or 'laps'}_{nums}.csv".replace("/", "-")
    return Response(
        content=csv.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def _moving_mask(sl: pd.DataFrame) -> np.ndarray:
    n = len(sl)
    if "gps_speed" in sl.columns:
        speed = sl["gps_speed"].to_numpy(dtype=float)
        return np.isfinite(speed) & (speed > 50)
    if "gps_speed_mph" in sl.columns:
        speed = sl["gps_speed_mph"].to_numpy(dtype=float) * 1.609344
        return np.isfinite(speed) & (speed > 50)
    return np.ones(n, dtype=bool)


def _finite_vals(sl: pd.DataFrame, key: str, mask: np.ndarray | None = None) -> np.ndarray | None:
    if key not in sl.columns:
        return None
    y = sl[key].to_numpy(dtype=float)
    m = np.isfinite(y)
    if mask is not None and len(mask) == len(y):
        m = m & mask
    if int(m.sum()) < 8:
        return None
    return y[m]


def _mechanical_items(sl: pd.DataFrame) -> list[dict]:
    """Lap health from the ECU channels Gauge.S already logged. Empty if absent."""
    if sl is None or sl.empty:
        return []
    items: list[dict] = []
    moving = _moving_mask(sl)
    oil = _finite_vals(sl, "oil_psi", moving)
    if oil is not None:
        med = float(np.median(oil))
        mn = float(np.min(oil))
        if med > 80:
            unit, low = "kPa", mn < 150
        elif med > 12:
            unit, low = "psi", mn < 20
        else:
            unit, low = "bar", mn < 1.5
        items.append({
            "key": "oil_psi",
            "label": "Oil P min",
            "value": round(mn, 2),
            "unit": unit,
            "flag": "low" if low else "",
        })
    for key, label, hot_c, hot_f in (
        ("coolant", "Coolant max", 115, 240),
        ("oil_temp", "Oil T max", 125, 260),
    ):
        vals = _finite_vals(sl, key)
        if vals is None:
            continue
        med = float(np.median(vals))
        mx = float(np.max(vals))
        if med > 140:
            unit, hot = "°F", mx > hot_f
        else:
            unit, hot = "°C", mx > hot_c
        items.append({
            "key": key,
            "label": label,
            "value": round(mx, 1),
            "unit": unit,
            "flag": "high" if hot else "",
        })
    if "afr" in sl.columns and "tps" in sl.columns:
        y = sl["afr"].to_numpy(dtype=float)
        tps = sl["tps"].to_numpy(dtype=float)
        all_afr = y[np.isfinite(y)]
        wot = np.isfinite(y) & np.isfinite(tps) & (tps >= 90)
        if all_afr.size >= 8 and int(wot.sum()) >= 8:
            sample = y[wot]
            med = float(np.median(all_afr))
            mx = float(np.max(sample))
            mn = float(np.min(sample))
            if med < 2.5:
                unit = "λ"
                flag = "lean" if mx > 1.08 else "rich" if mn < 0.78 else ""
            else:
                unit = "AFR"
                flag = "lean" if mx > 15.2 else "rich" if mn < 10.8 else ""
            shown = mx if flag == "lean" else mn if flag == "rich" else mx
            items.append({
                "key": "afr",
                "label": "AFR at WOT",
                "value": round(float(shown), 2),
                "unit": unit,
                "flag": flag,
            })
    return items


@router.get("/mechanical")
def mechanical(lap_ids: str, db: DB = Depends(get_db)):
    ids = [int(x) for x in lap_ids.split(",") if x]
    laps = _laps(db, ids)
    cache = _df_cache(laps)
    rows = []
    for lap in laps:
        sl = lap_slice(cache[lap.session_id], lap)
        rows.append({
            "lap_id": lap.id,
            "number": lap.number,
            "items": _mechanical_items(sl),
        })
    return {"laps": rows}


@router.get("/math-channels")
def list_math(db: DB = Depends(get_db)):
    return [math_out(m) for m in db.query(MathChannel).order_by(MathChannel.id).all()]


class MathIn(BaseModel):
    name: str
    expression: str
    unit: str = ""
    color: str = "#d29922"
    enabled: bool = True


@router.post("/math-channels")
def create_math(body: MathIn, db: DB = Depends(get_db)):
    from ..config import is_demo
    import re

    if is_demo():
        raise HTTPException(403, "Public demo — math channels are read-only")
    expr = (body.expression or "").strip()
    if len(expr) > 200 or not re.fullmatch(r"[0-9A-Za-z_ \t.+\-*/()><=,&|]+", expr):
        raise HTTPException(400, "Invalid math expression")
    m = MathChannel(**{**body.model_dump(), "expression": expr, "name": body.name[:80]})
    db.add(m)
    db.commit()
    db.refresh(m)
    return math_out(m)


@router.delete("/math-channels/{math_id}")
def delete_math(math_id: int, db: DB = Depends(get_db)):
    from ..config import is_demo

    if is_demo():
        raise HTTPException(403, "Public demo — math channels are read-only")
    m = db.get(MathChannel, math_id)
    if not m:
        raise HTTPException(404, "Not found")
    db.delete(m)
    db.commit()
    return {"ok": True}


class CoachIn(BaseModel):
    mode: str = "vs_fastest"
    lap_ids: list[int]
    subject_lap_id: int | None = None
    ref_lap_id: int | None = None
    force: bool = False
    view: dict | None = None


@router.get("/coach/status")
def coach_status():
    ok, reason = coach_available()
    return {"ok": ok, "reason": reason, "provider": COACH_PROVIDER, "model": COACH_MODEL}


@router.post("/coach")
def coach(body: CoachIn, db: DB = Depends(get_db)):
    ok, reason = coach_available()
    if not ok:
        raise HTTPException(503, reason)
    mode = body.mode if body.mode in {"single", "vs_fastest", "vs_virtual", "all"} else "vs_fastest"
    laps = _laps(db, body.lap_ids)
    if not laps:
        raise HTTPException(400, "Select at least one lap")
    anchor = next((l for l in laps if l.id == body.subject_lap_id), None) or laps[0]
    scoped = laps_on_same_track(laps, anchor)
    dropped_n = len(laps) - len(scoped)
    laps = scoped
    if not laps:
        raise HTTPException(400, "No laps on the subject session's track")
    flying = [l for l in laps if l.kind == "valid"]
    pool = flying or laps
    fastest = min(pool, key=lambda l: l.time_ms)
    subject = next((l for l in laps if l.id == body.subject_lap_id), None)
    if subject is None:
        subject = next((l for l in pool if l.id != fastest.id), None) if mode != "single" else fastest
        if subject is None:
            subject = fastest
    ref = next((l for l in laps if l.id == body.ref_lap_id), None)
    if mode in {"vs_fastest", "vs_virtual"} and ref is None:
        ref = fastest if subject.id != fastest.id else next((l for l in pool if l.id != subject.id), fastest)
    if mode == "single":
        ref = None
    if mode == "all":
        subject = fastest
        ref = None

    cache = _df_cache(laps)
    slices = {}
    for lap in laps:
        df = cache.get(lap.session_id)
        if df is None:
            continue
        slices[lap.id] = lap_slice(df, lap)

    math = db.query(MathChannel).filter(MathChannel.enabled.is_(True)).all()
    layout = laps[0].session.layout if laps else None
    briefing = build_briefing(laps, slices, math, mode, subject, ref, layout, view=body.view)
    briefing["scope"] = {
        "track": layout.track.name if layout and layout.track else None,
        "layout": layout.name if layout else None,
        "dropped_other_track_laps": dropped_n,
    }
    h = briefing_hash(briefing, COACH_MODEL)
    if not body.force:
        cached = db.query(CoachReport).filter(CoachReport.briefing_hash == h).first()
        if cached and cached.report:
            return {
                "cached": True,
                "model": cached.model,
                "provider": COACH_PROVIDER,
                "briefing": cached.briefing,
                "report": cached.report,
            }
    try:
        report = run_coach(briefing)
    except Exception as exc:
        raise HTTPException(502, f"Coach model failed: {exc}") from exc
    row = db.query(CoachReport).filter(CoachReport.briefing_hash == h).first()
    if row:
        row.report = report
        row.briefing = briefing
        row.model = COACH_MODEL
    else:
        row = CoachReport(
            briefing_hash=h,
            mode=mode,
            model=COACH_MODEL,
            briefing=briefing,
            report=report,
        )
        db.add(row)
    db.commit()
    return {
        "cached": False,
        "model": COACH_MODEL,
        "provider": COACH_PROVIDER,
        "briefing": briefing,
        "report": report,
    }
