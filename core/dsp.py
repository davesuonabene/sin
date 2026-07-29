from pathlib import Path
from typing import Union, Tuple
import numpy as np
import librosa


def stretch_audio(audio_data: np.ndarray, original_bpm: float, target_bpm: float) -> np.ndarray:
    """
    Time-stretches audio array to match target BPM from original BPM.
    Rate > 1 speeds up audio (higher BPM), rate < 1 slows down audio (lower BPM).
    """
    if original_bpm <= 0 or target_bpm <= 0 or original_bpm == target_bpm:
        return audio_data

    rate = float(target_bpm) / float(original_bpm)
    stretched = librosa.effects.time_stretch(y=audio_data, rate=rate)
    return stretched.astype(np.float32)


def load_sample(filepath: Union[str, Path], target_sr: int = 44100) -> Tuple[np.ndarray, float]:
    """
    Loads an audio file using librosa, forcing mono format and resampling
    to target_sr to guarantee sample-by-sample compatibility during mixing.

    Returns:
        Tuple[np.ndarray, float]: (1D float32 numpy array of audio samples, duration in seconds).
    """
    path_obj = Path(filepath)
    if not path_obj.exists():
        raise FileNotFoundError(f"Audio file not found: {filepath}")

    # librosa.load forces mono=True by default and resamples to target_sr
    audio_array, sr = librosa.load(str(path_obj), sr=target_sr, mono=True)
    audio_array = audio_array.astype(np.float32)
    duration_seconds = float(len(audio_array)) / float(sr)
    return audio_array, duration_seconds
