from pathlib import Path
from time import perf_counter
from typing import Union, Tuple, Optional
import numpy as np
import librosa
import soundfile as sf

from core.runtime_trace import get_runtime_cache, set_runtime_cache, trace_runtime
from core.stretching import StretchAlgorithm, normalize_stretch_algorithm, stretch_with_rubberband


def process_sample_transform(
    audio_data: np.ndarray,
    sr: int = 44100,
    original_bpm: Optional[float] = None,
    target_bpm: Optional[float] = None,
    transpose: float = 0.0,
    cents: float = 0.0,
    stretch_mode: str = "time_stretch",
    stretch_factor: float = 1.0,
    stretch_algorithm: str = StretchAlgorithm.RUBBERBAND.value,
    sample_type: str = "loop",
    fast_preview: bool = False,
) -> np.ndarray:
    """
    Applies pitch transposition and time-stretching transformations to audio array.

    - transpose: pitch shift in semitones (e.g. -24.0 to +24.0)
    - cents: fine tune pitch shift in cents (-100.0 to +100.0)
    - stretch_mode: 'time_stretch' (independent pitch/tempo), 'pitch_shift'/'varispeed'
      (locked pitch/tempo repitching via resampling), or 'off'
    - stretch_factor: speed/duration multiplier (e.g. 0.5 = half speed / double duration, 2.0 = 2x speed)
    - stretch_algorithm: a Rubber Band material preset, or 'librosa' for a legacy saved node
    - sample_type: 'loop' or 'one_shot' / 'oneshot'
    """
    transform_started_at = perf_counter()
    input_frame_count = int(audio_data.shape[-1])
    if audio_data.shape[-1] == 0:
        trace_runtime("DSP transform bypassed: empty audio")
        return audio_data.astype(np.float32)

    mode = str(stretch_mode or "time_stretch").lower()
    algorithm = normalize_stretch_algorithm(stretch_algorithm)
    total_semitones = float(transpose or 0.0) + (float(cents or 0.0) / 100.0)
    factor = float(stretch_factor or 1.0)
    if factor <= 0:
        factor = 1.0

    # Determine base time-stretch rate from BPM ratio if loop mode and not off
    bpm_rate = 1.0
    if sample_type not in ("one_shot", "oneshot") and mode != "off":
        orig = float(original_bpm or 120.0)
        tgt = float(target_bpm or 120.0)
        if orig > 0 and tgt > 0 and orig != tgt:
            bpm_rate = tgt / orig

    total_time_rate = bpm_rate * factor

    if mode in ("pitch_shift", "repitch", "varispeed"):
        # Repitch/varispeed: pitch and speed are linked together like tape/vinyl.
        pitch_rate = 2.0 ** (total_semitones / 12.0)
        total_varispeed_rate = pitch_rate * total_time_rate

        if abs(total_varispeed_rate - 1.0) > 1e-4:
            target_sr = float(sr) / total_varispeed_rate
            if target_sr > 0:
                audio_data = librosa.resample(
                    y=audio_data,
                    orig_sr=float(sr),
                    target_sr=target_sr,
                    axis=-1,
                )
    else:
        requires_pitch_shift = abs(total_semitones) > 1e-4
        requires_time_stretch = mode != "off" and abs(total_time_rate - 1.0) > 1e-4
        if algorithm is not StretchAlgorithm.LIBROSA and (requires_pitch_shift or requires_time_stretch):
            # Rubber Band processes pitch and tempo together in one high-quality pass.
            audio_data = stretch_with_rubberband(
                audio_data,
                sr,
                algorithm=algorithm,
                tempo_rate=total_time_rate if mode != "off" else 1.0,
                semitones=total_semitones,
                fast_engine=fast_preview,
            )
        else:
            # Retained solely for saved nodes that explicitly choose the legacy
            # algorithm. New nodes use Rubber Band by default.
            if requires_pitch_shift:
                audio_data = librosa.effects.pitch_shift(y=audio_data, sr=sr, n_steps=total_semitones)
            if requires_time_stretch:
                audio_data = librosa.effects.time_stretch(y=audio_data, rate=total_time_rate)

    # SoundFile and every transform already produce float32. Avoid a full
    # allocation on the overwhelmingly common bypass path.
    result = audio_data.astype(np.float32, copy=False)
    operations: list[str] = []
    if abs(total_semitones) > 1e-4:
        operations.append(f"pitch {total_semitones:+.2f} st")
    if mode != "off" and abs(total_time_rate - 1.0) > 1e-4:
        operations.append(f"rate {total_time_rate:.3f}x")
    operation_text = ", ".join(operations) if operations else "bypass"
    trace_runtime(
        f"DSP transform {operation_text}: {input_frame_count} -> {result.shape[-1]} samples "
        f"({(perf_counter() - transform_started_at) * 1000.0:.1f} ms)"
    )
    return result


