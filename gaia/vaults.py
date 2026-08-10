"""Vault policies, lifecycle helpers, and scoped import history."""
from __future__ import annotations

import re
from pathlib import Path
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from . import models
from . import collection_importer

def vault_store(vault) -> Path:
    """A vault is a virtual view over GAIA's central asset store."""
    return collection_importer.ASSET_STORE

def _populate(vault):
    return vault

def ensure_default_vault(db: Session):
    vault = db.query(models.Vault).order_by(models.Vault.id).first()
    if not vault:
        vault = models.Vault(name="Default vault", description="Default GAIA asset space")
        db.add(vault)
        db.commit()
        db.refresh(vault)
    db.query(models.Item).filter(models.Item.vault_id.is_(None)).update({models.Item.vault_id: vault.id}, synchronize_session=False)
    db.commit()

    items_with_vault = db.query(models.Item).filter(models.Item.vault_id.isnot(None)).all()
    for item in items_with_vault:
        if not item.vaults:
            target_vault = db.query(models.Vault).filter(models.Vault.id == item.vault_id).first() or vault
            item.vaults.append(target_vault)
    db.commit()

    for existing_vault in db.query(models.Vault).all():
        vault_store(existing_vault).mkdir(parents=True, exist_ok=True)
    return _populate(vault)

def initialise_schema(engine):
    """Add the vault link and item_vaults table for databases created before they existed."""
    inspector = inspect(engine)
    if "items" in inspector.get_table_names():
        columns = {column["name"] for column in inspector.get_columns("items")}
        if "vault_id" not in columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE items ADD COLUMN vault_id INTEGER"))
    if "item_vaults" not in inspector.get_table_names():
        models.Base.metadata.tables["item_vaults"].create(bind=engine, checkfirst=True)

def get_vault(db: Session, vault_id: int):
    vault = db.query(models.Vault).filter(models.Vault.id == vault_id).first()
    return _populate(vault) if vault else None

def get_vaults(db: Session):
    ensure_default_vault(db)
    return [_populate(vault) for vault in db.query(models.Vault).order_by(models.Vault.name).all()]

def create_vault(db: Session, name: str, description: str | None):
    if db.query(models.Vault).filter(models.Vault.name == name).first():
        raise ValueError("A vault with this name already exists")
    vault = models.Vault(name=name, description=description)
    db.add(vault)
    db.commit()
    db.refresh(vault)
    vault_store(vault).mkdir(parents=True, exist_ok=True)
    return _populate(vault)

def log_import(db: Session, vault_id: int, source_path: str, status: str, action: str, item_id: int | None = None, detail: str | None = None):
    entry = models.VaultImportLog(vault_id=vault_id, source_path=source_path, status=status, action=action, item_id=item_id, detail=detail)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry

def get_logs(db: Session, vault_id: int, limit: int = 100):
    return db.query(models.VaultImportLog).filter(models.VaultImportLog.vault_id == vault_id).order_by(models.VaultImportLog.created_at.desc()).limit(limit).all()
