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

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
