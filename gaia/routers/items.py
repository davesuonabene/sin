from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import List
import os
import re
from pathlib import Path
import shutil
import tempfile
import uuid
import zipfile
import json
import datetime
from collections import Counter

from .. import (
    collection_importer,
    crud,
    schemas,
    models,
    database,
    integrity,
    text_analyzer,
    midi_parser,
    multitrack_analyzer,
    project_service,
    type_registry,
    vaults,
)
import threading
from concurrent.futures import ThreadPoolExecutor

router = APIRouter(
    prefix="/items",
    tags=["items"],
)

class BatchAnalysisTaskManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._tasks = {}
        self._executor = ThreadPoolExecutor(max_workers=4)

    def create_task(self, targets: list, children_found: int = 0) -> str:
        task_id = uuid.uuid4().hex
        task_info = {
            "task_id": task_id,
            "total": len(targets),
            "children_found": children_found,
            "completed": 0,
            "failed": 0,
            "current_title": "",
            "status": "running",
            "updated_items": [],
            "cancelled": False,
        }
        with self._lock:
            self._tasks[task_id] = task_info

        self._executor.submit(self._run_batch, task_id, targets)
        return task_id

    def get_task(self, task_id: str) -> dict | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            return {
                **task,
                "updated_items": list(task["updated_items"])
            }

    def cancel_task(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task["cancelled"] = True
                task["status"] = "cancelled"
                return True
        return False

    def _run_batch(self, task_id: str, targets: list):
        db = database.SessionLocal()
        analyzed_collection_ids = set()
        try:
            for target in targets:
                with self._lock:
                    task = self._tasks.get(task_id)
                    if not task or task.get("cancelled"):
                        break

                kind = target.get("kind", "item")
                item_id = target.get("item_id")
                content_index = target.get("content_index")

                try:
                    db_item = crud.get_item(db, item_id=item_id)
                    if not db_item:
                        with self._lock:
                            task["failed"] += 1
                            task["completed"] += 1
                        continue

                    if kind == "content" and content_index is not None and isinstance(db_item, models.FolderItem):
                        content, _ = _get_collection_content(db_item, content_index)
                        title = content.get("title") or content.get("filename", "")
                        with self._lock:
                            task["current_title"] = title

                        analyzed = _analyze_collection_content(db_item, content)
                        _propagate_content_analysis(db, db_item, analyzed)
                        contents = [analyzed if entry.get("index") == content_index else entry for entry in (db_item.contents or [])]
                        crud.save_collection_contents(db, db_item, contents)
                        analyzed_collection_ids.add(db_item.id)

                        with self._lock:
                            task["completed"] += 1
                            task["updated_items"].append({
                                "kind": "content",
                                "item_id": item_id,
                                "content_index": content_index,
                                "content": analyzed,
                            })
                    elif isinstance(db_item, models.FolderItem):
                        # This fallback keeps API callers safe when they send a
                        # container target without first expanding its children.
                        title = db_item.title or Path(db_item.absolute_path).name
                        with self._lock:
                            task["current_title"] = title
                        contents = _analyze_collection_contents(db, db_item)
                        _finalize_collection_analysis(db, db_item, contents)
                        with self._lock:
                            task["completed"] += 1
                    else:
                        title = Path(db_item.absolute_path).name
                        with self._lock:
                            task["current_title"] = title

                        if os.path.isfile(db_item.absolute_path):
                            duration = collection_importer._audio_metadata(Path(db_item.absolute_path)).get("duration_seconds")
                            analysis = text_analyzer.analyze_path(db_item.absolute_path, duration_seconds=duration)
                            if db_item.type == "midi":
                                midi_values = midi_parser.parse_midi_file(db_item.absolute_path)
                                analysis["bpm"] = midi_values.get("bpm") or analysis.get("bpm")
                                role = text_analyzer.key_role(
                                    db_item.absolute_path, "midi", analysis.get("tags", [])
                                )
                                analysis["key"] = text_analyzer.normalize_key_for_role(
                                    midi_values.get("key") or analysis.get("key"), role
                                )

                            requested_type = db_item.type
                            if db_item.type in {"sample", "loop", "one_shot", "audio"}:
                                requested_type = analysis["type"]
                            bpm = analysis.get("bpm") if requested_type in {"loop", "midi"} else None
                            key = analysis.get("key") if requested_type in {"sample", "loop", "one_shot", "midi"} or db_item.type in {"sample", "loop", "one_shot", "midi"} else None

                            values = {"type": requested_type, "tags": analysis.get("tags", [])}
                            if requested_type in {"loop", "midi"}:
                                values["bpm"] = bpm
                            if requested_type in {"sample", "loop", "one_shot", "midi"} or db_item.type in {"sample", "loop", "one_shot", "midi"}:
                                values["key"] = key

                            req = schemas.ItemUpdate(**values)
                            updated_db_item = _apply_item_update(db_item, req, db)

                            with self._lock:
                                task["completed"] += 1
                                task["updated_items"].append({
                                    "kind": "item",
                                    "item_id": item_id,
                                    "item": {
                                        "id": updated_db_item.id,
                                        "bpm": getattr(updated_db_item, "bpm", None),
                                        "key": getattr(updated_db_item, "key", None),
                                        "type": updated_db_item.type,
                                        "tags": [t.name for t in getattr(updated_db_item, "tags", [])]
                                    }
                                })
                        else:
                            with self._lock:
                                task["failed"] += 1
                                task["completed"] += 1

                except Exception as exc:
                    with self._lock:
                        task["failed"] += 1
                        task["completed"] += 1

            with self._lock:
                task = self._tasks.get(task_id)
                cancelled = not task or task.get("cancelled")

            if not cancelled:
                # Content targets update their child rows incrementally. Once
                # all of a pack's children are done, refresh its derived type
                # and tags from those updated rows.
                for collection_id in analyzed_collection_ids:
                    collection = crud.get_item(db, collection_id)
                    if isinstance(collection, models.FolderItem):
                        _finalize_collection_analysis(db, collection)

            with self._lock:
                task = self._tasks.get(task_id)
                if task and task["status"] != "cancelled":
                    task["status"] = "completed"
                    task["current_title"] = ""
        finally:
            db.close()

batch_task_manager = BatchAnalysisTaskManager()

def _vault_for_request(db: Session, vault_id: int | None):
    if vault_id is None:
        return vaults.ensure_default_vault(db)
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")
    return vault


SEQUENCE_CHANNEL_KEYS = ("on", "probability", "offset", "velocity", "subdivisions")


def _validated_sequence_document(req: schemas.SequenceSaveRequest) -> dict:
    name = req.name.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", name):
        raise HTTPException(
            status_code=400,
            detail="Sequence names must be 1-64 letters, numbers, spaces, underscores, or hyphens.",
        )
    if req.format != "sin-sequence" or req.version != 1:
        raise HTTPException(status_code=400, detail="Unsupported sequence format or version")
    if not req.channels:
        raise HTTPException(status_code=400, detail="A sequence needs at least one channel")

    normalized_channels = []
    for channel in req.channels:
        if not isinstance(channel, dict):
            raise HTTPException(status_code=400, detail="Each sequence channel must be an object")
        normalized = {}
        step_count = None
        for key in SEQUENCE_CHANNEL_KEYS:
            values = channel.get(key)
            if not isinstance(values, list) or not values:
                raise HTTPException(status_code=400, detail=f"Sequence channel is missing {key} values")
            if len(values) > 256:
                raise HTTPException(status_code=400, detail="Sequences may contain at most 256 steps")
            if step_count is None:
                step_count = len(values)
            elif len(values) != step_count:
                raise HTTPException(status_code=400, detail="All parameter arrays in a channel must have equal length")
            if not all(isinstance(value, (int, float, bool)) for value in values):
                raise HTTPException(status_code=400, detail=f"Sequence {key} values must be numeric")
            normalized[key] = values
        normalized_channels.append(normalized)

    return {
        "format": "sin-sequence",
        "version": 1,
        "name": name,
        "channels": normalized_channels,
    }


@router.post("/save-sequence", response_model=schemas.Item)
def save_sequence(req: schemas.SequenceSaveRequest, db: Session = Depends(database.get_db)):
    """Persist a SIN sequence in GAIA's default vault and register it as an asset."""
    document = _validated_sequence_document(req)
    vault = vaults.ensure_default_vault(db)
    sequence_dir = vaults.vault_store(vault) / "sequences"
    sequence_dir.mkdir(parents=True, exist_ok=True)
    target = sequence_dir / f"{document['name']}.seq"
    temporary = sequence_dir / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(json.dumps(document, indent=2), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()

    absolute_path = str(target.resolve())
    file_hash = integrity.calculate_file_hash(absolute_path)
    size_bytes = target.stat().st_size
    existing = crud.get_item_by_path(db, absolute_path=absolute_path, vault_id=vault.id)
    if existing:
        existing.file_hash = file_hash
        existing.size_bytes = size_bytes
        existing.mime_type = "application/x-sin-sequence+json"
        existing.updated_at = datetime.datetime.utcnow()
        db.commit()
        db.refresh(existing)
        vaults.log_import(db, vault.id, absolute_path, "updated", "sequence_saved", existing.id)
        return existing

    item = schemas.ItemCreate(
        absolute_path=absolute_path,
        vault_id=vault.id,
        file_hash=file_hash,
        size_bytes=size_bytes,
        mime_type="application/x-sin-sequence+json",
        type="sequence",
    )
    result = crud.create_item(db, item)
    vaults.log_import(db, vault.id, absolute_path, "imported", "sequence_saved", result.id)
    return result


def _index_child_items_from_snapshot(db: Session, snapshot: dict, vault_id: int, parent_id: int | None = None):
    root_path = Path(snapshot["absolute_path"])
    target_vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    for entry in snapshot.get("contents", []):
        rel_path = entry.get("relative_path")
        if not rel_path:
            continue
        child_abs_path = str((root_path / rel_path).resolve())
        existing = db.query(models.Item).filter(models.Item.absolute_path == child_abs_path).first()
        if existing:
            if target_vault and target_vault not in existing.vaults:
                existing.vaults.append(target_vault)
            if existing.vault_id is None:
                existing.vault_id = vault_id
            if parent_id and getattr(existing, "parent_id", None) is None:
                existing.parent_id = parent_id
            entry["child_id"] = existing.id
            db.flush()
            continue

        entry_type = entry.get("type", "sample")
        bpm = entry.get("bpm")
        key = entry.get("key")
        size = entry.get("size_bytes")
        mime = entry.get("mime_type")
        file_hash = integrity.calculate_file_hash(child_abs_path)

        if entry_type == "loop":
            item_data = schemas.LoopSampleItemCreate(absolute_path=child_abs_path, vault_id=vault_id, parent_id=parent_id, file_hash=file_hash, size_bytes=size, mime_type=mime, bpm=bpm, key=key)
        elif entry_type == "one_shot":
            item_data = schemas.OneShotSampleItemCreate(absolute_path=child_abs_path, vault_id=vault_id, parent_id=parent_id, file_hash=file_hash, size_bytes=size, mime_type=mime, key=key)
        elif entry_type in {"sample", "audio"}:
            item_data = schemas.SampleItemCreate(absolute_path=child_abs_path, vault_id=vault_id, parent_id=parent_id, file_hash=file_hash, size_bytes=size, mime_type=mime, key=key)
        elif entry_type == "midi":
            item_data = schemas.MidiItemCreate(absolute_path=child_abs_path, vault_id=vault_id, parent_id=parent_id, file_hash=file_hash, size_bytes=size, mime_type=mime, bpm=bpm, key=key)
        else:
            item_data = schemas.ItemCreate(absolute_path=child_abs_path, vault_id=vault_id, parent_id=parent_id, file_hash=file_hash, size_bytes=size, mime_type=mime, type="item")

        child_item = crud.create_item(db, item_data, commit=False)
        if entry.get("tags"):
            crud.set_item_tags(db, child_item.id, entry.get("tags"), commit=False)
        entry["child_id"] = child_item.id


def _create_snapshot_item(
    source_path: str,
    db: Session,
    vault_id: int | None = None,
    expected_type: str = "auto",
    analysis_types: list[str] | None = None,
):
    source = collection_importer.canonical_source_path(source_path)
    vault = _vault_for_request(db, vault_id)
    existing = crud.get_collection_by_source(db, source, vault.id)
    if existing:
        vaults.log_import(db, vault.id, source, "duplicate", "skipped_duplicate", existing.id, "This source is already imported in this vault")
        return existing

    try:
        snapshot = collection_importer.snapshot_collection_source(
            source,
            asset_store=vaults.vault_store(vault),
            expected_type=expected_type,
            analysis_types=analysis_types,
        )
    except collection_importer.NoMatchingCollectionError:
        raise
    except Exception as exc:
        vaults.log_import(db, vault.id, source, "failed", "none", detail=str(exc))
        raise
    if snapshot["type"] == "multitrack":
        item = schemas.MultitrackItemCreate(
            absolute_path=snapshot["absolute_path"],
            vault_id=vault.id,
            size_bytes=snapshot["size_bytes"],
            mime_type=snapshot["mime_type"],
            type="multitrack",
            title=snapshot["title"],
            source_kind=snapshot["source_kind"],
            source_path=snapshot["source_path"],
            contents=snapshot["contents"],
            stems=snapshot["stems"],
            key=snapshot["key"],
            bpm=snapshot["bpm"],
            is_valid_length=snapshot["is_valid_length"],
            length_variance=snapshot["length_variance"],
            warnings=snapshot["warnings"],
        )
    else:
        item_schema = {
            "sample_pack": schemas.SamplePackItemCreate,
            "live_recording_project": schemas.LiveRecordingProjectItemCreate,
        }.get(snapshot["type"], schemas.CollectionItemCreate)
        item = item_schema(
            absolute_path=snapshot["absolute_path"],
            vault_id=vault.id,
            size_bytes=snapshot["size_bytes"],
            mime_type=snapshot["mime_type"],
            type=snapshot["type"],
            title=snapshot["title"],
            source_kind=snapshot["source_kind"],
            source_path=snapshot["source_path"],
            contents=snapshot["contents"],
            warnings=snapshot["warnings"],
        )
    try:
        result = crud.create_item(db, item, commit=False)
        _index_child_items_from_snapshot(db, snapshot, vault.id, parent_id=result.id)
        result = crud.save_collection_contents(
            db,
            result,
            snapshot["contents"],
            commit=False,
        )
        inferred_tags = _collection_tags(snapshot["contents"], result.type)
        if inferred_tags:
            result = crud.set_item_tags(db, result.id, inferred_tags, commit=False)
        db.commit()
        db.refresh(result)
        result = crud._populate_item_fields(result)
    except Exception as exc:
        db.rollback()
        if snapshot.get("managed_copy_created"):
            destination = Path(snapshot["absolute_path"])
            if destination.is_dir():
                shutil.rmtree(destination, ignore_errors=True)
            elif destination.exists():
                destination.unlink(missing_ok=True)
        vaults.log_import(db, vault.id, source, "failed", "rolled_back", detail=str(exc))
        raise
    vaults.log_import(db, vault.id, source, "imported", "snapshot_imported", result.id)
    return result


def _unique_file_destination(folder: Path, filename: str) -> Path:
    destination = folder / filename
    if not destination.exists():
        return destination
    stem = Path(filename).stem or "asset"
    suffix = Path(filename).suffix
    counter = 2
    while True:
        destination = folder / f"{stem}_{counter}{suffix}"
        if not destination.exists():
            return destination
        counter += 1


def _import_standalone_file(source_path: str, db: Session, vault_id: int | None = None):
    source = Path(collection_importer.canonical_source_path(source_path)).resolve()
    if not source.is_file() or source.suffix.lower() == ".zip":
        raise ValueError("Select a regular file")
    vault = _vault_for_request(db, vault_id)

    existing = crud.get_item_by_path(db, str(source), vault_id=vault.id)
    if existing:
        vaults.log_import(db, vault.id, str(source), "duplicate", "skipped_duplicate", existing.id)
        return existing

    store = vaults.vault_store(vault).resolve()
    managed_source = source == store or store in source.parents
    copied_path = None
    if managed_source:
        destination = source
    else:
        files_root = store / "files"
        files_root.mkdir(parents=True, exist_ok=True)
        destination = _unique_file_destination(files_root, source.name)
        staging = files_root / f".{uuid.uuid4().hex}.staging"
        try:
            shutil.copy2(source, staging)
            os.replace(staging, destination)
            copied_path = destination
        finally:
            staging.unlink(missing_ok=True)

    try:
        item_schema, tags = project_service.file_schema_for_path(destination, vault.id)
        result = crud.create_item(db, item_schema, commit=False)
        if tags:
            result = crud.set_item_tags(db, result.id, tags, commit=False)
        db.commit()
        db.refresh(result)
        result = crud._populate_item_fields(result)
    except Exception as exc:
        db.rollback()
        if copied_path:
            copied_path.unlink(missing_ok=True)
        vaults.log_import(db, vault.id, str(source), "failed", "rolled_back", detail=str(exc))
        raise

    vaults.log_import(db, vault.id, str(source), "imported", "file_imported", result.id)
    return result


def _import_loose_items(source: Path, db: Session, vault_id: int | None = None):
    """Import every file below a folder/archive without creating a container."""
    vault = _vault_for_request(db, vault_id)
    store = vaults.vault_store(vault).resolve()
    source = source.resolve()
    if source == store or source in store.parents:
        raise ValueError("Cannot import the GAIA asset store or a folder that contains it")

    temporary_directory = None
    scan_root = source
    try:
        if source.is_file() and zipfile.is_zipfile(source):
            temporary_directory = tempfile.TemporaryDirectory(prefix="gaia-import-")
            scan_root = Path(temporary_directory.name)
            collection_importer._extract_zip(source, scan_root)
        elif not source.is_dir():
            raise ValueError("Select a folder or a .zip archive")

        imported_items = []
        skipped = 0
        for root, dirs, files in os.walk(scan_root, topdown=True, followlinks=False):
            dirs[:] = sorted(
                directory for directory in dirs
                if not (Path(root) / directory).is_symlink()
            )
            for filename in sorted(files):
                file_path = Path(root) / filename
                if file_path.is_symlink():
                    continue
                existing = crud.get_item_by_path(db, str(file_path.resolve()), vault_id=vault.id)
                if existing:
                    skipped += 1
                    vaults.log_import(
                        db, vault.id, str(file_path), "duplicate", "skipped_duplicate",
                        existing.id, "This file is already registered in this vault",
                    )
                    continue
                imported_items.append(_import_standalone_file(str(file_path), db, vault.id))

        return {
            "type": "batch",
            "title": source.stem if source.is_file() else source.name,
            "absolute_path": str(source),
            "imported": len(imported_items),
            "skipped": skipped,
            "size_bytes": sum(int(item.size_bytes or 0) for item in imported_items),
            "items": imported_items,
            "warnings": [],
        }
    finally:
        if temporary_directory:
            temporary_directory.cleanup()


def _import_asset(req: schemas.CollectionImportRequest, db: Session):
    expectation = type_registry.validate_import_expectation(req.expected_type)
    allowed_types = type_registry.resolve_analysis_types(req.analysis_types, expectation)
    source = Path(collection_importer.canonical_source_path(req.source_path))
    if source.is_file() and not source.suffix.lower() == ".zip":
        if expectation not in {"auto", "files"}:
            raise ValueError(f"A file cannot be imported as {expectation}")
        return _import_standalone_file(str(source), db, req.vault_id)
    if not allowed_types:
        return _import_loose_items(source, db, req.vault_id)
    if expectation == "files":
        raise ValueError("The files mode expects a single file path")
    try:
        return _create_snapshot_item(
            str(source), db, req.vault_id, expectation, req.analysis_types
        )
    except collection_importer.NoMatchingCollectionError:
        if not req.fallback_to_files:
            raise
        return _import_loose_items(source, db, req.vault_id)


def _collection_tags(contents: list[dict], item_type: str) -> list[str]:
    media = [entry for entry in contents if entry.get("type") in {"sample", "loop", "one_shot", "midi"}]
    counts = Counter(tag for entry in media for tag in entry.get("tags", []))
    threshold = max(2, round(len(media) * 0.03))
    tags = [tag for tag, count in counts.most_common() if count >= threshold and tag not in {"Loop", "One shot", "MIDI"}][:6]
    if item_type == "sample_pack":
        tags.insert(0, "Sample pack")
    return tags


def _get_collection_content(db_item, content_index: int):
    if not isinstance(db_item, models.FolderItem):
        raise HTTPException(status_code=400, detail="Item is not a collection")
    contents = getattr(db_item, "contents", []) or []
    content = next((entry for entry in contents if entry.get("index") == content_index), None)
    if not content:
        raise HTTPException(status_code=404, detail="Collection content not found")

    relative_path = content.get("relative_path", "")
    candidate = os.path.abspath(os.path.join(db_item.absolute_path, relative_path))
    collection_root = os.path.abspath(db_item.absolute_path)
    if not os.path.isfile(candidate):
        stripped_rel = re.sub(r'^extracted/[^/]+/', '', relative_path)
        alt_path = os.path.abspath(os.path.join(collection_root, stripped_rel))
        if os.path.isfile(alt_path):
            candidate = alt_path

    if os.path.commonpath([collection_root, candidate]) != collection_root or not os.path.isfile(candidate):
        raise HTTPException(status_code=404, detail="Collection content is missing on disk")
    return content, candidate


def _stage_managed_collection_snapshot(item, db: Session) -> tuple[Path, Path] | None:
    """Move a managed collection snapshot aside until its database row is removed."""
    if not isinstance(item, models.FolderItem):
        return None

    vault = _vault_for_request(db, item.vault_id)
    snapshot = Path(item.absolute_path).resolve()
    store = vaults.vault_store(vault).resolve()
    if snapshot == store:
        # A malformed legacy row must never make the asset-store root deletable.
        return None
    try:
        snapshot.relative_to(store)
    except ValueError:
        # Only GAIA-managed snapshots may be removed from disk. Legacy/external
        # collection paths lose their record but leave the original files intact.
        return None

    if not snapshot.exists():
        return None

    staged = snapshot.parent / f".deleting-{item.id}-{uuid.uuid4().hex}"
    os.replace(snapshot, staged)
    return snapshot, staged


def _remove_staged_snapshot(staged: Path) -> None:
    if staged.is_dir():
        shutil.rmtree(staged, ignore_errors=True)
    elif staged.exists():
        staged.unlink(missing_ok=True)


def _clean_tags(values: list[str] | None) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in (values or []) if value and value.strip()))[:24]


