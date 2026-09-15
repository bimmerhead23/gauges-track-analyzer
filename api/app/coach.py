"""Build a compact driving briefing, then ask an LLM to coach from it."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np
import pandas as pd

from .config import (
    COACH_API_KEY,
    COACH_BASE_URL,
    COACH_MODEL,
    COACH_PROVIDER,
    GROQ_API_KEY,
    META_API_KEY,
    OPENAI_API_KEY,
    XAI_API_KEY,
)
from .models import Lap
from .traces import eclectic_best, mini_sectors, series_for, time_delta
from .turns import build_turns, locate_window

KEYS = ["gps_speed_mph", "tps", "brake", "gps_long_g", "gps_lat_g", "rpm"]


def _ms(v: int | float | None) -> float | None:
    if v is None:
        return None
    return round(float(v) / 1000.0, 3)


def _lap_card(lap: Lap) -> dict:
    sectors = sorted(lap.sectors or [], key=lambda s: s.index)
    s = lap.session
    lay = s.layout if s else None
    return {
        "lap_id": lap.id,
        "number": lap.number,
        "kind": lap.kind,
        "time_s": _ms(lap.time_ms),
        "distance_m": round(lap.distance_m, 1),
        "session_id": lap.session_id,
        "filename": s.filename if s else None,
        "started_at": s.started_at.isoformat() if s and s.started_at else None,
        "track": lay.track.name if lay and lay.track else None,
        "layout": lay.name if lay else None,
        "sectors": [{"index": sct.index, "time_s": _ms(sct.time_ms)} for sct in sectors],
    }


def track_key(lap: Lap) -> tuple:
    lay = lap.session.layout if lap.session else None
    if not lay:
        return (None, None)
    return (lay.track_id, lay.id)


def laps_on_same_track(laps: list[Lap], anchor: Lap) -> list[Lap]:
    """Keep only laps from the same track as the subject session (prefer same layout)."""
    at, al = track_key(anchor)
    if al is not None:
        same_layout = [l for l in laps if track_key(l)[1] == al]
        if same_layout:
            return same_layout
    if at is not None:
        same_track = [l for l in laps if track_key(l)[0] == at]
        if same_track:
            return same_track
    return laps


def _col_stats(sl: pd.DataFrame, key: str, math, d0: float | None = None, d1: float | None = None) -> dict | None:
    y = series_for(sl, key, math)
    if y is None or sl.empty:
        return None
    y = np.asarray(y, dtype=float)
    d = sl["lap_dist_m"].to_numpy(dtype=float) if "lap_dist_m" in sl.columns else None
    n = len(y)
    if d is not None:
        n = min(n, len(d))
        y, d = y[:n], d[:n]
        if d0 is not None and d1 is not None:
            mask = (d >= d0) & (d <= d1)
            y, d = y[mask], d[mask]
    ok = np.isfinite(y)
    y = y[ok]
    if d is not None:
        d = d[ok]
    if len(y) < 3:
        return None
    i_min = int(np.argmin(y))
    i_max = int(np.argmax(y))
    out = {
        "min": round(float(y[i_min]), 2),
        "max": round(float(y[i_max]), 2),
        "avg": round(float(np.mean(y)), 2),
    }
    if d is not None and len(d) == len(y):
        out["dist_at_min_m"] = round(float(d[i_min]), 1)
        out["dist_at_max_m"] = round(float(d[i_max]), 1)
    return out


def _usage(sl: pd.DataFrame) -> dict:
    out: dict[str, float] = {}
    if sl.empty or "t_ms" not in sl.columns:
        return out
    t = sl["t_ms"].to_numpy(dtype=float)
    if len(t) < 2:
        return out
    dt = np.diff(t, append=t[-1]) / 1000.0
    dt = np.clip(np.maximum(dt, 0), 0, 0.25)
    total = float(dt.sum()) or 1e-9
    if "tps" in sl.columns:
        y = sl["tps"].to_numpy(dtype=float)
        n = min(len(y), len(dt))
        out["wot_s"] = round(float(dt[:n][np.isfinite(y[:n]) & (y[:n] >= 90)].sum()), 2)
        out["wot_pct"] = round(100.0 * out["wot_s"] / total, 1)
    if "brake" in sl.columns:
        y = sl["brake"].to_numpy(dtype=float)
        n = min(len(y), len(dt))
        out["brake_s"] = round(float(dt[:n][np.isfinite(y[:n]) & (y[:n] >= 10)].sum()), 2)
        out["brake_pct"] = round(100.0 * out["brake_s"] / total, 1)
    out["total_s"] = round(total, 2)
    return out


def _loss_windows(x: list[float], y: list[float], width_m: float = 140.0, top_n: int = 6) -> list[dict]:
    if len(x) < 12:
        return []
    xa = np.asarray(x, dtype=float)
    ya = np.asarray(y, dtype=float)
    candidates: list[tuple[float, float, float]] = []
    i = 0
    n = len(xa)
    while i < n - 3:
        j = i + 1
        while j < n and xa[j] - xa[i] < width_m:
            j += 1
        if j - i < 4:
            i += 1
            continue
        loss = float(ya[j - 1] - ya[i])
        candidates.append((loss, float(xa[i]), float(xa[j - 1])))
        i += max(1, (j - i) // 4)
    candidates.sort(reverse=True)
    picked: list[tuple[float, float, float]] = []
    for loss, a, b in candidates:
        if loss < 0.025:
            break
        if any(not (b < pa or a > pb) for _, pa, pb in picked):
            continue
        picked.append((loss, a, b))
        if len(picked) >= top_n:
            break
    return [{"d0_m": round(a, 1), "d1_m": round(b, 1), "loss_s": round(loss, 3)} for loss, a, b in picked]


def _gain_windows(x: list[float], y: list[float], width_m: float = 140.0, top_n: int = 3) -> list[dict]:
    losses = _loss_windows(x, [-v for v in y], width_m, top_n)
    for w in losses:
        w["gain_s"] = w.pop("loss_s")
    return losses


def _view_from_sessions(laps: list[Lap]) -> dict[str, Any] | None:
    for l in laps:
        s = l.session
        saved = getattr(s, "analysis_settings", None) if s else None
        if not isinstance(saved, dict):
            continue
        plotted = saved.get("plotted") or []
        gates = saved.get("gates") or []
        preset = saved.get("gatePreset") or "off"
        color = saved.get("mapColor") or "lap"
        if plotted or gates or preset not in ("", "off") or color not in ("", "lap"):
            return {
                "map_color": color,
                "gate_preset": preset,
                "gates": gates,
                "plotted": plotted,
            }
    return None


def _layout_timing(layout) -> dict[str, Any]:
    secs = (layout.sectors if layout else None) or []
    src = None
    if secs and isinstance(secs[0], dict):
        src = secs[0].get("source")
    sf = layout.sf_gate if layout and isinstance(layout.sf_gate, dict) else {}
    n = len(secs) + 1 if secs else 3
    return {
        "official_sectors": n,
        "split_source": src or ("equal-thirds" if not secs else "layout"),
        "sf_source": sf.get("source") if sf else None,
    }


def build_briefing(
    laps: list[Lap],
    slices: dict[int, pd.DataFrame],
    math,
    mode: str,
    subject: Lap | None,
    ref: Lap | None,
    layout,
    view: dict | None = None,
) -> dict[str, Any]:
    flying = [l for l in laps if l.kind == "valid"]
    cards = [
        {"n": l.number, "kind": l.kind, "time_s": _ms(l.time_ms), "lap_id": l.id}
        for l in laps
        if l.kind == "valid"
    ][:12]
    length = 0.0
    if layout:
        length = float(layout.length_m or 0)
    for l in laps:
        length = max(length, l.distance_m)
    length = length or 5000.0

    minis_by = {}
    for l in laps:
        sl = slices.get(l.id)
        minis_by[l.id] = mini_sectors(sl, length) if sl is not None and not sl.empty else []

    purple = []
    if minis_by:
        n = min((len(m) for m in minis_by.values() if m), default=0)
        for i in range(n):
            best = min(m[i]["time_ms"] for m in minis_by.values() if len(m) > i)
            purple.append(best)
    virtual = eclectic_best([(l, slices.get(l.id)) for l in laps])
    virtual_ms = virtual["time_ms"] if virtual else None

    turn_src = None
    if ref is not None:
        turn_src = slices.get(ref.id)
    if (turn_src is None or getattr(turn_src, "empty", True)) and subject is not None:
        turn_src = slices.get(subject.id)
    turns = build_turns(turn_src, layout, length) if turn_src is not None else []

    track = {
        "name": layout.track.name if layout and layout.track else None,
        "layout": layout.name if layout else None,
        "direction": layout.direction if layout else None,
        "venue": layout.track.venue if layout and layout.track else None,
        "length_m": round(length, 1),
    }

    sessions_ctx = []
    seen_sid: set[int] = set()
    for l in laps:
        s = l.session
        if not s or s.id in seen_sid:
            continue
        seen_sid.add(s.id)
        sheet = s.log_sheet if isinstance(getattr(s, "log_sheet", None), dict) else {}
        filled = {k: v for k, v in (sheet or {}).items() if v not in (None, "")}
        sessions_ctx.append({
            "session_id": s.id,
            "filename": s.filename,
            "started_at": s.started_at.isoformat() if s.started_at else None,
            "vehicle": s.vehicle or "",
            "notes": (s.notes or "").strip()[:400],
            "log_sheet": filled,
        })

    live_view = view if isinstance(view, dict) and view else _view_from_sessions(laps)
    briefing: dict[str, Any] = {
        "mode": mode,
        "track": track,
        "timing": _layout_timing(layout),
        "logger": "Gauge.S ~14Hz GPS+ECU. +long G = brake, +lat G = left.",
        "laps": cards,
        "virtual_best_s": _ms(virtual_ms),
        "subject": _lap_card(subject) if subject else None,
        "reference": _lap_card(ref) if ref else None,
        "session_notes": sessions_ctx,
        "turns": [
            {k: t[k] for k in ("n", "apex_m", "name", "complex") if t.get(k) not in (None, "")}
            for t in turns
        ],
    }
    if live_view:
        briefing["view"] = {
            "map_color": live_view.get("map_color") or live_view.get("mapColor") or "lap",
            "gate_preset": live_view.get("gate_preset") or live_view.get("gatePreset") or "off",
            "gates": live_view.get("gates") or [],
            "plotted": live_view.get("plotted") or [],
        }

    if subject and subject.id in slices:
        briefing["subject_usage"] = _usage(slices[subject.id])
        briefing["subject_channel_stats"] = {
            k: _col_stats(slices[subject.id], k, math)
            for k in ("gps_speed_mph", "tps", "brake")
            if _col_stats(slices[subject.id], k, math)
        }

    if mode in {"vs_fastest", "vs_virtual"} and subject and ref and subject.id != ref.id:
        sub_sl = slices.get(subject.id)
        ref_sl = slices.get(ref.id)
        if sub_sl is not None and ref_sl is not None and not sub_sl.empty and not ref_sl.empty:
            td = time_delta(ref_sl, sub_sl)
            briefing["delta_vs_ref_end_s"] = round(float(td["y"][-1]), 3) if td.get("y") else None
            windows = _loss_windows(td.get("x") or [], td.get("y") or [], width_m=120.0, top_n=5)
            for w in windows:
                ch_keys = ("gps_speed_mph", "tps", "brake", "gps_lat_g", "gps_long_g")
                sub_ch = {k: _col_stats(sub_sl, k, math, w["d0_m"], w["d1_m"]) for k in ch_keys}
                ref_ch = {k: _col_stats(ref_sl, k, math, w["d0_m"], w["d1_m"]) for k in ch_keys}
                w["subject"] = {k: v for k, v in sub_ch.items() if v}
                w["reference"] = {k: v for k, v in ref_ch.items() if v}
                hints: dict[str, float] = {}
                ss, rr = w["subject"].get("gps_speed_mph"), w["reference"].get("gps_speed_mph")
                if ss and rr:
                    hints["min_speed_delta_mph"] = round(ss["min"] - rr["min"], 2)
                    if "dist_at_min_m" in ss and "dist_at_min_m" in rr:
                        hints["min_speed_point_delta_m"] = round(ss["dist_at_min_m"] - rr["dist_at_min_m"], 1)
                sb, rb = w["subject"].get("brake"), w["reference"].get("brake")
                if sb and rb:
                    hints["max_brake_delta"] = round(sb["max"] - rb["max"], 2)
                    if "dist_at_max_m" in sb and "dist_at_max_m" in rb:
                        hints["brake_point_delta_m"] = round(sb["dist_at_max_m"] - rb["dist_at_max_m"], 1)
                st, rt = w["subject"].get("tps"), w["reference"].get("tps")
                if st and rt:
                    hints["avg_tps_delta"] = round(st["avg"] - rt["avg"], 2)
                if hints:
                    w["vs_ref"] = hints
            for w in windows:
                loc = locate_window(turns, w["d0_m"], w["d1_m"], length)
                if loc.get("label"):
                    w["where"] = loc["label"]
                    w["turn"] = loc.get("turn")
                    w["phase"] = loc.get("phase")
            briefing["loss_windows"] = windows
            gains = _gain_windows(td.get("x") or [], td.get("y") or [], top_n=2)
            for w in gains:
                loc = locate_window(turns, w["d0_m"], w["d1_m"], length)
                if loc.get("label"):
                    w["where"] = loc["label"]
            briefing["gain_windows"] = gains
        if subject.sectors and ref.sectors:
            briefing["sector_table"] = []
            for s in sorted(subject.sectors, key=lambda x: x.index):
                r = next((x for x in ref.sectors if x.index == s.index), None)
                if r:
                    briefing["sector_table"].append(
                        {
                            "index": s.index,
                            "subject_s": _ms(s.time_ms),
                            "ref_s": _ms(r.time_ms),
                            "delta_s": round((s.time_ms - r.time_ms) / 1000.0, 3),
                        }
                    )

    if mode == "vs_virtual" and subject and purple:
        sm = minis_by.get(subject.id) or []
        mini_losses = []
        for i, m in enumerate(sm):
            if i >= len(purple):
                break
            loss = (m["time_ms"] - purple[i]) / 1000.0
            if loss >= 0.04:
                mini_losses.append(
                    {
                        "d0_m": round(m["d0"], 1),
                        "d1_m": round(m["d1"], 1),
                        "loss_s": round(loss, 3),
                    }
                )
        mini_losses.sort(key=lambda x: -x["loss_s"])
        for w in mini_losses[:5]:
            loc = locate_window(turns, w["d0_m"], w["d1_m"], length)
            if loc.get("label"):
                w["where"] = loc["label"]
        briefing["mini_losses_vs_purple"] = mini_losses[:5]
        briefing["reference_note"] = (
            "Virtual best is eclectic: fastest first and second half of each official "
            "sector across flying laps, then summed. Not a driven lap."
        )

    if mode == "all":
        fastest = min(flying, key=lambda l: l.time_ms) if flying else None
        per = []
        for l in flying[:8]:
            row: dict[str, Any] = {
                "n": l.number,
                "time_s": _ms(l.time_ms),
                "lap_id": l.id,
            }
            if fastest and l.id != fastest.id:
                sl = slices.get(l.id)
                rf = slices.get(fastest.id)
                if sl is not None and rf is not None and not sl.empty and not rf.empty:
                    td = time_delta(rf, sl)
                    row["delta_vs_fastest_s"] = round(float(td["y"][-1]), 3) if td.get("y") else None
                    losses = _loss_windows(td.get("x") or [], td.get("y") or [], top_n=2)
                    for w in losses:
                        loc = locate_window(turns, w["d0_m"], w["d1_m"], length)
                        if loc.get("label"):
                            w["where"] = loc["label"]
                    row["top_losses"] = losses
            per.append(row)
        briefing["per_lap"] = per
        briefing["fastest_selected"] = _lap_card(fastest) if fastest else None

    return briefing


PROMPT_VERSION = "7"

SYSTEM = """Expert driving coach. Gauge.S ~14Hz GPS+ECU. Use ONLY briefing numbers.

