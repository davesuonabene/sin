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
import json
import logging
import threading
from pathlib import Path
from time import perf_counter
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Tuple
import numpy as np

from fastapi import WebSocket, WebSocketDisconnect

from core.audio_engine import SinAudioEngine, is_native_engine_available, render_plan_offline
from core.plan_packer import pack_audio_node_model, pack_canonical_graph
from core.render_plan import (
    BusSpec,
    ClipSpec,
    PARAM_NAME_TO_ID,
    SIN_CLIP_CROP_IN_PLACE,
    SIN_CLIP_LIVE_CROP_BOUND,
    SIN_DEFAULT_SAMPLE_RATE,
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
        # 16-slot LRU of preview source IDs (90001..90016) so re-auditioning recent samples is 0ms RAM hit
        self._preview_lru: OrderedDict[str, int] = OrderedDict()
        self._preview_slot_pool: list[int] = list(range(90001, 90017))

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
        with self._lock:
            self._load_generation += 1
            if self._engine is not None:
                self._engine.set_transport(playing=False)
                self._engine.release_all_sources()
                self._engine.stop_device()
            self._active_plan = None
            self._preview_lru.clear()
            self._preview_slot_pool = list(range(90001, 90017))

    def shutdown(self) -> None:
        with self._lock:
            self._load_generation += 1
            if self._engine is not None:
                self._engine.close()
                self._engine = None
            self._active_plan = None
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
    ) -> Dict[str, Any]:
        """Pack & load a SIN AudioNodeModel synchronously (used by tests & direct callers).
        Packing runs outside `self._lock` so real-time telemetry and controls never block."""
        from ermes.py.schemas import AudioNodeModel

        eng, sr = self._prepare_engine_sample_rate()
        if eng is None:
            return {"ok": False, "error": "Native libsin_dsp library unavailable"}

        t0 = perf_counter()
        model = AudioNodeModel(**model_payload) if isinstance(model_payload, dict) else model_payload
        sys_obj = System(bpm=float(model.bpm or 120.0), sample_rate=sr, render_mode="preview")

        # Heavy procedural packing + Tier-2 Rubber Band cooking happens OUTSIDE self._lock!
        plan = pack_audio_node_model(model, sys_obj)

        with self._lock:
            if expected_gen is not None and expected_gen != self._load_generation:
                return {"ok": False, "superseded": True}
            ok = eng.load_plan(plan)
            if not ok:
                return {"ok": False, "error": "Failed to load node model plan into libsin_dsp"}
            self._active_plan = plan
            tel = eng.read_telemetry(include_scope=False)

        duration_sec = float(tel["duration_sec"] or 0.0)
        master_peaks: list[float] = []
        bus_peaks: Dict[str, list[float]] = {}
        if compute_peaks and 0.0 < duration_sec <= 60.0:
            master_peaks, bus_peaks = self._compute_plan_peaks(plan, sr, peak_columns)

        elapsed_ms = round((perf_counter() - t0) * 1000.0, 2)
        return {
            "ok": True,
            "duration_sec": duration_sec,
            "sample_rate": tel["sample_rate"],
            "bpm": plan.bpm,
            "bus_ids": list(plan.bus_id_map.keys()),
            "manifest": {"nodes": plan.manifest_nodes},
            "master_peaks": master_peaks,
            "bus_peaks": bus_peaks,
            "pack_ms": elapsed_ms,
            "_plan": plan,
        }

    def _compute_plan_peaks(
        self, plan: SinRenderPlan, sr: int, peak_columns: int = 512
    ) -> Tuple[list[float], Dict[str, list[float]]]:
        try:
            # Tap intermediate track/bus/sequence/arrangement nodes (skipping transparent __monitor__)
            # in the same single C++ offline pass so IRIDE panels get DSP-accurate waveforms!
            tap_bus_ids = [
                b.bus_id
                for b in plan.buses
                if b.parent_bus_id != 0
                and b.node_key != "__monitor__"
                and b.node_type in ("track", "bus", "master", "sequence", "arrangement")
            ][:32]
            master_buf, tapped = render_plan_offline(
                plan, sample_rate=sr, bus_tap_ids=tap_bus_ids or None
            )
            master_peaks = (
                _fast_waveform_peaks(master_buf, columns=peak_columns)
                if master_buf.size > 0
                else []
            )
            bus_cols = min(256, max(64, int(peak_columns // 2)))
            bus_peaks: Dict[str, list[float]] = {}
            for bid, buf in tapped.items():
                if buf.size > 0:
                    key = plan.bus_key_map.get(bid, str(bid))
                    bus_peaks[key] = _fast_waveform_peaks(buf, columns=bus_cols)
            return master_peaks, bus_peaks
        except Exception as exc:
            logger.debug("[%s] Master peak extraction skipped: %s", self.name, exc)
        return [], {}

    def set_param(self, node_id: str, param: str, value: float, ramp_ms: float = 5.0) -> bool:
        with self._lock:
            if self._engine is None:
                return False
            pid = PARAM_NAME_TO_ID.get(str(param or "").strip().lower())
            if pid is None:
                return False
            bid = self._engine.bus_id_map.get(str(node_id))
            if bid is None:
                try:
                    bid = int(node_id)
                except (TypeError, ValueError):
                    return False
            self._engine.set_param(bid, pid, float(value), float(ramp_ms))
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
            bid = self._engine.bus_id_map.get(str(node_id))
            if bid is None:
                try:
                    bid = int(node_id)
                except (TypeError, ValueError):
                    return False
            self._engine.set_stage_param(bid, int(stage_index), int(param_index), float(value), float(ramp_ms))
            return True

    def set_stage_enabled(self, node_id: str, stage_index: int, enabled: bool) -> bool:
        with self._lock:
            if self._engine is None:
                return False
            bid = self._engine.bus_id_map.get(str(node_id))
            if bid is None:
                try:
                    bid = int(node_id)
                except (TypeError, ValueError):
                    return False
            self._engine.set_stage_enabled(bid, int(stage_index), bool(enabled))
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
                    ok = self.set_param(
                        node_id=str(msg.get("node_id") or ""),
                        param=str(msg.get("param") or ""),
                        value=float(msg.get("value", 0.0)),
                        ramp_ms=float(msg.get("ramp_ms", 5.0)),
                    )
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_stage_param":
                    ok = self.set_stage_param(
                        node_id=str(msg.get("node_id") or ""),
                        stage_index=int(msg.get("stage_index", 0)),
                        param_index=int(msg.get("param_index", 0)),
                        value=float(msg.get("value", 0.0)),
                        ramp_ms=float(msg.get("ramp_ms", 5.0)),
                    )
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_stage_enabled":
                    ok = self.set_stage_enabled(
                        node_id=str(msg.get("node_id") or ""),
                        stage_index=int(msg.get("stage_index", 0)),
                        enabled=bool(msg.get("enabled", True)),
                    )
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": ok})

                elif mtype == "set_transport":
                    playing_req = bool(msg.get("playing", False))
                    seek_req = float(msg.get("seek_sec", -1.0))
                    if playing_req or seek_req >= 0.0:
                        await _claim_ownership()
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
                    await _claim_ownership()
                    gen = _next_generation()
                    if active_load_task and not active_load_task.done():
                        active_load_task.cancel()
                    if active_peaks_task and not active_peaks_task.done():
                        active_peaks_task.cancel()

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
                        if result.get("ok") and want_peaks and plan_obj is not None and 0.0 < dur_sec <= 60.0:
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
                    await asyncio.to_thread(self.stop_and_release)
                    tel = self.read_telemetry()
                    await _send_json({"type": "telemetry", **tel})
                    if req_id is not None:
                        await _send_json({"type": "ack", "req_id": req_id, "ok": True})

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