def _request_fields(req) -> set[str]:
    return set(req.model_fields_set) if hasattr(req, "model_fields_set") else set(req.__fields_set__)


def _apply_item_update(db_item, req: schemas.ItemUpdate, db: Session):
    fields = _request_fields(req)
    requested_type = req.type if "type" in fields else db_item.type
    if requested_type and requested_type != db_item.type:
        if db_item.type in {"sample", "loop", "one_shot"} and requested_type in {"sample", "loop", "one_shot"}:
            db_item = crud.reclassify_sample(db, db_item.id, requested_type)
        elif db_item.type in {"collection", "sample_pack"} and requested_type in {"collection", "sample_pack"}:
            db_item = crud.reclassify_collection(db, db_item.id, requested_type)
        else:
            raise HTTPException(status_code=400, detail="This asset cannot be changed to the selected type")

    if "title" in fields:
        if not isinstance(db_item, models.FolderItem):
            raise HTTPException(status_code=400, detail="Only collection display titles can be edited")
        db_item.title = (req.title or "").strip() or Path(db_item.absolute_path).name
    if "bpm" in fields:
        if req.bpm is not None and not 20 <= req.bpm <= 400:
            raise HTTPException(status_code=400, detail="BPM must be between 20 and 400")
        if not hasattr(db_item, "bpm"):
            if req.bpm is not None and getattr(db_item, "type", None) in {"sample", "one_shot", "audio"}:
                db_item = crud.reclassify_sample(db, db_item.id, "loop")
            else:
                raise HTTPException(status_code=400, detail="This asset type does not store BPM")
        if db_item and hasattr(db_item, "bpm"):
            db_item.bpm = req.bpm
    if "key" in fields:
        if not hasattr(db_item, "key"):
            raise HTTPException(status_code=400, detail="This asset type does not store a musical key")
        db_item.key = (req.key or "").strip() or None

    if fields.intersection({"title", "bpm", "key"}):
        db.commit()
        db.refresh(db_item)
    if "tags" in fields:
        db_item = crud.set_item_tags(db, db_item.id, _clean_tags(req.tags))
    return crud.get_item(db, db_item.id)


