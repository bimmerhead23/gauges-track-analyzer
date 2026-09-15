"""Wipe sessions, layouts, and files, then re-seed the track catalog.

    python -m app.reset
"""

from __future__ import annotations

import shutil

from sqlalchemy import delete
from sqlalchemy.orm import Session as DB

from .config import DATA_DIR
from .db import SessionLocal
from .models import CoachReport, Lap, Layout, MathChannel, Sector, Session, Track, Vehicle
from .seed import seed_if_empty


def reset_database(db: DB) -> dict:
    for model in (Sector, Lap, CoachReport, Session, Layout, Track, MathChannel, Vehicle):
        db.execute(delete(model))
    db.commit()
    for folder in (DATA_DIR / "sessions", DATA_DIR / "incoming"):
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True, exist_ok=True)
    seed_if_empty(db)
    return {
        "ok": True,
        "sessions": db.query(Session).count(),
        "tracks": db.query(Track).count(),
        "layouts": db.query(Layout).count(),
        "math_channels": db.query(MathChannel).count(),
    }


def main() -> None:
    db = SessionLocal()
    try:
        result = reset_database(db)
        print(
            "Database reset:",
            f"{result['tracks']} tracks,",
            f"{result['layouts']} layouts,",
            f"{result['math_channels']} math channels,",
            f"{result['sessions']} sessions.",
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
