import json
import os
from pathlib import Path
from sqlalchemy import delete, func, insert, update
from sqlalchemy.orm import Session
from . import models, schemas, type_registry

def _populate_item_fields(db_item):
    if not db_item:
        return db_item
    if not getattr(db_item, "title", None):
        db_item.title = os.path.basename(str(getattr(db_item, "absolute_path", "")).rstrip("/\\"))
    if isinstance(db_item, models.FolderItem) or type_registry.is_folder_type(getattr(db_item, "type", None)):
        manifest_contents = []
        manifest_raw = getattr(db_item, "manifest_json", None)
        if manifest_raw:
            try:
                manifest_contents = json.loads(manifest_raw)
            except Exception:
                manifest_contents = []

        # Child rows are canonical when present, but merge them over the
        # manifest rather than discarding manifest-only entries. This keeps
        # legacy and interrupted imports readable during gradual backfill.
        contents_by_path = {
            os.path.normcase(os.path.normpath(entry.get("relative_path", ""))): dict(entry)
            for entry in manifest_contents
            if entry.get("relative_path")
        }
        content_order = [
            os.path.normcase(os.path.normpath(entry.get("relative_path", "")))
            for entry in manifest_contents
            if entry.get("relative_path")
        ]

        if hasattr(db_item, "children") and db_item.children:
            from pathlib import Path
            collection_root = Path(db_item.absolute_path)
            for child in sorted(db_item.children, key=lambda c: c.absolute_path):
                child_analysis = (getattr(child, "attributes", {}) or {}).get("analysis", {})
                try:
                    rel_p = Path(child.absolute_path).relative_to(collection_root).as_posix()
                except ValueError:
                    rel_p = os.path.basename(child.absolute_path)
                path_key = os.path.normcase(os.path.normpath(rel_p))
                existing = contents_by_path.get(path_key, {})
                contents_by_path[path_key] = {
                    **existing,
                    "index": existing.get("index"),
                    "filename": os.path.basename(child.absolute_path),
                    "title": getattr(child, "title", None) or existing.get("title") or os.path.basename(child.absolute_path),
                    "relative_path": rel_p,
                    "type": child.type,
                    "mime_type": child.mime_type,
                    "size_bytes": child.size_bytes,
                    "duration_seconds": existing.get("duration_seconds"),
                    "bpm": getattr(child, "bpm", None) if getattr(child, "bpm", None) is not None else child_analysis.get("bpm"),
                    "key": getattr(child, "key", None) if getattr(child, "key", None) is not None else child_analysis.get("key"),
                    "is_loop": getattr(child, "is_loop", None) if child.type == "sample" else child_analysis.get("is_loop"),
                    "tags": [t.name for t in getattr(child, "tags", [])],
                    "streamable": child.type in {"audio", "track", "sample"},
                    "child_id": child.id,
                }
                if path_key not in content_order:
                    content_order.append(path_key)

        contents = [contents_by_path[key] for key in content_order if key in contents_by_path]
        for index, content in enumerate(contents):
            if content.get("index") is None:
                content["index"] = index
        db_item.contents = contents
        db_item.content_count = len(contents)
        try:
            db_item.warnings = json.loads(getattr(db_item, "warnings_json", None) or "[]")
        except Exception:
            db_item.warnings = []
    if isinstance(db_item, models.MultitrackItem) or getattr(db_item, "type", None) == "multitrack":
        stems_raw = getattr(db_item, "stems_json", None)
        if stems_raw:
            try:
                db_item.stems = json.loads(stems_raw)
            except Exception:
                db_item.stems = []
        else:
            db_item.stems = []
    return db_item

# Items
def get_item(db: Session, item_id: int):
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    return _populate_item_fields(item)

def get_item_by_path(db: Session, absolute_path: str, vault_id: int | None = None):
    norm_path = os.path.abspath(absolute_path)
    query = db.query(models.Item).filter(models.Item.absolute_path == norm_path)
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
    item = query.first()
    if item:
        return _populate_item_fields(item)

    # Check if norm_path matches source_path or is inside a CollectionItem's source_path
    collections_query = db.query(models.FolderItem).filter(models.FolderItem.source_path.isnot(None))
    if vault_id is not None:
        collections_query = collections_query.filter(models.FolderItem.vault_id == vault_id)
    collections = collections_query.all()
    for col in collections:
        if not col.source_path:
            continue
        try:
            col_source = os.path.abspath(col.source_path)
            if norm_path == col_source:
                return _populate_item_fields(col)
            if os.path.commonpath([col_source, norm_path]) == col_source:
                rel = os.path.relpath(norm_path, col_source)
                target_managed_path = os.path.abspath(os.path.join(col.absolute_path, rel))
                sub_item = db.query(models.Item).filter(models.Item.absolute_path == target_managed_path).first()
                if sub_item:
                    return _populate_item_fields(sub_item)
        except ValueError:
            pass

    # Keep resolving the original source path through the import ledger so
    # callers and repeat scans do not create duplicates after a managed copy.
    source_values = {absolute_path, norm_path}
    log_query = db.query(models.VaultImportLog).filter(
        models.VaultImportLog.source_path.in_(source_values),
        models.VaultImportLog.item_id.isnot(None),
    )
    if vault_id is not None:
        log_query = log_query.filter(models.VaultImportLog.vault_id == vault_id)
    source_log = log_query.order_by(models.VaultImportLog.created_at.desc()).first()
    if source_log:
        source_item = db.query(models.Item).filter(models.Item.id == source_log.item_id).first()
        if source_item:
            return _populate_item_fields(source_item)

    return None

