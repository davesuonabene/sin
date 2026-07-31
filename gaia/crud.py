from sqlalchemy.orm import Session
from . import models, schemas

# Items
def get_item(db: Session, item_id: int):
    return db.query(models.Item).filter(models.Item.id == item_id).first()

def get_item_by_path(db: Session, absolute_path: str):
    return db.query(models.Item).filter(models.Item.absolute_path == absolute_path).first()

def get_items(db: Session, skip: int = 0, limit: int = 100):
    return db.query(models.Item).offset(skip).limit(limit).all()

def create_item(db: Session, item: schemas.ItemCreate):
    type_map = {
        "item": models.Item,
        "midi": models.MidiItem,
        "audio": models.AudioItem,
        "track": models.TrackItem,
        "sample": models.SampleItem,
        "loop": models.LoopSampleItem,
        "one_shot": models.OneShotSampleItem,
    }
    
    model_class = type_map.get(item.type, models.Item)

    db_item = model_class(
        absolute_path=item.absolute_path,
        file_hash=item.file_hash,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type
    )
    
    if hasattr(item, "key") and hasattr(model_class, "key"):
        db_item.key = item.key
    if hasattr(item, "bpm") and hasattr(model_class, "bpm"):
        db_item.bpm = item.bpm

    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item

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
    db_item = get_item(db, item_id=item_id)
    if db_item:
        db.query(models.Item).filter(models.Item.id == item_id).update({"type": new_type})
        db.commit()
        db.refresh(db_item)
    return db_item

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
