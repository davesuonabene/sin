"""Import read-only folder and ZIP snapshots into GAIA's managed asset store."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import uuid
import zipfile
from typing import Any

import soundfile as sf

from . import midi_parser, multitrack_analyzer, text_analyzer


AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}
MIDI_EXTENSIONS = {".mid", ".midi"}
ASSET_STORE = Path(__file__).resolve().parents[1] / "assets"


def canonical_source_path(source_path: str) -> str:
    return os.path.abspath(source_path.strip().strip("\"'"))


def _ensure_within(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if os.path.commonpath([str(root_resolved), str(candidate_resolved)]) != str(root_resolved):
        raise ValueError("Archive contains an unsafe path")
    return candidate_resolved


def _copy_directory(source: Path, destination: Path) -> None:
    for root, dirs, files in os.walk(source, topdown=True, followlinks=False):
        dirs[:] = sorted(directory for directory in dirs if not os.path.islink(Path(root) / directory))
        relative_root = Path(root).relative_to(source)
        target_root = destination / relative_root
        target_root.mkdir(parents=True, exist_ok=True)
        for filename in sorted(files):
            source_file = Path(root) / filename
            if source_file.is_symlink():
                continue
            shutil.copy2(source_file, target_root / filename)


def _extract_zip(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(source) as archive:
        for info in archive.infolist():
            member = PurePosixPath(info.filename)
            if member.is_absolute() or ".." in member.parts:
                raise ValueError("Archive contains an unsafe path")
            # Unix symlinks can be embedded in ZIP metadata; never materialize them.
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
    """Return a manifest entry with freshly inferred, non-destructive metadata."""
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
        key = midi_values.get("key") or key

    return {
        **entry,
        "title": analysis["title"],
        "type": item_type,
        "duration_seconds": duration,
        "bpm": round(float(bpm)) if bpm is not None else None,
        "key": key,
        "tags": analysis.get("tags", []),
        "streamable": item_type in {"sample", "loop", "one_shot"},
    }


def build_manifest(root: Path) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for current_root, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs.sort()
        for filename in sorted(files):
            file_path = Path(current_root) / filename
            if file_path.is_symlink():
                continue
            relative_path = file_path.relative_to(root).as_posix()
            extension = file_path.suffix.lower()
            item_type = "midi" if extension in MIDI_EXTENSIONS else "sample" if extension in AUDIO_EXTENSIONS else "file"
            entry = {
                "index": len(contents),
                "filename": filename,
                "relative_path": relative_path,
                "type": item_type,
                "mime_type": mimetypes.guess_type(str(file_path))[0],
                "size_bytes": file_path.stat().st_size,
                "duration_seconds": None,
                "bpm": None,
                "key": None,
                "tags": [],
                "streamable": False,
            }
            contents.append(analyze_manifest_entry(root, entry))
    return contents


def inferred_collection_type(contents: list[dict[str, Any]], is_multitrack: bool = False) -> str:
    if is_multitrack:
        return "multitrack"
    media_count = sum(entry.get("type") in {"sample", "loop", "one_shot", "midi"} for entry in contents)
    return "sample_pack" if media_count >= 3 and media_count >= len(contents) * 0.5 else "collection"


import re

def snapshot_collection_source(source_path: str, asset_store: Path | None = None, allow_multitracks: bool = True) -> dict[str, Any]:
    """Copy or extract a source, then return its collection metadata and manifest."""
    source = Path(canonical_source_path(source_path))
    if not source.exists():
        raise ValueError("Source path does not exist")

    if source.is_dir():
        source_kind = "folder"
        title = source.name
    elif source.is_file() and zipfile.is_zipfile(source):
        source_kind = "zip"
        title = source.stem
    else:
        raise ValueError("Select a folder or a .zip archive")

    store = (asset_store or ASSET_STORE).resolve()
    store.mkdir(parents=True, exist_ok=True)

    safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip('. ') or "Imported_Collection"
    source_resolved = source.resolve()

    if source_kind == "folder" and (store in source_resolved.parents or source_resolved == store):
        destination = source_resolved
    else:
        destination = store / safe_title
        if destination.exists() and destination != source_resolved:
            destination = store / f"{safe_title}_{uuid.uuid4().hex[:6]}"

        staging = store / f".{uuid.uuid4().hex}.staging"
        staging.mkdir(parents=True, exist_ok=False)

        try:
            if source_kind == "folder":
                _copy_directory(source, staging)
            else:
                _extract_zip(source, staging)
            manifest = build_manifest(staging)
            analysis = multitrack_analyzer.analyze_multitrack_folder(str(staging), recursive=False)
            is_multitrack = allow_multitracks and multitrack_analyzer.is_multitrack_folder(str(staging))
            os.replace(staging, destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    manifest = build_manifest(destination)
    analysis = multitrack_analyzer.analyze_multitrack_folder(str(destination), recursive=False)
    is_multitrack = allow_multitracks and multitrack_analyzer.is_multitrack_folder(str(destination))

    # Stem paths must point at the finalized managed copy, not the source snapshot.
    stems = analysis.get("stems", []) if is_multitrack else []
    for stem in stems:
        relative = stem.get("relative_path", "")
        stem["absolute_path"] = str(destination / Path(relative))

    return {
        "absolute_path": str(destination),
        "source_path": str(source),
        "source_kind": source_kind,
        "title": title,
        "contents": manifest,
        "type": inferred_collection_type(manifest, is_multitrack),
        "mime_type": "application/zip" if source_kind == "zip" else "inode/directory",
        "size_bytes": sum(item.get("size_bytes") or 0 for item in manifest),
        "stems": stems,
        "key": analysis.get("key") if is_multitrack else None,
        "bpm": analysis.get("bpm") if is_multitrack else None,
        "is_valid_length": analysis.get("is_valid_length", False) if is_multitrack else None,
        "length_variance": analysis.get("length_variance", 0.0) if is_multitrack else None,
    }
