"""Gauge.S column map and display metadata."""

from __future__ import annotations

import re
from dataclasses import dataclass

CHANNEL_MAP = {
    "Timestamp (ms)": "t_ms",
    "Date": "date_raw",
    "Hour (h)": "hour",
    "Minute (min)": "minute",
    "Second (s)": "second",
    "analog 1 (V)": "analog_1",
    "analog 2 (V)": "analog_2",
    "analog 3 (V)": "analog_3",
    "analog 4 (V)": "analog_4",
    "accel x (g)": "accel_x",
    "accel y (g)": "accel_y",
    "accel z (g)": "accel_z",
    "intake air temp (°F)": "iat",
    "coolant (°F)": "coolant",
    "economy (l/100km)": "economy",
    "econ avg 1 (l/100km)": "econ_avg_1",
    "econ avg 2 (l/100km)": "econ_avg_2",
    "trip 1 (km)": "trip_1",
    "trip 2 (km)": "trip_2",
    "fuel usage (l/h)": "fuel_usage",
    "engine speed (RPM)": "rpm",
    "engine load (mg/str)": "engine_load",
    "mass airflow (kg/h)": "maf",
    "maf voltage (V)": "maf_v",
    "knock current (°CRK)": "knock",
    "vanos (°CRK)": "vanos",
    "tps (%)": "tps",
    "ignition angle (°CRK)": "ignition",
    "fuel inj (ms)": "inj_ms",
    "speed (mph)": "speed_mph",
    "iacv (%)": "iacv",
    "lambda int 1 (%)": "lambda_int_1",
    "lambda int 2 (%)": "lambda_int_2",
    "lambda 1 (V)": "lambda_1",
    "lambda 2 (V)": "lambda_2",
    "battery voltage (V)": "battery",
    "wbo (AFR)": "afr",
    "diff (°F)": "diff_temp",
    "oil (°F)": "oil_temp",
    "oil psi (PSI)": "oil_psi",
    "brake psi (%)": "brake",
    "gps speed (km/h)": "gps_speed",
    "gps north (Angle)": "gps_heading",
    "gps altitude (m)": "alt",
    "gps latitude (°)": "lat",
    "gps longitude (°)": "lon",
}

# Extra exact matches after normalization (wording that changed between exports).
_HEADER_ALIASES = {
    "coolant temp f": "coolant",
    "oil temp f": "oil_temp",
    "oil pressure psi": "oil_psi",
    "oil pressure": "oil_psi",
    "engine speed": "rpm",
    "engine speed rpm": "rpm",
    "brake pressure": "brake",
    "diff temp f": "diff_temp",
}

_TOKEN_FOLD = {
    "latitude": "lat",
    "longitude": "lon",
    "lng": "lon",
    "lon": "lon",
    "pressure": "press",
    "press": "press",
    "temperature": "temp",
    "temp": "temp",
    "volt": "voltage",
    "volts": "voltage",
    "voltage": "voltage",
    "altitude": "alt",
    "elevation": "alt",
    "elev": "alt",
    "heading": "heading",
    "course": "heading",
    "bearing": "heading",
    "position": "pos",
    "pos": "pos",
    "throttle": "throttle",
    "tps": "tps",
    "rpm": "rpm",
    "lateral": "lat",
    "longitudinal": "long",
    "vertical": "vert",
    "milliseconds": "ms",
    "millisecond": "ms",
    "msec": "ms",
    "kph": "kmh",
    "kmh": "kmh",
    "mph": "mph",
    "battery": "battery",
    "batt": "battery",
    "coolant": "coolant",
    "water": "coolant",
    "ect": "coolant",
    "iat": "iat",
    "injector": "inj",
    "injection": "inj",
    "inj": "inj",
    "accel": "accel",
    "acc": "accel",
    "acceleration": "accel",
    "analog": "analog",
    "afr": "afr",
    "wbo": "afr",
    "lambda": "lambda",
    "brake": "brake",
    "gps": "gps",
    "speed": "speed",
    "engine": "engine",
    "north": "heading",
    "ground": "gps",
}


