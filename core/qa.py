"""Audio Quality Assurance & Verification Analyzer for SIN rendering."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Union
import numpy as np
import soundfile as sf


@dataclass
class AudioQAResult:
    duration_seconds: float = 0.0
    sample_rate: int = 44100
    channels: int = 2
    peak_db: float = -math.inf
    rms_db: float = -math.inf
    clipping_samples: int = 0
    has_clipping: bool = False
    is_silent: bool = False
    dc_offset: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "duration_seconds": round(self.duration_seconds, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "peak_db": round(self.peak_db, 2) if math.isfinite(self.peak_db) else -999.0,
            "rms_db": round(self.rms_db, 2) if math.isfinite(self.rms_db) else -999.0,
            "clipping_samples": self.clipping_samples,
            "has_clipping": self.has_clipping,
            "is_silent": self.is_silent,
            "dc_offset": round(self.dc_offset, 5),
            "warnings": self.warnings,
        }


def analyze_audio_buffer(audio: np.ndarray, sample_rate: int = 44100) -> AudioQAResult:
    """Analyze a numpy float buffer (shape (channels, samples) or (samples,))."""
    warnings: list[str] = []

    if audio is None or audio.size == 0:
        return AudioQAResult(
            duration_seconds=0.0,
            sample_rate=sample_rate,
            channels=0,
            is_silent=True,
            warnings=["Audio buffer is empty."],
        )

    # Normalize to 2D: (channels, samples)
    if audio.ndim == 1:
        channels = 1
        samples_count = audio.shape[0]
        data = audio.reshape(1, -1)
    else:
        # Check layout: typically (channels, samples) where channels <= 2
        if audio.shape[0] <= 8 and audio.shape[1] > audio.shape[0]:
            channels = audio.shape[0]
            samples_count = audio.shape[1]
            data = audio
        else:
            # Layout was (samples, channels)
            channels = audio.shape[1]
            samples_count = audio.shape[0]
            data = np.moveaxis(audio, -1, 0)

    duration_seconds = samples_count / max(1, sample_rate)

    max_abs = float(np.max(np.abs(data)))
    if max_abs > 0:
        peak_db = 20.0 * math.log10(max_abs)
    else:
        peak_db = -math.inf

    mean_square = float(np.mean(data ** 2))
    if mean_square > 0:
        rms_db = 20.0 * math.log10(math.sqrt(mean_square))
    else:
        rms_db = -math.inf

    clipping_samples = int(np.sum(np.abs(data) >= 0.9999))
    has_clipping = clipping_samples > 0
    if has_clipping:
        warnings.append(f"Detected {clipping_samples} clipped samples (>= 0 dBFS).")

    is_silent = (peak_db < -70.0) or (duration_seconds < 0.01)
    if is_silent:
        warnings.append("Audio is virtually silent (peak < -70 dBFS).")

    dc_offset = float(np.mean(data))
    if abs(dc_offset) > 0.05:
        warnings.append(f"Significant DC offset detected ({dc_offset:+.3f}).")

    return AudioQAResult(
        duration_seconds=duration_seconds,
        sample_rate=sample_rate,
        channels=channels,
        peak_db=peak_db,
        rms_db=rms_db,
        clipping_samples=clipping_samples,
        has_clipping=has_clipping,
        is_silent=is_silent,
        dc_offset=dc_offset,
        warnings=warnings,
    )


def analyze_audio_file(filepath: Union[str, Path]) -> AudioQAResult:
    """Load and analyze an audio file from disk."""
    path = Path(filepath)
    if not path.is_file():
        return AudioQAResult(warnings=[f"File not found: {path}"])

    data, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    # sf.read returns (samples, channels)
    return analyze_audio_buffer(data, sample_rate)
