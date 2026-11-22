import json
import os

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base

SQLALCHEMY_DATABASE_URL = os.environ.get("GAIA_DATABASE_URL", "sqlite:///./gaia.db")

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def _configure_sqlite_connection(dbapi_connection, _connection_record):
    """Apply high-throughput local SQLite PRAGMAs and foreign-key cascades."""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-65536")      # 64 MB page cache
        cursor.execute("PRAGMA mmap_size=268435456")    # 256 MB memory-mapped I/O
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA busy_timeout=5000")
    except Exception:
        # Read-only or in-memory SQLite handles may reject WAL/mmap pragmas.
        pass
    finally:
        cursor.close()


# Backwards-compatible alias used by legacy unit tests
_enable_sqlite_foreign_keys = _configure_sqlite_connection
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def migrate_sample_pack_profiles() -> None:
    """Convert the removed sample_pack subtype into collection profile metadata."""
    table_names = set(inspect(engine).get_table_names())
    if "items" not in table_names:
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text("SELECT id, metadata_json FROM items WHERE type = 'sample_pack'")
        ).mappings().all()
        for row in rows:
            try:
                attributes = json.loads(row["metadata_json"] or "{}")
            except (TypeError, ValueError):
                attributes = {}
            attributes.update(
                profile_id="sample_pack",
                profile_bundle_id="sample-packs",
                profile_label="Sample pack",
            )
            import_attributes = dict(attributes.get("import") or {})
            import_attributes["immutable"] = True
            attributes["import"] = import_attributes
            connection.execute(
                text("UPDATE items SET type = 'collection', metadata_json = :metadata WHERE id = :item_id"),
                {"metadata": json.dumps(attributes), "item_id": row["id"]},
            )
        if "sample_pack_items" in table_names:
            connection.execute(text("DROP TABLE sample_pack_items"))


def migrate_project_links() -> None:
    """Migrate the removed source relationship label to a generic project link."""
    table_names = set(inspect(engine).get_table_names())
    if "item_references" not in table_names:
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text("SELECT id, stage_name, metadata_json FROM item_references WHERE stage_name IS NOT NULL")
        ).mappings().all()
        for row in rows:
            try:
                attributes = json.loads(row["metadata_json"] or "{}")
            except (TypeError, ValueError):
                attributes = {}
            tags = attributes.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            if row["stage_name"] not in tags:
                tags.append(row["stage_name"])
            attributes["tags"] = tags
            connection.execute(
                text("UPDATE item_references SET metadata_json = :metadata, stage_name = NULL WHERE id = :reference_id"),
                {"metadata": json.dumps(attributes), "reference_id": row["id"]},
            )
        connection.execute(
            text("UPDATE item_references SET relation_kind = 'use' WHERE relation_kind = 'source'")
        )


def migrate_performance_indexes() -> None:
    """Add indexes required by the current library read paths.

    ``create_all`` does not add newly declared indexes to an existing GAIA
    database, so these are kept as an explicit idempotent migration.
    """
    table_names = set(inspect(engine).get_table_names())
    required = {
        "items",
        "item_tags",
        "vault_import_logs",
    }
    if not required.issubset(table_names):
        return
    statements = (
        "CREATE INDEX IF NOT EXISTS ix_items_parent_id ON items (parent_id)",
        "CREATE INDEX IF NOT EXISTS ix_items_vault_parent ON items (vault_id, parent_id)",
        "CREATE INDEX IF NOT EXISTS ix_items_vault_type ON items (vault_id, type)",
        "CREATE INDEX IF NOT EXISTS ix_items_parent_type_path ON items (parent_id, type, absolute_path)",
        "CREATE INDEX IF NOT EXISTS ix_item_tags_item_id ON item_tags (item_id)",
        "CREATE INDEX IF NOT EXISTS ix_item_tags_tag_id ON item_tags (tag_id)",
        "CREATE INDEX IF NOT EXISTS ix_import_logs_vault_created ON vault_import_logs (vault_id, created_at)",
    )
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        if "playlist_items" in table_names:
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_playlist_items_playlist ON playlist_items (playlist_id, position)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_playlist_items_item ON playlist_items (item_id)"))
        if "vault_mirrors" in table_names:
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_vault_mirrors_vault ON vault_mirrors (vault_id)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_vault_mirrors_root_item ON vault_mirrors (root_item_id)"))