def _analyze_collection_content(db_item, content: dict) -> dict:
    relative_path = content.get("relative_path", "")
    candidate = Path(db_item.absolute_path) / Path(relative_path)
    if not candidate.is_file():
        return content
    return collection_importer.analyze_manifest_entry(Path(db_item.absolute_path), content)


def _relative_content_path(root: str, path: str) -> str:
    """Return a normalized relative path for matching a manifest entry to a child row."""
    try:
        return os.path.normcase(os.path.normpath(os.path.relpath(path, root)))
    except ValueError:
        return os.path.normcase(os.path.normpath(path))


def _propagate_content_analysis(db: Session, db_item: models.FolderItem, analyzed: dict) -> None:
    """Copy freshly analyzed manifest metadata to its indexed child item."""
    children = list(getattr(db_item, "children", []) or [])
    child_by_id = {child.id: child for child in children}
    child_by_path = {
        _relative_content_path(db_item.absolute_path, child.absolute_path): child
        for child in children
    }

    child = child_by_id.get(analyzed.get("child_id"))
    if child is None:
        relative_path = analyzed.get("relative_path")
        if relative_path:
            child = child_by_path.get(
                os.path.normcase(os.path.normpath(relative_path))
            )
    if child is None:
        return

    analyzed_type = analyzed.get("type")
    sample_types = {"sample", "loop", "one_shot"}
    target_type = analyzed_type if analyzed_type in sample_types | {"midi"} else child.type

    if target_type != child.type:
        if child.type in sample_types and target_type in sample_types:
            child = crud.reclassify_sample(db, child.id, target_type)
        else:
            # Non-media children are represented by the generic ``item`` type,
            # and cannot be reclassified from a manifest's ``file`` type.
            target_type = child.type

    values = {"tags": analyzed.get("tags", [])}
    if target_type in {"loop", "midi"} and hasattr(child, "bpm"):
        values["bpm"] = analyzed.get("bpm")
    if target_type in sample_types | {"midi"} and hasattr(child, "key"):
        values["key"] = analyzed.get("key")
    _apply_item_update(child, schemas.ItemUpdate(**values), db)


