from abc import ABC, abstractmethod
import logging
import math
from typing import Any, Dict, List, Optional, Tuple
import numpy as np


class DspProcessor(ABC):
    """Minimal In -> Out stereo/planar audio processor contract."""

    type_id: str = ""

    @abstractmethod
    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        """Transform `audio_in` (float32 planar) -> `audio_out` (float32 planar)."""
        raise NotImplementedError


def _db_to_lin(db: float) -> float:
    return 0.0 if db <= -120.0 else float(10.0 ** (db / 20.0))


def _ensure_planar(audio: np.ndarray) -> Tuple[np.ndarray, bool]:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        return arr[np.newaxis, :], True
    return arr, False


def _q_to_cutoff_order(q: float) -> int:
    min_q, max_q = 0.2, 12.0
    clamped = max(min_q, min(max_q, float(q)))
    t = (math.log(clamped) - math.log(min_q)) / (math.log(max_q) - math.log(min_q))
    return max(1, min(8, int(round(1.0 + max(0.0, min(1.0, t)) * 7.0))))


def _param_eq_band_sections(
    band_type: int,
    freq: float,
    gain_db: float,
    q: float,
    sr: int,
) -> List[Tuple[float, float, float, float, float]]:
    sr_f = float(max(1000, sr))
    f0 = max(20.0, min(0.45 * sr_f, float(freq)))
    w0 = 2.0 * math.pi * (f0 / sr_f)
    cos_w0 = math.cos(w0)
    sin_w0 = math.sin(w0)
    qv = max(0.1, float(q))

    if band_type in (0, 5):  # Low Cut (HPF) / High Cut (LPF)
        is_hp = (band_type == 0)
        order = _q_to_cutoff_order(qv)
        sections: List[Tuple[float, float, float, float, float]] = []
        if order % 2 == 1:
            k = math.tan(math.pi * (f0 / sr_f))
            norm = 1.0 / (1.0 + k)
            if is_hp:
                sections.append((norm, -norm, 0.0, (k - 1.0) * norm, 0.0))
            else:
                sections.append((k * norm, k * norm, 0.0, (k - 1.0) * norm, 0.0))
        pairs = order // 2
        for m in range(pairs):
            pole_sin = math.sin(math.pi * (2 * m + 1) / (2 * order))
            q_m = 1.0 / max(1e-4, 2.0 * pole_sin)
            alpha = sin_w0 / (2.0 * q_m)
            a0 = 1.0 + alpha
            inv_a0 = 1.0 / max(1e-12, a0)
            if is_hp:
                c = 0.5 * (1.0 + cos_w0)
                sections.append((c * inv_a0, -(1.0 + cos_w0) * inv_a0, c * inv_a0, (-2.0 * cos_w0) * inv_a0, (1.0 - alpha) * inv_a0))
            else:
                c = 0.5 * (1.0 - cos_w0)
                sections.append((c * inv_a0, (1.0 - cos_w0) * inv_a0, c * inv_a0, (-2.0 * cos_w0) * inv_a0, (1.0 - alpha) * inv_a0))
        return sections

    A = 10.0 ** (float(gain_db) / 40.0)
    if band_type == 2:  # Bell
        alpha = sin_w0 / (2.0 * qv)
        b0, b1, b2 = 1.0 + alpha * A, -2.0 * cos_w0, 1.0 - alpha * A
        a0, a1, a2 = 1.0 + alpha / A, -2.0 * cos_w0, 1.0 - alpha / A
    elif band_type == 3:  # Notch
        alpha = sin_w0 / (2.0 * qv)
        b0, b1, b2 = 1.0, -2.0 * cos_w0, 1.0
        a0, a1, a2 = 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha
    elif band_type == 1:  # Low Shelf
        alpha = (sin_w0 / 2.0) * math.sqrt(max(0.01, (A + 1.0 / A) * (1.0 / qv - 1.0) + 2.0))
        two_sqrt_a_alpha = 2.0 * math.sqrt(A) * alpha
        b0 = A * ((A + 1.0) - (A - 1.0) * cos_w0 + two_sqrt_a_alpha)
        b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cos_w0)
        b2 = A * ((A + 1.0) - (A - 1.0) * cos_w0 - two_sqrt_a_alpha)
        a0 = (A + 1.0) + (A - 1.0) * cos_w0 + two_sqrt_a_alpha
        a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cos_w0)
        a2 = (A + 1.0) + (A - 1.0) * cos_w0 - two_sqrt_a_alpha
    else:  # High Shelf (4)
        alpha = (sin_w0 / 2.0) * math.sqrt(max(0.01, (A + 1.0 / A) * (1.0 / qv - 1.0) + 2.0))
        two_sqrt_a_alpha = 2.0 * math.sqrt(A) * alpha
        b0 = A * ((A + 1.0) + (A - 1.0) * cos_w0 + two_sqrt_a_alpha)
        b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cos_w0)
        b2 = A * ((A + 1.0) + (A - 1.0) * cos_w0 - two_sqrt_a_alpha)
        a0 = (A + 1.0) - (A - 1.0) * cos_w0 + two_sqrt_a_alpha
        a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cos_w0)
        a2 = (A + 1.0) - (A - 1.0) * cos_w0 - two_sqrt_a_alpha

    inv_a0 = 1.0 / max(1e-12, a0)
    return [(b0 * inv_a0, b1 * inv_a0, b2 * inv_a0, a1 * inv_a0, a2 * inv_a0)]


