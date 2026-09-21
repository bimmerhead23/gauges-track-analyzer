"""Local ENU helpers, gates, crossings, start/finish proposal."""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np
from shapely.geometry import LineString, Point, Polygon

R_EARTH = 6_371_000.0


def to_xy(lat: np.ndarray | float, lon: np.ndarray | float, lat0: float, lon0: float):
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    x = np.radians(lon - lon0) * R_EARTH * math.cos(math.radians(lat0))
    y = np.radians(lat - lat0) * R_EARTH
    if x.ndim == 0:
        return float(x), float(y)
    return x, y


def to_ll(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    lat = lat0 + math.degrees(y / R_EARTH)
    lon = lon0 + math.degrees(x / (R_EARTH * math.cos(math.radians(lat0))))
    return lat, lon


def haversine_m(lat1, lon1, lat2, lon2) -> np.ndarray:
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(a))


def on_track_centroid(lat: np.ndarray, lon: np.ndarray, speed_mps: np.ndarray, min_speed: float = 16.0):
    """Median of high-speed GPS — ignores street/highway to/from the circuit."""
    ok = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(speed_mps) & (speed_mps >= min_speed)
    if int(ok.sum()) < 40:
        ok = np.isfinite(lat) & np.isfinite(lon)
    if not ok.any():
        return None
    return float(np.median(lat[ok])), float(np.median(lon[ok]))


def estimate_loop_m(lat: np.ndarray, lon: np.ndarray, dist_m: np.ndarray, speed_mps: np.ndarray, min_speed: float = 16.0):
    """Median path distance between passes of the high-speed cluster (approx lap length)."""
    ok = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(dist_m) & np.isfinite(speed_mps) & (speed_mps >= min_speed)
    if int(ok.sum()) < 80:
        return None
    clat = float(np.median(lat[ok]))
    clon = float(np.median(lon[ok]))
    near = haversine_m(lat, lon, clat, clon) < 60.0
    idxs = np.where(ok & near)[0]
    if len(idxs) < 4:
        return None
    passes = [int(idxs[0])]
    for i in idxs[1:]:
        if float(dist_m[i] - dist_m[passes[-1]]) > 400:
            passes.append(int(i))
    gaps = np.diff(np.array([dist_m[i] for i in passes], dtype=float))
    gaps = gaps[gaps > 900]
    if len(gaps) == 0:
        return None
    return float(np.median(gaps))


def heading_deg(lat1, lon1, lat2, lon2) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def heading_delta(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def dest_point(lat: float, lon: float, bearing: float, dist_m: float) -> tuple[float, float]:
    br = math.radians(bearing)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    d = dist_m / R_EARTH
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(br))
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def gate_from_point(lat: float, lon: float, heading: float, half_width_m: float = 14.0) -> dict:
    a = dest_point(lat, lon, heading + 90.0, half_width_m)
    b = dest_point(lat, lon, heading - 90.0, half_width_m)
    return {
        "a": {"lat": a[0], "lon": a[1]},
        "b": {"lat": b[0], "lon": b[1]},
        "heading": heading,
        "lat": lat,
        "lon": lon,
    }


def gate_linestring(gate: dict, lat0: float, lon0: float) -> LineString:
    xa, ya = to_xy(gate["a"]["lat"], gate["a"]["lon"], lat0, lon0)
    xb, yb = to_xy(gate["b"]["lat"], gate["b"]["lon"], lat0, lon0)
    return LineString([(xa, ya), (xb, yb)])


def polygon_from_ll(points: Iterable[dict], lat0: float, lon0: float) -> Polygon | None:
    pts = list(points or [])
    if len(pts) < 3:
        return None
    xy = [to_xy(p["lat"], p["lon"], lat0, lon0) for p in pts]
    if xy[0] != xy[-1]:
        xy.append(xy[0])
    return Polygon(xy)


