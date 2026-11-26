"""Reusable in-process real-time audio session host for FastAPI (`:8000` SIN and `:8001` GAIA).

Owns one lazy-initialized native `SinAudioEngine(offline_mode=False)` per server process,
handles low-latency WebSocket control messages (`load_canonical`, `load_node_model`,
`set_param`, `set_transport`, `set_audition`, `stop_and_release`), and pushes 30-45 Hz
playhead/meter/scope telemetry back to connected browser clients.

Concurrency design (zero GUI / event-loop freezes):
- Heavy packing & Tier-2 Rubber Band cooking ALWAYS run in a background worker thread
  WITHOUT holding `self._lock`. `self._lock` is only held for the <1ms `eng.load_plan()`
  pointer handoff and device start/stop.
- WebSocket plan loads are non-blocking and superseded cleanly by newer requests
  (`_load_generation`), so `set_param`, `set_transport`, and telemetry never stall.
- Master waveform peaks are computed asynchronously in a background task AFTER
  `plan_loaded` is sent so audio starts/hot-swaps immediately.
"""

from __future__ import annotations

from collections import OrderedDict
import asyncio
import copy
import json
import logging
import threading
from pathlib import Path
from time import perf_counter
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Tuple
import numpy as np

from fastapi import WebSocket, WebSocketDisconnect

from core.audio_engine import SinAudioEngine, is_native_engine_available, render_plan_offline
from core.env_config import get_env_config
from core.plan_packer import pack_audio_node_model, pack_canonical_graph
from core.processors.cook_scheduler import ProcessorCookScheduler
from core.processors.tile_cache import (
    GLOBAL_PEAK_PYRAMID_CACHE,
    GLOBAL_TILE_CACHE,
    PeakPyramid,
    TIER_RAW,
)
from core.processors.tile_scheduler import TiledCookScheduler
from core.render_plan import (
    BusSpec,
    ChainStageSpec,
    ClipSpec,
    PARAM_NAME_TO_ID,
    SIN_CLIP_CROP_IN_PLACE,
    SIN_CLIP_LIVE_CROP_BOUND,
    SIN_DEFAULT_SAMPLE_RATE,
    SIN_PARAM_CROP_END,
    SIN_PARAM_CROP_START,
    SIN_PARAM_MUTE,
    SIN_PARAM_PAN,
    SIN_PARAM_PLAYBACK_RATE,
    SIN_PARAM_POST_GAIN_DB,
    SIN_PARAM_PRE_GAIN_DB,
    SIN_PARAM_SOLO,
    SIN_PARAM_VOLUME,
    SinRenderPlan,
    SourceSpec,
)
from core.system import System

logger = logging.getLogger("sin.realtime_host")

ProjectRootResolver = Callable[[Optional[int]], Optional[Path]]
ItemPathResolver = Callable[[int], Optional[str]]


