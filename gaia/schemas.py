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
    storage_mode: Literal["managed", "external_reference"] = "managed"
    availability: Literal["pending", "transferring", "ready", "missing", "failed"] = "ready"
    attributes: dict[str, Any] = Field(default_factory=dict)

class ItemCreate(ItemBase):
    type: str = "item"

class ItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    favourite: Optional[bool] = None
    attributes: Optional[dict[str, Any]] = None
    tags: Optional[List[str]] = None


class SequenceSaveRequest(BaseModel):
    name: str
    format: str = "sin-sequence"
    version: int = 1
    channels: List[dict]


class CollectionContentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None
    type: Optional[str] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    favourite: Optional[bool] = None
    tags: Optional[List[str]] = None


ProposalField = Literal["key", "bpm", "favourite"]


class SinMetadataProposalCreate(BaseModel):
    """A library metadata change requested by SIN, pending GAIA review."""

    asset_ref: Optional[str] = None
    absolute_path: str
    field: ProposalField
    proposed_value: Any
    previous_value: Any = None
    source_node_id: Optional[int] = None


class SinMetadataProposal(BaseModel):
    id: int
    asset_ref: str
    absolute_path: str
    field: ProposalField
    proposed_value: Any
    previous_value: Any = None
    source_node_id: Optional[int] = None
    status: Literal["pending", "accepted", "rejected"]
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime] = None

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
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None
    audio_metadata: dict[str, Any] = Field(default_factory=dict)
    relative_path: str
    source_path: Optional[str] = None
    type: str = "file"
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = None
    duration_seconds: Optional[float] = None
    bpm: Optional[int] = None
    key: Optional[str] = None
    is_loop: Optional[bool] = None
    favourite: bool = False
    tags: List[str] = Field(default_factory=list)
    streamable: bool = False
    child_id: Optional[int] = None
    storage_mode: Literal["managed", "external_reference"] = "managed"
    availability: Literal["pending", "transferring", "ready", "missing", "failed"] = "ready"


class CollectionContentPage(BaseModel):
    contents: List[CollectionContent] = Field(default_factory=list)
    offset: int = 0
    limit: int = 0
    total: int = 0
    has_more: bool = False


class ItemSummary(BaseModel):
    absolute_path: str
    size_bytes: Optional[int] = None
    mime_type: Optional[str] = None
    vault_id: int
    parent_id: Optional[int] = None
    storage_mode: Literal["managed", "external_reference"] = "managed"
    availability: Literal["pending", "transferring", "ready", "missing", "failed"] = "ready"
    attributes: dict[str, Any] = Field(default_factory=dict)
    id: int
    created_at: datetime
    updated_at: datetime
    type: str
    title: Optional[str] = None
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None
    duration_seconds: Optional[float] = None
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_loop: Optional[bool] = None
    favourite: bool = False
    source_kind: Optional[str] = None
    source_path: Optional[str] = None
    content_count: Optional[int] = None
    content_types: List[str] = Field(default_factory=list)
    content_tags: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    matches_query: bool = False


class Item(ItemBase):
    id: int
    created_at: datetime
    updated_at: datetime
    type: str
    parent_id: Optional[int] = None
    title: Optional[str] = None
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None
    audio_metadata: dict[str, Any] = Field(default_factory=dict)
    key: Optional[str] = None
    bpm: Optional[int] = None
    is_loop: Optional[bool] = None
    favourite: bool = False
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

class ItemLocation(BaseModel):
    item_id: int
    vault_id: int
    vault_name: str
    ancestor_ids: List[int] = Field(default_factory=list)
    folder_path: Optional[str] = None
    title: Optional[str] = None
    filename: Optional[str] = None
    type: str

class MoveItemsRequest(BaseModel):
    item_ids: List[int]
    vault_id: int
    mode: Literal["move", "copy"] = "move"
    move_confirmed: bool = False

