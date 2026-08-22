"""Read-only source inspection helpers used by GAIA import previews and jobs."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import zipfile
from typing import Any

import soundfile as sf

from . import midi_parser, text_analyzer


AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}
MIDI_EXTENSIONS = {".mid", ".midi"}
ASSET_STORE = Path(
    os.environ.get("GAIA_ASSET_STORE", str(Path(__file__).resolve().parents[1] / "assets"))
)
MAX_ARCHIVE_FILES = int(os.environ.get("GAIA_MAX_ARCHIVE_FILES", "100000"))
MAX_ARCHIVE_UNCOMPRESSED_BYTES = int(
    os.environ.get("GAIA_MAX_ARCHIVE_UNCOMPRESSED_BYTES", str(500 * 1024**3))
)


def canonical_source_path(source_path: str) -> str:
    cleaned = (source_path or "").strip().strip("\"'").strip()
    if not cleaned:
        raise ValueError("Source path cannot be empty")
    return os.path.abspath(cleaned)


def _ensure_within(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if os.path.commonpath([str(root_resolved), str(candidate_resolved)]) != str(root_resolved):
        raise ValueError("Archive contains an unsafe path")
    return candidate_resolved


def _extract_zip(source: Path, destination: Path) -> None:
    """Extract a bounded archive while rejecting traversal and symlink entries."""
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        file_members = [info for info in members if not info.is_dir()]
        if len(file_members) > MAX_ARCHIVE_FILES:
            raise ValueError(f"Archive contains more than {MAX_ARCHIVE_FILES} files")
        total_size = sum(max(0, info.file_size) for info in file_members)
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError("Archive is larger than GAIA's configured extraction limit")
        for info in members:
            member = PurePosixPath(info.filename)
            if member.is_absolute() or ".." in member.parts:
                raise ValueError("Archive contains an unsafe path")
            if stat.S_ISLNK(info.external_attr >> 16):
                continue
            target = _ensure_within(destination, destination.joinpath(*member.parts))
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info, "r") as source_file, open(target, "wb") as target_file:
                shutil.copyfileobj(source_file, target_file)


def _audio_metadata(file_path: Path) -> dict[str, Any]:
    try:
        info = sf.info(str(file_path))
        return {"duration_seconds": round(float(info.duration), 4)}
    except Exception:
        return {"duration_seconds": None}


def analyze_manifest_entry(root: Path, entry: dict[str, Any]) -> dict[str, Any]:
    """Infer metadata without changing the source or managed asset store."""
    file_path = root / Path(entry["relative_path"])
    extension = file_path.suffix.lower()
    duration = entry.get("duration_seconds")
    if extension in AUDIO_EXTENSIONS and duration is None:
        duration = _audio_metadata(file_path).get("duration_seconds")

    analysis = text_analyzer.analyze_path(str(file_path), duration_seconds=duration)
    item_type = analysis["type"] if extension in AUDIO_EXTENSIONS else "midi" if extension in MIDI_EXTENSIONS else "file"
    bpm = analysis.get("bpm")
    key = analysis.get("key")
    if extension in MIDI_EXTENSIONS:
        try:
            midi_values = midi_parser.parse_midi_file(str(file_path))
        except Exception:
            midi_values = {}
        bpm = midi_values.get("bpm") or bpm
        role = text_analyzer.key_role(str(file_path), False, analysis.get("tags", []))
        key = text_analyzer.normalize_key_for_role(midi_values.get("key") or key, role)
    return {
        **entry,
        "title": analysis["title"],
        "type": item_type,
        "duration_seconds": duration,
        "bpm": round(float(bpm)) if bpm is not None else None,
        "key": key,
        "is_loop": bool(analysis.get("is_loop")),
        "tags": analysis.get("tags", []),
        "streamable": item_type == "audio",
    }


def build_manifest(root: Path) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for current_root, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs[:] = sorted(directory for directory in dirs if not (Path(current_root) / directory).is_symlink())
        for filename in sorted(files):
            file_path = Path(current_root) / filename
            if file_path.is_symlink():
                continue
            relative_path = file_path.relative_to(root).as_posix()
            extension = file_path.suffix.lower()
            entry = {
                "index": len(contents),
                "filename": filename,
                "relative_path": relative_path,
                "type": "midi" if extension in MIDI_EXTENSIONS else "audio" if extension in AUDIO_EXTENSIONS else "file",
                "mime_type": mimetypes.guess_type(str(file_path))[0],
                "size_bytes": file_path.stat().st_size,
                "duration_seconds": None,
                "bpm": None,
                "key": None,
                "is_loop": False,
                "tags": [],
                "streamable": False,
            }
            contents.append(analyze_manifest_entry(root, entry))
    return contents
