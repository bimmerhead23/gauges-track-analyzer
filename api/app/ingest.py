from __future__ import annotations

import math
import re
import shutil
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from .channels import detect_stored_units, display_meta, infer_unit, map_headers
from .config import DATA_DIR
from .geo import accept_gps, cumulative_distance, gps_accel_g, path_heading


REQUIRED = {"t_ms", "lat", "lon"}


def _parse_started_at(df: pd.DataFrame, filename: str) -> datetime | None:
    if {"date_raw", "hour", "minute", "second"}.issubset(df.columns):
        raw = int(df["date_raw"].iloc[0])
        yy, mm, dd = raw // 10000, (raw // 100) % 100, raw % 100
        year = 2000 + yy if yy < 80 else 1900 + yy
        h = int(df["hour"].iloc[0])
        mi = int(df["minute"].iloc[0])
        s = int(df["second"].iloc[0])
        try:
            return datetime(year, mm, dd, h, mi, s)
        except ValueError:
            pass
    if "datetime_raw" in df.columns:
        parsed = pd.to_datetime(df["datetime_raw"].iloc[0], errors="coerce")
        if pd.notna(parsed):
            return parsed.to_pydatetime().replace(tzinfo=None)
    m = re.search(r"(\d{2})-(\d{2})-(\d{2})[_-](\d{2})-(\d{2})", filename)
    if m:
        yy, mm, dd, h, mi = map(int, m.groups())
        return datetime(2000 + yy, mm, dd, h, mi, 0)
    return None


def _read_csv(path: Path) -> pd.DataFrame:
    from .filesafe import MAX_CSV_ROWS, check_csv_shape

    kwargs = dict(
        engine="c",
        encoding="utf-8",
        encoding_errors="replace",
        nrows=MAX_CSV_ROWS + 1,
    )
    try:
        df = pd.read_csv(path, **kwargs)
    except UnicodeDecodeError:
        df = pd.read_csv(path, engine="c", encoding="latin-1", nrows=MAX_CSV_ROWS + 1)
    if df.shape[1] == 1:
        raw = str(df.columns[0])
        for sep in (";", "\t", "|"):
            if sep in raw:
                try:
                    df = pd.read_csv(path, sep=sep, **kwargs)
                except UnicodeDecodeError:
                    df = pd.read_csv(path, sep=sep, engine="c", encoding="latin-1", nrows=MAX_CSV_ROWS + 1)
                break
    check_csv_shape(df)
    return df


