#!/usr/bin/env python3
"""Build GPS sector beacons from public track-atlas data + official COTA distances.

AiM Race Studio's .tkk track database is not published. This uses:
  - tobi/track-atlas OSM centerlines + published 3-sector splits
  - SRO / Al Kamel 2024 COTA sector lengths from the GT4 America notice

Output: api/app/data/layout_sectors.json
"""
from __future__ import annotations

import json
import math
import socket
import ssl
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from app.geo import gate_from_point, haversine_m, heading_deg  # noqa: E402
from app.tracks_catalog import COTA_SF, TRACKS  # noqa: E402

ATLAS_HOST = "raw.githubusercontent.com"
ATLAS_PREFIX = "/tobi/track-atlas/"
ATLAS_JSONL = f"https://{ATLAS_HOST}{ATLAS_PREFIX}main/tracks.jsonl"
ATLAS_GEO = f"https://{ATLAS_HOST}{ATLAS_PREFIX}main/tracks/{{slug}}/raw/{{path}}"
OUT = ROOT / "api" / "app" / "data" / "layout_sectors.json"

HALF_W = 16.0


_SSL = ssl.create_default_context()


def _decode_chunked(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        nl = data.find(b"\r\n", i)
        if nl < 0:
            break
        size = int(data[i:nl], 16)
        if size == 0:
            break
        start = nl + 2
        out.extend(data[start : start + size])
        i = start + size + 2
    return bytes(out)


def _get(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != ATLAS_HOST:
        raise ValueError(f"blocked URL host: {url}")
    if ".." in parsed.path.split("/") or not parsed.path.startswith(ATLAS_PREFIX):
        raise ValueError(f"blocked URL path: {url}")
    path = parsed.path or "/"
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {ATLAS_HOST}\r\n"
        "User-Agent: gauge-s-track-analyzer/1.0\r\n"
        "Accept: */*\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode()
    with socket.create_connection((ATLAS_HOST, 443), timeout=60) as raw:
        with _SSL.wrap_socket(raw, server_hostname=ATLAS_HOST) as sock:
            sock.sendall(req)
            buf = bytearray()
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf.extend(chunk)
    header, sep, body = bytes(buf).partition(b"\r\n\r\n")
    if not sep:
        raise RuntimeError(f"bad HTTP response for {path}")
    status_line = header.split(b"\r\n", 1)[0].decode("ascii", "replace")
    if " 200 " not in f" {status_line} ":
        raise RuntimeError(f"GET {path} -> {status_line}")
    if b"transfer-encoding: chunked" in header.lower():
        return _decode_chunked(body)
    return body


def _open_ring(coords: list[list[float]]) -> list[list[float]]:
    if len(coords) >= 2 and coords[0] == coords[-1]:
        return coords[:-1]
    return list(coords)


def _cum(coords: list[list[float]]) -> list[float]:
    out = [0.0]
    for i in range(1, len(coords)):
        lon0, lat0 = coords[i - 1]
        lon1, lat1 = coords[i]
        out.append(out[-1] + float(haversine_m(lat0, lon0, lat1, lon1)))
    return out


def _at_dist(coords: list[list[float]], cum: list[float], dist: float) -> tuple[float, float, float]:
    total = cum[-1]
    d = dist % total if total > 0 else 0.0
    for i in range(1, len(cum)):
        if cum[i] >= d:
            span = cum[i] - cum[i - 1] or 1e-9
            t = (d - cum[i - 1]) / span
            lon0, lat0 = coords[i - 1]
            lon1, lat1 = coords[i]
            lat = lat0 + t * (lat1 - lat0)
            lon = lon0 + t * (lon1 - lon0)
            hdg = heading_deg(lat0, lon0, lat1, lon1)
            return lat, lon, hdg
    lon, lat = coords[-1]
    lon0, lat0 = coords[-2] if len(coords) > 1 else coords[-1]
    return lat, lon, heading_deg(lat0, lon0, lat, lon)


def _nearest_i(coords: list[list[float]], lat: float, lon: float) -> int:
    best = 0
    bd = 1e18
    for i, (x, y) in enumerate(coords):
        d = float(haversine_m(lat, lon, y, x))
        if d < bd:
            bd = d
            best = i
    return best


def _rotate(coords: list[list[float]], i0: int) -> list[list[float]]:
    return coords[i0:] + coords[:i0]


def _signed_area(coords: list[list[float]]) -> float:
    a = 0.0
    n = len(coords)
    if n < 3:
        return 0.0
    for i in range(n):
        x1, y1 = coords[i]
        x2, y2 = coords[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a


def _orient(coords: list[list[float]], direction: str) -> list[list[float]]:
    """Keep index 0 (S/F) and walk in the racing direction."""
    want = (direction or "").upper()
    if want not in ("CW", "CCW"):
        return coords
    ccw = _signed_area(coords) > 0
    if (want == "CCW" and ccw) or (want == "CW" and not ccw):
        return coords
    return [coords[0]] + list(reversed(coords[1:]))


def _gate(lat: float, lon: float, hdg: float, source: str) -> dict:
    g = gate_from_point(lat, lon, hdg, HALF_W)
    g["source"] = source
    return g


def _outline(geo: dict) -> list[list[float]] | None:
    for feat in geo.get("features") or []:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        if props.get("role") == "outline" and geom.get("type") == "LineString":
            return _open_ring(geom.get("coordinates") or [])
    return None


def _corner_loop(geo: dict, sf: dict | None) -> list[list[float]] | None:
    """S/F + numbered apexes in racing order — cleaner than a messy OSM relation."""
    corners: list[tuple[int, float, float]] = []
    atlas_sf = None
    for feat in geo.get("features") or []:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if props.get("role") == "start_finish":
            atlas_sf = [lon, lat]
        if props.get("role") == "corner" and props.get("number") is not None:
            corners.append((int(props["number"]), lat, lon))
    if len(corners) < 4:
        return None
    corners.sort(key=lambda c: c[0])
    if sf and sf.get("lat") is not None:
        start = [float(sf["lon"]), float(sf["lat"])]
    elif atlas_sf:
        start = atlas_sf
    else:
        n, lat, lon = corners[0]
        start = [lon, lat]
    pts = [start]
    for _, lat, lon in corners:
        if float(haversine_m(start[1], start[0], lat, lon)) < 40 and len(pts) == 1:
            continue
        pts.append([lon, lat])
    if len(pts) < 5:
        return None
    return pts


def _corners_by_number(geo: dict) -> dict[int, tuple[float, float]]:
    out: dict[int, tuple[float, float]] = {}
    for feat in geo.get("features") or []:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        if props.get("role") != "corner" or geom.get("type") != "Point":
            continue
        n = props.get("number")
        coords = geom.get("coordinates") or []
        if n is None or len(coords) < 2:
            continue
        out[int(n)] = (float(coords[1]), float(coords[0]))
    return out


def _gate_between_corners(corners: dict[int, tuple[float, float]], n: int, source: str) -> dict | None:
    if n not in corners:
        return None
    lat, lon = corners[n]
    nxt = corners.get(n + 1) or corners.get(min(corners))
    if nxt:
        hdg = heading_deg(lat, lon, nxt[0], nxt[1])
    else:
        hdg = 0.0
    return _gate(lat, lon, hdg, source)


def _sector_fracs(layout: dict) -> list[float]:
    for rl in layout.get("range_layers") or []:
        if rl.get("kind") != "timing_sectors" and rl.get("id") != "timing_sectors":
            continue
        ends = []
        for it in rl.get("items") or []:
            end = it.get("end")
            if end is None:
                continue
            e = float(end)
            if 0.04 < e < 0.96:
                ends.append(e)
        ends = sorted(set(round(e, 5) for e in ends))
        return ends
    return []


def _catalog_hits() -> list[dict]:
    rows = []
    for t in TRACKS:
        for lay in t["layouts"]:
            rows.append({
                "track_name": t["name"],
                "layout_name": lay["name"],
                "direction": lay["direction"],
                "length_m": lay["length_m"],
                "centroid_lat": lay["centroid_lat"],
                "centroid_lon": lay["centroid_lon"],
                "sf_gate": lay.get("sf_gate"),
            })
    return rows


def _norm_name(s: str) -> str:
    s = (s or "").lower()
    for w in (
        "circuit", "international", "raceway", "speedway", "park", "the",
        "michelin", "weathertech", "autodromo", "autódromo", "nazionale",
        "grand prix", "gp",
    ):
        s = s.replace(w, " ")
    return " ".join(s.split())


def _name_hit(atlas_name: str, catalog_name: str) -> bool:
    a = _norm_name(atlas_name)
    b = _norm_name(catalog_name)
    if not a or not b:
        return False
    return a == b or a in b or b in a


def _pick_length(nearby: list[tuple[float, dict]], atlas_len: float | None) -> dict:
    if atlas_len and len(nearby) > 1:
        scored = []
        for d, c in nearby:
            cl = float(c["length_m"] or 0)
            if cl <= 0:
                continue
            rel = abs(cl - atlas_len) / max(atlas_len, cl)
            if rel > 0.22:
                continue
            scored.append((rel, d, c))
        if scored:
            scored.sort(key=lambda x: (x[0], x[1]))
            return scored[0][2]
    nearby.sort(key=lambda x: x[0])
    return nearby[0][1]


def _match(
    atlas_name: str,
    atlas_lat: float,
    atlas_lon: float,
    atlas_len: float | None,
    catalog: list[dict],
) -> dict | None:
    nearby = []
    for c in catalog:
        d = float(haversine_m(atlas_lat, atlas_lon, c["centroid_lat"], c["centroid_lon"]))
        if d <= 9000:
            nearby.append((d, c))
    if nearby:
        return _pick_length(nearby, atlas_len)
    named = []
    for c in catalog:
        if _name_hit(atlas_name, c["track_name"]):
            named.append((0.0, c))
    if named:
        return _pick_length(named, atlas_len)
    return None


def build() -> list[dict]:
    catalog = _catalog_hits()
    tracks = []
    for line in _get(ATLAS_JSONL).decode().splitlines():
        line = line.strip()
        if line:
            tracks.append(json.loads(line))

    out = []
    seen = set()
    for t in tracks:
        slug = t.get("slug")
        loc = t.get("location") or {}
        for lay in t.get("layouts") or []:
            geom = (lay.get("geometry") or {}).get("centerline")
            if not geom:
                continue
            fracs = _sector_fracs(lay)
            if len(fracs) < 1:
                continue
            atlas_lat = float(loc.get("lat") or 0)
            atlas_lon = float(loc.get("lon") or 0)
            hit = _match(t.get("name") or "", atlas_lat, atlas_lon, lay.get("length_m"), catalog)
            if not hit:
                print(f"unmatched {t.get('name')} {lay.get('name')}")
                continue
            url = ATLAS_GEO.format(slug=slug, path=geom)
            try:
                geo = json.loads(_get(url).decode())
            except Exception as exc:
                print(f"skip {slug}/{lay.get('id')}: {exc}")
                continue
            coords = _corner_loop(geo, hit.get("sf_gate")) or _outline(geo)
            if not coords or len(coords) < 5:
                print(f"skip {slug}/{lay.get('id')}: no geometry")
                continue
            key = (hit["track_name"], hit["layout_name"], hit["direction"])
            if key in seen:
                continue
            seen.add(key)

            sf = hit.get("sf_gate")
            if sf and sf.get("lat") and sf.get("lon"):
                i0 = _nearest_i(coords, float(sf["lat"]), float(sf["lon"]))
                source = (sf.get("source") or "catalog-sf") + "+track-atlas"
            else:
                # Prefer atlas S/F point if present
                i0 = 0
                for feat in geo.get("features") or []:
                    if (feat.get("properties") or {}).get("role") == "start_finish":
                        lon, lat = (feat.get("geometry") or {}).get("coordinates") or [None, None]
                        if lat is not None:
                            i0 = _nearest_i(coords, lat, lon)
                        break
                source = "track-atlas"

            ring = _orient(_rotate(coords, i0), hit["direction"])
            cum = _cum(ring)
            total = cum[-1]
            if total < 500:
                continue

            # COTA: SRO/Al Kamel lengths 1308.8 m and 3548.8 m along a flown
            # Gauge.S lap from the published timing line (OSM apexes do not
            # sit on that GPS path).
            if hit["track_name"] == "Circuit of the Americas" and hit["layout_name"] == "Grand Prix":
                source = "sro-alkamel-2024"
                sectors = [
                    {
                        "a": {"lat": 30.13454785468524, "lon": -97.63403049639012},
                        "b": {"lat": 30.13478494524737, "lon": -97.6342191038364},
                        "heading": 55.472285323706046,
                        "lat": 30.1346664,
                        "lon": -97.6341248,
                        "source": source,
                    },
                    {
                        "a": {"lat": 30.13774093645087, "lon": -97.63473133759179},
                        "b": {"lat": 30.13745506354636, "lon": -97.63469306246364},
                        "heading": 263.3951437348652,
                        "lat": 30.137598,
                        "lon": -97.6347122,
                        "source": source,
                    },
                ]
            else:
                dists = [f * total for f in fracs]
                sectors = []
                for dist in dists:
                    if dist < 80 or total - dist < 80:
                        continue
                    lat, lon, hdg = _at_dist(ring, cum, dist)
                    sectors.append(_gate(lat, lon, hdg, source))
            if not sectors:
                continue

            rec = {
                "track_name": hit["track_name"],
                "layout_name": hit["layout_name"],
                "direction": hit["direction"],
                "length_m": hit["length_m"],
                "centroid_lat": hit["centroid_lat"],
                "centroid_lon": hit["centroid_lon"],
                "source": source,
                "sectors": sectors,
            }
            if hit.get("sf_gate"):
                rec["sf_gate"] = hit["sf_gate"]
            elif not hit.get("sf_gate"):
                lat, lon, hdg = _at_dist(ring, cum, 0.0)
                rec["sf_gate"] = _gate(lat, lon, hdg, "track-atlas")
            out.append(rec)
            print(f"ok {hit['track_name']} / {hit['layout_name']}  {len(sectors)} splits  {source}")
    return out


def main():
    rows = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, indent=2) + "\n")
    print(f"wrote {len(rows)} layouts -> {OUT}")


if __name__ == "__main__":
    main()
