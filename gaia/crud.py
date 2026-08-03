import json
import os
from sqlalchemy.orm import Session
from . import models, schemas

def _populate_item_fields(db_item):
    if not db_item:
        return db_item
    if not getattr(db_item, "title", None):
        db_item.title = os.path.basename(str(getattr(db_item, "absolute_path", "")).rstrip("/\\"))
    if isinstance(db_item, models.CollectionItem) or getattr(db_item, "type", None) in {"collection", "sample_pack", "multitrack"}:
        manifest_raw = getattr(db_item, "manifest_json", None)
        if manifest_raw:
            try:
                db_item.contents = json.loads(manifest_raw)
            except Exception:
                db_item.contents = []
        else:
            db_item.contents = []
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
    query = db.query(models.Item).filter(models.Item.absolute_path == absolute_path)
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
    item = query.first()
    return _populate_item_fields(item)

def get_items(db: Session, skip: int = 0, limit: int = 100, vault_id: int | None = None):
    query = db.query(models.Item)
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
    items = query.offset(skip).limit(limit).all()
    for item in items:
        _populate_item_fields(item)
    return items

def create_item(db: Session, item: schemas.ItemCreate):
    type_map = {
        "item": models.Item,
        "midi": models.MidiItem,
        "audio": models.AudioItem,
        "track": models.TrackItem,
        "sample": models.SampleItem,
        "loop": models.LoopSampleItem,
        "one_shot": models.OneShotSampleItem,
        "collection": models.CollectionItem,
        "sample_pack": models.SamplePackItem,
        "multitrack": models.MultitrackItem,
    }
    
    model_class = type_map.get(item.type, models.Item)

    db_item = model_class(
        absolute_path=item.absolute_path,
        vault_id=item.vault_id,
        file_hash=item.file_hash,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type or ("audio/multitrack" if item.type == "multitrack" else None)
    )
    
    if hasattr(item, "key") and hasattr(model_class, "key"):
        db_item.key = item.key
    if hasattr(item, "bpm") and hasattr(model_class, "bpm"):
        db_item.bpm = item.bpm

    if issubclass(model_class, models.CollectionItem):
        db_item.title = getattr(item, "title", None)
        db_item.source_kind = getattr(item, "source_kind", "folder")
        db_item.source_path = getattr(item, "source_path", None)
        contents_val = getattr(item, "contents", [])
        contents_list = [content.dict() if hasattr(content, "dict") else content for content in contents_val]
        db_item.manifest_json = json.dumps(contents_list)
        db_item.content_count = len(contents_list)

    if model_class == models.MultitrackItem:
        stems_val = getattr(item, "stems", [])
        if isinstance(stems_val, list):
            stems_list = [s.dict() if hasattr(s, "dict") else s for s in stems_val]
        else:
            stems_list = []
        db_item.stems_json = json.dumps(stems_list)
        db_item.is_valid_length = getattr(item, "is_valid_length", True)
        db_item.length_variance = getattr(item, "length_variance", 0.0)

    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return _populate_item_fields(db_item)

def delete_item(db: Session, item_id: int):
    db_item = get_item(db, item_id=item_id)
    if db_item:
        db.delete(db_item)
        db.commit()
    return db_item

def add_tag_to_item(db: Session, item_id: int, tag_id: int):
    db_item = get_item(db, item_id=item_id)
    db_tag = get_tag(db, tag_id=tag_id)
    if db_item and db_tag and db_tag not in db_item.tags:
        db_item.tags.append(db_tag)
        db.commit()
        db.refresh(db_item)
    return db_item

def update_item_type(db: Session, item_id: int, new_type: str):
    """Types are derived at import time in the read-only library manager."""
    return None

def get_collection_by_source(db: Session, source_path: str, vault_id: int | None = None):
    query = db.query(models.CollectionItem).filter(models.CollectionItem.source_path == source_path)
    if vault_id is not None:
        query = query.filter(models.CollectionItem.vault_id == vault_id)
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

# Collections
def get_collection(db: Session, collection_id: int):
    return db.query(models.Collection).filter(models.Collection.id == collection_id).first()

def get_collections(db: Session, skip: int = 0, limit: int = 100):
    return db.query(models.Collection).offset(skip).limit(limit).all()

def create_collection(db: Session, collection: schemas.CollectionCreate):
    db_collection = models.Collection(name=collection.name, description=collection.description)
    db.add(db_collection)
    db.commit()
    db.refresh(db_collection)
    return db_collection