def get_items(db: Session, skip: int = 0, limit: int = 100, vault_id: int | None = None, include_children: bool = False):
    query = db.query(models.Item)
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
        if not include_children:
            from sqlalchemy.orm import aliased
            parent_alias = aliased(models.Item)
            query = query.outerjoin(parent_alias, models.Item.parent_id == parent_alias.id)
            query = query.filter(
                models.Item.parent_id.is_(None) |
                ~(parent_alias.vault_id == vault_id)
            )
    else:
        if not include_children:
            query = query.filter(models.Item.parent_id.is_(None))
    items = query.offset(skip).limit(limit).all()
    for item in items:
        _populate_item_fields(item)
    return items

def create_item(db: Session, item: schemas.ItemCreate, *, commit: bool = True):
    if item.vault_id is None:
        raise ValueError("GAIA items require an owning vault")
    # Library rows point only to physical vault-owned paths.  Import services
    # copy external sources before registering them, keeping ownership and
    # filesystem location aligned.
    from . import vaults

    vault = vaults.get_vault(db, item.vault_id)
    if not vault:
        raise ValueError("Vault not found")
    try:
        Path(item.absolute_path).resolve().relative_to(vaults.vault_store(vault).resolve())
    except ValueError as exc:
        raise ValueError("Item path must be inside its owning vault") from exc

    type_map = {
        "item": models.Item,
        "midi": models.MidiItem,
        "sequence": models.SequenceItem,
        "audio": models.AudioItem,
        "track": models.TrackItem,
        "sample": models.SampleItem,
        "collection": models.CollectionItem,
        "multitrack": models.MultitrackItem,
        "project": models.ProjectItem,
    }
    
    model_class = type_map.get(item.type, models.Item)

    db_item = model_class(
        absolute_path=item.absolute_path,
        vault_id=item.vault_id,
        parent_id=getattr(item, "parent_id", None),
        file_hash=item.file_hash,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type or ("audio/multitrack" if item.type == "multitrack" else None)
    )
    db_item.metadata_json = json.dumps(getattr(item, "attributes", {}) or {})
    
    if hasattr(item, "key") and hasattr(model_class, "key"):
        db_item.key = item.key
    if hasattr(item, "bpm") and hasattr(model_class, "bpm"):
        db_item.bpm = item.bpm
    if hasattr(item, "is_loop") and hasattr(model_class, "is_loop"):
        db_item.is_loop = bool(item.is_loop)

    if issubclass(model_class, models.FolderItem):
        db_item.title = getattr(item, "title", None)
        db_item.source_kind = getattr(item, "source_kind", "folder")
        db_item.source_path = getattr(item, "source_path", None)
        contents_val = getattr(item, "contents", [])
        contents_list = [content.model_dump() if hasattr(content, "model_dump") else content.dict() if hasattr(content, "dict") else content for content in contents_val]
        db_item.manifest_json = json.dumps(contents_list)
        db_item.content_count = len(contents_list)
        db_item.warnings_json = json.dumps(list(getattr(item, "warnings", []) or []))

    if model_class == models.MultitrackItem:
        stems_val = getattr(item, "stems", [])
        if isinstance(stems_val, list):
            stems_list = [s.model_dump() if hasattr(s, "model_dump") else s.dict() if hasattr(s, "dict") else s for s in stems_val]
        else:
            stems_list = []
        db_item.stems_json = json.dumps(stems_list)
        db_item.is_valid_length = getattr(item, "is_valid_length", True)
        db_item.length_variance = getattr(item, "length_variance", 0.0)

    db.add(db_item)
    if commit:
        db.commit()
        db.refresh(db_item)
    else:
        db.flush()
    return _populate_item_fields(db_item)

