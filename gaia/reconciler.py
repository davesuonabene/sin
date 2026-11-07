"""Lightweight, non-blocking synchronization between local vault folders and the database."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
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
    ".lnk",
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
    "project.json",
    "thumbs.db",
}

IGNORE_DIRNAMES = {
    ".gaia",
    ".git",
    ".pytest_cache",
    ".sin",
    "__pycache__",
    "auto-backups",
    "node_modules",
}


def _resolve_container_and_project(
    db: Session,
    vault_id: int,
    file_path: Path,
    store: Path,
    *,
    create_missing_folders: bool = False,
) -> tuple[models.Item | None, models.ProjectItem | None]:
    """Find (or synthesize) the nearest enclosing container item and owning project for a file path in a vault."""
    import json
    try:
        current = file_path.parent.resolve()
        store_resolved = store.resolve()
    except OSError:
        return None, None

    if current == store_resolved or not _is_relative_to(current, store_resolved):
        return None, None

    parent_item: models.Item | None = None
    probe = current
    while probe != store_resolved and _is_relative_to(probe, store_resolved):
        folder_item = (
            db.query(models.Item)
            .filter(
                models.Item.vault_id == vault_id,
                models.Item.absolute_path == str(probe),
            )
            .first()
        )
        if folder_item:
            parent_item = folder_item
            break
        probe = probe.parent

    owning_project: models.ProjectItem | None = None
    if parent_item:
        if isinstance(parent_item, models.ProjectItem) or getattr(parent_item, "type", None) == "project":
            owning_project = parent_item
        else:
            owning_project = project_service._find_owning_project(db, parent_item)

    # Synthesize missing intermediate FolderItem rows for normal vault directories
    is_domain_container = (
        owning_project is not None
        or (parent_item is not None and getattr(parent_item, "type", None) in {"project", "multitrack", "zoom_h4"})
    )
    if create_missing_folders and not is_domain_container:
        rel_parts = current.relative_to(store_resolved).parts
        curr_parent_id: int | None = None
        curr_folder: models.Item | None = None
        for idx in range(len(rel_parts)):
            sub_dir = (store_resolved / Path(*rel_parts[: idx + 1])).resolve()
            existing = (
                db.query(models.FolderItem)
                .filter(
                    models.FolderItem.vault_id == vault_id,
                    models.FolderItem.absolute_path == str(sub_dir),
                )
                .first()
            )
            if not existing:
                existing = models.FolderItem(
                    absolute_path=str(sub_dir),
                    vault_id=vault_id,
                    parent_id=curr_parent_id,
                    title=sub_dir.name,
                    source_kind="managed",
                    source_path=str(sub_dir),
                    content_count=0,
                    type="folder",
                    storage_mode="managed",
                    availability="ready",
                    metadata_json=json.dumps({
                        "is_folder": True,
                        "profile_id": "folder",
                        "profile_label": "Folder",
                    }),
                )
                db.add(existing)
                db.flush()
            curr_folder = existing
            curr_parent_id = existing.id
        if curr_folder is not None:
            parent_item = curr_folder

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


def _walk_vault_store_files(
    store_str: str,
    vault_id: int,
    vault_name: str,
) -> dict[str, dict[str, Any]]:
    """Fast iterative os.scandir walker using cached DirEntry.stat without per-file Path.resolve()."""
    disk_files: dict[str, dict[str, Any]] = {}
    stack = [store_str]
    entries_collected: list[tuple[str, str, str, int, str]] = []
    prefix_len = len(store_str) + 1

    while stack:
        curr_dir = stack.pop()
        try:
            with os.scandir(curr_dir) as it:
                subdirs: list[str] = []
                for entry in it:
                    name = entry.name
                    if entry.is_dir(follow_symlinks=False):
                        if name not in IGNORE_DIRNAMES and not name.startswith((".", ".deleting-")):
                            subdirs.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if name.lower() in IGNORE_FILENAMES or name.startswith((".", "._", "~$")):
                            continue
                        ext = os.path.splitext(name)[1].lower()
                        if ext in IGNORE_EXTENSIONS:
                            continue
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        norm_p = os.path.normpath(entry.path)
                        rel_p = norm_p[prefix_len:].replace("\\", "/") if len(norm_p) > prefix_len else name
                        entries_collected.append((norm_p, name, rel_p, st.st_size, ext))
                for subdir in sorted(subdirs, reverse=True):
                    stack.append(subdir)
        except OSError:
            continue

    entries_collected.sort(key=lambda x: x[0])
    for norm_p, name, rel_p, st_size, ext in entries_collected:
        norm_key = os.path.normcase(norm_p)
        disk_files[norm_key] = {
            "path": norm_p,
            "filename": name,
            "relative_path": rel_p,
            "size_bytes": st_size,
            "type": infer_file_type(name),
            "extension": ext,
            "vault_id": vault_id,
            "vault_name": vault_name,
        }
    return disk_files


def _extract_item_title(metadata_json: str | None, fallback_name: str) -> str:
    if metadata_json and '"title"' in metadata_json:
        try:
            meta = json.loads(metadata_json)
            if isinstance(meta, dict) and meta.get("title"):
                return str(meta["title"])
        except Exception:
            pass
    return fallback_name


def scan_vault_discrepancies(
    db: Session,
    vault_id: int,
    *,
    preloaded_vault: models.Vault | None = None,
    preloaded_rows: list[tuple[Any, ...]] | None = None,
    preloaded_mirrors: list[models.VaultMirror] | None = None,
    preloaded_disk_files: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Compare the physical vault store directory against database items.

    Returns detected untracked files, missing items, and suggested relinkings.
    """
    vault = preloaded_vault or vaults.get_vault(db, vault_id)
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
            "mirrors": [],
            "total_discrepancies": 0,
            "error": "Vault storage directory does not exist on disk",
        }

    store_str = os.path.normpath(str(store))
    store_norm_prefix = os.path.normcase(store_str) + os.sep

    # 1. Gather all legitimate physical files on disk
    disk_files = (
        dict(preloaded_disk_files)
        if preloaded_disk_files is not None
        else _walk_vault_store_files(store_str, vault_id, vault.name)
    )

    # 2. Query lightweight scalar rows for all database items owned by this vault
    if preloaded_rows is None:
        preloaded_rows = (
            db.query(
                models.Item.id,
                models.Item.absolute_path,
                models.Item.type,
                models.Item.storage_mode,
                models.Item.availability,
                models.Item.size_bytes,
                models.Item.file_hash,
                models.Item.metadata_json,
            )
            .filter(models.Item.vault_id == vault_id)
            .all()
        )

    # 3. Scan configured VaultMirrors first so mirrored external items and offline drives are handled accurately
    from . import mirrors as mirrors_service

    vault_mirrors = (
        preloaded_mirrors
        if preloaded_mirrors is not None
        else mirrors_service.list_vault_mirrors(db, vault_id)
    )
    mirror_statuses = [
        mirrors_service.scan_mirror_discrepancies(
            db,
            m,
            preloaded_rows=preloaded_rows,
            vault_name=vault.name,
        )
        for m in vault_mirrors
    ]
    mirror_prefixes = [
        os.path.normcase(os.path.normpath(str(Path(m.source_path).resolve()))) + os.sep
        for m in vault_mirrors
        if m.source_path
    ]

    missing_list: list[dict[str, Any]] = []
    restorable_item_ids: list[int] = []
    prefix_len = len(store_str) + 1

    for row in preloaded_rows:
        item_id, abs_path, item_type, storage_mode, availability, size_bytes, _file_hash, metadata_json = row
        if item_type in {"folder", "collection", "project", "multitrack", "zoom_h4"}:
            # Containers/directories are not leaf files in disk_files
            continue

        norm_abs = os.path.normpath(abs_path)
        item_norm_key = os.path.normcase(norm_abs)

        if item_norm_key in disk_files:
            if availability == "missing":
                restorable_item_ids.append(item_id)
            del disk_files[item_norm_key]
        else:
            # If this external_reference item is inside a configured VaultMirror,
            # its sync status is reported under mirror_statuses (preserving offline protection).
            if (storage_mode or "managed") == "external_reference":
                if any(item_norm_key.startswith(m_prefix) for m_prefix in mirror_prefixes):
                    continue
            # Check if it physically exists elsewhere (e.g. standalone external reference)
            if not os.path.exists(norm_abs):
                rel_path = (
                    norm_abs[prefix_len:].replace("\\", "/")
                    if item_norm_key.startswith(store_norm_prefix) and len(norm_abs) > prefix_len
                    else None
                )
                fname = os.path.basename(norm_abs)
                missing_list.append({
                    "id": item_id,
                    "path": abs_path,
                    "filename": fname,
                    "relative_path": rel_path,
                    "type": item_type,
                    "size_bytes": size_bytes,
                    "title": _extract_item_title(metadata_json, fname),
                    "vault_id": vault_id,
                    "vault_name": vault.name,
                })

    untracked_list = list(disk_files.values())

    # 4. Detect candidate renames/moves (same size and extension)
    moved_list: list[dict[str, Any]] = []
    matched_untracked_keys: set[str] = set()

    for missing in missing_list:
        if not missing.get("size_bytes"):
            continue
        missing_ext = os.path.splitext(missing["filename"])[1].lower()
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
                "vault_id": vault_id,
                "vault_name": vault.name,
            })

    mirror_discrepancy_count = sum(int(m.get("total_discrepancies", 0)) for m in mirror_statuses)
    total_discrepancies = len(untracked_list) + len(missing_list) + mirror_discrepancy_count

    return {
        "vault_id": vault_id,
        "vault_name": vault.name,
        "in_sync": total_discrepancies == 0,
        "untracked": untracked_list,
        "missing": missing_list,
        "moved": moved_list,
        "mirrors": mirror_statuses,
        "total_discrepancies": total_discrepancies,
    }


