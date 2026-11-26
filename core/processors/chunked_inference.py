"""Cross-OS overlap-add streaming chunk runner for long audio buffers."""

from __future__ import annotations

from typing import Callable, Dict, Optional
import threading
import numpy as np


def ensure_stereo_f32(audio: np.ndarray) -> np.ndarray:
    """Normalize input PCM into contiguous planar float32 `(2, N)`."""
    arr = np.asarray(audio, dtype=np.float32)
    if arr.size == 0:
        return np.zeros((2, 0), dtype=np.float32)
    if arr.ndim == 1:
        return np.stack([arr, arr], axis=0).astype(np.float32, copy=False)
    if arr.ndim == 2:
        if arr.shape[0] == 2:
            return np.ascontiguousarray(arr, dtype=np.float32)
        if arr.shape[0] == 1:
            return np.repeat(arr, 2, axis=0).astype(np.float32, copy=False)
        if arr.shape[1] == 2 and arr.shape[0] > 2:
            return np.ascontiguousarray(arr.T, dtype=np.float32)
        mono = np.mean(arr, axis=0, dtype=np.float32)
        return np.stack([mono, mono], axis=0)
    flat = arr.reshape(-1)
    return np.stack([flat, flat], axis=0).astype(np.float32, copy=False)


def run_chunked_overlap_add(
    audio: np.ndarray,
    sample_rate: int,
    chunk_fn: Callable[[np.ndarray, int], Dict[str, np.ndarray]],
    *,
    segment_sec: float = 7.8,
    overlap_ratio: float = 0.25,
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> Dict[str, np.ndarray]:
    """Run a multi-output DSP/ML processor across arbitrary-length stereo audio with cosine OLA.

    `chunk_fn(chunk_stereo_f32, sample_rate)` must return a dict mapping stem names to `(2, L)` float32 arrays.
    """
    stereo = ensure_stereo_f32(audio)
    total_frames = int(stereo.shape[-1])
    if total_frames == 0:
        return {}

    seg_frames = max(2048, int(round(float(segment_sec) * float(sample_rate))))
    if total_frames <= seg_frames:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Chunked inference cancelled")
        res = chunk_fn(stereo, sample_rate)
        if on_progress:
            on_progress(1.0)
        return {k: ensure_stereo_f32(v)[..., :total_frames] for k, v in res.items()}

    overlap_ratio = max(0.05, min(0.5, float(overlap_ratio)))
    hop = max(512, int(round(seg_frames * (1.0 - overlap_ratio))))
    fade = seg_frames - hop

    # Raised-cosine taper on overlap edges
    win = np.ones(seg_frames, dtype=np.float32)
    if fade > 0:
        ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(fade, dtype=np.float32) / float(fade)))
        win[:fade] = ramp
        win[-fade:] = ramp[::-1]

    starts = list(range(0, total_frames, hop))
    if starts[-1] + seg_frames < total_frames:
        starts.append(max(0, total_frames - seg_frames))

    accum: Dict[str, np.ndarray] = {}
    weight_sum = np.zeros(total_frames, dtype=np.float32)

    for idx, start in enumerate(starts):
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Chunked inference cancelled")

        end = min(total_frames, start + seg_frames)
        valid_len = end - start
        chunk = np.zeros((2, seg_frames), dtype=np.float32)
        chunk[:, :valid_len] = stereo[:, start:end]

        out_map = chunk_fn(chunk, sample_rate)
        w_slice = win[:valid_len].copy()
        if idx == 0 and fade > 0:
            w_slice[: min(fade, valid_len)] = 1.0
        if end == total_frames and fade > 0:
            tail = min(fade, valid_len)
            w_slice[valid_len - tail :] = 1.0

        for stem_key, stem_arr in out_map.items():
            s_arr = ensure_stereo_f32(stem_arr)[:, :valid_len]
            if stem_key not in accum:
                accum[stem_key] = np.zeros((2, total_frames), dtype=np.float32)
            accum[stem_key][:, start:end] += s_arr * w_slice[None, :]

        weight_sum[start:end] += w_slice
        if on_progress:
            on_progress(min(1.0, float(idx + 1) / float(len(starts))))

    safe_w = np.maximum(weight_sum, 1e-6)[None, :]
    return {k: (v / safe_w).astype(np.float32, copy=False) for k, v in accum.items()}
