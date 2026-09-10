"""Project workspaces, generic links, and project-owned files."""

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
    reference_service,
    schemas,
    text_analyzer,
    type_registry,
    vaults,
)


PROJECT_FILES_DIRECTORY = "files"


def _safe_name(value: str, *, field_name: str = "Name") -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (value or "").strip()).strip(". ")
    name = re.sub(r"\s+", " ", name)
    if not name:
        raise ValueError(f"{field_name} cannot be empty")
    if len(name) > 100:
        raise ValueError(f"{field_name} must be 100 characters or fewer")
    return name


def project_stage_directory(project: models.ProjectItem, stage_name: str) -> Path:
    """Return the canonical directory for project-owned generated files."""
    stage = _safe_name(stage_name, field_name="Stage name")
    return Path(project.absolute_path).resolve() / PROJECT_FILES_DIRECTORY / stage


def _project_schema(project_type: str):
    if project_type == "project":
        return schemas.ProjectItemCreate
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


def _remove_empty_loose_parents(start: Path, files_root: Path) -> None:
    """Prune legacy per-import folders while preserving the vault's loose-file root."""
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


def _find_owning_project(db: Session, item: models.Item | None) -> models.ProjectItem | None:
    curr = item
    while curr:
        if isinstance(curr, models.ProjectItem) or getattr(curr, "type", None) == "project":
            return curr
        pid = getattr(curr, "parent_id", None)
        curr = db.query(models.FolderItem).filter(models.FolderItem.id == pid).first() if pid is not None else None
    return None


def _folder_label(folder: models.Item, context_project: models.ProjectItem | None) -> str | None:
    if context_project:
        if folder.id == context_project.id:
            return None
        try:
            rel = Path(folder.absolute_path).relative_to(Path(context_project.absolute_path)).as_posix()
            if rel and rel != ".":
                return rel
            return None
        except ValueError:
            pass
    if isinstance(folder, models.ProjectItem) or getattr(folder, "type", None) == "project":
        return None
    title = getattr(folder, "title", None) or Path(folder.absolute_path).name
    return title if title and title != "." else None


def _count_folder_contents(db: Session, folder_id: int, context_project_id: int | None, folder_label: str | None) -> int:
    ref_count = 0
    if context_project_id:
        refs = db.query(models.ItemReference).filter(models.ItemReference.context_id == context_project_id).all()
        if folder_label:
            ref_count = sum(1 for r in refs if (r.attributes or {}).get("folder") == folder_label)
        elif folder_id == context_project_id:
            ref_count = len(refs)
    return db.query(models.Item).filter(models.Item.parent_id == folder_id).count() + ref_count


def file_schema_for_path(path: Path, vault_id: int, parent_id: int | None = None):
    """Register files as generic audio until a user classifies them otherwise."""
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
        "attributes": {
            "analysis": {
                "is_loop": bool(analysis.get("is_loop")),
                "bpm": analysis.get("bpm"),
                "key": analysis.get("key"),
            }
        },
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
        return schemas.AudioItemCreate(**common), analysis.get("tags", [])
    return schemas.ItemCreate(**common, type="item"), analysis.get("tags", [])


def _clone_item_file(
    db: Session,
    source: models.Item,
    source_path: Path,
    destination: Path,
    target_vault_id: int,
    target_parent_id: int | None,
) -> models.Item:
    """Copy a file and preserve its GAIA metadata and database row."""
    shutil.copy2(source_path, destination)
    item_schema, _ = file_schema_for_path(destination, target_vault_id, target_parent_id)
    common = item_schema.model_dump() if hasattr(item_schema, "model_dump") else item_schema.dict()
    common["attributes"] = dict(source.attributes)
    common["type"] = source.type
    common["file_hash"] = source.file_hash
    common["size_bytes"] = source.size_bytes
    common["mime_type"] = source.mime_type
    if source.type == "sample":
        item_schema = schemas.SampleItemCreate(
            **common,
            key=getattr(source, "key", None),
            bpm=getattr(source, "bpm", None),
            is_loop=bool(getattr(source, "is_loop", False)),
        )
    elif source.type == "track":
        item_schema = schemas.TrackItemCreate(**common)
    elif source.type == "midi":
        item_schema = schemas.MidiItemCreate(
            **common,
            key=getattr(source, "key", None),
            bpm=getattr(source, "bpm", None),
        )
    else:
        item_schema = schemas.ItemCreate(**common)
    cloned = crud.create_item(db, item_schema, commit=False)
    source_tags = [tag.name for tag in source.tags]
    if source_tags:
        crud.set_item_tags(db, cloned.id, source_tags, commit=False)
    return cloned