def _analyze_collection_contents(db: Session, db_item: models.FolderItem) -> list[dict]:
    """Analyze every collection entry and keep indexed child rows in sync."""
    analyzed_contents = []
    for entry in (db_item.contents or []):
        analyzed = _analyze_collection_content(db_item, entry)
        _propagate_content_analysis(db, db_item, analyzed)
        analyzed_contents.append(analyzed)
    return analyzed_contents


def _finalize_collection_analysis(db: Session, db_item: models.FolderItem, contents: list[dict] | None = None):
    """Persist collection analysis and refresh its derived type and tags."""
    contents = list(contents if contents is not None else (db_item.contents or []))
    db_item = crud.save_collection_contents(db, db_item, contents)
    inferred_type = collection_importer.inferred_collection_type(contents, db_item.type == "multitrack")
    if db_item.type in {"collection", "sample_pack"} and inferred_type != db_item.type:
        db_item = crud.reclassify_collection(db, db_item.id, inferred_type)
    return crud.set_item_tags(db, db_item.id, _collection_tags(contents, db_item.type))


def _expand_collection_analysis_targets(db: Session, targets: list[dict]) -> tuple[list[dict], int]:
    """Expand selected pack targets into their individual child analyses."""
    expanded = []
    seen = set()
    children_found = 0

    def add_target(target: dict) -> bool:
        key = (target.get("kind", "item"), target.get("item_id"), target.get("content_index"))
        if key in seen:
            return False
        seen.add(key)
        expanded.append(target)
        return True

    for target in targets:
        if target.get("kind", "item") != "item":
            add_target(target)
            continue
        db_item = crud.get_item(db, target.get("item_id"))
        if not isinstance(db_item, models.FolderItem):
            add_target(target)
            continue

        contents = db_item.contents or []
        if not contents:
            # Retain an empty collection as one target so it can still refresh
            # its metadata and report completion.
            add_target(target)
            continue
        for content in contents:
            child_target = {
                "kind": "content",
                "item_id": db_item.id,
                "content_index": content.get("index"),
            }
            if add_target(child_target):
                children_found += 1

    return expanded, children_found


