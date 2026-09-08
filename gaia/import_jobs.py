"""Fast, read-only import inspection and safe background materialisation."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any, Callable, Iterable

from sqlalchemy.orm import Session

from . import (
    collection_importer,
    crud,
    database,
    integrity,
    models,
    multitrack_analyzer,
    paths,
    profiles,
    schemas,
    vaults,
)


PREVIEW_TTL_SECONDS = 60 * 60
JOB_RETENTION_SECONDS = 24 * 60 * 60
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "stale"}
COPY_PROGRESS_CHUNK_BYTES = 8 * 1024 * 1024
FOLDER_TYPE_ASSIGNMENTS = {
    "action:contain": ("collection", None),
    "type:collection": ("collection", None),
    "type:multitrack": ("multitrack", None),
}
FILE_FAMILY_TYPES = {
    "audio": ("audio", "track", "sample"),
    "midi": ("midi",),
    "sequence": ("sequence",),
    "file": ("item",),
}
ARTIFACT_SUFFIXES = {".asd", ".bak", ".peak", ".pkf", ".reapeaks", ".tmp"}
ARTIFACT_FILENAMES = {".ds_store", "desktop.ini", "thumbs.db"}


class ImportPreviewError(ValueError):
    pass


class ImportCancelled(Exception):
    pass


def _vault_for_request(db: Session, vault_id: int | None) -> models.Vault:
    if vault_id is None:
        return vaults.ensure_default_vault(db)
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise ImportPreviewError("Vault not found")
    return vault


def _safe_name(value: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(". ") or "Imported"


def _unique_directory(parent: Path, title: str) -> Path:
    candidate = parent / _safe_name(title)
    return candidate if not candidate.exists() else parent / f"{_safe_name(title)}_{uuid.uuid4().hex[:8]}"


def _unique_file_destination(parent: Path, filename: str, reserved: set[str] | None = None) -> Path:
    """Return a collision-free path without wrapping a loose file in another folder."""
    reserved = reserved if reserved is not None else set()
    candidate = parent / Path(filename).name
    candidate_key = str(candidate).casefold()
    if not candidate.exists() and candidate_key not in reserved:
        reserved.add(candidate_key)
        return candidate
    stem = Path(filename).stem or "asset"
    suffix = Path(filename).suffix
    counter = 2
    while True:
        candidate = parent / f"{stem}_{counter}{suffix}"
        candidate_key = str(candidate).casefold()
        if not candidate.exists() and candidate_key not in reserved:
            reserved.add(candidate_key)
            return candidate
        counter += 1


def _remove_managed_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def _source_kind(source: Path) -> str:
    if source.is_dir():
        return "folder"
    if source.is_file() and zipfile.is_zipfile(source):
        return "zip"
    if source.is_file():
        return "file"
    raise ImportPreviewError("Source path does not exist")


def _file_family(path: str) -> tuple[str, str]:
    if PurePosixPath(path).name.startswith("._"):
        return "file", "item"
    extension = Path(path).suffix.casefold()
    if extension in collection_importer.AUDIO_EXTENSIONS:
        return "audio", "audio"
    if extension in collection_importer.MIDI_EXTENSIONS:
        return "midi", "midi"
    if extension == ".seq":
        return "sequence", "sequence"
    return "file", "item"


def _artifact_reason(relative_path: str) -> str | None:
    relative = PurePosixPath(relative_path)
    filename = relative.name.casefold()
    if filename.startswith("._"):
        return "macOS AppleDouble sidecar"
    if "__macosx" in {part.casefold() for part in relative.parts}:
        return "macOS archive metadata"
    if filename in ARTIFACT_FILENAMES:
        return "operating-system metadata"
    if Path(filename).suffix in ARTIFACT_SUFFIXES:
        return f"{Path(filename).suffix} application sidecar"
    return None


def _file_entry(relative_path: str, size: int, modified_ns: int, index: int, signature: str | None = None) -> dict[str, Any]:
    relative = PurePosixPath(relative_path).as_posix()
    family, item_type = _file_family(relative)
    extension = Path(relative).suffix.casefold()
    artifact_reason = _artifact_reason(relative)
    return {
        "index": index,
        "node_id": f"file:{index}",
        "kind": "file",
        "filename": PurePosixPath(relative).name,
        "relative_path": relative,
        "extension": extension,
        "parent_path": PurePosixPath(relative).parent.as_posix() if PurePosixPath(relative).parent.as_posix() != "." else ".",
        "depth": len(PurePosixPath(relative).parts),
        "family": family,
        "type": item_type,
        "allowed_types": list(FILE_FAMILY_TYPES[family]),
        "mime_type": mimetypes.guess_type(relative)[0],
        "size_bytes": int(size),
        "modified_ns": int(modified_ns),
        "signature": signature,
        "artifact": artifact_reason is not None,
        "artifact_reason": artifact_reason,
        "profile_role": None,
        "profile_role_reason": None,
    }


def _folder_node(relative_path: str, name: str, depth: int) -> dict[str, Any]:
    return {
        "node_id": f"folder:{relative_path}",
        "kind": "folder",
        "relative_path": relative_path,
        "parent_path": None if relative_path == "." else (PurePosixPath(relative_path).parent.as_posix() or "."),
        "name": name,
        "depth": depth,
        "detected_assignment": None,
        "suggested_assignment": None,
        "detection_label": None,
        "detection_reason": None,
        "warning_count": 0,
        "warning_messages": [],
    }


def _scan_folder(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entries: list[dict[str, Any]] = []
    nodes = [_folder_node(".", source.name, 0)]
    for current_root, dirs, files in os.walk(source, topdown=True, followlinks=False):
        current = Path(current_root)
        dirs[:] = sorted(name for name in dirs if not (current / name).is_symlink())
        relative_root = current.relative_to(source)
        for directory in dirs:
            relative = (relative_root / directory).as_posix()
            nodes.append(_folder_node(relative, directory, len(PurePosixPath(relative).parts)))
        for filename in sorted(files):
            path = current / filename
            if path.is_symlink():
                continue
            stat = path.stat()
            relative = (relative_root / filename).as_posix()
            entry = _file_entry(relative, stat.st_size, stat.st_mtime_ns, len(entries))
            entries.append(entry)
            nodes.append(entry)
    return entries, nodes


def _scan_zip(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entries: list[dict[str, Any]] = []
    nodes = [_folder_node(".", source.stem, 0)]
    folders: set[str] = set()
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        files = [member for member in members if not member.is_dir()]
        if len(files) > collection_importer.MAX_ARCHIVE_FILES:
            raise ImportPreviewError(f"Archive contains more than {collection_importer.MAX_ARCHIVE_FILES} files")
        if sum(max(0, member.file_size) for member in files) > collection_importer.MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ImportPreviewError("Archive is larger than GAIA's configured extraction limit")
        for member in members:
            relative = PurePosixPath(member.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise ImportPreviewError("Archive contains an unsafe path")
            for index in range(1, len(relative.parts)):
                folders.add(PurePosixPath(*relative.parts[:index]).as_posix())
            if member.is_dir():
                folders.add(PurePosixPath(*relative.parts).as_posix())
                continue
            signature = f"{member.CRC}:{member.compress_size}:{member.file_size}"
            entry = _file_entry(relative.as_posix(), member.file_size, 0, len(entries), signature)
            entries.append(entry)
    for relative in sorted(folders, key=lambda value: (len(PurePosixPath(value).parts), value.casefold())):
        nodes.append(_folder_node(relative, PurePosixPath(relative).name, len(PurePosixPath(relative).parts)))
    nodes.extend(entries)
    return entries, nodes


def _scan_source(source: Path, source_kind: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if source_kind == "folder":
        return _scan_folder(source)
    if source_kind == "zip":
        return _scan_zip(source)
    stat = source.stat()
    entry = _file_entry(source.name, stat.st_size, stat.st_mtime_ns, 0)
    entry["depth"] = 0
    return [entry], [entry]


def _stat_fingerprint(source: Path, source_kind: str, entries: list[dict[str, Any]]) -> str:
    """Cheap path/stat fingerprint; content hashing is deferred to the background job."""
    digest = hashlib.sha256()
    digest.update(source_kind.encode())
    digest.update(str(source.resolve()).encode())
    if source.exists():
        source_stat = source.stat()
        digest.update(f"{source_stat.st_size}:{source_stat.st_mtime_ns}".encode())
    for entry in entries:
        digest.update(entry["relative_path"].encode())
        digest.update(f"{entry['size_bytes']}:{entry['modified_ns']}:{entry.get('signature') or ''}".encode())
    return digest.hexdigest()


def _h4_role(entry: dict[str, Any]) -> str | None:
    if entry["family"] != "audio":
        return None
    stem = Path(entry["filename"]).stem.casefold()
    match = re.search(r"(?:^|[_\s-])tr(?P<role>lr|mic|\d{1,2})(?=$|[_\s.-])", stem)
    return match.group("role") if match else None


def _h4_roles(entries: list[dict[str, Any]]) -> set[str]:
    roles: set[str] = set()
    for entry in entries:
        role = _h4_role(entry)
        if role:
            roles.add(role)
    return roles


def _annotate_h4_roles(entries: list[dict[str, Any]]) -> None:
    role_entries = [(entry, _h4_role(entry)) for entry in entries]
    for entry, role in role_entries:
        if role == "lr":
            entry.update(profile_role="mixdown", profile_role_reason="Zoom TrLR mixdown")
        elif role:
            entry.update(profile_role="source_channel", profile_role_reason=f"Zoom Tr{role} source channel")
    if any(role == "lr" for _, role in role_entries):
        return
    audio_entries = [entry for entry, _ in role_entries if entry["family"] == "audio"]
    renamed = [entry for entry, role in role_entries if entry["family"] == "audio" and role is None]
    if len(audio_entries) > 1 and len(renamed) == 1:
        renamed[0].update(
            profile_role="mixdown",
            profile_role_reason="Only renamed audio file; inferred Zoom mixdown because TrLR is absent",
        )


def _looks_like_multitrack(entries: list[dict[str, Any]]) -> bool:
    role_pattern = re.compile(r"(?:^|[_\s-])(drums?|bass|vocals?|guitars?|keys?|synth|percussion|stems?)(?=$|[_\s.-])", re.I)
    roles = {
        match.group(1).casefold()
        for entry in entries
        if entry["family"] == "audio"
        for match in [role_pattern.search(Path(entry["filename"]).stem)]
        if match
    }
    return len(roles) >= 2


def _available_profiles() -> list[dict[str, Any]]:
    discovered: dict[str, profiles.Profile] = {}
    for profile in profiles.discover_profiles():
        discovered[profile.id] = profile
    if profiles.TEMPLATE_DIRECTORY.is_dir():
        for template in sorted(profiles.TEMPLATE_DIRECTORY.glob("*.json")):
            for profile in profiles.load_profile_bundle(template).profiles:
                discovered.setdefault(profile.id, profile)
    return [
        {
            "id": profile.id,
            "bundle_id": profile.bundle_id,
            "label": profile.label,
            "description": profile.description,
            "container_type": profile.container_type,
        }
        for profile in sorted(discovered.values(), key=lambda value: value.label.casefold())
    ]


def _classify_folders(nodes: list[dict[str, Any]], entries: list[dict[str, Any]]) -> None:
    folders = [node for node in nodes if node["kind"] == "folder"]
    for folder in folders:
        prefix = "" if folder["relative_path"] == "." else folder["relative_path"] + "/"
        direct = [entry for entry in entries if entry["parent_path"] == folder["relative_path"]]
        descendants = [entry for entry in entries if folder["relative_path"] == "." or entry["relative_path"].startswith(prefix)]
        h4_roles = _h4_roles(direct)
        if len(h4_roles) >= 2 and ({"mic", "lr"} & h4_roles):
            _annotate_h4_roles(direct)
            folder.update(
                detected_assignment="profile:zoom_h4",
                detection_label="Zoom H4",
                detection_reason=f"Timestamped Zoom tracks detected ({', '.join(sorted(h4_roles))}).",
            )
        elif _looks_like_multitrack(direct):
            folder.update(
                detected_assignment="type:multitrack",
                detection_label="Multitrack",
                detection_reason="Distinct stem-role filenames were detected.",
            )
        media_count = sum(entry["family"] in {"audio", "midi"} for entry in descendants)
        if not folder["detected_assignment"] and media_count >= 3 and media_count >= max(1, len(descendants)) * 0.5:
            folder.update(
                suggested_assignment="profile:sample_pack",
                detection_label="Possible sample pack",
                detection_reason="Most files are audio or MIDI; confirm the Sample pack profile if appropriate.",
            )
        artifact_entries = [entry for entry in descendants if entry["artifact"]]
        folder["warning_count"] = len(artifact_entries)
        folder["warning_messages"] = sorted({entry["artifact_reason"] for entry in artifact_entries if entry["artifact_reason"]})


def _find_conflicts(db: Session, vault: models.Vault, source: Path, source_kind: str) -> list[dict[str, Any]]:
    if source_kind not in {"folder", "zip"}:
        return []
    existing = crud.get_collection_by_source(db, str(source), vault.id)
    logged = db.query(models.VaultImportLog).filter(
        models.VaultImportLog.vault_id == vault.id,
        models.VaultImportLog.source_path == str(source),
        models.VaultImportLog.item_id.isnot(None),
    ).first()
    if not existing and not logged:
        return []
    return [{
        "kind": "source_already_imported",
        "message": "This source path is already represented in the destination vault.",
        "item_id": existing.id if existing else logged.item_id,
    }]


def create_preview(source_path: str, vault_id: int | None, db: Session) -> dict[str, Any]:
    started = time.perf_counter()
    source = Path(collection_importer.canonical_source_path(source_path)).resolve()
    source_kind = _source_kind(source)
    vault = _vault_for_request(db, vault_id)
    store = vaults.vault_store(vault).resolve()
    if source == store or store in source.parents or source in store.parents:
        raise ImportPreviewError("Choose a source outside the destination vault's managed asset store")
    entries, nodes = _scan_source(source, source_kind)
    _classify_folders(nodes, entries)
    profile_options = _available_profiles()
    type_counts: dict[str, int] = {}
    extension_counts: dict[str, int] = {}
    for entry in entries:
        family = entry.get("family", "file")
        type_counts[family] = type_counts.get(family, 0) + 1
        extension = entry.get("extension", "")
        extension_counts[extension] = extension_counts.get(extension, 0) + 1
    type_labels = {"audio": "Audio", "midi": "MIDI", "sequence": "Sequence", "file": "Other files"}
    return {
        "preview_id": uuid.uuid4().hex,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source_path": str(source),
        "source_kind": source_kind,
        "vault_id": vault.id,
        "source_fingerprint": _stat_fingerprint(source, source_kind, entries),
        "title": source.stem if source_kind in {"file", "zip"} else source.name,
        "entries": entries,
        "nodes": nodes,
        "file_count": len(entries),
        "folder_count": sum(node["kind"] == "folder" for node in nodes),
        "size_bytes": sum(entry["size_bytes"] for entry in entries),
        "inspection_ms": round((time.perf_counter() - started) * 1000),
        "profiles": profile_options,
        "folder_type_options": [
            {"value": "action:contain", "label": "Contain folder"},
            {"value": "action:ignore", "label": "Ignore folder (flatten)"},
            {"value": "type:multitrack", "label": "Multitrack"},
        ],
        "filter_options": {
            "types": [
                {"value": value, "label": type_labels.get(value, value.title()), "count": count}
                for value, count in sorted(type_counts.items(), key=lambda pair: pair[0])
            ],
            "extensions": [
                {"value": value, "label": value or "(no extension)", "count": count}
                for value, count in sorted(extension_counts.items(), key=lambda pair: (pair[0] == "", pair[0]))
            ],
        },
        "conflicts": _find_conflicts(db, vault, source, source_kind),
        "warnings": [],
    }


def _relative_is_within(relative_path: str, folder_path: str) -> bool:
    return folder_path == "." or relative_path == folder_path or relative_path.startswith(folder_path + "/")


def _topmost_folder_targets(assignments: dict[str, str]) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    for path, assignment in sorted(assignments.items(), key=lambda pair: (0 if pair[0] == "." else len(PurePosixPath(pair[0]).parts), pair[0])):
        if assignment and assignment != "action:ignore" and not any(_relative_is_within(path, parent) for parent, _ in targets):
            targets.append((path, assignment))
    return targets


def _resolve_folder_assignment(assignment: str, available_profiles: list[dict[str, Any]]) -> tuple[str, str | None]:
    if assignment in {"action:contain", "type:collection"}:
        return "collection", None
    if assignment in FOLDER_TYPE_ASSIGNMENTS:
        return FOLDER_TYPE_ASSIGNMENTS[assignment]
    if assignment.startswith("profile:"):
        profile_id = assignment.split(":", 1)[1]
        profile = next((value for value in available_profiles if value["id"] == profile_id), None)
        if not profile or profile["container_type"] not in {"collection", "multitrack"}:
            raise ImportPreviewError(f"Unknown folder profile: {profile_id}")
        return profile["container_type"], profile_id
    raise ImportPreviewError(f"Unsupported folder classification: {assignment}")


@contextmanager
def _materialized_root(preview: dict[str, Any]):
    source = Path(preview["source_path"])
    if preview["source_kind"] == "folder":
        yield source
    elif preview["source_kind"] == "file":
        yield source.parent
    else:
        with tempfile.TemporaryDirectory(prefix="gaia-import-extract-") as temporary:
            root = Path(temporary)
            collection_importer._extract_zip(source, root)
            yield root


def _copy_entries(
    root: Path,
    destination: Path,
    entries: Iterable[dict[str, Any]],
    prefix: str,
    cancelled: Callable[[], bool],
    progress: Callable[[str, int, bool], None],
) -> None:
    prefix_path = PurePosixPath() if prefix == "." else PurePosixPath(prefix)
    for entry in entries:
        if cancelled():
            raise ImportCancelled()
        relative = PurePosixPath(entry["relative_path"])
        rebased = relative if prefix == "." else relative.relative_to(prefix_path)
        source_file = root.joinpath(*relative.parts)
        target_file = destination.joinpath(*rebased.parts)
        target_file.parent.mkdir(parents=True, exist_ok=True)
        _copy_file_to_staging(source_file, target_file, lambda copied: progress(entry["filename"], copied, False))
        progress(entry["filename"], 0, True)


def _copy_file_to_staging(source: Path, destination: Path, progress: Callable[[int], None]) -> str:
    """Copy one file with byte progress while calculating its content hash."""
    digest = hashlib.sha256()
    with source.open("rb") as source_handle, destination.open("wb") as destination_handle:
        while True:
            chunk = source_handle.read(COPY_PROGRESS_CHUNK_BYTES)
            if not chunk:
                break
            destination_handle.write(chunk)
            digest.update(chunk)
            progress(len(chunk))
    shutil.copystat(source, destination)
    return digest.hexdigest()


def _original_source_path(preview: dict[str, Any], relative_path: str) -> str:
    if preview["source_kind"] == "file":
        return preview["source_path"]
    if preview["source_kind"] == "zip":
        return f"{preview['source_path']}::{relative_path}"
    relative = PurePosixPath(relative_path)
    return str(Path(preview["source_path"]).joinpath(*relative.parts))


def _manifest_seed(preview: dict[str, Any], entry: dict[str, Any], relative_path: str, index: int) -> dict[str, Any]:
    return {
        "index": index,
        "filename": entry["filename"],
        "relative_path": relative_path,
        "source_path": _original_source_path(preview, entry["relative_path"]),
        "type": entry.get("type", "item"),
        "mime_type": entry.get("mime_type"),
        "size_bytes": entry.get("size_bytes"),
        "duration_seconds": None,
        "bpm": None,
        "key": None,
        "is_loop": False,
        "tags": [],
        "streamable": False,
    }


def _process_staged_entries(
    staging_root: Path,
    entries: list[dict[str, Any]],
    destinations: list[Path],
    cancelled: Callable[[], bool],
    progress: Callable[[str], None],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Legacy helper retained for compatibility with older callers and tests."""
    if not entries:
        return [], []
    if len(entries) != len(destinations):
        raise ValueError("Every staged import entry requires one managed destination")

    def analyze(entry: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        source_path = staging_root / Path(entry["relative_path"])
        entry_warnings: list[str] = []
        try:
            analyzed = collection_importer.analyze_manifest_entry(staging_root, dict(entry))
        except Exception as exc:
            analyzed = {
                **entry,
                "title": Path(entry["filename"]).stem,
                "streamable": entry.get("type") in {"audio", "track", "sample"},
            }
            entry_warnings.append(
                f"Automatic analysis failed for {entry['source_path']}: {exc}. "
                "The file was imported with basic metadata and can be analyzed later."
            )
        try:
            analyzed["file_hash"] = integrity.calculate_file_hash(str(source_path))
        except Exception as exc:
            analyzed["file_hash"] = ""
            entry_warnings.append(f"Could not hash {entry['source_path']}: {exc}.")
        return analyzed, entry_warnings

    results: list[dict[str, Any] | None] = [None] * len(entries)
    warnings: list[str] = []
    for index, entry in enumerate(entries):
        if cancelled():
            raise ImportCancelled()
        analyzed, entry_warnings = analyze(entry)
        destination = destinations[index]
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging_root / Path(entry["relative_path"]), destination)
        results[index] = analyzed
        warnings.extend(entry_warnings)
        progress(entry["filename"])
    return [entry for entry in results if entry is not None], warnings


