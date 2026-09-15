from __future__ import annotations

import re

import numpy as np
import pandas as pd
import numexpr as ne

from .models import Lap, MathChannel

Gate = tuple[str, str, float]  # channel, op, value
_GATE_RE = re.compile(r"^([a-zA-Z0-9_]+)(>=|<=|>|<)(-?\d+(?:\.\d+)?)$")


def parse_gates(spec: str | None) -> list[Gate]:
    """Parse 'brake>10,tps<5' into AND-ed conditions. Empty/None → []."""
    if not spec or not str(spec).strip():
        return []
    out: list[Gate] = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        m = _GATE_RE.match(part)
        if not m:
            raise ValueError(f"Bad gate '{part}'. Use channel>value, e.g. brake>10")
        out.append((m.group(1), m.group(2), float(m.group(3))))
    return out


def apply_gates(
    sl: pd.DataFrame,
    math: list[MathChannel],
    gates: list[Gate] | None = None,
    dist_min: float | None = None,
    dist_max: float | None = None,
) -> np.ndarray:
    n = 0 if sl.empty else len(sl)
    mask = np.ones(n, dtype=bool)
    if n == 0:
        return mask
    if dist_min is not None or dist_max is not None:
        d = sl["lap_dist_m"].to_numpy(dtype=float) if "lap_dist_m" in sl.columns else None
        if d is None:
            mask[:] = False
            return mask
        ok = np.isfinite(d)
        if dist_min is not None:
            ok &= d >= dist_min
        if dist_max is not None:
            ok &= d <= dist_max
        mask &= ok
    for ch, op, val in gates or []:
        y = series_for(sl, ch, math)
        if y is None:
            mask[:] = False
            return mask
        y = np.asarray(y, dtype=float)[:n]
        ok = np.isfinite(y)
        if op == ">":
            ok &= y > val
        elif op == ">=":
            ok &= y >= val
        elif op == "<":
            ok &= y < val
        elif op == "<=":
            ok &= y <= val
        else:
            mask[:] = False
            return mask
        mask &= ok
    return mask


def lap_slice(df: pd.DataFrame, lap: Lap) -> pd.DataFrame:
    t = df["t_ms"].to_numpy(dtype=float)
    mask = (t >= lap.t_start_ms) & (t <= lap.t_end_ms)
    sl = df.loc[mask].copy()
    if sl.empty:
        return sl
    sl["lap_dist_m"] = sl["dist_m"] - float(sl["dist_m"].iloc[0])
    sl["lap_t_ms"] = sl["t_ms"] - float(sl["t_ms"].iloc[0])
    return sl


def downsample_xy(x: np.ndarray, y: np.ndarray, max_points: int) -> tuple[list, list]:
    n = len(x)
    if n <= max_points or max_points < 8:
        return x.astype(float).tolist(), y.astype(float).tolist()
    # min/max buckets keep spikes (brake/throttle)
    buckets = max_points // 2
    idx = np.linspace(0, n - 1, buckets + 1).astype(int)
    xs, ys = [], []
    for i in range(buckets):
        a, b = idx[i], idx[i + 1]
        if b <= a:
            b = min(a + 1, n)
        seg_y = y[a:b]
        seg_x = x[a:b]
        if len(seg_y) == 0:
            continue
        jmin = int(np.nanargmin(seg_y))
        jmax = int(np.nanargmax(seg_y))
        order = sorted({0, jmin, jmax, len(seg_y) - 1})
        for j in order:
            xs.append(float(seg_x[j]))
            ys.append(float(seg_y[j]) if np.isfinite(seg_y[j]) else None)
    return xs, ys


def eval_math(expr: str, sl: pd.DataFrame) -> np.ndarray | None:
    local = {c: sl[c].to_numpy(dtype=float) for c in sl.columns if sl[c].dtype.kind in "fiu"}
    try:
        out = ne.evaluate(expr, local_dict=local, global_dict={})
        return np.asarray(out, dtype=float)
    except Exception:
        return None


def series_for(
    sl: pd.DataFrame,
    key: str,
    math: list[MathChannel],
) -> np.ndarray | None:
    if key in sl.columns:
        return sl[key].to_numpy(dtype=float)
    for m in math:
        if m.name == key or m.name.lower().replace(" ", "_") == key:
            return eval_math(m.expression, sl)
    return None