def delete_item(db: Session, item_id: int):
    db_item = get_item(db, item_id=item_id)
    if db_item:
        subtree_ids = {db_item.id}
        frontier = [db_item.id]
        while frontier:
            child_ids = [
                row[0]
                for row in db.query(models.Item.id)
                .filter(models.Item.parent_id.in_(frontier))
                .all()
                if row[0] not in subtree_ids
            ]
            subtree_ids.update(child_ids)
            frontier = child_ids
        external_references = (
            db.query(models.ItemReference)
            .filter(
                (models.ItemReference.from_item_id.in_(subtree_ids))
                | (models.ItemReference.to_item_id.in_(subtree_ids))
            )
            .filter(~models.ItemReference.context_id.in_(subtree_ids))
            .count()
        )
        if external_references:
            raise ValueError("Item is referenced by a project; remove those references before deleting it")
        # ``context_id`` cascades at the database level, but a project is also
        # commonly the ``from_item_id`` of its own references.  SQLite checks
        # the RESTRICT endpoint foreign keys while SQLAlchemy is deleting the
        # item, before the context cascade can remove those rows.  Delete the
        # project-scoped edges explicitly so the item and its graph context
        # are removed in one transaction.
        db.query(models.ItemReference).filter(
            models.ItemReference.context_id.in_(subtree_ids)
        ).delete(synchronize_session=False)
        db.query(models.VaultImportLog).filter(
            models.VaultImportLog.item_id.in_(subtree_ids)
        ).update({models.VaultImportLog.item_id: None}, synchronize_session=False)
        db.delete(db_item)
        try:
            db.commit()
        except Exception:
            db.rollback()
            raise
    return db_item

def add_tag_to_item(db: Session, item_id: int, tag_id: int):
    db_item = get_item(db, item_id=item_id)
    db_tag = get_tag(db, tag_id=tag_id)
    if db_item and db_tag and db_tag not in db_item.tags:
        db_item.tags.append(db_tag)
        db.commit()
        db.refresh(db_item)
    return db_item


def set_item_tags(db: Session, item_id: int, names: list[str], *, commit: bool = True):
    db_item = get_item(db, item_id)
    if not db_item:
        return None
    clean_names = []
    seen_names = set()
    for raw_name in names:
        name = raw_name.strip() if raw_name else ""
        normalized = name.casefold()
        if name and normalized not in seen_names:
            seen_names.add(normalized)
            clean_names.append(name)
    existing = {
        tag.name.casefold(): tag
        for tag in db.query(models.Tag)
        .filter(func.lower(models.Tag.name).in_([name.casefold() for name in clean_names]))
        .all()
    }
    tags = []
    for name in clean_names:
        tag = existing.get(name.casefold())
        if not tag:
            tag = models.Tag(name=name)
            db.add(tag)
            existing[name.casefold()] = tag
        tags.append(tag)
    db_item.tags = tags
    if commit:
        db.commit()
        db.refresh(db_item)
    else:
        db.flush()
    return _populate_item_fields(db_item)


def save_collection_contents(
    db: Session,
    item: models.FolderItem,
    contents: list[dict],
    *,
    commit: bool = True,
):
    item.manifest_json = json.dumps(contents)
    item.content_count = len(contents)
    if commit:
        db.commit()
        db.refresh(item)
    else:
        db.flush()
    return _populate_item_fields(item)


def reclassify_audio(db: Session, item_id: int, new_type: str):
    """Move an item among the concrete audio, sample, and track types."""
    db_item = get_item(db, item_id)
    audio_types = {"audio", "sample", "track"}
    if not db_item or db_item.type not in audio_types or new_type not in audio_types:
        return None
    if db_item.type == new_type:
        return db_item

    db.expunge(db_item)
    db.execute(delete(models.TrackItem.__table__).where(models.TrackItem.__table__.c.id == item_id))
    if new_type != "sample":
        db.execute(delete(models.SampleItem.__table__).where(models.SampleItem.__table__.c.id == item_id))
    if new_type == "sample":
        db.execute(insert(models.SampleItem.__table__).prefix_with("OR IGNORE").values(id=item_id, is_loop=False))
    elif new_type == "track":
        db.execute(insert(models.TrackItem.__table__).prefix_with("OR IGNORE").values(id=item_id))
    db.execute(update(models.Item.__table__).where(models.Item.__table__.c.id == item_id).values(type=new_type))
    db.commit()
    return get_item(db, item_id)


def get_collection_by_source(db: Session, source_path: str, vault_id: int | None = None):
    query = db.query(models.FolderItem).filter(models.FolderItem.source_path == source_path)
    if vault_id is not None:
        query = query.filter(models.FolderItem.vault_id == vault_id)
    return (
        query.first()
    )

# Tags
def get_tag(db: Session, tag_id: int):
    return db.query(models.Tag).filter(models.Tag.id == tag_id).first()

def get_tag_by_name(db: Session, name: str):
    return db.query(models.Tag).filter(models.Tag.name == name).first()

def get_tags(db: Session, skip: int = 0, limit: int = 100):
    return db.query(models.Tag).offset(skip).limit(limit).all()

def create_tag(db: Session, tag: schemas.TagCreate):
    db_tag = models.Tag(name=tag.name)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag

def get_or_create_tag(db: Session, name: str):
    db_tag = get_tag_by_name(db, name=name)
    if db_tag:
        return db_tag
    db_tag = models.Tag(name=name)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag
