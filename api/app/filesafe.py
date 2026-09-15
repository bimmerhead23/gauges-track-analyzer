"""Limits for CSV uploads and .gsbak restore archives."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

from fastapi import HTTPException, UploadFile

MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_CSV_ROWS = 1_500_000
MAX_CSV_COLS = 96
MAX_HEADER_BYTES = 32_768
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED = 400 * 1024 * 1024
MAX_ARCHIVE_FILES = 400
MAX_ARCHIVE_RATIO = 200
MAX_DEMO_SESSIONS = 80
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
BIN_MAGIC = (
    b"PK",
    b"\x1f\x8b",
    b"%PDF",
    b"\x7fELF",
    b"\x89PNG",
    b"\xff\xd8\xff",
    b"MZ",
)


def safe_filename(name: str, suffix: str = ".csv") -> str:
    base = Path(str(name).replace("\\", "/")).name
    base = SAFE_NAME.sub("_", base).strip("._") or "upload"
    if suffix and not base.lower().endswith(suffix):
        base = f"{base}{suffix}"
    return base[:180]


def sniff_csv(data: bytes) -> None:
    if len(data) < 24:
        raise ValueError("File is too small to be a Gauge.S log")
    head = data[:8]
    for mag in BIN_MAGIC:
        if head.startswith(mag):
            raise ValueError("Not a CSV file")
    sample = data[:4096]
    if sample.startswith(b"\xff\xfe") or sample.startswith(b"\xfe\xff"):
        raise ValueError("UTF-16 is not supported")
    if b"\x00" in sample:
        raise ValueError("Binary file, not CSV")
    if sample.startswith(b"\xef\xbb\xbf"):
        sample = sample[3:]
    try:
        text = sample.decode("utf-8")
    except UnicodeDecodeError:
        text = sample.decode("latin-1", errors="strict")
    if not any(ch in text for ch in ",;\t"):
        raise ValueError("No CSV delimiter in the header")


async def save_upload(file: UploadFile, dest: Path, max_bytes: int = MAX_UPLOAD_BYTES) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    first = b""
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File is larger than {max_bytes // (1024 * 1024)} MB")
            if len(first) < 4096:
                first += chunk[: 4096 - len(first)]
            out.write(chunk)
    if written == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "Empty file")
    try:
        sniff_csv(first)
    except ValueError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from exc
    return written


def check_csv_shape(df, *, max_rows: int = MAX_CSV_ROWS, max_cols: int = MAX_CSV_COLS) -> None:
    if df.shape[1] > max_cols:
        raise ValueError(f"CSV has too many columns ({df.shape[1]} > {max_cols})")
    if df.shape[0] > max_rows:
        raise ValueError(f"CSV has too many rows ({df.shape[0]} > {max_rows})")
    if df.shape[0] < 50:
        raise ValueError("CSV does not have enough samples")


def check_zip(zf: zipfile.ZipFile) -> None:
    total = 0
    files = 0
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if name.endswith("/"):
            continue
        p = Path(name)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(f"unsafe path in archive: {name}")
        files += 1
        if files > MAX_ARCHIVE_FILES:
            raise ValueError("Archive has too many files")
        size = int(info.file_size or 0)
        if size > MAX_UPLOAD_BYTES:
            raise ValueError("Archive contains a file that is too large")
        total += size
        if total > MAX_ARCHIVE_UNCOMPRESSED:
            raise ValueError("Archive is too large uncompressed")
        compressed = int(info.compress_size or 1)
        if compressed > 0 and size / compressed > MAX_ARCHIVE_RATIO:
            raise ValueError("Archive compression ratio looks like a zip bomb")
