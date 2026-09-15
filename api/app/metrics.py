"""Lightweight snapshot for the ops dashboard."""

from __future__ import annotations

import time
from pathlib import Path

from .config import DATA_DIR, is_demo
from .db import SessionLocal
from .filesafe import MAX_DEMO_SESSIONS
from .models import Session

_STARTED = time.time()
# ip -> last seen unix time (unique visitors; not Gauge.S log sessions)
_seen: dict[str, float] = {}


def _dir_bytes(root: Path) -> int:
    total = 0
    try:
        for p in root.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _net_bytes() -> tuple[int, int]:
    rx = tx = 0
    try:
        lines = Path("/proc/net/dev").read_text().splitlines()[2:]
    except OSError:
        return 0, 0
    for line in lines:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        if name.strip() in {"lo"}:
            continue
        parts = rest.split()
        if len(parts) >= 9:
            rx += int(parts[0] or 0)
            tx += int(parts[8] or 0)
    return rx, tx


def _rss_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    return 0


def note_visitor(ip: str) -> None:
    ip = (ip or "").strip()
    if not ip or ip in {"127.0.0.1", "::1"}:
        return
    now = time.time()
    _seen[ip] = now
    cutoff = now - 86400
    stale = [k for k, t in _seen.items() if t < cutoff]
    for k in stale:
        del _seen[k]


def _visitors(window_s: float) -> int:
    now = time.time()
    return sum(1 for t in _seen.values() if now - t <= window_s)


def snapshot() -> dict:
    db = SessionLocal()
    try:
        sessions = int(db.query(Session).count())
    finally:
        db.close()
    rx, tx = _net_bytes()
    return {
        "ok": True,
        "demo": is_demo(),
        "sessions": sessions,
        "max_sessions": MAX_DEMO_SESSIONS if is_demo() else None,
        "data_bytes": _dir_bytes(DATA_DIR),
        "rss_bytes": _rss_bytes(),
        "net_rx_bytes": rx,
        "net_tx_bytes": tx,
        "uptime_s": int(time.time() - _STARTED),
        "visitors_1h": _visitors(3600),
        "visitors_24h": _visitors(86400),
    }
