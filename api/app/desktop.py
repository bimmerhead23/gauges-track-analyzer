"""Desktop entry: SQLite library, API + UI on 127.0.0.1.

    GAUGES_DESKTOP=1 python -m app.desktop
"""

from __future__ import annotations

import os
import socket
import sys
from pathlib import Path


def _desktop_home() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Gauge.S Track Analyzer"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home())
        return Path(base) / "Gauge.S Track Analyzer"
    return Path.home() / ".local/share/gauge-s-track-analyzer"


def main() -> None:
    os.environ["GAUGES_DESKTOP"] = "1"
    home = Path(os.environ.get("DATA_DIR") or _desktop_home())
    home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("DATA_DIR", str(home))
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{(home / 'track.db').as_posix()}")

    api_root = Path(__file__).resolve().parents[1]
    if str(api_root) not in sys.path:
        sys.path.insert(0, str(api_root))

    host = os.environ.get("GAUGES_HOST", "127.0.0.1")
    port = int(os.environ.get("GAUGES_PORT", "0") or "0")
    if port <= 0:
        sock = socket.socket()
        sock.bind((host, 0))
        port = int(sock.getsockname()[1])
        sock.close()
    os.environ["GAUGES_PORT"] = str(port)

    import uvicorn

    uvicorn.run("app.main:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
