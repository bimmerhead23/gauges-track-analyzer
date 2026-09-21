from __future__ import annotations

import numpy as np
import pandas as pd

from .geo import (
    crossings,
    estimate_loop_m,
    haversine_m,
    on_track_centroid,
    point_in_pit,
    propose_start_finish,
    signed_area,
)
from .models import Lap, Layout, Sector, Session, Track
from .turns import estimated_count


def match_layout(db, lat: np.ndarray, lon: np.ndarray, speed_mps: np.ndarray, dist_m: np.ndarray):
    c = on_track_centroid(lat, lon, speed_mps)
    if not c:
        return None
    clat, clon = c
    layouts: list[Layout] = db.query(Layout).all()
    hits = []
    for lay in layouts:
        d = float(haversine_m(clat, clon, lay.centroid_lat, lay.centroid_lon))
        rad = max(float(lay.match_radius_m or 0), 6000.0)
        if d <= rad:
            hits.append((d, lay))
    if not hits:
        return None
    def _quality(lay: Layout) -> int:
        # Prefer curated layouts (real length / direction / S/F) over OSM stubs.
        q = 0
        if lay.sf_gate:
            q += 5
        if float(lay.length_m or 0) not in (0, 4000):
            q += 2
        if (lay.direction or "").upper() not in ("BOTH", ""):
            q += 1
        return q

    hits.sort(key=lambda h: h[0])
    min_d = hits[0][0]
    near = [h for h in hits if h[0] <= max(min_d + 1500.0, 1800.0)]
    pool_hits = near or hits

    # Open path (BTG / rally / hillclimb): start and end are far apart.
    hs = np.isfinite(lat) & np.isfinite(lon) & (speed_mps >= 15)
    idx = np.where(hs)[0]
    if len(idx) > 20:
        i0, i1 = int(idx[0]), int(idx[-1])
        gap = float(haversine_m(lat[i0], lon[i0], lat[i1], lon[i1]))
        if gap > 400:
            staged = [h for h in pool_hits if (h[1].timing_mode or "loop") == "stage"]
            if not staged:
                staged = [h for h in hits if (h[1].timing_mode or "loop") == "stage"]
            if staged:
                staged.sort(key=lambda h: h[0])
                return staged[0][1]

    pool_hits.sort(key=lambda h: (-_quality(h[1]), h[0]))
    same_track = [h for h in pool_hits if h[1].track_id == pool_hits[0][1].track_id]
    hs = np.isfinite(lat) & np.isfinite(lon) & (speed_mps >= 16)
    if int(hs.sum()) > 50:
        area = signed_area(lat[hs], lon[hs])
    else:
        area = signed_area(lat[np.isfinite(lat)], lon[np.isfinite(lon)])
    want = "CCW" if area > 0 else "CW"
    directed = [h for h in same_track if (h[1].direction or "").upper() in (want, "BOTH", "")]
    pool = directed or same_track
    loop = estimate_loop_m(lat, lon, dist_m, speed_mps)
    if loop and len(pool) > 1:
        pool = sorted(pool, key=lambda h: abs(float(h[1].length_m) - loop))
    return pool[0][1]