Locate by TURN NUMBER from briefing.turns and loss_windows[].where (T12 entry, T1 apex, T11–T12 straight). Nicknames only if listed in briefing.turns (Big Red, Esses, Bobby Pin, Andretti, Carousel). NEVER invent names. NEVER use "sector 3 exit" as the primary location; S1/S2/S3 may follow in parentheses if useful.

vs_ref: brake_point_delta_m<0 = braked earlier; >0 = later. min_speed_delta_mph<0 = slower at slowest point. avg_tps_delta<0 = less throttle. +gps_long_g = brake; +gps_lat_g = left.

Write a real debrief, not slogans:
- headline + summary (3–5 sentences: gap, theme, named turns, AND any filled log_sheet: weather, ambient_f, track_temp_f, tyres, pressures, fuel, wing, setup, notes). If log_sheet is empty, do not invent conditions.
- Mention every sector_table row, but locate the story on turns.
- 4 priorities by loss_s. where MUST be a turn label like "T12 entry". diagnosis: 2–3 sentences with numbers. do: 2–3 sentences, a next-session drill. why: 1 sentence.
- session_plan: 3 ordered drills, each naming a turn.
- leave_alone: 2 items {where, why} with turn labels.
- view.map_color: if not "lap", they are looking at a rainbow map of that channel (red=high). Refer to it when it helps ("speed rainbow is already green through T7").
- view.gates / gate_preset: Overlay gating is on for their eyes only; loss_windows are still full-lap. If a priority matches the gate (e.g. Braking), say they can isolate it with the gate.
- view.plotted: channels on the overlay. Don't ask them to plot something already there.
- Honor session_notes and log_sheet. GPS G is approximate. Virtual best is eclectic half-sectors. This track only.

