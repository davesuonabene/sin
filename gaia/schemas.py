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

class ItemCreate(ItemBase):
    type: str = "item"

class ItemUpdate(BaseModel):
    type: str

class Item(ItemBase):
    id: int
    created_at: datetime
    updated_at: datetime
    type: str
    key: Optional[str] = None
    bpm: Optional[int] = None
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

# Requests
class DirectoryScanRequest(BaseModel):
    directory_path: str

class ItemTagRequest(BaseModel):
    tag_id: int