class AudioItemCreate(ItemCreate):
    type: str = "audio"

class AudioItem(Item):
    pass

class TrackItemCreate(AudioItemCreate):
    type: str = "track"
    title: Optional[str] = None
    author: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    release_year: Optional[int] = None
    genre: Optional[str] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    comment: Optional[str] = None

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
    transfer_mode: Literal["move", "copy", "keep"] = "copy"
    move_confirmed: bool = False
    skip_track_analysis: bool = False
    folder_assignments: dict[str, str] = Field(default_factory=dict)
    item_types: dict[int, str] = Field(default_factory=dict)
    excluded_indexes: List[int] = Field(default_factory=list)
    excluded_types: List[str] = Field(default_factory=list)
    excluded_extensions: List[str] = Field(default_factory=list)
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
    mode: Literal["move", "reference", "copy"] = "reference"
    folder: Optional[str] = None



class FolderCreateRequest(BaseModel):
    name: str
    vault_id: Optional[int] = None
    parent_id: Optional[int] = None
    item_ids: Optional[List[int]] = None
    reference_ids: Optional[List[int]] = None


class OpenLocationRequest(BaseModel):
    item_id: Optional[int] = None
    path: Optional[str] = None


class ItemDeleteLocator(BaseModel):
    kind: Literal["item"] = "item"
    item_id: int


class CollectionContentDeleteLocator(BaseModel):
    kind: Literal["content"] = "content"
    collection_id: int
    content_index: int


class ProjectReferenceDeleteLocator(BaseModel):
    kind: Literal["reference"] = "reference"
    project_id: int
    reference_id: int


class LibraryEntriesDeleteRequest(BaseModel):
    entries: List[
        ItemDeleteLocator
        | CollectionContentDeleteLocator
        | ProjectReferenceDeleteLocator
    ] = Field(default_factory=list)


class ProjectFromItemsRequest(BaseModel):
    item_ids: List[int] = Field(default_factory=list)
    mode: Literal["single", "one_per_item"] = "single"
    name: Optional[str] = None
    project_type: str = "project"
    vault_id: Optional[int] = None
    move_files: bool = False
    move_item_ids: List[int] = Field(default_factory=list)


ReferenceKind = Literal["component", "use", "derived", "supersedes"]


class ItemReferenceCreate(BaseModel):
    context_id: int
    from_item_id: int
    to_item_id: int
    relation_kind: ReferenceKind = "use"
    stage_name: Optional[str] = None
    revision_label: Optional[str] = None
    is_master: bool = False
    tags: List[str] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)


class ProjectReferenceCreate(BaseModel):
    from_item_id: int
    to_item_id: int
    relation_kind: ReferenceKind = "use"
    stage_name: Optional[str] = None
    revision_label: Optional[str] = None
    is_master: bool = False
    tags: List[str] = Field(default_factory=list)
    attributes: Optional[dict[str, Any]] = Field(default_factory=dict)


class ProjectReferenceUpdate(BaseModel):
    revision_label: Optional[str] = None
    tags: Optional[List[str]] = None


class ItemReference(ItemReferenceCreate):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProjectVersion(BaseModel):
    item: Item
    reference: ItemReference
    label: str
    is_external: bool = False


class ProjectTableRow(BaseModel):
    item: Item
    reference: ItemReference
    version_group: str
    is_external: bool = False
    versions: List[ProjectVersion] = Field(default_factory=list)


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


class MediaEditSegment(BaseModel):
    id: str
    start_frame: int
    end_frame: int
    label: Optional[str] = None


class MediaEditLayer(BaseModel):
    item_id: int
    pre_gain_db: float = 0.0
    # Post-fader linear multiplier.  Keep ``gain_db`` as a legacy input so
    # saved editor documents from before the linear fader migration continue
    # to load and can be converted by the media editor service.
    volume: Optional[float] = None
    gain_db: Optional[float] = 0.0
    muted: bool = False