def stretch_audio(audio_data: np.ndarray, original_bpm: float, target_bpm: float) -> np.ndarray:
    """
    Time-stretches audio array to match target BPM from original BPM.
    Legacy wrapper using process_sample_transform.
    """
    return process_sample_transform(
        audio_data=audio_data,
        original_bpm=original_bpm,
        target_bpm=target_bpm,
        sample_type="loop",
        stretch_mode="time_stretch"
    )


def load_sample(filepath: Union[str, Path], target_sr: int = 44100) -> Tuple[np.ndarray, float]:
    """
    Load audio using librosa's native ``(..., samples)`` layout and resample
    to ``target_sr``. Mono files remain one-dimensional, while multi-channel
    files use leading channel dimensions (normally ``channels, samples``).

    Returns:
        Tuple[np.ndarray, float]: (float32 audio array, duration in seconds).
    """
    path_obj = Path(filepath)
    if not path_obj.exists():
        trace_runtime(f"File missing: {path_obj}", "error")
        raise FileNotFoundError(f"Audio file not found: {filepath}")

    cache_key = ("audio", str(path_obj.resolve()), int(target_sr))
    cached = get_runtime_cache(cache_key)
    if cached is not None:
        cached_audio, cached_duration = cached
        trace_runtime(
            f"File cache hit: {path_obj.name}, {cached_audio.shape[-1]} frames"
        )
        return cached_audio, cached_duration

    load_started_at = perf_counter()
    loader = "SoundFile"
    source_sr = target_sr
    resampled = False
    try:
        # SoundFile is the direct, low-overhead path for the WAV/FLAC assets
        # managed by GAIA. Keep Librosa only as a compatibility fallback and
        # for the uncommon case where resampling is actually required.
        audio_array, source_sr = sf.read(str(path_obj), dtype="float32", always_2d=False)
        audio_array = np.asarray(audio_array, dtype=np.float32)
        if audio_array.ndim > 1:
            audio_array = np.moveaxis(audio_array, -1, 0)
        if int(source_sr) != int(target_sr):
            resampled = True
            audio_array = librosa.resample(
                y=audio_array,
                orig_sr=float(source_sr),
                target_sr=float(target_sr),
                axis=-1,
            ).astype(np.float32)
    except (OSError, RuntimeError, sf.LibsndfileError):
        loader = "Librosa fallback"
        audio_array, _ = librosa.load(str(path_obj), sr=target_sr, mono=False)
        audio_array = audio_array.astype(np.float32)
    duration_seconds = float(audio_array.shape[-1]) / float(target_sr)
    channel_count = 1 if audio_array.ndim == 1 else int(audio_array.shape[0])
    resample_text = f", resampled {source_sr} -> {target_sr} Hz" if resampled else ""
    trace_runtime(
        f"File loaded via {loader}: {path_obj.name}, {channel_count} ch, "
        f"{audio_array.shape[-1]} frames{resample_text} "
        f"({(perf_counter() - load_started_at) * 1000.0:.1f} ms)"
    )
    set_runtime_cache(cache_key, (audio_array, duration_seconds))
    return audio_array, duration_seconds
