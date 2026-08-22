from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import List
import os
import re
from pathlib import Path
import shutil
import uuid
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
    reference_service,
    type_registry,
    vaults,
)
from ..import_jobs import ImportPreviewError, import_job_manager
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
                                    db_item.absolute_path, False, analysis.get("tags", [])
                                )
                                analysis["key"] = text_analyzer.normalize_key_for_role(
                                    midi_values.get("key") or analysis.get("key"), role
                                )

                            req = _analysis_update_request(db_item, analysis)
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


def _collection_tags(contents: list[dict]) -> list[str]:
    media = [entry for entry in contents if entry.get("type") in {"audio", "sample", "midi"}]
    counts = Counter(tag for entry in media for tag in entry.get("tags", []))
    threshold = max(2, round(len(media) * 0.03))
    tags = [tag for tag, count in counts.most_common() if count >= threshold and tag not in {"Loop", "MIDI"}][:6]
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


def _stage_managed_item_path(item, db: Session) -> tuple[Path, Path, Path] | None:
    """Move any managed item aside until its database row is removed."""
    vault = _vault_for_request(db, item.vault_id)
    snapshot = Path(item.absolute_path).resolve()
    store = vaults.vault_store(vault).resolve()
    if snapshot == store:
        # A malformed legacy row must never make the asset-store root deletable.
        return None
    try:
        snapshot.relative_to(store)
    except ValueError:
        # Only GAIA-managed paths may be removed from disk. Legacy/external
        # paths lose their record but leave the original files intact.
        return None

    if not snapshot.exists():
        return None
    if isinstance(item, models.FolderItem) != snapshot.is_dir():
        # A malformed row must not broaden a file deletion into a directory
        # deletion (or vice versa).
        return None

    staged = snapshot.parent / f".deleting-{item.id}-{uuid.uuid4().hex}"
    os.replace(snapshot, staged)
    return snapshot, staged, store / "files"


def _remove_empty_import_parents(start: Path, files_root: Path) -> None:
    """Remove obsolete per-import folders without ever removing ``files/`` itself."""
    current = start.resolve()
    boundary = files_root.resolve()
    try:
        current.relative_to(boundary)
    except ValueError:
        return
    while current != boundary:
        try:
            current.rmdir()
        except OSError:
            return
        current = current.parent


def _remove_staged_snapshot(staged: Path, original_parent: Path, files_root: Path) -> None:
    if staged.is_dir():
        shutil.rmtree(staged, ignore_errors=True)
    elif staged.exists():
        staged.unlink(missing_ok=True)
    _remove_empty_import_parents(original_parent, files_root)


def _clean_tags(values: list[str] | None) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in (values or []) if value and value.strip()))[:24]


def _request_fields(req) -> set[str]:
    return set(req.model_fields_set) if hasattr(req, "model_fields_set") else set(req.__fields_set__)


def _analysis_attributes(db_item: models.Item, analysis: dict) -> dict:
    attributes = dict(getattr(db_item, "attributes", {}) or {})
    attributes["analysis"] = {
        "is_loop": bool(analysis.get("is_loop")),
        "bpm": analysis.get("bpm"),
        "key": analysis.get("key"),
    }
    return attributes


def _analysis_update_request(db_item: models.Item, analysis: dict) -> schemas.ItemUpdate:
    values = {"tags": analysis.get("tags", [])}
    if db_item.type == "sample":
        values.update(
            bpm=analysis.get("bpm"),
            key=analysis.get("key"),
            is_loop=bool(analysis.get("is_loop")),
        )
    elif db_item.type == "audio":
        values["attributes"] = _analysis_attributes(db_item, analysis)
    elif db_item.type == "midi":
        values.update(bpm=analysis.get("bpm"), key=analysis.get("key"))
    return schemas.ItemUpdate(**values)


