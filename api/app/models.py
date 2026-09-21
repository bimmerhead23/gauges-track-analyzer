from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

# JSON on SQLite, JSONB on Postgres.
JSONType = JSON().with_variant(JSONB(), "postgresql")


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    venue: Mapped[str] = mapped_column(String(120), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    layouts: Mapped[list["Layout"]] = relationship(back_populates="track", cascade="all, delete-orphan")


class Layout(Base):
    __tablename__ = "layouts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    name: Mapped[str] = mapped_column(String(120))
    direction: Mapped[str] = mapped_column(String(8), default="CW")
    length_m: Mapped[float] = mapped_column(Float)
    centroid_lat: Mapped[float] = mapped_column(Float)
    centroid_lon: Mapped[float] = mapped_column(Float)
    match_radius_m: Mapped[float] = mapped_column(Float, default=3000)
    sf_gate: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    finish_gate: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    timing_mode: Mapped[str] = mapped_column(String(16), default="loop")
    sectors: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    pit_polygon: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    turns: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    track: Mapped[Track] = relationship(back_populates="layouts")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    vehicle: Mapped[str] = mapped_column(String(120), default="")
    layout_id: Mapped[int | None] = mapped_column(ForeignKey("layouts.id"), nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="processing")
    error: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    log_sheet: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    analysis_settings: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    parquet_path: Mapped[str] = mapped_column(String(500), default="")
    raw_csv_path: Mapped[str] = mapped_column(String(500), default="")
    channels: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    bbox: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    video_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    layout: Mapped[Layout | None] = relationship()
    laps: Mapped[list["Lap"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class Lap(Base):
    __tablename__ = "laps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    number: Mapped[int] = mapped_column(Integer)
    t_start_ms: Mapped[int] = mapped_column(Integer)
    t_end_ms: Mapped[int] = mapped_column(Integer)
    time_ms: Mapped[int] = mapped_column(Integer)
    distance_m: Mapped[float] = mapped_column(Float)
    kind: Mapped[str] = mapped_column(String(16), default="valid")
    sectors_source: Mapped[str] = mapped_column(String(16), default="gates")
    is_best: Mapped[bool] = mapped_column(Boolean, default=False)
    session: Mapped[Session] = relationship(back_populates="laps")
    sectors: Mapped[list["Sector"]] = relationship(back_populates="lap", cascade="all, delete-orphan")


class Sector(Base):
    __tablename__ = "sectors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lap_id: Mapped[int] = mapped_column(ForeignKey("laps.id"))
    index: Mapped[int] = mapped_column(Integer)
    time_ms: Mapped[int] = mapped_column(Integer)
    distance_m: Mapped[float] = mapped_column(Float)
    lap: Mapped[Lap] = relationship(back_populates="sectors")


class Vehicle(Base):
    """Saved car names, reusable across sessions and tracks."""

    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)


class MathChannel(Base):
    __tablename__ = "math_channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    expression: Mapped[str] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(String(24), default="")
    color: Mapped[str] = mapped_column(String(16), default="#d29922")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class CoachReport(Base):
    __tablename__ = "coach_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    briefing_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    mode: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(80), default="")
    briefing: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    report: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
