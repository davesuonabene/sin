"""Flat declarative render-plan data contract between Python (Orchestrator/Packer)
and the native C++20 libsin_dsp audio engine.

Python's role is strictly packing data (sources, buses, clips, and UI telemetry
manifest) plus Tier-2 offline cooking (Rubber Band R3, future stem separation).
All real-time and offline audio decoding, disk streaming, resampling, cropping,
fading, mixing, and device output live inside libsin_dsp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
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
SIN_CLIP_LOOP_SOURCE         = 1 << 0
SIN_CLIP_LIVE_CROP_BOUND     = 1 << 1
SIN_CLIP_LIVE_RATE_BOUND     = 1 << 2
SIN_CLIP_CROP_IN_PLACE       = 1 << 3
SIN_CLIP_TILE_TIME_STRETCHED = 1 << 4

# Matches SinProcessorType & ABI limits in engine/include/sin_dsp.h
SIN_MAX_PROC_PARAMS  = 32
SIN_MAX_STAGE_METERS = 512
SIN_PROC_NONE        = 0
SIN_PROC_GAIN        = 1
SIN_PROC_PARAM_EQ    = 2
SIN_PROC_COMP        = 3
SIN_PROC_CLIPPER     = 4
SIN_PROC_LIMITER     = 5

_MANIFEST_PATH = Path(__file__).resolve().parent.parent / "dsp_modules" / "manifest.json"


def _load_processor_manifest() -> Dict[str, Dict[str, Any]]:
    if not _MANIFEST_PATH.is_file():
        return {}
    raw = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
    out: Dict[str, Dict[str, Any]] = {}
    for proc in raw.get("processors", []):
        ptype = str(proc.get("type") or "").strip().lower()
        if ptype:
            out[ptype] = proc
    return out


PROCESSOR_MANIFEST: Dict[str, Dict[str, Any]] = _load_processor_manifest()

PROCESSOR_TYPE_TO_ID: Dict[str, int] = {
    ptype: int(spec.get("engineId", SIN_PROC_NONE))
    for ptype, spec in PROCESSOR_MANIFEST.items()
} or {
    "gain": SIN_PROC_GAIN,
    "param_eq": SIN_PROC_PARAM_EQ,
    "comp": SIN_PROC_COMP,
    "clipper": SIN_PROC_CLIPPER,
    "limiter": SIN_PROC_LIMITER,
}


def pack_processor_params(proc_type: str, params_dict: Optional[Dict[str, Any]]) -> List[float]:
    """Pack a dict of module parameters into an ordered float list matching `manifest.json`."""
    ptype = str(proc_type or "").strip().lower()
    pdict = params_dict or {}
    if ptype == "gain":
        if pdict.get("gain") is not None:
            return [max(0.0, float(pdict["gain"]))]
        if pdict.get("gain_db") is not None:
            db = float(pdict["gain_db"])
            return [0.0 if db <= -35.9 else float(10.0 ** (db / 20.0))]
        return [1.0]

    spec = PROCESSOR_MANIFEST.get(ptype)
    if not spec:
        return []
    param_defs = sorted(spec.get("params", []), key=lambda p: int(p.get("paramIndex", 0)))
    if not param_defs:
        return []
    max_idx = max(int(p.get("paramIndex", 0)) for p in param_defs)
    out = [0.0] * min(SIN_MAX_PROC_PARAMS, max_idx + 1)
    for pdef in param_defs:
        idx = int(pdef.get("paramIndex", 0))
        if idx < 0 or idx >= len(out):
            continue
        key = str(pdef.get("key") or "")
        default_val = float(pdef.get("defaultValue", 0.0))
        raw_val = pdict.get(key, default_val)
        if raw_val is None:
            val = default_val
        elif isinstance(raw_val, bool):
            val = 1.0 if raw_val else 0.0
        else:
            try:
                val = float(raw_val)
            except (TypeError, ValueError):
                val = default_val
        pmin = pdef.get("min")
        pmax = pdef.get("max")
        if pmin is not None:
            val = max(float(pmin), val)
        if pmax is not None:
            val = min(float(pmax), val)
        out[idx] = val
    return out


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
    """An audio source registered into libsin_dsp: either a disk file (auto RAM <30s / stream >=30s),
    an in-memory cooked planar float32 NumPy buffer, or a layered sparse-tile streaming source."""

    source_id: int
    filepath: Optional[str] = None
    force_ram: bool = False
    pcm: Optional[np.ndarray] = None  # shape (frames,) or (2, frames) float32
    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE
    content_hash: int = 0
    num_frames: int = 0  # optional cached frame count at source sample_rate
    layered_tile_frames: int = 0  # > 0 => register layered tile overlay over filepath
    layered_num_tiles: int = 0
    layered_total_frames: int = 0  # total frames at tile sample_rate
    layered_node_key: str = ""     # processor node id owning this layered source


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
