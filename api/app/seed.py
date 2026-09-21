import json
from pathlib import Path

from sqlalchemy.orm import Session as DB

from .geo import haversine_m
from .models import Layout, MathChannel, Track
from .tracks_catalog import TRACKS
from .turns import turns_payload

DEFAULT_MATH = [
    {"name": "Combined G", "expression": "sqrt(gps_lat_g**2 + gps_long_g**2)", "unit": "g", "color": "#a371f7"},
    {"name": "Throttle-Brake overlap", "expression": "(tps > 5) * (brake > 5)", "unit": "", "color": "#f778ba"},
    {"name": "GPS vs wheel", "expression": "gps_speed_mph - wheel_speed_mph", "unit": "mph", "color": "#d29922"},
]

_OLD_WHEEL_EXPR = "gps_speed_mph - speed_mph"


def _find_layout(track: Track, lay: dict) -> Layout | None:
    want_dir = (lay["direction"] or "").upper()
    want_name = lay["name"]
    short = want_name.split()[0]
    if (lay.get("timing_mode") or "loop") == "stage":
        staged = [e for e in track.layouts if (e.timing_mode or "loop") == "stage"]
        if len(staged) == 1:
            return staged[0]
        for existing in staged:
            if existing.name == want_name:
                return existing
        for existing in track.layouts:
            n = (existing.name or "").lower()
            if "btg" in n or "gantry" in n:
                return existing
    for existing in track.layouts:
        if (existing.direction or "").upper() != want_dir:
            continue
        if existing.name == want_name or want_name.startswith(existing.name) or existing.name.startswith(short):
            return existing
    return None


def _catalog() -> list[dict]:
    rows = list(TRACKS)
    osm_path = Path(__file__).parent / "data" / "tracks_osm.json"
    if osm_path.exists():
        curated = {t["name"].lower() for t in TRACKS}
        for t in json.loads(osm_path.read_text()):
            if t.get("name", "").lower() not in curated:
                rows.append(t)
    return rows


def upsert_tracks(db: DB) -> None:
    by_name = {t.name.lower(): t for t in db.query(Track).all()}
    for spec in _catalog():
        track = by_name.get(spec["name"].lower())
        if not track:
            track = Track(name=spec["name"], venue=spec["venue"])
            db.add(track)
            db.flush()
            by_name[track.name.lower()] = track
        else:
            if spec.get("venue") and not track.venue:
                track.venue = spec["venue"]
        for lay in spec["layouts"]:
            payload = turns_payload(track.name, lay["name"], lay["length_m"])
            found = _find_layout(track, lay)
            if not found:
                db.add(
                    Layout(
                        track_id=track.id,
                        name=lay["name"],
                        direction=lay["direction"],
                        length_m=lay["length_m"],
                        centroid_lat=lay["centroid_lat"],
                        centroid_lon=lay["centroid_lon"],
                        match_radius_m=lay.get("match_radius_m", 8000),
                        sf_gate=lay.get("sf_gate"),
                        finish_gate=lay.get("finish_gate"),
                        timing_mode=lay.get("timing_mode") or "loop",
                        sectors=lay.get("sectors"),
                        turns=payload,
                    )
                )
                continue
            found.name = lay["name"]
            found.length_m = lay["length_m"]
            found.centroid_lat = lay["centroid_lat"]
            found.centroid_lon = lay["centroid_lon"]
            found.match_radius_m = lay.get("match_radius_m", 8000)
            found.turns = payload
            if lay.get("sf_gate") and not found.sf_gate:
                found.sf_gate = lay["sf_gate"]
            if lay.get("finish_gate") and not found.finish_gate:
                found.finish_gate = lay["finish_gate"]
            if lay.get("timing_mode") == "stage":
                found.timing_mode = "stage"
            elif not found.timing_mode:
                found.timing_mode = "loop"
            if lay.get("sectors") and not found.sectors:
                found.sectors = lay["sectors"]


def apply_layout_sectors(db: DB) -> None:
    """Published GPS splits (track-atlas + official COTA) onto matching layouts.

    Does not overwrite a layout that already has sector beacons (user-edited).
    """
    path = Path(__file__).parent / "data" / "layout_sectors.json"
    if not path.exists():
        return
    specs = json.loads(path.read_text())
    layouts: list[Layout] = db.query(Layout).all()
    for spec in specs:
        slat = float(spec["centroid_lat"])
        slon = float(spec["centroid_lon"])
        slen = float(spec.get("length_m") or 0)
        nearby = []
        for lay in layouts:
            if lay.track and (lay.track.venue or "") == "User":
                continue
            d = float(haversine_m(slat, slon, lay.centroid_lat, lay.centroid_lon))
            if d <= 9000:
                nearby.append((d, lay))
        if not nearby:
            continue
        want = (spec.get("track_name") or "").lower()
        named = [(d, lay) for d, lay in nearby if (lay.track.name if lay.track else "").lower() == want]
        nearby = named or nearby
        picked = None
        if slen and len(nearby) > 1:
            scored = []
            for d, lay in nearby:
                cl = float(lay.length_m or 0)
                if cl <= 0:
                    continue
                rel = abs(cl - slen) / max(slen, cl)
                if rel > 0.22:
                    continue
                scored.append((rel, d, lay))
            if scored:
                scored.sort(key=lambda x: (x[0], x[1]))
                picked = scored[0][2]
        if picked is None:
            nearby.sort(key=lambda x: x[0])
            picked = nearby[0][1]
        incoming = spec.get("sectors") or []
        existing = picked.sectors or []
        user_locked = any((g or {}).get("source") == "user" for g in existing)
        if incoming and not user_locked:
            picked.sectors = incoming
        if spec.get("sf_gate") and not picked.sf_gate:
            picked.sf_gate = spec["sf_gate"]
        # Official COTA sectors assume the SRO/Al Kamel timing line.
        if spec.get("source") == "sro-alkamel-2024" and spec.get("sf_gate") and not user_locked:
            picked.sf_gate = spec["sf_gate"]


def fill_missing_turns(db: DB) -> None:
    """OSM / leftover layouts that the curated table does not name."""
    for lay in db.query(Layout).all():
        turns = lay.turns if isinstance(lay.turns, dict) else {}
        if turns.get("count") is not None:
            continue
        name = (lay.name or "").lower()
        if "oval" in name:
            lay.turns = {"count": 4, "source": "catalog"}
            continue
        length = float(lay.length_m or 4000)
        lay.turns = {"count": int(max(6, min(73, round(length / 320.0)))), "source": "estimated"}


def seed_if_empty(db: DB) -> None:
    upsert_tracks(db)
    apply_layout_sectors(db)
    fill_missing_turns(db)
    if db.query(MathChannel).count() == 0:
        for m in DEFAULT_MATH:
            db.add(MathChannel(**m))
    else:
        stale = db.query(MathChannel).filter(MathChannel.expression == _OLD_WHEEL_EXPR).all()
        for row in stale:
            row.expression = "gps_speed_mph - wheel_speed_mph"
            if row.name == "GPS vs wheel (mph)":
                row.name = "GPS vs wheel"
    db.commit()
