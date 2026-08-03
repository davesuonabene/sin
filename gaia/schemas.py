from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

# Tags
class TagBase(BaseModel):
    name: str

class TagCreate(TagBase):
    pass

class Tag(TagBase):
    id: int

    class Config:
        orm_mode = True

# Collections
class CollectionBase(BaseModel):
    name: str
    description: Optional[str] = None

class CollectionCreate(CollectionBase):
    pass

class Collection(CollectionBase):
    id: int

    class Config:
        orm_mode = True

# Items
class ItemBase(BaseModel):
    absolute_path: str
    file_hash: Optional[str] = None
    size_bytes: Optional[int] = None
    mime_type: Optional[str] = None
    vault_id: Optional[int] = None

class ItemCreate(ItemBase):
    type: str = "item"

class ItemUpdate(BaseModel):
    type: str

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
    relative_path: str
    type: str = "file"
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = None
    duration_seconds: Optional[float] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    streamable: bool = False

class Item(ItemBase):
    id: int
    created_at: datetime
    updated_at: datetime
    type: str
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
    tags: List[Tag] = []
    collections: List[Collection] = []

    class Config:
        orm_mode = True

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
    source_kind: str
    source_path: Optional[str] = None
    contents: List[CollectionContent] = []

class CollectionItem(Item):
    title: Optional[str] = None
    source_kind: Optional[str] = None
    source_path: Optional[str] = None
    content_count: int = 0
    contents: List[CollectionContent] = []

class SamplePackItemCreate(CollectionItemCreate):
    type: str = "sample_pack"

class SamplePackItem(CollectionItem):
    pass

class MultitrackItemCreate(CollectionItemCreate):
    type: str = "multitrack"
    stems: List[StemInfo] = []
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_valid_length: bool = True
    length_variance: float = 0.0

class MultitrackItem(Item):
    stems: List[StemInfo] = []
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_valid_length: bool = True
    length_variance: float = 0.0

# Requests
class DirectoryScanRequest(BaseModel):
    directory_path: str
    look_for_multitracks: bool = False
    vault_id: Optional[int] = None

class CollectionImportRequest(BaseModel):
    source_path: str
    vault_id: Optional[int] = None

class MultitrackRegisterRequest(BaseModel):
    folder_path: str
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

    class Config:
        orm_mode = True
        from_attributes = True


class VaultImportLog(BaseModel):
    id: int
    vault_id: int
    source_path: str
    item_id: Optional[int] = None
    status: str
    action: str
    detail: Optional[str] = None
    created_at: datetime

    class Config:
        orm_mode = True
        from_attributes = True
