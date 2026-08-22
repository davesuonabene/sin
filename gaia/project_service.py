"""Project workspaces, read-only source links, and project-owned artifacts."""

from __future__ import annotations

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
    multitrack_analyzer,
    reference_service,
    schemas,
    text_analyzer,
    type_registry,
    vaults,
)


PROJECT_FILES_DIRECTORY = "files"
PROJECT_SOURCES_DIRECTORY = "sources"


def _safe_name(value: str, *, field_name: str = "Name") -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (value or "").strip()).strip(". ")
    name = re.sub(r"\s+", " ", name)
    if not name:
        raise ValueError(f"{field_name} cannot be empty")
    if len(name) > 100:
        raise ValueError(f"{field_name} must be 100 characters or fewer")
    return name


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


def _run_transaction(db: Session, operation, created_paths: list[Path] | None = None):
    created = created_paths if created_paths is not None else []
    try:
        result = operation()
        db.commit()
        return result
    except Exception:
        db.rollback()
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
    regenerate_markdown(db, project.id)
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
        regenerate_markdown(db, project.id)
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

    regenerate_markdown(db, project.id)
    return crud.get_item(db, project.id)


def regenerate_markdown(db: Session, project_id: int):
    from . import project_markdown

    return project_markdown.write_project_context(db, project_id)


def _apply_source_profile_defaults(
    db: Session,
    project_id: int,
    source_items: list[models.Item],
) -> None:
    """Materialize a matched source profile without adding anything to the source.

    A profile may nominate a default master (the Zoom H4 mixdown, for example).
    The first matching source receives that default only while the project has
    no user-selected master; later source links never replace it.
    """
    has_master = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project_id,
            models.ItemReference.is_master.is_(True),
        )
        .first()
        is not None
    )
    for source in source_items:
        profile_id = source.attributes.get("profile_id")
        if not profile_id:
            continue
        reference_service.apply_profile(
            db,
            project_id,
            source.id,
            profile_id,
            mark_suggested_master=not has_master,
        )
        has_master = has_master or (
            db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project_id,
                models.ItemReference.is_master.is_(True),
            )
            .first()
            is not None
        )