def parse_gauge_s(path: Path) -> pd.DataFrame:
    df = _read_csv(path)
    df.columns = [str(c).replace("\ufeff", "").strip() for c in df.columns]
    df = df.loc[:, ~df.columns.astype(str).str.match(r"^Unnamed")]
    orig_headers = [str(c) for c in df.columns]
    rename = map_headers(df.columns)
    header_units = {rename[c]: infer_unit(c) for c in rename}
    units = dict(header_units)
    df = df.rename(columns=rename)
    missing = REQUIRED - set(df.columns)
    if missing:
        labels = {"t_ms": "time", "lat": "latitude", "lon": "longitude"}
        need = ", ".join(labels.get(m, m) for m in sorted(missing))
        shown = ", ".join(orig_headers[:14])
        extra = f" (+{len(orig_headers) - 14} more)" if len(orig_headers) > 14 else ""
        raise ValueError(f"Could not find {need} in CSV headers ({shown}{extra})")

    skip_numeric = {"date_raw", "datetime_raw"}
    for col in df.columns:
        if col in skip_numeric:
            continue
        df[col] = pd.to_numeric(df[col], errors="coerce")

    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    valid = np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) > 0.1) & (np.abs(lon) > 0.1)
    lat = np.where(valid, lat, np.nan)
    lon = np.where(valid, lon, np.nan)

    t = df["t_ms"].to_numpy(dtype=float)
    t = np.nan_to_num(t, nan=0.0)
    if units.get("t_ms") == "s":
        t = t * 1000.0
    elif units.get("t_ms") != "ms" and len(t) > 8:
        diffs = np.diff(t)
        diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
        if len(diffs) and float(np.median(diffs)) < 1.0:
            t = t * 1000.0
    df["t_ms"] = t

    keep = accept_gps(lat, lon, valid, t)
    lat = np.where(keep, lat, np.nan)
    lon = np.where(keep, lon, np.nan)
    valid = keep
    df["lat"] = lat
    df["lon"] = lon

    if "gps_heading" in df.columns:
        hdg = df["gps_heading"].to_numpy(dtype=float)
        # logger uses 0 when no fix
        hdg = np.where(valid & (hdg != 0), hdg, np.nan)
    else:
        hdg = np.full(len(df), np.nan)
    path_h = path_heading(lat, lon, valid)
    heading = np.where(np.isfinite(hdg), hdg, path_h)
    df["heading_deg"] = heading

    df["dist_m"] = cumulative_distance(lat, lon, valid)

    stored = detect_stored_units(df, header_units)
    df.attrs["header_units"] = header_units
    df.attrs["stored_units"] = stored

    if "gps_speed" in df.columns:
        raw_spd = df["gps_speed"].to_numpy(dtype=float)
        raw_spd = np.where(np.isfinite(raw_spd), raw_spd, 0.0)
        gps_u = stored.get("gps_speed") or units.get("gps_speed")
        if gps_u == "mph":
            df["gps_speed_mph"] = raw_spd
            df["gps_speed"] = raw_spd * 1.609344
            speed_mps = raw_spd * 0.44704
        else:
            df["gps_speed"] = raw_spd
            df["gps_speed_mph"] = raw_spd * 0.621371
            speed_mps = raw_spd / 3.6
        stored["gps_speed"] = "km/h"
        stored["gps_speed_mph"] = "mph"
        df.attrs["stored_units"] = stored
    elif "speed_mph" in df.columns:
        raw_spd = df["speed_mph"].to_numpy(dtype=float)
        raw_spd = np.where(np.isfinite(raw_spd), raw_spd, 0.0)
        if stored.get("speed_mph") in ("km/h", "kmh"):
            speed_mps = raw_spd / 3.6
            df["gps_speed"] = raw_spd
            df["gps_speed_mph"] = raw_spd * 0.621371
            stored["gps_speed"] = "km/h"
            stored["gps_speed_mph"] = "mph"
        else:
            speed_mps = raw_spd * 0.44704
            df["gps_speed_mph"] = raw_spd
        df.attrs["stored_units"] = stored
    else:
        speed_mps = np.zeros(len(df))

    if "speed_mph" in df.columns:
        wheel = df["speed_mph"].to_numpy(dtype=float)
        wu = stored.get("speed_mph")
        if wu == "km/h":
            df["wheel_speed_mph"] = wheel * 0.621371
        elif wu == "mph":
            df["wheel_speed_mph"] = wheel
        elif "gps_speed_mph" in df.columns:
            df["wheel_speed_mph"] = _wheel_as_mph(wheel, df["gps_speed_mph"].to_numpy(dtype=float))
        else:
            df["wheel_speed_mph"] = wheel
        stored["wheel_speed_mph"] = "mph"
        df.attrs["stored_units"] = stored

    t_s = t / 1000.0
    long_g, lat_g = gps_accel_g(speed_mps, heading, t_s)
    df["gps_long_g"] = long_g
    df["gps_lat_g"] = lat_g
    oriented = _ecu_g(df, long_g, lat_g)
    if oriented is not None:
        df["long_g"], df["lat_g"] = oriented
        stored["long_g"] = "g"
        stored["lat_g"] = "g"
        df.attrs["stored_units"] = stored
    return df


def _wheel_as_mph(wheel: np.ndarray, gps_mph: np.ndarray) -> np.ndarray:
    """speed_mph is a historical key. Match it to GPS mph or treat it as km/h."""
    m = np.isfinite(wheel) & np.isfinite(gps_mph) & (gps_mph > 20)
    if int(m.sum()) < 30:
        return wheel
    med_w = float(np.median(wheel[m]))
    med_g = float(np.median(gps_mph[m]))
    if med_g > 5 and med_w > med_g * 1.3:
        return wheel * 0.621371
    return wheel


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    if int(m.sum()) < 80:
        return 0.0
    x = a[m] - float(np.mean(a[m]))
    y = b[m] - float(np.mean(b[m]))
    sx = float(np.std(x))
    sy = float(np.std(y))
    if sx < 1e-6 or sy < 1e-6:
        return 0.0
    return float(np.mean(x * y) / (sx * sy))


def _match_sign(ecu: np.ndarray, gps: np.ndarray) -> np.ndarray:
    pos = _corr(ecu, gps)
    neg = _corr(-ecu, gps)
    if neg > pos + 0.05:
        return -ecu
    return ecu


def _ecu_g(df: pd.DataFrame, gps_long: np.ndarray, gps_lat: np.ndarray):
    """Accelerometer G in the same frame as the GPS channels.

    Gauge.S does not promise which axis is longitudinal. Pair each raw axis
    with the GPS channel it actually follows, then flip the sign so
    +long is braking and +lat is a left turn.
    """
    if "accel_x" not in df.columns or "accel_y" not in df.columns:
        return None
    ax = df["accel_x"].to_numpy(dtype=float)
    ay = df["accel_y"].to_numpy(dtype=float)
    finite = ax[np.isfinite(ax)]
    if finite.size < 80:
        return None
    med = float(np.median(np.abs(finite)))
    peak = float(np.percentile(np.abs(finite), 99))
    if med > 3 or peak > 12 or peak < 0.05:
        return None
    if abs(_corr(ax, gps_lat)) >= abs(_corr(ay, gps_lat)):
        lat_raw, long_raw = ax, ay
    else:
        lat_raw, long_raw = ay, ax
    return _match_sign(long_raw, gps_long), _match_sign(lat_raw, gps_lat)