def _prepare_project(
    db: Session,
    name: str,
    project_type: str,
    vault,
) -> tuple[models.ProjectItem, Path]:
    if not type_registry.is_project_type(project_type):
        raise ValueError(f"Unsupported project type: {project_type}")
    title = _safe_name(name, field_name="Project name")
    vault_root = vaults.vault_store(vault).resolve()
    vault_root.mkdir(parents=True, exist_ok=True)
    destination = vault_root / title
    if destination.exists():
        raise ValueError(f"A managed project folder named '{title}' already exists")
    destination.mkdir(parents=False, exist_ok=False)
    files_root = destination / PROJECT_FILES_DIRECTORY
    files_root.mkdir(parents=True, exist_ok=True)
    for stage_name in ("edit", "source", "derived"):
        (files_root / stage_name).mkdir(parents=True, exist_ok=True)
    schema = _project_schema(project_type)(
        absolute_path=str(destination),
        vault_id=vault.id,
        title=title,
        source_kind="managed",
        source_path=str(destination),
        contents=[],
        warnings=[],
    )
    try:
        project = crud.create_item(db, schema, commit=False)
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return project, destination


def _run_transaction(
    db: Session,
    operation,
    created_paths: list[Path] | None = None,
    rollback_operation=None,
):
    created = created_paths if created_paths is not None else []
    try:
        result = operation()
        db.commit()
        return result
    except Exception:
        db.rollback()
        if rollback_operation is not None:
            try:
                rollback_operation()
            except OSError:
                pass
        for path in reversed(created):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
        raise


def create_project(db: Session, name: str, project_type: str, vault_id: int | None):
    vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")
    created_paths: list[Path] = []

    def operation():
        project, path = _prepare_project(db, name, project_type, vault)
        created_paths.append(path)
        db.flush()
        return project.id

    project_id = _run_transaction(db, operation, created_paths)
    project = crud.get_item(db, project_id)
    vaults.log_import(db, vault.id, project.absolute_path, "created", "project_created", project.id)
    sync_project_manifest(db, project.id)
    return project


def rename_project(db: Session, project_id: int, name: str):
    """Rename a managed project and its folder as one recoverable operation."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    vault = vaults.get_vault(db, project.vault_id)
    if not vault:
        raise ValueError("Vault not found")

    title = _safe_name(name, field_name="Project name")
    source = Path(project.absolute_path).resolve()
    vault_root = vaults.vault_store(vault).resolve()
    if source.parent != vault_root or not source.is_dir():
        raise ValueError("Project folder is missing from its owning vault")
    destination = (vault_root / title).resolve()
    if str(source) == str(destination):
        project.title = title
        db.commit()
        db.refresh(project)
        sync_project_manifest(db, project.id)
        return crud.get_item(db, project.id)
    if os.path.normcase(str(source)) != os.path.normcase(str(destination)) and destination.exists():
        raise ValueError(f"A managed project folder named '{title}' already exists")

    temporary = None
    try:
        if os.path.normcase(str(source)) == os.path.normcase(str(destination)):
            temporary = vault_root / f".gaia-rename-{project.id}-{uuid.uuid4().hex}"
            source.replace(temporary)
            temporary.replace(destination)
            temporary = None
        else:
            source.replace(destination)
        project.title = title
        db.flush()
        vaults.rewrite_managed_paths(
            db.connection(),
            [{"source": str(source), "target": str(destination)}],
        )
        db.commit()
    except Exception:
        db.rollback()
        if temporary and temporary.exists() and not source.exists():
            temporary.replace(source)
        elif destination.exists() and not source.exists():
            destination.replace(source)
        raise

    sync_project_manifest(db, project.id)
    return crud.get_item(db, project.id)


def sync_project_manifest(db: Session, project_id: int):
    """Refresh the one JSON project manifest from canonical graph rows."""
    from . import project_manifest

    return project_manifest.sync_project_manifest(db, project_id)


def add_items(db: Session, project_id: int, item_ids: list[int]):
    """Link existing library items without moving the underlying assets."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    if len(items) != len(unique_ids):
        raise ValueError("One or more items no longer exist")

    existing_links = {
        row.to_item_id
        for row in db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project_id,
            models.ItemReference.from_item_id == project_id,
        )
        .all()
    }

    def operation():
        for item in items:
            if item.id in existing_links:
                continue
            reference_service.create_reference(
                db,
                schemas.ProjectReferenceCreate(
                    from_item_id=project.id,
                    to_item_id=item.id,
                    relation_kind="use",
                ),
                context_id=project.id,
                commit=False,
            )
        return project.id

    _run_transaction(db, operation)
    sync_project_manifest(db, project.id)
    return crud.get_item(db, project.id)


def _project_link_exists(db: Session, context_id: int, item_id: int) -> bool:
    return (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == context_id,
            models.ItemReference.from_item_id == context_id,
            models.ItemReference.to_item_id == item_id,
        )
        .first()
        is not None
    )