def add_items(db: Session, project_id: int, item_ids: list[int]):
    """Link existing library items as read-only project sources."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one source item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    if len(items) != len(unique_ids):
        raise ValueError("One or more source items no longer exist")

    existing_sources = {
        row.to_item_id
        for row in db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project_id,
            models.ItemReference.relation_kind == "source",
        )
        .all()
    }

    def operation():
        for item in items:
            if item.id in existing_sources:
                continue
            reference_service.create_source_reference(db, project.id, item.id, commit=False)
        return project.id

    _run_transaction(db, operation)
    _apply_source_profile_defaults(db, project.id, items)
    regenerate_markdown(db, project.id)
    return crud.get_item(db, project.id)


def _source_reference_exists(db: Session, context_id: int, item_id: int) -> bool:
    return (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == context_id,
            models.ItemReference.from_item_id == context_id,
            models.ItemReference.to_item_id == item_id,
            models.ItemReference.relation_kind == "source",
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


def place_items(db: Session, target_id: int, item_ids: list[int], mode: str) -> dict:
    """Place library items in a folder by physical move or source reference."""
    target = db.query(models.FolderItem).filter(models.FolderItem.id == target_id).first()
    if not target:
        raise ValueError("Target folder not found")
    if mode not in {"move", "reference"}:
        raise ValueError("Choose either a full move or a reference")

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

    if mode == "reference":
        def link_operation():
            for item in ordered_items:
                if not _source_reference_exists(db, target.id, item.id):
                    reference_service.create_source_reference(db, target.id, item.id, commit=False)
            return target.id

        _run_transaction(db, link_operation)
        if isinstance(target, models.ProjectItem):
            _apply_source_profile_defaults(db, target.id, ordered_items)
            regenerate_markdown(db, target.id)
        return {
            "target": crud.get_item(db, target.id),
            "mode": mode,
            "item_ids": unique_ids,
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
    destination_root = target_root / PROJECT_SOURCES_DIRECTORY if isinstance(target, models.ProjectItem) else target_root

    validated: list[tuple[models.Item, Path]] = []
    for item in moved_items:
        source_vault = vaults.get_vault(db, item.vault_id)
        source = Path(item.absolute_path).resolve()
        if not source_vault or not _is_within(vaults.vault_store(source_vault), source):
            raise ValueError(f"'{source.name}' is outside its owning vault")
        if not source.exists():
            raise ValueError(f"'{source.name}' is missing from disk")
        if _is_within(source, target_root):
            raise ValueError("A folder cannot be moved into one of its descendants")
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
            if not _source_reference_exists(db, target.id, item.id):
                reference_service.create_source_reference(db, target.id, item.id, commit=False)

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

    if isinstance(target, models.ProjectItem):
        _apply_source_profile_defaults(db, target.id, moved_items)
        regenerate_markdown(db, target.id)
    return {
        "target": crud.get_item(db, target.id),
        "mode": mode,
        "item_ids": [item.id for item in moved_items],
    }


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

    sources_root = project_root / PROJECT_SOURCES_DIRECTORY
    validated: list[tuple[models.Item, Path]] = []
    for item in orphans:
        source = Path(item.absolute_path).resolve()
        if not _is_within(store, source):
            raise ValueError(f"Orphan asset '{source.name}' is outside its owning vault")
        if not source.is_file():
            raise ValueError(f"Orphan asset '{source.name}' is missing from disk")
        validated.append((item, source))

    moves: list[tuple[Path, Path]] = []
    created_sources_root = not sources_root.exists()
    try:
        sources_root.mkdir(parents=False, exist_ok=True)
        for item, source in validated:
            if source.parent == sources_root:
                destination = source
            else:
                destination = _unique_destination(sources_root, source.name)
                source.replace(destination)
                moves.append((source, destination))
            item.absolute_path = str(destination.resolve())
            item.parent_id = project.id
        db.commit()
    except Exception:
        db.rollback()
        for source, destination in reversed(moves):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.replace(source)
        if created_sources_root:
            try:
                sources_root.rmdir()
            except OSError:
                pass
        raise

    files_root = store / "files"
    for source, _ in moves:
        _remove_empty_loose_parents(source.parent, files_root)
    regenerate_markdown(db, project.id)
    return {
        "project": crud.get_item(db, project.id),
        "adopted": len(orphans),
        "item_ids": [item.id for item in orphans],
    }


def _import_external_file_as_source(db: Session, project: models.ProjectItem, source_path: str) -> models.Item:
    source = Path(collection_importer.canonical_source_path(source_path)).resolve()
    if not source.is_file() or source.suffix.lower() == ".zip":
        raise ValueError("Project source paths must be regular files already in GAIA or imported separately")
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
    """Import external files into GAIA, then link them as read-only sources."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    paths = list(dict.fromkeys(path.strip() for path in source_paths if path and path.strip()))
    if not paths:
        raise ValueError("Choose at least one source file")

    def operation():
        item_ids = [_import_external_file_as_source(db, project, path).id for path in paths]
        existing = {
            row.to_item_id
            for row in db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.relation_kind == "source",
            )
            .all()
        }
        for item_id in item_ids:
            if item_id not in existing:
                reference_service.create_source_reference(db, project.id, item_id, commit=False)
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
            models.ItemReference.relation_kind == "source",
        )
        .all()
    ]
    _apply_source_profile_defaults(db, project.id, linked_items)
    regenerate_markdown(db, project.id)
    return crud.get_item(db, project.id)


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
        raise ValueError("Select at least one source item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    by_id = {item.id: item for item in items}
    if len(by_id) != len(unique_ids):
        raise ValueError("One or more source items no longer exist")
    ordered_items = [by_id[item_id] for item_id in unique_ids]
    vault = vaults.ensure_default_vault(db) if vault_id is None else vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")
    if mode not in {"single", "one_per_item"}:
        raise ValueError("Unknown project creation mode")
    if mode == "single" and not (name or "").strip():
        # The library UI uses the selected source as the natural project
        # name. Keep the API equally useful for callers that omit the name.
        first_source = ordered_items[0]
        name = getattr(first_source, "title", None) or Path(first_source.absolute_path).name

    created_paths: list[Path] = []

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
                reference_service.create_source_reference(db, project.id, source.id, commit=False)
            project_ids.append(project.id)
        return project_ids

    project_ids = _run_transaction(db, operation, created_paths)
    result = [crud.get_item(db, project_id) for project_id in project_ids]
    for project in result:
        vaults.log_import(db, vault.id, project.absolute_path, "created", "project_created_from_sources", project.id)
        source_items = [
            source
            for source in ordered_items
            if db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.to_item_id == source.id,
                models.ItemReference.relation_kind == "source",
            )
            .first()
        ]
        _apply_source_profile_defaults(db, project.id, source_items)
        regenerate_markdown(db, project.id)
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
    if source_path.is_dir() and request.target_type != "multitrack":
        raise ValueError("A derived folder must be registered as a multitrack")
    if source_path.is_file() and request.target_type == "multitrack":
        raise ValueError("A multitrack result must be a folder")
    if (
        source_path.is_file()
        and request.target_type in {"audio", "track", "sample"}
        and source_path.suffix.lower() not in collection_importer.AUDIO_EXTENSIONS
    ):
        raise ValueError("Audio, track, and sample results must point to an audio file")

    stage = _safe_name(request.stage_name or "derived", field_name="Stage name")
    project_root = Path(project.absolute_path).resolve()
    destination_root = project_root / PROJECT_FILES_DIRECTORY / stage
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = _unique_destination(destination_root, source_path.name)
    if source_path.is_dir():
        shutil.copytree(source_path, destination)
    else:
        shutil.copy2(source_path, destination)
    created_paths = [destination]

    def operation():
        if request.target_type == "multitrack":
            manifest = collection_importer.build_manifest(destination)
            analysis = multitrack_analyzer.analyze_multitrack_folder(str(destination), recursive=False)
            artifact = crud.create_item(
                db,
                schemas.MultitrackItemCreate(
                    absolute_path=str(destination.resolve()),
                    vault_id=project.vault_id,
                    parent_id=project.id,
                    size_bytes=sum(entry.get("size_bytes") or 0 for entry in manifest),
                    mime_type="inode/directory",
                    title=destination.name,
                    source_kind="managed",
                    source_path=str(destination.resolve()),
                    contents=manifest,
                    stems=analysis.get("stems", []),
                    key=analysis.get("key"),
                    bpm=analysis.get("bpm"),
                    is_valid_length=bool(analysis.get("is_valid_length", True)),
                    length_variance=float(analysis.get("length_variance") or 0.0),
                    warnings=[],
                ),
                commit=False,
            )
            for entry in manifest:
                relative = entry.get("relative_path")
                if not relative:
                    continue
                child_path = destination / relative
                item_schema, tags = file_schema_for_path(child_path, project.vault_id, artifact.id)
                child = crud.create_item(db, item_schema, commit=False)
                if tags:
                    crud.set_item_tags(db, child.id, tags, commit=False)
                entry["child_id"] = child.id
            crud.save_collection_contents(db, artifact, manifest, commit=False)
        else:
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
    regenerate_markdown(db, project.id)
    return crud.get_item(db, artifact_id), reference
