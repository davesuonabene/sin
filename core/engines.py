from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, Type
import numpy as np

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject
from core.dsp import load_sample, stretch_audio


class NodeRenderer(ABC):
    """
    Abstract Base Class for node-specific rendering engines.
    """

    @abstractmethod
    def render(self, node_data: Any, system: System) -> np.ndarray:
        """
        Renders audio buffer for the specific node type.
        """
        pass


class TrackRenderer(NodeRenderer):
    """
    Rendering engine specific to Track nodes (container/mixer nodes).
    Sums or chains child audio outputs across timeline tracks.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        audio_obj = build_node_object(node_data)
        return audio_obj.render(system=system)


class SampleRenderer(NodeRenderer):
    """
    Rendering engine specific to Sample nodes (leaf audio sample nodes).
    Loads audio sample file and applies pitch transposition and time-stretching.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        sample_obj = build_node_object(node_data)
        return sample_obj.render(system=system)


class SequenceRenderer(NodeRenderer):
    """
    Rendering engine specific to Sequence nodes (rhythmic pattern step sequencer).
    Repeats child sample object over active step sequence patterns.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        seq_obj = build_node_object(node_data)
        return seq_obj.render(system=system)


class ArrangementRenderer(NodeRenderer):
    """
    Rendering engine specific to Arrangement nodes.
    Repeats child loops to reach user defined bars, applying probability.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        arr_obj = build_node_object(node_data)
        return arr_obj.render(system=system)


RENDERER_REGISTRY: Dict[str, Type[NodeRenderer]] = {
    "track": TrackRenderer,
    "sample": SampleRenderer,
    "sequence": SequenceRenderer,
    "arrangement": ArrangementRenderer
}


def get_renderer_for_node(node_type: str) -> NodeRenderer:
    """
    Factory function returning a specific rendering engine instance based on node_type.
    """
    renderer_cls = RENDERER_REGISTRY.get(node_type.lower(), TrackRenderer)
    return renderer_cls()


def _get_val(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        val = data.get(key)
    else:
        val = getattr(data, key, None)
    return val if val is not None else default


def build_node_object(node_data: Any) -> AudioObject:
    """
    Recursively builds AudioObject, SampleObject, SequenceObject, ItemPoolObject, or ArrangementObject hierarchy from Pydantic model or dict.
    """
    actual_path = _get_val(node_data, "filepath", None)
    if actual_path:
        import os
        if not os.path.exists(actual_path):
            alt_path = os.path.join("assets", actual_path)
            if os.path.exists(alt_path):
                actual_path = alt_path

    node_type = _get_val(node_data, "node_type", "track")
    node_name = _get_val(node_data, "node_name", "AudioNode")
    sample_type = _get_val(node_data, "sample_type", None) or _get_val(node_data, "sample_mode", "loop")
    original_bpm = _get_val(node_data, "original_bpm", 120.0)
    raw_chain = _get_val(node_data, "chain", None) or []
    chain_list = [c.dict() if hasattr(c, 'dict') else (c.model_dump() if hasattr(c, 'model_dump') else c) for c in raw_chain]

    crop_start = _get_val(node_data, "crop_start", 0.0)
    crop_end = _get_val(node_data, "crop_end", 1.0)
    transpose = _get_val(node_data, "transpose", 0.0)
    cents = _get_val(node_data, "cents", 0.0)
    stretch_mode = _get_val(node_data, "stretch_mode", "time_stretch")
    stretch_factor = _get_val(node_data, "stretch_factor", 1.0)

    if node_type == "sequence":
        sequence = _get_val(node_data, "sequence", None) or [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        step_length = _get_val(node_data, "step_length", 0.25)
        play_mode = _get_val(node_data, "play_mode", None) or _get_val(node_data, "playMode", None) or "gate"
        seed = _get_val(node_data, "seed", None)
        seed_mode = _get_val(node_data, "seed_mode", "moving")
        obj = SequenceObject(
            name=node_name,
            sequence=sequence,
            step_parameters=_get_val(node_data, "step_parameters", None),
            step_length=step_length,
            play_mode=play_mode,
            seed=seed,
            seed_mode=seed_mode,
            original_bpm=original_bpm,
            filepath=actual_path,
            chain=chain_list,
            sample_type=sample_type
        )

    elif node_type == "arrangement":
        from core.audio_object import ArrangementObject
        t_bars = _get_val(node_data, "total_bars", 4.0)
        prob = _get_val(node_data, "probability", 1.0)
        seed = _get_val(node_data, "seed", None)
        obj = ArrangementObject(
            name=node_name,
            total_bars=t_bars,
            probability=prob,
            seed=seed,
            original_bpm=original_bpm,
            chain=chain_list,
            section_points=_get_val(node_data, "section_points", None),
            section_enabled=_get_val(node_data, "section_enabled", None),
            section_probability=_get_val(node_data, "section_probability", None),
            section_quant=_get_val(node_data, "section_quant", None),
            section_quant_anchor=_get_val(node_data, "section_quant_anchor", None),
            quant=_get_val(node_data, "quant", "none"),
            quant_anchor=_get_val(node_data, "quant_anchor", "start")
        )
    elif node_type == "sample":
        obj = SampleObject(
            name=node_name,
            filepath=actual_path,
            original_bpm=original_bpm,
            chain=chain_list,
            crop_start=crop_start,
            crop_end=crop_end,
            sample_type=sample_type,
            transpose=transpose,
            cents=cents,
            stretch_mode=stretch_mode,
            stretch_factor=stretch_factor
        )
    else:
        obj = AudioObject(
            name=node_name,
            mix_mode=_get_val(node_data, "mix_mode", "sum"),
            original_bpm=original_bpm,
            filepath=actual_path,
            chain=chain_list,
            crop_start=crop_start,
            crop_end=crop_end,
            sample_type=sample_type,
            total_bars=_get_val(node_data, "total_bars", None),
            transpose=transpose,
            cents=cents,
            stretch_mode=stretch_mode,
            stretch_factor=stretch_factor
        )

    children = _get_val(node_data, "children", []) or []
    for child_data in children:
        start_beat = _get_val(child_data, "start_beat", 0.0)
        child_obj = build_node_object(child_data)
        obj.add_child(child_obj, start_beat)

    return obj