def accept_gps(
    lat: np.ndarray,
    lon: np.ndarray,
    valid: np.ndarray,
    t_ms: np.ndarray | None = None,
) -> np.ndarray:
    """Drop teleports. A real gap is a short chord; a bad fix jumps faster than any car.

    120 m/s is 432 km/h, plus 8 m of jitter. The rejected point is not used as the
    next anchor, so the following good fix is measured from the last sane one.
    """
    keep = np.asarray(valid, dtype=bool).copy()
    last = None
    for i in range(len(lat)):
        if not keep[i]:
            continue
        if last is None:
            last = i
            continue
        step = float(haversine_m(lat[last], lon[last], lat[i], lon[i]))
        dt = None
        if t_ms is not None:
            dt = (float(t_ms[i]) - float(t_ms[last])) / 1000.0
        if dt is None or dt <= 0:
            limit = 30.0
        else:
            limit = max(20.0, 120.0 * dt + 8.0)
        if step > limit:
            keep[i] = False
            continue
        last = i
    return keep


def cumulative_distance(lat: np.ndarray, lon: np.ndarray, valid: np.ndarray) -> np.ndarray:
    n = len(lat)
    dist = np.zeros(n, dtype=float)
    last_i = None
    for i in range(n):
        if not valid[i]:
            dist[i] = dist[i - 1] if i else 0.0
            continue
        if last_i is None:
            dist[i] = dist[i - 1] if i else 0.0
            last_i = i
            continue
        step = float(haversine_m(lat[last_i], lon[last_i], lat[i], lon[i]))
        dist[i] = dist[last_i] + step
        last_i = i
    return dist


def path_heading(lat: np.ndarray, lon: np.ndarray, valid: np.ndarray) -> np.ndarray:
    n = len(lat)
    hdg = np.full(n, np.nan)
    last_i = None
    for i in range(n):
        if not valid[i]:
            continue
        if last_i is not None:
            hdg[i] = heading_deg(lat[last_i], lon[last_i], lat[i], lon[i])
        last_i = i
    # forward-fill
    last = np.nan
    for i in range(n):
        if np.isnan(hdg[i]):
            hdg[i] = last
        else:
            last = hdg[i]
    if n and np.isnan(hdg[0]):
        first = next((v for v in hdg if not np.isnan(v)), 0.0)
        hdg[np.isnan(hdg)] = first
    return hdg