def _top_level_selection(items: list[models.Item]) -> list[models.Item]:
    selected_ids = {item.id for item in items}
    result = []
    for item in items:
        parent = item.parent
        seen = set()
        while parent is not None and parent.id not in seen:
            if parent.id in selected_ids:
                break
            seen.add(parent.id)
            parent = parent.parent
        else:
            result.append(item)
    return result


def place_items(db: Session, target_id: int, item_ids: list[int], mode: str, folder: str | None = None) -> dict:
    """Place library items in a folder by physical move or generic link."""
    target = db.query(models.FolderItem).filter(models.FolderItem.id == target_id).first()
    if not target:
        raise ValueError("Target folder not found")
    if mode not in {"move", "reference", "copy"}:
        raise ValueError("Choose move, reference, or copy")

    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Choose at least one item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    by_id = {item.id: item for item in items}
    if len(by_id) != len(unique_ids):
        raise ValueError("One or more items no longer exist")
    ordered_items = [by_id[item_id] for item_id in unique_ids]
    if target.id in by_id:
        raise ValueError("A folder cannot be placed inside itself")

    context_project = _find_owning_project(db, target)
    context_project_id = context_project.id if context_project else None
    effective_project_id = context_project_id or (target.id if isinstance(target, models.ProjectItem) else None)

    if folder is not None:
        folder_clean = folder.strip().strip("/")
        folder_label = folder_clean if folder_clean and folder_clean != "." else None
    else:
        folder_label = _folder_label(target, context_project)

    # Virtual folder / bin check: per AGENTS.md, folders in vaults and projects are logical bins.
    # Organizing items into/between folders never moves files on disk.
    is_virtual_folder = (
        effective_project_id is not None
        or folder_label is not None
        or getattr(target, "type", None) == "folder"
        or bool((getattr(target, "attributes", None) or {}).get("is_folder"))
        or ("is_folder" in str(getattr(target, "metadata_json", "")))
    )

    if mode == "reference":
        def link_operation():
            for item in ordered_items:
                if effective_project_id:
                    refs = db.query(models.ItemReference).filter(
                        models.ItemReference.context_id == effective_project_id,
                        models.ItemReference.to_item_id == item.id,
                    ).all()
                    if refs:
                        for ref in refs:
                            ref_attrs = dict(ref.attributes or {})
                            if folder_label:
                                ref_attrs["folder"] = folder_label
                            else:
                                ref_attrs.pop("folder", None)
                            ref.attributes = ref_attrs
                    else:
                        revision_label = None
                        stage_name = None
                        tags = []
                        if hasattr(item, "attributes") and isinstance(item.attributes, dict):
                            revision_label = item.attributes.get("cut_label") or item.attributes.get("revision_label")
                            stage_name = item.attributes.get("stage")
                        existing_ref = (
                            db.query(models.ItemReference)
                            .filter(models.ItemReference.to_item_id == item.id)
                            .first()
                        )
                        if existing_ref:
                            if not revision_label:
                                revision_label = existing_ref.revision_label
                            if not stage_name:
                                stage_name = existing_ref.stage_name
                            tags = reference_service.relation_tags(existing_ref)

                        reference_service.create_reference(
                            db,
                            schemas.ProjectReferenceCreate(
                                from_item_id=effective_project_id,
                                to_item_id=item.id,
                                relation_kind="use",
                                stage_name=stage_name,
                                revision_label=revision_label,
                                tags=tags,
                                attributes={"folder": folder_label} if folder_label else {},
                            ),
                            context_id=effective_project_id,
                            commit=False,
                        )
                else:
                    if not _project_link_exists(db, target.id, item.id):
                        revision_label = None
                        stage_name = None
                        tags = []
                        if hasattr(item, "attributes") and isinstance(item.attributes, dict):
                            revision_label = item.attributes.get("cut_label") or item.attributes.get("revision_label")
                            stage_name = item.attributes.get("stage")
                        existing_ref = (
                            db.query(models.ItemReference)
                            .filter(models.ItemReference.to_item_id == item.id)
                            .first()
                        )
                        if existing_ref:
                            if not revision_label:
                                revision_label = existing_ref.revision_label
                            if not stage_name:
                                stage_name = existing_ref.stage_name
                            tags = reference_service.relation_tags(existing_ref)

                        reference_service.create_reference(
                            db,
                            schemas.ProjectReferenceCreate(
                                from_item_id=target.id,
                                to_item_id=item.id,
                                relation_kind="use",
                                stage_name=stage_name,
                                revision_label=revision_label,
                                tags=tags,
                                attributes={"folder": folder_label} if folder_label else {},
                            ),
                            context_id=target.id,
                            commit=False,
                        )
                    else:
                        refs = db.query(models.ItemReference).filter(
                            models.ItemReference.context_id == target.id,
                            models.ItemReference.to_item_id == item.id,
                        ).all()
                        for ref in refs:
                            ref_attrs = dict(ref.attributes or {})
                            if folder_label:
                                ref_attrs["folder"] = folder_label
                            else:
                                ref_attrs.pop("folder", None)
                            ref.attributes = ref_attrs
            target.content_count = _count_folder_contents(db, target.id, effective_project_id, folder_label)
            return target.id

        _run_transaction(db, link_operation)
        if effective_project_id:
            sync_project_manifest(db, effective_project_id)
        return {
            "target": crud.item_summary(target),
            "target_id": target.id,
            "mode": mode,
            "item_ids": unique_ids,
        }


    if mode == "copy":
        target_root = Path(target.absolute_path).resolve()
        if not target_root.exists() or not target_root.is_dir():
            raise ValueError("Target folder is missing from disk")
        copied_items = _top_level_selection(ordered_items)
        created_paths: list[Path] = []
        cloned_ids: list[int] = []

        def copy_operation():
            for item in copied_items:
                source = Path(item.absolute_path).resolve()
                if not source.exists():
                    raise ValueError(f"'{source.name}' is missing from disk")
                destination = _unique_destination(target_root, source.name)
                created_paths.append(destination)
                cloned = _clone_item_file(db, item, source, destination, target.vault_id, target.id)
                cloned_ids.append(cloned.id)
                if isinstance(target, models.ProjectItem):
                    revision_label = None
                    stage_name = None
                    if hasattr(item, "attributes") and isinstance(item.attributes, dict):
                        revision_label = item.attributes.get("cut_label") or item.attributes.get("revision_label")
                        stage_name = item.attributes.get("stage")
                    existing_ref = (
                        db.query(models.ItemReference)
                        .filter(models.ItemReference.to_item_id == item.id)
                        .first()
                    )
                    if existing_ref:
                        if not revision_label:
                            revision_label = existing_ref.revision_label
                        if not stage_name:
                            stage_name = existing_ref.stage_name
                    reference_service.create_reference(
                        db,
                        schemas.ProjectReferenceCreate(
                            from_item_id=target.id,
                            to_item_id=cloned.id,
                            relation_kind="use",
                            stage_name=stage_name,
                            revision_label=revision_label,
                        ),
                        context_id=target.id,
                        commit=False,
                    )
            return target.id

        _run_transaction(db, copy_operation, created_paths)
        if isinstance(target, models.ProjectItem):
            sync_project_manifest(db, target.id)
        return {
            "target": crud.item_summary(target),
            "target_id": target.id,
            "mode": mode,
            "item_ids": cloned_ids,
        }

    moved_items = _top_level_selection(ordered_items)
    if any(isinstance(item, models.ProjectItem) for item in moved_items):
        raise ValueError("Projects must remain directly inside their owning vault")
    target_vault = vaults.get_vault(db, target.vault_id)
    if not target_vault:
        raise ValueError("Target vault not found")
    target_root = Path(target.absolute_path).resolve()
    target_store = vaults.vault_store(target_vault).resolve()
    if not _is_within(target_store, target_root) or not target_root.is_dir():
        raise ValueError("Target folder is missing from its owning vault")
    destination_root = target_root

    validated: list[tuple[models.Item, Path]] = []
    external_items: list[models.Item] = []
    context_project = _find_owning_project(db, target)
    context_project_id = context_project.id if context_project else None
    if folder is not None:
        folder_clean = folder.strip().strip("/")
        folder_label = folder_clean if folder_clean and folder_clean != "." else None
    else:
        folder_label = _folder_label(target, context_project)

    for item in moved_items:
        source = Path(item.absolute_path).resolve()
        if _is_within(source, target_root):
            raise ValueError("A folder cannot be moved into one of its descendants")

        is_external = (
            getattr(item, "storage_mode", None) == "external_reference"
            or getattr(item, "source_kind", None) == "external"
            or (isinstance(getattr(item, "attributes", None), dict) and item.attributes.get("storage_mode") == "external_reference")
        )
        if not is_external and item.vault_id:
            source_vault = vaults.get_vault(db, item.vault_id)
            if source_vault and not _is_within(vaults.vault_store(source_vault), source):
                is_external = True

        # If placing inside a project and the item is already a project reference,
        # keep it as a reference without altering original file on disk.
        is_project_ref = False
        if context_project_id:
            existing_ref = db.query(models.ItemReference).filter(
                models.ItemReference.context_id == context_project_id,
                models.ItemReference.to_item_id == item.id,
            ).first()
            if existing_ref:
                is_project_ref = True

        if is_external or is_project_ref:
            external_items.append(item)
        else:
            if not source.exists():
                raise ValueError(f"'{source.name}' is missing from disk")
            source_vault = vaults.get_vault(db, item.vault_id)
            if not source_vault or not _is_within(vaults.vault_store(source_vault), source):
                raise ValueError(f"'{source.name}' is outside its owning vault")
            validated.append((item, source))

    moves: list[tuple[Path, Path]] = []
    created_destination_root = not destination_root.exists()
    try:
        destination_root.mkdir(parents=False, exist_ok=True)
        operations = []
        for item, source in validated:
            if source.parent == destination_root:
                destination = source
            else:
                destination = _unique_destination(destination_root, source.name)
                source.replace(destination)
                moves.append((source, destination))
                operations.append({"source": str(source), "target": str(destination)})

            stack = [item]
            while stack:
                current = stack.pop()
                current.vault_id = target.vault_id
                stack.extend(current.children)
            item.parent_id = target.id
            if context_project_id:
                refs = db.query(models.ItemReference).filter(
                    models.ItemReference.context_id == context_project_id,
                    models.ItemReference.to_item_id == item.id,
                ).all()
                if refs:
                    for ref in refs:
                        ref_attrs = dict(ref.attributes or {})
                        if folder_label:
                            ref_attrs["folder"] = folder_label
                        else:
                            ref_attrs.pop("folder", None)
                        ref.attributes = ref_attrs
                elif not _project_link_exists(db, context_project_id, item.id):
                    reference_service.create_reference(
                        db,
                        schemas.ProjectReferenceCreate(
                            from_item_id=context_project_id,
                            to_item_id=item.id,
                            relation_kind="use",
                            attributes={"folder": folder_label} if folder_label else {},
                        ),
                        context_id=context_project_id,
                        commit=False,
                    )
            elif isinstance(target, models.ProjectItem) and not _project_link_exists(db, target.id, item.id):
                reference_service.create_reference(
                    db,
                    schemas.ProjectReferenceCreate(
                        from_item_id=target.id,
                        to_item_id=item.id,
                        relation_kind="use",
                    ),
                    context_id=target.id,
                    commit=False,
                )

        for item in external_items:
            is_proj_ref = False
            if context_project_id:
                refs = db.query(models.ItemReference).filter(
                    models.ItemReference.context_id == context_project_id,
                    models.ItemReference.to_item_id == item.id,
                ).all()
                if refs:
                    is_proj_ref = True
                    for ref in refs:
                        ref_attrs = dict(ref.attributes or {})
                        if folder_label:
                            ref_attrs["folder"] = folder_label
                        else:
                            ref_attrs.pop("folder", None)
                        ref.attributes = ref_attrs

            if not is_proj_ref:
                if context_project_id:
                    if not _project_link_exists(db, context_project_id, item.id):
                        reference_service.create_reference(
                            db,
                            schemas.ProjectReferenceCreate(
                                from_item_id=context_project_id,
                                to_item_id=item.id,
                                relation_kind="use",
                                attributes={"folder": folder_label} if folder_label else {},
                            ),
                            context_id=context_project_id,
                            commit=False,
                        )
                else:
                    item.parent_id = target.id
                    item.vault_id = target.vault_id
                    attrs = dict(item.attributes or {})
                    if folder_label:
                        attrs["folder"] = folder_label
                    else:
                        attrs.pop("folder", None)
                    item.attributes = attrs

        target.content_count = _count_folder_contents(db, target.id, context_project_id, folder_label)

        db.flush()
        if operations:
            vaults.rewrite_managed_paths(db.connection(), operations)
        db.commit()
    except Exception:
        db.rollback()
        for source, destination in reversed(moves):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.replace(source)
        if created_destination_root:
            try:
                destination_root.rmdir()
            except OSError:
                pass
        raise

    if context_project:
        sync_project_manifest(db, context_project.id)
    return {
        "target": crud.item_summary(target),
        "target_id": target.id,
        "mode": mode,
        "item_ids": [item.id for item in moved_items],
    }


