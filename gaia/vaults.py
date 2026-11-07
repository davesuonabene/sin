"""Physical vault ownership and managed asset movement for GAIA."""

from __future__ import annotations

import json
from pathlib import Path
import os
import re
import shutil
import uuid

from sqlalchemy import or_, text
from sqlalchemy.orm import Session

from . import models, paths


def _slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", "-", (value or "").strip().lower())
    return normalized.strip("-") or "vault"


def _storage_key(name: str) -> str:
    """Return the immutable, name-derived directory key for a new vault."""
    return _slug(name)


def vault_root(vault: models.Vault) -> Path:
    """Return the asset-store root selected for a vault."""
    if vault.custom_path:
        return Path(vault.custom_path).expanduser().resolve()
    return paths.vaults_directory().resolve()


def vault_store(vault: models.Vault) -> Path:
    """Return the physical directory that owns a vault's managed assets."""
    root = vault_root(vault)
    if vault.custom_path and getattr(vault, "custom_layout", "root") == "vault":
        return root
    return root / vault.storage_key


def _populate(vault: models.Vault) -> models.Vault:
    # ``path`` is response metadata, while ``custom_path`` retains whether the
    # standard asset-store root or an explicit root owns the directory.
    vault.path = str(vault_store(vault))
    vault.root_path = str(vault_root(vault))
    _ = list(getattr(vault, "mirrors", []) or [])
    return vault


def _preview_mode(value: str | None) -> str:
    mode = (value or "quick").strip().lower()
    if mode not in {"quick", "lazy", "hidden"}:
        raise ValueError("Vault preview must be quick, lazy, or hidden")
    return mode


def _target_path(value: str) -> Path:
    if not (value or "").strip():
        raise ValueError("Choose a destination folder")
    target = Path(value).expanduser().resolve()
    if target.exists() and not target.is_dir():
        raise ValueError("The vault path must be a folder")
    return target


def _path_key(value: Path) -> str:
    return os.path.normcase(str(value.resolve()))


def _ensure_unique_path(db: Session, target: Path, *, excluding_vault_id: int | None = None) -> None:
    target_key = _path_key(target)
    for existing in db.query(models.Vault).all():
        if excluding_vault_id is not None and existing.id == excluding_vault_id:
            continue
        existing_store = vault_store(existing)
        if (
            _path_key(existing_store) == target_key
            or _is_within(existing_store, target)
            or _is_within(target, existing_store)
        ):
            raise ValueError("Another vault already uses that path")


def ensure_default_vault(db: Session) -> models.Vault:
    vault = db.query(models.Vault).order_by(models.Vault.id).first()
    if vault is None:
        vault = models.Vault(
            name="Default vault",
            description="Default GAIA asset space",
            storage_key=_storage_key("Default vault"),
            preview="quick",
        )
        db.add(vault)
        db.commit()
        db.refresh(vault)
    vault_store(vault).mkdir(parents=True, exist_ok=True)
    return _populate(vault)


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _replace_path(value: str | None, operations: list[dict]) -> str | None:
    if not value:
        return value
    candidate = Path(value)
    if not candidate.is_absolute():
        return value
    for operation in sorted(operations, key=lambda entry: len(entry["source"]), reverse=True):
        source = Path(operation["source"])
        try:
            relative = candidate.resolve().relative_to(source.resolve())
        except ValueError:
            continue
        return str((Path(operation["target"]) / relative).resolve())
    return value


def _replace_path_values(value, operations: list[dict], *, preserve_source_paths: bool = False):
    if isinstance(value, str):
        return _replace_path(value, operations)
    if isinstance(value, list):
        return [_replace_path_values(entry, operations, preserve_source_paths=preserve_source_paths) for entry in value]
    if isinstance(value, dict):
        return {
            key: entry if preserve_source_paths and str(key).casefold() in {"source_path", "original_source_path"}
            else _replace_path_values(entry, operations, preserve_source_paths=preserve_source_paths)
            for key, entry in value.items()
        }
    return value


