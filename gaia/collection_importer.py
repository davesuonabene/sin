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

from . import multitrack_analyzer, text_analyzer


AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}
MIDI_EXTENSIONS = {".mid", ".midi"}
ASSET_STORE = Path(__file__).resolve().parents[1] / "assets" / "gaia-library" / "collections"


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


def _content_type(file_path: Path) -> str:
    extension = file_path.suffix.lower()
    if extension in MIDI_EXTENSIONS:
        return "midi"
    if extension in AUDIO_EXTENSIONS:
        analysis = text_analyzer.analyze_path(str(file_path))
        return analysis.get("type", "sample")
    return "file"


def _audio_metadata(file_path: Path) -> dict[str, Any]:
    try:
        info = sf.info(str(file_path))
        return {"duration_seconds": round(float(info.duration), 4)}
    except Exception:
        return {"duration_seconds": None}


def build_manifest(root: Path) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for current_root, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs.sort()
        for filename in sorted(files):
            file_path = Path(current_root) / filename
            if file_path.is_symlink():
                continue
            relative_path = file_path.relative_to(root).as_posix()
            item_type = _content_type(file_path)
            analysis = text_analyzer.analyze_path(str(file_path)) if item_type != "file" else {}
            bpm = analysis.get("bpm")
            try:
                bpm = int(bpm) if bpm is not None else None
            except (TypeError, ValueError):
                bpm = None
            audio_values = (
                _audio_metadata(file_path)
                if item_type in {"sample", "loop", "one_shot"}
                else {"duration_seconds": None}
            )
            contents.append({
                "index": len(contents),
                "filename": filename,
                "relative_path": relative_path,
                "type": item_type,
                "mime_type": mimetypes.guess_type(str(file_path))[0],
                "size_bytes": file_path.stat().st_size,
                "bpm": bpm,
                "key": analysis.get("key"),
                "streamable": item_type in {"sample", "loop", "one_shot"},
                **audio_values,
            })
    return contents


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
    if source.is_dir() and store.is_relative_to(source.resolve()):
        raise ValueError("Cannot import a folder that contains GAIA's managed asset store")
    store.mkdir(parents=True, exist_ok=True)
    import_id = uuid.uuid4().hex
    staging = store / f".{import_id}.staging"
    destination = store / import_id
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
        "type": "multitrack" if is_multitrack else "collection",
        "mime_type": "application/zip" if source_kind == "zip" else "inode/directory",
        "size_bytes": sum(item.get("size_bytes") or 0 for item in manifest),
        "stems": stems,
        "key": analysis.get("key") if is_multitrack else None,
        "bpm": analysis.get("bpm") if is_multitrack else None,
        "is_valid_length": analysis.get("is_valid_length", False) if is_multitrack else None,
        "length_variance": analysis.get("length_variance", 0.0) if is_multitrack else None,
    }