def _norm_header(name: str) -> str:
    s = str(name).replace("\ufeff", "").strip()
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    s = s.lower()
    s = s.replace("°", " ").replace("º", " ")
    s = s.replace("km/h", " kmh ").replace("km/hr", " kmh ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _tokens(name: str) -> tuple[str, ...]:
    parts = re.findall(r"[a-z]+|\d+", _norm_header(name))
    return tuple(_TOKEN_FOLD.get(p, p) for p in parts)


def _header_lookup() -> dict[str, str]:
    lookup = {_norm_header(src): dst for src, dst in CHANNEL_MAP.items()}
    lookup.update(_HEADER_ALIASES)
    return lookup


HEADER_LOOKUP = _header_lookup()


@dataclass(frozen=True)
class _Rule:
    key: str
    need: tuple[tuple[str, ...], ...]
    ban: tuple[str, ...] = ()
    weight: int = 10


# Semantic fallback when the exact Gauge.S label is missing or renamed.
_RULES: tuple[_Rule, ...] = (
    _Rule("lat", need=(("lat",),), ban=("g", "accel", "long", "lon"), weight=40),
    _Rule("lon", need=(("lon",),), ban=("g", "accel", "lat"), weight=40),
    _Rule("lon", need=(("long",), ("gps",)), ban=("g", "accel", "engine"), weight=30),
    _Rule("t_ms", need=(("timestamp",),), weight=40),
    _Rule("t_ms", need=(("time",),), ban=("date", "stamp", "lap"), weight=25),
    _Rule("datetime_raw", need=(("date",), ("time",)), weight=20),
    _Rule("date_raw", need=(("date",),), ban=("time",), weight=15),
    _Rule("hour", need=(("hour",),), weight=15),
    _Rule("minute", need=(("minute",),), weight=15),
    _Rule("second", need=(("second",),), ban=("time", "timestamp"), weight=10),
    _Rule("rpm", need=(("engine",), ("speed",)), ban=("gps",), weight=32),
    _Rule("rpm", need=(("rpm",),), ban=("gps", "oil", "p"), weight=30),
    _Rule("tps", need=(("tps",),), weight=30),
    _Rule("tps", need=(("throttle",),), weight=25),
    _Rule("brake", need=(("brake",),), weight=25),
    _Rule("gps_speed", need=(("gps",), ("speed",)), weight=35),
    _Rule("speed_mph", need=(("speed",),), ban=("gps", "engine", "air", "wheel"), weight=15),
    _Rule("gps_heading", need=(("heading",),), ban=("accel",), weight=25),
    _Rule("gps_heading", need=(("gps",), ("heading",)), weight=30),
    _Rule("alt", need=(("alt",),), ban=("analog",), weight=20),
    _Rule("coolant", need=(("coolant",),), weight=25),
    _Rule("oil_psi", need=(("oil",), ("press", "psi")), weight=30),
    _Rule("oil_temp", need=(("oil",), ("temp",)), ban=("press", "psi"), weight=28),
    _Rule("oil_temp", need=(("oil",),), ban=("press", "psi", "usage", "fuel"), weight=12),
    _Rule("iat", need=(("iat",),), weight=30),
    _Rule("iat", need=(("intake",),), weight=22),
    _Rule("battery", need=(("battery",),), weight=25),
    _Rule("afr", need=(("afr",),), weight=30),
    _Rule("accel_x", need=(("accel",), ("x", "long")), ban=("lat",), weight=25),
    _Rule("accel_y", need=(("accel",), ("y", "lat")), ban=("long", "lon"), weight=25),
    _Rule("accel_z", need=(("accel",), ("z", "vert")), weight=25),
    _Rule("analog_1", need=(("analog",), ("1",)), weight=20),
    _Rule("analog_2", need=(("analog",), ("2",)), weight=20),
    _Rule("analog_3", need=(("analog",), ("3",)), weight=20),
    _Rule("analog_4", need=(("analog",), ("4",)), weight=20),
    _Rule("maf_v", need=(("maf",), ("voltage",)), weight=25),
    _Rule("maf", need=(("maf",),), ban=("voltage",), weight=18),
    _Rule("maf", need=(("mass",), ("air",)), weight=16),
    _Rule("engine_load", need=(("engine",), ("load",)), weight=20),
    _Rule("knock", need=(("knock",),), weight=20),
    _Rule("vanos", need=(("vanos",),), weight=20),
    _Rule("ignition", need=(("ignition",),), weight=18),
    _Rule("inj_ms", need=(("inj",),), weight=18),
    _Rule("iacv", need=(("iacv", "iac"),), weight=18),
    _Rule("fuel_usage", need=(("fuel",),), ban=("inj",), weight=12),
    _Rule("economy", need=(("economy",),), ban=("avg",), weight=15),
    _Rule("econ_avg_1", need=(("econ", "economy"), ("avg",), ("1",)), weight=18),
    _Rule("econ_avg_2", need=(("econ", "economy"), ("avg",), ("2",)), weight=18),
    _Rule("trip_1", need=(("trip",), ("1",)), weight=15),
    _Rule("trip_2", need=(("trip",), ("2",)), weight=15),
    _Rule("lambda_int_1", need=(("lambda",), ("int",), ("1",)), weight=22),
    _Rule("lambda_int_2", need=(("lambda",), ("int",), ("2",)), weight=22),
    _Rule("lambda_1", need=(("lambda",), ("1",)), ban=("int",), weight=16),
    _Rule("lambda_2", need=(("lambda",), ("2",)), ban=("int",), weight=16),
    _Rule("diff_temp", need=(("diff",),), weight=15),
)


def _rule_score(rule: _Rule, toks: set[str]) -> int:
    if any(b in toks for b in rule.ban):
        return 0
    for group in rule.need:
        if not any(g in toks for g in group):
            return 0
    extra = sum(1 for group in rule.need for g in group if g in toks)
    return rule.weight + extra


TEMP_KEYS = ("iat", "coolant", "oil_temp", "diff_temp")
PRESS_KEYS = ("oil_psi",)
SPEED_KEYS = ("gps_speed", "gps_speed_mph", "speed_mph")
TEMP_HINT = {"temp", "oil", "coolant", "iat", "intake", "diff", "air"}


def canon_unit(unit: str | None) -> str | None:
    if not unit:
        return None
    key = re.sub(r"[^a-z0-9]+", "", str(unit).strip().lower())
    return {
        "c": "°C",
        "degc": "°C",
        "celsius": "°C",
        "f": "°F",
        "degf": "°F",
        "fahrenheit": "°F",
        "psi": "psi",
        "kpa": "kPa",
        "bar": "bar",
        "mph": "mph",
        "kmh": "km/h",
        "kph": "km/h",
        "ms": "ms",
        "s": "s",
    }.get(key, str(unit).strip() or None)


def infer_unit(header: str) -> str | None:
    """Best-effort unit from a raw header (mph vs km/h, °C vs °F, kPa vs psi)."""
    toks = set(_tokens(header))
    joined = " ".join(_tokens(header))
    if toks & {"celsius", "degc"} or ("c" in toks and toks & TEMP_HINT):
        return "°C"
    if toks & {"fahrenheit", "degf"} or ("f" in toks and toks & TEMP_HINT):
        return "°F"
    if "kpa" in toks:
        return "kPa"
    if "bar" in toks:
        return "bar"
    if "psi" in toks:
        return "psi"
    if "mph" in toks:
        return "mph"
    if "kmh" in toks or joined.endswith("km h") or " km h" in f" {joined} ":
        return "km/h"
    if "ms" in toks:
        return "ms"
    if toks & {"s", "sec", "secs"} and "ms" not in toks and "timestamp" not in toks:
        if "time" in toks or "timestamp" in toks:
            return "s"
    if "timestamp" in toks:
        return "ms"
    return None


def _finite_stats(series) -> tuple[float, float, float] | None:
    import numpy as np

    v = np.asarray(series, dtype=float)
    v = v[np.isfinite(v)]
    if v.size < 30:
        return None
    return float(np.min(v)), float(np.median(v)), float(np.max(v))


def detect_stored_units(df, header_units: dict | None = None) -> dict[str, str]:
    """Native units of columns in *df*.

    Named headers win. Empty Gauge.S labels like ``Oil temperature ()``
    fall back to ranges: 90 oil is °C, 330 pressure is kPa, 210 GPS is km/h.
    """
    out: dict[str, str] = {}
    for k, u in (header_units or {}).items():
        cu = canon_unit(u)
        if cu:
            out[str(k)] = cu

    cols = set(getattr(df, "columns", []))
    temp_c = temp_f = 0
    for k in TEMP_KEYS:
        if k not in cols:
            continue
        if k in out:
            if out[k] == "°C":
                temp_c += 2
            elif out[k] == "°F":
                temp_f += 2
            continue
        st = _finite_stats(df[k])
        if not st:
            continue
        _mn, med, mx = st
        if mx < 130 and med < 115:
            out[k] = "°C"
            temp_c += 1
        elif med > 130 or mx > 155:
            out[k] = "°F"
            temp_f += 1
    majority = "°C" if temp_c > temp_f else "°F" if temp_f > temp_c else None
    if majority:
        for k in TEMP_KEYS:
            if k in cols and not canon_unit((header_units or {}).get(k)):
                out[k] = majority

    for k in PRESS_KEYS:
        if k not in cols or k in out:
            continue
        st = _finite_stats(df[k])
        if not st:
            continue
        _mn, med, mx = st
        if mx > 150:
            out[k] = "kPa"
        elif mx <= 16 and med <= 10:
            out[k] = "bar"
        else:
            out[k] = "psi"

    gps_st = _finite_stats(df["gps_speed"]) if "gps_speed" in cols else None
    mph_st = _finite_stats(df["gps_speed_mph"]) if "gps_speed_mph" in cols else None
    wheel_st = _finite_stats(df["speed_mph"]) if "speed_mph" in cols else None

    if gps_st and mph_st and gps_st[2] > mph_st[2] * 1.15:
        out["gps_speed"] = "km/h"
        out["gps_speed_mph"] = "mph"
    else:
        if "gps_speed_mph" in cols:
            out.setdefault("gps_speed_mph", "mph")
        if gps_st and "gps_speed" not in out:
            if gps_st[2] > 160 or majority == "°C":
                out["gps_speed"] = "km/h"
            elif majority == "°F" or gps_st[2] <= 140:
                out["gps_speed"] = "mph"
            else:
                out["gps_speed"] = "km/h"

    if wheel_st and "speed_mph" not in out:
        gps_max = (gps_st or (0.0, 0.0, 0.0))[2]
        if gps_max > 20 and abs(wheel_st[2] - gps_max) / gps_max < 0.25:
            out["speed_mph"] = out.get("gps_speed") or "km/h"
        elif wheel_st[2] > 160 or majority == "°C":
            out["speed_mph"] = "km/h"
        else:
            out["speed_mph"] = "mph"

    return out


def _slug(name: str) -> str:
    n = _norm_header(name).replace(" ", "_")
    return re.sub(r"_+", "_", n).strip("_")


def map_headers(columns) -> dict[str, str]:
    """Map raw CSV headers to canonical channel keys.

    Matching is case-, punctuation-, and unit-insensitive, then falls back to
    token synonyms (throttle vs TPS, GPS Latitude vs lat, Time (s) vs Timestamp).
    """
    cols = [str(c) for c in columns]
    rename: dict[str, str] = {}
    used: set[str] = set()

    for col in cols:
        dst = HEADER_LOOKUP.get(_norm_header(col))
        if dst and dst not in used:
            rename[col] = dst
            used.add(dst)

    remaining = [c for c in cols if c not in rename]
    scored: list[tuple[int, str, str]] = []
    for col in remaining:
        toks = set(_tokens(col))
        if not toks:
            continue
        for rule in _RULES:
            if rule.key in used:
                continue
            score = _rule_score(rule, toks)
            if score:
                scored.append((score, rule.key, col))
    scored.sort(key=lambda row: -row[0])
    for _score, key, col in scored:
        if key in used or col in rename:
            continue
        rename[col] = key
        used.add(key)

    for col in cols:
        if col in rename or str(col).startswith("Unnamed"):
            continue
        slug = _slug(col)
        if slug and slug not in used:
            rename[col] = slug
            used.add(slug)
    return rename

DISPLAY = {
    "t_ms": ("Time", "ms"),
    "dist_m": ("Distance", "m"),
    "lat": ("GPS Latitude", "°"),
    "lon": ("GPS Longitude", "°"),
    "rpm": ("Engine RPM", "rpm"),
    "speed_mph": ("Speed", "mph"),
    "gps_speed": ("GPS Speed", "km/h"),
    "gps_speed_mph": ("GPS Speed", "mph"),
    "tps": ("Throttle", "%"),
    "brake": ("Brake", "%"),
    "accel_x": ("Accel X", "g"),
    "accel_y": ("Accel Y", "g"),
    "accel_z": ("Accel Z", "g"),
    "gps_long_g": ("Long G (GPS)", "g"),
    "gps_lat_g": ("Lat G (GPS)", "g"),
    "long_g": ("Long G", "g"),
    "lat_g": ("Lat G", "g"),
    "wheel_speed_mph": ("Wheel speed", "mph"),
    "heading_deg": ("Heading", "°"),
    "gps_heading": ("GPS Heading", "°"),
    "iat": ("Intake Temp", "°F"),
    "coolant": ("Coolant", "°F"),
    "oil_temp": ("Oil Temp", "°F"),
    "oil_psi": ("Oil Pressure", "psi"),
    "afr": ("AFR", "λ"),
    "battery": ("Battery", "V"),
    "ignition": ("Ignition Angle", "°"),
    "vanos": ("VANOS", "°"),
    "knock": ("Knock", "°"),
    "maf": ("MAF", "kg/h"),
    "engine_load": ("Engine Load", "mg/str"),
    "inj_ms": ("Injector", "ms"),
    "alt": ("Altitude", "m"),
    "analog_1": ("Analog 1", "V"),
    "analog_2": ("Analog 2", "V"),
    "analog_3": ("Analog 3", "V"),
    "analog_4": ("Analog 4", "V"),
    "diff_temp": ("Diff Temp", "°F"),
    "iacv": ("IACV", "%"),
}

DEFAULT_PLOT = ["gps_speed_mph", "rpm", "tps", "brake", "gps_long_g", "gps_lat_g"]

# Prefer these when the canonical name is missing
ALIASES = {
    "gps_speed_mph": ["gps_speed_mph", "speed_mph", "gps_speed"],
    "rpm": ["rpm"],
    "tps": ["tps"],
    "brake": ["brake"],
}


def display_meta(key: str, unit: str | None = None) -> dict:
    name, default_u = DISPLAY.get(key, (key.replace("_", " ").title(), ""))
    u = canon_unit(unit) or default_u
    return {"key": key, "name": name, "unit": u}