def rewrite_managed_paths(
    connection,
    operations: list[dict],
    *,
    preserve_source_paths: bool = False,
) -> None:
    """Keep all stored managed paths accurate after a normal vault move."""
    if not operations:
        return

    clauses = []
    params = {}
    for i, op in enumerate(operations):
        src = op["source"]
        params[f"s_{i}"] = src
        params[f"sp_{i}"] = f"{src}%"
        clauses.append(f"absolute_path = :s_{i} OR absolute_path LIKE :sp_{i}")

    where_sql = " OR ".join(clauses)
    item_rows = connection.execute(
        text(f"SELECT id, absolute_path, metadata_json FROM items WHERE {where_sql}"),
        params,
    ).mappings().all()

    for row in item_rows:
        absolute_path = _replace_path(row["absolute_path"], operations)
        metadata_json = row["metadata_json"]
        try:
            rewritten_metadata = json.dumps(_replace_path_values(
                json.loads(metadata_json or "{}"),
                operations,
                preserve_source_paths=preserve_source_paths,
            ))
        except (TypeError, ValueError):
            rewritten_metadata = metadata_json
        if absolute_path != row["absolute_path"] or rewritten_metadata != metadata_json:
            connection.execute(
                text("UPDATE items SET absolute_path = :absolute_path, metadata_json = :metadata_json WHERE id = :id"),
                {"id": row["id"], "absolute_path": absolute_path, "metadata_json": rewritten_metadata},
            )

    col_clauses = []
    col_params = {}
    for i, op in enumerate(operations):
        src = op["source"]
        col_params[f"s_{i}"] = src
        col_params[f"sp_{i}"] = f"{src}%"
        src_esc = json.dumps(src)[1:-1]
        col_params[f"se_{i}"] = f"%{src_esc}%"
        col_clauses.append(f"source_path = :s_{i} OR source_path LIKE :sp_{i} OR manifest_json LIKE :se_{i}")

    col_where = " OR ".join(col_clauses)
    collection_rows = connection.execute(
        text(f"SELECT id, source_path, manifest_json FROM collection_items WHERE {col_where}"),
        col_params,
    ).mappings().all()

    for row in collection_rows:
        source_path = row["source_path"] if preserve_source_paths else _replace_path(row["source_path"], operations)
        manifest_json = row["manifest_json"]
        try:
            rewritten_manifest = json.dumps(_replace_path_values(
                json.loads(manifest_json or "[]"),
                operations,
                preserve_source_paths=preserve_source_paths,
            ))
        except (TypeError, ValueError):
            rewritten_manifest = manifest_json
        if source_path != row["source_path"] or rewritten_manifest != manifest_json:
            connection.execute(
                text("UPDATE collection_items SET source_path = :source_path, manifest_json = :manifest_json WHERE id = :id"),
                {"id": row["id"], "source_path": source_path, "manifest_json": rewritten_manifest},
            )

    mt_clauses = []
    mt_params = {}
    for i, op in enumerate(operations):
        src_esc = json.dumps(op["source"])[1:-1]
        mt_params[f"se_{i}"] = f"%{src_esc}%"
        mt_clauses.append(f"stems_json LIKE :se_{i}")

    mt_where = " OR ".join(mt_clauses)
    multitrack_rows = connection.execute(
        text(f"SELECT id, stems_json FROM multitrack_items WHERE {mt_where}"),
        mt_params,
    ).mappings().all()

    for row in multitrack_rows:
        if not row["stems_json"]:
            continue
        try:
            rewritten_stems = json.dumps(_replace_path_values(json.loads(row["stems_json"]), operations))
        except (TypeError, ValueError):
            continue
        if rewritten_stems != row["stems_json"]:
            connection.execute(
                text("UPDATE multitrack_items SET stems_json = :stems_json WHERE id = :id"),
                {"id": row["id"], "stems_json": rewritten_stems},
            )

    log_rows = connection.execute(text("SELECT id, source_path FROM vault_import_logs")).mappings().all()
    for row in log_rows:
        source_path = row["source_path"] if preserve_source_paths else _replace_path(row["source_path"], operations)
        if source_path != row["source_path"]:
            connection.execute(
                text("UPDATE vault_import_logs SET source_path = :source_path WHERE id = :id"),
                {"id": row["id"], "source_path": source_path},
            )


def migrate_custom_vault_layouts(db: Session) -> None:
    """Upgrade exact custom folders into storage roots containing one vault folder.

    The initial custom-location implementation wrote managed files directly
    into the selected directory. Each legacy row is upgraded once by creating
    ``<selected root>/<storage_key>`` and moving only that vault's managed
    contents into it before rewriting tracked paths.
    """
    legacy_vaults = (
        db.query(models.Vault)
        .filter(models.Vault.custom_path.isnot(None), models.Vault.custom_layout == "vault")
        .order_by(models.Vault.id)
        .all()
    )
    for vault in legacy_vaults:
        source = Path(vault.custom_path).expanduser().resolve()
        if not source.is_dir():
            # Keep the old layout marker so a temporarily unavailable drive is
            # not silently replaced with a new empty vault.
            continue
        target = (source / vault.storage_key).resolve()
        target.mkdir(parents=False, exist_ok=True)
        moves: list[dict[str, str]] = []
        try:
            for child in list(source.iterdir()):
                if _path_key(child) == _path_key(target):
                    continue
                destination = target / child.name
                if destination.exists():
                    raise ValueError(
                        f"Cannot upgrade vault '{vault.name}': '{destination.name}' already exists"
                    )
                shutil.move(str(child), str(destination))
                moves.append({"source": str(child), "target": str(destination)})
            rewrite_managed_paths(
                db.connection(),
                [*moves, {"source": str(source), "target": str(target)}],
            )
            vault.custom_layout = "root"
            db.commit()
        except Exception:
            db.rollback()
            for operation in reversed(moves):
                original = Path(operation["source"])
                moved = Path(operation["target"])
                if moved.exists() and not original.exists():
                    shutil.move(str(moved), str(original))
            if target.exists() and not any(target.iterdir()):
                target.rmdir()
            raise


def _root_item(item: models.Item) -> models.Item:
    current = item
    seen: set[int] = set()
    while current.parent_id is not None:
        if current.id in seen:
            raise ValueError("Item hierarchy contains a cycle")
        seen.add(current.id)
        current = current.parent
        if current is None:
            raise ValueError("Item hierarchy is incomplete")
    return current


