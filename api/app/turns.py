"""Numbered corners from S/F along the driven lap, for Coach.

Official counts/names come from the catalog. Apexes are detected on a flying
lap (speed valleys + lateral G) so they match *this* start/finish line.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

def _t(count: int, names: dict | None = None, complexes: list | None = None) -> dict:
    out: dict = {"count": int(count), "source": "catalog"}
    if names:
        out["names"] = {int(k): v for k, v in names.items()}
    if complexes:
        out["complexes"] = complexes
    return out


# Official turn counts + nicknames. Numbering is in the driven direction from S/F.
# Keys are (track name, layout name), lowercased. Same count both ways unless noted.
LAYOUT_TURNS: dict[tuple[str, str], dict] = {
    ("circuit of the americas", "grand prix"): _t(
        20,
        {1: "Big Red", 11: "Bobby Pin", 20: "Andretti"},
        [
            {"turns": [3, 4, 5, 6], "name": "Esses"},
            {"turns": [13, 14, 15], "name": "Stadium"},
            {"turns": [16, 17, 18], "name": "Carousel"},
        ],
    ),
    ("harris hill raceway", "full course"): _t(11, {4: "Santa Rita"}),
    ("msr houston", "2.38 cw"): _t(17, complexes=[{"turns": [6, 7, 8], "name": "Diamond's Edge"}, {"turns": [12, 13], "name": "Carousel"}]),
    ("msr houston", "2.38 ccw"): _t(17, complexes=[{"turns": [6, 7, 8], "name": "Diamond's Edge"}, {"turns": [12, 13], "name": "Carousel"}]),
    ("msr cresson", "3.1 cw"): _t(16),
    ("msr cresson", "3.1 ccw"): _t(16),
    ("msr cresson", "1.7 cw"): _t(11),
    ("msr cresson", "1.7 ccw"): _t(11),
    ("msr cresson", "1.3 ccw"): _t(10),
    ("eagles canyon raceway", "2.7 cw"): _t(15),
    ("eagles canyon raceway", "2.7 ccw"): _t(15),
    ("road atlanta", "full course"): _t(12),
    ("barber motorsports park", "full course"): _t(16),
    ("sebring international raceway", "full course"): _t(17, {17: "Sunset Bend"}),
    ("daytona international speedway", "road course"): _t(12, complexes=[{"turns": [1, 2, 3], "name": "Bus Stop"}]),
    ("daytona international speedway", "oval"): _t(4),
    ("nola motorsports park", "full course"): _t(16),
    ("virginia international raceway", "full course"): _t(17),
    ("road america", "full course"): _t(14, {5: "Carousel", 11: "Kink", 12: "Canada Corner"}),
    ("watkins glen international", "grand prix"): _t(
        11,
        {10: "Inner Loop"},
        [{"turns": [2, 3, 4], "name": "Esses"}, {"turns": [6, 7, 8, 9], "name": "The Boot"}],
    ),
    ("lime rock park", "full course"): _t(7, {1: "Big Bend", 5: "Downhill"}),
    ("new hampshire motor speedway", "road course"): _t(12),
    ("mid-ohio sports car course", "full course"): _t(15, {2: "Keyhole", 4: "Madness"}),
    ("pittsburgh international race complex", "full course"): _t(19),
    ("njmp thunderbolt", "thunderbolt"): _t(10),
    ("njmp lightning", "lightning"): _t(10),
    ("summit point", "main"): _t(10),
    ("laguna seca", "full course"): _t(11, {2: "Andretti", 8: "Corkscrew", 9: "Rainey"}),
    ("sonoma raceway", "full course"): _t(12, {7: "The Carousel", 10: "The Theseus"}),
    ("thunderhill raceway park", "east 3-mile"): _t(15),
    ("thunderhill raceway park", "west 2-mile"): _t(10),
    ("thunderhill raceway park", "5-mile"): _t(23),
    ("buttonwillow raceway park", "full course"): _t(17),
    ("willow springs", "big willow"): _t(9),
    ("autobahn country club", "north"): _t(12),
    ("autobahn country club", "south"): _t(8),
    ("autobahn country club", "full"): _t(17),
    ("gingerman raceway", "full course"): _t(11),
    ("ncm motorsports park", "full course"): _t(16),
    ("indianapolis motor speedway", "road course"): _t(14),
    ("indianapolis motor speedway", "oval"): _t(4),
    ("hallett motor racing circuit", "full course"): _t(10),
    ("high plains raceway", "full course"): _t(15),
    ("utah motorsports campus", "outer"): _t(16),
    ("portland international raceway", "full course"): _t(12),
    ("pacific raceways", "full course"): _t(10),
    ("the ridge motorsports park", "full course"): _t(16),
    ("ozarks international raceway", "full course"): _t(18),
    ("heartland motorsports park", "road course"): _t(14),
    ("homestead-miami speedway", "road course"): _t(11),
    ("st. petersburg street circuit", "street"): _t(14),
    ("long beach street circuit", "street"): _t(11),
    ("miami international autodrome", "grand prix"): _t(19),
    ("las vegas strip circuit", "grand prix"): _t(17),
    ("circuit gilles villeneuve", "grand prix"): _t(14, {10: "Hairpin", 13: "Casino"}),
    ("canadian tire motorsport park", "full course"): _t(10, {2: "Moss Corner", 5: "Mario's"}),
    ("circuit mont-tremblant", "full course"): _t(15),
    ("calabogie motorsports park", "full course"): _t(20),
    ("autodromo hermanos rodriguez", "grand prix"): _t(17, complexes=[{"turns": [12, 13, 14, 15, 16, 17], "name": "Stadium"}]),
    ("silverstone circuit", "grand prix"): _t(
        18,
        {9: "Copse", 15: "Stowe", 16: "Vale", 17: "Club"},
        [{"turns": [10, 11, 12, 13, 14], "name": "Maggots-Becketts-Chapel"}],
    ),
    ("spa-francorchamps", "grand prix"): _t(
        19,
        {1: "La Source", 7: "Rivage", 8: "Pouhon", 12: "Stavelot", 15: "Blanchimont"},
        [{"turns": [3, 4, 5], "name": "Eau Rouge-Raidillon"}, {"turns": [18, 19], "name": "Bus Stop"}],
    ),
    ("nurburgring gp", "grand prix"): _t(15),
    ("nurburgring nordschleife", "nordschleife"): _t(73),
    ("monza", "grand prix"): _t(11, {1: "Rettifilo", 4: "Roggia", 8: "Lesmo", 10: "Ascari", 11: "Parabolica"}),
    ("imola", "grand prix"): _t(19, {2: "Tamburello", 4: "Villeneuve", 6: "Tosa", 11: "Piratella", 12: "Acque Minerali", 15: "Rivazza"}),
    ("mugello", "grand prix"): _t(15, {12: "Arrabbiata 1", 13: "Arrabbiata 2", 15: "Bucine"}),
    ("circuit de barcelona-catalunya", "grand prix"): _t(16, {10: "La Caixa", 16: "New Holland"}),
    ("paul ricard", "grand prix"): _t(15, {11: "Signes"}),
    ("hungaroring", "grand prix"): _t(14),
    ("red bull ring", "grand prix"): _t(10),
    ("zandvoort", "grand prix"): _t(14, {3: "Hugenholtz", 7: "Scheivlak", 13: "Bos Uit"}),
    ("monaco", "grand prix"): _t(
        19,
        {
            1: "Sainte Devote",
            4: "Casino",
            5: "Mirabeau",
            6: "Loews",
            8: "Portier",
            10: "Nouvelle Chicane",
            12: "Tabac",
            18: "Rascasse",
            19: "Antony Noghes",
        },
        [{"turns": [13, 14, 15, 16], "name": "Swimming Pool"}],
    ),
    ("brands hatch", "gp"): _t(9, {1: "Paddock Hill", 2: "Druids", 3: "Graham Hill", 6: "Surtees", 8: "Stirling's"}),
    ("brands hatch", "indy"): _t(6),
    ("donington park", "gp"): _t(12, {7: "Craner Curves", 11: "Melbourne Hairpin"}),
    ("oulton park", "international"): _t(17),
    ("portimao", "grand prix"): _t(15),
    ("estoril", "grand prix"): _t(13),
    ("hockenheimring", "grand prix"): _t(17, complexes=[{"turns": [12, 13, 14, 15], "name": "Stadium"}]),
    ("sachsenring", "gp"): _t(13),
    ("assen", "gp"): _t(18),
    ("le mans bugatti", "bugatti"): _t(14),
    ("circuit de la sarthe", "24 hours"): _t(
        38,
        {7: "Tertre Rouge", 8: "Mulsanne", 9: "Indianapolis", 10: "Arnage"},
        [{"turns": [31, 32, 33], "name": "Porsche Curves"}, {"turns": [36, 37, 38], "name": "Ford Chicanes"}],
    ),
    ("valencia ricardo tormo", "gp"): _t(14),
    ("jerez", "gp"): _t(13, {6: "Dry Sack"}),
    ("suzuka", "grand prix"): _t(
        18,
        {8: "Degner 1", 9: "Degner 2", 14: "Spoon", 15: "130R"},
        [{"turns": [3, 4, 5, 6, 7], "name": "S Curves"}, {"turns": [16, 17, 18], "name": "Casio Triangle"}],
    ),
    ("fuji speedway", "grand prix"): _t(16, {1: "First", 13: "Coca-Cola"}),
    ("shanghai international circuit", "grand prix"): _t(16),
    ("marina bay street circuit", "grand prix"): _t(19, {1: "Sheares", 7: "Memorial", 10: "Singapore Sling"}),
    ("bahrain international circuit", "grand prix"): _t(15),
    ("yas marina", "grand prix"): _t(16),
    ("jeddah corniche circuit", "grand prix"): _t(27),
    ("losail international circuit", "grand prix"): _t(16),
    ("albert park", "grand prix"): _t(14),
    ("phillip island", "gp"): _t(12, {1: "Dooen", 3: "Southern Loop", 4: "Stoner", 8: "Honda", 11: "Lukey Heights"}),
    ("interlagos", "grand prix"): _t(15, {1: "S do Senna", 4: "Descida do Lago", 12: "Junção"}),
    ("kyalami", "grand prix"): _t(16, {1: "The Kink", 8: "Crowthorne", 16: "Mineshaft"}),
}


def estimated_count(length_m: float) -> int:
    return int(np.clip(round(float(length_m or 4000) / 320.0), 6, 73))


def _normalize(spec: dict, source: str = "catalog") -> dict:
    names = spec.get("names") or {}
    names_i = {}
    for k, v in names.items():
        try:
            names_i[int(k)] = v
        except (TypeError, ValueError):
            continue
    out = {"count": int(spec["count"]), "source": spec.get("source") or source, "names": names_i}
    if spec.get("complexes"):
        out["complexes"] = spec["complexes"]
    return out


def turns_payload(track_name: str, layout_name: str, length_m: float) -> dict:
    """JSON-safe turns metadata to store on layouts.turns."""
    spec = spec_for(track_name, layout_name, length_m)
    payload = {"count": spec["count"], "source": spec.get("source") or "catalog"}
    if spec.get("names"):
        payload["names"] = {str(k): v for k, v in spec["names"].items()}
    if spec.get("complexes"):
        payload["complexes"] = spec["complexes"]
    return payload


def spec_for(track_name: str, layout_name: str, length_m: float = 0.0) -> dict:
    t = (track_name or "").strip().lower()
    n = (layout_name or "").strip().lower()
    if "oval" in n:
        return _t(4)
    hit = LAYOUT_TURNS.get((t, n))
    if hit:
        return hit
    for (tt, nn), spec in LAYOUT_TURNS.items():
        if tt != t:
            continue
        token = n.split()[0] if n else ""
        if token and (n.startswith(nn) or nn.startswith(token)):
            return spec
    return {"count": estimated_count(length_m), "source": "estimated", "names": {}}


def catalog_for(layout) -> dict:
    raw = getattr(layout, "turns", None) if layout is not None else None
    if isinstance(raw, dict) and int(raw.get("count") or 0) >= 3:
        return _normalize(raw, source=str(raw.get("source") or "db"))
    track = ""
    name = ""
    length = 0.0
    if layout is not None:
        name = (layout.name or "").strip()
        length = float(layout.length_m or 0)
        if getattr(layout, "track", None) is not None:
            track = (layout.track.name or "").strip()
    return spec_for(track, name, length)


def _smooth(y: np.ndarray, k: int = 5) -> np.ndarray:
    y = np.nan_to_num(y, nan=float(np.nanmean(y) if np.isfinite(y).any() else 0.0))
    k = max(3, min(k, len(y) // 4 * 2 + 1))
    if k < 3 or len(y) < k:
        return y
    return np.convolve(y, np.ones(k) / k, mode="same")


def detect_apexes(sl: pd.DataFrame, n_turns: int, min_sep_m: float = 80.0) -> list[float]:
    if sl is None or sl.empty or n_turns < 3:
        return []
    if "lap_dist_m" not in sl.columns or "gps_speed_mph" not in sl.columns:
        return []
    d = sl["lap_dist_m"].to_numpy(dtype=float)
    sp = sl["gps_speed_mph"].to_numpy(dtype=float)
    if "gps_lat_g" in sl.columns:
        g = np.abs(sl["gps_lat_g"].to_numpy(dtype=float))
    else:
        g = np.zeros(len(d))
    n = min(len(d), len(sp), len(g))
    if n < 40:
        return []
    d, sp, g = d[:n], sp[:n], np.nan_to_num(g[:n], nan=0.0)
    sm = _smooth(sp, 5)
    gl = _smooth(g, 5)
    cands: list[tuple[float, float]] = []
    for i in range(6, n - 6):
        speed_min = (
            sm[i] <= sm[i - 1]
            and sm[i] <= sm[i + 1]
            and sm[i] < sm[max(0, i - 8) : i].max()
            and sm[i] < sm[i + 1 : min(n, i + 9)].max()
        )
        g_peak = gl[i] >= gl[i - 1] and gl[i] >= gl[i + 1] and gl[i] > 0.45
        if not (speed_min or g_peak):
            continue
        depth = float(
            max(
                0.0,
                min(sm[max(0, i - 8) : i + 1].max(), sm[i : min(n, i + 9)].max()) - sm[i],
            )
        )
        if gl[i] < 0.35 and depth < 3:
            continue
        score = float(gl[i] * 12 + depth * 0.4 + (25 if sm[i] < 50 else 0))
        cands.append((score, float(d[i])))
    cands.sort(reverse=True)
    picked: list[tuple[float, float]] = []
    for score, dist in cands:
        if any(abs(dist - p[1]) < min_sep_m for p in picked):
            continue
        picked.append((score, dist))
        if len(picked) >= n_turns + 4:
            break
    if len(picked) > n_turns:
        picked = sorted(picked, key=lambda x: -x[0])[:n_turns]
    return sorted(p[1] for p in picked)


def _bounds(apices: list[float], length: float) -> list[tuple[float, float]]:
    if not apices or length <= 0:
        return []
    ext = [apices[-1] - length] + list(apices) + [apices[0] + length]
    out = []
    for i, a in enumerate(apices):
        d0 = (ext[i] + a) / 2.0
        d1 = (a + ext[i + 2]) / 2.0
        out.append((d0 % length, d1 % length if d1 != length else length))
    return out


def build_turns(sl: pd.DataFrame, layout, length_m: float) -> list[dict]:
    spec = catalog_for(layout)
    n = int(spec.get("count") or 0)
    if n < 3:
        n = int(np.clip(round((length_m or 4000) / 320.0), 8, 22))
    apices = detect_apexes(sl, n)
    if len(apices) < max(4, n // 2):
        return []
    length = float(length_m or (sl["lap_dist_m"].iloc[-1] if sl is not None and not sl.empty else 0))
    if length <= 0:
        return []
    names = spec.get("names") or {}
    complexes = spec.get("complexes") or []
    bounds = _bounds(apices, length)
    turns = []
    for i, apex in enumerate(apices):
        idx = i + 1
        d0, d1 = bounds[i]
        nick = names.get(idx)
        complex_name = None
        for c in complexes:
            if idx in (c.get("turns") or []):
                complex_name = c.get("name")
                break
        turns.append({
            "n": idx,
            "apex_m": round(apex, 1),
            "d0_m": round(d0, 1),
            "d1_m": round(d1, 1),
            "name": nick,
            "complex": complex_name,
        })
    return turns


def _in_span(x: float, d0: float, d1: float, length: float) -> bool:
    if d1 > d0:
        return d0 <= x < d1
    return x >= d0 or x < d1


def _phase(mid: float, apex: float, d0: float, d1: float, length: float) -> str:
    def circ(a, b):
        return (b - a) % length

    before = circ(d0, apex) or length * 0.3
    after = circ(apex, d1) or length * 0.3
    if circ(d0, mid) < before * 0.45:
        return "entry"
    if circ(mid, d1) < after * 0.45:
        return "exit"
    return "apex"


def locate_window(turns: list[dict], d0: float, d1: float, length: float) -> dict:
    """Map a distance window to Turn N entry/apex/exit or a straight between turns."""
    if not turns or length <= 0:
        return {"label": None, "turn": None, "phase": None}
    mid = ((d0 + d1) / 2.0) % length
    hits = [t for t in turns if _in_span(mid, t["d0_m"], t["d1_m"], length)]
    if not hits:
        nearest = min(turns, key=lambda t: min((mid - t["apex_m"]) % length, (t["apex_m"] - mid) % length))
        hits = [nearest]
    t = hits[0]
    # Long gap → name the straight (T11–T12) if we're far from both apexes
    i = t["n"] - 1
    nxt = turns[(i + 1) % len(turns)]
    gap = (nxt["apex_m"] - t["apex_m"]) % length
    dist_apex = min((mid - t["apex_m"]) % length, (t["apex_m"] - mid) % length)
    dist_next = min((mid - nxt["apex_m"]) % length, (nxt["apex_m"] - mid) % length)
    if gap > 450 and dist_apex > 90 and dist_next > 90:
        a, b = (t["n"], nxt["n"]) if dist_apex <= dist_next else (t["n"], nxt["n"])
        # order along the lap from previous apex
        lo, hi = t["n"], nxt["n"]
        return {
            "label": f"T{lo}–T{hi} straight",
            "turn": None,
            "phase": "straight",
            "from_turn": lo,
            "to_turn": hi,
        }
    phase = _phase(mid, t["apex_m"], t["d0_m"], t["d1_m"], length)
    label = f"T{t['n']} {phase}"
    extra = t.get("name") or t.get("complex")
    if extra:
        label = f"{label} ({extra})"
    # window covering a named complex
    covered = sorted({h["n"] for h in hits})
    if len(covered) >= 2:
        cname = hits[0].get("complex")
        span = f"T{covered[0]}–T{covered[-1]}"
        label = f"{span} {phase}" + (f" ({cname})" if cname else "")
    return {"label": label, "turn": t["n"], "phase": phase, "name": t.get("name")}