def gps_accel_g(
    speed_mps: np.ndarray, heading: np.ndarray, t_s: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Longitudinal and lateral G from GPS speed + heading.

    Signs are driver-felt (specific force), not vehicle acceleration:
    +long = braking (G forward), −long = throttle
    +lat  = left turn (G to the right), −lat = right turn
    """
    n = len(speed_mps)
    long_g = np.zeros(n)
    lat_g = np.zeros(n)
    if n < 3:
        return long_g, lat_g
    dt = np.diff(t_s, prepend=t_s[0])
    dt[dt <= 0] = np.nanmedian(dt[dt > 0]) if np.any(dt > 0) else 0.07
    dv = np.diff(speed_mps, prepend=speed_mps[0])
    # Vehicle accel is dv/dt and speed*yaw; flip so the plot matches seat-of-pants G.
    long_g = -(dv / dt) / 9.80665
    hdg_r = np.radians(heading)
    unwrap = np.unwrap(hdg_r)
    dhdg = np.diff(unwrap, prepend=unwrap[0])
    yaw_rate = dhdg / dt
    lat_g = -(speed_mps * yaw_rate) / 9.80665
    long_g = _box_smooth(np.nan_to_num(long_g), 5)
    lat_g = _box_smooth(np.nan_to_num(lat_g), 5)
    long_g = np.clip(long_g, -6, 6)
    lat_g = np.clip(lat_g, -6, 6)
    return long_g, lat_g


def _box_smooth(x: np.ndarray, win: int) -> np.ndarray:
    """Centered moving average. At ~14 Hz, 5 samples is about a quarter second."""
    if win <= 1 or len(x) < win:
        return x
    kernel = np.ones(win, dtype=float) / win
    return np.convolve(x, kernel, mode="same")


def signed_area(lat: np.ndarray, lon: np.ndarray) -> float:
    """Positive ~ CCW in lon/lat plane."""
    if len(lat) < 3:
        return 0.0
    x = lon
    y = lat
    return 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))


def crossings(
    lat: np.ndarray,
    lon: np.ndarray,
    t_ms: np.ndarray,
    heading: np.ndarray,
    speed_mps: np.ndarray,
    gate: dict,
    lat0: float,
    lon0: float,
    heading_tol: float = 55.0,
    min_speed_mps: float = 5.0,
) -> list[dict]:
    """Return interpolated gate crossings in the intended direction."""
    line = gate_linestring(gate, lat0, lon0)
    want = float(gate.get("heading", 0.0))
    xs, ys = to_xy(lat, lon, lat0, lon0)
    out = []
    for i in range(1, len(lat)):
        if np.isnan(lat[i]) or np.isnan(lat[i - 1]):
            continue
        if speed_mps[i] < min_speed_mps and speed_mps[i - 1] < min_speed_mps:
            continue
        seg = LineString([(xs[i - 1], ys[i - 1]), (xs[i], ys[i])])
        if not seg.intersects(line):
            continue
        inter = seg.intersection(line)
        if inter.is_empty:
            continue
        pt = inter if isinstance(inter, Point) else inter.representative_point()
        dx = xs[i] - xs[i - 1]
        dy = ys[i] - ys[i - 1]
        seg_len = math.hypot(dx, dy) or 1e-9
        frac = math.hypot(pt.x - xs[i - 1], pt.y - ys[i - 1]) / seg_len
        frac = min(max(frac, 0.0), 1.0)
        hdg = heading[i] if not np.isnan(heading[i]) else heading[i - 1]
        if heading_delta(float(hdg), want) > heading_tol:
            continue
        t = float(t_ms[i - 1] + frac * (t_ms[i] - t_ms[i - 1]))
        clat, clon = to_ll(pt.x, pt.y, lat0, lon0)
        out.append({"t_ms": t, "index": i, "frac": frac, "lat": clat, "lon": clon, "heading": float(hdg)})
    # de-dupe crossings closer than 2 s (double-hit on a wide gate)
    cleaned = []
    for c in out:
        if cleaned and c["t_ms"] - cleaned[-1]["t_ms"] < 2000:
            continue
        cleaned.append(c)
    return cleaned


def propose_start_finish(
    lat: np.ndarray,
    lon: np.ndarray,
    heading: np.ndarray,
    speed_mps: np.ndarray,
    min_speed_mps: float = 18.0,
) -> dict | None:
    """Find a repeated high-speed crossing — usually the front straight."""
    valid = (
        np.isfinite(lat)
        & np.isfinite(lon)
        & np.isfinite(heading)
        & (speed_mps >= min_speed_mps)
    )
    idx = np.where(valid)[0]
    if len(idx) < 40:
        return None
    lat0 = float(np.nanmedian(lat[valid]))
    lon0 = float(np.nanmedian(lon[valid]))
    xs, ys = to_xy(lat[idx], lon[idx], lat0, lon0)
    hdgs = heading[idx]
    spds = speed_mps[idx]
    best = None
    best_score = -1.0
    # subsample for O(n) neighbourhood scoring
    step = max(1, len(idx) // 800)
    for k in range(0, len(idx), step):
        dx = xs - xs[k]
        dy = ys - ys[k]
        near = (dx * dx + dy * dy) < (18.0**2)
        if near.sum() < 8:
            continue
        dh = np.array([heading_delta(float(hdgs[k]), float(h)) for h in hdgs[near]])
        aligned = dh < 25.0
        n = int(aligned.sum())
        if n < 6:
            continue
        score = n * float(np.median(spds[near][aligned]))
        if score > best_score:
            best_score = score
            best = k
    if best is None:
        return None
    return gate_from_point(float(lat[idx[best]]), float(lon[idx[best]]), float(hdgs[best]))


def point_in_pit(
    lat: np.ndarray,
    lon: np.ndarray,
    pit: list | None,
    lat0: float,
    lon0: float,
) -> np.ndarray:
    poly = polygon_from_ll(pit or [], lat0, lon0)
    n = len(lat)
    mask = np.zeros(n, dtype=bool)
    if poly is None:
        return mask
    xs, ys = to_xy(lat, lon, lat0, lon0)
    for i in range(n):
        if np.isnan(lat[i]):
            continue
        mask[i] = poly.contains(Point(xs[i], ys[i]))
    return mask