def adopt_unmatched(db, df: pd.DataFrame, filename: str) -> Layout | None:
    """Keep a log that missed the catalog by making a layout from its GPS.

    A second visit to the same place (within 2 km, venue User) reuses it.
    """
    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    valid = np.isfinite(lat) & np.isfinite(lon)
    if int(valid.sum()) < 50:
        return None
    clat = float(np.nanmedian(lat[valid]))
    clon = float(np.nanmedian(lon[valid]))
    for lay in db.query(Layout).join(Track).filter(Track.venue == "User").all():
        if float(haversine_m(clat, clon, lay.centroid_lat, lay.centroid_lon)) <= 2000:
            return lay
    speed = _speed_mps(df)
    dist = df["dist_m"].to_numpy(dtype=float) if "dist_m" in df.columns else np.zeros(len(df))
    heading = df["heading_deg"].to_numpy(dtype=float) if "heading_deg" in df.columns else np.zeros(len(df))
    loop = estimate_loop_m(lat, lon, dist, speed)
    length = float(loop or (dist[valid].max() - dist[valid].min() if valid.any() else 0) or 1000)
    length = max(length, 200.0)
    area = signed_area(lat[valid], lon[valid])
    direction = "CCW" if area > 0 else "CW"
    gate = propose_start_finish(lat, lon, heading, speed)
    if isinstance(gate, dict):
        gate = {**gate, "source": "auto"}
    base = f"GPS {clat:.3f}, {clon:.3f}"
    name = base
    n = 2
    while db.query(Track).filter(Track.name == name).first():
        name = f"{base} ({n})"
        n += 1
    track = Track(
        name=name[:120],
        venue="User",
        notes="Created from a log that did not match a catalog circuit. Place start/finish on the Track tab.",
    )
    db.add(track)
    db.flush()
    lay = Layout(
        track_id=track.id,
        name="From this log",
        direction=direction,
        length_m=length,
        centroid_lat=clat,
        centroid_lon=clon,
        match_radius_m=2500,
        sf_gate=gate,
        timing_mode="loop",
        turns={"count": estimated_count(length), "source": "estimated"},
    )
    db.add(lay)
    db.flush()
    return lay


def _speed_mps(df: pd.DataFrame) -> np.ndarray:
    if "gps_speed" in df.columns:
        return df["gps_speed"].to_numpy(dtype=float) / 3.6
    if "speed_mph" in df.columns:
        return df["speed_mph"].to_numpy(dtype=float) * 0.44704
    return np.zeros(len(df))


def detect_laps(df: pd.DataFrame, layout: Layout | None) -> tuple[list[dict], dict | None]:
    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    t_ms = df["t_ms"].to_numpy(dtype=float)
    dist = df["dist_m"].to_numpy(dtype=float)
    heading = df["heading_deg"].to_numpy(dtype=float)
    speed = _speed_mps(df)
    valid = np.isfinite(lat) & np.isfinite(lon)
    if valid.sum() < 50:
        return [], None

    lat0 = float(np.nanmedian(lat[valid]))
    lon0 = float(np.nanmedian(lon[valid]))
    mode = ((layout.timing_mode if layout else None) or "loop").lower()
    if mode == "stage":
        return _detect_stage(df, layout, lat, lon, t_ms, dist, heading, speed, lat0, lon0)

    gate = (layout.sf_gate if layout else None) or propose_start_finish(lat, lon, heading, speed)
    if not gate:
        return [_full_span(t_ms, dist, "out")], None

    xs, gate = _crossings_or_flip(lat, lon, t_ms, heading, speed, gate, lat0, lon0)

    pit = point_in_pit(lat, lon, layout.pit_polygon if layout else None, lat0, lon0)
    expected = layout.length_m if layout else None

    events = [{"t_ms": 0.0, "index": 0, "kind": "start"}] + xs + [
        {"t_ms": float(t_ms[-1]), "index": len(df) - 1, "kind": "end"}
    ]

    laps = []
    for i in range(len(events) - 1):
        a, b = events[i], events[i + 1]
        i0, i1 = int(a["index"]), int(b["index"])
        if i1 <= i0:
            continue
        time_ms = int(round(b["t_ms"] - a["t_ms"]))
        d_m = float(dist[i1] - dist[i0])
        sl = speed[i0:i1]
        avg = float(np.nanmean(sl)) if len(sl) else 0.0
        pit_frac = float(pit[i0:i1].mean()) if pit.any() else 0.0
        kind = "valid"
        if i == 0:
            kind = "out"
        elif i == len(events) - 2:
            kind = "in"
        if pit_frac > 0.08:
            kind = "pit"
        if expected:
            if d_m < 0.85 * expected or d_m > 1.15 * expected:
                if kind == "valid":
                    kind = "invalid"
        if avg < 8.0 and kind == "valid":  # ~18 mph average = paddock
            kind = "invalid"
        if time_ms < 15_000:
            continue
        laps.append({
            "number": 0,
            "t_start_ms": int(round(a["t_ms"])),
            "t_end_ms": int(round(b["t_ms"])),
            "time_ms": time_ms,
            "distance_m": d_m,
            "kind": kind,
            "i0": i0,
            "i1": i1,
        })

    # relative time filter vs median of candidate flying laps
    flying = [l for l in laps if l["kind"] == "valid"]
    if flying:
        med = float(np.median([l["time_ms"] for l in flying]))
        for l in flying:
            if l["time_ms"] > 1.45 * med:
                l["kind"] = "invalid"

    n = 1
    for l in laps:
        l["number"] = n
        n += 1
    if not laps:
        return [_full_span(t_ms, dist, "out")], gate
    return laps, gate


