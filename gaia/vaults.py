"""Vault policies, lifecycle helpers, and scoped import history."""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from . import models
from . import collection_importer


ORPHAN_CLEANUP_MIGRATION = "20260814_prune_orphan_joined_rows"
REFERENTIAL_CLEANUP_MIGRATION = "20260814_repair_referential_integrity"
FOLDER_CHILD_BACKFILL_MIGRATION = "20260814_backfill_folder_child_items"

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
    # Keep the many-to-many view in sync in one statement. The former ORM loop
    # loaded every asset and every membership on each startup, which became
    # costly once folders gained thousands of indexed child files.
    db.execute(text("""
        INSERT OR IGNORE INTO item_vaults (item_id, vault_id)
        SELECT id, vault_id FROM items WHERE vault_id IS NOT NULL
    """))
    db.commit()

    vault_store(vault).mkdir(parents=True, exist_ok=True)
    return _populate(vault)

def initialise_schema(engine):
    """Apply small, idempotent compatibility migrations to existing databases."""
    inspector = inspect(engine)
    if "items" in inspector.get_table_names():
        columns = {column["name"] for column in inspector.get_columns("items")}
        if "vault_id" not in columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE items ADD COLUMN vault_id INTEGER"))
        if "parent_id" not in columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE"))
    if "item_vaults" not in inspector.get_table_names():
        models.Base.metadata.tables["item_vaults"].create(bind=engine, checkfirst=True)
    if "collection_items" in inspector.get_table_names():
        collection_columns = {
            column["name"] for column in inspector.get_columns("collection_items")
        }
        if "warnings_json" not in collection_columns:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE collection_items ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'")
                )
    _apply_data_migrations(engine)


def _migration_backup(engine, migration_id: str) -> Path | None:
    """Create one recoverable SQLite copy before a destructive data migration."""
    database_path = engine.url.database
    if not database_path or database_path == ":memory:":
        return None
    source = Path(database_path).resolve()
    if not source.is_file():
        return None
    backup = source.with_name(f"{source.name}.{migration_id}.bak")
    if not backup.exists():
        source_connection = sqlite3.connect(source)
        backup_connection = sqlite3.connect(backup)
        try:
            source_connection.backup(backup_connection)
        finally:
            backup_connection.close()
            source_connection.close()
    return backup