def create_folder(
    db: Session,
    name: str,
    vault_id: int | None = None,
    parent_id: int | None = None,
    item_ids: list[int] | None = None,
    reference_ids: list[int] | None = None,
) -> models.CollectionItem:
    """Create a folder directory and lightweight CollectionItem, optionally placing items."""
    folder_name = _safe_name(name, field_name="Folder name")
    parent = None
    if parent_id is not None:
        parent = db.query(models.FolderItem).filter(models.FolderItem.id == parent_id).first()
        if not parent:
            raise ValueError("Parent folder not found")
        vault = vaults.get_vault(db, parent.vault_id)
        parent_root = Path(parent.absolute_path).resolve()
        folder_path = _unique_destination(parent_root, folder_name)
    else:
        vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
        if not vault:
            raise ValueError("Vault not found")
        store = vaults.vault_store(vault).resolve()
        folder_path = _unique_destination(store, folder_name)

    folder_path.mkdir(parents=True, exist_ok=True)
    folder = models.CollectionItem(
        absolute_path=str(folder_path.resolve()),
        vault_id=vault.id,
        parent_id=parent_id,
        title=folder_name,
        source_kind="managed",
        content_count=0,
        type="collection",
        storage_mode="managed",
        availability="ready",
        metadata_json=json.dumps({"is_folder": True, "profile_id": "folder", "profile_label": "Folder"}),
    )
    db.add(folder)
    db.flush()

    context_project = _find_owning_project(db, parent)
    folder_label = _folder_label(folder, context_project)

    if reference_ids:
        refs = db.query(models.ItemReference).filter(models.ItemReference.id.in_(reference_ids)).all()
        for ref in refs:
            ref_attrs = dict(ref.attributes or {})
            if folder_label:
                ref_attrs["folder"] = folder_label
            else:
                ref_attrs.pop("folder", None)
            ref.attributes = ref_attrs

    if item_ids:
        place_items(db, folder.id, item_ids, mode="move")

    folder.content_count = _count_folder_contents(db, folder.id, context_project.id if context_project else None, folder_label)
    vaults.log_import(db, vault.id, folder.absolute_path, "created", "folder_created", folder.id)
    if context_project:
        sync_project_manifest(db, context_project.id)
    db.commit()
    db.refresh(folder)
    return folder


