"""Standalone cooked AudioProcessorObject subclasses inheriting from `AudioObject`.

Inherits full SIN loop-buffer processing, child summing, `total_bars`, `GLOBAL_DAG_CACHE`,
and post-processor C++ FX chains (`self.chain`) without modifying `engine/` or `core/fx.py`.
"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING
import numpy as np

from core.audio_object import AudioObject
from core.dag_cache import GLOBAL_DAG_CACHE
from core.processors.chunked_inference import ensure_stereo_f32
from core.processors.cook_scheduler import PendingCookJob
from core.processors.model_manager import GLOBAL_DISK_STEM_CACHE, GLOBAL_MODEL_MANAGER, ModelManager
from core.processors.preamp_denoise import (
    PreampAnalysis,
    analyze_preamp,
    synthesize_preamp,
)
from core.processors.voice_isolator import (
    ModelNotInstalledError,
    VoiceDecomposition,
    check_voice_backend_ready,
    decompose_voice,
    recombine_voice,
)

if TYPE_CHECKING:
    from core.system import System

logger = logging.getLogger("sin.processor_nodes")

PROCESSOR_NODE_TYPES = frozenset({"preamp_denoise", "voice_isolator"})

PREAMP_DENOISE_PARAM_KEYS = frozenset({
    "profile_id",
    "input_topology",
    "stft_mode",
    "reduction_db",
    "sensitivity",
    "profile_weight",
    "stereo_coherence",
    "hp_hz",
    "spur_notch",
    "psychoacoustic_preserve",
    "natural_floor",
    "output_mode",
    "noise_start",
    "noise_end",
    "cook_mode",
    "precook_window_sec",
    "mix",
    "bypass",
})

VOICE_ISOLATOR_PARAM_KEYS = frozenset({
    "voice_db",
    "reverb_db",
    "ambience_db",
    "reverb_sensitivity",
    "mask_sharpness",
    "backend",
    "solo_stem",
    "mute_voice",
    "mute_reverb",
    "mute_ambience",
    "cook_mode",
    "precook_window_sec",
    "mix",
    "bypass",
})

ALL_PROCESSOR_PARAM_KEYS = PREAMP_DENOISE_PARAM_KEYS | VOICE_ISOLATOR_PARAM_KEYS


def _hash_audio_fast(audio: np.ndarray, sample_rate: int) -> str:
    """Fast content hash for a planar float32 buffer."""
    h = hashlib.blake2b(digest_size=12)
    h.update(f"{audio.shape}:{sample_rate}".encode("utf-8"))
    if audio.size > 0:
        flat = np.ascontiguousarray(audio.reshape(-1), dtype=np.float32)
        step = max(1, flat.size // 4096)
        h.update(flat[::step].tobytes())
        h.update(flat[: min(64, flat.size)].tobytes())
        h.update(flat[max(0, flat.size - 64) :].tobytes())
    return h.hexdigest()


class _ProcessorAnalysisStore:
    """Thread-safe bounded RAM LRU for Level-1 cooked analysis + partial preview windows."""

    def __init__(self, max_entries: int = 32) -> None:
        self._lock = threading.RLock()
        self._max = max(8, int(max_entries))
        self._full: OrderedDict[str, Any] = OrderedDict()
        self._partial: OrderedDict[str, Tuple[Any, int, int]] = OrderedDict()

    def get_full(self, fp: str) -> Optional[Any]:
        with self._lock:
            val = self._full.get(fp)
            if val is not None:
                self._full.move_to_end(fp)
            return val

    def put_full(self, fp: str, value: Any) -> None:
        with self._lock:
            self._full[fp] = value
            self._full.move_to_end(fp)
            self._partial.pop(fp, None)
            while len(self._full) > self._max:
                self._full.popitem(last=False)

    def get_partial(self, fp: str) -> Optional[Tuple[Any, int, int]]:
        with self._lock:
            val = self._partial.get(fp)
            if val is not None:
                self._partial.move_to_end(fp)
            return val

    def put_partial(self, fp: str, value: Any, start_frame: int, end_frame: int) -> None:
        with self._lock:
            self._partial[fp] = (value, int(start_frame), int(end_frame))
            self._partial.move_to_end(fp)
            while len(self._partial) > self._max:
                self._partial.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._full.clear()
            self._partial.clear()


GLOBAL_PROCESSOR_ANALYSIS_STORE = _ProcessorAnalysisStore(max_entries=32)


def _splice_with_crossfade(
    base_audio: np.ndarray,
    processed_slice: np.ndarray,
    start_frame: int,
    end_frame: int,
    sr: int,
) -> np.ndarray:
    """Splice a partial preview window into dry base audio with 10ms click-free edge fades."""
    out = ensure_stereo_f32(base_audio).copy()
    seg = ensure_stereo_f32(processed_slice)
    n = int(out.shape[-1])
    s = max(0, min(n, int(start_frame)))
    e = max(s, min(n, int(end_frame)))
    seg_len = min(e - s, int(seg.shape[-1]))
    if seg_len <= 0:
        return out
    fade = min(seg_len // 4, max(32, int(round(0.010 * sr))))
    w = np.ones(seg_len, dtype=np.float32)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        if s > 0:
            w[:fade] = ramp
        if s + seg_len < n:
            w[-fade:] = ramp[::-1]
    out[:, s : s + seg_len] = (
        out[:, s : s + seg_len] * (1.0 - w[None, :]) + seg[:, :seg_len] * w[None, :]
    )
    return out


class AudioProcessorObject(AudioObject):
    """Base class for standalone Python Tier-2 cooked audio processor nodes."""

    default_processor_params: Dict[str, Any] = {}
    supports_disk_cache: bool = False

    def __init__(
        self,
        *args: Any,
        processor_params: Optional[Dict[str, Any]] = None,
        model_manager: Optional[ModelManager] = None,
        analysis_store: Optional[_ProcessorAnalysisStore] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        merged = dict(self.default_processor_params)
        if isinstance(processor_params, dict):
            for k, v in processor_params.items():
                if v is not None:
                    merged[k] = v
        self.processor_params: Dict[str, Any] = merged
        self._model_manager = model_manager or GLOBAL_MODEL_MANAGER
        self._analysis_store = analysis_store or GLOBAL_PROCESSOR_ANALYSIS_STORE

    def is_bypassed(self) -> bool:
        return bool(self.processor_params.get("bypass", False))

    def cook_mode(self) -> str:
        mode = str(self.processor_params.get("cook_mode") or "auto").strip().lower()
        return "manual" if mode == "manual" else "auto"

    def structural_cook_params(self) -> Dict[str, Any]:
        """Return only parameters that invalidate Level-1 heavy analysis/decomposition."""
        return {}

    def check_ready(self) -> Dict[str, Any]:
        """Return readiness info (`ready: bool`, optional `model_id`, `model_status`)."""
        return {"ready": True, "model_id": None, "model_status": None}

    def cook_analysis(
        self,
        audio_in: np.ndarray,
        sample_rate: int,
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Any] = None,
    ) -> Any:
        raise NotImplementedError

    def synthesize(self, analysis: Any, audio_in: np.ndarray, sample_rate: int) -> np.ndarray:
        raise NotImplementedError

    def status_extra_from_analysis(self, analysis: Any) -> Dict[str, Any]:
        return {}

    def serialize_analysis_for_disk(self, analysis: Any) -> Optional[Dict[str, np.ndarray]]:
        return None

    def deserialize_analysis_from_disk(self, arrays: Dict[str, np.ndarray], sample_rate: int) -> Optional[Any]:
        return None

    def compute_cook_fingerprint(self, input_hash: str, sample_rate: int) -> str:
        payload = {
            "node_type": self.node_type,
            "input_hash": input_hash,
            "sr": int(sample_rate),
            "structural": self.structural_cook_params(),
        }
        return GLOBAL_DAG_CACHE.compute_fingerprint(payload)

    def _render_upstream(self, system: Optional[System], **kwargs: Any) -> np.ndarray:
        """Render child inputs using AudioObject's full loop/bar/summing semantics without own FX chain."""
        saved_chain = self.chain
        saved_vol = self._volume
        saved_fp = getattr(self, "fingerprint", None)
        try:
            self.chain = []
            self._volume = 1.0
            # Avoid colliding upstream render cache with this node's own post-processor cache
            if saved_fp is not None:
                self.fingerprint = f"{saved_fp}:upstream"
            raw = super().render(system=system, **kwargs)
        finally:
            self.chain = saved_chain
            self._volume = saved_vol
            if saved_fp is not None:
                self.fingerprint = saved_fp
        return ensure_stereo_f32(raw)

    def _lookup_full_analysis(self, cook_fp: str, sample_rate: int) -> Optional[Any]:
        art = self._analysis_store.get_full(cook_fp)
        if art is not None:
            return art
        if self.supports_disk_cache:
            arrays = GLOBAL_DISK_STEM_CACHE.get(self.node_type, cook_fp)
            if arrays is not None:
                art = self.deserialize_analysis_from_disk(arrays, sample_rate)
                if art is not None:
                    self._analysis_store.put_full(cook_fp, art)
                    return art
        return None

    def _store_full_analysis(self, cook_fp: str, art: Any) -> None:
        self._analysis_store.put_full(cook_fp, art)
        if self.supports_disk_cache:
            arrays = self.serialize_analysis_for_disk(art)
            if arrays:
                try:
                    GLOBAL_DISK_STEM_CACHE.put(self.node_type, cook_fp, arrays)
                except Exception as exc:
                    logger.debug("Disk stem cache write skipped: %s", exc)

    def _record_status(self, system: Optional[System], status: Dict[str, Any]) -> None:
        if system is None or self.node_id is None:
            return
        if hasattr(system, "record_processor_status"):
            system.record_processor_status(str(self.node_id), status)

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        sr = int(system.sample_rate) if system is not None else 48000
        audio_in = self._render_upstream(system, **kwargs)
        if audio_in.shape[-1] == 0:
            self._record_status(system, {
                "node_id": str(self.node_id) if self.node_id is not None else "",
                "node_type": self.node_type,
                "node_name": self.name,
                "state": "bypassed" if self.is_bypassed() else "ready",
                "progress": 1.0,
                "phase": "no input",
            })
            return audio_in

        nid_str = str(self.node_id) if self.node_id is not None else f"proc:{self.name}"

        # 1. Explicit bypass always passes clean dry audio immediately
        if self.is_bypassed():
            self._record_status(system, {
                "node_id": nid_str,
                "node_type": self.node_type,
                "node_name": self.name,
                "state": "bypassed",
                "progress": 1.0,
                "phase": "bypassed",
            })
            return self.apply_chain(audio_in, system)

        # 2. Check model readiness (never silently triggers network downloads)
        ready_info = self.check_ready()
        if not ready_info.get("ready", True):
            model_id = str(ready_info.get("model_id") or "")
            model_status = ready_info.get("model_status") or {}
            is_offline = system is None or system.render_mode == "offline"
            allow_bypass_export = bool(getattr(system, "allow_bypassed_export", False)) if system is not None else False
            self._record_status(system, {
                "node_id": nid_str,
                "node_type": self.node_type,
                "node_name": self.name,
                "state": "model_missing",
                "progress": 0.0,
                "phase": "model download required",
                "model_id": model_id,
                "model_status": model_status,
            })
            if is_offline and not allow_bypass_export:
                raise ModelNotInstalledError(model_id, model_status)
            return self.apply_chain(audio_in, system)

        input_hash = _hash_audio_fast(audio_in, sr)
        cook_fp = self.compute_cook_fingerprint(input_hash, sr)

        # 3. Level-1 Full Cache HIT -> Fast Level-2 synthesis!
        cached_art = self._lookup_full_analysis(cook_fp, sr)
        if cached_art is not None:
            out_audio = self.synthesize(cached_art, audio_in, sr)
            self._record_status(system, {
                "node_id": nid_str,
                "node_type": self.node_type,
                "node_name": self.name,
                "state": "ready",
                "progress": 1.0,
                "phase": "ready",
                "cook_fingerprint": cook_fp,
                **self.status_extra_from_analysis(cached_art),
            })
            return self.apply_chain(out_audio, system)

        # 4. Full Cache MISS
        is_preview = system is not None and system.render_mode == "preview"
        allow_async = bool(getattr(system, "allow_async_cook", False)) if system is not None else False
        force_ids = getattr(system, "force_cook_node_ids", None) or set()
        is_forced = nid_str in force_ids

        # Offline export mode: synchronously cook full clip (unless manual+stale with explicit allow_bypassed_export)
        if not is_preview:
            allow_bypass_export = bool(getattr(system, "allow_bypassed_export", False)) if system is not None else False
            if self.cook_mode() == "manual" and allow_bypass_export:
                self._record_status(system, {
                    "node_id": nid_str,
                    "node_type": self.node_type,
                    "node_name": self.name,
                    "state": "stale_bypassed",
                    "progress": 0.0,
                    "phase": "bypassed (manual stale)",
                    "cook_fingerprint": cook_fp,
                })
                return self.apply_chain(audio_in, system)

            full_art = self.cook_analysis(audio_in, sr)
            self._store_full_analysis(cook_fp, full_art)
            out_audio = self.synthesize(full_art, audio_in, sr)
            self._record_status(system, {
                "node_id": nid_str,
                "node_type": self.node_type,
                "node_name": self.name,
                "state": "ready",
                "progress": 1.0,
                "phase": "ready",
                "cook_fingerprint": cook_fp,
                **self.status_extra_from_analysis(full_art),
            })
            return self.apply_chain(out_audio, system)

        # Live preview mode with async cooking enabled -> non-blocking bypass (or partial window!)
        if allow_async:
            partial_entry = self._analysis_store.get_partial(cook_fp)
            if partial_entry is not None:
                p_art, s_idx, e_idx = partial_entry
                p_slice = self.synthesize(p_art, audio_in[:, s_idx:e_idx], sr)
                out_audio = _splice_with_crossfade(audio_in, p_slice, s_idx, e_idx, sr)
                base_state = "partial_ready"
                extra_st = self.status_extra_from_analysis(p_art)
            else:
                out_audio = audio_in
                base_state = "cooking_bypassed"
                extra_st = {}

            if self.cook_mode() == "manual" and not is_forced:
                self._record_status(system, {
                    "node_id": nid_str,
                    "node_type": self.node_type,
                    "node_name": self.name,
                    "state": "stale_bypassed",
                    "progress": 0.0,
                    "phase": "manual cook required",
                    "cook_fingerprint": cook_fp,
                })
                return self.apply_chain(audio_in, system)

            pending_list = getattr(system, "pending_cooks", None)
            if isinstance(pending_list, list):
                pending_list.append(
                    PendingCookJob(
                        node_id=nid_str,
                        node_type=self.node_type,
                        node_name=self.name,
                        cook_fingerprint=cook_fp,
                        audio_in=audio_in.copy(),
                        sample_rate=sr,
                        playhead_sec=float(getattr(system, "playhead_sec", 0.0) or 0.0),
                        cook_fn=self.cook_analysis,
                        store_partial_fn=lambda art, s_i, e_i, fp=cook_fp: self._analysis_store.put_partial(fp, art, s_i, e_i),
                        store_full_fn=lambda art, fp=cook_fp: self._store_full_analysis(fp, art),
                        immediate=is_forced,
                    )
                )

            self._record_status(system, {
                "node_id": nid_str,
                "node_type": self.node_type,
                "node_name": self.name,
                "state": base_state,
                "progress": 0.45 if base_state == "partial_ready" else 0.0,
                "phase": "preview window active" if base_state == "partial_ready" else "cooking (bypassed)",
                "cook_fingerprint": cook_fp,
                **extra_st,
            })
            return self.apply_chain(out_audio, system)

        # Direct synchronous preview fallback (e.g., `/api/preview` or unit tests without RealtimeAudioHost)
        full_art = self.cook_analysis(audio_in, sr)
        self._store_full_analysis(cook_fp, full_art)
        out_audio = self.synthesize(full_art, audio_in, sr)
        self._record_status(system, {
            "node_id": nid_str,
            "node_type": self.node_type,
            "node_name": self.name,
            "state": "ready",
            "progress": 1.0,
            "phase": "ready",
            "cook_fingerprint": cook_fp,
            **self.status_extra_from_analysis(full_art),
        })
        return self.apply_chain(out_audio, system)