def _apply_data_migrations(engine) -> None:
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """))
        orphan_cleanup_applied = connection.execute(
            text("SELECT 1 FROM schema_migrations WHERE id = :id"),
            {"id": ORPHAN_CLEANUP_MIGRATION},
        ).first()
    if not orphan_cleanup_applied:
        _migration_backup(engine, ORPHAN_CLEANUP_MIGRATION)
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        required_parents_by_table = (
            ("live_recording_project_items", ("project_items", "collection_items", "items")),
            ("loop_sample_items", ("sample_items", "audio_items", "items")),
            ("one_shot_sample_items", ("sample_items", "audio_items", "items")),
            ("track_items", ("audio_items", "items")),
            ("sample_pack_items", ("collection_items", "items")),
            ("multitrack_items", ("collection_items", "items")),
            ("project_items", ("collection_items", "items")),
            ("sample_items", ("audio_items", "items")),
            ("audio_items", ("items",)),
            ("midi_items", ("items",)),
            ("sequence_items", ("items",)),
            ("collection_items", ("items",)),
        )
        with engine.begin() as connection:
            for child_table, required_parents in required_parents_by_table:
                available_parents = [table for table in required_parents if table in tables]
                if child_table not in tables or not available_parents:
                    continue
                missing_parent_conditions = " OR ".join(
                    f"id NOT IN (SELECT id FROM {parent_table})"
                    for parent_table in available_parents
                )
                connection.execute(text(
                    f"DELETE FROM {child_table} "
                    f"WHERE {missing_parent_conditions}"
                ))
            connection.execute(
                text("INSERT INTO schema_migrations (id) VALUES (:id)"),
                {"id": ORPHAN_CLEANUP_MIGRATION},
            )
    _repair_referential_integrity(engine)
    _backfill_folder_child_items(engine)


def _repair_referential_integrity(engine) -> None:
    """Repair legacy rows created before SQLite FK enforcement was enabled."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as connection:
        if connection.execute(
            text("SELECT 1 FROM schema_migrations WHERE id = :id"),
            {"id": REFERENTIAL_CLEANUP_MIGRATION},
        ).first():
            return

    _migration_backup(engine, REFERENTIAL_CLEANUP_MIGRATION)
    with engine.begin() as connection:
        if {"item_tags", "items", "tags"}.issubset(tables):
            connection.execute(text("""
                DELETE FROM item_tags
                WHERE item_id NOT IN (SELECT id FROM items)
                   OR tag_id NOT IN (SELECT id FROM tags)
            """))
            connection.execute(text("""
                DELETE FROM item_tags
                WHERE rowid NOT IN (
                    SELECT MIN(rowid) FROM item_tags GROUP BY item_id, tag_id
                )
            """))
        if {"item_collections", "items", "collections"}.issubset(tables):
            connection.execute(text("""
                DELETE FROM item_collections
                WHERE item_id NOT IN (SELECT id FROM items)
                   OR collection_id NOT IN (SELECT id FROM collections)
            """))
            connection.execute(text("""
                DELETE FROM item_collections
                WHERE rowid NOT IN (
                    SELECT MIN(rowid) FROM item_collections GROUP BY item_id, collection_id
                )
            """))
        if {"item_vaults", "items", "vaults"}.issubset(tables):
            connection.execute(text("""
                DELETE FROM item_vaults
                WHERE item_id NOT IN (SELECT id FROM items)
                   OR vault_id NOT IN (SELECT id FROM vaults)
            """))
        if {"vault_import_logs", "items"}.issubset(tables):
            connection.execute(text("""
                UPDATE vault_import_logs SET item_id = NULL
                WHERE item_id IS NOT NULL AND item_id NOT IN (SELECT id FROM items)
            """))
        if {"vault_import_logs", "vaults"}.issubset(tables):
            connection.execute(text("""
                DELETE FROM vault_import_logs
                WHERE vault_id NOT IN (SELECT id FROM vaults)
            """))
        if {"items", "vaults"}.issubset(tables):
            connection.execute(text("""
                UPDATE items SET vault_id = NULL
                WHERE vault_id IS NOT NULL AND vault_id NOT IN (SELECT id FROM vaults)
            """))
        if "items" in tables:
            connection.execute(text("""
                UPDATE items SET parent_id = NULL
                WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM items)
            """))
        connection.execute(
            text("INSERT INTO schema_migrations (id) VALUES (:id)"),
            {"id": REFERENTIAL_CLEANUP_MIGRATION},
        )


