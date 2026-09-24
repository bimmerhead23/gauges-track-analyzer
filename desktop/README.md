# Gauge.S Track Analyzer — Mac app

Same analyzer in a native window, beside the Docker site. The library is a SQLite file at `~/Library/Application Support/Gauge.S Track Analyzer/`. That file is separate from the Docker volume.

Needs Python 3.12 (or an existing `api/.venv`), Node, and the Rust toolchain.

## Live window

```bash
./desktop/setup.sh          # once: venv if missing, then pip + npm
cd desktop && npm run dev
```

The API listens on `127.0.0.1:8000`. The window loads the Vite UI at `http://localhost:5173`. The first Rust compile takes a minute.

## Double-click app

```bash
source "$HOME/.cargo/env"
cd desktop && npm run build
open "src-tauri/target/release/bundle/macos/Gauge.S Track Analyzer.app"
```

Also writes a `.dmg` next to the `.app`. The app starts `api/.venv` from this checkout and serves the UI that the build just copied in, so leave the repo at the path it had when you built (build again after a move). The window stays hidden until the API is accepting connections.
