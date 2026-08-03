from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, Type
import numpy as np

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, SamplePoolObject
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
    Loads audio sample file and time-stretches if BPM differs.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        filepath = getattr(node_data, "filepath", None)
        if not filepath:
            return np.zeros(0, dtype=np.float32)

        sample_type = getattr(node_data, "sample_type", None) or getattr(node_data, "sample_mode", "loop")
        original_bpm = getattr(node_data, "original_bpm", 120.0) or 120.0
        target_bpm = getattr(node_data, "target_bpm", None) or getattr(node_data, "bpm", None) or system.bpm
        sample_rate = system.sample_rate

        audio_array, _ = load_sample(filepath, target_sr=sample_rate)
        if len(audio_array) == 0:
            return np.zeros(0, dtype=np.float32)

        crop_start = getattr(node_data, "crop_start", 0.0) or 0.0
        crop_end = getattr(node_data, "crop_end", 1.0) or 1.0
        if crop_start > 0.0 or crop_end < 1.0:
            total_samples = len(audio_array)
            s_idx = int(max(0.0, min(1.0, crop_start)) * total_samples)
            e_idx = int(max(0.0, min(1.0, crop_end)) * total_samples)
            if s_idx < e_idx:
                audio_array = audio_array[s_idx:e_idx]
            else:
                audio_array = np.zeros(0, dtype=np.float32)

        if len(audio_array) == 0:
            return np.zeros(0, dtype=np.float32)

        if sample_type not in ("one_shot", "oneshot"):
            if original_bpm != target_bpm:
                audio_array = stretch_audio(audio_array, original_bpm, target_bpm)

        return audio_array.astype(np.float32)


class SamplePoolRenderer(NodeRenderer):
    """
    Rendering engine specific to Sample Pool nodes.
    Dynamically picks and renders samples based on pool state.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        pool_obj = build_node_object(node_data)
        return pool_obj.render(system=system)


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


# Registry mapping node_type -> Renderer class
RENDERER_REGISTRY: Dict[str, Type[NodeRenderer]] = {
    "track": TrackRenderer,
    "sample": SampleRenderer,
    "sequence": SequenceRenderer,
    "sample_pool": SamplePoolRenderer,
    "arrangement": ArrangementRenderer
}


def get_renderer_for_node(node_type: str) -> NodeRenderer:
    """
    Factory function returning a specific rendering engine instance based on node_type.
    """
    renderer_cls = RENDERER_REGISTRY.get(node_type.lower(), TrackRenderer)
    return renderer_cls()


def build_node_object(node_data: Any) -> AudioObject:
    """
    Recursively builds AudioObject, SampleObject, SequenceObject, or ArrangementObject hierarchy from Pydantic model.
    """
    actual_path = getattr(node_data, "filepath", None)
    if actual_path:
        import os
        if not os.path.exists(actual_path):
            alt_path = os.path.join("assets", actual_path)
            if os.path.exists(alt_path):
                actual_path = alt_path

    node_type = getattr(node_data, "node_type", "track")
    node_name = getattr(node_data, "node_name", "AudioNode")
    sample_type = getattr(node_data, "sample_type", None) or getattr(node_data, "sample_mode", "loop")
    original_bpm = getattr(node_data, "original_bpm", 120.0)
    raw_chain = getattr(node_data, "chain", None) or []
    chain_list = [c.dict() if hasattr(c, 'dict') else (c.model_dump() if hasattr(c, 'model_dump') else c) for c in raw_chain]

    crop_start = getattr(node_data, "crop_start", 0.0) or 0.0
    crop_end = getattr(node_data, "crop_end", 1.0) or 1.0

    if node_type == "sequence":
        sequence = getattr(node_data, "sequence", None) or [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        step_length = getattr(node_data, "step_length", 0.25) or 0.25
        obj = SequenceObject(
            name=node_name,
            sequence=sequence,
            step_length=step_length,
            original_bpm=original_bpm,
            filepath=actual_path,
            chain=chain_list,
            sample_type=sample_type
        )
    elif node_type == "sample_pool":
        filters = getattr(node_data, "filters", None) or {}
        playback_mode = getattr(node_data, "playbackMode", "Random")
        seed = getattr(node_data, "seed", 0.0)
        obj = SamplePoolObject(
            name=node_name,
            filters=filters,
            playback_mode=playback_mode,
            seed=seed,
            original_bpm=original_bpm,
            chain=chain_list
        )
    elif node_type == "arrangement":
        from core.audio_object import ArrangementObject
        t_bars = getattr(node_data, "total_bars", None)
        if t_bars is None:
            t_bars = 4.0
        prob = getattr(node_data, "probability", None)
        if prob is None:
            prob = 1.0
        seed = getattr(node_data, "seed", None)
        obj = ArrangementObject(
            name=node_name,
            total_bars=t_bars,
            probability=prob,
            seed=seed,
            original_bpm=original_bpm,
            chain=chain_list
        )
    elif node_type == "sample":
        obj = SampleObject(
            name=node_name,
            filepath=actual_path,
            original_bpm=original_bpm,
            chain=chain_list,
            crop_start=crop_start,
            crop_end=crop_end,
            sample_type=sample_type
        )
    else:
        obj = AudioObject(
            name=node_name,
            mix_mode=getattr(node_data, "mix_mode", "sum") or "sum",
            original_bpm=original_bpm,
            filepath=actual_path,
            chain=chain_list,
            crop_start=crop_start,
            crop_end=crop_end,
            sample_type=sample_type
        )

    children = getattr(node_data, "children", [])
    for child_data in children:
        start_beat = getattr(child_data, "start_beat", 0.0) or 0.0
        child_obj = build_node_object(child_data)
        obj.add_child(child_obj, start_beat)

    return obj
