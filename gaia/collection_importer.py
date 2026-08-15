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

from . import midi_parser, multitrack_analyzer, text_analyzer, type_registry


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
        midi_key = midi_values.get("key")
        role = text_analyzer.key_role(str(file_path), item_type, analysis.get("tags", []))
        key = text_analyzer.normalize_key_for_role(midi_key or key, role)

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


class NoMatchingCollectionError(ValueError):
    """Raised when constrained auto-detection finds no matching collection type."""


def _classify_folder(
    root: Path,
    contents: list[dict[str, Any]],
    expected_type: str,
    analysis_types: list[str] | tuple[str, ...] | None = None,
) -> tuple[str, dict[str, Any], list[str]]:
    """Return the selected folder type, optional stem analysis, and warnings."""
    expectation = type_registry.validate_import_expectation(expected_type)
    if expectation == "files":
        raise ValueError("The files import mode cannot import a folder snapshot")
    allowed_types = type_registry.resolve_analysis_types(analysis_types, expectation)
    if not allowed_types:
        raise ValueError("Items-only mode does not create a folder snapshot")

    analysis: dict[str, Any] = {}
    looks_like_stems = False
    if "multitrack" in allowed_types:
        analysis = multitrack_analyzer.analyze_multitrack_folder(str(root), recursive=False)
        looks_like_stems = multitrack_analyzer.is_multitrack_analysis(analysis)

    if len(allowed_types) > 1:
        inferred_type = inferred_collection_type(contents, looks_like_stems)
        if inferred_type in allowed_types:
            return inferred_type, analysis, []
        if "collection" in allowed_types:
            return "collection", {}, []
        enabled = ", ".join(
            definition.label
            for definition in (type_registry.TYPE_BY_ID[value] for value in allowed_types)
        )
        raise NoMatchingCollectionError(
            f"The folder did not match an enabled analysis type ({enabled}). "
            "Import it as independent items or choose a specific collection type."
        )

    selected_type = allowed_types[0]
    if selected_type == "multitrack":
        warnings: list[str] = []
        stems = analysis.get("stems", []) or []
        if len(stems) < 2:
            warnings.append("Stem collection contains fewer than two direct audio files.")
        if stems and not analysis.get("is_valid_length"):
            variance = float(analysis.get("length_variance") or 0.0)
            warnings.append(
                f"Stem lengths differ by {variance:.4f} seconds; the folder was kept as an explicit stem collection."
            )
        elif stems and not looks_like_stems:
            warnings.append(
                "The filenames do not identify distinct stem roles; the folder was kept as an explicit stem collection."
            )
        return "multitrack", analysis, warnings
    if selected_type == "sample_pack":
        media_count = sum(
            entry.get("type") in {"sample", "loop", "one_shot", "midi"}
            for entry in contents
        )
        warnings = [] if media_count else ["No audio or MIDI items were found in this explicit sample pack."]
        return "sample_pack", {}, warnings
    if selected_type == "collection":
        return "collection", {}, []
    if type_registry.is_project_type(selected_type):
        return selected_type, {}, []
    raise ValueError(f"Unsupported folder import expectation: {selected_type}")


def snapshot_collection_source(
    source_path: str,
    asset_store: Path | None = None,
    allow_multitracks: bool = True,
    expected_type: str = "auto",
    analysis_types: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
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
    if source_kind == "folder" and (
        source_resolved == store or source_resolved in store.parents
    ):
        raise ValueError("Cannot import the GAIA asset store or a folder that contains it")

    expectation = type_registry.validate_import_expectation(expected_type)
    if not allow_multitracks and expectation == "auto":
        expectation = "collection"

    manifest: list[dict[str, Any]]
    analysis: dict[str, Any]
    warnings: list[str]
    selected_type: str

    managed_copy_created = not (
        source_kind == "folder" and (store in source_resolved.parents or source_resolved == store)
    )
    if not managed_copy_created:
        destination = source_resolved
        manifest = build_manifest(destination)
        selected_type, analysis, warnings = _classify_folder(
            destination, manifest, expectation, analysis_types
        )
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
            selected_type, analysis, warnings = _classify_folder(
                staging, manifest, expectation, analysis_types
            )
            os.replace(staging, destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    # Stem paths must point at the finalized managed copy, not the source snapshot.
    is_multitrack = selected_type == "multitrack"
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
        "type": selected_type,
        "mime_type": "application/zip" if source_kind == "zip" else "inode/directory",
        "size_bytes": sum(item.get("size_bytes") or 0 for item in manifest),
        "stems": stems,
        "key": analysis.get("key") if is_multitrack else None,
        "bpm": analysis.get("bpm") if is_multitrack else None,
        "is_valid_length": analysis.get("is_valid_length", False) if is_multitrack else None,
        "length_variance": analysis.get("length_variance", 0.0) if is_multitrack else None,
        "warnings": warnings,
        "managed_copy_created": managed_copy_created,
    }
