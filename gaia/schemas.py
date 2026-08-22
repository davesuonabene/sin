from pydantic import BaseModel, ConfigDict, Field
from typing import Any, List, Optional, Literal
from datetime import datetime

# Tags
class TagBase(BaseModel):
    name: str

class TagCreate(TagBase):
    pass

class Tag(TagBase):
    id: int
    model_config = ConfigDict(from_attributes=True)

# Items
class ItemBase(BaseModel):
    absolute_path: str
    file_hash: Optional[str] = None
    size_bytes: Optional[int] = None
    mime_type: Optional[str] = None
    vault_id: Optional[int] = None
    parent_id: Optional[int] = None
    attributes: dict[str, Any] = Field(default_factory=dict)

class ItemCreate(ItemBase):
    type: str = "item"

class ItemUpdate(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    attributes: Optional[dict[str, Any]] = None
    tags: Optional[List[str]] = None


class SequenceSaveRequest(BaseModel):
    name: str
    format: str = "sin-sequence"
    version: int = 1
    channels: List[dict]


class CollectionContentUpdate(BaseModel):
    title: Optional[str] = None
    type: Optional[str] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    tags: Optional[List[str]] = None

class StemInfo(BaseModel):
    filename: str
    relative_path: str
    absolute_path: str
    duration_seconds: float
    sample_rate: int = 44100
    channels: int = 2
    frames: int = 0
    stem_type: str = "Other"


class CollectionContent(BaseModel):
    index: int
    filename: str
    title: Optional[str] = None
    relative_path: str
    type: str = "file"
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = None
    duration_seconds: Optional[float] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    tags: List[str] = Field(default_factory=list)
    streamable: bool = False
    child_id: Optional[int] = None

class Item(ItemBase):
    id: int
    created_at: datetime
    updated_at: datetime
    type: str
    parent_id: Optional[int] = None
    title: Optional[str] = None
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_loop: Optional[bool] = None
    stems: Optional[List[StemInfo]] = None
    is_valid_length: Optional[bool] = None
    length_variance: Optional[float] = None
    source_kind: Optional[str] = None
    source_path: Optional[str] = None
    content_count: Optional[int] = None
    contents: Optional[List[CollectionContent]] = None
    warnings: List[str] = Field(default_factory=list)
    tags: List[Tag] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)

class MoveItemsRequest(BaseModel):
    item_ids: List[int]
    vault_id: int

class AudioItemCreate(ItemCreate):
    type: str = "audio"

class AudioItem(Item):
    pass

class TrackItemCreate(AudioItemCreate):
    type: str = "track"

class TrackItem(AudioItem):
    pass

class SampleItemCreate(AudioItemCreate):
    type: str = "sample"
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_loop: bool = False

class SampleItem(AudioItem):
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_loop: bool = False

class MidiItemCreate(ItemCreate):
    type: str = "midi"
    key: Optional[str] = None
    bpm: Optional[int] = None

class MidiItem(Item):
    key: Optional[str] = None
    bpm: Optional[int] = None

class CollectionItemCreate(ItemCreate):
    type: str = "collection"
    title: Optional[str] = None
    source_kind: str = "folder"
    source_path: Optional[str] = None
    contents: List[CollectionContent] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

class CollectionItem(Item):
    title: Optional[str] = None
    source_kind: Optional[str] = None
    source_path: Optional[str] = None
    content_count: int = 0
    contents: List[CollectionContent] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

class MultitrackItemCreate(CollectionItemCreate):
    type: str = "multitrack"
    stems: List[StemInfo] = Field(default_factory=list)
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_valid_length: bool = True
    length_variance: float = 0.0

class MultitrackItem(Item):
    stems: List[StemInfo] = Field(default_factory=list)
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_valid_length: bool = True
    length_variance: float = 0.0


class ProjectItemCreate(CollectionItemCreate):
    type: str = "project"
    source_kind: str = "managed"


class ProjectItem(CollectionItem):
    pass

# Requests
class ImportPreviewRequest(BaseModel):
    source_path: str
    vault_id: Optional[int] = None


class ImportJobCreateRequest(BaseModel):
    preview_id: str
    folder_assignments: dict[str, str] = Field(default_factory=dict)
    item_types: dict[int, str] = Field(default_factory=dict)
    excluded_indexes: List[int] = Field(default_factory=list)
    conflict_action: Optional[Literal["skip", "new_snapshot"]] = None


class ProjectCreateRequest(BaseModel):
    name: str
    project_type: str = "project"
    vault_id: Optional[int] = None


class ProjectAddItemsRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)


class ProjectAddPathsRequest(BaseModel):
    source_paths: List[str] = Field(default_factory=list)


class FolderPlacementRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)
    mode: Literal["move", "reference"]


class ProjectFromItemsRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)
    mode: Literal["single", "one_per_item"] = "single"
    name: Optional[str] = None
    project_type: str = "project"
    vault_id: Optional[int] = None


ReferenceKind = Literal["source", "component", "use", "derived", "supersedes"]


class ItemReferenceCreate(BaseModel):
    context_id: int
    from_item_id: int
    to_item_id: int
    relation_kind: ReferenceKind = "use"
    stage_name: Optional[str] = None
    revision_label: Optional[str] = None
    is_master: bool = False
    attributes: dict[str, Any] = Field(default_factory=dict)


class ProjectReferenceCreate(BaseModel):
    from_item_id: int
    to_item_id: int
    relation_kind: ReferenceKind = "use"
    stage_name: Optional[str] = None
    revision_label: Optional[str] = None
    is_master: bool = False
    attributes: dict[str, Any] = Field(default_factory=dict)


class ProjectReferenceUpdate(BaseModel):
    revision_label: Optional[str] = None


class ItemReference(ItemReferenceCreate):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProjectDerivedPathRequest(BaseModel):
    source_path: str
    from_item_id: int
    relation_kind: Literal["derived", "supersedes"] = "derived"
    stage_name: Optional[str] = None
    revision_label: Optional[str] = None
    is_master: bool = False
    target_type: Literal["audio", "track", "sample", "multitrack"] = "audio"


class ProjectProfileApplyRequest(BaseModel):
    source_item_id: int
    profile_id: str
    mark_suggested_master: bool = True


class ProjectDerivedPathResult(BaseModel):
    item: Item
    reference: ItemReference

class ItemTagRequest(BaseModel):
    tag_id: int


class VaultBase(BaseModel):
    name: str
    description: Optional[str] = None

class VaultCreate(VaultBase):
    pass

class VaultUpdate(BaseModel):
    name: str
    description: Optional[str] = None

class Vault(VaultBase):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class VaultImportLog(BaseModel):
    id: int
    vault_id: int
    source_path: str
    item_id: Optional[int] = None
    status: str
    action: str
    detail: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BatchAnalysisTarget(BaseModel):
    kind: str = "item"  # "item" or "content"
    item_id: int
    content_index: Optional[int] = None

class BatchAnalysisRequest(BaseModel):
    targets: List[BatchAnalysisTarget] = Field(default_factory=list)
    item_ids: Optional[List[int]] = None