def _apply_biquad_1d(x: np.ndarray, b0: float, b1: float, b2: float, a1: float, a2: float) -> np.ndarray:
    try:
        from scipy.signal import lfilter
        return lfilter([b0, b1, b2], [1.0, a1, a2], x).astype(np.float32, copy=False)
    except Exception:
        out = np.empty_like(x, dtype=np.float32)
        z1 = 0.0
        z2 = 0.0
        for i in range(x.shape[0]):
            xi = float(x[i])
            yi = b0 * xi + z1
            z1 = b1 * xi - a1 * yi + z2
            z2 = b2 * xi - a2 * yi
            out[i] = yi
        return out


class GainProcessor(DspProcessor):
    """Linear / decibel gain staging processor (`type_id = "gain"`)."""

    type_id: str = "gain"

    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        if "gain" in params and params["gain"] is not None:
            gain = float(params["gain"])
        elif "gain_db" in params and params["gain_db"] is not None:
            gain_db = float(params["gain_db"])
            gain = 0.0 if gain_db <= -35.9 else float(10.0 ** (gain_db / 20.0))
        else:
            gain = 1.0
        if gain == 1.0:
            return audio_in
        return (audio_in * gain).astype(np.float32, copy=False)


class ParamEqProcessor(DspProcessor):
    """Lightweight 4-band RBJ parametric EQ fallback (`type_id = "param_eq"`)."""

    type_id: str = "param_eq"

    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        buf, was_1d = _ensure_planar(audio_in)
        if buf.shape[-1] == 0:
            return audio_in
        out = buf.copy()
        bands = [
            (1, "b1", 100.0, 0.71),
            (2, "b2", 400.0, 1.0),
            (2, "b3", 2500.0, 1.0),
            (4, "b4", 8000.0, 0.71),
        ]
        for def_type, prefix, def_f, def_q in bands:
            enabled = float(params.get(f"{prefix}_enabled", 1.0)) >= 0.5
            if not enabled:
                continue
            band_type = max(0, min(5, int(round(float(params.get(f"{prefix}_type", def_type))))))
            gain_db = float(params.get(f"{prefix}_gain", 0.0))
            if band_type in (1, 2, 4) and abs(gain_db) < 1e-4:
                continue
            freq = float(params.get(f"{prefix}_freq", def_f))
            q = float(params.get(f"{prefix}_q", def_q))
            sections = _param_eq_band_sections(band_type, freq, gain_db, q, sample_rate)
            for coeffs in sections:
                for ch in range(out.shape[0]):
                    out[ch] = _apply_biquad_1d(out[ch], *coeffs)
        return out[0] if was_1d else out


