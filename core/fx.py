import numpy as np
from typing import List, Dict, Any


def apply_gain(audio: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    if "gain" in params and params["gain"] is not None:
        gain = float(params["gain"])
    elif "gain_db" in params and params["gain_db"] is not None:
        gain_db = float(params["gain_db"])
        gain = 0.0 if gain_db <= -35.9 else float(10.0 ** (gain_db / 20.0))
    else:
        gain = 1.0
    if gain == 1.0:
        return audio
    return (audio * gain).astype(np.float32, copy=False)


# Node chains currently support gain staging only (Pre Gain / Post Gain).
# All other sound shaping belongs to node-level functionality.
FX_PROCESSORS = {
    "gain": apply_gain,
}


def process_chain(audio_data: np.ndarray, chain_config: List[Dict[str, Any]], sample_rate: int = 44100) -> np.ndarray:
    """
    Executes gain-staging modules sequentially on the given audio_data buffer.
    Any unimplemented/placeholder module types are safely skipped as no-ops.
    """
    if audio_data.shape[-1] == 0 or not chain_config:
        return audio_data

    buffer = np.asarray(audio_data, dtype=np.float32)

    for module in chain_config:
        if not isinstance(module, dict) or not module.get("enabled", True):
            continue

        mod_type = str(module.get("type", "")).lower()
        processor = FX_PROCESSORS.get(mod_type)
        if processor is not None:
            try:
                buffer = processor(buffer, module.get("params", {}) or {})
            except Exception as e:
                import logging
                logging.getLogger("beat_generator.dsp").error(f"Error processing FX module {mod_type}: {e}")

    return buffer.astype(np.float32, copy=False)
