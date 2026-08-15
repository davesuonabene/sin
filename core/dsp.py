from pathlib import Path
from typing import Union, Tuple, Optional
import numpy as np
import librosa


def process_sample_transform(
    audio_data: np.ndarray,
    sr: int = 44100,
    original_bpm: Optional[float] = None,
    target_bpm: Optional[float] = None,
    transpose: float = 0.0,
    cents: float = 0.0,
    stretch_mode: str = "time_stretch",
    stretch_factor: float = 1.0,
    sample_type: str = "loop"
) -> np.ndarray:
    """
    Applies pitch transposition and time-stretching transformations to audio array.

    - transpose: pitch shift in semitones (e.g. -24.0 to +24.0)
    - cents: fine tune pitch shift in cents (-100.0 to +100.0)
    - stretch_mode: 'time_stretch' (independent pitch/tempo), 'pitch_shift'/'varispeed'
      (locked pitch/tempo repitching via resampling), or 'off'
    - stretch_factor: speed/duration multiplier (e.g. 0.5 = half speed / double duration, 2.0 = 2x speed)
    - sample_type: 'loop' or 'one_shot' / 'oneshot'
    """
    if audio_data.shape[-1] == 0:
        return audio_data.astype(np.float32)

    mode = str(stretch_mode or "time_stretch").lower()
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
        # Time-stretch mode (or off mode)
        # 1. Pitch shift (independent of duration)
        if abs(total_semitones) > 1e-4:
            audio_data = librosa.effects.pitch_shift(y=audio_data, sr=sr, n_steps=total_semitones)

        # 2. Time stretch (independent of pitch)
        if mode != "off" and abs(total_time_rate - 1.0) > 1e-4:
            audio_data = librosa.effects.time_stretch(y=audio_data, rate=total_time_rate)

    return audio_data.astype(np.float32)


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
        raise FileNotFoundError(f"Audio file not found: {filepath}")

    audio_array, sr = librosa.load(str(path_obj), sr=target_sr, mono=False)
    audio_array = audio_array.astype(np.float32)
    duration_seconds = float(audio_array.shape[-1]) / float(sr)
    return audio_array, duration_seconds
