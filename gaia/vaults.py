"""Physical vault ownership and managed asset movement for GAIA."""

from __future__ import annotations

import json
from pathlib import Path
import re

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import models, paths


def _slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", "-", (value or "").strip().lower())
    return normalized.strip("-") or "vault"


def _storage_key(name: str) -> str:
    """Return the immutable, name-derived directory key for a new vault."""
    return _slug(name)


def vault_store(vault: models.Vault) -> Path:
    """Return the physical directory that owns a vault's managed assets."""
    return paths.vaults_directory() / vault.storage_key


def _populate(vault: models.Vault) -> models.Vault:
    return vault


def ensure_default_vault(db: Session) -> models.Vault:
    vault = db.query(models.Vault).order_by(models.Vault.id).first()
    if vault is None:
        vault = models.Vault(
            name="Default vault",
            description="Default GAIA asset space",
            storage_key=_storage_key("Default vault"),
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


def _replace_path_values(value, operations: list[dict]):
    if isinstance(value, str):
        return _replace_path(value, operations)
    if isinstance(value, list):
        return [_replace_path_values(entry, operations) for entry in value]
    if isinstance(value, dict):
        return {key: _replace_path_values(entry, operations) for key, entry in value.items()}
    return value


def rewrite_managed_paths(connection, operations: list[dict]) -> None:
    """Keep all stored managed paths accurate after a normal vault move."""
    item_rows = connection.execute(text("SELECT id, absolute_path, metadata_json FROM items")).mappings().all()
    for row in item_rows:
        absolute_path = _replace_path(row["absolute_path"], operations)
        metadata_json = row["metadata_json"]
        try:
            rewritten_metadata = json.dumps(_replace_path_values(json.loads(metadata_json or "{}"), operations))
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
        source_path = _replace_path(row["source_path"], operations)
        manifest_json = row["manifest_json"]
        try:
            rewritten_manifest = json.dumps(_replace_path_values(json.loads(manifest_json or "[]"), operations))
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
        source_path = _replace_path(row["source_path"], operations)
        if source_path != row["source_path"]:
            connection.execute(
                text("UPDATE vault_import_logs SET source_path = :source_path WHERE id = :id"),
                {"id": row["id"], "source_path": source_path},
            )


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


def move_items_to_vault(db: Session, item_ids: list[int], vault_id: int) -> list[models.Item]:
    """Physically move selected assets (or their owning roots) to one vault."""
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
    for root in roots.values():
        if root.vault_id == target_vault.id:
            continue
        source = Path(root.absolute_path).resolve()
        owner = get_vault(db, root.vault_id)
        if not owner or not _is_within(vault_store(owner), source):
            raise ValueError("Only managed vault assets can be moved")
        destination = (vault_store(target_vault) / source.name).resolve()
        if destination.exists():
            raise ValueError(f"Target vault already contains '{source.name}'")
        operations.append({"source": str(source), "target": str(destination)})
    if not operations:
        return list(roots.values())

    try:
        for operation in operations:
            source = Path(operation["source"])
            target = Path(operation["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
        for root in roots.values():
            if root.vault_id == target_vault.id:
                continue
            stack = [root]
            while stack:
                current = stack.pop()
                current.vault_id = target_vault.id
                stack.extend(current.children)
        db.flush()
        rewrite_managed_paths(db.connection(), operations)
        db.commit()
    except Exception:
        db.rollback()
        for operation in reversed(operations):
            source = Path(operation["source"])
            target = Path(operation["target"])
            if target.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                target.replace(source)
        raise
    return [db.query(models.Item).filter(models.Item.id == root_id).one() for root_id in roots]


def get_vault(db: Session, vault_id: int) -> models.Vault | None:
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if vault:
        vault_store(vault).mkdir(parents=True, exist_ok=True)
        return _populate(vault)
    return None


def get_vaults(db: Session) -> list[models.Vault]:
    ensure_default_vault(db)
    vaults = db.query(models.Vault).order_by(models.Vault.name).all()
    for vault in vaults:
        vault_store(vault).mkdir(parents=True, exist_ok=True)
    return [_populate(vault) for vault in vaults]


def create_vault(db: Session, name: str, description: str | None) -> models.Vault:
    if db.query(models.Vault).filter(models.Vault.name == name).first():
        raise ValueError("Vault name already exists")
    storage_key = _storage_key(name)
    if db.query(models.Vault).filter(models.Vault.storage_key == storage_key).first():
        raise ValueError("Vault name conflicts with an existing vault folder")
    vault = models.Vault(name=name, description=description, storage_key=storage_key)
    db.add(vault)
    db.commit()
    db.refresh(vault)
    vault_store(vault).mkdir(parents=True, exist_ok=True)
    return _populate(vault)


def update_vault(db: Session, vault_id: int, name: str, description: str | None) -> models.Vault:
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
    db.commit()
    db.refresh(vault)
    return _populate(vault)


def delete_vault(db: Session, vault_id: int) -> None:
    """Delete an empty vault while protecting managed assets and the final vault."""
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    if not vault:
        raise ValueError("Vault not found")
    if db.query(models.Vault).count() <= 1:
        raise ValueError("The last vault cannot be deleted")
    if db.query(models.Item.id).filter(models.Item.vault_id == vault_id).first() is not None:
        raise ValueError("Move or delete the vault's assets before deleting it")

    store = vault_store(vault)
    if store.exists() and any(store.iterdir()):
        raise ValueError("The vault folder is not empty")
    db.delete(vault)
    db.commit()
    if store.exists():
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
    else:
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
