import os
import time
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import OperationalError

from .config import UI_DIR, is_demo, is_desktop
from .db import Base, SessionLocal, engine, ensure_schema
from .routers import analysis, backup, sessions, tracks
from .seed import seed_if_empty


@asynccontextmanager
async def lifespan(_: FastAPI):
    for attempt in range(60):
        try:
            Base.metadata.create_all(bind=engine)
            ensure_schema()
            db = SessionLocal()
            try:
                seed_if_empty(db)
            finally:
                db.close()
            if is_desktop():
                print(f"GAUGES_READY port={os.environ.get('GAUGES_PORT', '8000')}", flush=True)
            break
        except OperationalError:
            time.sleep(1)
    else:
        raise RuntimeError("Database never became ready")
    yield


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "")
    if raw.strip():
        return [o.strip() for o in raw.split(",") if o.strip()]
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8090",
        "http://127.0.0.1:8090",
    ]


app = FastAPI(title="Gauge.S Track Analyzer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
def _client_ip(request: Request) -> str:
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else ""


@app.middleware("http")
async def track_visitors(request: Request, call_next):
    path = request.url.path
    if path not in {"/api/health", "/api/metrics"}:
        from .metrics import note_visitor

        note_visitor(_client_ip(request))
    return await call_next(request)


app.include_router(sessions.router, prefix="/api")
app.include_router(tracks.router, prefix="/api")
app.include_router(analysis.router, prefix="/api")
app.include_router(backup.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"ok": True, "demo": is_demo()}


@app.get("/api/metrics")
def metrics():
    from .metrics import snapshot

    return snapshot()


def _ui_path() -> Path | None:
    if UI_DIR:
        p = Path(UI_DIR)
        if p.is_dir():
            return p
    if is_desktop():
        bundled = Path(__file__).resolve().parents[2] / "web" / "dist"
        if bundled.is_dir():
            return bundled
    return None


def _mount_ui() -> None:
    ui = _ui_path()
    if not ui:
        return
    assets = ui / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")
    index = ui / "index.html"

    root = ui.resolve()

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = (ui / full_path).resolve()
        if full_path and candidate.is_file() and (candidate == root or root in candidate.parents):
            return FileResponse(candidate)
        return FileResponse(index)


_mount_ui()