class CompressorProcessor(DspProcessor):
    """Lightweight stereo-linked feed-forward compressor fallback (`type_id = "comp"`)."""

    type_id: str = "comp"

    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        buf, was_1d = _ensure_planar(audio_in)
        n = buf.shape[-1]
        if n == 0:
            return audio_in

        sr = max(1000, int(sample_rate))
        thresh = float(params.get("threshold_db", -18.0))
        ratio = max(1.0, float(params.get("ratio", 4.0)))
        attack_ms = max(0.1, float(params.get("attack_ms", 10.0)))
        release_ms = max(5.0, float(params.get("release_ms", 100.0)))
        knee = max(0.0, float(params.get("knee_db", 3.0)))
        makeup_lin = _db_to_lin(float(params.get("makeup_db", 0.0)))
        mix = max(0.0, min(1.0, float(params.get("mix", 100.0)) * 0.01))

        att_c = math.exp(-1.0 / max(1.0, (attack_ms * 0.001) * sr))
        rel_c = math.exp(-1.0 / max(1.0, (release_ms * 0.001) * sr))
        slope = 1.0 - (1.0 / ratio)
        half_knee = 0.5 * knee

        det_lin = np.max(np.abs(buf), axis=0)
        det_db = np.where(det_lin > 1e-6, 20.0 * np.log10(np.maximum(1e-6, det_lin)), -120.0)

        env = np.empty(n, dtype=np.float32)
        e = -120.0
        for i in range(n):
            d = float(det_db[i])
            if d > e:
                e = att_c * e + (1.0 - att_c) * d
            else:
                e = rel_c * e + (1.0 - rel_c) * d
            env[i] = e

        over = env - thresh
        if knee > 1e-4:
            gr_db = np.where(
                over <= -half_knee,
                0.0,
                np.where(
                    over >= half_knee,
                    -slope * over,
                    -slope * ((over + half_knee) ** 2) / (2.0 * knee),
                ),
            )
        else:
            gr_db = np.where(over > 0.0, -slope * over, 0.0)

        comp_gain = (10.0 ** (gr_db / 20.0)) * makeup_lin
        eff_gain = ((1.0 - mix) + mix * comp_gain).astype(np.float32, copy=False)
        out = (buf * eff_gain[np.newaxis, :]).astype(np.float32, copy=False)
        return out[0] if was_1d else out


class ClipperProcessor(DspProcessor):
    """Lightweight Hard/Soft/Tanh waveshaper clipper fallback (`type_id = "clipper"`)."""

    type_id: str = "clipper"

    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        buf, was_1d = _ensure_planar(audio_in)
        if buf.shape[-1] == 0:
            return audio_in

        mode = int(round(float(params.get("mode", 1))))
        drive_lin = _db_to_lin(float(params.get("drive_db", 0.0)))
        ceil_lin = max(1e-6, _db_to_lin(float(params.get("ceiling_db", 0.0))))
        softness = max(0.0, min(1.0, float(params.get("softness", 0.5))))
        out_lin = _db_to_lin(float(params.get("output_db", 0.0)))

        x = (buf * drive_lin) / ceil_lin
        if mode == 0:
            y = np.clip(x, -1.0, 1.0)
        elif mode == 1:
            knee = max(0.0, min(0.99, softness))
            t = 1.0 - knee
            ax = np.abs(x)
            span = max(1e-4, knee)
            sat = t + span * np.tanh(np.maximum(0.0, ax - t) / span)
            y = np.where(ax <= t, x, np.sign(x) * np.minimum(1.0, sat))
        else:
            k = 1.0 + (1.0 - softness) * 2.5
            norm = math.tanh(k)
            y = np.tanh(x * k) / norm if norm > 1e-6 else np.tanh(x)
            y = np.clip(y, -1.0, 1.0)

        out = (y * ceil_lin * out_lin).astype(np.float32, copy=False)
        return out[0] if was_1d else out


