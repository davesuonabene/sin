"""Audio time-stretching engines used by the sample DSP pipeline.

This module is deliberately the only place that knows about Rubber Band's
Python wrapper and native executable.  The rest of the audio pipeline deals in
the project's channel-first ``(..., frames)`` NumPy layout.
"""

from __future__ import annotations

import os
import shutil
import sys
from enum import Enum
from pathlib import Path
from typing import Final

import numpy as np


class StretchAlgorithm(str, Enum):
    """Algorithms available to independent pitch/time processing."""

    # General keeps a natural timbre during manual pitch changes.  The previous
    # implementation enabled formant preservation for every sample, which can
    # make non-vocal material sound artificial when pitched down.
    RUBBERBAND = "rubberband"
    RUBBERBAND_VOCAL = "rubberband_vocal"
    RUBBERBAND_PERCUSSIVE = "rubberband_percussive"
    LIBROSA = "librosa"


DEFAULT_STRETCH_ALGORITHM: Final = StretchAlgorithm.RUBBERBAND

# Keep every user-facing preset and its Rubber Band flags together.  R3 is the
# detailed offline engine; R2's crispness control is specifically useful for
# transient-heavy unpitched material such as drums.
RUBBERBAND_PRESET_OPTIONS: Final[dict[StretchAlgorithm, dict[str, str]]] = {
    StretchAlgorithm.RUBBERBAND: {"--fine": ""},
    StretchAlgorithm.RUBBERBAND_VOCAL: {"--fine": "", "--formant": ""},
    StretchAlgorithm.RUBBERBAND_PERCUSSIVE: {"--fast": "", "--crisp": "6"},
}


class RubberBandUnavailableError(RuntimeError):
    """Raised when the native Rubber Band executable cannot be located."""


def normalize_stretch_algorithm(value: str | StretchAlgorithm | None) -> StretchAlgorithm:
    """Return a supported algorithm, keeping older saved nodes compatible."""

    if isinstance(value, StretchAlgorithm):
        return value
    try:
        return StretchAlgorithm(str(value or DEFAULT_STRETCH_ALGORITHM.value).lower())
    except ValueError:
        return DEFAULT_STRETCH_ALGORITHM


def stretch_with_rubberband(
    audio_data: np.ndarray,
    sample_rate: int,
    *,
    algorithm: StretchAlgorithm,
    tempo_rate: float,
    semitones: float,
    fast_engine: bool = False,
) -> np.ndarray:
    """Process audio once with the configured Rubber Band offline preset.

    ``tempo_rate`` matches the rest of SIN: values above one play faster and
    therefore shorten the output.  Rubber Band receives both the tempo and
    pitch settings in one invocation, avoiding a second lossy transform.
    """

    executable = _find_rubberband_executable()
    if executable is None:
        raise RubberBandUnavailableError(
            "Rubber Band is not installed. Run tools/install-rubberband.ps1 "
            "after installing requirements.txt, or set SIN_RUBBERBAND_EXECUTABLE."
        )

    try:
        import pyrubberband.pyrb as pyrb
    except ImportError as exc:  # pragma: no cover - covered by launcher verification
        raise RubberBandUnavailableError(
            "pyrubberband is not installed. Install requirements.txt before rendering."
        ) from exc

    # pyrubberband's public helpers support one operation at a time.  Its
    # version-pinned command bridge accepts the normal Rubber Band options, so
    # the isolated adapter can request tempo and pitch together in one pass.
    command_bridge = getattr(pyrb, "__rubberband", None)
    if command_bridge is None:  # pragma: no cover - defensive dependency guard
        raise RubberBandUnavailableError(
            "The installed pyrubberband version is unsupported; install the pinned requirements."
        )
    setattr(pyrb, "__RUBBERBAND_UTIL", str(executable))

    input_audio, was_multichannel = _to_channel_last(audio_data)
    engine_options = rubberband_options_for(algorithm)
    if fast_engine:
        # Interactive previews need low latency. Preserve material-specific
        # flags (for example vocal formants), but use Rubber Band's R2 engine;
        # the offline render path retains the higher-CPU R3 preset.
        engine_options.pop("--fine", None)
        engine_options["--fast"] = ""
    options: dict[str, str | float] = {
        **engine_options,
        "--tempo": float(tempo_rate),
        "--pitch": float(semitones),
    }
    if was_multichannel and input_audio.shape[1] == 2:
        options["--centre-focus"] = ""

    try:
        transformed = command_bridge(input_audio, int(sample_rate), **options)
    except Exception as exc:
        raise RuntimeError(f"Rubber Band processing failed: {exc}") from exc

    return _from_channel_last(transformed, was_multichannel)


def rubberband_options_for(algorithm: StretchAlgorithm) -> dict[str, str]:
    """Return a copy of the Rubber Band flags for a selectable preset."""

    try:
        return dict(RUBBERBAND_PRESET_OPTIONS[algorithm])
    except KeyError as exc:
        raise ValueError(f"{algorithm.value} is not a Rubber Band preset.") from exc


def _to_channel_last(audio_data: np.ndarray) -> tuple[np.ndarray, bool]:
    """Convert SIN's channel-first array into Rubber Band's documented layout."""

    audio = np.asarray(audio_data, dtype=np.float32)
    if audio.ndim == 1:
        return np.ascontiguousarray(audio), False
    if audio.ndim == 2:
        return np.ascontiguousarray(np.moveaxis(audio, 0, -1)), True
    raise ValueError("Rubber Band accepts mono or channel-first 2D audio only.")


def _from_channel_last(audio_data: np.ndarray, was_multichannel: bool) -> np.ndarray:
    audio = np.asarray(audio_data, dtype=np.float32)
    if was_multichannel:
        return np.ascontiguousarray(np.moveaxis(audio, -1, 0))
    return np.ascontiguousarray(audio)


def _find_rubberband_executable() -> Path | None:
    """Locate the managed executable first, then allow explicit/system installs."""

    configured = os.environ.get("SIN_RUBBERBAND_EXECUTABLE")
    candidates = [
        Path(configured) if configured else None,
        Path(sys.executable).resolve().parent.parent / "tools" / "rubberband" / _executable_name(),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate

    discovered = shutil.which("rubberband")
    return Path(discovered) if discovered else None


def _executable_name() -> str:
    return "rubberband.exe" if os.name == "nt" else "rubberband"
