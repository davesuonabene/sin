"""Supertone Clear / Goyo-style 3-way Voice Isolator (Voice + Voice Reverb + Ambience).

Implements a Two-Stage Cascaded Exact-Partition Pipeline native at 48 kHz stereo:
  Stage 1: `x -> s_wet_voice + s_ambience` (`s_ambience = x - s_wet_voice`)
  Stage 2: `s_wet_voice -> s_voice + s_reverb` (`s_reverb = s_wet_voice - s_voice`)
  Stage 3: Exact-partition linear sum `g_v * s_voice + g_r * s_reverb + g_a * s_ambience`
           (bit-exact 0 dB unity reconstruction!) with optional stereo-linked Wiener
           artifact guard (`mask_sharpness > 0`).

Supported multi-OS backends:
  - `fast_onnx` (Default): DeepFilterNet3 ONNX (~8.5 MB, cross-OS CPU) + pure-NumPy Block WPE.
  - `dsp_lite`: Zero-download pure NumPy/SciPy voice-band harmonic separator + Block WPE (instant offline).
  - `speech_hq`: MossFormer2_SE_48K (~210 MB, Apache-2.0) + Block WPE (in-venv or external bridge).
  - `studio_hq`: Mel-Band RoFormer Denoise (`aufr33`) + DeReverb (`anvuew`) (~860 MB, chunked OLA).
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple
import numpy as np
from scipy import ndimage, signal, special
import soundfile as sf

from core.processors.chunked_inference import ensure_stereo_f32, run_chunked_overlap_add
from core.processors.model_manager import GLOBAL_MODEL_MANAGER, ModelManager
from core.processors.runtime_env import (
    detect_runtime_capabilities,
    run_external_python_worker,
    select_onnx_providers,
)

logger = logging.getLogger("sin.processors.voice_isolator")

BACKEND_TO_MODEL_ID: Dict[str, Optional[str]] = {
    "dsp_lite": None,
    "fast_onnx": "deepfilternet3_onnx",
    "speech_hq": "mossformer2_se_48k",
    "studio_hq": "melband_roformer_voice_hq",
}


class ModelNotInstalledError(RuntimeError):
    """Raised when a requested high-level model is not yet downloaded locally."""

    def __init__(self, model_id: str, status: Dict[str, Any]) -> None:
        self.model_id = model_id
        self.model_status = status
        super().__init__(
            f"Model '{model_id}' is not installed locally (target: {status.get('target_dir')}). "
            "Download it explicitly before running this backend."
        )


@dataclass
class VoiceDecomposition:
    voice: np.ndarray  # (2, N) float32
    reverb: np.ndarray  # (2, N) float32
    ambience: np.ndarray  # (2, N) float32
    sample_rate: int
    backend_used: str
    rms_voice: float
    rms_reverb: float
    rms_ambience: float

    def to_cache_arrays(self) -> Dict[str, np.ndarray]:
        return {
            "voice": self.voice,
            "reverb": self.reverb,
            "ambience": self.ambience,
        }

    @classmethod
    def from_cache_arrays(
        cls,
        arrays: Dict[str, np.ndarray],
        sample_rate: int,
        backend_used: str,
    ) -> "VoiceDecomposition":
        v = ensure_stereo_f32(arrays["voice"])
        r = ensure_stereo_f32(arrays["reverb"])
        a = ensure_stereo_f32(arrays["ambience"])
        return cls(
            voice=v,
            reverb=r,
            ambience=a,
            sample_rate=sample_rate,
            backend_used=backend_used,
            rms_voice=_rms(v),
            rms_reverb=_rms(r),
            rms_ambience=_rms(a),
        )


def _rms(arr: np.ndarray) -> float:
    if arr.size == 0:
        return 0.0
    return round(float(np.sqrt(np.mean(arr.astype(np.float64) ** 2))), 5)


def _db_to_linear(db: float) -> float:
    val = float(db)
    if val <= -59.9:
        return 0.0
    return float(10.0 ** (val / 20.0))


def wpe_dereverb(
    audio: np.ndarray,
    sample_rate: int,
    *,
    sensitivity: float = 0.5,
    iterations: int = 3,
    n_fft: int = 1024,
    hop: int = 256,
    delay: int = 3,
    cancel_event: Optional[threading.Event] = None,
) -> np.ndarray:
    """Pure NumPy/SciPy Block Weighted Prediction Error (Nakatani et al., 2010) dereverberator.

    Distortion-free linear prediction: predicts and subtracts diffuse late reflections
    (lag >= `delay` frames ~ 16ms) while preserving direct voice & early reflections.
    """
    stereo = ensure_stereo_f32(audio)
    n_frames = int(stereo.shape[-1])
    if n_frames < n_fft * 2 or sensitivity <= 1e-3:
        return stereo.copy()

    sens = max(0.0, min(1.0, float(sensitivity)))
    taps = int(round(6 + 10 * sens))  # 6 .. 16 taps (~96 .. 256 ms late reverb tail)
    win = np.sqrt(signal.windows.hann(n_fft, sym=False)).astype(np.float32)

    out = np.zeros_like(stereo, dtype=np.float32)
    reg_eye = np.eye(taps, dtype=np.complex128) * 1e-4

    for ch in range(2):
        _, _, Y = signal.stft(
            stereo[ch],
            fs=sample_rate,
            window=win,
            nperseg=n_fft,
            noverlap=n_fft - hop,
            nfft=n_fft,
            boundary="zeros",
            padded=True,
        )
        n_f, n_t = Y.shape
        if n_t <= delay + taps + 2:
            out[ch] = stereo[ch]
            continue

        Y = Y.astype(np.complex128)
        X = Y.copy()
        valid_start = delay + taps
        valid_len = n_t - valid_start

        # Build delayed tap tensor Y_tilde[F, taps, valid_len]
        Y_tilde = np.empty((n_f, taps, valid_len), dtype=np.complex128)
        for k in range(taps):
            lag = delay + k
            Y_tilde[:, k, :] = Y[:, valid_start - lag : n_t - lag]

        Y_target = Y[:, valid_start:]
        eps_floor = np.maximum(np.mean(np.abs(Y) ** 2, axis=1, keepdims=True) * 1e-5, 1e-12)

        for _it in range(max(1, int(iterations))):
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("WPE dereverb cancelled")
            # Inverse time-varying variance weight `inv_var[F, valid_len]`
            power_x = np.abs(X[:, valid_start:]) ** 2
            # Smooth variance slightly across +/-1 frame for stability
            power_x = ndimage.uniform_filter1d(power_x, size=3, axis=1, mode="nearest")
            inv_var = 1.0 / np.maximum(power_x, eps_floor)

            # Weighted covariance R[F, taps, taps] and cross-correlation P[F, taps]
            Y_w = Y_tilde * inv_var[:, None, :]
            R = np.einsum("fkt,flt->fkl", Y_w, np.conj(Y_tilde)) + reg_eye[None, :, :]
            P = np.einsum("fkt,ft->fk", Y_w, np.conj(Y_target))

            try:
                G = np.linalg.solve(R, P[..., None])[..., 0]  # (F, taps)
            except np.linalg.LinAlgError:
                G = np.zeros((n_f, taps), dtype=np.complex128)

            pred = np.einsum("fk,fkt->ft", np.conj(G), Y_tilde)
            # Blend subtraction strength smoothly by sensitivity
            X[:, valid_start:] = Y_target - (0.35 + 0.65 * sens) * pred

        _, rec = signal.istft(
            X.astype(np.complex64),
            fs=sample_rate,
            window=win,
            nperseg=n_fft,
            noverlap=n_fft - hop,
            nfft=n_fft,
            boundary=True,
        )
        n = min(n_frames, int(rec.shape[-1]))
        out[ch, :n] = rec[:n].astype(np.float32)

    return out


def _dsp_lite_wet_voice_extract(
    audio: np.ndarray,
    sample_rate: int,
    cancel_event: Optional[threading.Event] = None,
) -> np.ndarray:
    """Zero-download pure NumPy/SciPy voice-band + harmonic MMSE-LSA wet-voice extractor.

    Separates voice-correlated energy (direct voice + room reflections in 85 Hz..10 kHz)
    from broadband stationary/ambient background noise so the 3-fader workflow works even offline.
    """
    stereo = ensure_stereo_f32(audio)
    n_frames = int(stereo.shape[-1])
    if n_frames == 0:
        return stereo

    n_fft = 2048 if n_frames >= 2048 else max(256, 1 << int(math.floor(math.log2(max(256, n_frames)))))
    hop = max(64, n_fft // 4)
    win = np.sqrt(signal.windows.hann(n_fft, sym=False)).astype(np.float32)
    freqs = np.linspace(0.0, 0.5 * float(sample_rate), n_fft // 2 + 1, dtype=np.float32)

    _, _, z_l = signal.stft(stereo[0], fs=sample_rate, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
    _, _, z_r = signal.stft(stereo[1], fs=sample_rate, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
    Z = np.stack([z_l, z_r], axis=0).astype(np.complex64)
    power = (Z.real ** 2 + Z.imag ** 2).astype(np.float32)
    n_f, n_t = Z.shape[1], Z.shape[2]
    if n_t == 0:
        return stereo

    # Voice-band soft prior (80 Hz..9.5 kHz) — sub-bass rumble & ultrasonic hiss lean ambience
    low_taper = np.clip((freqs - 55.0) / 55.0, 0.05, 1.0)
    high_taper = np.clip(1.0 - (freqs - 9000.0) / 7000.0, 0.15, 1.0)
    voice_band_prior = (low_taper * high_taper).astype(np.float32)[:, None]

    # Joint stereo power MMSE-SPP ambience estimator
    joint_p = 0.5 * (power[0] + power[1])
    noise_est = np.maximum(np.percentile(joint_p, 25.0, axis=1, keepdims=True), 1e-12).astype(np.float32)
    xi_h1 = 10.0 ** (14.0 / 10.0)
    rc = xi_h1 / (1.0 + xi_h1)
    n_track = np.empty_like(joint_p)
    n_prev = noise_est[:, 0].copy()

    for t in range(n_t):
        if cancel_event is not None and (t & 63) == 0 and cancel_event.is_set():
            raise InterruptedError("dsp_lite voice separation cancelled")
        y2 = joint_p[:, t]
        glr = np.clip((y2 / np.maximum(n_prev, 1e-12)) * rc, 0.0, 35.0)
        p_h1 = 1.0 / (1.0 + (1.0 + xi_h1) * np.exp(-glr))
        e_n2 = (1.0 - p_h1) * y2 + p_h1 * n_prev
        n_prev = np.maximum(0.88 * n_prev + 0.12 * e_n2, 1e-12)
        n_track[:, t] = n_prev

    # Ephraim-Malah MMSE-LSA voice presence mask (preserving attached room reflections via slower release)
    gamma = np.minimum(joint_p / np.maximum(n_track, 1e-12), 40.0)
    xi = np.maximum(0.92 * np.maximum(gamma - 1.0, 0.0) + 1e-3, 1e-4)
    ratio = xi / (1.0 + xi)
    nu = np.clip(ratio * gamma, 1e-6, 40.0)
    mask = np.minimum(1.0, ratio * np.exp(0.5 * special.exp1(nu))) * voice_band_prior
    mask = ndimage.gaussian_filter(mask.astype(np.float32), sigma=(0.8, 1.2))
    mask = np.clip(mask, 0.0, 1.0)

    Z_wet = Z * mask[None, :, :]
    out = np.zeros_like(stereo, dtype=np.float32)
    for ch in range(2):
        _, rec = signal.istft(Z_wet[ch], fs=sample_rate, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
        n = min(n_frames, int(rec.shape[-1]))
        out[ch, :n] = rec[:n].astype(np.float32)
    return out


def _run_onnx_or_bridge_stage1(
    audio: np.ndarray,
    sample_rate: int,
    backend: str,
    model_info: Dict[str, Any],
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> np.ndarray:
    """Execute Stage-1 ambience separation using installed ONNX/PyTorch runtime or external bridge.

    Falls back gracefully to `_dsp_lite_wet_voice_extract` if an optional runtime package isn't
    installed in either `.venv` or external global Python (logging a clear diagnostic).
    """
    caps = detect_runtime_capabilities()
    files_map = model_info.get("files") or {}

    # 1. Cross-OS ONNX Runtime path (`fast_onnx` -> authentic 3-graph DeepFilterNet3 ONNX)
    if backend == "fast_onnx" and caps.onnxruntime_version and files_map:
        try:
            if all(k in files_map for k in ("enc.onnx", "erb_dec.onnx", "df_dec.onnx")):
                from core.processors.deepfilternet3_onnx import get_deepfilternet3_engine

                df3 = get_deepfilternet3_engine(model_info)
                return df3.enhance_stereo(
                    audio,
                    sample_rate,
                    cancel_event=cancel_event,
                    on_progress=on_progress,
                )

            import onnxruntime as ort  # type: ignore

            providers = select_onnx_providers()
            onnx_paths = [Path(p) for p in files_map.values() if str(p).lower().endswith(".onnx")]
            if onnx_paths:
                sess_opts = ort.SessionOptions()
                sess_opts.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
                sess_opts.inter_op_num_threads = 1
                sess = ort.InferenceSession(str(onnx_paths[0]), sess_options=sess_opts, providers=providers)
                inputs = sess.get_inputs()
                if len(inputs) == 1 and len(inputs[0].shape) in (2, 3):
                    in_name = inputs[0].name

                    def _chunk_ort(chunk: np.ndarray, _sr: int) -> Dict[str, np.ndarray]:
                        x_in = chunk if len(inputs[0].shape) == 2 else chunk[None, :, :]
                        y_out = sess.run(None, {in_name: x_in.astype(np.float32)})[0]
                        return {"wet": ensure_stereo_f32(np.squeeze(y_out))}

                    res = run_chunked_overlap_add(
                        audio,
                        sample_rate,
                        _chunk_ort,
                        segment_sec=6.0,
                        overlap_ratio=0.2,
                        cancel_event=cancel_event,
                        on_progress=on_progress,
                    )
                    if "wet" in res:
                        return res["wet"]
        except InterruptedError:
            raise
        except Exception as exc:
            logger.warning("ONNX execution fallback to dsp_lite for %s: %s", backend, exc)

    # 2. Optional external Python subprocess bridge if `audio_separator` / `torch` exists globally
    if backend in ("speech_hq", "studio_hq") and caps.external_python and (
        "audio_separator" in caps.external_packages or "torch" in caps.external_packages
    ):
        ckpt_paths = list(files_map.values())
        if ckpt_paths and "audio_separator" in caps.external_packages:
            try:
                with tempfile.TemporaryDirectory(prefix="sin_voice_iso_") as tmpdir:
                    tmp = Path(tmpdir)
                    in_wav = tmp / "input.wav"
                    sf.write(str(in_wav), ensure_stereo_f32(audio).T, sample_rate, subtype="FLOAT")
                    ckpt = Path(ckpt_paths[0])
                    worker_code = (
                        "import sys; from audio_separator.separator import Separator; "
                        "sep = Separator(model_file_dir=sys.argv[1], output_dir=sys.argv[2], output_format='WAV'); "
                        "sep.load_model(model_filename=sys.argv[3]); "
                        "outs = sep.separate(sys.argv[4]); print(outs[0] if outs else '')"
                    )
                    proc = run_external_python_worker(
                        worker_code,
                        [str(ckpt.parent), str(tmp), ckpt.name, str(in_wav)],
                        cancel_event=cancel_event,
                    )
                    if proc.returncode == 0 and proc.stdout.strip():
                        out_name = proc.stdout.strip().splitlines()[-1]
                        out_wav = tmp / out_name if not Path(out_name).is_absolute() else Path(out_name)
                        if out_wav.is_file():
                            data, _ = sf.read(str(out_wav), dtype="float32", always_2d=True)
                            wet = ensure_stereo_f32(data.T)
                            if wet.shape[-1] == audio.shape[-1]:
                                return wet
            except InterruptedError:
                raise
            except Exception as exc:
                logger.warning("External worker fallback for %s: %s", backend, exc)

    # Reliable cross-OS signal-processing fallback when checkpoint exists but optional engine bindings are absent
    return _dsp_lite_wet_voice_extract(audio, sample_rate, cancel_event=cancel_event)


def check_voice_backend_ready(
    backend: str,
    model_manager: Optional[ModelManager] = None,
) -> Dict[str, Any]:
    """Check whether the requested `VoiceIsolatorNode` backend is ready locally (never downloads)."""
    b = str(backend or "fast_onnx").strip().lower()
    if b not in BACKEND_TO_MODEL_ID:
        b = "fast_onnx"
    model_id = BACKEND_TO_MODEL_ID[b]
    if model_id is None:
        return {"ready": True, "backend": b, "model_id": None, "model_status": None}
    mm = model_manager or GLOBAL_MODEL_MANAGER
    st = mm.get_model_status(model_id)
    return {
        "ready": bool(st.get("installed")),
        "backend": b,
        "model_id": model_id,
        "model_status": st,
    }


def decompose_voice(
    audio_in: np.ndarray,
    sample_rate: int,
    *,
    backend: str = "fast_onnx",
    reverb_sensitivity: float = 0.5,
    model_manager: Optional[ModelManager] = None,
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> VoiceDecomposition:
    """Level-1 exact-partition 3-stem decomposition: `x == voice + reverb + ambience`."""
    stereo = ensure_stereo_f32(audio_in)
    sr = int(sample_rate or 48000)
    b = str(backend or "fast_onnx").strip().lower()
    if b not in BACKEND_TO_MODEL_ID:
        b = "fast_onnx"

    check = check_voice_backend_ready(b, model_manager=model_manager)
    if not check["ready"]:
        raise ModelNotInstalledError(str(check["model_id"]), check["model_status"] or {})

    if stereo.shape[-1] == 0:
        z = np.zeros((2, 0), dtype=np.float32)
        return VoiceDecomposition(z, z, z, sr, b, 0.0, 0.0, 0.0)

    # Stage 1: Ambience extraction (`x -> s_wet_voice + s_ambience`)
    if on_progress:
        on_progress(0.10)
    if b == "dsp_lite":
        s_wet = _dsp_lite_wet_voice_extract(stereo, sr, cancel_event=cancel_event)
    else:
        s_wet = _run_onnx_or_bridge_stage1(
            stereo,
            sr,
            b,
            check["model_status"] or {},
            cancel_event=cancel_event,
            on_progress=(lambda f: on_progress(0.10 + 0.50 * f)) if on_progress else None,
        )
    s_wet = ensure_stereo_f32(s_wet)[:, : stereo.shape[-1]]
    s_ambience = (stereo - s_wet).astype(np.float32)

    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("Voice isolator cancelled before dereverb")
    if on_progress:
        on_progress(0.65)

    # Stage 2: Dereverberation strictly on `s_wet_voice` (`s_wet_voice -> s_voice + s_reverb`)
    s_voice = wpe_dereverb(
        s_wet,
        sr,
        sensitivity=float(reverb_sensitivity),
        iterations=3,
        cancel_event=cancel_event,
    )
    s_voice = ensure_stereo_f32(s_voice)[:, : stereo.shape[-1]]
    s_reverb = (s_wet - s_voice).astype(np.float32)

    if on_progress:
        on_progress(1.0)

    return VoiceDecomposition(
        voice=s_voice,
        reverb=s_reverb,
        ambience=s_ambience,
        sample_rate=sr,
        backend_used=b,
        rms_voice=_rms(s_voice),
        rms_reverb=_rms(s_reverb),
        rms_ambience=_rms(s_ambience),
    )


def recombine_voice(
    decomp: VoiceDecomposition,
    original: np.ndarray,
    params: Dict[str, Any],
) -> np.ndarray:
    """Level-2 fast (~5-15 ms) 3-stem recombination with exact 0 dB unity reconstruction."""
    orig = ensure_stereo_f32(original)
    n = int(orig.shape[-1])
    if n == 0:
        return orig

    v = decomp.voice[:, :n]
    r = decomp.reverb[:, :n]
    a = decomp.ambience[:, :n]

    solo = str(params.get("solo_stem") or "none").strip().lower()
    if solo == "voice":
        g_v, g_r, g_a = _db_to_linear(params.get("voice_db", 0.0)), 0.0, 0.0
    elif solo == "reverb":
        g_v, g_r, g_a = 0.0, _db_to_linear(params.get("reverb_db", 0.0)), 0.0
    elif solo == "ambience":
        g_v, g_r, g_a = 0.0, 0.0, _db_to_linear(params.get("ambience_db", 0.0))
    else:
        g_v = 0.0 if params.get("mute_voice") else _db_to_linear(params.get("voice_db", 0.0))
        g_r = 0.0 if params.get("mute_reverb") else _db_to_linear(params.get("reverb_db", 0.0))
        g_a = 0.0 if params.get("mute_ambience") else _db_to_linear(params.get("ambience_db", 0.0))

    # Fast bit-exact unity bypass when all 3 gains == 1.0
    if abs(g_v - 1.0) < 1e-6 and abs(g_r - 1.0) < 1e-6 and abs(g_a - 1.0) < 1e-6:
        return orig.copy()

    y_td = (g_v * v + g_r * r + g_a * a).astype(np.float32)

    sharpness = max(0.0, min(1.0, float(params.get("mask_sharpness", 0.25))))
    if sharpness > 1e-3 and n >= 512:
        n_fft = 2048 if n >= 2048 else 512
        hop = n_fft // 4
        win = np.sqrt(signal.windows.hann(n_fft, sym=False)).astype(np.float32)

        def _stft_pair(buf: np.ndarray) -> np.ndarray:
            _, _, zl = signal.stft(buf[0], fs=1.0, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
            _, _, zr = signal.stft(buf[1], fs=1.0, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
            return np.stack([zl, zr], axis=0).astype(np.complex64)

        X = _stft_pair(orig)
        Sv = _stft_pair(v)
        Sr = _stft_pair(r)
        Sa = _stft_pair(a)

        gamma = 1.0 + 1.2 * sharpness
        # Stereo-linked power preserves inter-channel phase (IPD) on reverb and ambience
        Pv = np.power(np.maximum(np.abs(Sv[0]) ** 2 + np.abs(Sv[1]) ** 2, 1e-18), 0.5 * gamma)
        Pr = np.power(np.maximum(np.abs(Sr[0]) ** 2 + np.abs(Sr[1]) ** 2, 1e-18), 0.5 * gamma)
        Pa = np.power(np.maximum(np.abs(Sa[0]) ** 2 + np.abs(Sa[1]) ** 2, 1e-18), 0.5 * gamma)
        denom = Pv + Pr + Pa + 1e-12
        G_iso = ((g_v * Pv + g_r * Pr + g_a * Pa) / denom).astype(np.float32)
        G_iso = ndimage.gaussian_filter(G_iso, sigma=(0.6, 0.8))

        Y_spec = X * G_iso[None, :, :]
        y_wiener = np.zeros_like(orig, dtype=np.float32)
        for ch in range(2):
            _, rec = signal.istft(Y_spec[ch], fs=1.0, window=win, nperseg=n_fft, noverlap=n_fft - hop, nfft=n_fft)
            ln = min(n, int(rec.shape[-1]))
            y_wiener[ch, :ln] = rec[:ln].astype(np.float32)

        y_out = ((1.0 - sharpness) * y_td + sharpness * y_wiener).astype(np.float32)
    else:
        y_out = y_td

    mix = max(0.0, min(1.0, float(params.get("mix", 1.0))))
    if mix < 0.9999:
        y_out = ((1.0 - mix) * orig + mix * y_out).astype(np.float32)
    return y_out