class MediaEditDestination(BaseModel):
    mode: Literal["project", "override"] = "project"
    project_id: Optional[int] = None
    override_item_id: Optional[int] = None
    revision_label: Optional[str] = None
    existing_output: Literal["cancel", "override", "new_version"] = "cancel"
    set_master: bool = True
    bitrate_kbps: int = 192


class MediaEditRequest(BaseModel):
    source_item_id: int
    target_id: Optional[str] = None
    active_layer_ids: List[int] = Field(default_factory=list)
    main_start_frame: Optional[int] = None
    main_end_frame: Optional[int] = None
    segments: List[MediaEditSegment] = Field(default_factory=list)
    layers: List[MediaEditLayer] = Field(default_factory=list)
    gain_db: float = 0.0
    normalize: bool = False
    target_peak_db: float = -1.0
    output_format: Literal["wav", "mp3"] = "wav"
    destination: MediaEditDestination = Field(default_factory=MediaEditDestination)


class MediaEditorViewState(BaseModel):
    selected_layer_id: Optional[int] = None
    selected_segment_id: Optional[str] = None
    waveform_zoom: float = 1.0
    view_start_frame: int = 0


class MediaEditorState(BaseModel):
    """The mutable, project-scoped working document for the media editor."""

    schema_version: Literal[1] = 1
    source_item_id: int
    target_id: str
    active_layer_ids: List[int] = Field(default_factory=list)
    main_start_frame: Optional[int] = None
    main_end_frame: Optional[int] = None
    segments: List[MediaEditSegment] = Field(default_factory=list)
    layers: List[MediaEditLayer] = Field(default_factory=list)
    gain_db: float = 0.0
    normalize: bool = False
    target_peak_db: float = -1.0
    output_format: Literal["wav", "mp3"] = "wav"
    view: MediaEditorViewState = Field(default_factory=MediaEditorViewState)

class ItemTagRequest(BaseModel):
    tag_id: int


class VaultBase(BaseModel):
    name: str
    description: Optional[str] = None
    preview: Literal["quick", "lazy", "hidden"] = "quick"

class VaultCreate(VaultBase):
    path: Optional[str] = None

class VaultUpdate(BaseModel):
    name: str
    description: Optional[str] = None
    preview: Literal["quick", "lazy", "hidden"] = "quick"


class VaultMigrate(BaseModel):
    path: str

class Vault(VaultBase):
    id: int
    storage_key: str
    path: str
    root_path: str
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


class DiscoveredFile(BaseModel):
    path: str
    filename: str
    relative_path: str
    size_bytes: int
    type: str
    extension: str


class MissingFile(BaseModel):
    id: int
    path: str
    filename: str
    relative_path: Optional[str] = None
    type: str
    size_bytes: Optional[int] = None
    title: Optional[str] = None


class MovedFileCandidate(BaseModel):
    item_id: int
    old_path: str
    new_path: str
    filename: str
    size_bytes: int


class VaultSyncStatus(BaseModel):
    vault_id: int
    vault_name: str
    in_sync: bool
    untracked: List[DiscoveredFile] = Field(default_factory=list)
    missing: List[MissingFile] = Field(default_factory=list)
    moved: List[MovedFileCandidate] = Field(default_factory=list)
    total_discrepancies: int = 0


class RelinkMovedPair(BaseModel):
    item_id: int
    new_path: str


class VaultReconcileRequest(BaseModel):
    add_untracked: Optional[List[str]] = None
    add_all_untracked: bool = False
    mark_missing: Optional[List[int]] = None
    mark_all_missing: bool = False
    purge_missing: Optional[List[int]] = None
    relink_moved: Optional[List[RelinkMovedPair]] = None


class VaultReconcileResponse(BaseModel):
    vault_id: int
    added_count: int = 0
    marked_missing_count: int = 0
    purged_count: int = 0
    relinked_count: int = 0
    in_sync: bool = True

