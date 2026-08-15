from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional, Literal
from datetime import datetime

# Tags
class TagBase(BaseModel):
    name: str

class TagCreate(TagBase):
    pass

class Tag(TagBase):
    id: int
    model_config = ConfigDict(from_attributes=True)

# Collections
class CollectionBase(BaseModel):
    name: str
    description: Optional[str] = None

class CollectionCreate(CollectionBase):
    pass

class Collection(CollectionBase):
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

class ItemCreate(ItemBase):
    type: str = "item"

class ItemUpdate(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
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
    stems: Optional[List[StemInfo]] = None
    is_valid_length: Optional[bool] = None
    length_variance: Optional[float] = None
    source_kind: Optional[str] = None
    source_path: Optional[str] = None
    content_count: Optional[int] = None
    contents: Optional[List[CollectionContent]] = None
    warnings: List[str] = Field(default_factory=list)
    tags: List[Tag] = Field(default_factory=list)
    collections: List[Collection] = Field(default_factory=list)
    vault_ids: List[int] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)

class DispatchItemsRequest(BaseModel):
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

class SampleItem(AudioItem):
    key: Optional[str] = None

class LoopSampleItemCreate(SampleItemCreate):
    type: str = "loop"
    bpm: Optional[int] = None

class LoopSampleItem(SampleItem):
    bpm: Optional[int] = None

class OneShotSampleItemCreate(SampleItemCreate):
    type: str = "one_shot"

class OneShotSampleItem(SampleItem):
    pass

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

class SamplePackItemCreate(CollectionItemCreate):
    type: str = "sample_pack"

class SamplePackItem(CollectionItem):
    pass

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


class LiveRecordingProjectItemCreate(ProjectItemCreate):
    type: str = "live_recording_project"


class ProjectItem(CollectionItem):
    pass

# Requests
class DirectoryScanRequest(BaseModel):
    directory_path: str
    look_for_multitracks: bool = False
    vault_id: Optional[int] = None
    expected_type: str = "files"
    analysis_types: Optional[List[str]] = None

class CollectionImportRequest(BaseModel):
    source_path: str
    vault_id: Optional[int] = None
    expected_type: str = "auto"
    analysis_types: Optional[List[str]] = None
    fallback_to_files: bool = False


class BatchImportResult(BaseModel):
    type: str = "batch"
    title: str
    absolute_path: str
    imported: int
    skipped: int = 0
    size_bytes: int = 0
    items: List[Item] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

class MultitrackRegisterRequest(BaseModel):
    folder_path: str
    vault_id: Optional[int] = None


class ProjectCreateRequest(BaseModel):
    name: str
    project_type: str = "live_recording_project"
    vault_id: Optional[int] = None


class ProjectAddItemsRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)


class ProjectAddPathsRequest(BaseModel):
    source_paths: List[str] = Field(default_factory=list)


class ProjectFromItemsRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)
    mode: Literal["single", "one_per_item"] = "single"
    name: Optional[str] = None
    project_type: str = "live_recording_project"
    vault_id: Optional[int] = None

class ItemTagRequest(BaseModel):
    tag_id: int


class VaultBase(BaseModel):
    name: str
    description: Optional[str] = None

class VaultCreate(VaultBase):
    pass

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
