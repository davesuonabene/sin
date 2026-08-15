"""Transactional project creation and file containment for GAIA."""

from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import uuid

from sqlalchemy.orm import Session

from . import (
    collection_importer,
    crud,
    integrity,
    midi_parser,
    models,
    schemas,
    text_analyzer,
    type_registry,
    vaults,
)


PROJECTS_DIRECTORY = "projects"


def _safe_project_name(value: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (value or "").strip()).strip(". ")
    name = re.sub(r"\s+", " ", name)
    if not name:
        raise ValueError("Project name cannot be empty")
    if len(name) > 100:
        raise ValueError("Project name must be 100 characters or fewer")
    return name


def _project_schema(project_type: str):
    if project_type == "live_recording_project":
        return schemas.LiveRecordingProjectItemCreate
    raise ValueError(f"Unsupported project type: {project_type}")


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _unique_destination(folder: Path, filename: str) -> Path:
    candidate = folder / filename
    if not candidate.exists():
        return candidate
    stem = Path(filename).stem or "asset"
    suffix = Path(filename).suffix
    counter = 2
    while True:
        candidate = folder / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def file_schema_for_path(path: Path, vault_id: int, parent_id: int | None = None):
    extension = path.suffix.lower()
    mime_type = mimetypes.guess_type(str(path))[0]
    size_bytes = path.stat().st_size
    file_hash = integrity.calculate_file_hash(str(path))
    duration = None
    if extension in collection_importer.AUDIO_EXTENSIONS:
        duration = collection_importer._audio_metadata(path).get("duration_seconds")
    analysis = text_analyzer.analyze_path(str(path), duration_seconds=duration)

    common = {
        "absolute_path": str(path.resolve()),
        "vault_id": vault_id,
        "parent_id": parent_id,
        "file_hash": file_hash,
        "size_bytes": size_bytes,
        "mime_type": mime_type,
    }
    if extension in collection_importer.MIDI_EXTENSIONS:
        try:
            midi_values = midi_parser.parse_midi_file(str(path))
        except Exception:
            midi_values = {}
        return schemas.MidiItemCreate(
            **common,
            bpm=midi_values.get("bpm") or analysis.get("bpm"),
            key=midi_values.get("key") or analysis.get("key"),
        ), analysis.get("tags", [])
    if extension in collection_importer.AUDIO_EXTENSIONS:
        if analysis.get("type") == "loop":
            return schemas.LoopSampleItemCreate(
                **common,
                bpm=round(float(analysis["bpm"])) if analysis.get("bpm") else None,
                key=analysis.get("key"),
            ), analysis.get("tags", [])
        if analysis.get("type") == "one_shot":
            return schemas.OneShotSampleItemCreate(
                **common,
                key=analysis.get("key"),
            ), analysis.get("tags", [])
        return schemas.SampleItemCreate(
            **common,
            key=analysis.get("key"),
        ), analysis.get("tags", [])
    return schemas.ItemCreate(**common, type="item"), analysis.get("tags", [])


def _prepare_project(
    db: Session,
    name: str,
    project_type: str,
    vault,
) -> tuple[models.ProjectItem, Path]:
    if not type_registry.is_project_type(project_type):
        raise ValueError(f"Unsupported project type: {project_type}")

    title = _safe_project_name(name)
    projects_root = vaults.vault_store(vault).resolve() / PROJECTS_DIRECTORY
    projects_root.mkdir(parents=True, exist_ok=True)
    destination = projects_root / title
    if destination.exists():
        raise ValueError(f"A managed project folder named '{title}' already exists")

    staging = projects_root / f".{uuid.uuid4().hex}.staging"
    staging.mkdir(parents=False, exist_ok=False)
    try:
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    schema_class = _project_schema(project_type)
    item = schema_class(
        absolute_path=str(destination),
        vault_id=vault.id,
        title=title,
        source_kind="managed",
        source_path=str(destination),
        contents=[],
        warnings=[],
    )
    try:
        project = crud.create_item(db, item, commit=False)
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return project, destination


def _attach_vault(item: models.Item, vault) -> None:
    if vault not in item.vaults:
        item.vaults.append(vault)
    if item.vault_id is None:
        item.vault_id = vault.id


def _contain_existing_item(
    db: Session,
    project: models.ProjectItem,
    item: models.Item,
    asset_store: Path,
    rollback_actions: list,
) -> None:
    if isinstance(item, models.FolderItem):
        raise ValueError("Folders cannot be encapsulated as Project files")
    if item.parent_id is not None:
        raise ValueError(f"{Path(item.absolute_path).name} already belongs to a folder")

    source = Path(item.absolute_path).resolve()
    if not source.is_file():
        raise ValueError(f"Asset file is missing: {source}")
    destination = _unique_destination(Path(project.absolute_path), source.name)

    if _is_within(asset_store, source):
        os.replace(source, destination)
        rollback_actions.append(lambda src=source, dst=destination: os.replace(dst, src) if dst.exists() else None)
    else:
        shutil.copy2(source, destination)
        rollback_actions.append(lambda dst=destination: dst.unlink(missing_ok=True))

    item.absolute_path = str(destination.resolve())
    item.parent = project
    _attach_vault(item, project.vault)