def move_items_to_vault(
    db: Session,
    item_ids: list[int],
    vault_id: int,
    *,
    mode: str = "move",
) -> list[models.Item]:
    """Materialize selected roots in another vault, moving or copying bytes.

    ``copy`` is intended for external references: it makes the item managed
    without changing its immutable recorded source path. Existing managed
    assets retain the historical move-only behavior.
    """
    if mode not in {"move", "copy"}:
        raise ValueError("Choose either move or copy")
    target_vault = get_vault(db, vault_id)
    if not target_vault:
        raise ValueError("Vault not found")
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one item to move")
    selected = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    if len(selected) != len(unique_ids):
        raise ValueError("One or more items no longer exist")

    roots: dict[int, models.Item] = {}
    for item in selected:
        root = _root_item(item)
        roots[root.id] = root
    operations: list[dict] = []
    external_roots: set[int] = set()
    for root in roots.values():
        is_external = getattr(root, "storage_mode", "managed") == "external_reference"
        if root.vault_id == target_vault.id and not is_external:
            continue
        source = Path(root.absolute_path).resolve()
        owner = get_vault(db, root.vault_id)
        if not is_external and (not owner or not _is_within(vault_store(owner), source)):
            raise ValueError("Only managed vault assets can be moved")
        if not source.exists():
            raise ValueError(f"'{source.name}' is missing from disk")
        if mode == "copy" and getattr(root, "storage_mode", "managed") != "external_reference":
            raise ValueError("Copy is available only for external references")
        destination = (vault_store(target_vault) / source.name).resolve()
        if is_external and (_is_within(source, destination) or _is_within(destination, source)):
            raise ValueError("The destination vault cannot be inside the referenced source")
        if destination.exists():
            raise ValueError(f"Target vault already contains '{source.name}'")
        operations.append({
            "source": str(source),
            "target": str(destination),
            "external": is_external,
            "copy": mode == "copy",
        })
        if is_external:
            external_roots.add(root.id)
    if not operations:
        return list(roots.values())

    try:
        for operation in operations:
            source = Path(operation["source"])
            target = Path(operation["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            root_id = next((root_id for root_id, root in roots.items() if str(Path(root.absolute_path).resolve()) == operation["source"]), None)
            is_external = bool(operation.get("external"))
            if is_external and mode == "copy":
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copy2(source, target)
            elif is_external and source.stat().st_dev != target.parent.stat().st_dev:
                # Cross-volume moves cannot be renamed atomically. Publish a
                # verified copy, then remove the original as the explicit move
                # action requested by the user.
                if source.is_dir():
                    shutil.copytree(source, target)
                    shutil.rmtree(source)
                else:
                    shutil.copy2(source, target)
                    source.unlink()
            else:
                source.replace(target)
        for root in roots.values():
            if root.vault_id == target_vault.id and root.id not in external_roots:
                continue
            stack = [root]
            while stack:
                current = stack.pop()
                current.vault_id = target_vault.id
                if current.id in external_roots or root.id in external_roots:
                    current.storage_mode = "managed"
                    current.availability = "ready"
                stack.extend(current.children)
        db.flush()
        rewrite_managed_paths(
            db.connection(),
            operations,
            preserve_source_paths=bool(external_roots),
        )
        db.commit()
    except Exception:
        db.rollback()
        for operation in reversed(operations):
            source = Path(operation["source"])
            target = Path(operation["target"])
            if not target.exists():
                continue
            source.parent.mkdir(parents=True, exist_ok=True)
            if source.exists():
                # A failed copy must not leave a second managed tree behind.
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)
            elif source.parent.stat().st_dev == target.parent.stat().st_dev:
                target.replace(source)
            elif target.is_dir():
                shutil.copytree(target, source)
                shutil.rmtree(target, ignore_errors=True)
            else:
                shutil.copy2(target, source)
                target.unlink(missing_ok=True)
        raise
    return [db.query(models.Item).filter(models.Item.id == root_id).one() for root_id in roots]


def place_items_in_vault(
    db: Session,
    vault_id: int,
    item_ids: list[int],
    mode: str = "copy",
    source_context_ids: list[int] | None = None,
) -> dict:
    """Place items directly at the root level of a vault via copy, reference, or move."""
    if mode not in {"copy", "reference", "move"}:
        raise ValueError("Choose move, reference, or copy")
    target_vault = get_vault(db, vault_id)
    if not target_vault:
        raise ValueError("Vault not found")
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        raise ValueError("Select at least one item")
    items = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    if len(items) != len(unique_ids):
        raise ValueError("One or more items no longer exist")

    if mode == "move":
        store = vault_store(target_vault).resolve()
        store.mkdir(parents=True, exist_ok=True)
        operations: list[dict[str, str]] = []
        for item in items:
            if item.vault_id == target_vault.id and item.parent_id is not None:
                old_parent_id = item.parent_id
                if getattr(item, "storage_mode", "managed") == "managed":
                    source = Path(item.absolute_path).resolve()
                    if source.exists() and source.parent != store and _is_within(store, source):
                        from . import project_service
                        destination = project_service._unique_destination(store, source.name)
                        source.replace(destination)
                        operations.append({"source": str(source), "target": str(destination)})
                item.parent_id = None
                attrs = dict(item.attributes or {})
                if "folder" in attrs:
                    attrs.pop("folder", None)
                    item.attributes = attrs
                db.query(models.ItemReference).filter(
                    models.ItemReference.context_id == old_parent_id,
                    models.ItemReference.to_item_id == item.id,
                ).delete(synchronize_session=False)

        if operations:
            db.flush()
            rewrite_managed_paths(db.connection(), operations, preserve_source_paths=True)

        if source_context_ids:
            from . import project_service
            for src_id in source_context_ids:
                db.query(models.ItemReference).filter(
                    models.ItemReference.context_id == src_id,
                    models.ItemReference.to_item_id.in_(unique_ids),
                ).delete(synchronize_session=False)
                try:
                    project_service.sync_project_manifest(db, src_id)
                except Exception:
                    pass

        other_vault_ids = [item.id for item in items if item.vault_id != target_vault.id]
        if other_vault_ids:
            move_items_to_vault(db, other_vault_ids, target_vault.id, mode="move")
        db.commit()
        return {
            "vault_id": target_vault.id,
            "mode": mode,
            "item_ids": unique_ids,
        }

    if mode == "reference":
        from . import crud, schemas
        for item in items:
            if item.vault_id == target_vault.id and item.parent_id is None:
                continue
            path_str = str(Path(item.absolute_path).resolve())
            existing = (
                db.query(models.Item)
                .filter(
                    models.Item.vault_id == target_vault.id,
                    models.Item.absolute_path == path_str,
                    models.Item.parent_id.is_(None),
                )
                .first()
            )
            if not existing:
                schema = schemas.ItemCreate(
                    absolute_path=path_str,
                    vault_id=target_vault.id,
                    parent_id=None,
                    storage_mode="external_reference",
                    type=item.type,
                    file_hash=item.file_hash,
                    size_bytes=item.size_bytes,
                    mime_type=item.mime_type,
                    attributes=dict(item.attributes),
                )
                new_item = crud.create_item(db, schema, commit=False)
                tags = [t.name for t in item.tags]
                if tags:
                    crud.set_item_tags(db, new_item.id, tags, commit=False)
        db.commit()
        return {
            "vault_id": target_vault.id,
            "mode": mode,
            "item_ids": unique_ids,
        }

    if mode == "copy":
        from . import project_service
        store = vault_store(target_vault).resolve()
        store.mkdir(parents=True, exist_ok=True)
        copied_ids: list[int] = []
        for item in items:
            source = Path(item.absolute_path).resolve()
            if not source.exists():
                raise ValueError(f"'{source.name}' is missing from disk")
            destination = project_service._unique_destination(store, source.name)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                cloned = project_service._clone_item_file(
                    db,
                    item,
                    source,
                    destination,
                    target_vault.id,
                    None,
                )
                copied_ids.append(cloned.id)
        db.commit()
        return {
            "vault_id": target_vault.id,
            "mode": mode,
            "item_ids": copied_ids,
        }


def get_vault(db: Session, vault_id: int) -> models.Vault | None:
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if vault:
        vault_store(vault).mkdir(parents=True, exist_ok=True)
        return _populate(vault)
    return None


def get_vaults(db: Session) -> list[models.Vault]:
    ensure_default_vault(db)
    records = db.query(models.Vault).order_by(models.Vault.name).all()
    return [_populate(vault) for vault in records]


def create_vault(
    db: Session,
    name: str,
    description: str | None,
    path: str | None = None,
    preview: str = "quick",
    mirrors_list: list | None = None,
) -> models.Vault:
    name = (name or "").strip()
    if not name:
        raise ValueError("Vault name cannot be empty")
    if db.query(models.Vault).filter(models.Vault.name == name).first():
        raise ValueError("Vault name already exists")
    storage_key = _storage_key(name)
    if db.query(models.Vault).filter(models.Vault.storage_key == storage_key).first():
        raise ValueError("Vault name conflicts with an existing vault folder")
    default_root = paths.vaults_directory().resolve()
    root = _target_path(path) if path else default_root
    target = (root / storage_key).resolve()
    _ensure_unique_path(db, target)
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"Vault folder '{storage_key}' already exists and is not empty")
    vault = models.Vault(
        name=name,
        description=description,
        storage_key=storage_key,
        custom_path=None if _path_key(root) == _path_key(default_root) else str(root),
        custom_layout="root",
        preview=_preview_mode(preview),
    )
    db.add(vault)
    try:
        vault_store(vault).mkdir(parents=True, exist_ok=True)
        db.flush()
        if mirrors_list:
            from . import mirrors as mirrors_service
            for mirror_payload in mirrors_list:
                mirrors_service.create_mirror(db, vault.id, mirror_payload, commit=False)
        db.commit()
        db.refresh(vault)
    except Exception:
        db.rollback()
        raise
    return _populate(vault)


