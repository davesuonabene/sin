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
FOLDER_TYPE_ASSIGNMENTS = {"type:multitrack": ("multitrack", None)}
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


def _unique_file_destination(parent: Path, filename: str) -> Path:
    """Return a collision-free path without wrapping a loose file in another folder."""
    candidate = parent / Path(filename).name
    if not candidate.exists():
        return candidate
    stem = Path(filename).stem or "asset"
    suffix = Path(filename).suffix
    counter = 2
    while True:
        candidate = parent / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
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
    artifact_reason = _artifact_reason(relative)
    return {
        "index": index,
        "node_id": f"file:{index}",
        "kind": "file",
        "filename": PurePosixPath(relative).name,
        "relative_path": relative,
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
        "folder_type_options": [{"value": "type:multitrack", "label": "Multitrack"}],
        "conflicts": _find_conflicts(db, vault, source, source_kind),
        "warnings": [],
    }


def _relative_is_within(relative_path: str, folder_path: str) -> bool:
    return folder_path == "." or relative_path == folder_path or relative_path.startswith(folder_path + "/")


def _topmost_folder_targets(assignments: dict[str, str]) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    for path, assignment in sorted(assignments.items(), key=lambda pair: (0 if pair[0] == "." else len(PurePosixPath(pair[0]).parts), pair[0])):
        if assignment and not any(_relative_is_within(path, parent) for parent, _ in targets):
            targets.append((path, assignment))
    return targets


def _resolve_folder_assignment(assignment: str, available_profiles: list[dict[str, Any]]) -> tuple[str, str | None]:
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
    progress: Callable[[str], None],
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
        shutil.copy2(source_file, target_file)
        progress(entry["filename"])


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


def _item_schema_for_manifest(entry: dict[str, Any], absolute_path: Path, vault_id: int, parent_id: int | None, forced_type: str):
    common = {
        "absolute_path": str(absolute_path.resolve()),
        "vault_id": vault_id,
        "parent_id": parent_id,
        "file_hash": integrity.calculate_file_hash(str(absolute_path)),
        "size_bytes": entry.get("size_bytes"),
        "mime_type": entry.get("mime_type"),
    }
    if forced_type == "sample":
        return schemas.SampleItemCreate(**common, bpm=entry.get("bpm"), key=entry.get("key"), is_loop=bool(entry.get("is_loop")))
    if forced_type == "track":
        return schemas.TrackItemCreate(**common)
    if forced_type == "audio":
        return schemas.AudioItemCreate(**common, attributes={"analysis": {"is_loop": bool(entry.get("is_loop")), "bpm": entry.get("bpm"), "key": entry.get("key")}})
    if forced_type == "midi":
        return schemas.MidiItemCreate(**common, bpm=entry.get("bpm"), key=entry.get("key"))
    return schemas.ItemCreate(**common, type=forced_type if forced_type in {"sequence", "item"} else "item")


def _index_children(db: Session, snapshot: dict[str, Any], vault_id: int, parent_id: int, job: dict[str, Any], prefix: str) -> None:
    root = Path(snapshot["absolute_path"])
    for entry in snapshot["contents"]:
        original = entry["relative_path"] if prefix == "." else (PurePosixPath(prefix) / entry["relative_path"]).as_posix()
        forced_type = _forced_item_type(original, entry, job)
        preview_entry = _preview_entry(original, job)
        item_schema = _item_schema_for_manifest(entry, root / Path(entry["relative_path"]), vault_id, parent_id, forced_type)
        if preview_entry and preview_entry.get("profile_role"):
            attributes = dict(item_schema.attributes or {})
            attributes.update(
                profile_role=preview_entry["profile_role"],
                profile_role_reason=preview_entry.get("profile_role_reason"),
            )
            item_schema.attributes = attributes
        child = crud.create_item(
            db,
            item_schema,
            commit=False,
        )
        if entry.get("tags"):
            crud.set_item_tags(db, child.id, entry["tags"], commit=False)
        entry["child_id"] = child.id
        entry["type"] = forced_type
        if preview_entry and preview_entry.get("profile_role"):
            entry["profile_role"] = preview_entry["profile_role"]


