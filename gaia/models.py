from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Table
from sqlalchemy.orm import relationship
import datetime
from .database import Base

# Association Tables
item_tags = Table(
    "item_tags",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id")),
    Column("tag_id", Integer, ForeignKey("tags.id"))
)

item_collections = Table(
    "item_collections",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id")),
    Column("collection_id", Integer, ForeignKey("collections.id"))
)

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    absolute_path = Column(String, unique=True, index=True, nullable=False)
    file_hash = Column(String, index=True, nullable=True) # SHA-256 for integrity
    size_bytes = Column(Integer, nullable=True)
    mime_type = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    type = Column(String)

    __mapper_args__ = {
        "polymorphic_identity": "item",
        "polymorphic_on": type,
    }

    # Relationships
    tags = relationship("Tag", secondary=item_tags, back_populates="items")
    collections = relationship("Collection", secondary=item_collections, back_populates="items")

class AudioItem(Item):
    __tablename__ = "audio_items"
    id = Column(Integer, ForeignKey("items.id"), primary_key=True)
    
    __mapper_args__ = {
        "polymorphic_identity": "audio",
    }

class TrackItem(AudioItem):
    __tablename__ = "track_items"
    id = Column(Integer, ForeignKey("audio_items.id"), primary_key=True)
    
    __mapper_args__ = {
        "polymorphic_identity": "track",
    }

class SampleItem(AudioItem):
    __tablename__ = "sample_items"
    id = Column(Integer, ForeignKey("audio_items.id"), primary_key=True)
    key = Column(String, nullable=True)
    
    __mapper_args__ = {
        "polymorphic_identity": "sample",
    }

class LoopSampleItem(SampleItem):
    __tablename__ = "loop_sample_items"
    id = Column(Integer, ForeignKey("sample_items.id"), primary_key=True)
    bpm = Column(Integer, nullable=True)
    
    __mapper_args__ = {
        "polymorphic_identity": "loop",
    }

class OneShotSampleItem(SampleItem):
    __tablename__ = "one_shot_sample_items"
    id = Column(Integer, ForeignKey("sample_items.id"), primary_key=True)
    
    __mapper_args__ = {
        "polymorphic_identity": "one_shot",
    }

class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)

    items = relationship("Item", secondary=item_tags, back_populates="tags")

class Collection(Base):
    __tablename__ = "collections"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    description = Column(String, nullable=True)

    items = relationship("Item", secondary=item_collections, back_populates="collections")
