from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DATABASE_URL


class Base(DeclarativeBase):
    pass


_engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _connection_record) -> None:
    if engine.dialect.name != "sqlite":
        return
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def _add_column_if_missing(conn, table: str, column: str, sql_type: str) -> None:
    insp = inspect(conn)
    if table not in insp.get_table_names():
        return
    existing = {c["name"] for c in insp.get_columns(table)}
    if column in existing:
        return
    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def ensure_schema() -> None:
    """Add columns/tables create_all will not apply to existing DBs, plus backfills."""
    with engine.begin() as conn:
        dialect = conn.dialect.name
        json_sql = "JSONB" if dialect == "postgresql" else "JSON"
        _add_column_if_missing(conn, "sessions", "log_sheet", json_sql)
        _add_column_if_missing(conn, "sessions", "analysis_settings", json_sql)
        _add_column_if_missing(conn, "layouts", "turns", json_sql)

    from .models import Session, Vehicle

    db = SessionLocal()
    try:
        known = {v.name.lower() for v in db.query(Vehicle).all()}
        for (name,) in db.query(Session.vehicle).distinct():
            n = (name or "").strip()
            if n and n.lower() not in known:
                db.add(Vehicle(name=n[:120]))
                known.add(n.lower())
        db.commit()
    finally:
        db.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