def _apply_item_update(db_item, req: schemas.ItemUpdate, db: Session):
    fields = _request_fields(req)
    if "title" in fields and isinstance(db_item, models.ProjectItem):
        if fields != {"title"}:
            raise HTTPException(status_code=400, detail="Rename a project separately from other metadata changes")
        try:
            return project_service.rename_project(db, db_item.id, req.title or "")
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    requested_type = req.type if "type" in fields else db_item.type
    if requested_type and requested_type != db_item.type:
        if db_item.type in {"audio", "sample", "track"} and requested_type in {"audio", "sample", "track"}:
            db_item = crud.reclassify_audio(db, db_item.id, requested_type)
        else:
            raise HTTPException(status_code=400, detail="This asset cannot be changed to the selected type")

    if "title" in fields:
        if not isinstance(db_item, models.FolderItem):
            raise HTTPException(status_code=400, detail="Only collection display titles can be edited")
        db_item.title = (req.title or "").strip() or Path(db_item.absolute_path).name
    if "bpm" in fields:
        if req.bpm is not None and not 20 <= req.bpm <= 400:
            raise HTTPException(status_code=400, detail="BPM must be between 20 and 400")
        if db_item.type == "audio":
            attributes = dict(db_item.attributes or {})
            analysis = dict(attributes.get("analysis") or {})
            analysis["bpm"] = req.bpm
            attributes["analysis"] = analysis
            db_item.attributes = attributes
        elif hasattr(db_item, "bpm"):
            db_item.bpm = req.bpm
        else:
            raise HTTPException(status_code=400, detail="This asset type does not store BPM")
    if "key" in fields:
        key = (req.key or "").strip() or None
        if db_item.type == "audio":
            attributes = dict(db_item.attributes or {})
            analysis = dict(attributes.get("analysis") or {})
            analysis["key"] = key
            attributes["analysis"] = analysis
            db_item.attributes = attributes
        elif hasattr(db_item, "key"):
            db_item.key = key
        else:
            raise HTTPException(status_code=400, detail="This asset type does not store a musical key")

    if "is_loop" in fields:
        if db_item.type != "sample":
            raise HTTPException(status_code=400, detail="Only samples store loop metadata")
        db_item.is_loop = bool(req.is_loop)

    if "attributes" in fields:
        db_item.attributes = req.attributes or {}

    if fields.intersection({"title", "bpm", "key", "is_loop", "attributes"}):
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

    _apply_item_update(child, _analysis_update_request(child, analyzed), db)


def _analyze_collection_contents(db: Session, db_item: models.FolderItem) -> list[dict]:
    """Analyze every collection entry and keep indexed child rows in sync."""
    analyzed_contents = []
    for entry in (db_item.contents or []):
        analyzed = _analyze_collection_content(db_item, entry)
        _propagate_content_analysis(db, db_item, analyzed)
        analyzed_contents.append(analyzed)
    return analyzed_contents


def _finalize_collection_analysis(db: Session, db_item: models.FolderItem, contents: list[dict] | None = None):
    """Persist collection analysis without changing its user-selected classification."""
    contents = list(contents if contents is not None else (db_item.contents or []))
    db_item = crud.save_collection_contents(db, db_item, contents)
    return crud.set_item_tags(db, db_item.id, _collection_tags(contents))


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