def _collection_tags(contents: list[dict[str, Any]]) -> list[str]:
    counts: dict[str, int] = {}
    media = [entry for entry in contents if entry.get("type") in {"audio", "midi", "sample"}]
    for entry in media:
        for tag in entry.get("tags", []):
            counts[tag] = counts.get(tag, 0) + 1
    threshold = max(2, round(len(media) * 0.03))
    return [tag for tag, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0])) if count >= threshold][:6]


def _forced_item_type(original_path: str, entry: dict[str, Any], job: dict[str, Any]) -> str:
    preview_entry = _preview_entry(original_path, job)
    if not preview_entry:
        return entry.get("type", "item")
    return job["item_types"].get(str(preview_entry["index"]), preview_entry["type"])


def _preview_entry(original_path: str, job: dict[str, Any]) -> dict[str, Any] | None:
    return next((value for value in job["preview"]["entries"] if value["relative_path"] == original_path), None)


def _item_schema_for_manifest(
    entry: dict[str, Any],
    absolute_path: Path,
    vault_id: int,
    parent_id: int | None,
    forced_type: str,
    *,
    storage_mode: str = "managed",
    availability: str = "ready",
):
    common = {
        "absolute_path": str(absolute_path.resolve()),
        "vault_id": vault_id,
        "parent_id": parent_id,
        "storage_mode": storage_mode,
        "availability": availability,
        "file_hash": entry.get("file_hash"),
        "size_bytes": entry.get("size_bytes"),
        "mime_type": entry.get("mime_type"),
    }
    audio_metadata = dict(entry.get("audio_metadata") or {})
    if not audio_metadata:
        audio_metadata = {
            field: entry.get(field)
            for field in collection_importer.AUDIO_METADATA_FIELDS
            if entry.get(field) is not None
        }
    if forced_type == "sample":
        return schemas.SampleItemCreate(
            **common,
            bpm=entry.get("bpm"),
            key=entry.get("key"),
            is_loop=bool(entry.get("is_loop")),
            attributes={"audio_metadata": audio_metadata} if audio_metadata else {},
        )
    if forced_type == "track":
        return schemas.TrackItemCreate(
            **common,
            title=audio_metadata.get("title"),
            author=entry.get("author"),
            album=entry.get("album"),
            album_artist=entry.get("album_artist"),
            release_year=entry.get("release_year"),
            genre=entry.get("genre"),
            track_number=entry.get("track_number"),
            disc_number=entry.get("disc_number"),
            comment=entry.get("comment"),
            attributes={"audio_metadata": audio_metadata} if audio_metadata else {},
        )
    if forced_type == "audio":
        attributes = {
            "analysis": {"is_loop": bool(entry.get("is_loop")), "bpm": entry.get("bpm"), "key": entry.get("key")}
        }
        if audio_metadata:
            attributes["audio_metadata"] = audio_metadata
        return schemas.AudioItemCreate(**common, attributes=attributes)
    if forced_type == "midi":
        return schemas.MidiItemCreate(**common, bpm=entry.get("bpm"), key=entry.get("key"))
    return schemas.ItemCreate(**common, type=forced_type if forced_type in {"sequence", "item"} else "item")


