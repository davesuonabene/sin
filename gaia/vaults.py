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
    item_rows = connection.execute(text("SELECT id, absolute_path, metadata_json FROM items")).mappings().all()
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

    collection_rows = connection.execute(
        text("SELECT id, source_path, manifest_json FROM collection_items")
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

    multitrack_rows = connection.execute(text("SELECT id, stems_json FROM multitrack_items")).mappings().all()
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
        move_items_to_vault(db, unique_ids, target_vault.id, mode="move")
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

    try:
        if delete_contents and has_items:
            vault_item_ids = db.query(models.Item.id).filter(models.Item.vault_id == vault_id)
            db.query(models.ItemReference).filter(
                or_(
                    models.ItemReference.context_id.in_(vault_item_ids),
                    models.ItemReference.from_item_id.in_(vault_item_ids),
                    models.ItemReference.to_item_id.in_(vault_item_ids),
                )
            ).delete(synchronize_session=False)

            # Joined-table inheritance needs ORM deletion so every concrete
            # subtype row is removed before its base Item row.
            for item in db.query(models.Item).filter(models.Item.vault_id == vault_id).all():
                db.delete(item)
            db.flush()

        db.delete(vault)
        db.commit()
    except Exception:
        db.rollback()
        if staged_store and staged_store.exists() and not store.exists():
            os.replace(staged_store, store)
        raise

    if staged_store and staged_store.exists():
        if background_tasks is None:
            shutil.rmtree(staged_store)
        else:
            background_tasks.add_task(shutil.rmtree, staged_store, True)
    elif store.exists():
        store.rmdir()


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