JSON only:
{"headline":"...","summary":"...","priorities":[{"where":"T12 entry","loss_s":0.18,"diagnosis":"...","do":"...","why":"..."}],"session_plan":["...","...","..."],"leave_alone":[{"where":"T3–T6 Esses","why":"..."}],"caveats":["..."]}
"""


def briefing_hash(briefing: dict, model: str) -> str:
    raw = json.dumps({"b": briefing, "m": model, "p": PROMPT_VERSION}, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _coach_client():
    """OpenAI-compatible chat client for the configured provider."""
    from openai import OpenAI

    extra: dict[str, Any] = {}
    timeout = 120.0
    if COACH_PROVIDER == "xai":
        if not XAI_API_KEY:
            raise ValueError("XAI_API_KEY is not set. https://console.x.ai")
        client = OpenAI(api_key=XAI_API_KEY, base_url="https://api.x.ai/v1", timeout=180.0)
        extra["extra_body"] = {"reasoning_effort": "low"}
        timeout = 180.0
    elif COACH_PROVIDER == "groq":
        if not GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY is not set. https://console.groq.com")
        client = OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1", timeout=90.0)
        timeout = 90.0
    elif COACH_PROVIDER == "meta":
        if not META_API_KEY:
            raise ValueError("META_API_KEY is not set. https://ai.developer.meta.com (Model API key)")
        client = OpenAI(api_key=META_API_KEY, base_url="https://api.meta.ai/v1", timeout=180.0)
        timeout = 180.0
    elif COACH_PROVIDER == "openai":
        if not OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY is not set. https://platform.openai.com")
        client = OpenAI(api_key=OPENAI_API_KEY, timeout=120.0)
    elif COACH_PROVIDER in {"openai-compatible", "compatible", "custom"}:
        if not COACH_API_KEY or not COACH_BASE_URL:
            raise ValueError("Set COACH_BASE_URL and COACH_API_KEY for an OpenAI-compatible endpoint.")
        client = OpenAI(api_key=COACH_API_KEY, base_url=COACH_BASE_URL, timeout=120.0)
    else:
        raise ValueError(f"Unknown COACH_PROVIDER={COACH_PROVIDER!r}")
    return client, extra, timeout


def coach_available() -> tuple[bool, str]:
    try:
        _coach_client()
    except ValueError as exc:
        return False, str(exc)
    return True, ""


def run_coach(briefing: dict) -> dict:
    client, kwargs, _timeout = _coach_client()
    payload = "Debrief this briefing. JSON only.\n" + json.dumps(briefing, default=str, separators=(",", ":"))
    print(f"coach: {COACH_PROVIDER}/{COACH_MODEL} bytes={len(payload)}", flush=True)
    max_out = 2200 if COACH_PROVIDER == "groq" else 3500
    resp = client.chat.completions.create(
        model=COACH_MODEL,
        temperature=0.5,
        max_tokens=max_out,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": payload},
        ],
        **kwargs,
    )
    text = resp.choices[0].message.content or "{}"
    try:
        report = json.loads(text)
    except json.JSONDecodeError:
        report = {"headline": text[:400], "priorities": [], "leave_alone": [], "caveats": ["Model did not return JSON."]}
    if not isinstance(report, dict):
        report = {"headline": str(report), "priorities": [], "leave_alone": [], "caveats": []}
    report.setdefault("headline", "")
    report.setdefault("summary", "")
    report.setdefault("priorities", [])
    report.setdefault("session_plan", [])
    report.setdefault("leave_alone", [])
    report.setdefault("caveats", [])
    return report