@router.get("/types")
def read_type_definitions():
    """The fixed, read-only taxonomy used by the manager and its clients."""
    return type_registry.type_definitions()


@router.post("/import-collection", response_model=schemas.Item | schemas.BatchImportResult)
def import_collection(req: schemas.CollectionImportRequest, db: Session = Depends(database.get_db)):
    try:
        return _import_asset(req, db)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/import", response_model=schemas.Item | schemas.BatchImportResult)
def import_asset(req: schemas.CollectionImportRequest, db: Session = Depends(database.get_db)):
    """Unified managed import for a single file, folder, or ZIP archive."""
    try:
        return _import_asset(req, db)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.post("/multitrack", response_model=schemas.Item)
def register_multitrack(req: schemas.MultitrackRegisterRequest, db: Session = Depends(database.get_db)):
    try:
        item = _create_snapshot_item(req.folder_path, db, req.vault_id, "multitrack")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if item.type != "multitrack":
        raise HTTPException(status_code=400, detail="Folder was imported as a collection, not a multitrack")
    return item

@router.post("/", response_model=schemas.Item)
def create_item(item: schemas.ItemCreate, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, item.vault_id)
    item.vault_id = vault.id
    db_item = crud.get_item_by_path(db, absolute_path=item.absolute_path, vault_id=vault.id)
    if db_item:
        raise HTTPException(status_code=400, detail="Item already registered")
    
    if not item.file_hash:
        item.file_hash = integrity.calculate_file_hash(item.absolute_path)
    
    if not item.size_bytes:
        meta = integrity.get_file_metadata(item.absolute_path)
        if meta:
            item.size_bytes = meta.get("size_bytes")
            
    result = crud.create_item(db=db, item=item)
    vaults.log_import(db, vault.id, item.absolute_path, "imported", "registered_asset", result.id)
    return result