def update_vault(
    db: Session,
    vault_id: int,
    name: str,
    description: str | None,
    preview: str = "quick",
) -> models.Vault:
    """Update editable vault metadata without changing its immutable storage key."""
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if not vault:
        raise ValueError("Vault not found")
    if not name:
        raise ValueError("Vault name cannot be empty")
    duplicate = (
        db.query(models.Vault)
        .filter(models.Vault.name == name, models.Vault.id != vault_id)
        .first()
    )
    if duplicate:
        raise ValueError("Vault name already exists")
    vault.name = name
    vault.description = description
    vault.preview = _preview_mode(preview)
    db.commit()
    db.refresh(vault)
    return _populate(vault)


def migrate_vault(db: Session, vault_id: int, path: str) -> models.Vault:
    """Move a complete managed vault and rewrite every tracked internal path."""
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if not vault:
        raise ValueError("Vault not found")
    source = vault_store(vault).resolve()
    target_root = _target_path(path)
    target = (target_root / vault.storage_key).resolve()
    if _path_key(source) == _path_key(target):
        return _populate(vault)
    _ensure_unique_path(db, target, excluding_vault_id=vault_id)
    if _is_within(source, target) or _is_within(target, source):
        raise ValueError("Choose a destination outside the current vault")
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"Destination vault folder '{vault.storage_key}' is not empty")
    if not source.is_dir():
        raise ValueError("The current vault path is unavailable")

    default_root = paths.vaults_directory().resolve()
    target_existed = target.exists()
    if target_existed:
        target.rmdir()
    target.parent.mkdir(parents=True, exist_ok=True)
    moved = False
    try:
        shutil.move(str(source), str(target))
        moved = True
        rewrite_managed_paths(
            db.connection(),
            [{"source": str(source), "target": str(target)}],
        )
        vault.custom_path = None if _path_key(target_root) == _path_key(default_root) else str(target_root)
        vault.custom_layout = "root"
        db.commit()
    except Exception:
        db.rollback()
        if moved and target.exists() and not source.exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(target), str(source))
        elif target_existed and not target.exists():
            target.mkdir(parents=True, exist_ok=True)
        raise
    db.refresh(vault)
    return _populate(vault)