def _crossings_or_flip(lat, lon, t_ms, heading, speed, gate, lat0, lon0):
    xs = crossings(lat, lon, t_ms, heading, speed, gate, lat0, lon0)
    if xs:
        return xs, gate
    flipped = dict(gate)
    flipped["heading"] = (float(gate.get("heading", 0)) + 180) % 360
    xs = crossings(lat, lon, t_ms, heading, speed, flipped, lat0, lon0)
    if xs:
        return xs, flipped
    return [], gate


def _full_span(t_ms: np.ndarray, dist: np.ndarray, kind: str) -> dict:
    return {
        "number": 1,
        "t_start_ms": int(round(float(t_ms[0]))),
        "t_end_ms": int(round(float(t_ms[-1]))),
        "time_ms": int(round(float(t_ms[-1] - t_ms[0]))),
        "distance_m": float(dist[-1] - dist[0]),
        "kind": kind,
        "i0": 0,
        "i1": int(len(t_ms) - 1),
    }


def _detect_stage(df, layout, lat, lon, t_ms, dist, heading, speed, lat0, lon0):
    """Pair start-gate (A) crossings with the next finish-gate (B). Rally / BTG."""
    start = layout.sf_gate if layout else None
    finish = layout.finish_gate if layout else None
    if not start or not finish:
        return [_full_span(t_ms, dist, "out")], start
    xs_a, start = _crossings_or_flip(lat, lon, t_ms, heading, speed, start, lat0, lon0)
    xs_b, finish = _crossings_or_flip(lat, lon, t_ms, heading, speed, finish, lat0, lon0)
    if not xs_a and xs_b:
        moving = np.where(np.isfinite(speed) & (speed >= 8.0))[0]
        i = int(moving[0]) if len(moving) else 0
        xs_a = [{"t_ms": float(t_ms[i]), "index": i}]
    if not xs_a or not xs_b:
        return [_full_span(t_ms, dist, "out")], start
    expected = float(layout.length_m) if layout and layout.length_m else None
    runs = []
    j = 0
    for a in xs_a:
        while j < len(xs_b) and xs_b[j]["t_ms"] <= a["t_ms"] + 400:
            j += 1
        if j >= len(xs_b):
            break
        b = xs_b[j]
        j += 1
        i0, i1 = int(a["index"]), int(b["index"])
        if i1 <= i0:
            continue
        time_ms = int(round(b["t_ms"] - a["t_ms"]))
        d_m = float(dist[i1] - dist[i0])
        if time_ms < 8000 or d_m < 200:
            continue
        sl = speed[i0:i1]
        avg = float(np.nanmean(sl)) if len(sl) else 0.0
        kind = "valid" if avg >= 8.0 else "invalid"
        if expected and (d_m < 0.45 * expected or d_m > 1.6 * expected):
            if kind == "valid":
                kind = "invalid"
        runs.append({
            "number": 0,
            "t_start_ms": int(round(a["t_ms"])),
            "t_end_ms": int(round(b["t_ms"])),
            "time_ms": time_ms,
            "distance_m": d_m,
            "kind": kind,
            "i0": i0,
            "i1": i1,
        })
    if not runs:
        return [_full_span(t_ms, dist, "out")], start
    n = 1
    for l in runs:
        l["number"] = n
        n += 1
    return runs, start