class PreampDenoiseObject(AudioProcessorObject):
    """Generalized recording-device preamp / ADC floor noise remover (`node_type = 'preamp_denoise'`)."""

    supports_disk_cache = False
    default_processor_params: Dict[str, Any] = {
        "profile_id": "generic_adc",
        "input_topology": "mono_or_dual_mono",
        "stft_mode": "hq_dual_res",
        "reduction_db": 12.0,
        "sensitivity": 0.0,
        "profile_weight": 0.7,
        "stereo_coherence": 0.6,
        "hp_hz": 40.0,
        "spur_notch": 0.5,
        "psychoacoustic_preserve": 0.75,
        "natural_floor": 0.15,
        "output_mode": "denoised",
        "noise_start": 0.0,
        "noise_end": 0.0,
        "cook_mode": "auto",
        "precook_window_sec": 24.0,
        "mix": 1.0,
        "bypass": False,
    }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["node_type"] = "preamp_denoise"
        super().__init__(*args, **kwargs)

    def structural_cook_params(self) -> Dict[str, Any]:
        p = self.processor_params
        return {
            "profile_id": str(p.get("profile_id") or "generic_adc"),
            "stft_mode": str(p.get("stft_mode") or "hq_dual_res"),
            "hp_hz": round(float(p.get("hp_hz", 40.0)), 2),
            "noise_start": round(float(p.get("noise_start", 0.0)), 4),
            "noise_end": round(float(p.get("noise_end", 0.0)), 4),
        }

    def cook_analysis(
        self,
        audio_in: np.ndarray,
        sample_rate: int,
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Any] = None,
    ) -> PreampAnalysis:
        p = self.processor_params
        return analyze_preamp(
            audio_in,
            sample_rate,
            profile_id=str(p.get("profile_id") or "generic_adc"),
            hp_hz=float(p.get("hp_hz", 40.0)),
            stft_mode=str(p.get("stft_mode") or "hq_dual_res"),
            noise_start=float(p.get("noise_start", 0.0)),
            noise_end=float(p.get("noise_end", 0.0)),
            cancel_event=cancel_event,
            on_progress=on_progress,
        )

    def synthesize(self, analysis: PreampAnalysis, audio_in: np.ndarray, sample_rate: int) -> np.ndarray:
        return synthesize_preamp(analysis, audio_in, self.processor_params)

    def status_extra_from_analysis(self, analysis: PreampAnalysis) -> Dict[str, Any]:
        return {
            "profile_id": analysis.profile.id,
            "detected_spurs_hz": list(analysis.primary.detected_spurs_hz),
        }