def delete_vault(
    db: Session,
    vault_id: int,
    *,
    delete_contents: bool = False,
    background_tasks=None,
) -> None:
    """Delete a vault, optionally purging every asset and relationship it owns.

    A content purge stages the whole managed directory with one atomic rename.
    The database transaction can therefore be rolled back without leaving the
    filesystem half-deleted, regardless of how many items the vault contains.
    """
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if not vault:
        raise ValueError("Vault not found")
    if db.query(models.Vault).count() <= 1:
        raise ValueError("The last vault cannot be deleted")
    has_items = db.query(models.Item.id).filter(models.Item.vault_id == vault_id).first() is not None
    if has_items and not delete_contents:
        raise ValueError("Move or delete the vault's assets before deleting it")

    store = vault_store(vault)
    if not delete_contents and store.exists() and any(store.iterdir()):
        raise ValueError("The vault folder is not empty")

    staged_store: Path | None = None
    if delete_contents and store.exists():
        staged_store = store.parent / f".deleting-vault-{vault.id}-{uuid.uuid4().hex}"
        os.replace(store, staged_store)

    affected_project_ids: set[int] = set()

    try:
        if delete_contents and has_items:
            vault_item_ids = db.query(models.Item.id).filter(models.Item.vault_id == vault_id)

            # Track external projects that reference items in this vault so their
            # manifests can be synchronized after references are deleted.
            external_refs = (
                db.query(models.ItemReference.context_id)
                .filter(
                    or_(
                        models.ItemReference.from_item_id.in_(vault_item_ids),
                        models.ItemReference.to_item_id.in_(vault_item_ids),
                    )
                )
                .filter(~models.ItemReference.context_id.in_(vault_item_ids))
                .all()
            )
            affected_project_ids.update(row[0] for row in external_refs)

            db.query(models.ItemReference).filter(
                or_(
                    models.ItemReference.context_id.in_(vault_item_ids),
                    models.ItemReference.from_item_id.in_(vault_item_ids),
                    models.ItemReference.to_item_id.in_(vault_item_ids),
                )
            ).delete(synchronize_session=False)

            # Clear import log references before deleting items so SQLite foreign key
            # constraints do not block item deletion.
            db.query(models.VaultImportLog).filter(
                models.VaultImportLog.vault_id == vault_id
            ).delete(synchronize_session=False)
            db.query(models.VaultImportLog).filter(
                models.VaultImportLog.item_id.in_(vault_item_ids)
            ).update({models.VaultImportLog.item_id: None}, synchronize_session=False)

            # Clear item tag associations before deleting items.
            db.execute(models.item_tags.delete().where(models.item_tags.c.item_id.in_(vault_item_ids)))

            # Joined-table inheritance needs ORM deletion so every concrete
            # subtype row is removed before its base Item row.
            # Order child items first so parent-child relationships cascade cleanly.
            items_to_delete = (
                db.query(models.Item)
                .filter(models.Item.vault_id == vault_id)
                .order_by(models.Item.parent_id.isnot(None).desc())
                .all()
            )
            for item in items_to_delete:
                db.delete(item)
            db.flush()
        else:
            db.query(models.VaultImportLog).filter(
                models.VaultImportLog.vault_id == vault_id
            ).delete(synchronize_session=False)

        db.delete(vault)
        db.commit()
    except Exception:
        db.rollback()
        if staged_store and staged_store.exists() and not store.exists():
            try:
                os.replace(staged_store, store)
            except OSError:
                pass
        raise

    if staged_store and staged_store.exists():
        if background_tasks is None:
            paths.safe_rmtree(staged_store)
        else:
            background_tasks.add_task(paths.safe_rmtree, staged_store)
    elif store.exists():
        try:
            store.rmdir()
        except OSError:
            if delete_contents:
                paths.safe_rmtree(store)

    if affected_project_ids:
        from . import project_service

        for proj_id in sorted(affected_project_ids):
            try:
                project_service.sync_project_manifest(db, proj_id)
            except (ValueError, OSError):
                pass



def log_import(
    db: Session,
    vault_id: int,
    source_path: str,
    status: str,
    action: str,
    item_id: int | None = None,
    detail: str | None = None,
    *,
    commit: bool = True,
    flush: bool = True,
) -> models.VaultImportLog:
    entry = models.VaultImportLog(
        vault_id=vault_id,
        source_path=source_path,
        status=status,
        action=action,
        item_id=item_id,
        detail=detail,
    )
    db.add(entry)
    if commit:
        db.commit()
        db.refresh(entry)
    elif flush:
        db.flush()
    return entry


def get_logs(db: Session, vault_id: int, limit: int = 100) -> list[models.VaultImportLog]:
    return (
        db.query(models.VaultImportLog)
        .filter(models.VaultImportLog.vault_id == vault_id)
        .order_by(models.VaultImportLog.created_at.desc())
        .limit(limit)
        .all()
    )


def _folder_chain_relative_path(db: Session, item: models.Item) -> Path:
    """Return the relative directory path inside ``<vault_store>`` for ``item`` based on its parent folder hierarchy."""
    segments: list[str] = []
    curr_id = item.parent_id
    seen: set[int] = set()
    while curr_id is not None and curr_id not in seen:
        seen.add(curr_id)
        parent = db.query(models.Item).filter(models.Item.id == curr_id).first()
        if not parent:
            break
        folder_name = getattr(parent, "title", None) or Path(parent.absolute_path).name
        if folder_name:
            segments.insert(0, folder_name)
        curr_id = parent.parent_id
    return Path(*segments) if segments else Path()