@router.get("/", response_model=List[schemas.Item])
def read_items(skip: int = 0, limit: int = 10000, vault_id: int | None = None, include_children: bool = False, db: Session = Depends(database.get_db)):
    items = crud.get_items(db, skip=skip, limit=limit, vault_id=vault_id, include_children=include_children)
    return items

@router.post("/dispatch", response_model=List[schemas.Item])
def dispatch_items(req: schemas.DispatchItemsRequest, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, req.vault_id)
    return crud.dispatch_items_to_vault(db, req.item_ids, vault.id)

@router.delete("/{item_id}/vaults/{vault_id}", response_model=schemas.Item)
def remove_from_vault(item_id: int, vault_id: int, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, vault_id)
    return crud.remove_item_from_vault(db, item_id, vault.id)

@router.get("/browse")
def browse_folder():
    import subprocess
    
    ps_code = """
Add-Type -AssemblyName System.Windows.Forms
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.Description = "Select Import Directory"
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
if ($fbd.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $fbd.SelectedPath
}
"""
    try:
        result = subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-Command", ps_code], capture_output=True, text=True, check=True)
        folder_path = result.stdout.strip()
        return {"path": folder_path}
    except Exception as e:
        return {"error": str(e) + (result.stderr if 'result' in locals() else '')}


@router.get("/browse-file")
def browse_file():
    import subprocess

    ps_code = """
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select an asset file"
$dialog.Filter = "Supported assets|*.wav;*.flac;*.mp3;*.ogg;*.aif;*.aiff;*.mid;*.midi;*.seq;*.zip|All files|*.*"
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
}
"""
    try:
        result = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-Command", ps_code],
            capture_output=True,
            text=True,
            check=True,
        )
        return {"path": result.stdout.strip()}
    except Exception as exc:
        return {"error": str(exc) + (result.stderr if "result" in locals() else "")}

@router.get("/{item_id}", response_model=schemas.Item)
def read_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return db_item

@router.get("/{item_id}/verify")
def verify_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    
    is_intact = integrity.verify_file_integrity(db_item.absolute_path, db_item.file_hash)
    return {"id": item_id, "intact": is_intact}

