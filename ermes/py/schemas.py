"""
ERMES Canonical Pydantic Models & Schemas
Serves as the single source of truth for graph serialization payloads across SIN.
"""

from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, field_validator


class FxModuleModel(BaseModel):
    id: str
    type: str
    name: str
    enabled: bool = True
    fixed: bool = False
    params: Dict[str, Any] = {}


class AudioNodeModel(BaseModel):
    node_name: str
    node_type: str = "track"
    sample_type: Optional[str] = "loop"
    filepath: Optional[str] = None
    original_bpm: Optional[float] = None
    target_bpm: Optional[float] = None
    key: Optional[str] = None
    start_beat: float = 0.0
    bpm: float = 120.0
    filename: Optional[str] = None
    sequence: Optional[List[int]] = None
    step_parameters: Optional[List[Dict[str, Any]]] = None
    step_length: Optional[float] = None
    play_mode: Optional[str] = "gate"
    fade_ms: float = 0.0
    selected_items: Optional[List[Dict[str, Any]]] = None
    playbackMode: Optional[str] = None
    seed: Optional[float] = None
    seed_mode: Optional[str] = "moving"
    refresh_mode: Literal[
        "local", "parent", "ancestor", "global", "off",
        "local_refresh", "parent_refresh", "global_refresh",
        "parent_render", "self_render", "manual", "fixed"
    ] = "off"
    total_bars: Optional[float] = None
    probability: Optional[float] = None
    section_points: List[float] = []
    section_enabled: List[bool] = []
    section_probability: List[float] = []
    section_sample_start: List[float] = []
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
                     'section_sample_start', 'section_quant', 'section_quant_anchor',
                     'chain', 'children', mode='before')
    @classmethod
    def sanitize_lists(cls, v):
        return [] if v is None else v


class PoolResolveRequest(BaseModel):
    selected_items: List[Dict[str, Any]] = []
    seed: float = 0.0
    playbackMode: str = "Random"
    items_resolved: bool = False
    previous_sample: Optional[str] = None
    prefer_different: bool = False