def collect_items_into_vault(db: Session, item_ids: list[int]) -> list[models.Item]:
    """Materialize selected ``external_reference`` items (and external descendants of selected folders) into their owning vault's physical storage."""
    from . import crud, integrity, mirrors

    unique_ids = list(dict.fromkeys(int(i) for i in item_ids if i is not None))
    if not unique_ids:
        raise ValueError("Select at least one item to collect")

    selected = db.query(models.Item).filter(models.Item.id.in_(unique_ids)).all()
    if len(selected) != len(unique_ids):
        raise ValueError("One or more selected items no longer exist")

    # Expand any selected FolderItem to include its subtree
    all_target_ids: set[int] = set(unique_ids)
    frontier = list(unique_ids)
    while frontier:
        children = [
            r[0]
            for r in db.query(models.Item.id)
            .filter(models.Item.parent_id.in_(frontier))
            .all()
            if r[0] not in all_target_ids
        ]
        all_target_ids.update(children)
        frontier = children

    all_targets = (
        db.query(models.Item)
        .filter(models.Item.id.in_(all_target_ids))
        .order_by(models.Item.id.asc())
        .all()
    )

    leaf_targets = [
        item
        for item in all_targets
        if not isinstance(item, models.FolderItem)
        and getattr(item, "type", None) not in {"folder", "collection"}
        and getattr(item, "storage_mode", "managed") == "external_reference"
    ]
    folder_targets = [
        item
        for item in all_targets
        if (isinstance(item, models.FolderItem) or getattr(item, "type", None) in {"folder", "collection"})
        and getattr(item, "storage_mode", "managed") == "external_reference"
    ]

    if not leaf_targets and not folder_targets:
        return [crud.get_item(db, i) for i in unique_ids]

    created_files: list[Path] = []
    affected_vault_ids: set[int] = set()
    try:
        for item in leaf_targets:
            vault = get_vault(db, item.vault_id)
            if not vault:
                raise ValueError("Owning vault not found")
            affected_vault_ids.add(vault.id)
            store = vault_store(vault).resolve()
            source = Path(item.absolute_path).resolve()
            if not source.is_file():
                raise ValueError(f"Referenced file '{source.name}' is missing from disk")

            rel_dir = _folder_chain_relative_path(db, item)
            dest_dir = (store / rel_dir).resolve()
            dest_dir.mkdir(parents=True, exist_ok=True)
            destination = (dest_dir / source.name).resolve()

            if _path_key(destination) != _path_key(source):
                if destination.exists():
                    from . import project_service
                    destination = project_service._unique_destination(dest_dir, source.name)
                partial = destination.with_name(f".{destination.name}.gaia-collect-{uuid.uuid4().hex}")
                try:
                    shutil.copy2(source, partial)
                    if partial.stat().st_size != source.stat().st_size:
                        raise OSError(f"Collected file size mismatch for '{source.name}'")
                    os.replace(partial, destination)
                    created_files.append(destination)
                finally:
                    partial.unlink(missing_ok=True)

            attrs = dict(item.attributes or {})
            imp = dict(attrs.get("import") or {})
            if not imp.get("source_path"):
                imp["source_path"] = str(source)
            try:
                imp["source_mtime_ns"] = source.stat().st_mtime_ns
            except OSError:
                pass
            attrs["import"] = imp
            item.attributes = attrs
            item.absolute_path = str(destination)
            item.storage_mode = "managed"
            item.availability = "ready"
            if not item.file_hash:
                item.file_hash = integrity.calculate_file_hash(str(destination))

        db.flush()

        # Check ancestor & selected folders: if a folder has no remaining external_reference descendants,
        # promote it to managed inside <vault_store>.
        candidate_folders: dict[int, models.Item] = {f.id: f for f in folder_targets}
        for item in leaf_targets:
            curr_id = item.parent_id
            seen_anc: set[int] = set()
            while curr_id is not None and curr_id not in seen_anc:
                seen_anc.add(curr_id)
                anc = db.query(models.Item).filter(models.Item.id == curr_id).first()
                if not anc:
                    break
                if getattr(anc, "storage_mode", "managed") == "external_reference":
                    candidate_folders[anc.id] = anc
                curr_id = anc.parent_id

        for folder in candidate_folders.values():
            vault = get_vault(db, folder.vault_id)
            if not vault:
                continue
            affected_vault_ids.add(vault.id)
            store = vault_store(vault).resolve()
            rel_dir = _folder_chain_relative_path(db, folder)
            folder_name = getattr(folder, "title", None) or Path(folder.absolute_path).name
            phys_dir = (store / rel_dir / folder_name).resolve()
            phys_dir.mkdir(parents=True, exist_ok=True)

            # Check if any external_reference leaf remains in this folder's subtree
            sub_ids = {folder.id}
            f_queue = [folder.id]
            while f_queue:
                ch = [
                    r[0]
                    for r in db.query(models.Item.id)
                    .filter(models.Item.parent_id.in_(f_queue))
                    .all()
                    if r[0] not in sub_ids
                ]
                sub_ids.update(ch)
                f_queue = ch

            remaining_ext = (
                db.query(models.Item.id)
                .filter(
                    models.Item.id.in_(sub_ids - {folder.id}),
                    ~models.Item.type.in_(["folder", "collection"]),
                    models.Item.storage_mode == "external_reference",
                )
                .count()
            )
            if remaining_ext == 0:
                if not getattr(folder, "source_path", None):
                    folder.source_path = folder.absolute_path
                folder.absolute_path = str(phys_dir)
                folder.storage_mode = "managed"
                folder.availability = "ready"

        for vid in affected_vault_ids:
            mirrors._refresh_folder_counts(db, vid)

        db.commit()
    except Exception:
        db.rollback()
        for fpath in reversed(created_files):
            fpath.unlink(missing_ok=True)
        raise

    return [crud.get_item(db, i) for i in unique_ids]


