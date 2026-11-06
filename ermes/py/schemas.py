"""
ERMES Canonical Pydantic Models & Schemas
Serves as the single source of truth for graph serialization payloads across SIN.
"""

from typing import List, Optional, Literal, Dict, Any, Union
from pydantic import BaseModel, field_validator


class FxModuleModel(BaseModel):
    id: str
    type: str
    name: Optional[str] = None
    enabled: bool = True
    fixed: bool = False
    params: Dict[str, Any] = {}

    @field_validator('name', mode='before')
    @classmethod
    def sanitize_name(cls, v, info):
        if v:
            return str(v)
        data = info.data if hasattr(info, 'data') else {}
        return data.get('id') or data.get('type') or 'Module'


class NodeSlotModel(BaseModel):
    slot: int = 0
    label: Optional[str] = None
    pool_query: Optional[str] = None
    filepath: Optional[str] = None
    library_item_id: Optional[Union[int, str]] = None
    sequence_name: Optional[str] = None
    original_bpm: Optional[float] = None
    key: Optional[str] = None
    duration_seconds: Optional[float] = None
    crop_start: Optional[float] = None
    crop_end: Optional[float] = None
    pitch_shift: Optional[float] = None
    time_stretch: Optional[float] = None
    sequence: Optional[List[int]] = None
    step_parameters: Optional[List[Dict[str, Any]]] = None
    sample_slot: Optional[str] = None
    step_slots: Optional[List[int]] = None
    seed: Optional[Union[str, float, int]] = None
    cycle_seeds: Optional[List[int]] = None
    field_operators: Optional[Dict[str, str]] = None

    def get(self, key: str, default: Any = None) -> Any:
        val = getattr(self, key, default)
        return default if val is None else val

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


class AudioNodeModel(BaseModel):
    node_id: Optional[int] = None
    node_name: str
    node_type: str = "track"
    sample_type: Optional[str] = "loop"
    filepath: Optional[str] = None
    original_bpm: Optional[float] = None
    target_bpm: Optional[float] = None
    key: Optional[str] = None
    start_beat: float = 0.0
    mix_mode: Optional[str] = "sum"
    gain: Optional[float] = None
    bpm: float = 120.0
    filename: Optional[str] = None
    project_name: Optional[str] = None
    project: Optional[str] = None
    export_directory: Optional[str] = None
    export_pattern: Optional[str] = None
    export_overwrite_mode: Optional[Literal["incremental", "overwrite"]] = "incremental"
    sequence: Optional[List[int]] = None
    step_parameters: Optional[List[Dict[str, Any]]] = None
    step_length: Optional[float] = None
    play_mode: Optional[str] = "gate"
    release: float = 0.0
    fade_ms: float = 0.0
    selected_items: Optional[List[Dict[str, Any]]] = None
    playbackMode: Optional[str] = None
    seed: Optional[Union[str, float, int]] = None
    seed_mode: Optional[str] = "moving"
    refresh_mode: Literal[
        "local", "parent", "ancestor", "global", "off",
        "local_refresh", "parent_refresh", "global_refresh",
        "parent_render", "self_render", "manual", "fixed"
    ] = "off"
    slots: List[NodeSlotModel] = []
    active_slot: int = 0
    pool_query: Optional[str] = None
    field_operators: Optional[Dict[str, str]] = None
    sample_slot: Optional[str] = "*"
    step_slots: List[int] = []
    cycle_seeds: List[int] = []
    section_slots: List[int] = []
    total_bars: Optional[float] = None
    global_bars: Optional[float] = None
    global_seed: Optional[Union[str, float, int]] = None
    field_seed: Optional[Union[str, float, int]] = None
    probability: Optional[float] = None
    section_points: List[float] = []
    section_enabled: List[bool] = []
    section_probability: List[float] = []
    section_quant: List[str] = []
    section_quant_anchor: List[str] = []
    quant: Optional[str] = "none"
    quant_anchor: Literal["start", "end"] = "start"
    crop_start: float = 0.0
    crop_end: float = 1.0
    transpose: float = 0.0
    cents: float = 0.0
    stretch_mode: Optional[str] = "time_stretch"
    stretch_factor: float = 1.0
    stretch_algorithm: Optional[str] = "rubberband"
    key_match_mode: Optional[str] = "off"
    key_match_algorithm: Optional[str] = "nearest"
    chain: List[FxModuleModel] = []
    modulators: Optional[List[Dict[str, Any]]] = None
    children: List['AudioNodeModel'] = []

    @field_validator('seed_mode', mode='before')
    @classmethod
    def sanitize_seed_mode(cls, v):
        if not v or not isinstance(v, str):
            return "moving"
        v_str = str(v).strip().lower()
        return v_str if v_str in ("fixed", "moving") else "moving"

    @field_validator('refresh_mode', mode='before')
    @classmethod
    def sanitize_refresh_mode(cls, v):
        valid = {
            "local", "parent", "ancestor", "global", "off",
            "local_refresh", "parent_refresh", "global_refresh",
            "parent_render", "self_render", "manual", "fixed"
        }
        if not v or str(v).lower() not in valid:
            return "off"
        return str(v).lower()

    @field_validator('section_points', 'section_enabled', 'section_probability',
                     'section_quant', 'section_quant_anchor',
                     'slots', 'step_slots', 'cycle_seeds', 'section_slots',
                     'chain', 'children', mode='before')
    @classmethod
    def sanitize_lists(cls, v):
        return [] if v is None else v


class PoolResolveRequest(BaseModel):
    selected_items: List[Dict[str, Any]] = []
    seed: Union[str, float, int] = 0.0
    playbackMode: str = "Random"
    items_resolved: bool = False
    previous_sample: Optional[str] = None
    prefer_different: bool = False