def _backfill_folder_child_items(engine) -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    required = {
        "items",
        "collection_items",
        "audio_items",
        "sample_items",
        "loop_sample_items",
        "one_shot_sample_items",
        "midi_items",
        "tags",
        "item_tags",
        "schema_migrations",
    }
    if not required.issubset(tables):
        return
    item_columns = {column["name"] for column in inspector.get_columns("items")}
    if not {
        "absolute_path",
        "vault_id",
        "file_hash",
        "size_bytes",
        "mime_type",
        "parent_id",
        "created_at",
        "updated_at",
        "type",
    }.issubset(item_columns):
        return
    with engine.begin() as connection:
        if connection.execute(
            text("SELECT 1 FROM schema_migrations WHERE id = :id"),
            {"id": FOLDER_CHILD_BACKFILL_MIGRATION},
        ).first():
            return

    _migration_backup(engine, FOLDER_CHILD_BACKFILL_MIGRATION)
    with engine.begin() as connection:
        folders = connection.execute(text("""
            SELECT i.id, i.absolute_path, i.vault_id, ci.manifest_json
            FROM items i
            JOIN collection_items ci ON ci.id = i.id
        """)).mappings().all()
        for folder in folders:
            try:
                manifest = json.loads(folder["manifest_json"] or "[]")
            except (TypeError, ValueError):
                continue
            changed = False
            for entry in manifest:
                relative_path = entry.get("relative_path")
                if not relative_path:
                    continue
                absolute_path = str(
                    (Path(folder["absolute_path"]) / Path(relative_path)).resolve()
                )
                if not Path(absolute_path).is_file():
                    continue
                existing = connection.execute(
                    text("SELECT id, parent_id FROM items WHERE absolute_path = :path"),
                    {"path": absolute_path},
                ).mappings().first()
                if existing:
                    child_id = existing["id"]
                    if existing["parent_id"] is None:
                        connection.execute(
                            text("UPDATE items SET parent_id = :parent_id WHERE id = :id"),
                            {"parent_id": folder["id"], "id": child_id},
                        )
                else:
                    raw_type = entry.get("type") or "item"
                    item_type = (
                        "sample"
                        if raw_type == "audio"
                        else raw_type
                        if raw_type in {"loop", "one_shot", "sample", "midi"}
                        else "item"
                    )
                    result = connection.execute(text("""
                        INSERT INTO items (
                            absolute_path, vault_id, file_hash, size_bytes,
                            mime_type, parent_id, created_at, updated_at, type
                        ) VALUES (
                            :absolute_path, :vault_id, NULL, :size_bytes,
                            :mime_type, :parent_id, CURRENT_TIMESTAMP,
                            CURRENT_TIMESTAMP, :type
                        )
                    """), {
                        "absolute_path": absolute_path,
                        "vault_id": folder["vault_id"],
                        "size_bytes": entry.get("size_bytes"),
                        "mime_type": entry.get("mime_type"),
                        "parent_id": folder["id"],
                        "type": item_type,
                    })
                    child_id = result.lastrowid
                    if item_type in {"sample", "loop", "one_shot"}:
                        connection.execute(
                            text("INSERT OR IGNORE INTO audio_items (id) VALUES (:id)"),
                            {"id": child_id},
                        )
                        connection.execute(text(
                            "INSERT OR IGNORE INTO sample_items (id, key) VALUES (:id, :key)"
                        ), {"id": child_id, "key": entry.get("key")})
                        if item_type == "loop":
                            connection.execute(text(
                                "INSERT OR IGNORE INTO loop_sample_items (id, bpm) VALUES (:id, :bpm)"
                            ), {"id": child_id, "bpm": entry.get("bpm")})
                        elif item_type == "one_shot":
                            connection.execute(
                                text("INSERT OR IGNORE INTO one_shot_sample_items (id) VALUES (:id)"),
                                {"id": child_id},
                            )
                    elif item_type == "midi":
                        connection.execute(text(
                            "INSERT OR IGNORE INTO midi_items (id, key, bpm) VALUES (:id, :key, :bpm)"
                        ), {
                            "id": child_id,
                            "key": entry.get("key"),
                            "bpm": entry.get("bpm"),
                        })
                if "item_vaults" in tables and folder["vault_id"] is not None:
                    connection.execute(text(
                        "INSERT OR IGNORE INTO item_vaults (item_id, vault_id) VALUES (:item_id, :vault_id)"
                    ), {"item_id": child_id, "vault_id": folder["vault_id"]})
                for tag_name in list(dict.fromkeys(entry.get("tags") or [])):
                    tag_name = str(tag_name).strip()
                    if not tag_name:
                        continue
                    tag_row = connection.execute(
                        text("SELECT id FROM tags WHERE lower(name) = lower(:name)"),
                        {"name": tag_name},
                    ).first()
                    if tag_row:
                        tag_id = tag_row[0]
                    else:
                        tag_id = connection.execute(
                            text("INSERT INTO tags (name) VALUES (:name)"),
                            {"name": tag_name},
                        ).lastrowid
                    connection.execute(text("""
                        INSERT INTO item_tags (item_id, tag_id)
                        SELECT :item_id, :tag_id
                        WHERE NOT EXISTS (
                            SELECT 1 FROM item_tags
                            WHERE item_id = :item_id AND tag_id = :tag_id
                        )
                    """), {"item_id": child_id, "tag_id": tag_id})
                if entry.get("child_id") != child_id:
                    entry["child_id"] = child_id
                    changed = True
            if changed:
                connection.execute(text("""
                    UPDATE collection_items
                    SET manifest_json = :manifest, content_count = :content_count
                    WHERE id = :id
                """), {
                    "manifest": json.dumps(manifest),
                    "content_count": len(manifest),
                    "id": folder["id"],
                })
        connection.execute(
            text("INSERT INTO schema_migrations (id) VALUES (:id)"),
            {"id": FOLDER_CHILD_BACKFILL_MIGRATION},
        )

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