def migrate_to_1to1_physical_vaults(db: Session) -> dict[str, int]:
    """Idempotent non-destructive migration to the 1-1 physical vault architecture."""
    import datetime
    from . import mirrors

    stats = {
        "collections_converted": 0,
        "zoom_h4_converted": 0,
        "root_files_unwrapped": 0,
        "folders_synthesized": 0,
        "items_reparented": 0,
        "mirrors_created": 0,
    }

    conn = db.connection()

    # Step A: Convert legacy collection items to folder
    res_col = conn.execute(text("UPDATE items SET type = 'folder' WHERE type = 'collection'"))
    stats["collections_converted"] = int(res_col.rowcount or 0)

    # Step B: Convert multitrack items with zoom_h4 profile to zoom_h4 subtype
    res_zh4 = conn.execute(
        text(
            "UPDATE items SET type = 'zoom_h4' "
            "WHERE type = 'multitrack' AND metadata_json LIKE '%\"profile_id\": \"zoom_h4\"%'"
        )
    )
    stats["zoom_h4_converted"] = int(res_zh4.rowcount or 0)
    if stats["collections_converted"] or stats["zoom_h4_converted"]:
        db.commit()

    all_vaults = db.query(models.Vault).order_by(models.Vault.id.asc()).all()
    domain_container_types = {"project", "multitrack", "zoom_h4"}

    for vault in all_vaults:
        store = vault_store(vault).resolve()
        if not store.exists():
            continue

        # Step C: Unwrap <vault_store>/files/<filename> for root-level managed items (parent_id IS NULL)
        legacy_files_dir = (store / "files").resolve()
        if legacy_files_dir.is_dir():
            root_managed = (
                db.query(models.Item)
                .filter(
                    models.Item.vault_id == vault.id,
                    models.Item.parent_id.is_(None),
                    models.Item.storage_mode == "managed",
                    ~models.Item.type.in_(["folder", "collection", "project", "multitrack", "zoom_h4"]),
                )
                .all()
            )
            unwrap_moves: list[dict[str, str]] = []
            for item in root_managed:
                item_path = Path(item.absolute_path).resolve()
                if item_path.parent == legacy_files_dir and item_path.is_file():
                    dest = (store / item_path.name).resolve()
                    if dest.exists() and _path_key(dest) != _path_key(item_path):
                        dest = mirrors._next_version_destination(store, item_path.name)
                    if _path_key(dest) != _path_key(item_path):
                        os.replace(item_path, dest)
                        unwrap_moves.append({"source": str(item_path), "target": str(dest)})
                        stats["root_files_unwrapped"] += 1

            if unwrap_moves:
                rewrite_managed_paths(
                    db.connection(),
                    unwrap_moves,
                    preserve_source_paths=True,
                )
                db.commit()

            # Remove legacy <vault_store>/files directory if it has no non-ignored media files and no DB items
            from . import reconciler as _reconciler

            has_db_in_files = (
                db.query(models.Item.id)
                .filter(
                    models.Item.vault_id == vault.id,
                    models.Item.absolute_path.like(f"{legacy_files_dir}%"),
                )
                .first()
                is not None
            )
            if not has_db_in_files:
                has_real_files = False
                for r_dir, _dirs, f_names in os.walk(legacy_files_dir):
                    for fn in f_names:
                        if fn.lower() in _reconciler.IGNORE_FILENAMES or fn.startswith((".", "._", "~$")):
                            continue
                        if Path(fn).suffix.lower() in _reconciler.IGNORE_EXTENSIONS:
                            continue
                        has_real_files = True
                        break
                    if has_real_files:
                        break
                if not has_real_files:
                    paths.safe_rmtree(legacy_files_dir)

        # Step C.2: Reconcile ProjectItem directories renamed on disk where a sibling FolderItem
        # was synthesized over a directory containing files/edit/current.json for that project_id.
        vault_projects = (
            db.query(models.ProjectItem)
            .filter(models.ProjectItem.vault_id == vault.id)
            .all()
        )
        for proj in vault_projects:
            proj_dir = Path(os.path.normpath(proj.absolute_path))
            # Check if any sibling FolderItem in the same vault has files/edit/current.json matching proj.id
            sibling_folders = (
                db.query(models.FolderItem)
                .filter(
                    models.FolderItem.vault_id == vault.id,
                    models.FolderItem.type == "folder",
                    models.FolderItem.id != proj.id,
                )
                .all()
            )
            for sib in sibling_folders:
                sib_dir = Path(os.path.normpath(sib.absolute_path))
                current_json = sib_dir / "files" / "edit" / "current.json"
                if not current_json.is_file():
                    continue
                try:
                    data = json.loads(current_json.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if isinstance(data, dict) and data.get("project_id") == proj.id:
                    # Re-parent all children of duplicate FolderItem to the ProjectItem
                    for child in db.query(models.Item).filter(models.Item.parent_id == sib.id).all():
                        child.parent_id = proj.id
                        stats["items_reparented"] += 1
                    db.delete(sib)
                    db.flush()
                    proj.absolute_path = str(sib_dir)
                    proj.title = sib.title or sib_dir.name
                    proj.source_path = str(sib_dir)
                    meta = json.loads(proj.metadata_json or "{}")
                    if isinstance(meta, dict):
                        meta["title"] = proj.title
                        meta["source_path"] = str(sib_dir)
                        proj.metadata_json = json.dumps(meta)
                    db.commit()
                    # Clean up ghost old project dir if it only contained project.json and empty dirs
                    if proj_dir.is_dir() and _path_key(proj_dir) != _path_key(sib_dir):
                        ghost_files = [fn for _r, _ds, fns in os.walk(proj_dir) for fn in fns]
                        if all(fn.lower() == "project.json" for fn in ghost_files):
                            paths.safe_rmtree(proj_dir)
                    try:
                        from . import project_service
                        project_service.sync_project_manifest(db, proj.id)
                    except Exception:
                        pass
                    break

        # Fast check: if no legacy types/files were converted and no unparented subfolder/external items exist,
        # skip scanning all vault items on every startup.
        has_unparented_ext = (
            db.query(models.Item.id)
            .filter(
                models.Item.vault_id == vault.id,
                models.Item.storage_mode == "external_reference",
                models.Item.parent_id.is_(None),
                ~models.Item.type.in_(["folder", "collection", "project"]),
            )
            .first()
            is not None
        )
        needs_hierarchy_scan = bool(
            stats["collections_converted"]
            or stats["zoom_h4_converted"]
            or stats["root_files_unwrapped"]
            or has_unparented_ext
        )
        if not needs_hierarchy_scan:
            unparented_managed = (
                db.query(models.Item.absolute_path)
                .filter(
                    models.Item.vault_id == vault.id,
                    models.Item.storage_mode == "managed",
                    models.Item.parent_id.is_(None),
                    ~models.Item.type.in_(["project", "multitrack", "zoom_h4"]),
                )
                .all()
            )
            store_norm = _path_key(store)
            for (abs_p,) in unparented_managed:
                p_parent = Path(os.path.normpath(abs_p)).parent
                if _path_key(p_parent) != store_norm and _is_within(store, p_parent):
                    needs_hierarchy_scan = True
                    break

        if not needs_hierarchy_scan:
            continue

        # Step D: Synthesize missing intermediate FolderItem rows for managed items inside <vault_store>
        vault_items = (
            db.query(models.Item)
            .filter(models.Item.vault_id == vault.id)
            .order_by(models.Item.id.asc())
            .all()
        )
        domain_roots: list[tuple[Path, models.Item]] = []
        folder_by_norm: dict[str, models.FolderItem] = {}

        for item in vault_items:
            if item.type in domain_container_types:
                try:
                    domain_roots.append((Path(os.path.normpath(item.absolute_path)), item))
                except OSError:
                    pass
            elif item.type in {"folder", "collection"} and isinstance(item, models.FolderItem):
                try:
                    folder_by_norm[_path_key(Path(os.path.normpath(item.absolute_path)))] = item
                except OSError:
                    pass

        def _enclosing_domain_root(p: Path) -> models.Item | None:
            for d_path, d_item in domain_roots:
                if _path_key(p) != _path_key(d_path) and _is_within(d_path, p):
                    return d_item
            return None

        def _ensure_managed_dir_chain(dir_path: Path) -> models.FolderItem | None:
            if _path_key(dir_path) == _path_key(store) or not _is_within(store, dir_path):
                return None
            rel = Path(os.path.normpath(dir_path)).relative_to(store)
            parts = [p for p in rel.parts if p and p != "."]
            if not parts:
                return None
            curr_parent_id: int | None = None
            curr_folder: models.FolderItem | None = None
            for idx in range(len(parts)):
                sub_path = Path(os.path.normpath(store / Path(*parts[: idx + 1])))
                key = _path_key(sub_path)
                existing = folder_by_norm.get(key)
                if existing is None:
                    existing = models.FolderItem(
                        absolute_path=str(sub_path),
                        vault_id=vault.id,
                        parent_id=curr_parent_id,
                        title=sub_path.name,
                        source_kind="managed",
                        source_path=str(sub_path),
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
                    folder_by_norm[key] = existing
                    stats["folders_synthesized"] += 1
                else:
                    if existing.parent_id != curr_parent_id and _enclosing_domain_root(sub_path) is None:
                        existing.parent_id = curr_parent_id
                        stats["items_reparented"] += 1
                curr_folder = existing
                curr_parent_id = existing.id
            return curr_folder

        # First ensure existing managed FolderItems have their ancestor chain
        for folder in list(folder_by_norm.values()):
            if getattr(folder, "storage_mode", "managed") != "managed":
                continue
            fpath = Path(os.path.normpath(folder.absolute_path))
            if not _is_within(store, fpath) or _enclosing_domain_root(fpath) is not None:
                continue
            _ensure_managed_dir_chain(fpath)

        # Next ensure every managed leaf item (and non-project domain container inside a subfolder)
        # is parented to its immediate FolderItem
        for item in vault_items:
            if getattr(item, "storage_mode", "managed") != "managed":
                continue
            if item.type in {"folder", "collection", "project"}:
                continue
            item_path = Path(os.path.normpath(item.absolute_path))
            if not _is_within(store, item_path):
                continue
            enclosing_domain = _enclosing_domain_root(item_path)
            if enclosing_domain is not None:
                continue
            parent_dir = item_path.parent
            if _path_key(parent_dir) == _path_key(store):
                if item.parent_id is not None:
                    item.parent_id = None
                    stats["items_reparented"] += 1
            else:
                target_folder = _ensure_managed_dir_chain(parent_dir)
                if target_folder and item.parent_id != target_folder.id:
                    item.parent_id = target_folder.id
                    stats["items_reparented"] += 1

        # Step E: Migrate unparented legacy external_reference items into a VaultMirror + 1-1 FolderItem tree
        unparented_external = [
            item
            for item in vault_items
            if getattr(item, "storage_mode", "managed") == "external_reference"
            and item.parent_id is None
            and item.type not in {"folder", "collection", "project"}
        ]
        if unparented_external:
            by_drive: dict[str, list[models.Item]] = {}
            for ext_item in unparented_external:
                drive = os.path.splitdrive(ext_item.absolute_path)[0].upper() or "ROOT"
                by_drive.setdefault(drive, []).append(ext_item)

            for _, group in by_drive.items():
                dir_paths = [str(Path(it.absolute_path).resolve().parent) for it in group]
                try:
                    common_dir_str = os.path.commonpath(dir_paths)
                    common_root = Path(common_dir_str).resolve()
                except ValueError:
                    common_root = Path(dir_paths[0]).resolve()

                if len( common_root.parts ) <= 1 and len(dir_paths) == 1:
                    common_root = Path(dir_paths[0]).resolve()

                existing_mirror = None
                for m in mirrors.list_vault_mirrors(db, vault.id):
                    if _path_key(Path(m.source_path)) == _path_key(common_root):
                        existing_mirror = m
                        break

                if not existing_mirror:
                    existing_mirror = models.VaultMirror(
                        vault_id=vault.id,
                        source_path=str(common_root),
                        target_folder_path=common_root.name or "External Mirror",
                        mode="reference_1to1",
                        enabled=True,
                        last_synced_at=datetime.datetime.utcnow(),
                    )
                    db.add(existing_mirror)
                    db.flush()
                    stats["mirrors_created"] += 1

                root_folder = mirrors._ensure_mirror_folder_chain(db, vault, existing_mirror)
                subfolder_cache: dict[str, models.FolderItem] = {}

                for ext_item in group:
                    ext_path = Path(ext_item.absolute_path).resolve()
                    try:
                        rel_dir = ext_path.parent.relative_to(common_root).as_posix()
                    except ValueError:
                        rel_dir = ""
                    target_parent = mirrors._ensure_1to1_subfolder(
                        db,
                        vault.id,
                        root_folder,
                        common_root,
                        rel_dir,
                        subfolder_cache,
                    )
                    ext_item.parent_id = target_parent.id
                    attrs = dict(ext_item.attributes or {})
                    imp = dict(attrs.get("import") or {})
                    if not imp.get("source_path"):
                        imp["source_path"] = str(ext_path)
                    imp["mirror_id"] = existing_mirror.id
                    attrs["import"] = imp
                    ext_item.attributes = attrs
                    stats["items_reparented"] += 1

        mirrors._refresh_folder_counts(db, vault.id)
        db.commit()

    return stats
