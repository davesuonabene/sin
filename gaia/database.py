import json
import os

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base

SQLALCHEMY_DATABASE_URL = os.environ.get("GAIA_DATABASE_URL", "sqlite:///./gaia.db")

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record):
    """Make declared cascades effective for every GAIA SQLite connection."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()
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
        "CREATE INDEX IF NOT EXISTS ix_item_tags_item_id ON item_tags (item_id)",
        "CREATE INDEX IF NOT EXISTS ix_item_tags_tag_id ON item_tags (tag_id)",
        "CREATE INDEX IF NOT EXISTS ix_import_logs_vault_created ON vault_import_logs (vault_id, created_at)",
    )
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


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
        connection.execute(text("UPDATE items SET availability = 'ready' WHERE availability IS NULL"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_items_storage_mode ON items (storage_mode)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_items_availability ON items (availability)"))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
