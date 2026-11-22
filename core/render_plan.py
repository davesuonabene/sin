"""Flat declarative render-plan data contract between Python (Orchestrator/Packer)
and the native C++20 libsin_dsp audio engine.

Python's role is strictly packing data (sources, buses, clips, and UI telemetry
manifest) plus Tier-2 offline cooking (Rubber Band R3, future stem separation).
All real-time and offline audio decoding, disk streaming, resampling, cropping,
fading, mixing, and device output live inside libsin_dsp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import numpy as np

SIN_DEFAULT_SAMPLE_RATE = 48000

# Matches SinParamId in engine/include/sin_dsp.h
SIN_PARAM_PRE_GAIN_DB   = 1
SIN_PARAM_VOLUME        = 2
SIN_PARAM_POST_GAIN_DB  = 3
SIN_PARAM_PAN           = 4
SIN_PARAM_MUTE          = 5
SIN_PARAM_SOLO          = 6
SIN_PARAM_CROP_START    = 7
SIN_PARAM_CROP_END      = 8
SIN_PARAM_PLAYBACK_RATE = 9

# Matches SinClipFlags in engine/include/sin_dsp.h
SIN_CLIP_LOOP_SOURCE     = 1 << 0
SIN_CLIP_LIVE_CROP_BOUND = 1 << 1
SIN_CLIP_LIVE_RATE_BOUND = 1 << 2
SIN_CLIP_CROP_IN_PLACE   = 1 << 3

# Matches SinProcessorType & SIN_MAX_PROC_PARAMS in engine/include/sin_dsp.h
SIN_MAX_PROC_PARAMS = 8
SIN_PROC_NONE       = 0
SIN_PROC_GAIN       = 1

PROCESSOR_TYPE_TO_ID: Dict[str, int] = {
    "gain": SIN_PROC_GAIN,
}

PARAM_NAME_TO_ID: Dict[str, int] = {
    "pre_gain_db": SIN_PARAM_PRE_GAIN_DB,
    "volume": SIN_PARAM_VOLUME,
    "post_gain_db": SIN_PARAM_POST_GAIN_DB,
    "gain_db": SIN_PARAM_POST_GAIN_DB,
    "pan": SIN_PARAM_PAN,
    "mute": SIN_PARAM_MUTE,
    "muted": SIN_PARAM_MUTE,
    "solo": SIN_PARAM_SOLO,
    "crop_start": SIN_PARAM_CROP_START,
    "crop_end": SIN_PARAM_CROP_END,
    "playback_rate": SIN_PARAM_PLAYBACK_RATE,
}


@dataclass
class SourceSpec:
    """An audio source registered into libsin_dsp: either a disk file (auto RAM <30s / stream >=30s)
    or an in-memory cooked planar float32 NumPy buffer."""

    source_id: int
    filepath: Optional[str] = None
    force_ram: bool = False
    pcm: Optional[np.ndarray] = None  # shape (frames,) or (2, frames) float32
    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE
    content_hash: int = 0
    num_frames: int = 0  # optional cached frame count at source sample_rate


@dataclass
class BusSpec:
    """One stereo mixer bus in the flat BusMixerDAG."""

    bus_id: int
    parent_bus_id: int = 0  # 0 or == bus_id means root master bus
    node_key: str = ""      # original graph/node string id (e.g. "ch-4259", "master", "12")
    node_type: str = "track"
    node_name: str = ""
    pre_gain_db: float = 0.0
    volume: float = 1.0
    post_gain_db: float = 0.0
    pan: float = 0.0
    crop_start: float = 0.0
    crop_end: float = 1.0
    playback_rate: float = 1.0
    muted: bool = False
    solo: bool = False


@dataclass
class ClipSpec:
    """One scheduled audio clip/voice routed to a BusSpec."""

    clip_id: int
    source_id: int
    target_bus_id: int
    timeline_start_frame: int = 0
    timeline_length_frames: int = 0  # <= 0 => natural cropped source length
    source_start_ratio: float = 0.0
    source_end_ratio: float = 1.0
    gain: float = 1.0
    playback_rate: float = 1.0
    fade_in_frames: int = 0
    fade_out_frames: int = 0
    release_frames: int = 0
    flags: int = 0


@dataclass
class ChainStageSpec:
    """One ordered In -> Out DspProcessor stage bound to a BusSpec."""

    bus_id: int
    stage_index: int = 0
    processor_type: int = SIN_PROC_NONE
    enabled: bool = True
    params: List[float] = field(default_factory=list)


@dataclass
class SinRenderPlan:
    """Complete self-contained flat data plan consumable by libsin_dsp (live or offline)."""

    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE
    bpm: float = 120.0
    explicit_duration_sec: float = 0.0  # <= 0 => "auto" unconstrained natural length
    sources: List[SourceSpec] = field(default_factory=list)
    buses: List[BusSpec] = field(default_factory=list)
    clips: List[ClipSpec] = field(default_factory=list)
    stages: List[ChainStageSpec] = field(default_factory=list)
    # Maps canonical/editor string node IDs (e.g. "ch-4259", "src-4259", "14") -> SinBusId
    bus_id_map: Dict[str, int] = field(default_factory=dict)
    # Reverse map: SinBusId -> primary node_key (for 60Hz telemetry serialization)
    bus_key_map: Dict[int, str] = field(default_factory=dict)
    # Symbolic manifest events for SIN IRIDE / GAIA UI telemetry
    manifest_nodes: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # Optional output post-processing metadata (offline export)
    normalize: bool = False
    target_peak_db: float = -1.0