def migrate_vault_locations() -> None:
    """Add location and loading-policy fields to existing GAIA databases."""
    table_names = set(inspect(engine).get_table_names())
    if "vaults" not in table_names:
        return
    columns = {column["name"] for column in inspect(engine).get_columns("vaults")}
    with engine.begin() as connection:
        if "custom_path" not in columns:
            connection.execute(text("ALTER TABLE vaults ADD COLUMN custom_path VARCHAR"))
        if "custom_layout" not in columns:
            # Rows created by the first custom-path implementation stored the
            # final vault directory rather than its containing storage root.
            connection.execute(
                text("ALTER TABLE vaults ADD COLUMN custom_layout VARCHAR NOT NULL DEFAULT 'vault'")
            )
        if "preview" not in columns:
            connection.execute(
                text("ALTER TABLE vaults ADD COLUMN preview VARCHAR NOT NULL DEFAULT 'quick'")
            )
        connection.execute(
            text("UPDATE vaults SET preview = 'quick' WHERE preview IS NULL OR preview NOT IN ('quick', 'lazy', 'hidden')")
        )
        connection.execute(
            text("UPDATE vaults SET custom_layout = 'vault' WHERE custom_layout IS NULL OR custom_layout NOT IN ('root', 'vault')")
        )
        connection.execute(
            text("UPDATE vaults SET custom_layout = 'root' WHERE custom_path IS NULL")
        )


