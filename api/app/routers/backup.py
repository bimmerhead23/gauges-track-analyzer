import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session as DB
from starlette.background import BackgroundTask

from ..backup import export_to_temp, restore_backup
from ..config import is_demo
from ..db import get_db

router = APIRouter(prefix="/backup", tags=["backup"])


@router.get("")
def download_backup(db: DB = Depends(get_db)):
    try:
        path = export_to_temp(db)
    except Exception as exc:
        raise HTTPException(500, f"Backup failed: {exc}") from exc
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"gauges-library-{stamp}.gsbak",
        background=BackgroundTask(lambda p=str(path): Path(p).unlink(missing_ok=True)),
    )


@router.post("/restore")
async def restore(file: UploadFile = File(...), db: DB = Depends(get_db)):
    if is_demo():
        raise HTTPException(403, "Public demo — the library resets nightly.")
    name = (file.filename or "").lower()
    if not name.endswith(".gsbak") and not name.endswith(".zip"):
        raise HTTPException(400, "Upload a .gsbak library backup")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".gsbak") as handle:
        handle.write(await file.read())
        tmp_path = Path(handle.name)
    try:
        try:
            return restore_backup(db, tmp_path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(400, str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)