@router.post("/scan")
def scan_directory(req: schemas.DirectoryScanRequest, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, req.vault_id)
    try:
        expectation = type_registry.validate_import_expectation(req.expected_type)
        dir_path = collection_importer.canonical_source_path(req.directory_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not os.path.isdir(dir_path):
        raise HTTPException(status_code=400, detail="Invalid directory path")

    source_root = Path(dir_path).resolve()
    asset_store = vaults.vault_store(vault).resolve()
    if source_root == asset_store or source_root in asset_store.parents:
        raise HTTPException(
            status_code=400,
            detail="Cannot scan the GAIA asset store or a folder that contains it",
        )

    if expectation != "files":
        try:
            _create_snapshot_item(
                dir_path, db, vault.id, expectation, req.analysis_types
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"imported": 1}
    
    supported_extensions = {".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff", ".mid", ".midi"}
    imported_items = []
    
    # Walk top-down so every folder gets a chance to claim its direct audio
    # files as a multitrack before they are imported as individual samples.
    # Clearing `dirs` then prevents the multitrack's stems (and any nested
    # support folders) from being scanned again.
    for root, dirs, files in os.walk(dir_path, topdown=True):
        dirs.sort()
        files.sort()
        existing_col = crud.get_item_by_path(db, root, vault_id=vault.id)
        if existing_col and type_registry.is_folder_type(getattr(existing_col, "type", None)):
            dirs.clear()
            continue

        if req.look_for_multitracks and multitrack_analyzer.is_multitrack_folder(root):
            snapshot_item = _create_snapshot_item(root, db, vault.id)
            if snapshot_item.type == "multitrack":
                imported_items.append(snapshot_item)
                dirs.clear()
                continue

        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in supported_extensions:
                abs_path = os.path.join(root, file)
                existing = crud.get_item_by_path(db, absolute_path=abs_path, vault_id=vault.id)
                if not existing:
                    imported_items.append(_import_standalone_file(abs_path, db, vault.id))
                else:
                    vaults.log_import(db, vault.id, abs_path, "duplicate", "skipped_duplicate", existing.id, "This file is already registered in this vault")
                    
    return {"imported": len(imported_items)}

@router.post("/{item_id}/tags", response_model=schemas.Item)
def add_tag_to_item(item_id: int, req: schemas.ItemTagRequest, db: Session = Depends(database.get_db)):
    db_item = crud.add_tag_to_item(db, item_id=item_id, tag_id=req.tag_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item or Tag not found")
    return db_item

def delete_item(
    item_id: int,
    db: Session,
    background_tasks: BackgroundTasks | None = None,
):
    existing = crud.get_item(db, item_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Item not found")

    staged_snapshot = None
    try:
        staged_snapshot = _stage_managed_collection_snapshot(existing, db)
        crud.delete_item(db, item_id=item_id)
    except Exception:
        if staged_snapshot:
            original, staged = staged_snapshot
            if staged.exists() and not original.exists():
                os.replace(staged, original)
        raise

    if staged_snapshot:
        _, staged = staged_snapshot
        if background_tasks is not None:
            background_tasks.add_task(_remove_staged_snapshot, staged)
        else:
            _remove_staged_snapshot(staged)
    return {"status": "success", "id": item_id}


@router.delete("/{item_id}")
def delete_item_route(
    item_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(database.get_db),
):
    return delete_item(item_id, db, background_tasks)

@router.patch("/{item_id}", response_model=schemas.Item)
def update_item(item_id: int, req: schemas.ItemUpdate, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    return _apply_item_update(db_item, req, db)


@router.post("/{item_id}/analyze", response_model=schemas.Item)
def analyze_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")

    if isinstance(db_item, models.FolderItem):
        contents = _analyze_collection_contents(db, db_item)
        return _finalize_collection_analysis(db, db_item, contents)

    if not os.path.isfile(db_item.absolute_path):
        raise HTTPException(status_code=404, detail="Asset is missing on disk")
    duration = collection_importer._audio_metadata(Path(db_item.absolute_path)).get("duration_seconds")
    analysis = text_analyzer.analyze_path(db_item.absolute_path, duration_seconds=duration)
    if db_item.type == "midi":
        midi_values = midi_parser.parse_midi_file(db_item.absolute_path)
        analysis["bpm"] = midi_values.get("bpm") or analysis.get("bpm")
        analysis["key"] = midi_values.get("key") or analysis.get("key")
    requested_type = db_item.type
    if db_item.type in {"sample", "loop", "one_shot", "audio"}:
        requested_type = analysis["type"]
    bpm = analysis.get("bpm") if requested_type in {"loop", "midi"} else None
    key = analysis.get("key") if requested_type in {"sample", "loop", "one_shot", "midi"} or db_item.type in {"sample", "loop", "one_shot", "midi"} else None

    if not key and requested_type in {"sample", "loop", "one_shot"}:
        from core.analyzers import KeyAnalyzer
        key = KeyAnalyzer.from_audio_file(db_item.absolute_path)

    values = {"type": requested_type, "tags": analysis.get("tags", [])}
    if requested_type in {"loop", "midi"}:
        values["bpm"] = bpm
    if requested_type in {"sample", "loop", "one_shot", "midi"} or db_item.type in {"sample", "loop", "one_shot", "midi"}:
        values["key"] = key
    request = schemas.ItemUpdate(**values)
    return _apply_item_update(db_item, request, db)


@router.post("/analyze-batch")
def start_batch_analysis(req: schemas.BatchAnalysisRequest, db: Session = Depends(database.get_db)):
    targets = []
    if req.targets:
        targets = [t.model_dump() if hasattr(t, "model_dump") else t.dict() for t in req.targets]
    elif req.item_ids:
        targets = [{"kind": "item", "item_id": item_id} for item_id in req.item_ids]

    if not targets:
        raise HTTPException(status_code=400, detail="No items or targets specified for batch analysis")

    if not isinstance(db, Session):
        expansion_db = database.SessionLocal()
        try:
            targets, children_found = _expand_collection_analysis_targets(expansion_db, targets)
        finally:
            expansion_db.close()
    else:
        targets, children_found = _expand_collection_analysis_targets(db, targets)
    task_id = batch_task_manager.create_task(targets, children_found=children_found)
    return {"task_id": task_id, "total": len(targets), "children_found": children_found}


@router.get("/analyze-batch/{task_id}")
def get_batch_analysis_status(task_id: str):
    status = batch_task_manager.get_task(task_id)
    if not status:
        raise HTTPException(status_code=404, detail="Batch analysis task not found")
    return status


@router.post("/analyze-batch/{task_id}/cancel")
def cancel_batch_analysis(task_id: str):
    success = batch_task_manager.cancel_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Batch analysis task not found")
    return {"status": "cancelled", "task_id": task_id}


@router.get("/{item_id}/contents", response_model=List[schemas.CollectionContent])
def get_collection_contents(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    if not isinstance(db_item, models.FolderItem):
        raise HTTPException(status_code=400, detail="Item is not a collection")
    return getattr(db_item, "contents", []) or []


@router.patch("/{item_id}/contents/{content_index}", response_model=schemas.CollectionContent)
def update_collection_content(item_id: int, content_index: int, req: schemas.CollectionContentUpdate, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    content, _ = _get_collection_content(db_item, content_index)
    fields = _request_fields(req)
    extension = Path(content.get("filename", "")).suffix.lower()
    allowed_types = {"midi"} if extension in collection_importer.MIDI_EXTENSIONS else {"sample", "loop", "one_shot"} if extension in collection_importer.AUDIO_EXTENSIONS else {"file"}
    if "type" in fields and req.type not in allowed_types:
        raise HTTPException(status_code=400, detail="The selected type is not valid for this file")
    if "bpm" in fields and req.bpm is not None and not 20 <= req.bpm <= 400:
        raise HTTPException(status_code=400, detail="BPM must be between 20 and 400")

    child_id = content.get("child_id")
    if child_id:
        child_item = crud.get_item(db, child_id)
        if child_item:
            update_kwargs = {}
            if "type" in fields:
                update_kwargs["type"] = req.type
            if "bpm" in fields:
                update_kwargs["bpm"] = req.bpm
            if "key" in fields:
                update_kwargs["key"] = req.key
            if "tags" in fields:
                update_kwargs["tags"] = req.tags
            if update_kwargs:
                _apply_item_update(child_item, schemas.ItemUpdate(**update_kwargs), db)
            db.refresh(db_item)
            crud._populate_item_fields(db_item)
            content, _ = _get_collection_content(db_item, content_index)
            return content

    for field in fields:
        if field == "tags":
            content[field] = _clean_tags(req.tags)
        elif field == "title":
            content[field] = (req.title or "").strip() or text_analyzer.clean_title(content["filename"])
        elif field in {"type", "bpm", "key"}:
            value = getattr(req, field)
            content[field] = value.strip() or None if isinstance(value, str) else value
    crud.save_collection_contents(db, db_item, db_item.contents)
    return content


@router.post("/{item_id}/contents/{content_index}/analyze", response_model=schemas.CollectionContent)
def analyze_collection_content(item_id: int, content_index: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    content, _ = _get_collection_content(db_item, content_index)
    analyzed = _analyze_collection_content(db_item, content)
    _propagate_content_analysis(db, db_item, analyzed)
    contents = [analyzed if entry.get("index") == content_index else entry for entry in db_item.contents]
    crud.save_collection_contents(db, db_item, contents)
    return analyzed

@router.get("/{item_id}/contents/{content_index}/stream")
def stream_collection_content(item_id: int, content_index: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    content, content_path = _get_collection_content(db_item, content_index)
    return FileResponse(path=content_path, media_type=content.get("mime_type") or "application/octet-stream")

@router.get("/{item_id}/stems")
def get_item_stems(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    if db_item.type != "multitrack":
        raise HTTPException(status_code=400, detail="Item is not a multitrack item")
    return {
        "id": item_id,
        "is_valid_length": getattr(db_item, "is_valid_length", True),
        "length_variance": getattr(db_item, "length_variance", 0.0),
        "stems": getattr(db_item, "stems", [])
    }

@router.get("/{item_id}/stems/{stem_index}/stream")
def stream_stem_item(item_id: int, stem_index: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    stems = getattr(db_item, "stems", []) or []
    if stem_index < 0 or stem_index >= len(stems):
        raise HTTPException(status_code=404, detail="Stem index out of range")
    
    stem_path = stems[stem_index].get("absolute_path")
    if not stem_path or not os.path.exists(stem_path):
        raise HTTPException(status_code=404, detail="Stem file missing on disk")
        
    return FileResponse(path=stem_path, media_type="audio/wav")

@router.get("/{item_id}/stream")
def stream_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    
    if db_item.type == "multitrack":
        stems = getattr(db_item, "stems", []) or []
        if stems and stems[0].get("absolute_path") and os.path.exists(stems[0]["absolute_path"]):
            return FileResponse(path=stems[0]["absolute_path"], media_type="audio/wav")
    
    if not os.path.exists(db_item.absolute_path):
        raise HTTPException(status_code=404, detail="File physically missing on disk")
    
    mime = db_item.mime_type or ("audio/midi" if db_item.type == "midi" else "audio/wav")
    return FileResponse(path=db_item.absolute_path, media_type=mime)