def migrate_item_residency() -> None:
    """Add explicit storage and readiness state to existing library rows."""
    if "items" not in set(inspect(engine).get_table_names()):
        return
    columns = {column["name"] for column in inspect(engine).get_columns("items")}
    with engine.begin() as connection:
        if "storage_mode" not in columns:
            connection.execute(text("ALTER TABLE items ADD COLUMN storage_mode VARCHAR NOT NULL DEFAULT 'managed'"))
        if "availability" not in columns:
            connection.execute(text("ALTER TABLE items ADD COLUMN availability VARCHAR NOT NULL DEFAULT 'ready'"))
        connection.execute(text("UPDATE items SET storage_mode = 'managed' WHERE storage_mode IS NULL"))
        connection.execute(text("UPDATE items SET availability = 'ready' WHERE availability IS NULL OR availability = 'available'"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_items_storage_mode ON items (storage_mode)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_items_availability ON items (availability)"))


def migrate_project_engines() -> None:
    """Add project_kind and editor_engine columns to project_items and backfill legacy rows."""
    from pathlib import Path

    table_names = set(inspect(engine).get_table_names())
    if "project_items" not in table_names:
        return
    columns = {column["name"] for column in inspect(engine).get_columns("project_items")}
    added_engine = "editor_engine" not in columns
    added_kind = "project_kind" not in columns
    with engine.begin() as connection:
        if added_kind:
            connection.execute(
                text("ALTER TABLE project_items ADD COLUMN project_kind VARCHAR NOT NULL DEFAULT 'audio'")
            )
        if added_engine:
            connection.execute(
                text("ALTER TABLE project_items ADD COLUMN editor_engine VARCHAR NOT NULL DEFAULT 'sin'")
            )
        connection.execute(
            text("UPDATE project_items SET project_kind = 'audio' WHERE project_kind IS NULL OR project_kind = ''")
        )
        connection.execute(
            text("UPDATE project_items SET editor_engine = 'sin' WHERE editor_engine IS NULL OR editor_engine = ''")
        )
        if added_engine and "items" in table_names:
            rows = connection.execute(
                text(
                    "SELECT p.id, i.absolute_path FROM project_items p "
                    "JOIN items i ON i.id = p.id"
                )
            ).mappings().all()
            for row in rows:
                project_root = Path(row["absolute_path"])
                manifest_candidates = (
                    project_root / "project.json",
                    project_root / "files" / "edit" / "current.json",
                )
                detected_engine = "sin"
                for candidate in manifest_candidates:
                    if not candidate.is_file():
                        continue
                    try:
                        doc = json.loads(candidate.read_text(encoding="utf-8") or "{}")
                    except (OSError, ValueError, TypeError):
                        continue
                    if not isinstance(doc, dict):
                        continue
                    explicit_engine = doc.get("editor_engine") or (
                        doc.get("session", {}).get("engine") if isinstance(doc.get("session"), dict) else None
                    )
                    if explicit_engine in {"sin", "simple_media"}:
                        detected_engine = explicit_engine
                        break
                    has_legacy_editor = bool(doc.get("editor")) or bool(doc.get("edits")) or doc.get("schema") == "gaia-media-edit"
                    if has_legacy_editor:
                        detected_engine = "simple_media"
                        break
                    if isinstance(doc.get("graph"), dict):
                        detected_engine = "sin"
                        break
                connection.execute(
                    text("UPDATE project_items SET editor_engine = :engine WHERE id = :project_id"),
                    {"engine": detected_engine, "project_id": row["id"]},
                )
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_project_items_project_kind ON project_items (project_kind)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_project_items_editor_engine ON project_items (editor_engine)"))

def ensure_catalog_acceleration_raw(raw_conn) -> None:
    """Idempotently install revision tracking, changelog triggers, and FTS5 on a raw sqlite3 connection."""
    cur = raw_conn.cursor()
    try:
        tables = {
            row[0]
            for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        if "items" not in tables:
            return

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS library_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        cur.execute(
            "INSERT OR IGNORE INTO library_meta (key, value) VALUES ('library_rev', '1')"
        )
        cur.execute(
            "INSERT OR IGNORE INTO library_meta (key, value) VALUES ('fts_synced_rev', '0')"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS library_changelog (
                rev INTEGER PRIMARY KEY AUTOINCREMENT,
                entity TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                op TEXT NOT NULL,
                vault_id INTEGER
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS ix_library_changelog_entity ON library_changelog (entity, entity_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS ix_items_parent_type_path ON items (parent_id, type, absolute_path)"
        )

        # FTS5 virtual table for sub-2ms server-side search fallback / API search
        try:
            cur.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
                    item_id UNINDEXED,
                    vault_id UNINDEXED,
                    type,
                    filename,
                    title,
                    path_text,
                    tags,
                    meta_text,
                    tokenize='unicode61 remove_diacritics 2'
                )
                """
            )
        except Exception:
            # Older SQLite builds without FTS5 degrade gracefully to LIKE fallback.
            pass

        bump_rev_sql = (
            "INSERT OR REPLACE INTO library_meta(key, value) "
            "VALUES ('library_rev', CAST((SELECT COALESCE(MAX(rev), 1) FROM library_changelog) AS TEXT));"
        )

        trigger_defs: list[tuple[str, str, str]] = [
            (
                "items",
                "trg_gaia_rev_items_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_items_ai AFTER INSERT ON items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('item', NEW.id, 'upsert', NEW.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "items",
                "trg_gaia_rev_items_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_items_au AFTER UPDATE ON items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('item', NEW.id, 'upsert', NEW.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "items",
                "trg_gaia_rev_items_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_items_ad AFTER DELETE ON items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('item', OLD.id, 'delete', OLD.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "item_tags",
                "trg_gaia_rev_item_tags_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_item_tags_ai AFTER INSERT ON item_tags
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('item', NEW.item_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "item_tags",
                "trg_gaia_rev_item_tags_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_item_tags_ad AFTER DELETE ON item_tags
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('item', OLD.item_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "tags",
                "trg_gaia_rev_tags_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_tags_ai AFTER INSERT ON tags
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('tag', NEW.id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "tags",
                "trg_gaia_rev_tags_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_tags_au AFTER UPDATE ON tags
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('tag', NEW.id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "tags",
                "trg_gaia_rev_tags_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_tags_ad AFTER DELETE ON tags
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('tag', OLD.id, 'delete', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vaults",
                "trg_gaia_rev_vaults_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_vaults_ai AFTER INSERT ON vaults
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', NEW.id, 'upsert', NEW.id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vaults",
                "trg_gaia_rev_vaults_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_vaults_au AFTER UPDATE ON vaults
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', NEW.id, 'upsert', NEW.id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vaults",
                "trg_gaia_rev_vaults_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_vaults_ad AFTER DELETE ON vaults
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', OLD.id, 'delete', OLD.id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vault_mirrors",
                "trg_gaia_rev_mirrors_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_mirrors_ai AFTER INSERT ON vault_mirrors
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', NEW.vault_id, 'upsert', NEW.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vault_mirrors",
                "trg_gaia_rev_mirrors_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_mirrors_au AFTER UPDATE ON vault_mirrors
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', NEW.vault_id, 'upsert', NEW.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "vault_mirrors",
                "trg_gaia_rev_mirrors_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_mirrors_ad AFTER DELETE ON vault_mirrors
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('vault', OLD.vault_id, 'upsert', OLD.vault_id);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlists",
                "trg_gaia_rev_playlists_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlists_ai AFTER INSERT ON playlists
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', NEW.id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlists",
                "trg_gaia_rev_playlists_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlists_au AFTER UPDATE ON playlists
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', NEW.id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlists",
                "trg_gaia_rev_playlists_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlists_ad AFTER DELETE ON playlists
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', OLD.id, 'delete', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlist_items",
                "trg_gaia_rev_playlist_items_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlist_items_ai AFTER INSERT ON playlist_items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', NEW.playlist_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlist_items",
                "trg_gaia_rev_playlist_items_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlist_items_au AFTER UPDATE ON playlist_items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', NEW.playlist_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "playlist_items",
                "trg_gaia_rev_playlist_items_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_playlist_items_ad AFTER DELETE ON playlist_items
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('playlist', OLD.playlist_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "item_references",
                "trg_gaia_rev_refs_ai",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_refs_ai AFTER INSERT ON item_references
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('project_ref', NEW.context_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "item_references",
                "trg_gaia_rev_refs_au",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_refs_au AFTER UPDATE ON item_references
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('project_ref', NEW.context_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
            (
                "item_references",
                "trg_gaia_rev_refs_ad",
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_refs_ad AFTER DELETE ON item_references
                BEGIN
                    INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                    VALUES ('project_ref', OLD.context_id, 'upsert', NULL);
                    {bump_rev_sql}
                END
                """,
            ),
        ]

        for subtype_table in ("sample_items", "midi_items", "multitrack_items", "collection_items", "project_items"):
            trigger_defs.append(
                (
                    subtype_table,
                    f"trg_gaia_rev_{subtype_table}_au",
                    f"""
                    CREATE TRIGGER IF NOT EXISTS trg_gaia_rev_{subtype_table}_au AFTER UPDATE ON {subtype_table}
                    BEGIN
                        INSERT INTO library_changelog(entity, entity_id, op, vault_id)
                        VALUES ('item', NEW.id, 'upsert', NULL);
                        {bump_rev_sql}
                    END
                    """,
                )
            )

        for tbl_name, _trg_name, ddl in trigger_defs:
            if tbl_name in tables:
                cur.execute(ddl)
    finally:
        cur.close()


def migrate_catalog_acceleration(target_engine=None) -> None:
    """Install catalog revision/changelog tables, FTS5 index, and atomic triggers."""
    eng = target_engine or engine
    raw_conn = eng.raw_connection()
    try:
        ensure_catalog_acceleration_raw(raw_conn)
        raw_conn.commit()
    finally:
        raw_conn.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