def _index_children(db: Session, snapshot: dict[str, Any], vault_id: int, parent_id: int, job: dict[str, Any], prefix: str) -> None:
    root = Path(snapshot["absolute_path"])
    pending: list[tuple[models.Item, dict[str, Any], dict[str, Any] | None]] = []
    for entry in snapshot["contents"]:
        original = entry["relative_path"] if prefix == "." else (PurePosixPath(prefix) / entry["relative_path"]).as_posix()
        forced_type = _forced_item_type(original, entry, job)
        preview_entry = _preview_entry(original, job)
        item_schema = _item_schema_for_manifest(
            entry,
            root / Path(entry["relative_path"]),
            vault_id,
            parent_id,
            forced_type,
            storage_mode=snapshot.get("storage_mode", "managed"),
            availability=snapshot.get("availability", "ready"),
        )
        if preview_entry and preview_entry.get("profile_role"):
            attributes = dict(item_schema.attributes or {})
            attributes.update(
                profile_role=preview_entry["profile_role"],
                profile_role_reason=preview_entry.get("profile_role_reason"),
            )
            item_schema.attributes = attributes
        attributes = dict(item_schema.attributes or {})
        attributes["import"] = {
            "job_id": job["job_id"],
            "mode": job["transfer_mode"],
            "source_path": entry["source_path"],
            "state": "ready" if snapshot.get("availability") == "ready" else "registered",
            "registered_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        item_schema.attributes = attributes
        child = crud.create_item(
            db,
            item_schema,
            commit=False,
            flush=False,
        )
        entry["type"] = forced_type
        entry["storage_mode"] = snapshot.get("storage_mode", "managed")
        entry["availability"] = snapshot.get("availability", "ready")
        if preview_entry and preview_entry.get("profile_role"):
            entry["profile_role"] = preview_entry["profile_role"]
        pending.append((child, entry, preview_entry))
    crud.set_items_tags(db, [(child, entry.get("tags", [])) for child, entry, _ in pending])
    for child, entry, _ in pending:
        entry["child_id"] = child.id


def _container_snapshot(
    preview: dict[str, Any],
    destination: Path,
    target: dict[str, Any],
    contents: list[dict[str, Any]],
    import_warnings: list[str],
    *,
    analyze: bool = True,
    storage_mode: str = "managed",
    availability: str = "ready",
) -> dict[str, Any]:
    analysis: dict[str, Any] = {}
    warnings = list(import_warnings)
    if analyze and target["container_type"] == "multitrack":
        try:
            analysis = multitrack_analyzer.analyze_multitrack_folder(str(destination), recursive=False)
        except Exception as exc:
            warnings.append(
                f"Automatic multitrack analysis failed for {target['title']}: {exc}. "
                "The files were imported and can be analyzed later."
            )
        stems = analysis.get("stems", []) or []
        if stems and not analysis.get("is_valid_length"):
            warnings.append(f"Stem lengths differ by {float(analysis.get('length_variance') or 0):.4f} seconds.")
    else:
        stems = []
    for stem in stems:
        stem["absolute_path"] = str(destination / Path(stem.get("relative_path", "")))
    if target["relative_path"] == ".":
        source_path = preview["source_path"]
    elif preview["source_kind"] == "zip":
        source_path = f"{preview['source_path']}::{target['relative_path']}"
    else:
        source_path = str(Path(preview["source_path"]) / Path(target["relative_path"]))
    return {
        "absolute_path": str(destination),
        "source_path": source_path,
        "source_kind": preview["source_kind"],
        "title": target["title"],
        "contents": contents,
        "type": target["container_type"],
        "mime_type": "application/zip" if preview["source_kind"] == "zip" else "inode/directory",
        "size_bytes": sum(int(entry.get("size_bytes") or 0) for entry in contents),
        "stems": stems,
        "key": analysis.get("key"),
        "bpm": analysis.get("bpm"),
        "is_valid_length": analysis.get("is_valid_length", False),
        "length_variance": analysis.get("length_variance", 0.0),
        "warnings": warnings,
        "storage_mode": storage_mode,
        "availability": availability,
    }


def _create_container(db: Session, snapshot: dict[str, Any], vault: models.Vault, job: dict[str, Any], target: dict[str, Any]) -> models.Item:
    profile = next((value for value in job["preview"]["profiles"] if value["id"] == target.get("profile_id")), None)
    attributes = {
        "import": {
            "job_id": job["job_id"],
            "source_fingerprint": job["preview"]["source_fingerprint"],
            "source_kind": snapshot["source_kind"],
            "imported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "immutable": target.get("profile_id") == "sample_pack",
        }
    }
    if profile:
        attributes.update(profile_id=profile["id"], profile_bundle_id=profile["bundle_id"], profile_label=profile["label"])
    common = {
        "absolute_path": snapshot["absolute_path"], "vault_id": vault.id,
        "storage_mode": snapshot.get("storage_mode", "managed"),
        "availability": snapshot.get("availability", "ready"),
        "size_bytes": snapshot["size_bytes"], "mime_type": snapshot["mime_type"],
        "title": snapshot["title"], "source_kind": snapshot["source_kind"],
        "source_path": snapshot["source_path"], "contents": snapshot["contents"],
        "warnings": snapshot["warnings"], "attributes": attributes,
    }
    if snapshot["type"] == "multitrack":
        schema = schemas.MultitrackItemCreate(
            **common, stems=snapshot["stems"], key=snapshot["key"], bpm=snapshot["bpm"],
            is_valid_length=snapshot["is_valid_length"], length_variance=snapshot["length_variance"],
        )
    else:
        schema = schemas.CollectionItemCreate(**common)
    result = crud.create_item(db, schema, commit=False)
    _index_children(db, snapshot, vault.id, result.id, job, target["relative_path"])
    crud.save_collection_contents(db, result, snapshot["contents"], commit=False, flush=False)
    tags = _collection_tags(snapshot["contents"])
    if tags:
        crud.set_items_tags(db, [(result, tags)])
    return result


def _item_payload(item: models.Item) -> dict[str, Any]:
    audio_metadata = dict((getattr(item, "attributes", {}) or {}).get("audio_metadata") or {})
    return {
        "id": item.id,
        "type": item.type,
        "display_type": item.attributes.get("profile_label") or item.type,
        "title": getattr(item, "title", None) or Path(item.absolute_path).name,
        "absolute_path": item.absolute_path,
        "source_path": crud._source_path(item),
        "storage_mode": item.storage_mode,
        "availability": item.availability,
        "size_bytes": item.size_bytes,
        "author": audio_metadata.get("author"),
        "release_year": audio_metadata.get("release_year"),
        "album": audio_metadata.get("album"),
        "album_artist": audio_metadata.get("album_artist"),
        "genre": audio_metadata.get("genre"),
        "track_number": audio_metadata.get("track_number"),
        "disc_number": audio_metadata.get("disc_number"),
        "comment": audio_metadata.get("comment"),
        "audio_metadata": audio_metadata,
    }


class ImportJobManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._previews: dict[str, dict[str, Any]] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gaia-import")

    def _prune(self) -> None:
        now = time.time()
        self._previews = {key: value for key, value in self._previews.items() if now - value["created_epoch"] < PREVIEW_TTL_SECONDS}
        self._jobs = {key: value for key, value in self._jobs.items() if value["status"] not in TERMINAL_STATUSES or now - value["created_epoch"] < JOB_RETENTION_SECONDS}

    def create_preview(self, source_path: str, vault_id: int | None, db: Session) -> dict[str, Any]:
        preview = create_preview(source_path, vault_id, db)
        with self._lock:
            self._prune()
            self._previews[preview["preview_id"]] = {**preview, "created_epoch": time.time()}
        return preview

    def _preview(self, preview_id: str) -> dict[str, Any]:
        with self._lock:
            self._prune()
            preview = self._previews.get(preview_id)
            if not preview:
                raise ImportPreviewError("Preview expired or was not found. Inspect the source again.")
            return json.loads(json.dumps(preview))

    def _log_path(self, job_id: str) -> Path:
        now = dt.datetime.now(dt.timezone.utc)
        directory = paths.import_logs_directory() / now.strftime("%Y-%m-%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{now.strftime('%Y-%m-%dT%H-%M-%S-%fZ')}_{job_id}.log"

    def _append_log(self, task: dict[str, Any], event: str, **details: Any) -> None:
        type_counts: dict[str, int] = {}
        for value in task["item_types"].values():
            type_counts[value] = type_counts.get(value, 0) + 1
        record = {
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "event": event,
            "job_id": task["job_id"], "preview_id": task["preview"]["preview_id"],
            "source_path": task["preview"]["source_path"], "vault_id": task["preview"]["vault_id"],
            "source_fingerprint": task["preview"]["source_fingerprint"],
            "folder_assignments": task["folder_assignments"],
            "item_type_counts": type_counts,
            "transfer_mode": task["transfer_mode"],
            "conflict_action": task["conflict_action"],
            **details,
        }
        with open(task["log_path"], "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()

    def _public_task(self, task: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in task.items() if key not in {"preview", "cancel_requested", "created_epoch", "targets", "item_types", "folder_assignments"}}

    def create_job(self, request: schemas.ImportJobCreateRequest) -> dict[str, Any]:
        preview = self._preview(request.preview_id)
        if request.transfer_mode == "move" and not request.move_confirmed:
            raise ImportPreviewError("Moving requires confirmation that the original files will be removed")
        if request.transfer_mode == "keep" and preview["source_kind"] == "zip":
            raise ImportPreviewError("ZIP contents cannot be kept as external references")
        valid_folders = {node["relative_path"] for node in preview["nodes"] if node["kind"] == "folder"}
        folder_assignments = {path: value for path, value in request.folder_assignments.items() if value}
        if not set(folder_assignments).issubset(valid_folders):
            raise ImportPreviewError("A folder classification no longer belongs to this preview")
        targets = []
        for relative_path, assignment in _topmost_folder_targets(folder_assignments):
            if assignment == "action:ignore":
                continue
            container_type, profile_id = _resolve_folder_assignment(assignment, preview["profiles"])
            targets.append({
                "relative_path": relative_path, "assignment": assignment,
                "container_type": container_type, "profile_id": profile_id,
                "title": preview["title"] if relative_path == "." else PurePosixPath(relative_path).name,
            })
        valid_indexes = {entry["index"] for entry in preview["entries"]}
        excluded_indexes = set(request.excluded_indexes)
        if not excluded_indexes.issubset(valid_indexes):
            raise ImportPreviewError("An excluded file no longer belongs to this preview")
        valid_filter_types = {entry.get("family") for entry in preview["entries"]}
        requested_types = {str(value).casefold() for value in request.excluded_types}
        if not requested_types.issubset(valid_filter_types):
            raise ImportPreviewError("An excluded file type no longer belongs to this preview")
        valid_extensions = {entry.get("extension", "") for entry in preview["entries"]}
        requested_extensions = {str(value).casefold() for value in request.excluded_extensions}
        if not requested_extensions.issubset(valid_extensions):
            raise ImportPreviewError("An excluded file extension no longer belongs to this preview")
        excluded_indexes.update(
            entry["index"]
            for entry in preview["entries"]
            if entry.get("family") in requested_types or entry.get("extension", "") in requested_extensions
        )
        item_types = {str(index): value for index, value in request.item_types.items()}
        for entry in preview["entries"]:
            selected = item_types.get(str(entry["index"]), entry["type"])
            if selected not in entry["allowed_types"]:
                raise ImportPreviewError(f"{entry['relative_path']} cannot be assigned type {selected}")
            item_types[str(entry["index"])] = selected
        included_entries = [entry for entry in preview["entries"] if entry["index"] not in excluded_indexes]
        if not included_entries:
            raise ImportPreviewError("Keep at least one file in the import")
        targets = [
            target for target in targets
            if any(_relative_is_within(entry["relative_path"], target["relative_path"]) for entry in included_entries)
        ]
        if preview["conflicts"] and request.conflict_action is None:
            raise ImportPreviewError("Choose how to handle the conflict shown in the preview")
        covered = {entry["index"] for entry in included_entries if any(_relative_is_within(entry["relative_path"], target["relative_path"]) for target in targets)}
        loose = [entry["index"] for entry in included_entries if entry["index"] not in covered]
        job_id = uuid.uuid4().hex
        task = {
            "job_id": job_id, "status": "queued", "phase": "queued", "current_title": "",
            "total": len(included_entries), "completed": 0, "imported": 0, "skipped": 0,
            "registration_total": len(included_entries), "registration_completed": 0,
            "staging_total": len(included_entries), "staging_completed": 0,
            "staging_bytes_total": sum(int(entry.get("size_bytes") or 0) for entry in included_entries),
            "staging_bytes_completed": 0,
            "processing_total": len(included_entries), "processing_completed": 0,
            "excluded": len(excluded_indexes), "failed": 0, "warnings": [], "error": None, "result_items": [],
            "log_path": str(self._log_path(job_id)), "created_epoch": time.time(), "cancel_requested": False,
            "preview": preview, "targets": targets, "loose_indexes": loose,
            "folder_assignments": folder_assignments, "item_types": item_types,
            "transfer_mode": request.transfer_mode,
            "skip_track_analysis": request.skip_track_analysis,
            "excluded_indexes": sorted(excluded_indexes),
            "conflict_action": request.conflict_action,
        }
        try:
            self._append_log(task, "queued", target_count=len(targets), loose_file_count=len(loose), excluded_count=len(excluded_indexes))
        except OSError as exc:
            raise ImportPreviewError(f"Could not create the required import log: {exc}") from exc
        with self._lock:
            self._prune()
            self._jobs[job_id] = task
        self._executor.submit(self._run, job_id)
        return self._public_task(task)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._prune()
            task = self._jobs.get(job_id)
            return self._public_task(task) if task else None

    def cancel_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            task = self._jobs.get(job_id)
            if not task:
                return None
            if task["status"] in TERMINAL_STATUSES:
                return self._public_task(task)
            task.update(cancel_requested=True, status="cancelling", phase="cancelling")
        self._append_log(task, "cancellation_requested")
        return self._public_task(task)

    def _cancelled(self, task: dict[str, Any]) -> bool:
        with self._lock:
            return bool(task.get("cancel_requested"))

    def _update(self, task: dict[str, Any], **values: Any) -> None:
        with self._lock:
            task.update(values)

    def _verify_preview(self, task: dict[str, Any]) -> bool:
        preview = task["preview"]
        source = Path(preview["source_path"])
        try:
            kind = _source_kind(source)
            entries, _ = _scan_source(source, kind)
            return kind == preview["source_kind"] and _stat_fingerprint(source, kind, entries) == preview["source_fingerprint"]
        except Exception:
            return False

    def _run(self, job_id: str) -> None:
        task = self._jobs[job_id]
        preview = task["preview"]
        db = database.SessionLocal()
        db.expire_on_commit = False
        partial_paths: list[Path] = []
        results: list[models.Item] = []
        registered_entries: list[dict[str, Any]] = []
        registration_committed = False
        try:
            self._update(task, status="running", phase="revalidating")
            self._append_log(task, "started")
            if not self._verify_preview(task):
                self._update(task, status="stale", phase="stale", error="Source changed, moved, or disappeared after preview.")
                self._append_log(task, "preview_invalidated", error=task["error"])
                return
            if preview["conflicts"] and task["conflict_action"] == "skip":
                self._update(
                    task,
                    status="completed",
                    phase="completed",
                    completed=task["total"],
                    registration_completed=task["registration_total"],
                    staging_completed=task["staging_total"],
                    staging_bytes_completed=task["staging_bytes_total"],
                    processing_completed=task["processing_total"],
                    skipped=task["total"],
                )
                self._append_log(task, "completed", reason="source_conflict_skipped")
                return
            vault = _vault_for_request(db, preview["vault_id"])
            store = vaults.vault_store(vault).resolve()
            transfer_mode = task["transfer_mode"]

            def copied(title: str, copied_bytes: int, file_completed: bool = False) -> None:
                if self._cancelled(task):
                    raise ImportCancelled()
                with self._lock:
                    task["staging_bytes_completed"] += copied_bytes
                    if file_completed:
                        task["staging_completed"] += 1
                    task["completed"] = task["staging_completed"]
                    task["current_title"] = title

            def analyzed(title: str) -> None:
                if self._cancelled(task):
                    raise ImportCancelled()
                with self._lock:
                    task["processing_completed"] += 1
                    task["completed"] = task["processing_completed"]
                    task["current_title"] = title

            with _materialized_root(preview) as root:
                included_entries = [
                    entry for entry in preview["entries"]
                    if entry["index"] not in task["excluded_indexes"]
                ]

                # Stage 1: create all library rows from preview metadata before
                # reading file contents or changing any source path.
                self._update(task, phase="registering", completed=0, current_title="")
                storage_mode = "external_reference" if transfer_mode == "keep" else "managed"
                initial_availability = "ready" if transfer_mode == "keep" else "pending"
                reserved_directories: set[str] = set()
                for target in task["targets"]:
                    entries = [
                        entry for entry in included_entries
                        if _relative_is_within(entry["relative_path"], target["relative_path"])
                    ]
                    prefix = PurePosixPath() if target["relative_path"] == "." else PurePosixPath(target["relative_path"])
                    if transfer_mode == "keep":
                        destination = root if target["relative_path"] == "." else root.joinpath(*prefix.parts)
                    else:
                        base_name = _safe_name(target["title"])
                        destination = store / base_name
                        while str(destination).casefold() in reserved_directories or destination.exists():
                            destination = store / f"{base_name}_{uuid.uuid4().hex[:8]}"
                        reserved_directories.add(str(destination).casefold())
                    seeds = []
                    for index, entry in enumerate(entries):
                        relative = PurePosixPath(entry["relative_path"])
                        rebased = relative if target["relative_path"] == "." else relative.relative_to(prefix)
                        seeds.append(_manifest_seed(preview, entry, rebased.as_posix(), index))
                    snapshot = _container_snapshot(
                        preview,
                        destination,
                        target,
                        seeds,
                        [],
                        analyze=False,
                        storage_mode=storage_mode,
                        availability=initial_availability,
                    )
                    container = _create_container(db, snapshot, vault, task, target)
                    results.append(container)
                    for entry, seed in zip(entries, snapshot["contents"]):
                        registered_entries.append({
                            "item_id": seed["child_id"],
                            "parent_id": container.id,
                            "content_index": seed["index"],
                            "manifest_relative_path": seed["relative_path"],
                            "source": root.joinpath(*PurePosixPath(entry["relative_path"]).parts),
                            "destination": destination.joinpath(*PurePosixPath(seed["relative_path"]).parts),
                            "entry": entry,
                        })

                loose = [entry for entry in included_entries if entry["index"] in task["loose_indexes"]]
                if loose:
                    files_root = store / "files"
                    reserved: set[str] = set()
                    for index, entry in enumerate(loose):
                        source = root.joinpath(*PurePosixPath(entry["relative_path"]).parts)
                        target_path = source if transfer_mode == "keep" else _unique_file_destination(files_root, entry["filename"], reserved)
                        seed = _manifest_seed(preview, entry, entry["relative_path"], index)
                        forced_type = task["item_types"][str(entry["index"])]
                        item = _item_schema_for_manifest(
                            seed,
                            target_path,
                            vault.id,
                            None,
                            forced_type,
                            storage_mode=storage_mode,
                            availability=initial_availability,
                        )
                        attributes = dict(item.attributes or {})
                        attributes["import"] = {
                            "job_id": job_id,
                            "mode": transfer_mode,
                            "source_path": seed["source_path"],
                            "state": "ready" if initial_availability == "ready" else "registered",
                            "registered_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                        }
                        item.attributes = attributes
                        created = crud.create_item(db, item, commit=False)
                        results.append(created)
                        registered_entries.append({
                            "item_id": created.id,
                            "parent_id": None,
                            "content_index": None,
                            "manifest_relative_path": None,
                            "source": source,
                            "destination": target_path,
                            "entry": entry,
                        })

                db.commit()
                registration_committed = True
                self._update(
                    task,
                    registration_completed=task["registration_total"],
                    completed=task["registration_total"],
                    result_items=[_item_payload(item) for item in results],
                )
                self._append_log(task, "registered", imported=len(results), mode=transfer_mode)

                # Stage 2: publish each file independently. Copy hashes bytes in
                # flight; move uses a same-volume atomic rename when possible.
                self._update(task, phase="transferring", completed=0, current_title="")
                if transfer_mode == "keep":
                    self._update(
                        task,
                        staging_completed=task["staging_total"],
                        staging_bytes_completed=task["staging_bytes_total"],
                    )
                else:
                    for record in registered_entries:
                        if self._cancelled(task):
                            raise ImportCancelled()
                        source = Path(record["source"])
                        destination = Path(record["destination"])
                        if not source.is_file():
                            raise FileNotFoundError(f"Source file disappeared: {source}")
                        source_stat = source.stat()
                        expected_modified_ns = int(record["entry"].get("modified_ns") or 0)
                        if (
                            source_stat.st_size != int(record["entry"].get("size_bytes") or 0)
                            or (expected_modified_ns and source_stat.st_mtime_ns != expected_modified_ns)
                        ):
                            raise ImportPreviewError(f"Source file changed before transfer: {source}")
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        item = crud.get_item(db, record["item_id"])
                        item.availability = "transferring"
                        item.storage_mode = "managed"
                        atomic_move = False
                        partial = destination.with_name(f".{destination.name}.gaia-part-{job_id}")
                        try:
                            if destination.exists():
                                raise FileExistsError(f"Managed destination appeared after registration: {destination}")
                            same_volume = source.stat().st_dev == destination.parent.stat().st_dev
                            member_move = transfer_mode == "move" and preview["source_kind"] != "zip"
                            if member_move and same_volume:
                                os.replace(source, destination)
                                atomic_move = True
                                file_hash = None
                                copied(record["entry"]["filename"], int(record["entry"].get("size_bytes") or 0))
                            else:
                                partial_paths.append(partial)
                                file_hash = _copy_file_to_staging(
                                    source,
                                    partial,
                                    lambda count, title=record["entry"]["filename"]: copied(title, count),
                                )
                                after_copy_stat = source.stat()
                                if (
                                    partial.stat().st_size != source_stat.st_size
                                    or after_copy_stat.st_size != source_stat.st_size
                                    or after_copy_stat.st_mtime_ns != source_stat.st_mtime_ns
                                ):
                                    raise OSError(f"Transferred size does not match source: {source}")
                                os.replace(partial, destination)
                                partial_paths.remove(partial)
                            item = crud.get_item(db, record["item_id"])
                            item.absolute_path = str(destination.resolve())
                            item.storage_mode = "managed"
                            item.availability = "ready"
                            if file_hash:
                                item.file_hash = file_hash
                            attributes = dict(item.attributes or {})
                            import_attributes = dict(attributes.get("import") or {})
                            import_attributes.update(
                                state="ready",
                                ready_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                            )
                            attributes["import"] = import_attributes
                            item.attributes = attributes
                            db.commit()
                            if member_move and not atomic_move:
                                try:
                                    source.unlink()
                                except OSError as exc:
                                    with self._lock:
                                        task["warnings"].append(
                                            f"Vault copy is ready but the original could not be removed: {source}: {exc}"
                                        )
                            copied(record["entry"]["filename"], 0, True)
                        except Exception:
                            db.rollback()
                            if atomic_move and destination.exists() and not source.exists():
                                source.parent.mkdir(parents=True, exist_ok=True)
                                os.replace(destination, source)
                            raise

                    for result in results:
                        if isinstance(result, models.FolderItem):
                            refreshed = crud.get_item(db, result.id)
                            refreshed.availability = "ready"
                    db.commit()
                    if transfer_mode == "move" and preview["source_kind"] == "zip":
                        Path(preview["source_path"]).unlink()

                # Stage 3: analyze one ready file at a time. A failed analysis
                # never invalidates a successfully published or referenced file.
                self._update(task, phase="analyzing", completed=0, current_title="")
                from .routers.items import _analysis_update_request, _apply_item_update

                for record in registered_entries:
                    if self._cancelled(task):
                        raise ImportCancelled()
                    item = crud.get_item(db, record["item_id"])
                    path = Path(item.absolute_path)
                    try:
                        if not path.is_file():
                            item.availability = "missing"
                            db.commit()
                            raise FileNotFoundError(f"File is unavailable: {path}")
                        skip_analysis = task.get("skip_track_analysis", False) and item.type == "track"
                        if skip_analysis:
                            # The import preview has already inspected the path
                            # and established the selected type. Do not open or
                            # hash the media when the user explicitly opted out
                            # of track analysis.
                            analyzed_entry = _manifest_seed(preview, record["entry"], path.name, 0)
                            analyzed_entry.update(
                                title=Path(path.name).stem,
                                type="track",
                                streamable=True,
                            )
                        else:
                            analysis_seed = _manifest_seed(preview, record["entry"], path.name, 0)
                            analyzed_entry = collection_importer.analyze_manifest_entry(path.parent, analysis_seed)
                            # The type selected in the inspect table is authoritative.
                            analyzed_entry["type"] = item.type
                            if not item.file_hash:
                                item.file_hash = integrity.calculate_file_hash(str(path))
                        item.availability = "ready"
                        attributes = dict(item.attributes or {})
                        import_attributes = dict(attributes.get("import") or {})
                        import_attributes.update(
                            state="analysis_skipped" if skip_analysis else "complete",
                        )
                        if not skip_analysis:
                            import_attributes["analyzed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
                        attributes["import"] = import_attributes
                        item.attributes = attributes
                        if skip_analysis:
                            updated = item
                        else:
                            # Import-time analysis historically stored only the
                            # compact loop/BPM/key summary on the child. Keep the
                            # richer duration in the manifest while retaining that
                            # stable item-attribute shape for existing libraries.
                            item_analysis = dict(analyzed_entry)
                            item_analysis.pop("duration_seconds", None)
                            updated = _apply_item_update(item, _analysis_update_request(item, item_analysis), db)

                        if record["parent_id"] is not None:
                            parent = crud.get_item(db, record["parent_id"])
                            contents = []
                            for content in parent.contents or []:
                                if content.get("child_id") == record["item_id"]:
                                    replacement = {
                                        **content,
                                        **analyzed_entry,
                                        "index": record["content_index"],
                                        "relative_path": record["manifest_relative_path"],
                                        "child_id": record["item_id"],
                                        "storage_mode": updated.storage_mode,
                                        "availability": updated.availability,
                                    }
                                    contents.append(replacement)
                                else:
                                    contents.append(content)
                            crud.save_collection_contents(db, parent, contents)
                    except Exception as exc:
                        db.rollback()
                        item = crud.get_item(db, record["item_id"])
                        if item and item.availability != "missing":
                            item.availability = "ready"
                            attributes = dict(item.attributes or {})
                            import_attributes = dict(attributes.get("import") or {})
                            import_attributes["state"] = "analysis_failed"
                            attributes["import"] = import_attributes
                            item.attributes = attributes
                            db.commit()
                        with self._lock:
                            task["warnings"].append(
                                f"Automatic analysis failed for {record['entry']['filename']}: {exc}. The file is ready and can be analyzed later."
                            )
                    analyzed(record["entry"]["filename"])

                # Multitrack metadata describes the container as a whole and
                # must be computed after every stem is available.  Keep this
                # separate from per-file analysis so a failed stem analysis
                # cannot prevent the container from being imported.
                for result in results:
                    if not isinstance(result, models.MultitrackItem):
                        continue
                    try:
                        multitrack = multitrack_analyzer.analyze_multitrack_folder(
                            result.absolute_path,
                            recursive=False,
                        )
                        stems = multitrack.get("stems", []) or []
                        for stem in stems:
                            stem["absolute_path"] = str(
                                Path(result.absolute_path) / Path(stem.get("relative_path", ""))
                            )
                        result.stems = stems
                        # Multitrack stems are persisted as JSON (the public
                        # ``stems`` attribute is hydrated by CRUD on read).
                        result.stems_json = json.dumps(stems)
                        result.key = multitrack.get("key")
                        result.bpm = multitrack.get("bpm")
                        result.is_valid_length = bool(multitrack.get("is_valid_length", False))
                        result.length_variance = float(multitrack.get("length_variance") or 0.0)
                        if stems and not result.is_valid_length:
                            result.warnings = list(result.warnings or []) + [
                                f"Stem lengths differ by {result.length_variance:.4f} seconds."
                            ]
                            result.warnings_json = json.dumps(result.warnings)
                        db.commit()
                    except Exception as exc:
                        with self._lock:
                            task["warnings"].append(
                                f"Automatic multitrack analysis failed for {result.title}: {exc}. "
                                "The files were imported and can be analyzed later."
                            )

            if self._cancelled(task):
                raise ImportCancelled()
            self._update(task, phase="finalizing", current_title="")
            for item in results:
                vaults.log_import(
                    db,
                    vault.id,
                    preview["source_path"],
                    "imported",
                    f"background_import_{task['transfer_mode']}",
                    item.id,
                    detail=job_id,
                    commit=False,
                    flush=False,
                )
            db.commit()
            self._update(
                task,
                status="completed",
                phase="completed",
                completed=task["total"],
                registration_completed=task["registration_total"],
                staging_completed=task["staging_total"],
                staging_bytes_completed=task["staging_bytes_total"],
                processing_completed=task["processing_total"],
                imported=len(results),
                result_items=[_item_payload(crud.get_item(db, item.id)) for item in results],
            )
            self._append_log(task, "completed", imported=len(results), skipped=task["skipped"])
        except ImportCancelled:
            db.rollback()
            _remove_abandoned_rows(db, job_id)
            self._update(task, status="cancelled", phase="cancelled", current_title="")
            self._append_log(task, "cancelled")
        except Exception as exc:
            db.rollback()
            if not registration_committed:
                for result in reversed(results):
                    try:
                        db.delete(result)
                    except Exception:
                        pass
            self._update(task, status="failed", phase="failed", error=str(exc), failed=1, current_title="")
            self._append_log(task, "failed", error=str(exc))
        finally:
            for partial in partial_paths:
                try:
                    partial.unlink(missing_ok=True)
                except OSError:
                    pass
            db.close()


def cleanup_stale_staging() -> None:
    root = paths.vaults_directory()
    if not root.is_dir():
        return
    for candidate in root.rglob(".gaia-import-*.staging"):
        if candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)
    # A process interruption can leave an unpublished transfer beside its
    # destination. These names are generated exclusively by the importer and
    # are safe to remove on the next startup.
    for candidate in root.rglob(".*.gaia-part-*"):
        try:
            if candidate.is_dir():
                shutil.rmtree(candidate, ignore_errors=True)
            else:
                candidate.unlink(missing_ok=True)
        except OSError:
            pass


def _remove_abandoned_rows(db: Session, job_id: str | None = None) -> int:
    candidates = (
        db.query(models.Item)
        .filter(models.Item.availability.in_(("pending", "transferring")))
        .all()
    )
    candidates.sort(key=lambda item: item.parent_id is None)
    removed = 0
    for item in candidates:
        import_state = (item.attributes or {}).get("import") or {}
        if not import_state.get("job_id") or (job_id and import_state.get("job_id") != job_id):
            continue
        if Path(item.absolute_path).exists():
            continue
        db.delete(item)
        removed += 1
    if removed:
        db.commit()
    return removed


def cleanup_abandoned_import_rows() -> int:
    """Remove database-only placeholders left by an interrupted transfer.

    Registration is intentionally committed before file transfer. If the
    process is stopped afterwards, those rows are safe to discard only when
    their importer-owned destination is still absent. Ready rows and rows
    without an import job marker are never touched.
    """
    db = database.SessionLocal()
    removed = 0
    try:
        removed = _remove_abandoned_rows(db)
        return removed
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


import_job_manager = ImportJobManager()