def sector_times(df: pd.DataFrame, lap: dict, layout: Layout | None) -> tuple[list[dict], str]:
    """Sectors from layout split gates, else equal-distance thirds.

    Intermediate beacons are timed in lap-distance order (not list order).
    One split → two sectors; N splits → N+1 sectors, capped at 8. Gates
    within 50 m of S/F or of the previous split are ignored. No usable
    gates → equal thirds (the historical default).
    """
    i0, i1 = lap["i0"], lap["i1"]
    sl = df.iloc[i0 : i1 + 1]
    lat = sl["lat"].to_numpy(dtype=float)
    lon = sl["lon"].to_numpy(dtype=float)
    t_ms = sl["t_ms"].to_numpy(dtype=float)
    dist = sl["dist_m"].to_numpy(dtype=float)
    heading = sl["heading_deg"].to_numpy(dtype=float)
    speed = _speed_mps(sl)
    t0 = float(t_ms[0])
    d0 = float(dist[0])
    d_end = float(dist[-1])
    d_span = max(d_end - d0, 1.0)
    MIN_M = 50.0
    MAX_SEC = 8

    gates = []
    if layout and layout.sectors:
        gates = [g for g in layout.sectors if isinstance(g, dict)]

    hits: list[tuple[float, float]] = []
    if gates:
        lat0 = float(np.nanmedian(lat[np.isfinite(lat)])) if np.isfinite(lat).any() else 0
        lon0 = float(np.nanmedian(lon[np.isfinite(lon)])) if np.isfinite(lon).any() else 0
        for g in gates:
            xs = crossings(lat, lon, t_ms, heading, speed, g, lat0, lon0, heading_tol=70)
            if not xs:
                continue
            k = int(xs[0]["index"])
            k = min(max(k, 0), len(dist) - 1)
            hits.append((float(xs[0]["t_ms"]), float(dist[k])))
        hits.sort(key=lambda h: h[1])

    splits_t = [t0]
    splits_d = [d0]
    for t, d in hits:
        if d - splits_d[-1] < MIN_M:
            continue
        if d_end - d < MIN_M:
            continue
        splits_t.append(t)
        splits_d.append(d)
        if len(splits_t) >= MAX_SEC:
            break

    source = "gates"
    if len(splits_t) < 2:
        source = "equal"
        splits_t = [t0]
        splits_d = [d0]
        for frac in (1 / 3, 2 / 3):
            target = d0 + frac * d_span
            k = int(np.argmin(np.abs(dist - target)))
            splits_t.append(float(t_ms[k]))
            splits_d.append(float(dist[k]))
    splits_t.append(float(t_ms[-1]))
    splits_d.append(d_end)

    for i in range(1, len(splits_t)):
        if splits_t[i] < splits_t[i - 1]:
            splits_t[i] = splits_t[i - 1]
            splits_d[i] = splits_d[i - 1]

    nsec = min(MAX_SEC, len(splits_t) - 1)
    out = []
    for i in range(nsec):
        out.append({
            "index": i + 1,
            "time_ms": int(round(splits_t[i + 1] - splits_t[i])),
            "distance_m": float(splits_d[i + 1] - splits_d[i]),
        })
    return out, source


def persist_laps(db, session: Session, df: pd.DataFrame, layout: Layout | None) -> dict | None:
    lap_ids = [r[0] for r in db.query(Lap.id).filter(Lap.session_id == session.id).all()]
    if lap_ids:
        db.query(Sector).filter(Sector.lap_id.in_(lap_ids)).delete(synchronize_session=False)
        db.query(Lap).filter(Lap.id.in_(lap_ids)).delete(synchronize_session=False)
        db.flush()
    db.expire(session, ["laps"])
    laps, gate = detect_laps(df, layout)
    valid_times = [l["time_ms"] for l in laps if l["kind"] == "valid"]
    best = min(valid_times) if valid_times else None
    for l in laps:
        rec = Lap(
            session_id=session.id,
            number=l["number"],
            t_start_ms=l["t_start_ms"],
            t_end_ms=l["t_end_ms"],
            time_ms=l["time_ms"],
            distance_m=l["distance_m"],
            kind=l["kind"],
            is_best=bool(best is not None and l["kind"] == "valid" and l["time_ms"] == best),
        )
        secs, source = sector_times(df, l, layout)
        rec.sectors_source = source
        db.add(rec)
        db.flush()
        for s in secs:
            db.add(Sector(lap_id=rec.id, index=s["index"], time_ms=s["time_ms"], distance_m=s["distance_m"]))
    return gate