class VoiceIsolatorObject(AudioProcessorObject):
    """3-way Voice + Voice Reverb + Ambience isolator (`node_type = 'voice_isolator'`)."""

    supports_disk_cache = True
    default_processor_params: Dict[str, Any] = {
        "voice_db": 0.0,
        "reverb_db": 0.0,
        "ambience_db": 0.0,
        "reverb_sensitivity": 0.5,
        "mask_sharpness": 0.25,
        "backend": "fast_onnx",
        "solo_stem": "none",
        "mute_voice": False,
        "mute_reverb": False,
        "mute_ambience": False,
        "cook_mode": "auto",
        "precook_window_sec": 24.0,
        "mix": 1.0,
        "bypass": False,
    }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["node_type"] = "voice_isolator"
        super().__init__(*args, **kwargs)

    def structural_cook_params(self) -> Dict[str, Any]:
        p = self.processor_params
        return {
            "backend": str(p.get("backend") or "fast_onnx").strip().lower(),
            "reverb_sensitivity": round(float(p.get("reverb_sensitivity", 0.5)), 3),
        }

    def check_ready(self) -> Dict[str, Any]:
        return check_voice_backend_ready(
            str(self.processor_params.get("backend") or "fast_onnx"),
            model_manager=self._model_manager,
        )

    def cook_analysis(
        self,
        audio_in: np.ndarray,
        sample_rate: int,
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Any] = None,
    ) -> VoiceDecomposition:
        p = self.processor_params
        return decompose_voice(
            audio_in,
            sample_rate,
            backend=str(p.get("backend") or "fast_onnx"),
            reverb_sensitivity=float(p.get("reverb_sensitivity", 0.5)),
            model_manager=self._model_manager,
            cancel_event=cancel_event,
            on_progress=on_progress,
        )

    def synthesize(self, analysis: VoiceDecomposition, audio_in: np.ndarray, sample_rate: int) -> np.ndarray:
        return recombine_voice(analysis, audio_in, self.processor_params)

    def status_extra_from_analysis(self, analysis: VoiceDecomposition) -> Dict[str, Any]:
        return {
            "backend": analysis.backend_used,
            "stem_rms": {
                "voice": analysis.rms_voice,
                "reverb": analysis.rms_reverb,
                "ambience": analysis.rms_ambience,
            },
        }

    def serialize_analysis_for_disk(self, analysis: VoiceDecomposition) -> Optional[Dict[str, np.ndarray]]:
        return analysis.to_cache_arrays()

    def deserialize_analysis_from_disk(
        self, arrays: Dict[str, np.ndarray], sample_rate: int
    ) -> Optional[VoiceDecomposition]:
        if all(k in arrays for k in ("voice", "reverb", "ambience")):
            backend = str(self.processor_params.get("backend") or "fast_onnx")
            return VoiceDecomposition.from_cache_arrays(arrays, sample_rate, backend)
        return None


