from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Table, Boolean, Float, Text, Index, text
from sqlalchemy.orm import relationship
import json
import datetime
from .database import Base

# Association Tables
item_tags = Table(
    "item_tags",
    Base.metadata,
    Column("item_id", Integer, ForeignKey("items.id", ondelete="CASCADE")),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"))
)

Index("ix_item_tags_item_id", item_tags.c.item_id)
Index("ix_item_tags_tag_id", item_tags.c.tag_id)

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    absolute_path = Column(String, index=True, nullable=False)
    vault_id = Column(Integer, ForeignKey("vaults.id", ondelete="RESTRICT"), index=True, nullable=False)
    file_hash = Column(String, index=True, nullable=True) # SHA-256 for integrity
    size_bytes = Column(Integer, nullable=True)
    mime_type = Column(String, nullable=True)
    parent_id = Column(Integer, ForeignKey("items.id", ondelete="CASCADE"), index=True, nullable=True)
    metadata_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    type = Column(String)

    __mapper_args__ = {
        "polymorphic_identity": "item",
        "polymorphic_on": type,
    }

    # Relationships
    tags = relationship("Tag", secondary=item_tags, back_populates="items")
    vault = relationship("Vault", back_populates="items")
    parent = relationship("Item", remote_side=[id], back_populates="children", foreign_keys=[parent_id])
    children = relationship("Item", back_populates="parent", cascade="all, delete-orphan", foreign_keys=[parent_id])

    @property
    def attributes(self) -> dict:
        try:
            return json.loads(self.metadata_json or "{}")
        except (TypeError, ValueError):
            return {}

    @attributes.setter
    def attributes(self, value: dict | None) -> None:
        self.metadata_json = json.dumps(value or {})

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
    bpm = Column(Integer, nullable=True)
    is_loop = Column(Boolean, nullable=False, default=False)
    
    __mapper_args__ = {
        "polymorphic_identity": "sample",
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
    """Concrete subtype for an unclassified, generic folder."""

    __mapper_args__ = {
        "polymorphic_identity": "collection",
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


class ItemReference(Base):
    """A project-scoped, directed edge in GAIA's logical asset graph."""

    __tablename__ = "item_references"
    __table_args__ = (
        Index(
            "uq_item_references_active_master",
            "context_id",
            unique=True,
            sqlite_where=text("is_master = 1"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    context_id = Column(Integer, ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True)
    from_item_id = Column(Integer, ForeignKey("items.id", ondelete="RESTRICT"), nullable=False, index=True)
    to_item_id = Column(Integer, ForeignKey("items.id", ondelete="RESTRICT"), nullable=False, index=True)
    relation_kind = Column(String, nullable=False, default="use")
    stage_name = Column(String, nullable=True)
    revision_label = Column(String, nullable=True)
    is_master = Column(Boolean, nullable=False, default=False)
    metadata_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow, nullable=False)

    context = relationship("Item", foreign_keys=[context_id])
    from_item = relationship("Item", foreign_keys=[from_item_id])
    to_item = relationship("Item", foreign_keys=[to_item_id])

    @property
    def attributes(self) -> dict:
        try:
            return json.loads(self.metadata_json or "{}")
        except (TypeError, ValueError):
            return {}

    @attributes.setter
    def attributes(self, value: dict | None) -> None:
        self.metadata_json = json.dumps(value or {})

    @property
    def tags(self) -> list[str]:
        values = self.attributes.get("tags", [])
        return [str(value) for value in values if str(value).strip()]

class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)

    items = relationship("Item", secondary=item_tags, back_populates="tags")

class Vault(Base):
    """A user-defined asset space with its own import policy and history."""
    __tablename__ = "vaults"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    description = Column(String, nullable=True)
    preset = Column(String, nullable=False, default="general")
    rules_json = Column(Text, nullable=False, default="{}")
    storage_key = Column(String, unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    items = relationship("Item", back_populates="vault")
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


class SinMetadataProposal(Base):
    """A metadata edit staged by SIN for GAIA to review and apply.

    The target is intentionally stored as GAIA's stable item locator rather
    than as a foreign key: a proposal remains reviewable when an asset has
    since been moved or deleted.
    """

    __tablename__ = "sin_metadata_proposals"

    id = Column(Integer, primary_key=True, index=True)
    asset_ref = Column(String, nullable=False, index=True)
    absolute_path = Column(String, nullable=False, index=True)
    field = Column(String, nullable=False, index=True)
    proposed_value_json = Column(Text, nullable=False)
    previous_value_json = Column(Text, nullable=True)
    source_node_id = Column(Integer, nullable=True)
    status = Column(String, nullable=False, default="pending", index=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow, nullable=False)
    resolved_at = Column(DateTime, nullable=True)


Index(
    "ix_sin_metadata_proposals_pending_target",
    SinMetadataProposal.asset_ref,
    SinMetadataProposal.field,
    SinMetadataProposal.status,
)