def adopt_orphans(db: Session, project_id: int) -> dict:
    """Move referenced, managed, unparented files into their project.

    Adoption changes physical and hierarchical ownership without changing item
    identity or relationship labels.  The project's existing generic reference
    graph is the adoption allow-list; unrelated vault orphans are never moved.
    """
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")

    vault = vaults.get_vault(db, project.vault_id)
    if not vault:
        raise ValueError("Vault not found")
    store = vaults.vault_store(vault).resolve()
    project_root = Path(project.absolute_path).resolve()
    if not _is_within(store, project_root) or not project_root.is_dir():
        raise ValueError("Project folder is missing from its owning vault")

    project_references = (
        db.query(models.ItemReference)
        .filter(models.ItemReference.context_id == project.id)
        .all()
    )
    referenced_ids = {
        item_id
        for reference in project_references
        for item_id in (reference.from_item_id, reference.to_item_id)
        if item_id != project.id
    }
    if not referenced_ids:
        return {"project": crud.get_item(db, project.id), "adopted": 0, "item_ids": []}

    candidates = (
        db.query(models.Item)
        .filter(
            models.Item.vault_id == project.vault_id,
            models.Item.parent_id.is_(None),
            models.Item.id.in_(referenced_ids),
        )
        .order_by(models.Item.id)
        .all()
    )
    orphans = [item for item in candidates if not isinstance(item, models.FolderItem)]
    if not orphans:
        return {"project": crud.get_item(db, project.id), "adopted": 0, "item_ids": []}

    validated: list[tuple[models.Item, Path, bool]] = []
    for item in orphans:
        source = Path(item.absolute_path).resolve()
        is_external = getattr(item, "storage_mode", "managed") == "external_reference"
        if not is_external and not _is_within(store, source):
            raise ValueError(f"Orphan asset '{source.name}' is outside its owning vault")
        if not source.is_file():
            raise ValueError(f"Orphan asset '{source.name}' is missing from disk")
        validated.append((item, source, is_external))

    moves: list[tuple[Path, Path]] = []
    copied_paths: list[Path] = []
    try:
        for item, source, is_external in validated:
            destination_root = project_stage_directory(project, "source") if is_external else project_root
            destination_root.mkdir(parents=True, exist_ok=True)
            destination = destination_root / source.name
            if source.parent == project_root:
                destination = source
            elif destination.exists():
                if destination != source:
                    destination = _unique_destination(destination_root, source.name)
            if source == destination:
                destination = source
            elif is_external:
                partial = destination.with_name(f".{destination.name}.gaia-adopt-{uuid.uuid4().hex}")
                try:
                    shutil.copy2(source, partial)
                    if partial.stat().st_size != source.stat().st_size:
                        raise OSError(f"Adopted copy size does not match '{source.name}'")
                    os.replace(partial, destination)
                    copied_paths.append(destination)
                finally:
                    partial.unlink(missing_ok=True)
            else:
                source.replace(destination)
                moves.append((source, destination))
            item.absolute_path = str(destination.resolve())
            item.parent_id = project.id
            item.storage_mode = "managed"
            item.availability = "ready"
            if is_external:
                item.file_hash = integrity.calculate_file_hash(str(destination))
        db.commit()
    except Exception:
        db.rollback()
        for source, destination in reversed(moves):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.replace(source)
        for copied in copied_paths:
            copied.unlink(missing_ok=True)
        raise

    files_root = store / "files"
    for source, _ in moves:
        _remove_empty_loose_parents(source.parent, files_root)
    sync_project_manifest(db, project.id)
    return {
        "project": crud.get_item(db, project.id),
        "adopted": len(orphans),
        "item_ids": [item.id for item in orphans],
    }