class LimiterProcessor(DspProcessor):
    """Lightweight brickwall lookahead peak limiter fallback (`type_id = "limiter"`)."""

    type_id: str = "limiter"

    def process(
        self,
        audio_in: np.ndarray,
        params: Dict[str, Any],
        sample_rate: int = 44100,
    ) -> np.ndarray:
        buf, was_1d = _ensure_planar(audio_in)
        n = buf.shape[-1]
        if n == 0:
            return audio_in

        sr = max(1000, int(sample_rate))
        in_gain = _db_to_lin(float(params.get("input_gain_db", 0.0)))
        ceil_lin = max(1e-6, _db_to_lin(float(params.get("ceiling_db", -0.3))))
        release_ms = max(5.0, min(500.0, float(params.get("release_ms", 60.0))))
        lookahead_ms = max(0.0, min(10.0, float(params.get("lookahead_ms", 2.0))))

        la = int(round((lookahead_ms * 0.001) * sr))
        la_sec = max(0.0002, lookahead_ms * 0.001)
        att_c = math.exp(-1.0 / max(1.0, 0.25 * la_sec * sr))
        rel_c = math.exp(-1.0 / max(1.0, (release_ms * 0.001) * sr))

        driven = buf * in_gain
        if la > 0:
            delayed = np.zeros_like(driven)
            if la < n:
                delayed[:, la:] = driven[:, : n - la]
        else:
            delayed = driven

        det = np.maximum(np.max(np.abs(driven), axis=0), np.max(np.abs(delayed), axis=0))
        gain_env = 1.0
        eff_gains = np.ones(n, dtype=np.float32)
        for i in range(n):
            dp = float(det[i])
            target_g = (ceil_lin / dp) if dp > ceil_lin else 1.0
            if target_g < gain_env:
                gain_env = att_c * gain_env + (1.0 - att_c) * target_g
                if gain_env > target_g and la == 0:
                    gain_env = target_g
            else:
                gain_env = rel_c * gain_env + (1.0 - rel_c) * target_g
            gain_env = max(0.0, min(1.0, gain_env))
            eff_gains[i] = min(gain_env, target_g)

        out = np.clip(delayed * eff_gains[np.newaxis, :], -ceil_lin, ceil_lin).astype(np.float32, copy=False)
        return out[0] if was_1d else out


class ProcessorRegistry:
    """Single source of truth for registered offline/real-time DSP processors."""

    def __init__(self) -> None:
        self._processors: Dict[str, DspProcessor] = {}

    def register(self, processor: DspProcessor) -> None:
        key = str(processor.type_id).strip().lower()
        if not key:
            raise ValueError("DspProcessor.type_id cannot be empty")
        self._processors[key] = processor

    def get(self, type_id: str) -> Optional[DspProcessor]:
        return self._processors.get(str(type_id or "").strip().lower())

    def types(self) -> frozenset[str]:
        return frozenset(self._processors.keys())


PROCESSOR_REGISTRY = ProcessorRegistry()
PROCESSOR_REGISTRY.register(GainProcessor())
PROCESSOR_REGISTRY.register(ParamEqProcessor())
PROCESSOR_REGISTRY.register(CompressorProcessor())
PROCESSOR_REGISTRY.register(ClipperProcessor())
PROCESSOR_REGISTRY.register(LimiterProcessor())
KNOWN_PROCESSOR_TYPES = PROCESSOR_REGISTRY.types()
_GAIN_PROCESSOR = PROCESSOR_REGISTRY.get("gain")


def apply_gain(audio: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    assert _GAIN_PROCESSOR is not None
    return _GAIN_PROCESSOR.process(audio, params)


def process_chain(
    audio_data: np.ndarray,
    chain_config: List[Dict[str, Any]],
    sample_rate: int = 44100,
) -> np.ndarray:
    """Execute registered In -> Out DspProcessor modules sequentially on `audio_data`."""
    if audio_data.shape[-1] == 0 or not chain_config:
        return audio_data

    buffer = np.asarray(audio_data, dtype=np.float32)

    for module in chain_config:
        if not isinstance(module, dict) or not module.get("enabled", True):
            continue

        mod_type = str(module.get("type", "")).strip().lower()
        processor = PROCESSOR_REGISTRY.get(mod_type)
        if processor is not None:
            try:
                buffer = processor.process(
                    buffer,
                    module.get("params", {}) or {},
                    sample_rate=sample_rate,
                )
            except Exception as e:
                logging.getLogger("beat_generator.dsp").error(
                    f"Error processing DSP module {mod_type}: {e}"
                )

    return buffer.astype(np.float32, copy=False)