def repair_stored_g(sl: pd.DataFrame) -> pd.DataFrame:
    """Fix logs imported when accel X was assumed to be longitudinal.

    Scatter X is lat G (positive = left turn, drawn to the right) and Y is
    long G (positive = braking, drawn up). A swapped pair puts braking on X.
    """
    need = ("lat_g", "long_g", "gps_lat_g", "gps_long_g")
    if any(c not in sl.columns for c in need) or len(sl) < 80:
        return sl
    lat = sl["lat_g"].to_numpy(dtype=float)
    lon = sl["long_g"].to_numpy(dtype=float)
    glat = sl["gps_lat_g"].to_numpy(dtype=float)
    glong = sl["gps_long_g"].to_numpy(dtype=float)
    if abs(_corr(lon, glat)) > abs(_corr(lon, glong)) + 0.2:
        lat, lon = lon.copy(), lat.copy()
    if _corr(lat, glat) < -0.2:
        lat = -lat
    if _corr(lon, glong) < -0.2:
        lon = -lon
    sl["lat_g"] = lat
    sl["long_g"] = lon
    return sl


def sample_columns(df: pd.DataFrame) -> list[str]:
    skip = {"date_raw", "hour", "minute", "second", "datetime_raw"}
    cols = []
    for c in df.columns:
        if c in skip:
            continue
        if pd.api.types.is_numeric_dtype(df[c]):
            cols.append(c)
    # stable order: core first
    front = [c for c in ["t_ms", "dist_m", "lat", "lon", "heading_deg"] if c in cols]
    rest = [c for c in cols if c not in front]
    return front + rest


def write_session_files(session_id: int, src_csv: Path, df: pd.DataFrame) -> tuple[Path, Path]:
    from .filesafe import safe_filename

    folder = DATA_DIR / "sessions" / str(session_id)
    folder.mkdir(parents=True, exist_ok=True)
    raw = folder / safe_filename(src_csv.name)
    if src_csv.resolve() != raw.resolve():
        shutil.copy2(src_csv, raw)
    parquet = folder / "samples.parquet"
    cols = sample_columns(df)
    df[cols].to_parquet(parquet, index=False)
    return parquet, raw


def channel_catalog(df: pd.DataFrame) -> list[dict]:
    stored = dict(df.attrs.get("stored_units") or {})
    stored.update(detect_stored_units(df, df.attrs.get("header_units") or {}))
    out = []
    for key in sample_columns(df):
        meta = display_meta(key, stored.get(key))
        meta["source"] = "derived" if key in {
            "dist_m", "heading_deg", "gps_long_g", "gps_lat_g", "gps_speed_mph"
        } else "logged"
        out.append(meta)
    return out


def enrich_channel_units(session) -> bool:
    """Fix catalog units on an already-imported session (empty Gauge.S headers)."""
    path = getattr(session, "parquet_path", None)
    if not path or not session.channels:
        return False
    try:
        df = load_samples(path)
    except Exception:
        return False
    stored = detect_stored_units(df)
    changed = False
    next_ch = []
    for c in session.channels:
        if not isinstance(c, dict):
            next_ch.append(c)
            continue
        row = dict(c)
        u = stored.get(row.get("key"))
        if u and row.get("unit") != u:
            row["unit"] = u
            changed = True
        next_ch.append(row)
    if changed:
        session.channels = next_ch
    return changed


def gps_bbox(df: pd.DataFrame) -> dict | None:
    lat = df["lat"].to_numpy(dtype=float)
    lon = df["lon"].to_numpy(dtype=float)
    valid = np.isfinite(lat) & np.isfinite(lon)
    if not valid.any():
        return None
    return {
        "min_lat": float(np.nanmin(lat)),
        "max_lat": float(np.nanmax(lat)),
        "min_lon": float(np.nanmin(lon)),
        "max_lon": float(np.nanmax(lon)),
        "centroid_lat": float(np.nanmedian(lat[valid])),
        "centroid_lon": float(np.nanmedian(lon[valid])),
    }


_SAMPLE_CACHE: OrderedDict[tuple[str, int], pd.DataFrame] = OrderedDict()
_SAMPLE_CACHE_MAX = 8


def load_samples(parquet_path: str) -> pd.DataFrame:
    """Process-wide cache. Callers must not mutate the frame (lap_slice copies)."""
    path = Path(parquet_path)
    try:
        key = (str(path), path.stat().st_mtime_ns)
    except OSError:
        return pd.read_parquet(parquet_path)
    hit = _SAMPLE_CACHE.get(key)
    if hit is not None:
        _SAMPLE_CACHE.move_to_end(key)
        return hit
    df = pd.read_parquet(path)
    _SAMPLE_CACHE[key] = df
    while len(_SAMPLE_CACHE) > _SAMPLE_CACHE_MAX:
        _SAMPLE_CACHE.popitem(last=False)
    return df
