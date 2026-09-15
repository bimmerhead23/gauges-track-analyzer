import os
import sys
from pathlib import Path


def is_desktop() -> bool:
    return os.environ.get("GAUGES_DESKTOP", "").strip().lower() in {"1", "true", "yes"}


def is_demo() -> bool:
    return os.environ.get("GAUGES_DEMO", "").strip().lower() in {"1", "true", "yes"}


def desktop_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Gauge.S Track Analyzer"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home())
        return Path(base) / "Gauge.S Track Analyzer"
    return Path.home() / ".local/share/gauge-s-track-analyzer"


def sqlalchemy_url(raw: str) -> str:
    """Some hosts hand out postgres://; SQLAlchemy wants postgresql+psycopg://."""
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://") :]
    if raw.startswith("postgresql://") and "+psycopg" not in raw.split("://", 1)[0]:
        raw = "postgresql+psycopg://" + raw[len("postgresql://") :]
    return raw


if is_desktop():
    DATA_DIR = Path(os.environ["DATA_DIR"]) if os.environ.get("DATA_DIR") else desktop_data_dir()
else:
    DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

_raw_db = os.environ.get("DATABASE_URL", "").strip()
DATABASE_URL = (
    sqlalchemy_url(_raw_db) if _raw_db else f"sqlite:///{(DATA_DIR / 'track.db').as_posix()}"
)

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
XAI_API_KEY = os.environ.get("XAI_API_KEY", "")
META_API_KEY = os.environ.get("META_API_KEY") or os.environ.get("MODEL_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
COACH_API_KEY = os.environ.get("COACH_API_KEY", "")
COACH_BASE_URL = os.environ.get("COACH_BASE_URL", "").strip().rstrip("/")
COACH_PROVIDER = os.environ.get("COACH_PROVIDER", "xai").strip().lower()
_DEFAULT_MODEL = {
    "xai": "grok-4.6",
    "groq": "llama-3.3-70b-versatile",
    "meta": "muse-spark-1.3",
    "openai": "gpt-4.1",
    "openai-compatible": "gpt-4o",
}
COACH_MODEL = os.environ.get("COACH_MODEL", _DEFAULT_MODEL.get(COACH_PROVIDER, "grok-4.6"))
UI_DIR = os.environ.get("GAUGES_UI_DIR", "").strip()
