"""Lightweight, non-blocking synchronization between local vault folders and the database."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from . import crud, models, project_service, reference_service, schemas, vaults


IGNORE_EXTENSIONS = {
    ".asd",
    ".bak",
    ".crdownload",
    ".part",
    ".peak",
    ".pkf",
    ".reapeaks",
    ".tmp",
}

IGNORE_FILENAMES = {
    ".ds_store",
    ".gitignore",
    ".gitkeep",
    "current.json",
    "desktop.ini",
    "manifest.json",
    "thumbs.db",
}

IGNORE_DIRNAMES = {
    ".gaia",
    ".git",
    ".pytest_cache",
    ".sin",
    "__pycache__",
    "node_modules",
}


def _resolve_container_and_project(
    db: Session,
    vault_id: int,
    file_path: Path,
    store: Path,
) -> tuple[models.Item | None, models.ProjectItem | None]:
    """Find the nearest enclosing container item and owning project for a file path in a vault."""
    try:
        current = file_path.parent.resolve()
        store_resolved = store.resolve()
    except OSError:
        return None, None

    parent_item: models.Item | None = None
    while current != store_resolved and _is_relative_to(current, store_resolved):
        folder_item = (
            db.query(models.Item)
            .filter(
                models.Item.vault_id == vault_id,
                models.Item.absolute_path == str(current),
            )
            .first()
        )
        if folder_item:
            parent_item = folder_item
            break
        current = current.parent

    if not parent_item:
        return None, None

    owning_project: models.ProjectItem | None = None
    if isinstance(parent_item, models.ProjectItem) or getattr(parent_item, "type", None) == "project":
        owning_project = parent_item
    else:
        owning_project = project_service._find_owning_project(db, parent_item)

    return parent_item, owning_project


def _establish_project_reference(
    db: Session,
    owning_project: models.ProjectItem,
    item: models.Item,
    parent_item: models.Item | None = None,
) -> models.ItemReference:
    """Link a newly added or existing project item via ItemReference with version compatibility."""
    existing_ref = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == owning_project.id,
            models.ItemReference.to_item_id == item.id,
        )
        .first()
    )
    if existing_ref:
        return existing_ref

    info = reference_service.file_version_info(item.absolute_path)
    version_group = info.get("group")

    matching_ref: models.ItemReference | None = None
    if version_group:
        project_refs = (
            db.query(models.ItemReference)
            .filter(models.ItemReference.context_id == owning_project.id)
            .all()
        )
        for ref in project_refs:
            ref_item = db.query(models.Item).filter(models.Item.id == ref.to_item_id).first()
            if ref_item:
                ref_info = reference_service.file_version_info(ref_item.absolute_path)
                if ref_info.get("group") == version_group:
                    matching_ref = ref
                    break

    folder_label: str | None = None
    if parent_item and parent_item.id != owning_project.id:
        folder_label = getattr(parent_item, "title", None) or Path(parent_item.absolute_path).name

    if matching_ref:
        ref_attrs = dict(matching_ref.attributes or {})
        if folder_label:
            ref_attrs["folder"] = folder_label

        ref = reference_service.create_reference(
            db,
            schemas.ProjectReferenceCreate(
                from_item_id=owning_project.id,
                to_item_id=item.id,
                relation_kind=matching_ref.relation_kind or "use",
                stage_name=matching_ref.stage_name,
                revision_label=matching_ref.revision_label,
                tags=reference_service.relation_tags(matching_ref),
                attributes=ref_attrs,
            ),
            context_id=owning_project.id,
            commit=False,
        )
    else:
        stage_name = None
        try:
            rel = Path(item.absolute_path).resolve().relative_to(Path(owning_project.absolute_path).resolve())
            parts = rel.parts
            if len(parts) > 2 and parts[0] == "files":
                stage_name = parts[1]
        except (ValueError, IndexError):
            pass

        ref_attrs = {"folder": folder_label} if folder_label else {}
        ref = reference_service.create_reference(
            db,
            schemas.ProjectReferenceCreate(
                from_item_id=owning_project.id,
                to_item_id=item.id,
                relation_kind="use",
                stage_name=stage_name,
                attributes=ref_attrs,
            ),
            context_id=owning_project.id,
            commit=False,
        )

    return ref


def infer_file_type(filename: str) -> str:
    """Infer the default GAIA item polymorphic type from the file extension."""
    ext = Path(filename).suffix.lower()
    if ext in {".wav", ".mp3", ".flac", ".ogg", ".aif", ".aiff", ".m4a", ".aac"}:
        return "sample"
    if ext in {".mid", ".midi"}:
        return "midi"
    if ext == ".seq":
        return "sequence"
    return "item"


def _is_relative_to(candidate: Path, base: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def scan_vault_discrepancies(db: Session, vault_id: int) -> dict[str, Any]:
    """Compare the physical vault store directory against database items.

    Returns detected untracked files, missing items, and suggested relinkings.
    """
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")

    store = vaults.vault_store(vault).resolve()
    if not store.exists() or not store.is_dir():
        return {
            "vault_id": vault_id,
            "vault_name": vault.name,
            "in_sync": False,
            "untracked": [],
            "missing": [],
            "moved": [],
            "total_discrepancies": 0,
            "error": "Vault storage directory does not exist on disk",
        }

    # 1. Gather all legitimate physical files on disk
    disk_files: dict[str, dict[str, Any]] = {}
    for root_dir, dirs, files in os.walk(store, topdown=True):
        # Prune ignored directories
        dirs[:] = [
            d for d in sorted(dirs)
            if d not in IGNORE_DIRNAMES and not d.startswith((".", ".deleting-"))
        ]

        for filename in sorted(files):
            if filename.lower() in IGNORE_FILENAMES or filename.startswith((".", "._", "~$")):
                continue
            ext = Path(filename).suffix.lower()
            if ext in IGNORE_EXTENSIONS:
                continue

            file_path = Path(root_dir) / filename
            try:
                stat_res = file_path.stat()
            except OSError:
                continue

            resolved = file_path.resolve()
            norm_key = os.path.normcase(str(resolved))
            rel_path = str(resolved.relative_to(store)).replace("\\", "/")

            disk_files[norm_key] = {
                "path": str(resolved),
                "filename": filename,
                "relative_path": rel_path,
                "size_bytes": stat_res.st_size,
                "type": infer_file_type(filename),
                "extension": ext,
            }

    # 2. Query all database items owned by this vault
    db_items = db.query(models.Item).filter(models.Item.vault_id == vault_id).all()

    missing_list: list[dict[str, Any]] = []
    restorable_item_ids: list[int] = []

    for item in db_items:
        if isinstance(item, models.FolderItem):
            # Collections/folders are containers rather than physical asset leaves
            continue

        item_resolved = Path(item.absolute_path).resolve()
        item_norm_key = os.path.normcase(str(item_resolved))

        if item_norm_key in disk_files:
            # File exists on disk as expected
            if item.availability == "missing":
                restorable_item_ids.append(item.id)
            # Remove from disk_files so remaining are untracked
            del disk_files[item_norm_key]
        else:
            # Check if it physically exists elsewhere (e.g. external reference)
            if not item_resolved.exists():
                rel_path = (
                    str(item_resolved.relative_to(store)).replace("\\", "/")
                    if _is_relative_to(item_resolved, store)
                    else None
                )
                missing_list.append({
                    "id": item.id,
                    "path": item.absolute_path,
                    "filename": item_resolved.name,
                    "relative_path": rel_path,
                    "type": item.type,
                    "size_bytes": item.size_bytes,
                    "title": getattr(item, "title", None) or item_resolved.name,
                })

    untracked_list = list(disk_files.values())

    # 3. Detect candidate renames/moves (same size and extension)
    moved_list: list[dict[str, Any]] = []
    matched_untracked_keys: set[str] = set()

    for missing in missing_list:
        if not missing.get("size_bytes"):
            continue
        missing_ext = Path(missing["filename"]).suffix.lower()
        candidates = [
            u for u in untracked_list
            if u["path"] not in matched_untracked_keys
            and u["size_bytes"] == missing["size_bytes"]
            and u["extension"] == missing_ext
        ]

        if len(candidates) == 1:
            match = candidates[0]
            matched_untracked_keys.add(match["path"])
            moved_list.append({
                "item_id": missing["id"],
                "old_path": missing["path"],
                "new_path": match["path"],
                "filename": match["filename"],
                "size_bytes": match["size_bytes"],
            })

    total_discrepancies = len(untracked_list) + len(missing_list)

    return {
        "vault_id": vault_id,
        "vault_name": vault.name,
        "in_sync": total_discrepancies == 0,
        "untracked": untracked_list,
        "missing": missing_list,
        "moved": moved_list,
        "total_discrepancies": total_discrepancies,
    }


def reconcile_vault(
    db: Session,
    vault_id: int,
    request: schemas.VaultReconcileRequest,
) -> schemas.VaultReconcileResponse:
    """Apply requested reconciliation operations to the vault and database."""
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")

    store = vaults.vault_store(vault).resolve()
    affected_project_ids: set[int] = set()

    added_count = 0
    marked_missing_count = 0
    purged_count = 0
    relinked_count = 0

    relinked_item_ids: set[int] = set()
    relinked_paths: set[str] = set()

    # 0. Self-heal existing vault items whose parent_id is None but are physically inside a container
    orphaned_vault_items = (
        db.query(models.Item)
        .filter(
            models.Item.vault_id == vault_id,
            models.Item.parent_id.is_(None),
        )
        .all()
    )
    for item in orphaned_vault_items:
        if isinstance(item, models.FolderItem) or getattr(item, "type", None) in {"project", "collection", "folder"}:
            continue
        item_path = Path(item.absolute_path)
        parent_item, owning_project = _resolve_container_and_project(db, vault_id, item_path, store)
        if parent_item:
            item.parent_id = parent_item.id
            if owning_project:
                _establish_project_reference(db, owning_project, item, parent_item)
                affected_project_ids.add(owning_project.id)

    # 1. Relink moved/renamed items
    if request.relink_moved:
        for pair in request.relink_moved:
            item = db.query(models.Item).filter(
                models.Item.id == pair.item_id,
                models.Item.vault_id == vault_id,
            ).first()
            if not item:
                continue

            target_path = Path(pair.new_path).resolve()
            if not target_path.exists() or not target_path.is_file():
                continue

            item.absolute_path = str(target_path)
            try:
                item.size_bytes = target_path.stat().st_size
            except OSError:
                pass
            item.availability = "ready"

            parent_item, owning_project = _resolve_container_and_project(db, vault_id, target_path, store)
            item.parent_id = parent_item.id if parent_item else None
            if owning_project:
                _establish_project_reference(db, owning_project, item, parent_item)
                affected_project_ids.add(owning_project.id)

            relinked_item_ids.add(item.id)
            relinked_paths.add(os.path.normcase(str(target_path)))
            relinked_count += 1

    # 2. Add untracked files
    paths_to_add: list[str] = []
    if request.add_all_untracked:
        scan = scan_vault_discrepancies(db, vault_id)
        paths_to_add.extend(
            u["path"] for u in scan.get("untracked", [])
            if os.path.normcase(u["path"]) not in relinked_paths
        )
    elif request.add_untracked:
        paths_to_add.extend(request.add_untracked)

    for file_path_str in paths_to_add:
        file_path = Path(file_path_str).resolve()
        norm_key = os.path.normcase(str(file_path))
        if norm_key in relinked_paths:
            continue
        if not file_path.exists() or not file_path.is_file():
            continue

        parent_item, owning_project = _resolve_container_and_project(db, vault_id, file_path, store)
        resolved_parent_id = parent_item.id if parent_item else None

        # Check if already registered
        existing = db.query(models.Item).filter(
            models.Item.vault_id == vault_id,
            models.Item.absolute_path == str(file_path),
        ).first()
        if existing:
            if existing.availability != "ready":
                existing.availability = "ready"
            if existing.parent_id != resolved_parent_id:
                existing.parent_id = resolved_parent_id
            if owning_project:
                _establish_project_reference(db, owning_project, existing, parent_item)
                affected_project_ids.add(owning_project.id)
            continue

        item_type = infer_file_type(file_path.name)
        file_size = file_path.stat().st_size
        mime_type = mimetypes.guess_type(str(file_path))[0]

        schema = schemas.ItemCreate(
            absolute_path=str(file_path),
            vault_id=vault_id,
            parent_id=resolved_parent_id,
            type=item_type,
            size_bytes=file_size,
            storage_mode="managed",
            availability="ready",
            mime_type=mime_type or ("audio/wav" if item_type in {"audio", "sample", "track"} else None),
        )

        new_item = crud.create_item(db, schema, commit=False)
        added_count += 1

        if owning_project:
            _establish_project_reference(db, owning_project, new_item, parent_item)
            affected_project_ids.add(owning_project.id)

    # 3. Mark missing items
    ids_to_mark: set[int] = set()
    if request.mark_all_missing:
        scan = scan_vault_discrepancies(db, vault_id)
        ids_to_mark.update(
            m["id"] for m in scan.get("missing", [])
            if m["id"] not in relinked_item_ids
        )
    elif request.mark_missing:
        ids_to_mark.update(
            item_id for item_id in request.mark_missing
            if item_id not in relinked_item_ids
        )

    for item_id in ids_to_mark:
        item = db.query(models.Item).filter(
            models.Item.id == item_id,
            models.Item.vault_id == vault_id,
        ).first()
        if item and item.availability != "missing":
            item.availability = "missing"
            marked_missing_count += 1

    # 4. Purge missing items (confirmed deletion)
    if request.purge_missing:
        for item_id in request.purge_missing:
            item = db.query(models.Item).filter(
                models.Item.id == item_id,
                models.Item.vault_id == vault_id,
            ).first()
            if not item:
                continue

            # Clear references and associations
            db.execute(models.item_tags.delete().where(models.item_tags.c.item_id == item.id))
            db.query(models.ItemReference).filter(
                (models.ItemReference.from_item_id == item.id) |
                (models.ItemReference.to_item_id == item.id)
            ).delete(synchronize_session=False)

            db.delete(item)
            purged_count += 1

    for pid in affected_project_ids:
        try:
            project_service.sync_project_manifest(db, pid)
        except Exception:
            pass

    db.commit()

    # Re-evaluate sync state
    updated_scan = scan_vault_discrepancies(db, vault_id)

    return schemas.VaultReconcileResponse(
        vault_id=vault_id,
        added_count=added_count,
        marked_missing_count=marked_missing_count,
        purged_count=purged_count,
        relinked_count=relinked_count,
        in_sync=bool(updated_scan.get("in_sync", True)),
    )
