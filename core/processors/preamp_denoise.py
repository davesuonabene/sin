"""Generalized Preamp & ADC Floor De-Noise Engine (5-stage signal-agnostic statistical + psychoacoustic DSP).

Works across handheld field recorders (Zoom H4 / H4n / H4n Pro / H4essential coincident X/Y)
AND USB/PCIe audio interfaces / soundcards (mono mic, Hi-Z DI, independent stereo line).
100% NumPy/SciPy (zero ML dependencies) with 2-level caching:
  - Level 1 (`analyze_preamp`): HPF + STFT (single or dual-res 4096+512) + Gerkmann-Hendriks MMSE-SPP
    + preamp profile PSD + stationary hum/USB/LCD spur detection + L/R coherence (MSC).
  - Level 2 (`synthesize_preamp`): fast (~15-40ms) topology-gated MSC boost + transient-aware
    Ephraim-Malah MMSE-LSA + 24-band Bark simultaneous masking relaxation + 2D ERB/time gain
    smoothing + natural floor + exact `noise_only` diff output.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Dict, List, Optional, Tuple
import threading
import numpy as np
from scipy import ndimage, signal, special

from core.processors.chunked_inference import ensure_stereo_f32
from core.processors.preamp_profiles import (
    PreampProfile,
    VALID_TOPOLOGIES,
    evaluate_profile_psd,
    get_preamp_profile,
)


# 24 critical Bark band edges (Hz)
_BARK_EDGES_HZ = np.array(
    [
        0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480,
        1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700,
        9500, 12000, 24000,
    ],
    dtype=np.float64,
)


def _build_schroeder_spreading_matrix(n_bands: int = 24) -> np.ndarray:
    """Precompute Schroeder's 24x24 Bark simultaneous-masking spreading matrix (linear power)."""
    idx = np.arange(n_bands, dtype=np.float64)
    dz = idx[:, None] - idx[None, :]  # target_band - masker_band
    dz_s = dz + 0.474
    spread_db = 15.81 + 7.5 * dz_s - 17.5 * np.sqrt(1.0 + dz_s * dz_s)
    mat = np.power(10.0, spread_db / 10.0)
    # Normalize each masker column so total spread energy is well-behaved
    col_sum = np.maximum(np.sum(mat, axis=0, keepdims=True), 1e-12)
    return (mat / col_sum).astype(np.float32)


_SCHROEDER_MATRIX = _build_schroeder_spreading_matrix(24)


def _bark_bin_indices(freqs_hz: np.ndarray) -> np.ndarray:
    idx = np.searchsorted(_BARK_EDGES_HZ[1:], freqs_hz, side="right")
    return np.clip(idx, 0, 23).astype(np.int32)


def _stft_sqrt_hann(x: np.ndarray, n_fft: int, hop: int) -> Tuple[np.ndarray, np.ndarray]:
    """Strict COLA Sqrt-Hann STFT returning `(freqs_norm_bins, Z[2, F, T])`."""
    win = np.sqrt(signal.windows.hann(n_fft, sym=False)).astype(np.float32)
    # Pad edges symmetrically so frame 0 and final frame reconstruct cleanly
    z_l = signal.stft(
        x[0],
        fs=1.0,
        window=win,
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        boundary="zeros",
        padded=True,
    )[2]
    z_r = signal.stft(
        x[1],
        fs=1.0,
        window=win,
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        boundary="zeros",
        padded=True,
    )[2]
    return win, np.stack([z_l, z_r], axis=0).astype(np.complex64, copy=False)


def _istft_sqrt_hann(Z: np.ndarray, win: np.ndarray, n_fft: int, hop: int, target_len: int) -> np.ndarray:
    y_l = signal.istft(
        Z[0],
        fs=1.0,
        window=win,
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        boundary=True,
    )[1]
    y_r = signal.istft(
        Z[1],
        fs=1.0,
        window=win,
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        boundary=True,
    )[1]
    out = np.zeros((2, target_len), dtype=np.float32)
    n = min(target_len, int(y_l.shape[-1]))
    out[0, :n] = y_l[:n]
    out[1, :n] = y_r[:n]
    return out


def _apply_zero_phase_hpf(stereo: np.ndarray, sr: int, hp_hz: float) -> np.ndarray:
    cutoff = float(hp_hz or 0.0)
    if cutoff < 5.0 or stereo.shape[-1] < 32:
        return stereo
    nyq = 0.5 * float(sr)
    norm_cut = min(0.45, max(1e-4, cutoff / nyq))
    sos = signal.butter(2, norm_cut, btype="highpass", output="sos")
    out = np.empty_like(stereo, dtype=np.float32)
    out[0] = signal.sosfiltfilt(sos, stereo[0]).astype(np.float32)
    out[1] = signal.sosfiltfilt(sos, stereo[1]).astype(np.float32)
    return out