def _add_unregistered_path(
    db: Session,
    project: models.ProjectItem,
    source_path: str,
    asset_store: Path,
    rollback_actions: list,
) -> models.Item:
    source = Path(collection_importer.canonical_source_path(source_path)).resolve()
    if not source.is_file():
        raise ValueError(f"Project additions must be files: {source}")
    if _is_within(Path(project.absolute_path), source):
        raise ValueError(f"File is already inside this Project: {source.name}")

    existing = crud.get_item_by_path(db, str(source))
    if existing:
        _contain_existing_item(db, project, existing, asset_store, rollback_actions)
        return existing

    destination = _unique_destination(Path(project.absolute_path), source.name)
    if _is_within(asset_store, source):
        os.replace(source, destination)
        rollback_actions.append(lambda src=source, dst=destination: os.replace(dst, src) if dst.exists() else None)
    else:
        shutil.copy2(source, destination)
        rollback_actions.append(lambda dst=destination: dst.unlink(missing_ok=True))

    item_schema, tags = file_schema_for_path(destination, project.vault_id, project.id)
    item = crud.create_item(db, item_schema, commit=False)
    if tags:
        crud.set_item_tags(db, item.id, tags, commit=False)
    return item


def _sync_project_manifest(db: Session, project: models.ProjectItem) -> None:
    contents = collection_importer.build_manifest(Path(project.absolute_path))
    project.manifest_json = json.dumps(contents)
    project.content_count = len(contents)
    project.size_bytes = sum(entry.get("size_bytes") or 0 for entry in contents)
    db.flush()


def _run_file_operation(db: Session, operation, created_project_paths: list[Path] | None = None):
    rollback_actions: list = []
    created_paths = created_project_paths if created_project_paths is not None else []
    try:
        result = operation(rollback_actions)
        db.commit()
        return result
    except Exception:
        db.rollback()
        for rollback in reversed(rollback_actions):
            try:
                rollback()
            except Exception:
                pass
        for path in reversed(created_paths):
            shutil.rmtree(path, ignore_errors=True)
        raise


def create_project(db: Session, name: str, project_type: str, vault_id: int | None):
    vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")
    created_paths: list[Path] = []

    def operation(_rollback_actions):
        project, path = _prepare_project(db, name, project_type, vault)
        created_paths.append(path)
        db.flush()
        return project.id

    project_id = _run_file_operation(db, operation, created_paths)
    project = crud.get_item(db, project_id)
    vaults.log_import(db, vault.id, project.absolute_path, "created", "project_created", project.id)
    return project


def add_items(db: Session, project_id: int, item_ids: list[int]):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    if not item_ids:
        raise ValueError("Select at least one file")
    items = db.query(models.Item).filter(models.Item.id.in_(set(item_ids))).all()
    if len(items) != len(set(item_ids)):
        raise ValueError("One or more selected files no longer exist")
    asset_store = vaults.vault_store(project.vault).resolve()

    def operation(rollback_actions):
        for item in items:
            _contain_existing_item(db, project, item, asset_store, rollback_actions)
        db.flush()
        _sync_project_manifest(db, project)
        return project.id

    project_id = _run_file_operation(db, operation)
    return crud.get_item(db, project_id)


def add_paths(db: Session, project_id: int, source_paths: list[str]):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    cleaned_paths = list(dict.fromkeys(path.strip() for path in source_paths if path and path.strip()))
    if not cleaned_paths:
        raise ValueError("Choose at least one file")
    asset_store = vaults.vault_store(project.vault).resolve()

    def operation(rollback_actions):
        for source_path in cleaned_paths:
            _add_unregistered_path(db, project, source_path, asset_store, rollback_actions)
        db.flush()
        _sync_project_manifest(db, project)
        return project.id

    project_id = _run_file_operation(db, operation)
    return crud.get_item(db, project_id)


def create_from_items(
    db: Session,
    item_ids: list[int],
    mode: str,
    name: str | None,
    project_type: str,
    vault_id: int | None,
):
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one file")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    items_by_id = {item.id: item for item in items}
    if len(items_by_id) != len(unique_ids):
        raise ValueError("One or more selected files no longer exist")
    ordered_items = [items_by_id[item_id] for item_id in unique_ids]
    for item in ordered_items:
        if isinstance(item, models.FolderItem) or item.parent_id is not None:
            raise ValueError("Only loose top-level files can be converted into Projects")

    vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")
    if mode == "single" and not (name or "").strip():
        raise ValueError("A name is required when creating one Project")
    if mode not in {"single", "one_per_item"}:
        raise ValueError("Unknown Project creation mode")

    created_paths: list[Path] = []
    asset_store = vaults.vault_store(vault).resolve()

    def operation(rollback_actions):
        project_ids = []
        if mode == "single":
            project, path = _prepare_project(db, name or "Project", project_type, vault)
            created_paths.append(path)
            db.flush()
            for item in ordered_items:
                _contain_existing_item(db, project, item, asset_store, rollback_actions)
            _sync_project_manifest(db, project)
            project_ids.append(project.id)
        else:
            for item in ordered_items:
                project_name = Path(item.absolute_path).stem or Path(item.absolute_path).name
                project, path = _prepare_project(db, project_name, project_type, vault)
                created_paths.append(path)
                db.flush()
                _contain_existing_item(db, project, item, asset_store, rollback_actions)
                _sync_project_manifest(db, project)
                project_ids.append(project.id)
        return project_ids

    project_ids = _run_file_operation(db, operation, created_paths)
    projects = [crud.get_item(db, project_id) for project_id in project_ids]
    for project in projects:
        vaults.log_import(db, vault.id, project.absolute_path, "created", "project_created_from_items", project.id)
    return projects