def _fast_waveform_peaks(audio_data: np.ndarray, columns: int = 512) -> list[float]:
    """Vectorized [min0, max0, min1, max1, ...] peak extractor (~0.3 ms for 512 cols)."""
    if audio_data is None or audio_data.size == 0 or columns <= 0:
        return []
    mono = audio_data.mean(axis=0, dtype=np.float32) if audio_data.ndim > 1 else np.asarray(audio_data, dtype=np.float32)
    total = int(mono.shape[-1])
    if total == 0:
        return []
    cols = min(int(columns), total)
    usable = (total // cols) * cols
    if usable <= 0:
        return []
    reshaped = mono[:usable].reshape(cols, usable // cols)
    mins = np.round(reshaped.min(axis=1), 4)
    maxs = np.round(reshaped.max(axis=1), 4)
    interleaved = np.empty(cols * 2, dtype=np.float32)
    interleaved[0::2] = mins
    interleaved[1::2] = maxs
    return interleaved.tolist()


class RealtimeAudioHost:
    """Thread-safe controller wrapping one real-time native `SinAudioEngine`."""

    def __init__(
        self,
        name: str = "sin",
        sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
        project_root_resolver: Optional[ProjectRootResolver] = None,
        item_path_resolver: Optional[ItemPathResolver] = None,
        include_scope: bool = False,
    ) -> None:
        self.name = name
        self._requested_sr = int(sample_rate or SIN_DEFAULT_SAMPLE_RATE)
        self._project_root_resolver = project_root_resolver
        self._item_path_resolver = item_path_resolver
        self._include_scope = bool(include_scope)
        self._lock = threading.RLock()
        self._engine: Optional[SinAudioEngine] = None
        self._clients: Set[WebSocket] = set()
        self._client_senders: Dict[WebSocket, Callable[[Dict[str, Any]], Awaitable[None]]] = {}
        self._owner_ws: Optional[WebSocket] = None
        self._active_plan: Optional[SinRenderPlan] = None
        self._load_generation: int = 0
        self._last_peak_columns: int = 512
        self._last_node_model_payload: Optional[Dict[str, Any]] = None
        self._ws_loop: Optional[asyncio.AbstractEventLoop] = None
        self._cook_scheduler = ProcessorCookScheduler(
            on_status=self._on_processor_cook_status,
            on_hot_swap=self._on_processor_cook_hot_swap,
        )
        self._tile_scheduler = TiledCookScheduler(
            on_tile_publish=self._on_layered_tile_publish,
            on_tile_visual=self._on_layered_tile_visual,
            on_status=self._on_processor_cook_status,
        )
        self._wait_for_fx: bool = bool(get_env_config().wait_for_fx_default)
        self._active_peak_filepath: Optional[str] = None
        self._active_base_pyramid: Optional[PeakPyramid] = None
        self._active_peak_window: Tuple[float, float, float] = (0.0, 1.0, 0.0)  # (src_s0, rate, tl_dur)
        # 16-slot LRU of preview source IDs (90001..90016) so re-auditioning recent samples is 0ms RAM hit
        self._preview_lru: OrderedDict[str, int] = OrderedDict()
        self._preview_slot_pool: list[int] = list(range(90001, 90017))

    def _on_layered_tile_publish(self, source_id: int, tile_idx: int, pcm: Optional[np.ndarray], gen: int) -> None:
        eng = self._engine
        if eng is not None and eng.supports_layered_tiles():
            eng.set_layered_tile(source_id, tile_idx, pcm, generation=gen)

    def _on_layered_tile_visual(self, payload: Dict[str, Any]) -> None:
        self._broadcast_async_event(payload)

    def get_engine_settings(self) -> Dict[str, Any]:
        cfg = get_env_config()
        return {
            "wait_for_fx": bool(self._wait_for_fx),
            "tile_sec": float(cfg.tile_sec),
            "default_precook_sec": float(cfg.default_precook_sec),
            "cache_stats": GLOBAL_TILE_CACHE.stats(),
        }

    def update_engine_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        if "wait_for_fx" in settings:
            self._wait_for_fx = bool(settings["wait_for_fx"])
        if settings.get("tile_ram_mb") is not None:
            try:
                GLOBAL_TILE_CACHE.set_ram_budget_mb(int(settings["tile_ram_mb"]))
            except (TypeError, ValueError):
                pass
        if settings.get("dsp_cache_max_gb") is not None:
            try:
                GLOBAL_TILE_CACHE.set_disk_budget_gb(float(settings["dsp_cache_max_gb"]))
            except (TypeError, ValueError):
                pass
        if bool(settings.get("clear_tile_cache", False)):
            GLOBAL_TILE_CACHE.clear()
        return self.get_engine_settings()

    def query_viewport_peaks(self, start_sec: float, end_sec: float, columns: int = 512) -> Dict[str, Any]:
        cols = max(16, min(2048, int(columns or 512)))
        overlay = self._tile_scheduler.overlay
        if overlay is not None:
            peaks, tiers = overlay.query_viewport(start_sec, end_sec, cols)
            return {
                "ok": True,
                "start_sec": float(start_sec),
                "end_sec": float(end_sec),
                "duration_sec": overlay.duration_sec,
                "peaks": peaks,
                "tiers": tiers,
                "coverage": overlay.coverage_summary(),
            }
        pyr = self._active_base_pyramid
        if pyr is not None:
            win_s0, win_rate, win_dur = self._active_peak_window
            eff_dur = win_dur if win_dur > 0.0 else pyr.duration_sec
            eff_rate = max(0.05, float(win_rate or 1.0))
            src_s0 = win_s0 + max(0.0, float(start_sec)) * eff_rate
            src_s1 = win_s0 + max(float(start_sec) + 1e-4, float(end_sec)) * eff_rate
            peaks = pyr.query(src_s0, src_s1, cols)
            return {
                "ok": True,
                "start_sec": float(start_sec),
                "end_sec": float(end_sec),
                "duration_sec": eff_dur,
                "peaks": peaks,
                "tiers": [TIER_RAW] * (len(peaks) // 2),
                "coverage": None,
            }
        return {"ok": False, "peaks": [], "tiers": []}

    def _broadcast_async_event(self, payload: Dict[str, Any]) -> None:
        loop = self._ws_loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            senders = list(self._client_senders.values())
        for sender in senders:
            try:
                asyncio.run_coroutine_threadsafe(sender(payload), loop)
            except Exception:
                pass

    def _on_processor_cook_status(self, node_id: str, status: Dict[str, Any]) -> None:
        self._broadcast_async_event({"type": "processor_status", **status})

    def _on_processor_cook_hot_swap(self, node_id: str, stage: str) -> None:
        """Silently re-pack & 5ms hot-swap the active node model once a background cook completes."""
        with self._lock:
            payload = copy.deepcopy(self._last_node_model_payload)
            gen = self._load_generation
            cols = self._last_peak_columns
        if payload is None:
            return
        try:
            res = self.load_node_model_plan(
                payload,
                compute_peaks=True,
                peak_columns=cols,
                expected_gen=gen,
                allow_async_cook=True,
            )
            if not res.get("ok") or res.get("superseded"):
                return
            res.pop("_plan", None)
            self._broadcast_async_event({
                "type": "plan_hot_swapped",
                "node_id": str(node_id),
                "stage": stage,
                **res,
            })
        except Exception as exc:
            logger.debug("[%s] Processor hot-swap skipped: %s", self.name, exc)

    def status(self) -> Dict[str, Any]:
        available = is_native_engine_available()
        with self._lock:
            sr = self._engine.sample_rate if self._engine is not None else self._requested_sr
            running = self._engine.is_device_running() if self._engine is not None else False
        return {
            "host": self.name,
            "available": available,
            "sample_rate": sr,
            "device_running": running,
            "clients": len(self._clients),
        }

    def _ensure_engine(self) -> Optional[SinAudioEngine]:
        if not is_native_engine_available():
            return None
        with self._lock:
            if self._engine is None:
                self._engine = SinAudioEngine(
                    sample_rate=self._requested_sr,
                    max_block_size=512,
                    offline_mode=False,
                )
            return self._engine

    def _ensure_device_started(self, eng: SinAudioEngine) -> bool:
        if eng.is_device_running():
            return True
        ok = eng.start_device()
        if not ok:
            logger.warning("[%s] Failed to start OS audio device via miniaudio", self.name)
        return ok

    def stop_and_release(self) -> None:
        self._cook_scheduler.cancel_all()
        self._tile_scheduler.clear_session()
        with self._lock:
            self._load_generation += 1
            if self._engine is not None:
                self._engine.set_transport(playing=False)
                self._engine.release_all_sources()
                self._engine.stop_device()
            self._active_plan = None
            self._last_node_model_payload = None
            self._active_peak_filepath = None
            self._active_base_pyramid = None
            self._active_peak_window = (0.0, 1.0, 0.0)
            self._preview_lru.clear()
            self._preview_slot_pool = list(range(90001, 90017))

    def shutdown(self) -> None:
        self._cook_scheduler.cancel_all()
        self._tile_scheduler.shutdown()
        with self._lock:
            self._load_generation += 1
            if self._engine is not None:
                self._engine.close()
                self._engine = None
            self._active_plan = None
            self._last_node_model_payload = None
            self._active_peak_filepath = None
            self._active_base_pyramid = None
            self._active_peak_window = (0.0, 1.0, 0.0)
            self._preview_lru.clear()
            self._preview_slot_pool = list(range(90001, 90017))

    def _allocate_preview_source_id(self, norm_path: str) -> int:
        if norm_path in self._preview_lru:
            self._preview_lru.move_to_end(norm_path)
            return self._preview_lru[norm_path]
        if self._preview_slot_pool:
            slot = self._preview_slot_pool.pop(0)
        else:
            _evicted_path, slot = self._preview_lru.popitem(last=False)
        self._preview_lru[norm_path] = slot
        return slot

    def preview_file(
        self,
        filepath: str,
        *,
        expected_gen: Optional[int] = None,
        play: bool = True,
        compute_peaks: bool = False,
        peak_columns: int = 512,
    ) -> Dict[str, Any]:
        """Load and immediately audition one local audio file via the already-compiled native libsin_dsp."""
        eng, sr = self._prepare_engine_sample_rate()
        if eng is None:
            return {"ok": False, "error": "Native libsin_dsp library unavailable"}

        path = Path(str(filepath or ""))
        if not path.is_file():
            return {"ok": False, "error": "Audio file not found on disk"}
        path_str = str(path.resolve())

        t0 = perf_counter()
        with self._lock:
            if expected_gen is not None and expected_gen != self._load_generation:
                return {"ok": False, "superseded": True}
            source_id = self._allocate_preview_source_id(path_str)
            plan = SinRenderPlan(
                sample_rate=sr,
                bpm=120.0,
                explicit_duration_sec=0.0,
                sources=[SourceSpec(source_id=source_id, filepath=path_str)],
                buses=[BusSpec(bus_id=1, parent_bus_id=0, node_key="preview", node_type="track", node_name=path.name)],
                clips=[ClipSpec(
                    clip_id=1,
                    source_id=source_id,
                    target_bus_id=1,
                    timeline_start_frame=0,
                    timeline_length_frames=0,
                    flags=SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_CROP_IN_PLACE,
                )],
                bus_id_map={"preview": 1},
                bus_key_map={1: "preview"},
            )
            ok = eng.load_plan(plan)
            if not ok:
                return {"ok": False, "error": "Failed to decode audio file in libsin_dsp"}
            self._active_plan = plan
            eng.set_transport(playing=bool(play), seek_sec=0.0, loop_enabled=False)
            tel = eng.read_telemetry(include_scope=False)

        master_peaks: list[float] = []
        dur_sec = float(tel["duration_sec"] or 0.0)
        if compute_peaks and 0.0 < dur_sec <= 120.0:
            master_peaks, _ = self._compute_plan_peaks(plan, sr, peak_columns)

        elapsed_ms = round((perf_counter() - t0) * 1000.0, 2)
        result: Dict[str, Any] = {
            "ok": True,
            "duration_sec": tel["duration_sec"],
            "sample_rate": tel["sample_rate"],
            "is_playing": tel["is_playing"],
            "playhead_sec": tel["playhead_sec"],
            "load_ms": elapsed_ms,
        }
        if compute_peaks:
            result["master_peaks"] = master_peaks
        return result

    def preview_item(
        self,
        item_id: int,
        *,
        expected_gen: Optional[int] = None,
        play: bool = True,
    ) -> Dict[str, Any]:
        if self._item_path_resolver is None:
            return {"ok": False, "error": "Item preview resolver is not configured"}
        resolved = self._item_path_resolver(int(item_id))
        if not resolved:
            return {"ok": False, "error": "Audio item not found or unavailable"}
        return self.preview_file(resolved, expected_gen=expected_gen, play=play)

    def _prepare_engine_sample_rate(self) -> Tuple[Optional[SinAudioEngine], int]:
        eng = self._ensure_engine()
        if eng is None:
            return None, self._requested_sr
        with self._lock:
            self._ensure_device_started(eng)
            return eng, eng.sample_rate

    def load_canonical_plan(
        self,
        graph: Dict[str, Any],
        *,
        project_id: Optional[int] = None,
        project_root: Optional[Path] = None,
        snapshot: Optional[Dict[str, Any]] = None,
        transient_overrides: Optional[Dict[str, Any]] = None,
        workspace: Optional[Dict[str, Any]] = None,
        solo_ids: Optional[list[str]] = None,
        expected_gen: Optional[int] = None,
    ) -> Dict[str, Any]:
        eng, sr = self._prepare_engine_sample_rate()
        if eng is None:
            return {"ok": False, "error": "Native libsin_dsp library unavailable"}

        t0 = perf_counter()
        resolved_root = project_root
        if resolved_root is None and project_id is not None and self._project_root_resolver is not None:
            resolved_root = self._project_root_resolver(project_id)

        # Pack completely OUTSIDE self._lock so telemetry, set_param, and HTTP never block!
        plan = pack_canonical_graph(
            base_graph=graph,
            snapshot=snapshot,
            transient_overrides=transient_overrides,
            project_root=resolved_root,
            sample_rate=sr,
            workspace=workspace,
            solo_ids=solo_ids,
        )

        with self._lock:
            if expected_gen is not None and expected_gen != self._load_generation:
                return {"ok": False, "superseded": True}
            ok = eng.load_plan(plan)
            if not ok:
                return {"ok": False, "error": "Failed to load plan into libsin_dsp"}
            self._active_plan = plan
            tel = eng.read_telemetry(include_scope=False)

        elapsed_ms = round((perf_counter() - t0) * 1000.0, 2)
        return {
            "ok": True,
            "duration_sec": tel["duration_sec"],
            "sample_rate": tel["sample_rate"],
            "bpm": plan.bpm,
            "bus_ids": list(plan.bus_id_map.keys()),
            "manifest": {"nodes": plan.manifest_nodes},
            "pack_ms": elapsed_ms,
        }

    def load_node_model_plan(
        self,
        model_payload: Dict[str, Any],
        *,
        compute_peaks: bool = True,
        peak_columns: int = 512,
        expected_gen: Optional[int] = None,
        allow_async_cook: bool = True,
        force_cook_node_ids: Optional[Set[str]] = None,
    ) -> Dict[str, Any]:
        """Pack & load a SIN AudioNodeModel synchronously (used by tests & direct callers).
        Packing runs outside `self._lock` so real-time telemetry and controls never block."""
        from ermes.py.schemas import AudioNodeModel

        eng, sr = self._prepare_engine_sample_rate()
        if eng is None:
            return {"ok": False, "error": "Native libsin_dsp library unavailable"}

        t0 = perf_counter()
        cur_playhead = 0.0
        try:
            cur_playhead = float(eng.read_telemetry(include_scope=False).get("playhead_sec") or 0.0)
        except Exception:
            cur_playhead = 0.0

        model = AudioNodeModel(**model_payload) if isinstance(model_payload, dict) else model_payload
        sys_obj = System(
            bpm=float(model.bpm or 120.0),
            sample_rate=sr,
            render_mode="preview",
            allow_async_cook=allow_async_cook,
            playhead_sec=cur_playhead,
            force_cook_node_ids=force_cook_node_ids,
        )

        # Heavy procedural packing + Tier-2 Rubber Band cooking happens OUTSIDE self._lock!
        plan = pack_audio_node_model(model, sys_obj)

        with self._lock:
            if expected_gen is not None and expected_gen != self._load_generation:
                return {"ok": False, "superseded": True}
            ok = eng.load_plan(plan)
            if not ok:
                return {"ok": False, "error": "Failed to load node model plan into libsin_dsp"}
            self._active_plan = plan
            if isinstance(model_payload, dict):
                self._last_node_model_payload = copy.deepcopy(model_payload)
            tel = eng.read_telemetry(include_scope=False)

        # Start tiled streaming cook session(s) for long tracks, OR legacy short-clip cooks
        has_tiled = bool(getattr(sys_obj, "pending_tiled_cooks", None))
        duration_sec = float(tel["duration_sec"] or 0.0)
        if has_tiled:
            tiled_spec = sys_obj.pending_tiled_cooks[0]
            # Sync exact decoded duration from C++ ma_decoder so crop_start aligns to 0.0ms even on VBR MP3s!
            try:
                src_info = eng.get_source_info(tiled_spec.source_id)
                if src_info and src_info.get("num_frames", 0) > 0 and src_info.get("sample_rate", 0) > 0:
                    ma_sr = int(src_info["sample_rate"])
                    ma_dur = float(src_info["num_frames"]) / float(ma_sr)
                    if ma_dur > 0.0:
                        tiled_spec.file_sample_rate = ma_sr
                        tiled_spec.duration_sec = ma_dur
                        tiled_spec.total_frames = min(
                            tiled_spec.total_frames,
                            max(1, int(round(ma_dur * tiled_spec.sample_rate))),
                        )
            except Exception:
                pass
            if duration_sec > 0.0:
                tiled_spec.timeline_duration_sec = duration_sec
            # Include all non-monitor node keys in bus_node_ids so IRIDE canvas nodes get waveforms too!
            all_bus_keys = list(tiled_spec.bus_node_ids)
            for k in plan.bus_id_map.keys():
                if k != "__monitor__" and k not in all_bus_keys:
                    all_bus_keys.append(k)
            tiled_spec.bus_node_ids = all_bus_keys
            self._active_peak_filepath = tiled_spec.base_filepath
            self._active_peak_window = (
                tiled_spec.crop_start_sec,
                max(0.05, float(tiled_spec.playback_rate or 1.0)),
                tiled_spec.active_timeline_sec,
            )
            self._tile_scheduler.start_session(tiled_spec, playhead_sec=cur_playhead)
            sys_obj.processor_statuses.update(self._tile_scheduler.get_all_statuses())
        else:
            self._tile_scheduler.clear_session()
            # Track primary file source for long-file (>60s) peak pyramid support even without RX nodes
            primary_fp = next((s.filepath for s in plan.sources if s.filepath), None)
            self._active_peak_filepath = primary_fp
            self._active_peak_window = (0.0, 1.0, duration_sec)

        for job in sys_obj.pending_cooks:
            self._cook_scheduler.schedule(job)

        master_peaks: list[float] = []
        bus_peaks: Dict[str, list[float]] = {}
        if compute_peaks and not has_tiled and 0.0 < duration_sec <= 60.0:
            master_peaks, bus_peaks = self._compute_plan_peaks(plan, sr, peak_columns)

        elapsed_ms = round((perf_counter() - t0) * 1000.0, 2)
        return {
            "ok": True,
            "duration_sec": duration_sec,
            "sample_rate": tel["sample_rate"],
            "bpm": plan.bpm,
            "bus_ids": list(plan.bus_id_map.keys()),
            "manifest": {"nodes": plan.manifest_nodes},
            "processor_statuses": dict(sys_obj.processor_statuses),
            "master_peaks": master_peaks,
            "bus_peaks": bus_peaks,
            "tiled": has_tiled,
            "has_peak_pyramid": bool(self._active_peak_filepath and (has_tiled or duration_sec > 60.0)),
            "pack_ms": elapsed_ms,
            "_plan": plan,
        }

    def _snapshot_active_plan_locked(self) -> Optional[SinRenderPlan]:
        plan = self._active_plan
        if plan is None:
            return None
        return SinRenderPlan(
            sample_rate=plan.sample_rate,
            bpm=plan.bpm,
            explicit_duration_sec=plan.explicit_duration_sec,
            sources=list(plan.sources),
            buses=[copy.copy(b) for b in plan.buses],
            clips=list(plan.clips),
            stages=[
                ChainStageSpec(
                    bus_id=st.bus_id,
                    stage_index=st.stage_index,
                    processor_type=st.processor_type,
                    enabled=st.enabled,
                    params=list(st.params),
                )
                for st in plan.stages
            ],
            bus_id_map=dict(plan.bus_id_map),
            bus_key_map=dict(plan.bus_key_map),
            manifest_nodes=plan.manifest_nodes,
            normalize=plan.normalize,
            target_peak_db=plan.target_peak_db,
        )

    def _compute_plan_peaks(
        self, plan: SinRenderPlan, sr: int, peak_columns: int = 512
    ) -> Tuple[list[float], Dict[str, list[float]]]:
        try:
            # Tap intermediate track/bus/sequence/arrangement/null/sample nodes (skipping transparent __monitor__)
            # in the same single C++ offline pass so IRIDE panels get DSP-accurate post-FX waveforms!
            tap_bus_ids = [
                b.bus_id
                for b in plan.buses
                if b.parent_bus_id != 0
                and b.node_key != "__monitor__"
                and b.node_type in ("track", "bus", "master", "sequence", "arrangement", "null", "sample", "preamp_denoise", "voice_isolator")
            ][:64]
            master_buf, tapped = render_plan_offline(
                plan, sample_rate=sr, bus_tap_ids=tap_bus_ids or None
            )
            master_peaks = (
                _fast_waveform_peaks(master_buf, columns=peak_columns)
                if master_buf.size > 0
                else []
            )
            bus_cols = min(256, max(64, int(peak_columns // 2)))
            grouped_buffers: Dict[str, list[np.ndarray]] = {}
            for bid, buf in tapped.items():
                if buf.size > 0:
                    key = plan.bus_key_map.get(bid, str(bid))
                    grouped_buffers.setdefault(key, []).append(buf)
            bus_peaks: Dict[str, list[float]] = {}
            for key, bufs in grouped_buffers.items():
                if len(bufs) == 1:
                    combined = bufs[0]
                else:
                    max_frames = max(int(b.shape[-1]) for b in bufs)
                    ch = max(int(b.shape[0]) if b.ndim > 1 else 1 for b in bufs)
                    combined = np.zeros((ch, max_frames), dtype=np.float32)
                    for b in bufs:
                        n = int(b.shape[-1])
                        if b.ndim == 1:
                            combined[:, :n] += b[None, :]
                        else:
                            combined[:b.shape[0], :n] += b
                bus_peaks[key] = _fast_waveform_peaks(combined, columns=bus_cols)
            return master_peaks, bus_peaks
        except Exception as exc:
            logger.debug("[%s] Master peak extraction skipped: %s", self.name, exc)
        return [], {}

    def _resolve_target_bus_ids_locked(self, node_id: str) -> list[int]:
        key = str(node_id)
        if self._active_plan is not None:
            matched = [int(b.bus_id) for b in self._active_plan.buses if b.node_key == key]
            if matched:
                return matched
        if self._engine is not None:
            bid = self._engine.bus_id_map.get(key)
            if bid is not None:
                return [int(bid)]
        try:
            return [int(node_id)]
        except (TypeError, ValueError):
            return []

    def set_param(self, node_id: str, param: str, value: float, ramp_ms: float = 5.0) -> bool:
        with self._lock:
            if self._engine is None:
                return False
            pid = PARAM_NAME_TO_ID.get(str(param or "").strip().lower())
            if pid is None:
                return False
            target_bids = self._resolve_target_bus_ids_locked(node_id)
            if not target_bids:
                return False
            fval = float(value)
            framp = float(ramp_ms)
            for bid in target_bids:
                self._engine.set_param(bid, pid, fval, framp)
            if self._active_plan is not None:
                bid_set = set(target_bids)
                for b in self._active_plan.buses:
                    if b.bus_id not in bid_set:
                        continue
                    if pid == SIN_PARAM_PRE_GAIN_DB:
                        b.pre_gain_db = fval
                    elif pid == SIN_PARAM_VOLUME:
                        b.volume = max(0.0, fval)
                    elif pid == SIN_PARAM_POST_GAIN_DB:
                        b.post_gain_db = fval
                    elif pid == SIN_PARAM_PAN:
                        b.pan = max(-1.0, min(1.0, fval))
                    elif pid == SIN_PARAM_MUTE:
                        b.muted = (fval >= 0.5)
                    elif pid == SIN_PARAM_SOLO:
                        b.solo = (fval >= 0.5)
                    elif pid == SIN_PARAM_CROP_START:
                        b.crop_start = max(0.0, min(b.crop_end, fval))
                        tl_dur = float(self._engine.read_telemetry(include_scope=False).get("duration_sec") or 0.0)
                        self._tile_scheduler.update_crop_window(
                            crop_start=b.crop_start,
                            timeline_duration_sec=tl_dur,
                        )
                        if self._tile_scheduler.active_session is not None:
                            s = self._tile_scheduler.active_session
                            self._active_peak_window = (s.crop_start_sec, max(0.05, float(s.playback_rate or 1.0)), s.active_timeline_sec)
                        elif self._active_base_pyramid is not None:
                            self._active_peak_window = (b.crop_start * self._active_base_pyramid.duration_sec, max(0.05, float(b.playback_rate or 1.0)), tl_dur or self._active_peak_window[2])
                    elif pid == SIN_PARAM_CROP_END:
                        b.crop_end = max(b.crop_start, min(1.0, fval))
                        tl_dur = float(self._engine.read_telemetry(include_scope=False).get("duration_sec") or 0.0)
                        self._tile_scheduler.update_crop_window(
                            crop_end=b.crop_end,
                            timeline_duration_sec=tl_dur,
                        )
                        if self._tile_scheduler.active_session is not None:
                            s = self._tile_scheduler.active_session
                            self._active_peak_window = (s.crop_start_sec, max(0.05, float(s.playback_rate or 1.0)), s.active_timeline_sec)
                    elif pid == SIN_PARAM_PLAYBACK_RATE:
                        b.playback_rate = max(0.05, fval)
                        tl_dur = float(self._engine.read_telemetry(include_scope=False).get("duration_sec") or 0.0)
                        self._tile_scheduler.update_crop_window(
                            playback_rate=b.playback_rate,
                            timeline_duration_sec=tl_dur,
                        )
                        if self._tile_scheduler.active_session is not None:
                            s = self._tile_scheduler.active_session
                            self._active_peak_window = (s.crop_start_sec, max(0.05, float(s.playback_rate or 1.0)), s.active_timeline_sec)
                        elif self._active_base_pyramid is not None:
                            self._active_peak_window = (self._active_peak_window[0], b.playback_rate, tl_dur or self._active_peak_window[2])
            return True

    def set_stage_param(
        self,
        node_id: str,
        stage_index: int,
        param_index: int,
        value: float,
        ramp_ms: float = 5.0,
    ) -> bool:
        with self._lock:
            if self._engine is None:
                return False
            target_bids = self._resolve_target_bus_ids_locked(node_id)
            if not target_bids:
                return False
            sidx = int(stage_index)
            pidx = int(param_index)
            fval = float(value)
            framp = float(ramp_ms)
            for bid in target_bids:
                self._engine.set_stage_param(bid, sidx, pidx, fval, framp)
            if self._active_plan is not None:
                bid_set = set(target_bids)
                for st in self._active_plan.stages:
                    if st.bus_id in bid_set and st.stage_index == sidx and 0 <= pidx < 32:
                        if pidx >= len(st.params):
                            st.params.extend([0.0] * (pidx + 1 - len(st.params)))
                        st.params[pidx] = fval
            return True

    def set_stage_enabled(self, node_id: str, stage_index: int, enabled: bool) -> bool:
        with self._lock:
            if self._engine is None:
                return False
            target_bids = self._resolve_target_bus_ids_locked(node_id)
            if not target_bids:
                return False
            sidx = int(stage_index)
            flag = bool(enabled)
            for bid in target_bids:
                self._engine.set_stage_enabled(bid, sidx, flag)
            if self._active_plan is not None:
                bid_set = set(target_bids)
                for st in self._active_plan.stages:
                    if st.bus_id in bid_set and st.stage_index == sidx:
                        st.enabled = flag
            return True

    def set_transport(
        self,
        *,
        playing: bool,
        seek_sec: float = -1.0,
        bpm: float = 0.0,
        loop_start_sec: float = 0.0,
        loop_end_sec: float = 0.0,
        loop: bool = False,
    ) -> Dict[str, Any]:
        eng = self._ensure_engine()
        if eng is None:
            return {"ok": False}
        with self._lock:
            if playing:
                self._ensure_device_started(eng)
            eng.set_transport(
                playing=bool(playing),
                seek_sec=float(seek_sec),
                bpm=float(bpm),
                loop_start_sec=float(loop_start_sec),
                loop_end_sec=float(loop_end_sec),
                loop_enabled=bool(loop),
            )
            return eng.read_telemetry(include_scope=self._include_scope)

    def set_audition(
        self,
        *,
        active: bool,
        node_id: Optional[str] = None,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
    ) -> Dict[str, Any]:
        eng = self._ensure_engine()
        if eng is None:
            return {"ok": False}
        with self._lock:
            if active:
                self._ensure_device_started(eng)
            bid = 0
            if node_id:
                bid = eng.bus_id_map.get(str(node_id), 0)
            eng.set_audition(
                active=bool(active),
                solo_bus_id=int(bid),
                start_sec=float(start_sec),
                end_sec=float(end_sec),
            )
            return eng.read_telemetry(include_scope=self._include_scope)

    def read_telemetry(self) -> Dict[str, Any]:
        # Grab reference under brief lock; C++ read_telemetry only reads atomics!
        eng = self._engine
        if eng is None:
            return {
                "playhead_sec": 0.0,
                "duration_sec": 0.0,
                "bpm": 120.0,
                "sample_rate": self._requested_sr,
                "is_playing": False,
                "loop_enabled": False,
                "audition_active": False,
                "master_peak_l": 0.0,
                "master_peak_r": 0.0,
                "master_rms_l": 0.0,
                "master_rms_r": 0.0,
                "bus_peaks": {},
                "bus_rms": {},
                "stage_meters": {},
            }
        return eng.read_telemetry(include_scope=self._include_scope)

    async def handle_websocket(self, websocket: WebSocket) -> None:
        await websocket.accept()
        send_lock = asyncio.Lock()

        async def _send_json(payload: Dict[str, Any]) -> None:
            try:
                async with send_lock:
                    await websocket.send_text(json.dumps(payload, separators=(",", ":")))
            except Exception:
                pass

        with self._lock:
            self._clients.add(websocket)
            self._client_senders[websocket] = _send_json

        await _send_json({"type": "hello", **self.status()})

        stop_telemetry = asyncio.Event()
        active_load_task: Optional[asyncio.Task] = None
        active_peaks_task: Optional[asyncio.Task] = None
        peaks_debounce_task: Optional[asyncio.Task] = None

        async def _claim_ownership() -> None:
            prev_send = None
            with self._lock:
                if self._owner_ws is not websocket:
                    prev_ws = self._owner_ws
                    self._owner_ws = websocket
                    if prev_ws is not None:
                        prev_send = self._client_senders.get(prev_ws)
            if prev_send is not None:
                tel_snapshot = dict(self.read_telemetry())
                tel_snapshot["is_playing"] = False
                await prev_send({"type": "telemetry", **tel_snapshot})

        async def _telemetry_loop() -> None:
            was_playing = False
            while not stop_telemetry.is_set():
                try:
                    await asyncio.sleep(1.0 / 30.0)
                    if self._owner_ws is not websocket:
                        was_playing = False
                        continue
                    tel = self.read_telemetry()
                    playing = bool(tel.get("is_playing"))
                    if playing:
                        self._tile_scheduler.update_playhead(
                            float(tel.get("playhead_sec") or 0.0),
                            is_playing=True,
                        )
                    elif was_playing:
                        self._tile_scheduler.update_playhead(
                            float(tel.get("playhead_sec") or 0.0),
                            is_playing=False,
                        )
                    if playing or was_playing:
                        await _send_json({"type": "telemetry", **tel})
                    was_playing = playing
                except asyncio.CancelledError:
                    break
                except Exception:
                    break

        telemetry_task = asyncio.create_task(_telemetry_loop())

        def _next_generation() -> int:
            with self._lock:
                self._load_generation += 1
                return self._load_generation

        def _schedule_param_peaks_recompute() -> None:
            nonlocal peaks_debounce_task, active_peaks_task
            if peaks_debounce_task and not peaks_debounce_task.done():
                peaks_debounce_task.cancel()
            if active_peaks_task and not active_peaks_task.done():
                active_peaks_task.cancel()
            with self._lock:
                gen = self._load_generation
                cols = self._last_peak_columns

            async def _debounced_peaks(expected_g: int = gen, peak_cols: int = cols) -> None:
                try:
                    await asyncio.sleep(0.06)
                    with self._lock:
                        if self._load_generation != expected_g:
                            return
                        plan_snap = self._snapshot_active_plan_locked()
                        sr = self._engine.sample_rate if self._engine is not None else self._requested_sr
                    if plan_snap is None:
                        return
                    dur_sec = float(self.read_telemetry().get("duration_sec") or 0.0)
                    if dur_sec <= 0.0:
                        return
                    sess = self._tile_scheduler.active_session
                    if sess is not None or dur_sec > 60.0:
                        # Fast pyramid / quick-overview refresh on live crop or rate edits (zero offline full-track render!)
                        ov = self._tile_scheduler.overlay
                        if sess is not None and ov is not None and ov.base_pyramid is None and self._active_peak_filepath:
                            src_s0 = sess.crop_start_sec
                            rate = max(0.05, float(sess.playback_rate or 1.0))
                            quick = await asyncio.to_thread(
                                GLOBAL_PEAK_PYRAMID_CACHE.scan_quick_overview,
                                self._active_peak_filepath,
                                src_s0,
                                src_s0 + dur_sec * rate,
                                peak_cols,
                            )
                            if quick is not None and self._load_generation == expected_g:
                                ov.set_quick_raw_peaks(quick[0])
                        vp = await asyncio.to_thread(self.query_viewport_peaks, 0.0, dur_sec, peak_cols)
                        if vp.get("ok") and vp.get("peaks") and self._load_generation == expected_g:
                            bus_keys = list(sess.bus_node_ids) if sess is not None else [
                                k for k in plan_snap.bus_id_map.keys() if k != "__monitor__"
                            ]
                            await _send_json({
                                "type": "master_peaks",
                                "duration_sec": dur_sec,
                                "master_peaks": vp["peaks"],
                                "bus_peaks": {k: vp["peaks"] for k in bus_keys},
                                "peak_tiers": vp.get("tiers"),
                                "has_peak_pyramid": True,
                                "coverage": vp.get("coverage"),
                            })
                        return
                    peaks, bus_peaks = await asyncio.to_thread(self._compute_plan_peaks, plan_snap, sr, peak_cols)
                    if (peaks or bus_peaks) and self._load_generation == expected_g:
                        await _send_json({
                            "type": "master_peaks",
                            "duration_sec": dur_sec,
                            "master_peaks": peaks,
                            "bus_peaks": bus_peaks,
                        })
                except asyncio.CancelledError:
                    return
                except Exception:
                    return

            peaks_debounce_task = asyncio.create_task(_debounced_peaks())

        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue

                mtype = str(msg.get("type") or "")
                req_id = msg.get("req_id")

                if mtype == "set_param":
                    node_key = str(msg.get("node_id") or "")
                    ok = self.set_param(
                        node_id=node_key,
                        param=str(msg.get("param") or ""),
                        value=float(msg.get("value", 0.0)),
                        ramp_ms=float(msg.get("ramp_ms", 5.0)),
                    )
                    if ok and node_key != "__monitor__" and self._active_plan is not None:
                        _schedule_param_peaks_recompute()
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_stage_param":
                    node_key = str(msg.get("node_id") or "")
                    ok = self.set_stage_param(
                        node_id=node_key,
                        stage_index=int(msg.get("stage_index", 0)),
                        param_index=int(msg.get("param_index", 0)),
                        value=float(msg.get("value", 0.0)),
                        ramp_ms=float(msg.get("ramp_ms", 5.0)),
                    )
                    if ok and node_key != "__monitor__" and self._active_plan is not None:
                        _schedule_param_peaks_recompute()
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_stage_enabled":
                    node_key = str(msg.get("node_id") or "")
                    ok = self.set_stage_enabled(
                        node_id=node_key,
                        stage_index=int(msg.get("stage_index", 0)),
                        enabled=bool(msg.get("enabled", True)),
                    )
                    if ok and node_key != "__monitor__" and self._active_plan is not None:
                        _schedule_param_peaks_recompute()
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_transport":
                    playing_req = bool(msg.get("playing", False))
                    seek_req = float(msg.get("seek_sec", -1.0))
                    if playing_req or seek_req >= 0.0:
                        await _claim_ownership()
                    target_sec = seek_req if seek_req >= 0.0 else float(self.read_telemetry().get("playhead_sec") or 0.0)
                    self._tile_scheduler.update_playhead(target_sec, is_playing=playing_req)
                    # Optional DAW 'Wait for FX' preroll before transport starts on an uncooked playhead tile
                    if playing_req and self._wait_for_fx and self._tile_scheduler.active_session is not None:
                        await asyncio.to_thread(self._tile_scheduler.wait_for_playhead_tile, target_sec, 2.5)
                    tel = self.set_transport(
                        playing=playing_req,
                        seek_sec=seek_req,
                        bpm=float(msg.get("bpm", 0.0)),
                        loop_start_sec=float(msg.get("loop_start_sec", 0.0)),
                        loop_end_sec=float(msg.get("loop_end_sec", 0.0)),
                        loop=bool(msg.get("loop", False)),
                    )
                    await _send_json({"type": "telemetry", **tel})
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": True})

                elif mtype == "set_audition":
                    if bool(msg.get("active", False)):
                        await _claim_ownership()
                    tel = self.set_audition(
                        active=bool(msg.get("active", False)),
                        node_id=msg.get("node_id"),
                        start_sec=float(msg.get("start_sec", 0.0)),
                        end_sec=float(msg.get("end_sec", 0.0)),
                    )
                    await _send_json({"type": "telemetry", **tel})
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": True})

                elif mtype == "load_canonical":
                    await _claim_ownership()
                    gen = _next_generation()
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()
                    if peaks_debounce_task and not peaks_debounce_task.done():
                        peaks_debounce_task.cancel()

                    async def _run_canonical(m=msg, rid=req_id, g=gen) -> None:
                        result = await asyncio.to_thread(
                            self.load_canonical_plan,
                            m.get("graph") or {},
                            project_id=m.get("project_id"),
                            snapshot=m.get("snapshot"),
                            transient_overrides=m.get("transient_overrides"),
                            workspace=m.get("workspace"),
                            solo_ids=m.get("solo_ids"),
                            expected_gen=g,
                        )
                        if not result.get("superseded"):
                            await _send_json({"type": "plan_loaded", "req_id": rid, **result})

                    active_load_task = asyncio.create_task(_run_canonical())

                elif mtype == "load_node_model":
                    self._ws_loop = asyncio.get_running_loop()
                    await _claim_ownership()
                    gen = _next_generation()
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()
                    if active_peaks_task and not active_peaks_task.done():
                        active_peaks_task.cancel()
                    if peaks_debounce_task and not peaks_debounce_task.done():
                        peaks_debounce_task.cancel()
                    self._last_peak_columns = int(msg.get("peak_columns", 512))

                    async def _run_node_model(m=msg, rid=req_id, g=gen) -> None:
                        nonlocal active_peaks_task
                        # 1. Pack & hot-swap live plan WITHOUT waiting for waveform peaks!
                        result = await asyncio.to_thread(
                            self.load_node_model_plan,
                            m.get("model") or {},
                            compute_peaks=False,
                            expected_gen=g,
                        )
                        if result.get("superseded"):
                            return
                        plan_obj = result.pop("_plan", None)
                        await _send_json({"type": "plan_loaded", "req_id": rid, **result})

                        # 2. Compute master peaks asynchronously in background so audio & UI stay 100% fluid
                        want_peaks = bool(m.get("compute_peaks", True))
                        dur_sec = float(result.get("duration_sec") or 0.0)
                        sr = int(result.get("sample_rate") or self._requested_sr)
                        cols = int(m.get("peak_columns", 512))
                        is_tiled = bool(result.get("tiled", False))
                        peak_fp = self._active_peak_filepath

                        if result.get("ok") and want_peaks and plan_obj is not None and dur_sec > 0.0:
                            if not is_tiled and dur_sec <= 60.0:
                                async def _run_peaks(p=plan_obj, p_sr=sr, p_cols=cols, p_dur=dur_sec, p_g=g) -> None:
                                    peaks, bus_peaks = await asyncio.to_thread(self._compute_plan_peaks, p, p_sr, p_cols)
                                    if (peaks or bus_peaks) and self._load_generation == p_g:
                                        await _send_json({
                                            "type": "master_peaks",
                                            "duration_sec": p_dur,
                                            "master_peaks": peaks,
                                            "bus_peaks": bus_peaks,
                                        })

                                active_peaks_task = asyncio.create_task(_run_peaks())
                            elif peak_fp:
                                # Long track (>60s) or tiled RX track:
                                # Stage 1 (<90-350ms): Instant overview peaks across active cropped span + bus_peaks for IRIDE nodes!
                                # Stage 2 (background): Full sequential multi-res pyramid cached to disk for crisp zooming.
                                async def _run_pyramid_peaks(fp=peak_fp, p=plan_obj, p_cols=cols, p_dur=dur_sec, p_g=g) -> None:
                                    sess = self._tile_scheduler.active_session
                                    if sess is not None:
                                        src_s0 = sess.crop_start_sec
                                        rate = max(0.05, float(sess.playback_rate or 1.0))
                                        src_s1 = src_s0 + p_dur * rate
                                        bus_keys = list(sess.bus_node_ids)
                                    else:
                                        # Respect primary clip crop_start/playback_rate even without RX nodes
                                        clip0 = p.clips[0] if p.clips else None
                                        bus0 = next((b for b in p.buses if clip0 and b.bus_id == clip0.target_bus_id), None)
                                        cs = float(bus0.crop_start if bus0 else (clip0.source_start_ratio if clip0 else 0.0))
                                        rate = max(0.05, float(bus0.playback_rate if bus0 else 1.0))
                                        src_s0 = 0.0
                                        src_s1 = p_dur * rate
                                        if cs > 0.0:
                                            f_dur = 0.0
                                            try:
                                                if clip0 is not None and self._engine is not None:
                                                    si = self._engine.get_source_info(clip0.source_id)
                                                    if si and si.get("num_frames", 0) > 0 and si.get("sample_rate", 0) > 0:
                                                        f_dur = float(si["num_frames"]) / float(si["sample_rate"])
                                            except Exception:
                                                f_dur = 0.0
                                            if f_dur <= 0.0:
                                                try:
                                                    import soundfile as _sf
                                                    f_dur = float(_sf.info(fp).duration or 0.0)
                                                except Exception:
                                                    f_dur = 0.0
                                            if f_dur > 0.0:
                                                src_s0 = cs * f_dur
                                                src_s1 = min(f_dur, src_s0 + p_dur * rate)
                                        self._active_peak_window = (src_s0, rate, p_dur)
                                        bus_keys = [k for k in p.bus_id_map.keys() if k != "__monitor__"]

                                    sample_bus_keys = {
                                        b.node_key for b in p.buses if str(b.node_type or "").lower() == "sample"
                                    }

                                    # Stage 1: Fast overview scan (<90-350ms)
                                    quick = await asyncio.to_thread(
                                        GLOBAL_PEAK_PYRAMID_CACHE.scan_quick_overview,
                                        fp,
                                        src_s0,
                                        src_s1,
                                        p_cols,
                                    )
                                    if self._load_generation != p_g:
                                        return
                                    if quick is not None:
                                        q_peaks, _ = quick
                                        ov = self._tile_scheduler.overlay
                                        if ov is not None:
                                            ov.set_quick_raw_peaks(q_peaks)
                                            vp = self.query_viewport_peaks(0.0, p_dur, p_cols)
                                            out_peaks = vp["peaks"] if vp.get("ok") else q_peaks
                                            out_tiers = vp["tiers"] if vp.get("ok") else [TIER_RAW] * (len(out_peaks) // 2)
                                            out_cov = vp.get("coverage")
                                        else:
                                            out_peaks = q_peaks
                                            out_tiers = [TIER_RAW] * (len(q_peaks) // 2)
                                            out_cov = None
                                        # Keep Sample nodes showing dry input peaks while processor/master nodes show post-FX peaks!
                                        b_peaks = {
                                            k: (q_peaks if k in sample_bus_keys else out_peaks)
                                            for k in bus_keys
                                        }
                                        await _send_json({
                                            "type": "master_peaks",
                                            "duration_sec": p_dur,
                                            "master_peaks": out_peaks,
                                            "bus_peaks": b_peaks,
                                            "peak_tiers": out_tiers,
                                            "has_peak_pyramid": True,
                                            "coverage": out_cov,
                                        })

                                    # Stage 2: Build/load full sequential multi-res pyramid in background for razor-sharp zoom
                                    pyr = await asyncio.to_thread(GLOBAL_PEAK_PYRAMID_CACHE.get_or_build, fp)
                                    if pyr is None or self._load_generation != p_g:
                                        return
                                    self._active_base_pyramid = pyr
                                    self._tile_scheduler.attach_base_pyramid(pyr)
                                    vp2 = self.query_viewport_peaks(0.0, p_dur, p_cols)
                                    if vp2.get("ok") and self._load_generation == p_g:
                                        raw_pyr_peaks = pyr.query(src_s0, src_s1, p_cols) if sample_bus_keys else None
                                        b_peaks2 = {
                                            k: (raw_pyr_peaks if (k in sample_bus_keys and raw_pyr_peaks) else vp2["peaks"])
                                            for k in bus_keys
                                        }
                                        await _send_json({
                                            "type": "master_peaks",
                                            "duration_sec": p_dur,
                                            "master_peaks": vp2["peaks"],
                                            "bus_peaks": b_peaks2,
                                            "peak_tiers": vp2["tiers"],
                                            "has_peak_pyramid": True,
                                            "coverage": vp2.get("coverage"),
                                        })

                                active_peaks_task = asyncio.create_task(_run_pyramid_peaks())

                    active_load_task = asyncio.create_task(_run_node_model())

                elif mtype == "preview_item":
                    await _claim_ownership()
                    gen = _next_generation()
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()

                    async def _run_preview_item(m=msg, rid=req_id, g=gen) -> None:
                        item_id_val = m.get("item_id")
                        if item_id_val is None:
                            await _send_json({"type": "preview_loaded", "req_id": rid, "ok": False, "error": "Missing item_id"})
                            return
                        result = await asyncio.to_thread(
                            self.preview_item,
                            int(item_id_val),
                            expected_gen=g,
                            play=bool(m.get("play", True)),
                        )
                        if not result.get("superseded"):
                            await _send_json({"type": "preview_loaded", "req_id": rid, **result})

                    active_load_task = asyncio.create_task(_run_preview_item())

                elif mtype == "preview_file":
                    await _claim_ownership()
                    gen = _next_generation()
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()

                    async def _run_preview_file(m=msg, rid=req_id, g=gen) -> None:
                        result = await asyncio.to_thread(
                            self.preview_file,
                            str(m.get("filepath") or ""),
                            expected_gen=g,
                            play=bool(m.get("play", True)),
                            compute_peaks=bool(m.get("compute_peaks", False)),
                            peak_columns=int(m.get("peak_columns", 512)),
                        )
                        if not result.get("superseded"):
                            await _send_json({"type": "preview_loaded", "req_id": rid, **result})

                    active_load_task = asyncio.create_task(_run_preview_file())

                elif mtype == "stop_and_release":
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()
                    if active_peaks_task and not active_peaks_task.done():
                        active_peaks_task.cancel()
                    if peaks_debounce_task and not peaks_debounce_task.done():
                        peaks_debounce_task.cancel()
                    await asyncio.to_thread(self.stop_and_release)
                    tel = self.read_telemetry()
                    await _send_json({"type": "telemetry", **tel})
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": True})

                elif mtype == "cook_node":
                    await _claim_ownership()
                    target_nid = str(msg.get("node_id") or "")
                    if target_nid and self._tile_scheduler.has_node(target_nid):
                        ok = self._tile_scheduler.request_manual_cook(target_nid)
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok, "tiled": True})
                        continue
                    model_data = msg.get("model") or self._last_node_model_payload
                    if not target_nid or not model_data:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": False})
                    else:
                        gen = _next_generation()

                        async def _run_forced_cook(m_payload=model_data, nid=target_nid, rid=req_id, g=gen) -> None:
                            self._ws_loop = asyncio.get_running_loop()
                            res = await asyncio.to_thread(
                                self.load_node_model_plan,
                                m_payload,
                                compute_peaks=False,
                                expected_gen=g,
                                allow_async_cook=True,
                                force_cook_node_ids={nid},
                            )
                            if not res.get("superseded"):
                                res.pop("_plan", None)
                                await _send_json({"type": "plan_loaded", "req_id": rid, **res})

                        active_load_task = asyncio.create_task(_run_forced_cook())

                elif mtype == "cook_full_track":
                    target_nid = str(msg.get("node_id") or "")
                    enable = bool(msg.get("enable", True))
                    ok = self._tile_scheduler.request_cook_full_track(target_nid, enable=enable) if target_nid else False
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "update_processor_param":
                    target_nid = str(msg.get("node_id") or "")
                    key = str(msg.get("key") or "")
                    value = msg.get("value")
                    commit = bool(msg.get("commit", True))
                    res = self._tile_scheduler.update_param(target_nid, key, value, commit=commit) if target_nid and key else None
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": bool(res and res.get("ok")), **(res or {})})

                elif mtype == "query_peaks":
                    s_sec = float(msg.get("start_sec", 0.0))
                    e_sec = float(msg.get("end_sec", 0.0))
                    cols = int(msg.get("columns", 512))
                    vp = await asyncio.to_thread(self.query_viewport_peaks, s_sec, e_sec, cols)
                    await _send_json({"type": "peaks_viewport", "req_id": req_id, **vp})

                elif mtype == "set_engine_settings":
                    updated = await asyncio.to_thread(self.update_engine_settings, msg.get("settings") or msg)
                    await _send_json({"type": "engine_settings", "req_id": req_id, "ok": True, **updated})

                elif mtype == "get_engine_settings":
                    cur_settings = await asyncio.to_thread(self.get_engine_settings)
                    await _send_json({"type": "engine_settings", "req_id": req_id, "ok": True, **cur_settings})

                elif mtype == "cancel_cook":
                    target_nid = str(msg.get("node_id") or "")
                    cancelled = False
                    if target_nid:
                        cancelled = self._tile_scheduler.cancel_node(target_nid) or self._cook_scheduler.cancel_node(target_nid)
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": True, "cancelled": cancelled})

                elif mtype == "ping":
                    await _send_json({"type": "pong", "req_id": req_id})

        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.debug("[%s] WebSocket error: %s", self.name, exc)
        finally:
            stop_telemetry.set()
            telemetry_task.cancel()
            if active_load_task and not active_load_task.done():
                active_load_task.cancel()
            if active_peaks_task and not active_peaks_task.done():
                active_peaks_task.cancel()
            if peaks_debounce_task and not peaks_debounce_task.done():
                peaks_debounce_task.cancel()
            try:
                await telemetry_task
            except Exception:
                pass
            was_owner = False
            no_clients_left = False
            with self._lock:
                self._clients.discard(websocket)
                self._client_senders.pop(websocket, None)
                if self._owner_ws is websocket:
                    self._owner_ws = None
                    was_owner = True
                no_clients_left = (len(self._clients) == 0)
            if no_clients_left:
                await asyncio.to_thread(self.stop_and_release)
            elif was_owner:
                await asyncio.to_thread(self.set_transport, playing=False)