@router.post("/import/preview")
def preview_import(req: schemas.ImportPreviewRequest, db: Session = Depends(database.get_db)):
    """Inspect a source without copying it or creating any GAIA asset rows."""
    try:
        return import_job_manager.create_preview(req.source_path, req.vault_id, db)
    except (ImportPreviewError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/import/jobs")
def create_import_job(req: schemas.ImportJobCreateRequest):
    """Queue a confirmed, revalidated background import job."""
    try:
        return import_job_manager.create_job(req)
    except ImportPreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/import/jobs/{job_id}")
def read_import_job(job_id: str):
    task = import_job_manager.get_job(job_id)
    if not task:
        raise HTTPException(status_code=404, detail="Import job not found")
    return task


@router.post("/import/jobs/{job_id}/cancel")
def cancel_import_job(job_id: str):
    task = import_job_manager.cancel_job(job_id)
    if not task:
        raise HTTPException(status_code=404, detail="Import job not found")
    return task


def _source_browser_locations() -> list[dict]:
    """Return useful local shortcuts without invoking an operating-system picker."""
    home = Path.home().resolve()
    candidates = [
        ("Home", home, "home"),
        ("Desktop", home / "Desktop", "desktop"),
        ("Downloads", home / "Downloads", "downloads"),
        ("Music", home / "Music", "music"),
    ]
    if os.name == "nt":
        try:
            import ctypes

            drive_mask = ctypes.windll.kernel32.GetLogicalDrives()
            candidates.extend(
                (f"{letter} drive", Path(f"{letter}:\\"), "drive")
                for index, letter in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
                if drive_mask & (1 << index)
            )
        except (AttributeError, OSError):
            candidates.append((f"{home.drive} drive", Path(home.anchor), "drive"))
    else:
        candidates.append(("Computer", Path("/"), "drive"))

    locations = []
    seen = set()
    for label, path, kind in candidates:
        try:
            resolved = path.resolve()
            key = os.path.normcase(str(resolved))
            if key in seen or not resolved.is_dir():
                continue
        except OSError:
            continue
        seen.add(key)
        locations.append({"label": label, "path": str(resolved), "kind": kind})
    return locations


@router.get("/import/browse-source")
def browse_import_source(path: str | None = None):
    """List one local directory for GAIA's in-app source picker."""
    requested = Path(path).expanduser() if path else Path.home()
    try:
        requested = requested.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail="That location does not exist or cannot be opened") from exc

    selected_path = str(requested) if requested.is_file() else None
    directory = requested.parent if requested.is_file() else requested
    if not directory.is_dir():
        raise HTTPException(status_code=400, detail="That location is not a file or folder")

    entries = []
    try:
        for child in directory.iterdir():
            try:
                link_stat = child.lstat()
                link_attributes = getattr(link_stat, "st_file_attributes", 0)
                if child.name.startswith(".") or link_attributes & 0x06:
                    continue
                stat = child.stat()
                kind = "folder" if child.is_dir() else "file" if child.is_file() else None
                resolved = child.resolve()
            except OSError:
                continue
            if not kind:
                continue
            entries.append({
                "name": child.name,
                "path": str(resolved),
                "kind": kind,
                "size_bytes": None if kind == "folder" else stat.st_size,
                "modified_at": datetime.datetime.fromtimestamp(
                    stat.st_mtime, datetime.timezone.utc
                ).isoformat(),
                "is_archive": kind == "file" and child.suffix.casefold() == ".zip",
            })
        entries.sort(key=lambda entry: (entry["kind"] != "folder", entry["name"].casefold()))
    except (OSError, PermissionError) as exc:
        raise HTTPException(status_code=403, detail="GAIA cannot read that location") from exc

    parent = directory.parent
    return {
        "path": str(directory),
        "parent": None if parent == directory else str(parent),
        "selected_path": selected_path,
        "entries": entries,
        "locations": _source_browser_locations(),
    }

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

@router.post("/move-to-vault", response_model=List[schemas.Item])
def move_items_to_vault(req: schemas.MoveItemsRequest, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, req.vault_id)
    try:
        return vaults.move_items_to_vault(db, req.item_ids, vault.id)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{folder_id}/place-items")
def place_items_in_folder(
    folder_id: int,
    req: schemas.FolderPlacementRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.place_items(db, folder_id, req.item_ids, req.mode)
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.get("/{item_id}", response_model=schemas.Item)
def read_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return db_item


@router.get("/{item_id}/preview", response_model=schemas.Item)
def read_item_preview(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    preview = reference_service.resolve_item_preview(db, item_id)
    if not preview:
        raise HTTPException(status_code=404, detail="This item has no playable preview master")
    return crud.get_item(db, preview.id)

@router.get("/{item_id}/verify")
def verify_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    
    is_intact = integrity.verify_file_integrity(db_item.absolute_path, db_item.file_hash)
    return {"id": item_id, "intact": is_intact}

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
        staged_snapshot = _stage_managed_item_path(existing, db)
        crud.delete_item(db, item_id=item_id)
    except (ValueError, OSError) as exc:
        if staged_snapshot:
            original, staged, _ = staged_snapshot
            if staged.exists() and not original.exists():
                os.replace(staged, original)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        if staged_snapshot:
            original, staged, _ = staged_snapshot
            if staged.exists() and not original.exists():
                os.replace(staged, original)
        raise

    if staged_snapshot:
        original, staged, files_root = staged_snapshot
        if background_tasks is not None:
            background_tasks.add_task(_remove_staged_snapshot, staged, original.parent, files_root)
        else:
            _remove_staged_snapshot(staged, original.parent, files_root)
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
    return _apply_item_update(db_item, _analysis_update_request(db_item, analysis), db)


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
    allowed_types = {"midi"} if extension in collection_importer.MIDI_EXTENSIONS else {"audio", "sample", "track"} if extension in collection_importer.AUDIO_EXTENSIONS else {"file"}
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
            if "is_loop" in fields:
                update_kwargs["is_loop"] = req.is_loop
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
        elif field in {"type", "bpm", "key", "is_loop"}:
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
