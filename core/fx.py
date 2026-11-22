from abc import ABC, abstractmethod
import logging
from typing import Any, Dict, List, Optional
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