def interpolate_at_distance(sl: pd.DataFrame, dist_m: float, keys: list[str], math: list[MathChannel]) -> dict:
    if sl.empty:
        return {}
    d = sl["lap_dist_m"].to_numpy(dtype=float)
    if len(d) < 2:
        return {}
    dist_m = float(np.clip(dist_m, d.min(), d.max()))
    out = {"dist_m": dist_m}
    out["t_ms"] = float(np.interp(dist_m, d, sl["lap_t_ms"].to_numpy(dtype=float)))
    if "lat" in sl.columns:
        out["lat"] = float(np.interp(dist_m, d, sl["lat"].to_numpy(dtype=float)))
        out["lon"] = float(np.interp(dist_m, d, sl["lon"].to_numpy(dtype=float)))
    for k in keys:
        y = series_for(sl, k, math)
        if y is None:
            continue
        y = np.nan_to_num(y, nan=0.0)
        out[k] = float(np.interp(dist_m, d, y))
    return out


def range_stats(
    sl: pd.DataFrame,
    dist_a: float,
    dist_b: float,
    keys: list[str],
    math: list[MathChannel],
) -> dict | None:
    """Δt / Δs and min/max/avg of channels between two distances."""
    if sl.empty or "lap_dist_m" not in sl.columns:
        return None
    d = sl["lap_dist_m"].to_numpy(dtype=float)
    t = sl["lap_t_ms"].to_numpy(dtype=float) if "lap_t_ms" in sl.columns else None
    if len(d) < 2:
        return None
    lo = float(min(dist_a, dist_b))
    hi = float(max(dist_a, dist_b))
    lo = float(np.clip(lo, d.min(), d.max()))
    hi = float(np.clip(hi, d.min(), d.max()))
    t_a = float(np.interp(lo, d, t)) if t is not None else None
    t_b = float(np.interp(hi, d, t)) if t is not None else None
    mask = (d >= lo) & (d <= hi)
    channels = {}
    for k in keys:
        y = series_for(sl, k, math)
        if y is None:
            continue
        y = np.asarray(y, dtype=float)
        n = min(len(y), len(d))
        yy, dd = y[:n], d[:n]
        a = float(np.interp(lo, dd, np.nan_to_num(yy, nan=0.0)))
        b = float(np.interp(hi, dd, np.nan_to_num(yy, nan=0.0)))
        seg = yy[mask[:n] & np.isfinite(yy)]
        channels[k] = {
            "a": a,
            "b": b,
            "min": float(np.min(seg)) if len(seg) else None,
            "max": float(np.max(seg)) if len(seg) else None,
            "avg": float(np.mean(seg)) if len(seg) else None,
        }
    return {
        "dist_a": lo,
        "dist_b": hi,
        "delta_m": hi - lo,
        "t_a_ms": t_a,
        "t_b_ms": t_b,
        "delta_s": ((t_b - t_a) / 1000.0) if t_a is not None and t_b is not None else None,
        "channels": channels,
    }


def time_delta(ref: pd.DataFrame, other: pd.DataFrame, max_points: int = 1500) -> dict:
    """Δt(s) = t_other(s) - t_ref(s) on a shared distance grid."""
    if ref.empty or other.empty:
        return {"x": [], "y": []}
    d0 = ref["lap_dist_m"].to_numpy(dtype=float)
    t0 = ref["lap_t_ms"].to_numpy(dtype=float) / 1000.0
    d1 = other["lap_dist_m"].to_numpy(dtype=float)
    t1 = other["lap_t_ms"].to_numpy(dtype=float) / 1000.0
    end = float(min(d0.max(), d1.max()))
    grid = np.linspace(0, end, max_points)
    tr = np.interp(grid, d0, t0)
    to = np.interp(grid, d1, t1)
    return {"x": grid.tolist(), "y": (to - tr).tolist()}


def sector_distance_windows(lap: Lap, sl: pd.DataFrame | None = None) -> list[dict]:
    """Official sector [d0, d1] along this lap. Last sector absorbs remaining distance."""
    secs = sorted(lap.sectors or [], key=lambda s: s.index)
    if not secs:
        return []
    d_end = float(lap.distance_m or 0)
    if sl is not None and not sl.empty and "lap_dist_m" in sl.columns:
        d_end = max(d_end, float(sl["lap_dist_m"].iloc[-1]))
    d_end = max(d_end, sum(float(s.distance_m or 0) for s in secs))
    cursor = 0.0
    out: list[dict] = []
    for i, s in enumerate(secs):
        d0 = cursor
        d1 = cursor + float(s.distance_m or 0)
        if i == len(secs) - 1:
            d1 = max(d1, d_end)
        cursor = d1
        out.append({
            "index": int(s.index),
            "d0": d0,
            "d1": d1,
            "time_ms": int(s.time_ms),
        })
    # Match Splits display: last sector absorbs lap-time rounding so
    # sector times sum to TIME and virtual deltas sum to the lap delta.
    if out and lap.time_ms is not None:
        ssum = sum(w["time_ms"] for w in out)
        out[-1]["time_ms"] += int(lap.time_ms) - ssum
    return out


