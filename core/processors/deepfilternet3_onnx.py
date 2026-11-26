"""Authentic Cross-OS DeepFilterNet3 ONNX Inference Engine (48 kHz, pure NumPy/SciPy + ONNX Runtime).

Implements the exact Rikorose/DeepFilterNet3 3-graph ONNX pipeline (`enc.onnx`, `erb_dec.onnx`, `df_dec.onnx`):
  - Vorbis 960-sample analysis/synthesis window (`hop=480`, exact 50% COLA reconstruction)
  - 32-band ERB filterbank (`min_nb_freqs=2`) + exponential running mean normalization
  - 96-bin complex spectrogram (`0..4.8 kHz`) + exponential running unit normalization
  - Sequence-batched ONNX Runtime inference (`CPUExecutionProvider` / standard cross-OS providers)
  - ERB spectral mask (`96..480`) + 5-tap complex Deep Filtering (`0..95`, `df_lookahead=2`)
"""

from __future__ import annotations

import configparser
import logging
import math
import os
from pathlib import Path
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple
import numpy as np
from scipy import signal

from core.processors.chunked_inference import ensure_stereo_f32
from core.processors.runtime_env import select_onnx_providers

logger = logging.getLogger("sin.processors.deepfilternet3_onnx")

_SESSION_LOCK = threading.RLock()
_SESSION_CACHE: Dict[str, "DeepFilterNet3Onnx"] = {}


def _freq2erb(freq_hz: float) -> float:
    return 9.265 * math.log1p(freq_hz / (24.7 * 9.265))


def _erb2freq(n_erb: float) -> float:
    return 24.7 * 9.265 * (math.exp(n_erb / 9.265) - 1.0)