def scan_all_vaults_discrepancies(
    db: Session,
    vault_ids: list[int] | None = None,
) -> dict[str, Any]:
    """Scan all vaults (or a subset) in parallel using a single bulk DB query + concurrent directory walks."""
    all_vaults = vaults.get_vaults(db)
    if vault_ids is not None:
        wanted = {int(vid) for vid in vault_ids}
        all_vaults = [v for v in all_vaults if v.id in wanted]

    if not all_vaults:
        return {
            "vault_id": 0,
            "vault_name": "All Vaults",
            "in_sync": True,
            "untracked": [],
            "missing": [],
            "moved": [],
            "mirrors": [],
            "total_discrepancies": 0,
        }

    if len(all_vaults) == 1:
        return scan_vault_discrepancies(db, all_vaults[0].id, preloaded_vault=all_vaults[0])

    v_ids = [v.id for v in all_vaults]
    rows_by_vault: dict[int, list[tuple[Any, ...]]] = {v.id: [] for v in all_vaults}
    for row in (
        db.query(
            models.Item.vault_id,
            models.Item.id,
            models.Item.absolute_path,
            models.Item.type,
            models.Item.storage_mode,
            models.Item.availability,
            models.Item.size_bytes,
            models.Item.file_hash,
            models.Item.metadata_json,
        )
        .filter(models.Item.vault_id.in_(v_ids))
        .all()
    ):
        rows_by_vault.setdefault(row[0], []).append(row[1:])

    mirrors_by_vault: dict[int, list[models.VaultMirror]] = {v.id: [] for v in all_vaults}
    for m in (
        db.query(models.VaultMirror)
        .filter(models.VaultMirror.vault_id.in_(v_ids))
        .order_by(models.VaultMirror.id.asc())
        .all()
    ):
        mirrors_by_vault.setdefault(m.vault_id, []).append(m)

    # Walk physical vault directories concurrently (os.scandir releases the GIL)
    walk_targets: list[tuple[int, str, str]] = []
    for v in all_vaults:
        store = vaults.vault_store(v).resolve()
        if store.exists() and store.is_dir():
            walk_targets.append((v.id, os.path.normpath(str(store)), v.name))

    disk_by_vault: dict[int, dict[str, dict[str, Any]]] = {}
    if walk_targets:
        with ThreadPoolExecutor(max_workers=min(8, len(walk_targets))) as pool:
            futures = {
                vid: pool.submit(_walk_vault_store_files, store_str, vid, vname)
                for vid, store_str, vname in walk_targets
            }
            for vid, fut in futures.items():
                disk_by_vault[vid] = fut.result()

    combined_untracked: list[dict[str, Any]] = []
    combined_missing: list[dict[str, Any]] = []
    combined_moved: list[dict[str, Any]] = []
    combined_mirrors: list[dict[str, Any]] = []
    total_discrepancies = 0

    for v in all_vaults:
        status = scan_vault_discrepancies(
            db,
            v.id,
            preloaded_vault=v,
            preloaded_rows=rows_by_vault.get(v.id, []),
            preloaded_mirrors=mirrors_by_vault.get(v.id, []),
            preloaded_disk_files=disk_by_vault.get(v.id),
        )
        combined_untracked.extend(status.get("untracked", []))
        combined_missing.extend(status.get("missing", []))
        combined_moved.extend(status.get("moved", []))
        combined_mirrors.extend(status.get("mirrors", []))
        total_discrepancies += int(status.get("total_discrepancies", 0))

    return {
        "vault_id": 0,
        "vault_name": "All Vaults",
        "in_sync": total_discrepancies == 0,
        "untracked": combined_untracked,
        "missing": combined_missing,
        "moved": combined_moved,
        "mirrors": combined_mirrors,
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

        parent_item, owning_project = _resolve_container_and_project(
            db,
            vault_id,
            file_path,
            store,
            create_missing_folders=True,
        )
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

    # 5. Synchronize requested VaultMirrors
    from . import mirrors as mirrors_service

    mirrored_count = 0
    if request.sync_all_mirrors or request.sync_mirror_ids:
        target_mirrors = mirrors_service.list_vault_mirrors(db, vault_id)
        if not request.sync_all_mirrors and request.sync_mirror_ids is not None:
            wanted = {int(mid) for mid in request.sync_mirror_ids}
            target_mirrors = [m for m in target_mirrors if m.id in wanted]
        for mirror in target_mirrors:
            res = mirrors_service.sync_mirror(db, mirror, commit=False)
            mirrored_count += (
                int(res.get("added_count", 0))
                + int(res.get("updated_count", 0))
                + int(res.get("missing_count", 0))
            )

    mirrors_service._refresh_folder_counts(db, vault_id)

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
        mirrored_count=mirrored_count,
        in_sync=bool(updated_scan.get("in_sync", True)),
    )


def reconcile_all_vaults(
    db: Session,
    request: schemas.VaultReconcileRequest,
) -> schemas.VaultReconcileResponse:
    """Reconcile across all vaults in the database."""
    all_vaults = vaults.get_vaults(db)
    added_count = 0
    marked_missing_count = 0
    purged_count = 0
    relinked_count = 0
    mirrored_count = 0

    for v in all_vaults:
        res = reconcile_vault(db, v.id, request)
        added_count += res.added_count
        marked_missing_count += res.marked_missing_count
        purged_count += res.purged_count
        relinked_count += res.relinked_count
        mirrored_count += res.mirrored_count

    updated = scan_all_vaults_discrepancies(db)
    return schemas.VaultReconcileResponse(
        vault_id=0,
        added_count=added_count,
        marked_missing_count=marked_missing_count,
        purged_count=purged_count,
        relinked_count=relinked_count,
        mirrored_count=mirrored_count,
        in_sync=bool(updated.get("in_sync", True)),
    )