def _time_at_dist(sl: pd.DataFrame, dist_m: float) -> float | None:
    if sl is None or sl.empty or "lap_dist_m" not in sl.columns or "lap_t_ms" not in sl.columns:
        return None
    d = sl["lap_dist_m"].to_numpy(dtype=float)
    t = sl["lap_t_ms"].to_numpy(dtype=float)
    n = min(len(d), len(t))
    if n < 2:
        return None
    d, t = d[:n], t[:n]
    x = float(np.clip(dist_m, float(d.min()), float(d.max())))
    v = float(np.interp(x, d, t))
    return v if np.isfinite(v) else None


def _scaled_halves(sl: pd.DataFrame, window: dict) -> tuple[float, float]:
    """Two complete halves of one official sector, scaled so they sum to official time."""
    official = float(window["time_ms"])
    t0 = _time_at_dist(sl, window["d0"])
    t1 = _time_at_dist(sl, window["d1"])
    tm = _time_at_dist(sl, (window["d0"] + window["d1"]) / 2.0)
    if t0 is None or t1 is None or tm is None:
        return official / 2.0, official / 2.0
    h1 = tm - t0
    h2 = t1 - tm
    s = h1 + h2
    if not (h1 > 0 and h2 > 0 and s > 0):
        return official / 2.0, official / 2.0
    scale = official / s
    return h1 * scale, h2 * scale


def _eclectic_official_only(laps: list[Lap]) -> dict | None:
    """Fallback: min of each complete official sector, then sum."""
    by: dict[int, list[int]] = {}
    order: list[int] = []
    for lap in laps:
        secs = sorted(lap.sectors or [], key=lambda s: s.index)
        if not order and secs:
            order = [int(s.index) for s in secs]
        for s in secs:
            by.setdefault(int(s.index), []).append(int(s.time_ms))
    if not order:
        return None
    sectors = [{"index": idx, "time_ms": min(by[idx])} for idx in order if by.get(idx)]
    if not sectors:
        return None
    return {
        "time_ms": int(sum(s["time_ms"] for s in sectors)),
        "sectors": sectors,
        "windows_per_sector": 1,
    }


def eclectic_best(items: list[tuple[Lap, pd.DataFrame | None]]) -> dict | None:
    """Theoretical / virtual best lap.

    MoTeC i2 eclectic, AiM Race Studio theoretical, and Race Technology theoretical
    all do the same thing: min of each *complete identical segment* across valid
    laps, then sum. They use a handful of sectors (typically 3–7, split mid-straight),
    not dozens of GPS mini-bins — too many slices accumulate GPS error and invent
    a fantasy lap.

    We split each official sector in half. Each lap times those windows as
    wholes; the two halves are scaled so they add to that lap's official sector
    time. Virtual S_i = min(first half) + min(second half), which cannot be
    slower than the best flown official sector. TIME is the sum of sectors.
    """
    pool = [
        (lap, sl)
        for lap, sl in items
        if lap is not None
        and getattr(lap, "kind", None) == "valid"
        and sl is not None
        and not getattr(sl, "empty", True)
    ]
    if not pool:
        pool = [
            (lap, sl)
            for lap, sl in items
            if lap is not None and sl is not None and not getattr(sl, "empty", True)
        ]
    if not pool:
        laps_only = [
            lap for lap, _ in items
            if lap is not None and getattr(lap, "kind", None) == "valid"
        ]
        if not laps_only:
            laps_only = [lap for lap, _ in items if lap is not None]
        return _eclectic_official_only(laps_only)

    first_h: dict[int, list[float]] = {}
    second_h: dict[int, list[float]] = {}
    official_best: dict[int, int] = {}
    order: list[int] = []

    for lap, sl in pool:
        wins = sector_distance_windows(lap, sl)
        if not wins:
            continue
        if not order:
            order = [w["index"] for w in wins]
        for w in wins:
            idx = w["index"]
            h1, h2 = _scaled_halves(sl, w)
            first_h.setdefault(idx, []).append(h1)
            second_h.setdefault(idx, []).append(h2)
            ot = int(w["time_ms"])
            if idx not in official_best or ot < official_best[idx]:
                official_best[idx] = ot

    if not order:
        return None

    sectors = []
    for idx in order:
        a = first_h.get(idx) or []
        b = second_h.get(idx) or []
        if not a or not b:
            if idx in official_best:
                sectors.append({"index": idx, "time_ms": official_best[idx]})
            continue
        t = int(round(min(a) + min(b)))
        cap = official_best.get(idx)
        if cap is not None and t > cap:
            t = cap
        sectors.append({"index": idx, "time_ms": max(0, t)})

    if not sectors:
        return None
    return {
        "time_ms": int(sum(s["time_ms"] for s in sectors)),
        "sectors": sectors,
        "windows_per_sector": 2,
    }