def compute_erb_widths(sr: int = 48000, fft_size: int = 960, nb_bands: int = 32, min_nb_freqs: int = 2) -> np.ndarray:
    """Exact port of `libDF::erb_fb`."""
    nyq = sr // 2
    freq_width = float(sr) / float(fft_size)
    erb_low = _freq2erb(0.0)
    erb_high = _freq2erb(float(nyq))
    step = (erb_high - erb_low) / float(nb_bands)
    erb = [0] * nb_bands
    prev_freq = 0
    freq_over = 0
    for i in range(1, nb_bands + 1):
        f = _erb2freq(erb_low + i * step)
        fb = int(round(f / freq_width))
        nb_freqs = fb - prev_freq - freq_over
        if nb_freqs < min_nb_freqs:
            freq_over = min_nb_freqs - nb_freqs
            nb_freqs = min_nb_freqs
        else:
            freq_over = 0
        erb[i - 1] = nb_freqs
        prev_freq = fb
    erb[nb_bands - 1] += 1
    too_large = sum(erb) - (fft_size // 2 + 1)
    if too_large > 0:
        erb[nb_bands - 1] -= too_large
    return np.asarray(erb, dtype=np.int32)


def vorbis_window(fft_size: int = 960) -> np.ndarray:
    """Exact port of `libDF` Vorbis window (`w[i]^2 + w[i + N/2]^2 == 1`)."""
    half = fft_size // 2
    idx = np.arange(fft_size, dtype=np.float64)
    s = np.sin(0.5 * np.pi * (idx + 0.5) / float(half))
    return np.sin(0.5 * np.pi * s * s).astype(np.float32)


def _stft_df3(x_mono: np.ndarray, window: np.ndarray, fft_size: int, hop_size: int) -> np.ndarray:
    """Zero-latency `libDF`-compatible forward STFT returning `spec[T, F]` complex64."""
    n = int(x_mono.shape[-1])
    pad_front = fft_size - hop_size
    n_frames = int(math.ceil((n + pad_front) / float(hop_size)))
    total_len = (n_frames - 1) * hop_size + fft_size
    pad_end = max(0, total_len - pad_front - n)
    padded = np.pad(x_mono.astype(np.float32, copy=False), (pad_front, pad_end), mode="constant")

    # Strided framing `(T, fft_size)`
    strides = (padded.strides[0] * hop_size, padded.strides[0])
    frames = np.lib.stride_tricks.as_strided(padded, shape=(n_frames, fft_size), strides=strides)
    wnorm = 1.0 / (float(fft_size * fft_size) / float(2 * hop_size))
    spec = np.fft.rfft(frames * window[None, :], axis=1) * wnorm
    return spec.astype(np.complex64, copy=False)


def _istft_df3(spec: np.ndarray, window: np.ndarray, fft_size: int, hop_size: int, target_len: int) -> np.ndarray:
    """Exact `libDF`-compatible inverse STFT matching `_stft_df3` with latency compensation."""
    n_frames = int(spec.shape[0])
    if n_frames == 0:
        return np.zeros(target_len, dtype=np.float32)
    # `realfft::ComplexToReal` is unnormalized (`fft_size * irfft`)
    time_frames = (np.fft.irfft(spec, n=fft_size, axis=1) * float(fft_size)).astype(np.float32)
    time_frames *= window[None, :]

    out_len = (n_frames - 1) * hop_size + fft_size
    buf = np.zeros(out_len, dtype=np.float32)
    for t in range(n_frames):
        s = t * hop_size
        buf[s : s + fft_size] += time_frames[t]

    pad_front = fft_size - hop_size
    sliced = buf[pad_front : pad_front + target_len]
    if sliced.shape[0] < target_len:
        out = np.zeros(target_len, dtype=np.float32)
        out[: sliced.shape[0]] = sliced
        return out
    return sliced.astype(np.float32, copy=False)


def _extract_features(
    spec: np.ndarray,
    erb_widths: np.ndarray,
    nb_df: int,
    alpha: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute `(feat_erb[1, 1, T, 32], feat_spec[1, 2, T, 96])` matching `libDF`."""
    n_t = int(spec.shape[0])
    nb_erb = int(erb_widths.shape[0])
    power = (spec.real * spec.real + spec.imag * spec.imag).astype(np.float32)

    # ERB band mean energy -> dB
    erb_db = np.empty((n_t, nb_erb), dtype=np.float32)
    col = 0
    for b in range(nb_erb):
        w = int(erb_widths[b])
        band_e = np.mean(power[:, col : col + w], axis=1)
        erb_db[:, b] = np.log10(band_e + 1e-10) * 10.0
        col += w

    # Exponential running mean normalization (`MEAN_NORM_INIT = [-60, -90]`)
    one_m = np.float32(1.0 - alpha)
    a32 = np.float32(alpha)
    mean_state = np.linspace(-60.0, -90.0, nb_erb, dtype=np.float32)
    feat_erb = np.empty((n_t, nb_erb), dtype=np.float32)
    for t in range(n_t):
        x = erb_db[t]
        mean_state = x * one_m + mean_state * a32
        feat_erb[t] = (x - mean_state) / 40.0

    # Exponential running unit normalization on first `nb_df` complex bins (`UNIT_NORM_INIT = [0.001, 0.0001]`)
    spec_df = spec[:, :nb_df]
    mag_df = np.abs(spec_df).astype(np.float32)
    unit_state = np.linspace(0.001, 0.0001, nb_df, dtype=np.float32)
    feat_spec = np.empty((2, n_t, nb_df), dtype=np.float32)
    for t in range(n_t):
        unit_state = mag_df[t] * one_m + unit_state * a32
        inv_s = 1.0 / np.sqrt(np.maximum(unit_state, 1e-12))
        feat_spec[0, t] = spec_df[t].real * inv_s
        feat_spec[1, t] = spec_df[t].imag * inv_s

    return feat_erb[None, None, :, :], feat_spec[None, :, :, :]


class DeepFilterNet3Onnx:
    """Cached 3-graph ONNX Runtime session wrapper for DeepFilterNet3."""

    def __init__(self, model_dir: Path, files_map: Dict[str, str]) -> None:
        import onnxruntime as ort  # type: ignore

        self.model_dir = Path(model_dir)
        self.sr = 48000
        self.fft_size = 960
        self.hop_size = 480
        self.nb_erb = 32
        self.nb_df = 96
        self.min_nb_erb_freqs = 2
        self.df_order = 5
        self.df_lookahead = 2
        self.conv_lookahead = 2
        self.norm_tau = 1.0

        cfg_path = Path(files_map.get("config.ini") or (self.model_dir / "config.ini"))
        if cfg_path.is_file():
            cp = configparser.ConfigParser()
            cp.read(cfg_path, encoding="utf-8")
            if cp.has_section("df"):
                self.sr = cp.getint("df", "sr", fallback=48000)
                self.fft_size = cp.getint("df", "fft_size", fallback=960)
                self.hop_size = cp.getint("df", "hop_size", fallback=480)
                self.nb_erb = cp.getint("df", "nb_erb", fallback=32)
                self.nb_df = cp.getint("df", "nb_df", fallback=96)
                self.min_nb_erb_freqs = cp.getint("df", "min_nb_erb_freqs", fallback=2)
                self.df_order = cp.getint("df", "df_order", fallback=5)
                self.df_lookahead = cp.getint("df", "df_lookahead", fallback=2)
                self.norm_tau = cp.getfloat("df", "norm_tau", fallback=1.0)
            if cp.has_section("deepfilternet"):
                self.conv_lookahead = cp.getint("deepfilternet", "conv_lookahead", fallback=2)

        self.window = vorbis_window(self.fft_size)
        self.erb_widths = compute_erb_widths(self.sr, self.fft_size, self.nb_erb, self.min_nb_erb_freqs)
        self.alpha = math.exp(-float(self.hop_size) / max(1e-6, float(self.sr) * self.norm_tau))

        providers = select_onnx_providers()
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # Keep half of CPU cores free so FastAPI, WebSocket telemetry, audio & UI stay silky responsive
        sess_opts.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
        sess_opts.inter_op_num_threads = 1

        enc_path = str(files_map.get("enc.onnx") or (self.model_dir / "enc.onnx"))
        erb_path = str(files_map.get("erb_dec.onnx") or (self.model_dir / "erb_dec.onnx"))
        df_path = str(files_map.get("df_dec.onnx") or (self.model_dir / "df_dec.onnx"))

        self.enc_sess = ort.InferenceSession(enc_path, sess_options=sess_opts, providers=providers)
        self.erb_sess = ort.InferenceSession(erb_path, sess_options=sess_opts, providers=providers)
        self.df_sess = ort.InferenceSession(df_path, sess_options=sess_opts, providers=providers)

    def enhance_mono_48k(
        self,
        x_mono: np.ndarray,
        *,
        chunk_frames: int = 1200,  # ~12 seconds per chunk at 10 ms hop
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> np.ndarray:
        n = int(x_mono.shape[-1])
        if n == 0:
            return x_mono.astype(np.float32, copy=True)

        spec = _stft_df3(x_mono, self.window, self.fft_size, self.hop_size)  # (T, 481)
        n_t = int(spec.shape[0])
        if n_t == 0:
            return x_mono.astype(np.float32, copy=True)

        feat_erb_all, feat_spec_all = _extract_features(spec, self.erb_widths, self.nb_df, self.alpha)

        # Apply causal conv_lookahead shift (`ConstantPad2d((0, 0, -L, L), 0)`) matching `DfNet.forward`
        la = max(0, int(self.conv_lookahead))
        if la > 0 and n_t > la:
            fe_shifted = np.zeros_like(feat_erb_all)
            fs_shifted = np.zeros_like(feat_spec_all)
            fe_shifted[:, :, :-la, :] = feat_erb_all[:, :, la:, :]
            fs_shifted[:, :, :-la, :] = feat_spec_all[:, :, la:, :]
        else:
            fe_shifted = feat_erb_all
            fs_shifted = feat_spec_all

        # Run ONNX inference in bounded sequence chunks with modest overlap to prevent GRU cold-start seams
        overlap = 40  # 400 ms GRU warmup context
        step = max(64, int(chunk_frames) - overlap)
        m_all = np.ones((n_t, self.nb_erb), dtype=np.float32)
        coefs_all = np.zeros((n_t, self.nb_df, self.df_order, 2), dtype=np.float32)

        starts = list(range(0, n_t, step))
        for idx, st in enumerate(starts):
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("DeepFilterNet3 ONNX inference cancelled")

            ctx_st = max(0, st - overlap)
            end = min(n_t, st + step)
            fe_in = np.ascontiguousarray(fe_shifted[:, :, ctx_st:end, :], dtype=np.float32)
            fs_in = np.ascontiguousarray(fs_shifted[:, :, ctx_st:end, :], dtype=np.float32)

            e0, e1, e2, e3, emb, c0, _lsnr = self.enc_sess.run(
                None, {"feat_erb": fe_in, "feat_spec": fs_in}
            )
            (m_chunk,) = self.erb_sess.run(
                None, {"emb": emb, "e3": e3, "e2": e2, "e1": e1, "e0": e0}
            )
            df_outs = self.df_sess.run(None, {"emb": emb, "c0": c0})
            c_chunk = df_outs[0]  # [1, S, nb_df, df_order * 2]

            trim = st - ctx_st
            m_valid = m_chunk[0, 0, trim:, :]
            c_valid = c_chunk[0, trim:, :, :].reshape(-1, self.nb_df, self.df_order, 2)
            valid_len = end - st
            m_all[st:end] = m_valid[:valid_len]
            coefs_all[st:end] = c_valid[:valid_len]

            if on_progress:
                on_progress(float(idx + 1) / float(max(1, len(starts))))

        # 1. Expand 32-band ERB mask back to all 481 FFT bins
        m_full = np.repeat(m_all, self.erb_widths, axis=1)  # (T, 481)
        spec_m = spec * m_full

        # 2. Apply 5-tap complex Deep Filtering on bins `0..nb_df-1` (`df_lookahead=2`)
        pad_before = self.df_order - 1 - self.df_lookahead
        pad_after = self.df_lookahead
        spec_df_pad = np.pad(spec[:, : self.nb_df], ((pad_before, pad_after), (0, 0)), mode="constant")
        out_re = np.zeros((n_t, self.nb_df), dtype=np.float32)
        out_im = np.zeros((n_t, self.nb_df), dtype=np.float32)
        for k in range(self.df_order):
            s_slice = spec_df_pad[k : k + n_t]
            c_re = coefs_all[:, :, k, 0]
            c_im = coefs_all[:, :, k, 1]
            out_re += s_slice.real * c_re - s_slice.imag * c_im
            out_im += s_slice.imag * c_re + s_slice.real * c_im

        spec_enh = spec_m.copy()
        spec_enh[:, : self.nb_df] = out_re + 1j * out_im

        return _istft_df3(spec_enh, self.window, self.fft_size, self.hop_size, n)

    def enhance_stereo(
        self,
        audio: np.ndarray,
        sample_rate: int,
        *,
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> np.ndarray:
        stereo = ensure_stereo_f32(audio)
        n_orig = int(stereo.shape[-1])
        if n_orig == 0:
            return stereo.copy()

        sr = int(sample_rate or 48000)
        if sr != self.sr:
            g = math.gcd(self.sr, sr)
            up, down = self.sr // g, sr // g
            work_l = signal.resample_poly(stereo[0], up, down).astype(np.float32)
            work_r = signal.resample_poly(stereo[1], up, down).astype(np.float32)
        else:
            work_l, work_r = stereo[0], stereo[1]

        # If input is dual-mono (identical L and R), run once and duplicate (2x faster!)
        is_mono_dup = bool(np.max(np.abs(work_l - work_r)) < 1e-6)
        if is_mono_dup:
            enh_l = self.enhance_mono_48k(work_l, cancel_event=cancel_event, on_progress=on_progress)
            enh_r = enh_l.copy()
        else:
            enh_l = self.enhance_mono_48k(
                work_l,
                cancel_event=cancel_event,
                on_progress=(lambda f: on_progress(0.5 * f)) if on_progress else None,
            )
            enh_r = self.enhance_mono_48k(
                work_r,
                cancel_event=cancel_event,
                on_progress=(lambda f: on_progress(0.5 + 0.5 * f)) if on_progress else None,
            )

        if sr != self.sr:
            g = math.gcd(sr, self.sr)
            up, down = sr // g, self.sr // g
            enh_l = signal.resample_poly(enh_l, up, down).astype(np.float32)
            enh_r = signal.resample_poly(enh_r, up, down).astype(np.float32)

        out = np.zeros((2, n_orig), dtype=np.float32)
        ln = min(n_orig, int(enh_l.shape[-1]), int(enh_r.shape[-1]))
        out[0, :ln] = enh_l[:ln]
        out[1, :ln] = enh_r[:ln]
        return out


def get_deepfilternet3_engine(model_info: Dict[str, Any]) -> DeepFilterNet3Onnx:
    """Return a cached `DeepFilterNet3Onnx` engine for the resolved model directory."""
    loc = str(model_info.get("location") or "")
    files_map = model_info.get("files") or {}
    cache_key = loc or str(sorted(files_map.items()))
    with _SESSION_LOCK:
        engine = _SESSION_CACHE.get(cache_key)
        if engine is None:
            engine = DeepFilterNet3Onnx(Path(loc) if loc else Path(next(iter(files_map.values()))).parent, files_map)
            _SESSION_CACHE[cache_key] = engine
        return engine
