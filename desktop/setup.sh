#!/bin/sh
# One-time (or after requirements.txt changes) setup for the Mac desktop app.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$ROOT/api/.venv/bin/python" ]; then
  PY="${GAUGES_PYTHON:-python3.12}"
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo "Need Python 3.12. Try: brew install python@3.12" >&2
    exit 1
  fi
  "$PY" -m venv "$ROOT/api/.venv"
fi
"$ROOT/api/.venv/bin/pip" install -U pip
"$ROOT/api/.venv/bin/pip" install -r "$ROOT/api/requirements.txt"
cd "$ROOT/web" && npm install
cd "$ROOT/desktop" && npm install
echo "Ready. From desktop/: npm run dev"