def mini_sectors(sl: pd.DataFrame, length_m: float, step_m: float = 250.0) -> list[dict]:
    """~250 m windows (10–20 per lap) for the mini-sector bar only — not virtual best."""
    if sl.empty:
        return []
    d = sl["lap_dist_m"].to_numpy(dtype=float)
    t = sl["lap_t_ms"].to_numpy(dtype=float)
    n = int(round(length_m / step_m)) if length_m else 12
    n = max(10, min(20, n))
    edges = np.linspace(0, float(min(d.max(), length_m)), n + 1)
    out = []
    for i in range(n):
        a, b = edges[i], edges[i + 1]
        ia = int(np.searchsorted(d, a, side="left"))
        ib = int(np.searchsorted(d, b, side="left"))
        ia = min(ia, len(d) - 1)
        ib = min(ib, len(d) - 1)
        if ib <= ia:
            continue
        out.append({
            "index": i,
            "d0": float(a),
            "d1": float(b),
            "time_ms": int(round(t[ib] - t[ia])),
        })
    return out


def _rpm_edges(x: np.ndarray) -> np.ndarray:
    lo = float(np.nanmin(x))
    hi = float(np.nanmax(x))
    if not np.isfinite(lo) or not np.isfinite(hi):
        return np.linspace(0.0, 8000.0, 9)
    step = 500.0 if hi - lo >= 1500 else 250.0
    a = np.floor(lo / step) * step
    b = np.ceil(hi / step) * step
    if b <= a:
        b = a + step * 4
    n = int(round((b - a) / step))
    n = max(6, min(16, n))
    return np.linspace(a, a + n * step, n + 1)


