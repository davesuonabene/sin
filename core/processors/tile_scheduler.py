"""3-Tier chunked tile cook scheduler for seamless 1h+ long-track RX processing.

Design:
- Splits long tracks into overlapping fixed tiles (default 8.0s core + 0.75s OLA halo).
- Reads ONLY the active tile slice from disk via `soundfile.SoundFile.seek()` (never loads
  full 1h+ files into Python RAM).
- Strict DSP vs. ML tier split:
    * TIER_FAST_DSP (1): `preamp_denoise`, `voice_isolator[dsp_lite]` -> cooks playhead
      precook window first, then sweeps outward across the full track in background tiles.
    * TIER_COMPLEX_ML (2): neural/ONNX `voice_isolator` backends -> strictly cooks inside
      the sliding playhead precook window (`[playhead - 4s .. playhead + precook_sec]`)
      unless `cook_full_track` is explicitly requested.
- Live-drag local re-synth: cheap Level-2 mix/synth knobs re-synthesize ONLY the active
  playhead tile(s) immediately from cached RAM analysis/stems; off-screen tiles re-bake
  lazily on commit (`commit=True`).
- Structural edits: debounced stale-hold keeps previous cooked tiles playing in C++ (marked
  amber/stale in the UI) until newly cooked playhead tiles replace them atomically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import logging
import math
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
import numpy as np
from scipy import signal
import soundfile as sf

from core.env_config import get_env_config
from core.processors.chunked_inference import ensure_stereo_f32
from core.processors.model_manager import GLOBAL_MODEL_MANAGER
from core.processors.preamp_denoise import (
    PreampAnalysis,
    PreampGlobalBaseline,
    analyze_preamp,
    scan_preamp_global_baseline,
    synthesize_preamp,
)
from core.processors.tile_cache import (
    GLOBAL_PEAK_PYRAMID_CACHE,
    GLOBAL_TILE_CACHE,
    HybridTileCache,
    PeakPyramidCache,
    TIER_COMPLEX_ML,
    TIER_FAST_DSP,
    TIER_RAW,
    TIER_STALE,
    TiledWaveformOverlay,
    compute_interleaved_peaks,
)
from core.processors.voice_isolator import (
    VoiceDecomposition,
    check_voice_backend_ready,
    decompose_voice,
    recombine_voice,
)

logger = logging.getLogger("sin.processors.tile_scheduler")

PREAMP_STRUCTURAL_KEYS = frozenset({"profile_id", "stft_mode", "hp_hz", "noise_start", "noise_end"})
VOICE_STRUCTURAL_KEYS = frozenset({"backend", "reverb_sensitivity"})


def classify_stage_tier(node_type: str, params: Dict[str, Any]) -> int:
    """Strict DSP vs. ML tier split."""
    nt = str(node_type or "").strip().lower()
    if nt in ("preamp_denoise", "rubberband_stretch"):
        return TIER_FAST_DSP
    if nt == "voice_isolator":
        backend = str((params or {}).get("backend") or "fast_onnx").strip().lower()
        return TIER_FAST_DSP if backend == "dsp_lite" else TIER_COMPLEX_ML
    return TIER_FAST_DSP


def is_structural_processor_param(node_type: str, key: str) -> bool:
    nt = str(node_type or "").strip().lower()
    k = str(key or "").strip()
    if nt == "preamp_denoise":
        return k in PREAMP_STRUCTURAL_KEYS
    if nt == "voice_isolator":
        return k in VOICE_STRUCTURAL_KEYS
    return True


def _file_sig_str(filepath: str) -> str:
    try:
        st = os.stat(filepath)
        return f"{os.path.abspath(filepath)}|{st.st_mtime_ns}|{st.st_size}"
    except OSError:
        return str(filepath)


def _fp_hash(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:20]


@dataclass
class TiledStageSpec:
    node_id: str
    node_type: str
    node_name: str
    processor_params: Dict[str, Any] = field(default_factory=dict)

    @property
    def tier(self) -> int:
        return classify_stage_tier(self.node_type, self.processor_params)

    @property
    def bypassed(self) -> bool:
        return bool(self.processor_params.get("bypass", False))

    @property
    def cook_mode(self) -> str:
        return "manual" if str(self.processor_params.get("cook_mode") or "auto").strip().lower() == "manual" else "auto"

    @property
    def precook_window_sec(self) -> float:
        raw = self.processor_params.get("precook_window_sec")
        try:
            if raw is not None:
                return max(4.0, min(180.0, float(raw)))
        except (TypeError, ValueError):
            pass
        return float(get_env_config().default_precook_sec)

    def structural_dict(self) -> Dict[str, Any]:
        p = self.processor_params
        if self.node_type == "preamp_denoise":
            return {
                "profile_id": str(p.get("profile_id") or "generic_adc"),
                "stft_mode": str(p.get("stft_mode") or "hq_dual_res"),
                "hp_hz": round(float(p.get("hp_hz", 40.0)), 2),
                "noise_start": round(float(p.get("noise_start", 0.0)), 4),
                "noise_end": round(float(p.get("noise_end", 0.0)), 4),
            }
        if self.node_type == "voice_isolator":
            return {
                "backend": str(p.get("backend") or "fast_onnx").strip().lower(),
                "reverb_sensitivity": round(float(p.get("reverb_sensitivity", 0.5)), 3),
            }
        if self.node_type == "rubberband_stretch":
            return {
                "tempo_rate": round(float(p.get("tempo_rate", 1.0)), 6),
                "semitones": round(float(p.get("semitones", 0.0)), 4),
                "algorithm": str(p.get("algorithm") or "rubberband").strip().lower(),
                "fast_engine": bool(p.get("fast_engine", True)),
            }
        return {}


@dataclass
class TiledTrackSessionSpec:
    """Declarative session descriptor emitted by `plan_packer` for long tiled RX / Rubber Band chains."""

    source_id: int
    base_filepath: str
    sample_rate: int
    file_sample_rate: int
    total_frames: int  # total tile-space frames at `sample_rate` (stretched output frames when tile_time_stretched=True)
    duration_sec: float  # full RAW file duration in seconds
    tile_sec: float
    tile_frames: int
    num_tiles: int
    stages: List[TiledStageSpec]  # upstream -> downstream
    crop_start: float = 0.0  # normalized [0..1]
    crop_end: float = 1.0  # normalized [0..1]
    playback_rate: float = 1.0
    timeline_duration_sec: float = 0.0  # active timeline span (<= 0 => cropped file duration / playback_rate)
    bus_node_ids: List[str] = field(default_factory=list)
    tile_time_stretched: bool = False  # True when tiles store already time-stretched audio at unity rate
    stretch_tempo_rate: float = 1.0    # Rubber Band tempo rate R when tile_time_stretched=True

    @property
    def tile_time_scale(self) -> float:
        """Multiplier mapping RAW file seconds -> tile-space seconds."""
        if self.tile_time_stretched:
            return 1.0 / max(0.05, float(self.stretch_tempo_rate or 1.0))
        return 1.0

    @property
    def tile_total_duration_sec(self) -> float:
        return self.duration_sec * self.tile_time_scale

    @property
    def crop_start_sec(self) -> float:
        return max(0.0, min(self.duration_sec, float(self.crop_start) * self.duration_sec))

    @property
    def crop_end_sec(self) -> float:
        ce = max(float(self.crop_start), min(1.0, float(self.crop_end)))
        return max(self.crop_start_sec, ce * self.duration_sec)

    @property
    def active_timeline_sec(self) -> float:
        if self.timeline_duration_sec > 0.0:
            return float(self.timeline_duration_sec)
        span = max(0.0, self.crop_end_sec - self.crop_start_sec)
        return span / max(0.05, float(self.playback_rate or 1.0))


class TiledCookScheduler:
    """Background playhead-aware 3-tier tile cook worker with zero full-file RAM loads."""

    HALO_SEC = 0.75
    LOOKBEHIND_SEC = 4.0
    LEAD_LATENCY_SEC = 0.35
    TILE_PEAK_COLS = 64

    def __init__(
        self,
        *,
        tile_cache: Optional[HybridTileCache] = None,
        peak_cache: Optional[PeakPyramidCache] = None,
        on_tile_publish: Optional[Callable[[int, int, Optional[np.ndarray], int], None]] = None,
        on_tile_visual: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_status: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    ) -> None:
        self._tile_cache = tile_cache or GLOBAL_TILE_CACHE
        self._peak_cache = peak_cache or GLOBAL_PEAK_PYRAMID_CACHE
        self._on_tile_publish = on_tile_publish
        self._on_tile_visual = on_tile_visual
        self._on_status = on_status

        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._session: Optional[TiledTrackSessionSpec] = None
        self._overlay: Optional[TiledWaveformOverlay] = None
        self._file_sig: str = ""
        self._generation: int = 0
        self._playhead_sec: float = 0.0
        self._is_playing: bool = False
        self._full_track_ml_nodes: Set[str] = set()
        self._forced_manual_nodes: Set[str] = set()

        # Published state for current generation: tile_idx -> (tier, synth_fp, gen)
        self._published: Dict[int, Tuple[int, str, int]] = {}
        # Priority override queue (e.g. live-drag local re-synth)
        self._priority_tiles: List[int] = []
        self._live_drag_active: bool = False
        self._debounce_timer: Optional[threading.Timer] = None
        self._cancel_event = threading.Event()
        self._baselines: Dict[str, PreampGlobalBaseline] = {}
        self._statuses: Dict[str, Dict[str, Any]] = {}
        # Small RAM cache of raw disk slices per `(file_sig, tidx)` so live-drag fader tweaks skip MP3 disk seeks!
        self._raw_tile_ram: Dict[Tuple[str, int], Tuple[np.ndarray, int, int]] = {}

        self._stop = False
        self._worker = threading.Thread(target=self._worker_loop, name="sin-tile-cook", daemon=True)
        self._worker.start()

    def get_all_statuses(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {k: dict(v) for k, v in self._statuses.items()}

    @property
    def overlay(self) -> Optional[TiledWaveformOverlay]:
        with self._lock:
            return self._overlay

    @property
    def active_session(self) -> Optional[TiledTrackSessionSpec]:
        with self._lock:
            return self._session

    def has_node(self, node_id: str) -> bool:
        nid = str(node_id)
        with self._lock:
            if self._session is None:
                return False
            return any(st.node_id == nid for st in self._session.stages)

    def start_session(
        self,
        spec: TiledTrackSessionSpec,
        *,
        playhead_sec: float = 0.0,
        overlay: Optional[TiledWaveformOverlay] = None,
    ) -> TiledWaveformOverlay:
        """Install (or smoothly update) a tiled cooking session for a long track."""
        with self._lock:
            self._cancel_debounce_locked()
            self._cancel_event.set()
            self._cancel_event = threading.Event()
            self._generation += 1
            gen = self._generation

            same_track = (
                self._session is not None
                and self._session.source_id == spec.source_id
                and self._session.base_filepath == spec.base_filepath
                and self._session.num_tiles == spec.num_tiles
            )

            self._session = spec
            self._file_sig = _file_sig_str(spec.base_filepath)
            self._playhead_sec = max(0.0, float(playhead_sec))
            self._priority_tiles.clear()
            self._live_drag_active = False

            if overlay is not None:
                self._overlay = overlay
            elif same_track and self._overlay is not None:
                self._overlay.update_window(
                    crop_start_sec=spec.crop_start_sec,
                    playback_rate=spec.playback_rate,
                    timeline_duration_sec=spec.active_timeline_sec,
                    tile_time_scale=spec.tile_time_scale,
                )
                self._overlay.mark_all_stale()
            else:
                self._overlay = TiledWaveformOverlay(
                    base_pyramid=None,
                    duration_sec=spec.active_timeline_sec,
                    tile_sec=spec.tile_sec,
                    num_tiles=spec.num_tiles,
                    crop_start_sec=spec.crop_start_sec,
                    playback_rate=spec.playback_rate,
                    file_duration_sec=spec.duration_sec,
                    tile_time_scale=spec.tile_time_scale,
                )

            if not same_track:
                self._published.clear()
                self._full_track_ml_nodes.clear()
                self._forced_manual_nodes.clear()
                self._raw_tile_ram.clear()
            else:
                # Keep stale tiles audible in C++ while invalidating published fp map so worker refreshes
                self._published.clear()
            self._statuses.clear()

            # Immediately re-hydrate any already-cached playhead tiles in <2ms if disk/RAM hit exists
            self._cond.notify_all()
            out_overlay = self._overlay

        # Emit initial per-stage status
        for st in spec.stages:
            if st.bypassed:
                self._emit_status(st, "bypassed", 1.0, "bypassed")
            elif st.cook_mode == "manual" and st.node_id not in self._forced_manual_nodes:
                self._emit_status(st, "stale_bypassed", 0.0, "manual cook required")
            else:
                chk = self._check_stage_ready(st)
                if not chk.get("ready", True):
                    self._emit_status(
                        st,
                        "model_missing",
                        0.0,
                        "model download required",
                        extra={"model_id": chk.get("model_id"), "model_status": chk.get("model_status")},
                    )
                else:
                    phase = "precooking window" if st.tier == TIER_COMPLEX_ML else "propagating fast DSP"
                    self._emit_status(st, "cooking_bypassed", 0.0, phase)
        return out_overlay

    def attach_base_pyramid(self, pyramid: Any) -> None:
        with self._lock:
            if self._overlay is not None:
                self._overlay.base_pyramid = pyramid

    def clear_session(self) -> None:
        with self._lock:
            self._cancel_debounce_locked()
            self._cancel_event.set()
            self._cancel_event = threading.Event()
            self._generation += 1
            self._session = None
            self._overlay = None
            self._published.clear()
            self._priority_tiles.clear()
            self._full_track_ml_nodes.clear()
            self._forced_manual_nodes.clear()
            self._cond.notify_all()

    def shutdown(self) -> None:
        with self._lock:
            self._stop = True
            self._cancel_debounce_locked()
            self._cancel_event.set()
            self._cond.notify_all()
        if self._worker.is_alive():
            self._worker.join(timeout=1.5)

    def update_playhead(self, playhead_sec: float, *, is_playing: Optional[bool] = None) -> None:
        with self._lock:
            prev_tile = self._time_to_tile_locked(self._playhead_sec)
            self._playhead_sec = max(0.0, float(playhead_sec))
            if is_playing is not None:
                self._is_playing = bool(is_playing)
            new_tile = self._time_to_tile_locked(self._playhead_sec)
            if self._session is not None and new_tile != prev_tile:
                self._cond.notify_all()

    def update_crop_window(
        self,
        *,
        crop_start: Optional[float] = None,
        crop_end: Optional[float] = None,
        playback_rate: Optional[float] = None,
        timeline_duration_sec: Optional[float] = None,
    ) -> bool:
        """Keep tile scheduling & waveform overlay aligned when live crop/rate params change."""
        with self._lock:
            if self._session is None:
                return False
            if crop_start is not None:
                self._session.crop_start = max(0.0, min(self._session.crop_end, float(crop_start)))
            if crop_end is not None:
                self._session.crop_end = max(self._session.crop_start, min(1.0, float(crop_end)))
            if playback_rate is not None:
                self._session.playback_rate = max(0.05, float(playback_rate))
            if timeline_duration_sec is not None and timeline_duration_sec > 0.0:
                self._session.timeline_duration_sec = float(timeline_duration_sec)
            if self._overlay is not None:
                self._overlay.update_window(
                    crop_start_sec=self._session.crop_start_sec,
                    playback_rate=self._session.playback_rate,
                    timeline_duration_sec=self._session.active_timeline_sec,
                )
            self._cond.notify_all()
            return True

    def request_cook_full_track(self, node_id: str, enable: bool = True) -> bool:
        nid = str(node_id)
        with self._lock:
            if self._session is None or not any(s.node_id == nid for s in self._session.stages):
                return False
            if enable:
                self._full_track_ml_nodes.add(nid)
                self._forced_manual_nodes.add(nid)
            else:
                self._full_track_ml_nodes.discard(nid)
            self._cond.notify_all()
            return True

    def request_manual_cook(self, node_id: str) -> bool:
        nid = str(node_id)
        with self._lock:
            if self._session is None or not any(s.node_id == nid for s in self._session.stages):
                return False
            self._forced_manual_nodes.add(nid)
            self._cond.notify_all()
            return True

    def cancel_node(self, node_id: str) -> bool:
        nid = str(node_id)
        with self._lock:
            if self._session is None or not any(s.node_id == nid for s in self._session.stages):
                return False
            self._full_track_ml_nodes.discard(nid)
            self._cancel_event.set()
            self._cancel_event = threading.Event()
            self._generation += 1
            self._cond.notify_all()
            return True

    def update_param(
        self,
        node_id: str,
        key: str,
        value: Any,
        *,
        commit: bool = True,
    ) -> Optional[Dict[str, Any]]:
        """Live-drag fast path vs. debounced stale-hold structural update.

        Returns None if `node_id` is not part of the active tiled session.
        """
        nid = str(node_id)
        with self._lock:
            if self._session is None:
                return None
            stage = next((s for s in self._session.stages if s.node_id == nid), None)
            if stage is None:
                return None

            stage.processor_params[key] = value
            if key == "precook_window_sec":
                self._cond.notify_all()
                return {"ok": True, "mode": "precook_resized"}

            if key == "cook_mode":
                if stage.cook_mode == "manual":
                    self._forced_manual_nodes.discard(nid)
                    self._emit_status(stage, "stale_bypassed", 0.0, "manual cook required")
                else:
                    self._cond.notify_all()
                return {"ok": True, "mode": f"cook_mode_{stage.cook_mode}"}

            if key == "bypass":
                # If ALL stages are now bypassed, clear C++ tile overlay immediately so raw audio plays cleanly
                if all(s.bypassed for s in self._session.stages):
                    if self._on_tile_publish is not None:
                        for tidx in range(self._session.num_tiles):
                            self._on_tile_publish(self._session.source_id, tidx, None, 0)
                    if self._overlay is not None:
                        self._overlay.clear_tiles()
                    self._published.clear()
                    if self._on_tile_visual is not None:
                        try:
                            self._on_tile_visual({
                                "type": "tile_update",
                                "clear_all": True,
                                "duration_sec": round(self._session.active_timeline_sec, 4),
                                "bus_node_ids": list(self._session.bus_node_ids),
                                "stage_node_ids": [s.node_id for s in self._session.stages],
                            })
                        except Exception:
                            pass
                    self._emit_status(stage, "bypassed", 1.0, "bypassed")
                    return {"ok": True, "mode": "bypassed"}

            is_struct = is_structural_processor_param(stage.node_type, key)
            if not is_struct:
                # FAST LEVEL-2 MIX/SYNTH KNOB:
                # Re-synthesize ONLY playhead tile (+ next tile) live while dragging (~20-50ms)!
                p_tile = self._time_to_tile_locked(self._playhead_sec)
                local_tiles = [t for t in (p_tile, p_tile + 1) if 0 <= t < self._session.num_tiles]
                self._live_drag_active = not bool(commit)
                self._generation += 1
                if commit:
                    # Pointer released: mark off-screen tiles dirty so background sweep updates them lazily
                    self._published.clear()
                    self._priority_tiles = list(local_tiles)
                else:
                    # Mid-drag: ONLY re-synth local playhead tiles without churning off-screen tiles
                    for t in local_tiles:
                        self._published.pop(t, None)
                    self._priority_tiles = list(local_tiles)
                self._cond.notify_all()
                return {"ok": True, "mode": "live_synth" if not commit else "commit_synth", "tiles": local_tiles}

            # HEAVY STRUCTURAL KNOB:
            # Hold previous cooked tiles audible in C++ (marked stale/amber) and debounce re-cook!
            if self._overlay is not None:
                self._overlay.mark_all_stale()
                self._emit_stale_visual_locked()
            self._emit_status(stage, "cooking_bypassed", 0.0, "re-cooking (holding stale)")
            self._cancel_debounce_locked()
            debounce_sec = max(0.05, float(get_env_config().cook_debounce_ms) / 1000.0)

            def _trigger_structural() -> None:
                with self._lock:
                    self._debounce_timer = None
                    if self._session is None:
                        return
                    self._cancel_event.set()
                    self._cancel_event = threading.Event()
                    self._generation += 1
                    self._published.clear()
                    self._priority_tiles.clear()
                    self._live_drag_active = False
                    self._cond.notify_all()

            timer = threading.Timer(debounce_sec, _trigger_structural)
            timer.daemon = True
            self._debounce_timer = timer
            timer.start()
            return {"ok": True, "mode": "structural_stale_hold", "debounce_ms": int(debounce_sec * 1000)}

    def wait_for_playhead_tile(self, playhead_sec: float, timeout_sec: float = 2.5) -> bool:
        """Block briefly (for optional 'Wait for FX' preroll) until the tile at `playhead_sec` is published."""
        deadline = time.monotonic() + max(0.05, float(timeout_sec))
        with self._lock:
            if self._session is None:
                return True
            active_stages = [s for s in self._session.stages if self._is_stage_active_locked(s)]
            if not active_stages:
                return True
            self._playhead_sec = max(0.0, float(playhead_sec))
            target_tile = self._time_to_tile_locked(self._playhead_sec)
            if target_tile not in self._priority_tiles:
                self._priority_tiles.insert(0, target_tile)
            self._cond.notify_all()
            while True:
                if self._session is None:
                    return True
                pub = self._published.get(target_tile)
                if pub is not None:
                    return True
                rem = deadline - time.monotonic()
                if rem <= 0.0:
                    return False
                self._cond.wait(timeout=min(0.1, rem))

    def _cancel_debounce_locked(self) -> None:
        if self._debounce_timer is not None:
            self._debounce_timer.cancel()
            self._debounce_timer = None

    def _active_tile_bounds_locked(self) -> Tuple[int, int]:
        if self._session is None or self._session.tile_sec <= 0:
            return 0, 0
        scale = self._session.tile_time_scale
        s_tile = self._session.crop_start_sec * scale
        e_tile = min(
            self._session.tile_total_duration_sec,
            s_tile + self._session.active_timeline_sec * max(0.05, self._session.playback_rate) * scale,
        )
        min_t = max(0, min(self._session.num_tiles - 1, int(math.floor(s_tile / self._session.tile_sec))))
        max_t = max(min_t, min(self._session.num_tiles - 1, int(math.floor(max(s_tile, e_tile - 1e-4) / self._session.tile_sec))))
        return min_t, max_t

    def _time_to_tile_locked(self, timeline_sec: float) -> int:
        """Convert TIMELINE playhead seconds -> tile index (honoring crop_start, playback_rate & tile_time_scale)."""
        if self._session is None or self._session.tile_sec <= 0:
            return 0
        scale = self._session.tile_time_scale
        rate = max(0.05, float(self._session.playback_rate or 1.0))
        tile_sec_pos = (self._session.crop_start_sec + max(0.0, float(timeline_sec)) * rate) * scale
        min_t, max_t = self._active_tile_bounds_locked()
        idx = int(math.floor(max(0.0, tile_sec_pos) / self._session.tile_sec))
        return max(min_t, min(max_t, idx))

    def _is_stage_active_locked(self, st: TiledStageSpec) -> bool:
        if st.bypassed:
            return False
        if st.cook_mode == "manual" and st.node_id not in self._forced_manual_nodes:
            return False
        return True

    def _check_stage_ready(self, st: TiledStageSpec) -> Dict[str, Any]:
        if st.node_type == "voice_isolator":
            return check_voice_backend_ready(
                str(st.processor_params.get("backend") or "fast_onnx"),
                model_manager=GLOBAL_MODEL_MANAGER,
            )
        return {"ready": True}

    def _emit_status(
        self,
        st: TiledStageSpec,
        state: str,
        progress: float,
        phase: str,
        *,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload = {
            "node_id": st.node_id,
            "node_type": st.node_type,
            "node_name": st.node_name,
            "state": state,
            "progress": round(max(0.0, min(1.0, float(progress))), 3),
            "phase": phase,
            "tier": st.tier,
            "precook_window_sec": st.precook_window_sec,
            **(extra or {}),
        }
        with self._lock:
            self._statuses[st.node_id] = dict(payload)
        if self._on_status is None:
            return
        try:
            self._on_status(st.node_id, payload)
        except Exception:
            pass

    def _emit_stale_visual_locked(self) -> None:
        if self._on_tile_visual is None or self._session is None or self._overlay is None:
            return
        msg = {
            "type": "tile_update",
            "stale_all": True,
            "duration_sec": self._session.active_timeline_sec,
            "coverage": self._overlay.coverage_summary(),
            "bus_node_ids": list(self._session.bus_node_ids),
            "stage_node_ids": [s.node_id for s in self._session.stages],
        }
        try:
            self._on_tile_visual(msg)
        except Exception:
            pass

    def _pick_next_job_locked(self) -> Optional[Tuple[TiledTrackSessionSpec, int, int, int, threading.Event]]:
        """Select `(session, tile_idx, target_max_tier, generation, cancel_ev)` or None if idle."""
        sess = self._session
        if sess is None or sess.num_tiles <= 0:
            return None

        active_stages = [s for s in sess.stages if self._is_stage_active_locked(s)]
        if not active_stages:
            return None

        has_fast = any(s.tier == TIER_FAST_DSP for s in active_stages)
        ml_stages = [s for s in active_stages if s.tier == TIER_COMPLEX_ML]
        has_ml = bool(ml_stages)
        ml_full_track = any(s.node_id in self._full_track_ml_nodes for s in ml_stages)
        max_precook = max((s.precook_window_sec for s in active_stages), default=24.0)

        # 1. Explicit priority tiles (e.g. live-drag local playhead re-synth or Wait-for-FX)
        while self._priority_tiles:
            tidx = self._priority_tiles.pop(0)
            if 0 <= tidx < sess.num_tiles:
                want_tier = TIER_COMPLEX_ML if has_ml else TIER_FAST_DSP
                return sess, tidx, want_tier, self._generation, self._cancel_event

        # While actively dragging a fast knob, do NOT churn off-screen tiles
        if self._live_drag_active:
            return None

        # 2. Sliding Playhead Precook Window inside active cropped bounds (lead latency FIRST, then forward, then lookbehind)
        min_t, max_t = self._active_tile_bounds_locked()
        lead_sec = self._playhead_sec + (self.LEAD_LATENCY_SEC if self._is_playing else 0.0)
        lead_tile = self._time_to_tile_locked(lead_sec)
        cur_tile = self._time_to_tile_locked(self._playhead_sec)
        win_end_tile = self._time_to_tile_locked(self._playhead_sec + max_precook)
        win_start_tile = self._time_to_tile_locked(max(0.0, self._playhead_sec - self.LOOKBEHIND_SEC))

        window_order: List[int] = []
        for cand in [lead_tile, cur_tile]:
            if min_t <= cand <= max_t and cand not in window_order:
                window_order.append(cand)
        for t in range(cur_tile + 1, min(max_t, win_end_tile) + 1):
            if t not in window_order:
                window_order.append(t)
        for t in range(cur_tile - 1, max(min_t, win_start_tile) - 1, -1):
            if t not in window_order:
                window_order.append(t)

        want_window_tier = TIER_COMPLEX_ML if has_ml else TIER_FAST_DSP
        for tidx in window_order:
            pub = self._published.get(tidx)
            if pub is None or pub[0] < want_window_tier:
                return sess, tidx, want_window_tier, self._generation, self._cancel_event

        # 3. Full-Track Background Sweep (strictly within active cropped bounds [min_t .. max_t]):
        #    Strict DSP vs. ML split: Fast DSP propagates across active tiles; Complex ML only if explicitly requested!
        want_bg_tier = TIER_COMPLEX_ML if (has_ml and ml_full_track) else (TIER_FAST_DSP if has_fast else TIER_RAW)
        if want_bg_tier == TIER_RAW:
            return None

        max_dist = max(cur_tile - min_t, max_t - cur_tile)
        for d in range(1, max_dist + 1):
            for tidx in (cur_tile + d, cur_tile - d):
                if min_t <= tidx <= max_t:
                    pub = self._published.get(tidx)
                    if pub is None or pub[0] < want_bg_tier:
                        return sess, tidx, want_bg_tier, self._generation, self._cancel_event
        return None

    def _read_disk_slice(
        self,
        filepath: str,
        target_sr: int,
        start_frame_sr: int,
        end_frame_sr: int,
    ) -> np.ndarray:
        """Read ONLY `[start_frame_sr, end_frame_sr)` directly from disk (zero full-file RAM load)."""
        needed = max(0, int(end_frame_sr) - int(start_frame_sr))
        if needed <= 0:
            return np.zeros((2, 0), dtype=np.float32)
        with sf.SoundFile(filepath, mode="r") as f:
            file_sr = int(f.samplerate or target_sr or 48000)
            file_len = int(len(f))
            if file_sr == target_sr:
                s0 = max(0, min(file_len, int(start_frame_sr)))
                s1 = max(s0, min(file_len, int(end_frame_sr)))
                f.seek(s0)
                raw = f.read(s1 - s0, dtype="float32", always_2d=True)
                stereo = ensure_stereo_f32(raw.T) if raw.size > 0 else np.zeros((2, 0), dtype=np.float32)
            else:
                ratio = float(file_sr) / float(target_sr)
                s0 = max(0, min(file_len, int(math.floor(start_frame_sr * ratio))))
                s1 = max(s0, min(file_len, int(math.ceil(end_frame_sr * ratio)) + 16))
                f.seek(s0)
                raw = f.read(s1 - s0, dtype="float32", always_2d=True)
                stereo = ensure_stereo_f32(raw.T) if raw.size > 0 else np.zeros((2, 0), dtype=np.float32)
                if stereo.shape[-1] > 0:
                    g = math.gcd(int(target_sr), int(file_sr))
                    stereo = signal.resample_poly(stereo, int(target_sr) // g, int(file_sr) // g, axis=-1).astype(np.float32)

        if stereo.shape[-1] < needed:
            pad = np.zeros((2, needed - stereo.shape[-1]), dtype=np.float32)
            stereo = np.concatenate([stereo, pad], axis=-1)
        return np.ascontiguousarray(stereo[:, :needed], dtype=np.float32)

    def _get_or_scan_preamp_baseline(
        self,
        sess: TiledTrackSessionSpec,
        st: TiledStageSpec,
        file_sig: str,
    ) -> Optional[PreampGlobalBaseline]:
        b_key = _fp_hash({"sig": file_sig, "sr": sess.sample_rate, "struct": st.structural_dict()})
        with self._lock:
            existing = self._baselines.get(b_key)
            if existing is not None:
                return existing
        p = st.processor_params
        baseline = scan_preamp_global_baseline(
            sess.base_filepath,
            sess.sample_rate,
            profile_id=str(p.get("profile_id") or "generic_adc"),
            hp_hz=float(p.get("hp_hz", 40.0)),
            stft_mode=str(p.get("stft_mode") or "hq_dual_res"),
            noise_start=float(p.get("noise_start", 0.0)),
            noise_end=float(p.get("noise_end", 0.0)),
        )
        if baseline is not None:
            with self._lock:
                self._baselines[b_key] = baseline
                if len(self._baselines) > 16:
                    self._baselines.pop(next(iter(self._baselines)))
        return baseline

    def _execute_tile(
        self,
        sess: TiledTrackSessionSpec,
        tidx: int,
        target_max_tier: int,
        gen: int,
        cancel_ev: threading.Event,
    ) -> None:
        with self._lock:
            if self._generation != gen or cancel_ev.is_set():
                return
            file_sig = self._file_sig
            # Snapshot active stages permitted up to `target_max_tier`
            stages_snap: List[TiledStageSpec] = []
            for st in sess.stages:
                if not self._is_stage_active_locked(st):
                    continue
                if st.tier > target_max_tier:
                    continue
                stages_snap.append(
                    TiledStageSpec(
                        node_id=st.node_id,
                        node_type=st.node_type,
                        node_name=st.node_name,
                        processor_params=dict(st.processor_params),
                    )
                )

        if not stages_snap:
            return

        sr = sess.sample_rate
        s0 = tidx * sess.tile_frames
        s1 = min(sess.total_frames, (tidx + 1) * sess.tile_frames)
        core_len = max(0, s1 - s0)
        if core_len <= 0:
            return

        # Compute cumulative chain synth fingerprint for fast PCM cache hit
        chain_synth_fp = _fp_hash({
            "sig": file_sig,
            "sr": sr,
            "tile_frames": sess.tile_frames,
            "stages": [(s.node_type, s.processor_params) for s in stages_snap],
        })
        effective_tier = max(s.tier for s in stages_snap)

        # 1. Fast final PCM tile cache hit (RAM LRU or Disk Spill!)
        cached_pcm = self._tile_cache.get_pcm_tile(chain_synth_fp, tidx)
        if cached_pcm is not None and cached_pcm.pcm.shape[-1] == core_len:
            self._commit_tile_result(sess, tidx, cached_pcm.pcm, cached_pcm.peaks, effective_tier, chain_synth_fp, gen, stages_snap)
            return

        # 2. Read ONLY `[src_s0 - halo, src_s1 + halo)` directly from disk (with tiny 8-tile RAM cache)
        rb_stage = next((s for s in stages_snap if s.node_type == "rubberband_stretch"), None)
        if sess.tile_time_stretched and rb_stage is not None:
            tempo_rate = max(0.05, float(rb_stage.processor_params.get("tempo_rate", sess.stretch_tempo_rate or 1.0)))
            raw_total_frames_sr = max(1, int(round(sess.duration_sec * sr)))
            src_s0 = int(round(float(s0) * tempo_rate))
            src_s1 = int(round(float(s1) * tempo_rate))
            src_halo = int(round(self.HALO_SEC * max(1.0, tempo_rate) * sr))
            h0 = max(0, src_s0 - src_halo)
            h1 = min(raw_total_frames_sr, src_s1 + src_halo)
            trim_left = max(0, int(round(float(src_s0 - h0) / tempo_rate)))
        else:
            halo_frames = int(round(self.HALO_SEC * sr))
            h0 = max(0, s0 - halo_frames)
            h1 = min(sess.total_frames, s1 + halo_frames)
            trim_left = s0 - h0

        raw_key = (file_sig, tidx)
        audio: Optional[np.ndarray] = None
        with self._lock:
            cached_raw = self._raw_tile_ram.get(raw_key)
            if cached_raw is not None and cached_raw[1] == h0 and cached_raw[2] == h1:
                audio = cached_raw[0]
        if audio is None:
            audio = self._read_disk_slice(sess.base_filepath, sr, h0, h1)
            with self._lock:
                self._raw_tile_ram[raw_key] = (audio, h0, h1)
                if len(self._raw_tile_ram) > 8:
                    self._raw_tile_ram.pop(next(iter(self._raw_tile_ram)))
        if cancel_ev.is_set():
            return

        upstream_fp = _fp_hash({"sig": file_sig, "sr": sr, "tile_frames": sess.tile_frames, "h0": h0, "h1": h1})
        highest_applied_tier = TIER_RAW
        stage_extras: Dict[str, Dict[str, Any]] = {}

        for st in stages_snap:
            if cancel_ev.is_set():
                return
            chk = self._check_stage_ready(st)
            if not chk.get("ready", True):
                self._emit_status(
                    st,
                    "model_missing",
                    0.0,
                    "model download required",
                    extra={"model_id": chk.get("model_id"), "model_status": chk.get("model_status")},
                )
                continue

            cook_fp = _fp_hash({
                "up": upstream_fp,
                "nt": st.node_type,
                "struct": st.structural_dict(),
            })

            if st.node_type == "rubberband_stretch":
                from core.stretching import (
                    RubberBandUnavailableError,
                    StretchAlgorithm,
                    normalize_stretch_algorithm,
                    stretch_with_rubberband,
                )
                p = st.processor_params
                r_tempo = max(0.05, float(p.get("tempo_rate", 1.0)))
                r_semis = float(p.get("semitones", 0.0))
                r_algo = normalize_stretch_algorithm(p.get("algorithm") or "rubberband")
                r_fast = bool(p.get("fast_engine", True))
                if abs(r_tempo - 1.0) > 1e-4 or abs(r_semis) > 1e-4:
                    if r_algo is not StretchAlgorithm.LIBROSA:
                        try:
                            audio = stretch_with_rubberband(
                                audio,
                                sr,
                                algorithm=r_algo,
                                tempo_rate=r_tempo,
                                semitones=r_semis,
                                fast_engine=r_fast,
                            )
                        except RubberBandUnavailableError:
                            import librosa
                            if abs(r_semis) > 1e-4:
                                audio = librosa.effects.pitch_shift(y=audio, sr=sr, n_steps=r_semis)
                            if abs(r_tempo - 1.0) > 1e-4:
                                audio = librosa.effects.time_stretch(y=audio, rate=r_tempo)
                    else:
                        import librosa
                        if abs(r_semis) > 1e-4:
                            audio = librosa.effects.pitch_shift(y=audio, sr=sr, n_steps=r_semis)
                        if abs(r_tempo - 1.0) > 1e-4:
                            audio = librosa.effects.time_stretch(y=audio, rate=r_tempo)
                audio = ensure_stereo_f32(audio)
                if cancel_ev.is_set():
                    return
                highest_applied_tier = max(highest_applied_tier, TIER_FAST_DSP)

            elif st.node_type == "preamp_denoise":
                art = self._tile_cache.get_analysis(cook_fp, tidx)
                if art is None:
                    baseline = self._get_or_scan_preamp_baseline(sess, st, file_sig)
                    p = st.processor_params
                    art = analyze_preamp(
                        audio,
                        sr,
                        profile_id=str(p.get("profile_id") or "generic_adc"),
                        hp_hz=float(p.get("hp_hz", 40.0)),
                        stft_mode=str(p.get("stft_mode") or "hq_dual_res"),
                        noise_start=float(p.get("noise_start", 0.0)),
                        noise_end=float(p.get("noise_end", 0.0)),
                        global_baseline=baseline,
                        cancel_event=cancel_ev,
                    )
                    if cancel_ev.is_set():
                        return
                    self._tile_cache.put_analysis(cook_fp, tidx, art, serialize_fn=None)
                audio = synthesize_preamp(art, audio, st.processor_params)
                highest_applied_tier = max(highest_applied_tier, TIER_FAST_DSP)

            elif st.node_type == "voice_isolator":
                backend = str(st.processor_params.get("backend") or "fast_onnx")

                def _deser_voice(arrays: Dict[str, np.ndarray], b_name: str = backend) -> Optional[VoiceDecomposition]:
                    if all(k in arrays for k in ("voice", "reverb", "ambience")):
                        return VoiceDecomposition.from_cache_arrays(arrays, sr, b_name)
                    return None

                art = self._tile_cache.get_analysis(cook_fp, tidx, deserialize_fn=_deser_voice)
                if art is None:
                    art = decompose_voice(
                        audio,
                        sr,
                        backend=backend,
                        reverb_sensitivity=float(st.processor_params.get("reverb_sensitivity", 0.5)),
                        model_manager=GLOBAL_MODEL_MANAGER,
                        cancel_event=cancel_ev,
                    )
                    if cancel_ev.is_set():
                        return
                    self._tile_cache.put_analysis(
                        cook_fp,
                        tidx,
                        art,
                        serialize_fn=lambda d: d.to_cache_arrays(),
                    )
                audio = recombine_voice(art, audio, st.processor_params)
                stage_extras[st.node_id] = {
                    "backend": art.backend_used,
                    "stem_rms": {
                        "voice": art.rms_voice,
                        "reverb": art.rms_reverb,
                        "ambience": art.rms_ambience,
                    },
                }
                highest_applied_tier = max(highest_applied_tier, st.tier)

            upstream_fp = _fp_hash({"cook": cook_fp, "params": st.processor_params})

        if cancel_ev.is_set() or highest_applied_tier == TIER_RAW:
            return

        # 3. Trim OLA halos cleanly to exact core tile length
        core_pcm = np.ascontiguousarray(audio[:, trim_left : trim_left + core_len], dtype=np.float32)
        if core_pcm.shape[-1] < core_len:
            pad = np.zeros((2, core_len - core_pcm.shape[-1]), dtype=np.float32)
            core_pcm = np.concatenate([core_pcm, pad], axis=-1)

        tile_peaks = compute_interleaved_peaks(core_pcm, self.TILE_PEAK_COLS)
        # Skip disk spill mid-drag so rapid fader motion stays 100% RAM-speed
        with self._lock:
            persist = not self._live_drag_active
        self._tile_cache.put_pcm_tile(
            chain_synth_fp,
            tidx,
            core_pcm,
            tile_peaks,
            tier=highest_applied_tier,
            generation=gen,
            persist_disk=persist,
        )
        self._commit_tile_result(
            sess, tidx, core_pcm, tile_peaks, highest_applied_tier, chain_synth_fp, gen, stages_snap, stage_extras
        )

    def _commit_tile_result(
        self,
        sess: TiledTrackSessionSpec,
        tidx: int,
        core_pcm: np.ndarray,
        tile_peaks: np.ndarray,
        tier: int,
        synth_fp: str,
        gen: int,
        stages_snap: List[TiledStageSpec],
        stage_extras: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> None:
        with self._lock:
            if self._generation != gen or self._session is None or self._session.source_id != sess.source_id:
                return
            self._published[tidx] = (tier, synth_fp, gen)
            tl_span: Optional[Tuple[float, float]] = None
            if self._overlay is not None:
                self._overlay.set_tile(tidx, tier, tile_peaks, stale=False)
                cov = self._overlay.coverage_summary()
                tl_span = self._overlay.tile_to_timeline_span(tidx)
            else:
                cov = {"num_tiles": sess.num_tiles, "tile_sec": sess.tile_sec, "fast_tiles": 0, "ml_tiles": 0, "stale_tiles": 0}
            # Signal any Wait-for-FX caller waiting on playhead tile
            self._cond.notify_all()

        # Publish atomically into C++ LayeredTileStore (ZERO load_plan reload!)
        if self._on_tile_publish is not None:
            try:
                self._on_tile_publish(sess.source_id, tidx, core_pcm, gen)
            except Exception as exc:
                logger.debug("Layered tile C++ publish failed: %s", exc)

        # Push compact dual-color tile delta in TIMELINE coordinates to frontend transport bar
        if self._on_tile_visual is not None and tl_span is not None:
            t_start, t_end = tl_span
            # Trim tile_peaks if the tile straddles crop_start or timeline_end so waveform edges align cleanly
            scale = sess.tile_time_scale
            tile_s0 = float(tidx) * sess.tile_sec
            tile_s1 = min(sess.tile_total_duration_sec, float(tidx + 1) * sess.tile_sec)
            tile_span = max(1e-4, tile_s1 - tile_s0)
            rate_t = max(1e-4, float(sess.playback_rate or 1.0) * scale)
            crop_t = sess.crop_start_sec * scale
            vis_tile_s0 = crop_t + t_start * rate_t
            vis_tile_s1 = crop_t + t_end * rate_t
            n_pairs = int(tile_peaks.size // 2)
            p0 = max(0, min(n_pairs - 1, int(math.floor(((vis_tile_s0 - tile_s0) / tile_span) * n_pairs))))
            p1 = max(p0 + 1, min(n_pairs, int(math.ceil(((vis_tile_s1 - tile_s0) / tile_span) * n_pairs))))
            vis_peaks = tile_peaks[p0 * 2 : p1 * 2]
            try:
                self._on_tile_visual({
                    "type": "tile_update",
                    "tile_index": tidx,
                    "num_tiles": cov.get("num_tiles", sess.num_tiles),
                    "start_sec": round(t_start, 4),
                    "end_sec": round(t_end, 4),
                    "duration_sec": round(sess.active_timeline_sec, 4),
                    "tier": tier,
                    "stale": False,
                    "peaks": np.round(vis_peaks, 4).tolist(),
                    "coverage": cov,
                    "bus_node_ids": list(sess.bus_node_ids),
                    "stage_node_ids": [s.node_id for s in sess.stages],
                })
            except Exception:
                pass

        # Update per-stage progress badges cleanly
        num_t = max(1, int(cov.get("num_tiles", sess.num_tiles)))
        for st in stages_snap:
            st_ex = (stage_extras or {}).get(st.node_id)
            if st.tier == TIER_FAST_DSP:
                done_count = cov.get("fast_tiles", 0) + cov.get("ml_tiles", 0)
                frac = min(1.0, float(done_count) / float(num_t))
                state = "ready" if done_count >= num_t else "partial_ready"
                phase = "ready" if done_count >= num_t else f"propagating {done_count}/{num_t} tiles"
                self._emit_status(st, state, frac, phase, extra=st_ex)
            else:
                ml_done = cov.get("ml_tiles", 0)
                with self._lock:
                    full_req = st.node_id in self._full_track_ml_nodes
                if full_req:
                    frac = min(1.0, float(ml_done) / float(num_t))
                    state = "ready" if ml_done >= num_t else "partial_ready"
                    phase = "ready" if ml_done >= num_t else f"cooking full track {ml_done}/{num_t}"
                else:
                    win_tiles = max(1, min(num_t, int(math.ceil((st.precook_window_sec + self.LOOKBEHIND_SEC) / sess.tile_sec))))
                    frac = min(1.0, float(ml_done) / float(win_tiles))
                    state = "ready" if ml_done >= num_t else "partial_ready"
                    phase = "ready" if ml_done >= num_t else f"precook ({int(round(st.precook_window_sec))}s · {ml_done}/{num_t} tiles)"
                self._emit_status(st, state, frac, phase, extra=st_ex)

    def _worker_loop(self) -> None:
        while True:
            with self._lock:
                while not self._stop:
                    job = self._pick_next_job_locked()
                    if job is not None:
                        break
                    self._cond.wait(timeout=0.5)
                if self._stop:
                    return
            sess, tidx, target_tier, gen, cancel_ev = job
            try:
                self._execute_tile(sess, tidx, target_tier, gen, cancel_ev)
                # Brief cooperative yield between background tiles so HTTP/WS/UI requests never starve
                with self._lock:
                    has_urgent = bool(self._priority_tiles)
                if not has_urgent:
                    time.sleep(0.015)
            except InterruptedError:
                continue
            except Exception as exc:
                logger.exception("Tiled cook error on tile %d: %s", tidx, exc)
                # Avoid tight spin on broken input
                time.sleep(0.15)
