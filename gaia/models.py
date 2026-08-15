from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Table, Boolean, Float, Text
from sqlalchemy.orm import relationship
import datetime
from .database import Base

# Association Tables
item_tags = Table(
    "item_tags",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id", ondelete="CASCADE")),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"))
)

item_collections = Table(
    "item_collections",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id", ondelete="CASCADE")),
    Column("collection_id", Integer, ForeignKey("collections.id", ondelete="CASCADE"))
)

item_vaults = Table(
    "item_vaults",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id", ondelete="CASCADE"), primary_key=True),
    Column("vault_id", Integer, ForeignKey("vaults.id", ondelete="CASCADE"), primary_key=True),
)

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    absolute_path = Column(String, index=True, nullable=False)
    vault_id = Column(Integer, ForeignKey("vaults.id", ondelete="SET NULL"), index=True, nullable=True)
    file_hash = Column(String, index=True, nullable=True) # SHA-256 for integrity
    size_bytes = Column(Integer, nullable=True)
    mime_type = Column(String, nullable=True)
    parent_id = Column(Integer, ForeignKey("items.id", ondelete="CASCADE"), index=True, nullable=True)
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
    vault = relationship("Vault", back_populates="direct_items")
    vaults = relationship("Vault", secondary=item_vaults, back_populates="items", passive_deletes=True)
    parent = relationship("Item", remote_side=[id], back_populates="children", foreign_keys=[parent_id])
    children = relationship("Item", back_populates="parent", cascade="all, delete-orphan", foreign_keys=[parent_id])

class MidiItem(Item):
    __tablename__ = "midi_items"
    id = Column(Integer, ForeignKey("items.id"), primary_key=True)
    key = Column(String, nullable=True)
    bpm = Column(Integer, nullable=True)

    __mapper_args__ = {
        "polymorphic_identity": "midi",
    }


class SequenceItem(Item):
    __tablename__ = "sequence_items"
    id = Column(Integer, ForeignKey("items.id"), primary_key=True)

    __mapper_args__ = {
        "polymorphic_identity": "sequence",
    }


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

class FolderItem(Item):
    """Base persistence model for typed folders managed by GAIA."""
    __tablename__ = "collection_items"
    id = Column(Integer, ForeignKey("items.id"), primary_key=True)
    title = Column(String, nullable=True)
    source_kind = Column(String, nullable=False)  # folder | zip | managed
    source_path = Column(String, nullable=True)
    manifest_json = Column(String, nullable=True)
    content_count = Column(Integer, default=0)
    warnings_json = Column(Text, nullable=False, default="[]")

    __mapper_args__ = {
        "polymorphic_identity": "folder",
    }


class CollectionItem(FolderItem):
    """Compatibility subtype for an unclassified, generic folder."""

    __mapper_args__ = {
        "polymorphic_identity": "collection",
    }


class SamplePackItem(FolderItem):
    __tablename__ = "sample_pack_items"
    id = Column(Integer, ForeignKey("collection_items.id"), primary_key=True)

    __mapper_args__ = {
        "polymorphic_identity": "sample_pack",
    }


class MultitrackItem(FolderItem):
    """A folder interpreted as a collection of aligned audio stems."""
    __tablename__ = "multitrack_items"
    id = Column(Integer, ForeignKey("collection_items.id"), primary_key=True)
    stems_json = Column(String, nullable=True)
    key = Column(String, nullable=True)
    bpm = Column(Integer, nullable=True)
    is_valid_length = Column(Boolean, default=True)
    length_variance = Column(Float, default=0.0)

    __mapper_args__ = {
        "polymorphic_identity": "multitrack",
    }


class ProjectItem(FolderItem):
    """Base class for user-created project workflows."""
    __tablename__ = "project_items"
    id = Column(Integer, ForeignKey("collection_items.id"), primary_key=True)

    __mapper_args__ = {
        "polymorphic_identity": "project",
    }


class LiveRecordingProjectItem(ProjectItem):
    """Project workflow for raw live recordings through mastered exports."""
    __tablename__ = "live_recording_project_items"
    id = Column(Integer, ForeignKey("project_items.id"), primary_key=True)

    __mapper_args__ = {
        "polymorphic_identity": "live_recording_project",
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


class Vault(Base):
    """A user-defined asset space with its own import policy and history."""
    __tablename__ = "vaults"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    description = Column(String, nullable=True)
    preset = Column(String, nullable=False, default="general")
    rules_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    items = relationship("Item", secondary=item_vaults, back_populates="vaults", passive_deletes=True)
    direct_items = relationship("Item", back_populates="vault")
    import_logs = relationship("VaultImportLog", back_populates="vault", cascade="all, delete-orphan")


class VaultImportLog(Base):
    __tablename__ = "vault_import_logs"

    id = Column(Integer, primary_key=True, index=True)
    vault_id = Column(Integer, ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False, index=True)
    source_path = Column(String, nullable=False)
    item_id = Column(Integer, ForeignKey("items.id", ondelete="SET NULL"), nullable=True)
    status = Column(String, nullable=False)  # imported | duplicate | rejected | failed
    action = Column(String, nullable=False, default="imported")
    detail = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    vault = relationship("Vault", back_populates="import_logs")