def _bin_xy(
    x: np.ndarray,
    y: np.ndarray,
    z: np.ndarray,
    x_edges: np.ndarray,
    y_edges: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    nx, ny = len(x_edges) - 1, len(y_edges) - 1
    counts = np.zeros((ny, nx), dtype=np.int32)
    totals = np.zeros((ny, nx), dtype=np.float64)
    ok = (
        np.isfinite(x)
        & np.isfinite(y)
        & np.isfinite(z)
        & (x >= x_edges[0])
        & (x <= x_edges[-1])
        & (y >= y_edges[0])
        & (y <= y_edges[-1])
    )
    if not np.any(ok):
        return totals, counts
    xi = np.clip(np.searchsorted(x_edges, x[ok], side="right") - 1, 0, nx - 1)
    yi = np.clip(np.searchsorted(y_edges, y[ok], side="right") - 1, 0, ny - 1)
    np.add.at(counts, (yi, xi), 1)
    np.add.at(totals, (yi, xi), z[ok])
    return totals, counts


def _grid_out(totals: np.ndarray, counts: np.ndarray) -> dict:
    mean = np.divide(totals, counts, out=np.full(totals.shape, np.nan), where=counts > 0)
    cells = []
    for row in mean:
        cells.append([None if not np.isfinite(v) else round(float(v), 3) for v in row])
    used = counts > 0
    z_vals = mean[used]
    return {
        "mean": cells,
        "count": counts.astype(int).tolist(),
        "n": int(counts.sum()),
        "z_min": round(float(np.min(z_vals)), 3) if len(z_vals) else None,
        "z_max": round(float(np.max(z_vals)), 3) if len(z_vals) else None,
        "z_mean": round(float(np.average(z_vals, weights=counts[used])), 3) if len(z_vals) else None,
    }


def operating_map(
    items: list[tuple[Lap, pd.DataFrame | None]],
    math: list[MathChannel],
    *,
    x_key: str = "rpm",
    y_key: str = "tps",
    z_key: str = "afr",
    gates: list | None = None,
    dist_min: float | None = None,
    dist_max: float | None = None,
) -> dict:
    """Mean Z in X×Y bins (default AFR vs RPM vs throttle). Same idea as a mixture map."""
    prepared: list[tuple[int, np.ndarray, np.ndarray, np.ndarray]] = []
    missing: list[str] = []
    for lap, sl in items:
        if lap is None or sl is None or getattr(sl, "empty", True):
            continue
        xs = series_for(sl, x_key, math)
        ys = series_for(sl, y_key, math)
        zs = series_for(sl, z_key, math)
        if xs is None or ys is None or zs is None:
            for k, arr in ((x_key, xs), (y_key, ys), (z_key, zs)):
                if arr is None and k not in missing:
                    missing.append(k)
            continue
        n = min(len(xs), len(ys), len(zs), len(sl))
        mask = apply_gates(sl, math, gates, dist_min, dist_max)[:n]
        x = np.asarray(xs, dtype=float)[:n][mask]
        y = np.asarray(ys, dtype=float)[:n][mask]
        z = np.asarray(zs, dtype=float)[:n][mask]
        ok = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
        if int(ok.sum()) < 8:
            continue
        prepared.append((int(lap.id), x[ok], y[ok], z[ok]))

    if not prepared:
        return {
            "x_key": x_key,
            "y_key": y_key,
            "z_key": z_key,
            "x_edges": [],
            "y_edges": [],
            "missing": missing,
            "series": [],
            "combined": None,
        }

    all_x = np.concatenate([p[1] for p in prepared])
    all_y = np.concatenate([p[2] for p in prepared])
    all_z = np.concatenate([p[3] for p in prepared])
    x_edges = _rpm_edges(all_x) if x_key == "rpm" else np.linspace(float(np.nanmin(all_x)), float(np.nanmax(all_x)), 13)
    if y_key == "tps":
        y_hi = 100.0 if float(np.nanmax(all_y)) <= 105 else float(np.ceil(np.nanmax(all_y) / 10.0) * 10.0)
        y_edges = np.linspace(0.0, y_hi, 11)
    else:
        y_edges = np.linspace(float(np.nanmin(all_y)), float(np.nanmax(all_y)), 11)

    med = float(np.nanmedian(all_z))
    is_lambda = med < 4.0
    if is_lambda:
        stoich, rich, lean, unit = 1.0, 0.80, 1.10, "λ"
    else:
        stoich, rich, lean, unit = 14.7, 12.5, 16.0, "AFR"
    p5, p95 = float(np.nanpercentile(all_z, 5)), float(np.nanpercentile(all_z, 95))
    rich = min(rich, p5) if np.isfinite(p5) else rich
    lean = max(lean, p95) if np.isfinite(p95) else lean

    series = []
    tot_all = np.zeros((len(y_edges) - 1, len(x_edges) - 1), dtype=np.float64)
    cnt_all = np.zeros_like(tot_all, dtype=np.int32)
    for lap_id, x, y, z in prepared:
        totals, counts = _bin_xy(x, y, z, x_edges, y_edges)
        tot_all += totals
        cnt_all += counts
        row = _grid_out(totals, counts)
        row["lap_id"] = lap_id
        series.append(row)

    return {
        "x_key": x_key,
        "y_key": y_key,
        "z_key": z_key,
        "x_label": "Engine RPM",
        "y_label": "Throttle",
        "z_label": "AFR",
        "unit": unit,
        "stoich": stoich,
        "rich": round(rich, 3),
        "lean": round(lean, 3),
        "x_edges": [round(float(v), 1) for v in x_edges],
        "y_edges": [round(float(v), 1) for v in y_edges],
        "missing": missing,
        "series": series,
        "combined": _grid_out(tot_all, cnt_all),
    }


def stats(sl: pd.DataFrame, key: str, math: list[MathChannel], mask: np.ndarray | None = None) -> dict | None:
    y = series_for(sl, key, math)
    if y is None or len(y) == 0:
        return None
    y = np.asarray(y, dtype=float)
    if mask is not None:
        m = np.asarray(mask, dtype=bool)[: len(y)]
        y = y[m]
    y = y[np.isfinite(y)]
    if len(y) == 0:
        return None
    return {
        "min": float(np.min(y)),
        "max": float(np.max(y)),
        "avg": float(np.mean(y)),
        "n": int(len(y)),
    }