def inspect_export_preflight(
    node_model: Any,
    *,
    model_manager: Optional[ModelManager] = None,
) -> Dict[str, Any]:
    """Walk an `AudioNodeModel` tree and collect hybrid export warnings for processor nodes."""
    issues: List[Dict[str, Any]] = []
    mm = model_manager or GLOBAL_MODEL_MANAGER

    def _visit(node: Any) -> None:
        if node is None:
            return
        ntype = str(node.get("node_type") if isinstance(node, dict) else getattr(node, "node_type", "") or "").lower()
        nid = node.get("node_id") if isinstance(node, dict) else getattr(node, "node_id", None)
        nname = str(node.get("node_name") if isinstance(node, dict) else getattr(node, "node_name", "Processor") or "Processor")
        pparams = (
            node.get("processor_params")
            if isinstance(node, dict)
            else getattr(node, "processor_params", None)
        ) or {}

        if ntype in PROCESSOR_NODE_TYPES:
            if bool(pparams.get("bypass", False)):
                issues.append({
                    "node_id": nid,
                    "node_name": nname,
                    "node_type": ntype,
                    "state": "bypassed",
                    "detail": f"'{nname}' has Bypass enabled and will export unprocessed dry audio.",
                })
            else:
                if ntype == "voice_isolator":
                    backend = str(pparams.get("backend") or "fast_onnx")
                    chk = check_voice_backend_ready(backend, model_manager=mm)
                    if not chk["ready"]:
                        issues.append({
                            "node_id": nid,
                            "node_name": nname,
                            "node_type": ntype,
                            "state": "model_missing",
                            "model_id": chk["model_id"],
                            "detail": f"'{nname}' requires model '{chk['model_id']}' which is not downloaded yet.",
                        })
                if str(pparams.get("cook_mode") or "auto").lower() == "manual":
                    issues.append({
                        "node_id": nid,
                        "node_name": nname,
                        "node_type": ntype,
                        "state": "stale_manual",
                        "detail": f"'{nname}' is in Manual Cook mode; choose Cancel to process first or Bypass & Proceed to export dry audio.",
                    })

        children = node.get("children") if isinstance(node, dict) else getattr(node, "children", None)
        for ch in children or []:
            _visit(ch)

    _visit(node_model)
    return {
        "ok": len(issues) == 0,
        "has_warnings": len(issues) > 0,
        "issues": issues,
    }