def _import_external_file(db: Session, project: models.ProjectItem, source_path: str) -> models.Item:
    source = Path(collection_importer.canonical_source_path(source_path)).resolve()
    if not source.is_file() or source.suffix.lower() == ".zip":
        raise ValueError("Project paths must be regular files already in GAIA or imported separately")
    existing = crud.get_item_by_path(db, str(source), project.vault_id)
    if existing:
        return existing

    vault = vaults.get_vault(db, project.vault_id)
    store = vaults.vault_store(vault).resolve()
    destination = source if _is_within(store, source) else _unique_destination(store, source.name)
    copied = False
    if destination != source:
        shutil.copy2(source, destination)
        copied = True
    try:
        item_schema, tags = file_schema_for_path(destination, project.vault_id)
        item = crud.create_item(db, item_schema, commit=False)
        if tags:
            crud.set_item_tags(db, item.id, tags, commit=False)
        return item
    except Exception:
        if copied:
            destination.unlink(missing_ok=True)
        raise


def add_paths(db: Session, project_id: int, source_paths: list[str]):
    """Import external files into GAIA, then link them to the project."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    paths = list(dict.fromkeys(path.strip() for path in source_paths if path and path.strip()))
    if not paths:
        raise ValueError("Choose at least one file")

    def operation():
        item_ids = [_import_external_file(db, project, path).id for path in paths]
        existing = {
            row.to_item_id
            for row in db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.from_item_id == project.id,
            )
            .all()
        }
        for item_id in item_ids:
            if item_id not in existing:
                reference_service.create_reference(
                    db,
                    schemas.ProjectReferenceCreate(
                        from_item_id=project.id,
                        to_item_id=item_id,
                        relation_kind="use",
                    ),
                    context_id=project.id,
                    commit=False,
                )
        return project.id

    _run_transaction(db, operation)
    linked_items = [
        row
        for row in db.query(models.Item)
        .join(
            models.ItemReference,
            models.ItemReference.to_item_id == models.Item.id,
        )
        .filter(
            models.ItemReference.context_id == project.id,
            models.ItemReference.from_item_id == project.id,
        )
        .all()
    ]
    sync_project_manifest(db, project.id)
    return crud.get_item(db, project.id)


def create_from_items(
    db: Session,
    item_ids: list[int],
    mode: str,
    name: str | None,
    project_type: str,
    vault_id: int | None,
    move_files: bool = False,
    move_item_ids: list[int] | None = None,
):
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    by_id = {item.id: item for item in items}
    if len(by_id) != len(unique_ids):
        raise ValueError("One or more items no longer exist")
    ordered_items = [by_id[item_id] for item_id in unique_ids]
    move_item_id_set = {int(item_id) for item_id in (move_item_ids or [])}
    vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")
    if mode not in {"single", "one_per_item"}:
        raise ValueError("Unknown project creation mode")
    if mode == "single" and not (name or "").strip():
        # The library UI uses the selected item as the natural project
        # name. Keep the API equally useful for callers that omit the name.
        first_source = ordered_items[0]
        name = getattr(first_source, "title", None) or Path(first_source.absolute_path).name

    created_paths: list[Path] = []
    moved_files: list[tuple[Path, Path]] = []

    def rollback_moved_files():
        for source, destination in reversed(moved_files):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.replace(source)

    def source_project(item: models.Item, target_project: models.ProjectItem) -> models.ProjectItem | None:
        """Return the project that physically owns a selected file, if any."""
        current = item.parent
        seen: set[int] = set()
        while current is not None and current.id not in seen:
            if isinstance(current, models.ProjectItem) and current.id != target_project.id:
                return current
            seen.add(current.id)
            current = current.parent

        # Keep legacy rows safe as well: a file can be inside a project folder
        # even when its parent_id was not persisted during an older migration.
        item_path = Path(item.absolute_path).resolve()
        for candidate in db.query(models.ProjectItem).all():
            if candidate.id == target_project.id:
                continue
            project_root = Path(candidate.absolute_path).resolve()
            if item_path != project_root and _is_within(project_root, item_path):
                return candidate
        return None

    def clone_project_file(
        source: models.Item,
        source_path: Path,
        destination: Path,
        target_project: models.ProjectItem,
    ) -> models.Item:
        """Copy a project-owned file and preserve its GAIA metadata."""
        return _clone_item_file(db, source, source_path, destination, target_project.vault_id, target_project.id)

    def operation():
        project_ids: list[int] = []
        project_groups = (
            [(name or "Project", ordered_items)]
            if mode == "single"
            else [(Path(item.absolute_path).stem or Path(item.absolute_path).name, [item]) for item in ordered_items]
        )
        for project_name, sources in project_groups:
            project, path = _prepare_project(db, project_name, project_type, vault)
            created_paths.append(path)
            db.flush()
            for source in sources:
                linked_item_id = source.id
                if (move_files or source.id in move_item_id_set) and not isinstance(source, models.FolderItem):
                    source_path = Path(source.absolute_path).resolve()
                    if not source_path.is_file():
                        raise ValueError(f"'{source_path.name}' is missing from disk")
                    owning_project = source_project(source, project)
                    if owning_project is not None:
                        destination = _unique_destination(path, source_path.name)
                        linked_item_id = clone_project_file(source, source_path, destination, project).id
                    elif source.parent_id is None:
                        destination = _unique_destination(path, source_path.name)
                        source_path.replace(destination)
                        moved_files.append((source_path, destination))
                        source.absolute_path = str(destination.resolve())
                        source.vault_id = project.vault_id
                        source.parent_id = project.id

                reference_service.create_reference(
                    db,
                    schemas.ProjectReferenceCreate(
                        from_item_id=project.id,
                        to_item_id=linked_item_id,
                        relation_kind="use",
                    ),
                    context_id=project.id,
                    commit=False,
                )
            project_ids.append(project.id)
        return project_ids

    project_ids = _run_transaction(
        db,
        operation,
        created_paths,
        rollback_operation=rollback_moved_files,
    )
    result = [crud.get_item(db, project_id) for project_id in project_ids]
    for project in result:
        vaults.log_import(db, vault.id, project.absolute_path, "created", "project_created_from_items", project.id)
        sync_project_manifest(db, project.id)
    return result


def _artifact_schema_for_type(
    target_type: str,
    path: Path,
    vault_id: int,
    parent_id: int,
):
    item_schema, tags = file_schema_for_path(path, vault_id, parent_id)
    common = item_schema.model_dump() if hasattr(item_schema, "model_dump") else item_schema.dict()
    if target_type == "track":
        common["type"] = "track"
        item_schema = schemas.TrackItemCreate(**common)
    elif target_type == "sample":
        analysis = common.get("attributes", {}).get("analysis", {})
        common["type"] = "sample"
        item_schema = schemas.SampleItemCreate(
            **common,
            bpm=analysis.get("bpm"),
            key=analysis.get("key"),
            is_loop=bool(analysis.get("is_loop")),
        )
    return item_schema, tags


def register_derived_path(
    db: Session,
    project_id: int,
    request: schemas.ProjectDerivedPathRequest,
):
    """Copy an externally created result into a project and connect the graph."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    source_item = db.query(models.Item).filter(models.Item.id == request.from_item_id).first()
    if not source_item:
        raise ValueError("Source item not found")
    source_path = Path(collection_importer.canonical_source_path(request.source_path)).resolve()
    if not source_path.exists():
        raise ValueError("Derived result is missing on disk")
    if request.target_type == "multitrack":
        raise ValueError("Project stages contain generated files; multitrack folders belong in the library")
    if source_path.is_dir():
        raise ValueError("Project results must be files")
    if (
        source_path.is_file()
        and request.target_type in {"audio", "track", "sample"}
        and source_path.suffix.lower() not in collection_importer.AUDIO_EXTENSIONS
    ):
        raise ValueError("Audio, track, and sample results must point to an audio file")

    destination_root = project_stage_directory(project, request.stage_name or "derived")
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = _unique_destination(destination_root, source_path.name)
    shutil.copy2(source_path, destination)
    created_paths = [destination]

    def operation():
        item_schema, tags = _artifact_schema_for_type(
            request.target_type, destination, project.vault_id, project.id
        )
        artifact = crud.create_item(db, item_schema, commit=False)
        if tags:
            crud.set_item_tags(db, artifact.id, tags, commit=False)
        reference = reference_service.create_reference(
            db,
            schemas.ProjectReferenceCreate(
                from_item_id=source_item.id,
                to_item_id=artifact.id,
                relation_kind=request.relation_kind,
                stage_name=request.stage_name,
                revision_label=request.revision_label,
                is_master=request.is_master,
            ),
            context_id=project.id,
            commit=False,
        )
        return artifact.id, reference.id

    artifact_id, reference_id = _run_transaction(db, operation, created_paths)
    reference = db.query(models.ItemReference).filter(models.ItemReference.id == reference_id).first()
    sync_project_manifest(db, project.id)
    return crud.get_item(db, artifact_id), reference