def _track_mmse_spp_noise(
    power: np.ndarray,
    *,
    baseline_init: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Gerkmann & Hendriks (2012) MMSE-SPP noise PSD tracker across frames `power[2, F, T]`.

    When `baseline_init` `(2, F)` is supplied from a global file scan, anchors initialization
    and bounds slow drift around `[0.35x .. 2.8x]` of the baseline so loud tiles never misread
    the floor while still tracking gradual room-tone changes over 1h+ recordings.
    """
    n_ch, n_f, n_t = power.shape
    if n_t == 0:
        return np.zeros_like(power, dtype=np.float32)

    xi_h1 = 10.0 ** (15.0 / 10.0)  # fixed optimal 15 dB a priori SNR
    ratio_coeff = xi_h1 / (1.0 + xi_h1)
    one_plus_xi = 1.0 + xi_h1  # P(H0)/P(H1) == 1.0
    alpha_p = 0.2
    alpha_n = 0.90 if baseline_init is not None else 0.85
    eps = 1e-12

    if baseline_init is not None and baseline_init.shape == (n_ch, n_f):
        init_n = np.maximum(np.asarray(baseline_init, dtype=np.float32), eps)
        floor_min = np.maximum(init_n * 0.35, eps)
        broadband_cap = np.maximum(init_n * 2.8, eps)
    else:
        # Initialize from lower 20th-percentile power, capped by local spectral median across frequency
        # so sustained musical notes / continuous drones (e.g. organ, synth, guitar) are NEVER absorbed into the broadband preamp floor!
        raw_init_n = np.maximum(np.percentile(power, 20.0, axis=-1), eps).astype(np.float32)
        init_n = np.empty_like(raw_init_n)
        for ch in range(n_ch):
            spec_med = ndimage.median_filter(raw_init_n[ch], size=17, mode="nearest")
            init_n[ch] = np.minimum(raw_init_n[ch], np.maximum(spec_med * 2.0, eps))
        floor_min = eps
        broadband_cap = np.maximum(init_n * 3.0, eps)

    noise_psd = np.empty((n_ch, n_f, n_t), dtype=np.float32)
    n_prev = init_n.copy()
    p_smooth = np.full((n_ch, n_f), 0.5, dtype=np.float32)

    for t in range(n_t):
        y2 = power[:, :, t]
        glr_exp = np.clip((y2 / np.maximum(n_prev, eps)) * ratio_coeff, 0.0, 40.0)
        p_inst = 1.0 / (1.0 + one_plus_xi * np.exp(-glr_exp))
        p_smooth = alpha_p * p_smooth + (1.0 - alpha_p) * p_inst
        # Stagnation guard: if SPP stays stuck near 1.0, clamp p_inst so tracker can still adapt
        stagnant = p_smooth > 0.99
        p_eff = np.where(stagnant, np.minimum(p_inst, 0.985), p_inst)
        e_n2 = (1.0 - p_eff) * y2 + p_eff * n_prev
        n_curr = alpha_n * n_prev + (1.0 - alpha_n) * e_n2
        n_prev = np.clip(n_curr, floor_min, broadband_cap)
        noise_psd[:, :, t] = n_prev

    return noise_psd


def _compute_stereo_msc(Z: np.ndarray, alpha_c: float = 0.82) -> np.ndarray:
    """Compute recursively smoothed Magnitude-Squared Coherence `msc[F, T] in [0, 1]`."""
    n_f, n_t = Z.shape[1], Z.shape[2]
    if n_t == 0:
        return np.ones((n_f, 0), dtype=np.float32)
    p_ll_raw = (Z[0].real ** 2 + Z[0].imag ** 2).astype(np.float32)
    p_rr_raw = (Z[1].real ** 2 + Z[1].imag ** 2).astype(np.float32)
    p_lr_raw = (Z[0] * np.conj(Z[1])).astype(np.complex64)

    p_ll = np.empty((n_f, n_t), dtype=np.float32)
    p_rr = np.empty((n_f, n_t), dtype=np.float32)
    p_lr_re = np.empty((n_f, n_t), dtype=np.float32)
    p_lr_im = np.empty((n_f, n_t), dtype=np.float32)

    ll = p_ll_raw[:, 0].copy()
    rr = p_rr_raw[:, 0].copy()
    lr_re = p_lr_raw[:, 0].real.copy()
    lr_im = p_lr_raw[:, 0].imag.copy()
    one_m = 1.0 - alpha_c

    for t in range(n_t):
        ll = alpha_c * ll + one_m * p_ll_raw[:, t]
        rr = alpha_c * rr + one_m * p_rr_raw[:, t]
        lr_re = alpha_c * lr_re + one_m * p_lr_raw[:, t].real
        lr_im = alpha_c * lr_im + one_m * p_lr_raw[:, t].imag
        p_ll[:, t] = ll
        p_rr[:, t] = rr
        p_lr_re[:, t] = lr_re
        p_lr_im[:, t] = lr_im

    num = lr_re_sq = p_lr_re * p_lr_re + p_lr_im * p_lr_im
    den = np.maximum(p_ll * p_rr, 1e-18)
    return np.clip(num / den, 0.0, 1.0).astype(np.float32)


def _detect_stationary_spurs(
    power: np.ndarray,
    freqs_hz: np.ndarray,
    profile: PreampProfile,
) -> Tuple[np.ndarray, List[float]]:
    """Detect stationary narrowband hardware spurs / hum (returns per-bin excess dB mask `[F]` & Hz list).

    Guards against notching out loud musical drones/instruments by requiring adaptive spurs to
    remain low-level electronic artifacts (below -28 dBFS average bin power) and temporally flat.
    """
    n_f, n_t = power.shape[1], power.shape[2]
    spur_excess_db = np.zeros(n_f, dtype=np.float32)
    if n_t < 4:
        return spur_excess_db, []

    avg_power = np.maximum(0.5 * (power[0] + power[1]), 1e-18)  # (F, T)
    log_p = 10.0 * np.log10(avg_power)
    mean_db = np.mean(log_p, axis=1)
    std_db = np.std(log_p, axis=1)
    local_med = ndimage.median_filter(mean_db, size=13, mode="nearest")
    prom_db = mean_db - local_med

    # Hardware spurs are low-level electronic lines (<< loud musical tones) with flat temporal variance.
    # Require strict local peak dominance and exclude +/-3 bin window-leakage skirts of loud signals (> -28 dBFS).
    low_level_electronic = mean_db <= -28.0
    loud_signal_mask = mean_db > -28.0
    near_loud_signal = ndimage.maximum_filter1d(loud_signal_mask.astype(np.int8), size=7, mode="nearest") > 0
    local_max_3 = ndimage.maximum_filter1d(mean_db, size=3, mode="nearest")
    is_local_peak = mean_db >= (local_max_3 - 1e-4)

    adaptive_mask = (
        (freqs_hz >= 40.0)
        & low_level_electronic
        & (~near_loud_signal)
        & is_local_peak
        & (prom_db >= 7.5)
        & (std_db <= 3.5)
    )
    spur_excess_db = np.where(adaptive_mask, np.clip(prom_db, 0.0, 24.0), 0.0).astype(np.float32)

    # Profile-nominated hum/USB/LCD spurs use a gentler threshold (3.5 dB prominence) while still guarding loud music
    df = float(freqs_hz[1] - freqs_hz[0]) if n_f > 1 else 1.0
    for spur in profile.spurs:
        if spur.freq_hz < 30.0 or spur.freq_hz >= float(freqs_hz[-1]):
            continue
        k = int(round(spur.freq_hz / max(df, 1e-6)))
        lo = max(1, k - 1)
        hi = min(n_f, k + 2)
        if np.any(near_loud_signal[lo:hi]):
            continue
        local_peak = float(np.max(prom_db[lo:hi]))
        local_level = float(np.max(mean_db[lo:hi]))
        local_std = float(np.min(std_db[lo:hi]))
        if local_level <= -24.0 and local_peak >= 3.5 and local_std <= 5.5:
            cut = min(float(spur.max_cut_db), local_peak + 3.0)
            spur_excess_db[lo:hi] = np.maximum(spur_excess_db[lo:hi], cut)

    # Widen detected single-bin spurs by +/-1 bin softly (half cut) to catch spectral leakage,
    # never spilling into bins belonging to loud musical signals.
    widened = np.maximum(
        spur_excess_db,
        0.5 * np.maximum(
            np.pad(spur_excess_db[:-1], (1, 0)),
            np.pad(spur_excess_db[1:], (0, 1)),
        ),
    ).astype(np.float32)
    widened = np.where(near_loud_signal, 0.0, widened).astype(np.float32)

    detected_hz: List[float] = []
    for k in range(1, n_f - 1):
        if spur_excess_db[k] > 0.0 and spur_excess_db[k] >= spur_excess_db[k - 1] and spur_excess_db[k] >= spur_excess_db[k + 1]:
            detected_hz.append(round(float(freqs_hz[k]), 1))
    return widened, detected_hz[:16]


def _spectral_flux_envelope(Z: np.ndarray) -> np.ndarray:
    """Compute normalized per-frame spectral flux `[T]` for transient detection."""
    mag = np.sqrt(np.maximum(0.5 * (np.abs(Z[0]) ** 2 + np.abs(Z[1]) ** 2), 1e-18))
    n_t = mag.shape[1]
    if n_t <= 1:
        return np.zeros(n_t, dtype=np.float32)
    diff = np.maximum(mag[:, 1:] - mag[:, :-1], 0.0)
    flux = np.sum(diff, axis=0) / np.maximum(np.sum(mag[:, :-1], axis=0), 1e-8)
    return np.concatenate([[0.0], flux]).astype(np.float32)


@dataclass
class _StftBranchAnalysis:
    n_fft: int
    hop: int
    win: np.ndarray
    freqs_hz: np.ndarray
    Z: np.ndarray  # (2, F, T) complex64
    power: np.ndarray  # (2, F, T) float32
    noise_adapt: np.ndarray  # (2, F, T) float32
    profile_psd: np.ndarray  # (2, F) float32 (anchored to input noise level)
    clip_print_psd: Optional[np.ndarray]  # (2, F) float32
    msc: np.ndarray  # (F, T) float32
    spur_excess_db: np.ndarray  # (F,) float32
    detected_spurs_hz: List[float]
    flux: np.ndarray  # (T,) float32
    bark_idx: np.ndarray  # (F,) int32


@dataclass
class PreampAnalysis:
    sample_rate: int
    num_frames: int
    hp_hz: float
    stft_mode: str
    profile: PreampProfile
    primary: _StftBranchAnalysis
    transient_branch: Optional[_StftBranchAnalysis] = None


@dataclass
class _BranchBaseline:
    n_fft: int
    noise_psd: np.ndarray  # (2, F) float32
    profile_psd: np.ndarray  # (2, F) float32
    spur_excess_db: np.ndarray  # (F,) float32
    detected_spurs_hz: List[float]
    clip_print_psd: Optional[np.ndarray] = None  # (2, F) float32


@dataclass
class PreampGlobalBaseline:
    """Fast multi-point sampled global baseline for consistent chunked 1h+ denoising with slow drift."""

    sample_rate: int
    profile_id: str
    hp_hz: float
    stft_mode: str
    primary: _BranchBaseline
    transient: Optional[_BranchBaseline] = None


def _build_branch_baseline(
    conditioned: np.ndarray,
    sr: int,
    n_fft: int,
    hop: int,
    profile: PreampProfile,
    clip_print_audio: Optional[np.ndarray] = None,
) -> _BranchBaseline:
    _, Z = _stft_sqrt_hann(conditioned, n_fft, hop)
    freqs_hz = np.linspace(0.0, 0.5 * float(sr), Z.shape[1], dtype=np.float64)
    power = (Z.real * Z.real + Z.imag * Z.imag).astype(np.float32)
    eps = 1e-12
    raw_init_n = np.maximum(np.percentile(power, 20.0, axis=-1), eps).astype(np.float32)
    init_n = np.empty_like(raw_init_n)
    for ch in range(2):
        spec_med = ndimage.median_filter(raw_init_n[ch], size=17, mode="nearest")
        init_n[ch] = np.minimum(raw_init_n[ch], np.maximum(spec_med * 2.0, eps))
    spur_excess_db, detected_spurs_hz = _detect_stationary_spurs(power, freqs_hz, profile)

    prof_l, prof_r = evaluate_profile_psd(profile, freqs_hz)
    prof_raw = np.stack([prof_l, prof_r], axis=0)
    mid_mask = (freqs_hz >= 400.0) & (freqs_hz <= min(8000.0, 0.4 * sr))
    if not np.any(mid_mask):
        mid_mask = np.ones_like(freqs_hz, dtype=bool)
    scales = np.empty((2, 1), dtype=np.float32)
    for ch in range(2):
        ratios = init_n[ch, mid_mask] / np.maximum(prof_raw[ch, mid_mask], 1e-12)
        scales[ch, 0] = float(np.percentile(ratios, 20.0))
    profile_psd = np.maximum(prof_raw * scales, 1e-15).astype(np.float32)

    clip_print_psd: Optional[np.ndarray] = None
    if clip_print_audio is not None and clip_print_audio.shape[-1] >= n_fft:
        _, Zp = _stft_sqrt_hann(clip_print_audio, n_fft, hop)
        pp = (Zp.real * Zp.real + Zp.imag * Zp.imag).astype(np.float32)
        clip_print_psd = np.maximum(np.median(pp, axis=-1), 1e-15).astype(np.float32)

    return _BranchBaseline(
        n_fft=n_fft,
        noise_psd=init_n,
        profile_psd=profile_psd,
        spur_excess_db=spur_excess_db,
        detected_spurs_hz=detected_spurs_hz,
        clip_print_psd=clip_print_psd,
    )


def scan_preamp_global_baseline(
    filepath: str,
    target_sr: int,
    *,
    profile_id: str = "generic_adc",
    hp_hz: float = 40.0,
    stft_mode: str = "hq_dual_res",
    noise_start: float = 0.0,
    noise_end: float = 0.0,
    num_probes: int = 12,
    probe_sec: float = 0.5,
    profiles_dir: Optional[Any] = None,
) -> Optional[PreampGlobalBaseline]:
    """Read ~12 evenly spaced 0.5s probes directly from disk (<150ms, ~2MB RAM) to anchor
    a shared global preamp floor & spur mask across all 8s tiles of a 1h+ recording.
    """
    import soundfile as sf

    try:
        with sf.SoundFile(filepath, mode="r") as f:
            file_sr = int(f.samplerate or target_sr or 48000)
            total_frames = int(len(f))
            if total_frames <= 0:
                return None
            probe_frames = max(1024, min(total_frames, int(round(probe_sec * file_sr))))
            count = max(1, min(int(num_probes), max(1, total_frames // probe_frames)))
            slices: List[np.ndarray] = []
            max_start = max(0, total_frames - probe_frames)
            for i in range(count):
                pos = int(round((i / float(max(1, count - 1))) * max_start)) if count > 1 else 0
                f.seek(pos)
                raw = f.read(probe_frames, dtype="float32", always_2d=True)
                if raw.size > 0:
                    slices.append(ensure_stereo_f32(raw.T))

            clip_print_audio: Optional[np.ndarray] = None
            if noise_end > noise_start + 0.002:
                s0 = max(0, min(total_frames - 1, int(round(noise_start * total_frames))))
                s1 = max(s0 + 1, min(total_frames, int(round(noise_end * total_frames))))
                # Cap manual noise print slice to 6 seconds so scanning stays instant even if user selects a wide span
                max_print = int(round(6.0 * file_sr))
                f.seek(s0)
                raw_p = f.read(min(s1 - s0, max_print), dtype="float32", always_2d=True)
                if raw_p.size > 0:
                    clip_print_audio = ensure_stereo_f32(raw_p.T)
    except Exception:
        return None

    if not slices:
        return None

    sr = int(target_sr or file_sr or 48000)
    combined = np.concatenate(slices, axis=-1)
    if file_sr != sr and combined.shape[-1] > 0:
        from math import gcd
        g = gcd(sr, file_sr)
        combined = signal.resample_poly(combined, sr // g, file_sr // g, axis=-1).astype(np.float32)
        if clip_print_audio is not None:
            clip_print_audio = signal.resample_poly(clip_print_audio, sr // g, file_sr // g, axis=-1).astype(np.float32)

    profile = get_preamp_profile(profile_id, profiles_dir=profiles_dir)
    mode = str(stft_mode or "hq_dual_res").strip().lower()
    if mode not in ("hq_dual_res", "fast_single_res"):
        mode = "hq_dual_res"

    conditioned = _apply_zero_phase_hpf(combined, sr, hp_hz)
    cond_print = _apply_zero_phase_hpf(clip_print_audio, sr, hp_hz) if clip_print_audio is not None else None

    if mode == "hq_dual_res" and conditioned.shape[-1] >= 4096:
        primary = _build_branch_baseline(conditioned, sr, 4096, 1024, profile, cond_print)
        transient = _build_branch_baseline(conditioned, sr, 512, 128, profile, cond_print)
    else:
        n_fft = min(2048, max(256, 1 << int(math.floor(math.log2(max(256, conditioned.shape[-1]))))))
        hop = max(64, n_fft // 4)
        primary = _build_branch_baseline(conditioned, sr, n_fft, hop, profile, cond_print)
        transient = None

    return PreampGlobalBaseline(
        sample_rate=sr,
        profile_id=profile.id,
        hp_hz=float(hp_hz or 0.0),
        stft_mode=mode,
        primary=primary,
        transient=transient,
    )


def _analyze_branch(
    conditioned: np.ndarray,
    sr: int,
    n_fft: int,
    hop: int,
    profile: PreampProfile,
    noise_start: float,
    noise_end: float,
    *,
    branch_baseline: Optional[_BranchBaseline] = None,
) -> _StftBranchAnalysis:
    win, Z = _stft_sqrt_hann(conditioned, n_fft, hop)
    freqs_hz = np.linspace(0.0, 0.5 * float(sr), Z.shape[1], dtype=np.float64)
    power = (Z.real * Z.real + Z.imag * Z.imag).astype(np.float32)

    use_base = branch_baseline is not None and branch_baseline.n_fft == n_fft and branch_baseline.noise_psd.shape == (2, Z.shape[1])
    noise_adapt = _track_mmse_spp_noise(
        power,
        baseline_init=branch_baseline.noise_psd if use_base else None,
    )
    msc = _compute_stereo_msc(Z)
    if use_base:
        spur_excess_db = branch_baseline.spur_excess_db
        detected_spurs_hz = list(branch_baseline.detected_spurs_hz)
        profile_psd = branch_baseline.profile_psd
        clip_print_psd = branch_baseline.clip_print_psd
    else:
        spur_excess_db, detected_spurs_hz = _detect_stationary_spurs(power, freqs_hz, profile)
        # Evaluate preamp profile curve & auto-scale scalar gain anchor to quiet bins
        prof_l, prof_r = evaluate_profile_psd(profile, freqs_hz)
        prof_raw = np.stack([prof_l, prof_r], axis=0)
        med_adapt = np.median(noise_adapt, axis=-1)  # (2, F)
        mid_mask = (freqs_hz >= 400.0) & (freqs_hz <= min(8000.0, 0.4 * sr))
        if not np.any(mid_mask):
            mid_mask = np.ones_like(freqs_hz, dtype=bool)
        scales = np.empty((2, 1), dtype=np.float32)
        for ch in range(2):
            ratios = med_adapt[ch, mid_mask] / np.maximum(prof_raw[ch, mid_mask], 1e-12)
            scales[ch, 0] = float(np.percentile(ratios, 20.0))
        profile_psd = np.maximum(prof_raw * scales, 1e-15).astype(np.float32)

        # Optional in-node learned clip noise print `[noise_start, noise_end]`
        clip_print_psd = None
        if noise_end > noise_start + 0.005 and Z.shape[2] >= 2:
            n_t = Z.shape[2]
            t0 = max(0, min(n_t - 1, int(round(noise_start * n_t))))
            t1 = max(t0 + 1, min(n_t, int(round(noise_end * n_t))))
            clip_print_psd = np.maximum(np.median(power[:, :, t0:t1], axis=-1), 1e-15).astype(np.float32)

    flux = _spectral_flux_envelope(Z)

    return _StftBranchAnalysis(
        n_fft=n_fft,
        hop=hop,
        win=win,
        freqs_hz=freqs_hz,
        Z=Z,
        power=power,
        noise_adapt=noise_adapt,
        profile_psd=profile_psd,
        clip_print_psd=clip_print_psd,
        msc=msc,
        spur_excess_db=spur_excess_db,
        detected_spurs_hz=detected_spurs_hz,
        flux=flux,
        bark_idx=_bark_bin_indices(freqs_hz),
    )


def analyze_preamp(
    audio_in: np.ndarray,
    sample_rate: int,
    *,
    profile_id: str = "generic_adc",
    hp_hz: float = 40.0,
    stft_mode: str = "hq_dual_res",
    noise_start: float = 0.0,
    noise_end: float = 0.0,
    profiles_dir: Optional[Any] = None,
    global_baseline: Optional[PreampGlobalBaseline] = None,
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Any] = None,
) -> PreampAnalysis:
    """Level-1 analysis: HPF + STFT + MMSE-SPP + preamp PSD + spur detection + MSC."""
    stereo = ensure_stereo_f32(audio_in)
    sr = int(sample_rate or 48000)
    profile = get_preamp_profile(profile_id, profiles_dir=profiles_dir)
    mode = str(stft_mode or "hq_dual_res").strip().lower()
    if mode not in ("hq_dual_res", "fast_single_res"):
        mode = "hq_dual_res"

    conditioned = _apply_zero_phase_hpf(stereo, sr, hp_hz)
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("Preamp analysis cancelled")
    if on_progress:
        on_progress(0.25)

    p_base = global_baseline.primary if global_baseline is not None else None
    t_base = global_baseline.transient if global_baseline is not None else None

    if mode == "hq_dual_res" and stereo.shape[-1] >= 4096:
        primary = _analyze_branch(conditioned, sr, 4096, 1024, profile, noise_start, noise_end, branch_baseline=p_base)
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Preamp analysis cancelled")
        if on_progress:
            on_progress(0.70)
        transient = _analyze_branch(conditioned, sr, 512, 128, profile, noise_start, noise_end, branch_baseline=t_base)
    else:
        n_fft = min(2048, max(256, 1 << int(math.floor(math.log2(max(256, stereo.shape[-1]))))))
        hop = max(64, n_fft // 4)
        primary = _analyze_branch(conditioned, sr, n_fft, hop, profile, noise_start, noise_end, branch_baseline=p_base)
        transient = None

    if on_progress:
        on_progress(1.0)
    return PreampAnalysis(
        sample_rate=sr,
        num_frames=int(stereo.shape[-1]),
        hp_hz=float(hp_hz or 0.0),
        stft_mode=mode,
        profile=profile,
        primary=primary,
        transient_branch=transient,
    )


def _synthesize_branch(
    branch: _StftBranchAnalysis,
    sr: int,
    target_len: int,
    *,
    topology: str,
    reduction_db: float,
    sensitivity_db: float,
    profile_weight: float,
    stereo_coherence: float,
    spur_notch: float,
    psychoacoustic_preserve: float,
    natural_floor: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Level-2 fast synthesis on one STFT branch. Returns `(audio_out[2, N], avg_gain_db[F])`."""
    n_ch, n_f, n_t = branch.Z.shape
    if n_t == 0:
        return np.zeros((2, target_len), dtype=np.float32), np.zeros(n_f, dtype=np.float32)

    eps = 1e-12
    red_db = max(0.0, min(42.0, float(reduction_db)))
    g_min = float(10.0 ** (-red_db / 20.0))
    sens_lin = float(10.0 ** (float(sensitivity_db) / 10.0))
    w_cal = max(0.0, min(1.0, float(profile_weight)))
    sc = max(0.0, min(1.0, float(stereo_coherence)))
    spur_amt = max(0.0, min(1.0, float(spur_notch)))
    psy_amt = max(0.0, min(1.0, float(psychoacoustic_preserve)))
    nat_floor = max(0.0, min(1.0, float(natural_floor)))

    # 1. Fuse adaptive MMSE-SPP noise floor with calibrated preamp prior & optional clip noise print
    prior = branch.profile_psd[:, :, None]
    if branch.clip_print_psd is not None:
        prior = 0.35 * prior + 0.65 * branch.clip_print_psd[:, :, None]
    n_base = (1.0 - w_cal) * branch.noise_adapt + w_cal * np.maximum(prior, branch.noise_adapt)

    # 2. Topology-gated Stereo Coherence (MSC) preamp noise boost
    if topology == "coincident_xy_stereo" and sc > 1e-4:
        rho = (1.0 / (1.0 + (branch.freqs_hz / 2800.0) ** 2)).astype(np.float32)[:, None]
        kappa_msc = 1.0 + (sc * 2.2) * rho * np.power(np.maximum(0.0, 1.0 - branch.msc), 1.5)
        n_eff = n_base * (sens_lin * kappa_msc[None, :, :])
    elif topology == "spaced_stereo" and sc > 1e-4:
        rho = (1.0 / (1.0 + (branch.freqs_hz / 700.0) ** 2)).astype(np.float32)[:, None]
        kappa_msc = 1.0 + (sc * 1.1) * rho * np.power(np.maximum(0.0, 1.0 - branch.msc), 1.5)
        n_eff = n_base * (sens_lin * kappa_msc[None, :, :])
    else:
        # mono_or_dual_mono: STRICTLY zero cross-channel MSC interference!
        n_eff = n_base * sens_lin
    n_eff = np.maximum(n_eff, eps)

    # 3. Stationary narrowband spur / hum notch mask `[F]`
    if spur_amt > 1e-4 and np.any(branch.spur_excess_db > 0.0):
        spur_gain = np.power(10.0, -(branch.spur_excess_db * spur_amt) / 20.0).astype(np.float32)
    else:
        spur_gain = np.ones(n_f, dtype=np.float32)

    # 4. Transient-Aware Decision-Directed A Priori SNR + Ephraim-Malah MMSE-LSA Gain
    G_raw = np.ones((n_ch, n_f, n_t), dtype=np.float32)
    g_prev = np.ones((n_ch, n_f), dtype=np.float32)
    y_prev_p = branch.power[:, :, 0].copy()
    n_prev = n_eff[:, :, 0].copy()
    xi_min = 1e-4
    band_counts = np.maximum(np.bincount(branch.bark_idx, minlength=24).astype(np.float32), 1.0)

    for t in range(n_t):
        y2 = branch.power[:, :, t]
        nt = n_eff[:, :, t]
        gamma = np.minimum(y2 / nt, 1000.0)
        flux_t = float(branch.flux[t])
        # Adapt DD memory down during transients and sudden high-SNR onsets so crisp impulses never lag 1 frame
        flux_drop = min(1.0, max(0.0, (flux_t - 0.25) / 0.30))
        snr_onset = np.clip((gamma - 5.0) / 15.0, 0.0, 1.0)
        alpha_dd = np.maximum(0.12, 0.97 - 0.55 * flux_drop - 0.70 * snr_onset)
        xi_prev = (g_prev * g_prev * y_prev_p) / np.maximum(n_prev, eps)
        xi = np.maximum(alpha_dd * xi_prev + (1.0 - alpha_dd) * np.maximum(gamma - 1.0, 0.0), xi_min)

        ratio = xi / (1.0 + xi)
        nu = np.clip(ratio * gamma, 1e-6, 40.0)
        # Ephraim-Malah MMSE-LSA: G = (xi/(1+xi)) * exp(0.5 * E1(nu))
        g_lsa = np.minimum(1.0, ratio * np.exp(0.5 * special.exp1(nu))).astype(np.float32)

        # 5. 24-Band Bark Simultaneous Masking Relaxation (per-bin normalized excess signal only)
        if psy_amt > 1e-4:
            # Only true signal energy exceeding the noise floor creates simultaneous masking (prevents noise self-masking!)
            sig_excess = np.maximum((g_lsa * g_lsa) * y2 - 1.5 * nt, 0.0)
            for ch in range(n_ch):
                band_p = np.bincount(branch.bark_idx, weights=sig_excess[ch], minlength=24).astype(np.float32)
                spread_p = _SCHROEDER_MATRIX @ band_p
                # Convert band masking energy back into per-FFT-bin PSD (~ -14 dB masking offset)
                mask_psd_band = (spread_p / band_counts) * (0.04 * psy_amt)
                mask_psd_bin = mask_psd_band[branch.bark_idx]
                g_mask = np.sqrt(np.maximum(mask_psd_bin / np.maximum(nt[ch], eps), 0.0))
                g_lsa[ch] = np.minimum(1.0, np.maximum(g_lsa[ch], np.minimum(1.0, g_mask)))

        G_raw[:, :, t] = g_lsa
        g_prev = g_lsa
        y_prev_p = y2
        n_prev = nt

    # 6. 2D ERB/Time Musical-Noise Suppression (suppresses low-SNR chirps while protecting narrowband signal peaks!)
    log_raw = np.log(np.maximum(G_raw, 1e-4))
    log_freq_sm = ndimage.uniform_filter1d(log_raw, size=3, axis=1, mode="nearest")
    # Never let adjacent noise bins pull down a strong tonal/chirp peak (G_raw > 0.65)
    tonal_protect = np.clip((G_raw - 0.55) / 0.25, 0.0, 1.0)
    log_g = tonal_protect * np.maximum(log_raw, log_freq_sm) + (1.0 - tonal_protect) * log_freq_sm

    hop_sec = float(branch.hop) / float(sr)
    # Near-instantaneous attack (~0.4 ms) preserves field transients/plosives while ~45 ms release eliminates musical-noise chatter
    a_att = math.exp(-hop_sec / 0.0004)
    a_rel = math.exp(-hop_sec / 0.045)
    log_s = np.empty_like(log_g)
    cur = log_g[:, :, 0].copy()
    for t in range(n_t):
        target = log_g[:, :, t]
        # Rising gain = attack (instantaneous); falling gain = release (smooth)
        alpha_t = np.where(target > cur, a_att, a_rel)
        cur = alpha_t * cur + (1.0 - alpha_t) * target
        log_s[:, :, t] = cur

    G_smooth = np.exp(log_s).astype(np.float32)

    # Apply reduction floor + natural comfort-floor blend + narrowband spur notch
    eff_floor = g_min + nat_floor * 0.25 * (1.0 - g_min)
    G_final = np.maximum(G_smooth, eff_floor) * spur_gain[None, :, None]

    # Stereo gain linking ONLY for correlated stereo topologies (never for independent dual-mono!)
    if topology in ("coincident_xy_stereo", "spaced_stereo"):
        g_min_lr = np.minimum(G_final[0], G_final[1])
        G_final[0] = 0.65 * G_final[0] + 0.35 * g_min_lr
        G_final[1] = 0.65 * G_final[1] + 0.35 * g_min_lr

    if red_db <= 1e-4 and spur_amt <= 1e-4:
        G_final = np.ones_like(G_final)

    Z_out = branch.Z * G_final
    audio_out = _istft_sqrt_hann(Z_out, branch.win, branch.n_fft, branch.hop, target_len)
    avg_gain_db = 20.0 * np.log10(np.maximum(np.mean(G_final, axis=(0, 2)), 1e-5))
    return audio_out, avg_gain_db.astype(np.float32)


def synthesize_preamp(
    analysis: PreampAnalysis,
    audio_in: np.ndarray,
    params: Dict[str, Any],
) -> np.ndarray:
    """Level-2 fast synthesis (~15-40 ms) from cached `PreampAnalysis`."""
    stereo_in = ensure_stereo_f32(audio_in)
    target_len = int(stereo_in.shape[-1])
    if target_len == 0:
        return stereo_in

    topology = str(params.get("input_topology") or analysis.profile.default_topology).strip().lower()
    if topology not in VALID_TOPOLOGIES:
        topology = analysis.profile.default_topology

    synth_kwargs = dict(
        topology=topology,
        reduction_db=float(params.get("reduction_db", 12.0)),
        sensitivity_db=float(params.get("sensitivity", 0.0)),
        profile_weight=float(params.get("profile_weight", 0.7)),
        stereo_coherence=float(params.get("stereo_coherence", 0.6)),
        spur_notch=float(params.get("spur_notch", 0.5)),
        psychoacoustic_preserve=float(params.get("psychoacoustic_preserve", 0.75)),
        natural_floor=float(params.get("natural_floor", 0.15)),
    )

    y_primary, _ = _synthesize_branch(analysis.primary, analysis.sample_rate, target_len, **synth_kwargs)

    if analysis.transient_branch is not None:
        y_trans, _ = _synthesize_branch(analysis.transient_branch, analysis.sample_rate, target_len, **synth_kwargs)
        # Upsample short-window spectral-flux transient mask cleanly without smearing out 1-frame impulse peaks
        flux_short = analysis.transient_branch.flux
        t_mask_raw = np.clip((flux_short - 0.28) / 0.24, 0.0, 1.0).astype(np.float32)
        if t_mask_raw.size > 1:
            # Dilate +/-1 short frame (~+/-2.7 ms) so the entire impulse envelope uses the 512-sample branch, then smooth edges
            t_mask_dil = ndimage.maximum_filter1d(t_mask_raw, size=3, mode="nearest")
            t_mask_frames = np.clip(ndimage.gaussian_filter1d(t_mask_dil, sigma=0.75) * 1.15, 0.0, 1.0).astype(np.float32)
            sample_grid = np.linspace(0.0, float(t_mask_frames.size - 1), target_len, dtype=np.float32)
            t_mask = np.interp(sample_grid, np.arange(t_mask_frames.size, dtype=np.float32), t_mask_frames).astype(np.float32)
            denoised = ((1.0 - t_mask[None, :]) * y_primary + t_mask[None, :] * y_trans).astype(np.float32)
        else:
            denoised = y_primary
    else:
        denoised = y_primary

    mix = max(0.0, min(1.0, float(params.get("mix", 1.0))))
    if mix < 0.9999:
        denoised = ((1.0 - mix) * stereo_in + mix * denoised).astype(np.float32)

    output_mode = str(params.get("output_mode") or "denoised").strip().lower()
    if output_mode == "noise_only":
        return (stereo_in - denoised).astype(np.float32)
    return denoised.astype(np.float32, copy=False)


def find_quietest_window(
    audio_in: np.ndarray,
    sample_rate: int,
    window_sec: float = 1.0,
) -> Tuple[float, float]:
    """Find normalized `[noise_start, noise_end]` of the lowest-RMS window for 1-click Noise Print learning."""
    stereo = ensure_stereo_f32(audio_in)
    n = int(stereo.shape[-1])
    sr = int(sample_rate or 48000)
    if n == 0:
        return 0.0, 0.0
    win_frames = min(n, max(256, int(round(float(window_sec) * sr))))
    if win_frames >= n:
        return 0.0, 1.0

    energy = 0.5 * (stereo[0] * stereo[0] + stereo[1] * stereo[1])
    csum = np.concatenate([[0.0], np.cumsum(energy, dtype=np.float64)])
    step = max(1, win_frames // 16)
    starts = np.arange(0, n - win_frames + 1, step, dtype=np.int64)
    win_e = csum[starts + win_frames] - csum[starts]
    # Ignore pure digital zero silence (< -110 dBFS) if real non-zero floor exists
    non_silent = win_e > (win_frames * 1e-11)
    if np.any(non_silent):
        valid_starts = starts[non_silent]
        best_start = int(valid_starts[int(np.argmin(win_e[non_silent]))])
    else:
        best_start = int(starts[int(np.argmin(win_e))])
    return round(best_start / float(n), 4), round(min(1.0, (best_start + win_frames) / float(n)), 4)


def compute_preview_curves(
    audio_in: np.ndarray,
    sample_rate: int,
    params: Dict[str, Any],
    *,
    num_points: int = 128,
    profiles_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """Compute compact 128-point log-frequency Input/Noise/Output PSD curves for the Inspector canvas."""
    stereo = ensure_stereo_f32(audio_in)
    sr = int(sample_rate or 48000)
    analysis = analyze_preamp(
        stereo,
        sr,
        profile_id=str(params.get("profile_id") or "generic_adc"),
        hp_hz=float(params.get("hp_hz", 40.0)),
        stft_mode="fast_single_res",
        noise_start=float(params.get("noise_start", 0.0)),
        noise_end=float(params.get("noise_end", 0.0)),
        profiles_dir=profiles_dir,
    )
    topology = str(params.get("input_topology") or analysis.profile.default_topology).strip().lower()
    if topology not in VALID_TOPOLOGIES:
        topology = analysis.profile.default_topology
    _, avg_gain_db = _synthesize_branch(
        analysis.primary,
        sr,
        int(stereo.shape[-1]),
        topology=topology,
        reduction_db=float(params.get("reduction_db", 12.0)),
        sensitivity_db=float(params.get("sensitivity", 0.0)),
        profile_weight=float(params.get("profile_weight", 0.7)),
        stereo_coherence=float(params.get("stereo_coherence", 0.6)),
        spur_notch=float(params.get("spur_notch", 0.5)),
        psychoacoustic_preserve=float(params.get("psychoacoustic_preserve", 0.75)),
        natural_floor=float(params.get("natural_floor", 0.15)),
    )

    br = analysis.primary
    in_psd = np.mean(br.power, axis=(0, 2))
    noise_psd = 0.5 * (np.median(br.noise_adapt[0], axis=1) + np.median(br.noise_adapt[1], axis=1))
    prof_psd = 0.5 * (br.profile_psd[0] + br.profile_psd[1])
    w_cal = max(0.0, min(1.0, float(params.get("profile_weight", 0.7))))
    fused_noise = (1.0 - w_cal) * noise_psd + w_cal * np.maximum(prof_psd, noise_psd)

    in_db = 10.0 * np.log10(np.maximum(in_psd, 1e-12))
    noise_db = 10.0 * np.log10(np.maximum(fused_noise, 1e-12))
    out_db = in_db + avg_gain_db

    f_min = 25.0
    f_max = min(20000.0, 0.49 * float(sr))
    log_freqs = np.geomspace(f_min, f_max, max(32, int(num_points)))
    q_start, q_end = find_quietest_window(stereo, sr, window_sec=1.0)

    return {
        "profile_id": analysis.profile.id,
        "default_topology": analysis.profile.default_topology,
        "freqs_hz": [round(float(v), 1) for v in log_freqs],
        "input_db": [round(float(v), 2) for v in np.interp(log_freqs, br.freqs_hz, in_db)],
        "noise_floor_db": [round(float(v), 2) for v in np.interp(log_freqs, br.freqs_hz, noise_db)],
        "output_db": [round(float(v), 2) for v in np.interp(log_freqs, br.freqs_hz, out_db)],
        "detected_spurs_hz": br.detected_spurs_hz,
        "suggested_noise_window": [q_start, q_end],
    }
