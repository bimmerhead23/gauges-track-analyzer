from __future__ import annotations

import math
import re
import shutil
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from .channels import display_meta, infer_unit, map_headers
from .config import DATA_DIR
from .geo import cumulative_distance, gps_accel_g, path_heading


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
    units = {rename[c]: infer_unit(c) for c in rename}
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
    df["lat"] = lat
    df["lon"] = lon

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

    if "gps_speed" in df.columns:
        raw_spd = df["gps_speed"].to_numpy(dtype=float)
        raw_spd = np.where(np.isfinite(raw_spd), raw_spd, 0.0)
        if units.get("gps_speed") == "mph":
            df["gps_speed_mph"] = raw_spd
            df["gps_speed"] = raw_spd * 1.609344
            speed_mps = raw_spd * 0.44704
        else:
            df["gps_speed"] = raw_spd
            df["gps_speed_mph"] = raw_spd * 0.621371
            speed_mps = raw_spd / 3.6
    elif "speed_mph" in df.columns:
        speed_mps = df["speed_mph"].to_numpy(dtype=float) * 0.44704
        df["gps_speed_mph"] = df["speed_mph"]
    else:
        speed_mps = np.zeros(len(df))

    t_s = t / 1000.0
    long_g, lat_g = gps_accel_g(speed_mps, heading, t_s)
    df["gps_long_g"] = long_g
    df["gps_lat_g"] = lat_g
    return df


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
    out = []
    for key in sample_columns(df):
        meta = display_meta(key)
        meta["source"] = "derived" if key in {
            "dist_m", "heading_deg", "gps_long_g", "gps_lat_g", "gps_speed_mph"
        } else "logged"
        out.append(meta)
    return out


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


def load_samples(parquet_path: str) -> pd.DataFrame:
    return pd.read_parquet(parquet_path)
