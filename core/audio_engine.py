"""In-process ctypes bridge to the native C++20 libsin_dsp shared library.

Loads engine/bin/sin_dsp.dll (Windows), engine/bin/libsin_dsp.dylib (macOS),
or engine/bin/libsin_dsp.so (Linux) directly in-process with zero extra ports,
zero subprocesses, and zero-copy float32 NumPy interop.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
import numpy as np

from core.render_plan import (
    SIN_DEFAULT_SAMPLE_RATE,
    SIN_MAX_PROC_PARAMS,
    BusSpec,
    ChainStageSpec,
    ClipSpec,
    SinRenderPlan,
    SourceSpec,
)

logger = logging.getLogger("sin.audio_engine")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENGINE_BIN_DIR = PROJECT_ROOT / "engine" / "bin"


# --- C99 ABI ctypes Structure Definitions (exact match with engine/include/sin_dsp.h) ---

class _SinEngineConfig(ctypes.Structure):
    _fields_ = [
        ("sample_rate", ctypes.c_uint32),
        ("max_block_size", ctypes.c_uint32),
        ("offline_mode", ctypes.c_uint32),
    ]


class _SinBusDesc(ctypes.Structure):
    _fields_ = [
        ("bus_id", ctypes.c_uint32),
        ("parent_bus_id", ctypes.c_uint32),
        ("pre_gain_db", ctypes.c_float),
        ("volume", ctypes.c_float),
        ("post_gain_db", ctypes.c_float),
        ("pan", ctypes.c_float),
        ("crop_start", ctypes.c_float),
        ("crop_end", ctypes.c_float),
        ("playback_rate", ctypes.c_float),
        ("muted", ctypes.c_uint8),
        ("solo", ctypes.c_uint8),
        ("_pad", ctypes.c_uint8 * 2),
    ]


class _SinClipDesc(ctypes.Structure):
    _fields_ = [
        ("clip_id", ctypes.c_uint32),
        ("source_id", ctypes.c_uint32),
        ("target_bus_id", ctypes.c_uint32),
        ("timeline_start_frame", ctypes.c_int64),
        ("timeline_length_frames", ctypes.c_int64),
        ("source_start_ratio", ctypes.c_double),
        ("source_end_ratio", ctypes.c_double),
        ("gain", ctypes.c_float),
        ("playback_rate", ctypes.c_float),
        ("fade_in_frames", ctypes.c_uint32),
        ("fade_out_frames", ctypes.c_uint32),
        ("release_frames", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
    ]


class _SinChainStageDesc(ctypes.Structure):
    _fields_ = [
        ("bus_id", ctypes.c_uint32),
        ("stage_index", ctypes.c_uint32),
        ("processor_type", ctypes.c_uint32),
        ("enabled", ctypes.c_uint32),
        ("num_params", ctypes.c_uint32),
        ("params", ctypes.c_float * SIN_MAX_PROC_PARAMS),
    ]


class _SinTelemetry(ctypes.Structure):
    _fields_ = [
        ("playhead_seconds", ctypes.c_double),
        ("duration_seconds", ctypes.c_double),
        ("bpm", ctypes.c_double),
        ("sample_rate", ctypes.c_uint32),
        ("is_playing", ctypes.c_uint32),
        ("loop_enabled", ctypes.c_uint32),
        ("audition_active", ctypes.c_uint32),
        ("active_bus_count", ctypes.c_uint32),
        ("master_peak_l", ctypes.c_float),
        ("master_peak_r", ctypes.c_float),
        ("master_rms_l", ctypes.c_float),
        ("master_rms_r", ctypes.c_float),
    ]


class _SinBusPeak(ctypes.Structure):
    _fields_ = [
        ("bus_id", ctypes.c_uint32),
        ("peak", ctypes.c_float),
    ]


class _SinSourceInfo(ctypes.Structure):
    _fields_ = [
        ("sample_rate", ctypes.c_uint32),
        ("channels", ctypes.c_uint32),
        ("num_frames", ctypes.c_uint64),
        ("is_streaming", ctypes.c_uint8),
        ("_pad", ctypes.c_uint8 * 7),
    ]


_LIB_CACHE: Optional[ctypes.CDLL] = None
_LIB_LOAD_ATTEMPTED: bool = False


def find_native_library_path() -> Optional[Path]:
    env_path = os.environ.get("SIN_DSP_LIBRARY")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p

    if sys.platform.startswith("win"):
        names = ["sin_dsp.dll"]
    elif sys.platform == "darwin":
        names = ["libsin_dsp.dylib", "sin_dsp.dylib"]
    else:
        names = ["libsin_dsp.so", "sin_dsp.so"]

    for name in names:
        cand = ENGINE_BIN_DIR / name
        if cand.is_file():
            return cand
    return None


def _bind_functions(lib: ctypes.CDLL) -> None:
    c_void_p = ctypes.c_void_p
    c_f_p = ctypes.POINTER(ctypes.c_float)

    lib.sin_engine_create.argtypes = [ctypes.POINTER(_SinEngineConfig)]
    lib.sin_engine_create.restype = c_void_p

    lib.sin_engine_destroy.argtypes = [c_void_p]
    lib.sin_engine_destroy.restype = None

    lib.sin_engine_reset.argtypes = [c_void_p]
    lib.sin_engine_reset.restype = None

    lib.sin_engine_start_device.argtypes = [c_void_p]
    lib.sin_engine_start_device.restype = ctypes.c_int32

    lib.sin_engine_stop_device.argtypes = [c_void_p]
    lib.sin_engine_stop_device.restype = None

    lib.sin_engine_is_device_running.argtypes = [c_void_p]
    lib.sin_engine_is_device_running.restype = ctypes.c_int32

    lib.sin_engine_get_sample_rate.argtypes = [c_void_p]
    lib.sin_engine_get_sample_rate.restype = ctypes.c_uint32

    lib.sin_engine_register_file_source.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32]
    lib.sin_engine_register_file_source.restype = ctypes.c_int32

    lib.sin_engine_register_pcm_source.argtypes = [
        c_void_p, ctypes.c_uint32, c_f_p, c_f_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint64
    ]
    lib.sin_engine_register_pcm_source.restype = ctypes.c_int32

    lib.sin_engine_get_source_info.argtypes = [c_void_p, ctypes.c_uint32, ctypes.POINTER(_SinSourceInfo)]
    lib.sin_engine_get_source_info.restype = ctypes.c_int32

    lib.sin_engine_release_source.argtypes = [c_void_p, ctypes.c_uint32]
    lib.sin_engine_release_source.restype = ctypes.c_int32

    lib.sin_engine_release_all_sources.argtypes = [c_void_p]
    lib.sin_engine_release_all_sources.restype = None

    lib.sin_engine_load_plan.argtypes = [
        c_void_p,
        ctypes.POINTER(_SinBusDesc), ctypes.c_uint32,
        ctypes.POINTER(_SinClipDesc), ctypes.c_uint32,
        ctypes.c_double, ctypes.c_double,
    ]
    lib.sin_engine_load_plan.restype = ctypes.c_int32

    lib.sin_engine_load_plan_with_chains.argtypes = [
        c_void_p,
        ctypes.POINTER(_SinBusDesc), ctypes.c_uint32,
        ctypes.POINTER(_SinClipDesc), ctypes.c_uint32,
        ctypes.POINTER(_SinChainStageDesc), ctypes.c_uint32,
        ctypes.c_double, ctypes.c_double,
    ]
    lib.sin_engine_load_plan_with_chains.restype = ctypes.c_int32

    lib.sin_engine_set_param.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_uint16, ctypes.c_float, ctypes.c_float]
    lib.sin_engine_set_param.restype = None

    lib.sin_engine_set_stage_param.argtypes = [
        c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_float, ctypes.c_float
    ]
    lib.sin_engine_set_stage_param.restype = None

    lib.sin_engine_set_stage_enabled.argtypes = [
        c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32
    ]
    lib.sin_engine_set_stage_enabled.restype = None

    lib.sin_engine_set_transport.argtypes = [
        c_void_p, ctypes.c_uint32, ctypes.c_double, ctypes.c_double,
        ctypes.c_double, ctypes.c_double, ctypes.c_uint32,
    ]
    lib.sin_engine_set_transport.restype = None

    lib.sin_engine_set_audition.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_double, ctypes.c_double]
    lib.sin_engine_set_audition.restype = None

    lib.sin_engine_process.argtypes = [c_void_p, c_f_p, c_f_p, ctypes.c_uint32]
    lib.sin_engine_process.restype = None

    lib.sin_engine_set_bus_tap.argtypes = [c_void_p, ctypes.c_uint32, c_f_p, c_f_p, ctypes.c_uint32]
    lib.sin_engine_set_bus_tap.restype = ctypes.c_int32

    lib.sin_engine_clear_bus_taps.argtypes = [c_void_p]
    lib.sin_engine_clear_bus_taps.restype = None

    lib.sin_engine_read_telemetry.argtypes = [
        c_void_p,
        ctypes.POINTER(_SinTelemetry),
        ctypes.POINTER(_SinBusPeak), ctypes.c_uint32,
        c_f_p, ctypes.c_uint32,
    ]
    lib.sin_engine_read_telemetry.restype = None


def load_native_library(reload_if_missing: bool = False) -> Optional[ctypes.CDLL]:
    global _LIB_CACHE, _LIB_LOAD_ATTEMPTED
    if _LIB_CACHE is not None:
        return _LIB_CACHE
    if _LIB_LOAD_ATTEMPTED and not reload_if_missing:
        return None
    _LIB_LOAD_ATTEMPTED = True

    lib_path = find_native_library_path()
    if lib_path is None:
        logger.debug("Native libsin_dsp library not found in %s", ENGINE_BIN_DIR)
        return None

    try:
        lib = ctypes.CDLL(str(lib_path))
        _bind_functions(lib)
        _LIB_CACHE = lib
        logger.info("Loaded native libsin_dsp from %s", lib_path)
        return lib
    except OSError as exc:
        logger.warning("Failed to load native libsin_dsp (%s): %s", lib_path, exc)
        return None


def is_native_engine_available() -> bool:
    if os.environ.get("SIN_ENGINE_BACKEND", "").strip().lower() == "python":
        return False
    return load_native_library() is not None


class SinAudioEngine:
    """High-level Python wrapper over one native libsin_dsp SinEngine instance."""

    def __init__(
        self,
        sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
        max_block_size: int = 1024,
        offline_mode: bool = True,
    ) -> None:
        lib = load_native_library()
        if lib is None:
            raise RuntimeError(
                "Native libsin_dsp binary is not built. Run tools/build-engine.ps1 (Windows) "
                "or tools/build-engine.sh (macOS/Linux)."
            )
        self._lib = lib
        cfg = _SinEngineConfig(
            sample_rate=int(sample_rate or SIN_DEFAULT_SAMPLE_RATE),
            max_block_size=int(max_block_size or 1024),
            offline_mode=1 if offline_mode else 0,
        )
        self._handle = lib.sin_engine_create(ctypes.byref(cfg))
        if not self._handle:
            raise RuntimeError("sin_engine_create returned NULL")
        self._offline = bool(offline_mode)
        self._registered_sources: Dict[int, Tuple[Optional[str], int]] = {}
        self._file_sigs: Dict[int, Tuple[str, int, int]] = {}
        self._bus_key_map: Dict[int, str] = {}
        self._bus_id_map: Dict[str, int] = {}

    def __enter__(self) -> "SinAudioEngine":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._lib.sin_engine_destroy(self._handle)
            self._handle = None
            self._registered_sources.clear()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    @property
    def sample_rate(self) -> int:
        if not self._handle:
            return SIN_DEFAULT_SAMPLE_RATE
        return int(self._lib.sin_engine_get_sample_rate(self._handle))

    @property
    def bus_id_map(self) -> Dict[str, int]:
        return self._bus_id_map

    @property
    def bus_key_map(self) -> Dict[int, str]:
        return self._bus_key_map

    def reset(self) -> None:
        if self._handle:
            self._lib.sin_engine_reset(self._handle)

    def start_device(self) -> bool:
        if not self._handle:
            return False
        return self._lib.sin_engine_start_device(self._handle) == 0

    def stop_device(self) -> None:
        if self._handle:
            self._lib.sin_engine_stop_device(self._handle)

    def is_device_running(self) -> bool:
        return bool(self._handle and self._lib.sin_engine_is_device_running(self._handle))

    @staticmethod
    def _file_signature(filepath: str) -> Tuple[str, int, int]:
        try:
            st = os.stat(filepath)
            return (str(filepath), int(st.st_mtime_ns), int(st.st_size))
        except OSError:
            return (str(filepath), 0, 0)

    def register_file_source(self, source_id: int, filepath: str, force_ram: bool = False) -> bool:
        if not self._handle or not filepath:
            return False
        rc = self._lib.sin_engine_register_file_source(
            self._handle,
            int(source_id),
            str(filepath).encode("utf-8"),
            1 if force_ram else 0,
        )
        if rc == 0:
            sig = self._file_signature(str(filepath))
            self._registered_sources[int(source_id)] = (sig[0], sig[1] ^ (sig[2] << 1))
            self._file_sigs[int(source_id)] = sig
            return True
        return False

    def register_pcm_source(
        self,
        source_id: int,
        audio: np.ndarray,
        sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
        content_hash: int = 0,
    ) -> bool:
        if not self._handle or audio is None:
            return False
        arr = np.asarray(audio, dtype=np.float32)
        if arr.size == 0:
            ch0 = np.zeros(0, dtype=np.float32)
            rc = self._lib.sin_engine_register_pcm_source(
                self._handle, int(source_id), None, None, 0, int(sample_rate), int(content_hash) & 0xFFFFFFFFFFFFFFFF
            )
            return rc == 0

        if arr.ndim == 1:
            ch0 = np.ascontiguousarray(arr, dtype=np.float32)
            p0 = ch0.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
            p1 = None
            n_frames = int(ch0.shape[0])
        else:
            ch0 = np.ascontiguousarray(arr[0], dtype=np.float32)
            p0 = ch0.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
            if arr.shape[0] > 1:
                ch1 = np.ascontiguousarray(arr[1], dtype=np.float32)
                p1 = ch1.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
            else:
                ch1 = None
                p1 = None
            n_frames = int(ch0.shape[0])

        rc = self._lib.sin_engine_register_pcm_source(
            self._handle,
            int(source_id),
            p0,
            p1,
            n_frames,
            int(sample_rate or SIN_DEFAULT_SAMPLE_RATE),
            int(content_hash) & 0xFFFFFFFFFFFFFFFF,
        )
        if rc == 0:
            self._registered_sources[int(source_id)] = (None, int(content_hash))
            self._file_sigs.pop(int(source_id), None)
            return True
        return False

    def get_source_info(self, source_id: int) -> Optional[Dict[str, object]]:
        if not self._handle:
            return None
        info = _SinSourceInfo()
        rc = self._lib.sin_engine_get_source_info(self._handle, int(source_id), ctypes.byref(info))
        if rc != 0:
            return None
        return {
            "sample_rate": int(info.sample_rate),
            "channels": int(info.channels),
            "num_frames": int(info.num_frames),
            "is_streaming": bool(info.is_streaming),
        }

    def release_all_sources(self) -> None:
        if self._handle:
            self._lib.sin_engine_release_all_sources(self._handle)
            self._registered_sources.clear()
            self._file_sigs.clear()

    def load_plan(self, plan: SinRenderPlan) -> bool:
        if not self._handle:
            return False

        # Register / refresh sources cleanly (cache files by path + mtime_ns + size)
        active_source_ids = set()
        for src in plan.sources:
            sid = int(src.source_id)
            active_source_ids.add(sid)
            if src.pcm is not None:
                self.register_pcm_source(sid, src.pcm, src.sample_rate, src.content_hash)
            elif src.filepath:
                sig = self._file_signature(str(src.filepath))
                if self._file_sigs.get(sid) != sig:
                    self.register_file_source(sid, src.filepath, force_ram=src.force_ram)

        # Pack buses into flat C struct array
        n_buses = len(plan.buses)
        c_buses = (_SinBusDesc * max(1, n_buses))()
        for i, b in enumerate(plan.buses):
            c_buses[i] = _SinBusDesc(
                bus_id=int(b.bus_id),
                parent_bus_id=int(b.parent_bus_id),
                pre_gain_db=float(b.pre_gain_db),
                volume=float(b.volume),
                post_gain_db=float(b.post_gain_db),
                pan=float(b.pan),
                crop_start=float(b.crop_start),
                crop_end=float(b.crop_end),
                playback_rate=float(b.playback_rate),
                muted=1 if b.muted else 0,
                solo=1 if b.solo else 0,
            )

        # Pack clips into flat C struct array
        n_clips = len(plan.clips)
        c_clips = (_SinClipDesc * max(1, n_clips))()
        for i, c in enumerate(plan.clips):
            c_clips[i] = _SinClipDesc(
                clip_id=int(c.clip_id),
                source_id=int(c.source_id),
                target_bus_id=int(c.target_bus_id),
                timeline_start_frame=int(c.timeline_start_frame),
                timeline_length_frames=int(c.timeline_length_frames),
                source_start_ratio=float(c.source_start_ratio),
                source_end_ratio=float(c.source_end_ratio),
                gain=float(c.gain),
                playback_rate=float(c.playback_rate),
                fade_in_frames=int(max(0, c.fade_in_frames)),
                fade_out_frames=int(max(0, c.fade_out_frames)),
                release_frames=int(max(0, c.release_frames)),
                flags=int(c.flags),
            )

        # Pack optional ordered DspProcessor chain stages
        n_stages = len(plan.stages)
        c_stages = (_SinChainStageDesc * max(1, n_stages))()
        for i, st in enumerate(plan.stages):
            p_arr = (ctypes.c_float * SIN_MAX_PROC_PARAMS)()
            np_count = min(len(st.params), SIN_MAX_PROC_PARAMS)
            for pi in range(np_count):
                p_arr[pi] = float(st.params[pi])
            c_stages[i] = _SinChainStageDesc(
                bus_id=int(st.bus_id),
                stage_index=int(st.stage_index),
                processor_type=int(st.processor_type),
                enabled=1 if st.enabled else 0,
                num_params=np_count,
                params=p_arr,
            )

        rc = self._lib.sin_engine_load_plan_with_chains(
            self._handle,
            c_buses if n_buses > 0 else None,
            n_buses,
            c_clips if n_clips > 0 else None,
            n_clips,
            c_stages if n_stages > 0 else None,
            n_stages,
            float(plan.explicit_duration_sec),
            float(plan.bpm or 120.0),
        )
        if rc == 0:
            # Prune obsolete non-preview sources (< 90001) so switching large presets never leaks RAM
            obsolete_ids = [
                sid for sid in list(self._registered_sources.keys())
                if sid < 90001 and sid not in active_source_ids
            ]
            for sid in obsolete_ids:
                self._lib.sin_engine_release_source(self._handle, sid)
                self._registered_sources.pop(sid, None)
                self._file_sigs.pop(sid, None)
            self._bus_id_map = dict(plan.bus_id_map)
            self._bus_key_map = dict(plan.bus_key_map)
            return True
        return False

    def set_param(self, bus_id: int, param_id: int, value: float, ramp_ms: float = 5.0) -> None:
        if self._handle:
            self._lib.sin_engine_set_param(
                self._handle, int(bus_id), int(param_id), float(value), float(ramp_ms)
            )

    def set_stage_param(
        self,
        bus_id: int,
        stage_index: int,
        param_index: int,
        value: float,
        ramp_ms: float = 5.0,
    ) -> None:
        if self._handle:
            self._lib.sin_engine_set_stage_param(
                self._handle,
                int(bus_id),
                int(stage_index),
                int(param_index),
                float(value),
                float(ramp_ms),
            )

    def set_stage_enabled(self, bus_id: int, stage_index: int, enabled: bool) -> None:
        if self._handle:
            self._lib.sin_engine_set_stage_enabled(
                self._handle,
                int(bus_id),
                int(stage_index),
                1 if enabled else 0,
            )

    def set_transport(
        self,
        playing: bool,
        seek_sec: float = -1.0,
        bpm: float = 0.0,
        loop_start_sec: float = 0.0,
        loop_end_sec: float = 0.0,
        loop_enabled: bool = False,
    ) -> None:
        if self._handle:
            self._lib.sin_engine_set_transport(
                self._handle,
                1 if playing else 0,
                float(seek_sec),
                float(bpm),
                float(loop_start_sec),
                float(loop_end_sec),
                1 if loop_enabled else 0,
            )

    def set_audition(
        self,
        active: bool,
        solo_bus_id: int = 0,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
    ) -> None:
        if self._handle:
            self._lib.sin_engine_set_audition(
                self._handle,
                1 if active else 0,
                int(solo_bus_id),
                float(start_sec),
                float(end_sec),
            )

    def read_telemetry(self, include_scope: bool = False) -> Dict[str, object]:
        hdr = _SinTelemetry()
        bus_peaks_arr = (_SinBusPeak * 256)()
        scope_arr = (ctypes.c_float * 128)() if include_scope else None
        if self._handle:
            self._lib.sin_engine_read_telemetry(
                self._handle,
                ctypes.byref(hdr),
                bus_peaks_arr,
                256,
                scope_arr,
                128 if include_scope else 0,
            )
        peaks_by_key: Dict[str, float] = {}
        count = min(int(hdr.active_bus_count), 256)
        for i in range(count):
            bid = int(bus_peaks_arr[i].bus_id)
            key = self._bus_key_map.get(bid, str(bid))
            peaks_by_key[key] = round(float(bus_peaks_arr[i].peak), 4)

        payload: Dict[str, object] = {
            "playhead_sec": round(float(hdr.playhead_seconds), 4),
            "duration_sec": round(float(hdr.duration_seconds), 4),
            "bpm": float(hdr.bpm),
            "sample_rate": int(hdr.sample_rate),
            "is_playing": bool(hdr.is_playing),
            "loop_enabled": bool(hdr.loop_enabled),
            "audition_active": bool(hdr.audition_active),
            "master_peak_l": round(float(hdr.master_peak_l), 4),
            "master_peak_r": round(float(hdr.master_peak_r), 4),
            "master_rms_l": round(float(hdr.master_rms_l), 4),
            "master_rms_r": round(float(hdr.master_rms_r), 4),
            "bus_peaks": peaks_by_key,
        }
        if include_scope and scope_arr is not None:
            payload["scope"] = [round(float(scope_arr[i]), 4) for i in range(128)]
        return payload

    def render_offline(
        self,
        total_frames: Optional[int] = None,
        block_size: int = 2048,
        bus_tap_ids: Optional[Iterable[int]] = None,
    ) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
        """Pull planar stereo float32 audio (2, N) synchronously at full native C++ speed."""
        if not self._handle:
            return np.zeros((2, 0), dtype=np.float32), {}

        if total_frames is None:
            tel = self.read_telemetry(include_scope=False)
            dur = float(tel["duration_sec"])
            total_frames = int(round(dur * self.sample_rate))

        total_frames = max(0, int(total_frames))
        if total_frames == 0:
            return np.zeros((2, 0), dtype=np.float32), {}

        out_l = np.zeros(total_frames, dtype=np.float32)
        out_r = np.zeros(total_frames, dtype=np.float32)

        taps: Dict[int, Tuple[np.ndarray, np.ndarray]] = {}
        self._lib.sin_engine_clear_bus_taps(self._handle)
        if bus_tap_ids:
            for bid in bus_tap_ids:
                tl = np.zeros(total_frames, dtype=np.float32)
                tr = np.zeros(total_frames, dtype=np.float32)
                taps[int(bid)] = (tl, tr)
                self._lib.sin_engine_set_bus_tap(
                    self._handle,
                    int(bid),
                    tl.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                    tr.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                    total_frames,
                )

        self.reset()
        blk = max(64, int(block_size))
        off = 0
        c_f_p = ctypes.POINTER(ctypes.c_float)
        while off < total_frames:
            n = min(blk, total_frames - off)
            self._lib.sin_engine_process(
                self._handle,
                out_l[off:].ctypes.data_as(c_f_p),
                out_r[off:].ctypes.data_as(c_f_p),
                n,
            )
            off += n

        self._lib.sin_engine_clear_bus_taps(self._handle)
        master = np.stack([out_l, out_r], axis=0)
        tap_arrays = {bid: np.stack([tl, tr], axis=0) for bid, (tl, tr) in taps.items()}
        return master, tap_arrays


def render_plan_offline(
    plan: SinRenderPlan,
    sample_rate: Optional[int] = None,
    total_frames: Optional[int] = None,
    bus_tap_ids: Optional[Iterable[int]] = None,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    sr = int(sample_rate or plan.sample_rate or SIN_DEFAULT_SAMPLE_RATE)
    with SinAudioEngine(sample_rate=sr, max_block_size=2048, offline_mode=True) as eng:
        eng.load_plan(plan)
        if total_frames is None and plan.explicit_duration_sec > 0.0:
            total_frames = int(round(plan.explicit_duration_sec * sr))
        return eng.render_offline(total_frames=total_frames, bus_tap_ids=bus_tap_ids)