def _container_snapshot(preview: dict[str, Any], staging: Path, destination: Path, target: dict[str, Any]) -> dict[str, Any]:
    contents = collection_importer.build_manifest(staging)
    analysis: dict[str, Any] = {}
    warnings: list[str] = []
    if target["container_type"] == "multitrack":
        analysis = multitrack_analyzer.analyze_multitrack_folder(str(staging), recursive=False)
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
    crud.save_collection_contents(db, result, snapshot["contents"], commit=False)
    tags = _collection_tags(snapshot["contents"])
    if tags:
        crud.set_item_tags(db, result.id, tags, commit=False)
    return result


def _item_payload(item: models.Item) -> dict[str, Any]:
    return {
        "id": item.id,
        "type": item.type,
        "display_type": item.attributes.get("profile_label") or item.type,
        "title": getattr(item, "title", None) or Path(item.absolute_path).name,
        "absolute_path": item.absolute_path,
        "size_bytes": item.size_bytes,
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
        record = {
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "event": event,
            "job_id": task["job_id"], "preview_id": task["preview"]["preview_id"],
            "source_path": task["preview"]["source_path"], "vault_id": task["preview"]["vault_id"],
            "source_fingerprint": task["preview"]["source_fingerprint"],
            "folder_assignments": task["folder_assignments"],
            "item_types": task["item_types"],
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
        valid_folders = {node["relative_path"] for node in preview["nodes"] if node["kind"] == "folder"}
        folder_assignments = {path: value for path, value in request.folder_assignments.items() if value}
        if not set(folder_assignments).issubset(valid_folders):
            raise ImportPreviewError("A folder classification no longer belongs to this preview")
        targets = []
        for relative_path, assignment in _topmost_folder_targets(folder_assignments):
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
        item_types = {str(index): value for index, value in request.item_types.items()}
        for entry in preview["entries"]:
            selected = item_types.get(str(entry["index"]), entry["type"])
            if selected not in entry["allowed_types"]:
                raise ImportPreviewError(f"{entry['relative_path']} cannot be assigned type {selected}")
            item_types[str(entry["index"])] = selected
        included_entries = [entry for entry in preview["entries"] if entry["index"] not in excluded_indexes]
        if not included_entries:
            raise ImportPreviewError("Keep at least one file in the import")
        if preview["conflicts"] and request.conflict_action is None:
            raise ImportPreviewError("Choose how to handle the conflict shown in the preview")
        covered = {entry["index"] for entry in included_entries if any(_relative_is_within(entry["relative_path"], target["relative_path"]) for target in targets)}
        loose = [entry["index"] for entry in included_entries if entry["index"] not in covered]
        job_id = uuid.uuid4().hex
        task = {
            "job_id": job_id, "status": "queued", "phase": "queued", "current_title": "",
            "total": len(included_entries), "completed": 0, "imported": 0, "skipped": 0,
            "excluded": len(excluded_indexes), "failed": 0, "warnings": [], "error": None, "result_items": [],
            "log_path": str(self._log_path(job_id)), "created_epoch": time.time(), "cancel_requested": False,
            "preview": preview, "targets": targets, "loose_indexes": loose,
            "folder_assignments": folder_assignments, "item_types": item_types,
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
        staging_paths: list[Path] = []
        destinations: list[Path] = []
        results: list[models.Item] = []
        try:
            self._update(task, status="running", phase="revalidating")
            self._append_log(task, "started")
            if not self._verify_preview(task):
                self._update(task, status="stale", phase="stale", error="Source changed, moved, or disappeared after preview.")
                self._append_log(task, "preview_invalidated", error=task["error"])
                return
            if preview["conflicts"] and task["conflict_action"] == "skip":
                self._update(task, status="completed", phase="completed", skipped=task["total"])
                self._append_log(task, "completed", reason="source_conflict_skipped")
                return
            vault = _vault_for_request(db, preview["vault_id"])
            store = vaults.vault_store(vault).resolve()

            def copied(title: str) -> None:
                if self._cancelled(task):
                    raise ImportCancelled()
                with self._lock:
                    task["completed"] += 1
                    task["current_title"] = title

            with _materialized_root(preview) as root:
                for target_number, target in enumerate(task["targets"]):
                    entries = [
                        entry for entry in preview["entries"]
                        if entry["index"] not in task["excluded_indexes"]
                        and _relative_is_within(entry["relative_path"], target["relative_path"])
                    ]
                    staging = store / f".gaia-import-{job_id}-{target_number}.staging"
                    staging.mkdir(parents=True, exist_ok=False)
                    staging_paths.append(staging)
                    self._update(task, phase="staging", current_title=target["title"])
                    _copy_entries(root, staging, entries, target["relative_path"], lambda: self._cancelled(task), copied)
                    destination = _unique_directory(store, target["title"])
                    self._update(task, phase="analyzing", current_title=target["title"])
                    snapshot = _container_snapshot(preview, staging, destination, target)
                    os.replace(staging, destination)
                    staging_paths.remove(staging)
                    destinations.append(destination)
                    results.append(_create_container(db, snapshot, vault, task, target))

                loose = [entry for entry in preview["entries"] if entry["index"] in task["loose_indexes"]]
                if loose:
                    files_root = store / "files"
                    files_root.mkdir(parents=True, exist_ok=True)
                    staging = store / f".gaia-import-{job_id}-files.staging"
                    staging.mkdir(parents=True, exist_ok=False)
                    staging_paths.append(staging)
                    _copy_entries(root, staging, loose, ".", lambda: self._cancelled(task), copied)
                    for entry in loose:
                        forced_type = task["item_types"][str(entry["index"])]
                        analyzed_entry = collection_importer.analyze_manifest_entry(staging, dict(entry))
                        staged_file = staging / Path(analyzed_entry["relative_path"])
                        target_path = _unique_file_destination(files_root, analyzed_entry["filename"])
                        os.replace(staged_file, target_path)
                        destinations.append(target_path)
                        item = _item_schema_for_manifest(analyzed_entry, target_path, vault.id, None, forced_type)
                        attributes = dict(item.attributes or {})
                        if preview["source_kind"] == "file":
                            original_source = preview["source_path"]
                        elif preview["source_kind"] == "zip":
                            original_source = f"{preview['source_path']}::{entry['relative_path']}"
                        else:
                            original_source = str(Path(preview["source_path"]) / Path(entry["relative_path"]))
                        attributes["import"] = {"job_id": job_id, "source_path": original_source, "imported_at": dt.datetime.now(dt.timezone.utc).isoformat()}
                        item.attributes = attributes
                        results.append(crud.create_item(db, item, commit=False))
                    shutil.rmtree(staging, ignore_errors=True)
                    staging_paths.remove(staging)
            if self._cancelled(task):
                raise ImportCancelled()
            self._update(task, phase="finalizing", current_title="")
            for item in results:
                vaults.log_import(
                    db,
                    vault.id,
                    preview["source_path"],
                    "imported",
                    "background_import",
                    item.id,
                    detail=job_id,
                    commit=False,
                )
            db.commit()
            for item in results:
                db.refresh(item)
                crud._populate_item_fields(item)
            self._update(task, status="completed", phase="completed", imported=len(results), result_items=[_item_payload(item) for item in results])
            self._append_log(task, "completed", imported=len(results), skipped=task["skipped"])
        except ImportCancelled:
            db.rollback()
            for destination in destinations:
                _remove_managed_path(destination)
            self._update(task, status="cancelled", phase="cancelled", current_title="")
            self._append_log(task, "cancelled")
        except Exception as exc:
            db.rollback()
            for destination in destinations:
                _remove_managed_path(destination)
            self._update(task, status="failed", phase="failed", error=str(exc), failed=1, current_title="")
            self._append_log(task, "failed", error=str(exc))
        finally:
            for staging in staging_paths:
                shutil.rmtree(staging, ignore_errors=True)
            db.close()


def cleanup_stale_staging() -> None:
    root = paths.vaults_directory()
    if not root.is_dir():
        return
    for candidate in root.rglob(".gaia-import-*.staging"):
        if candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)


import_job_manager = ImportJobManager()
