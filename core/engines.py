from abc import ABC
from typing import Dict, Any, Type
import numpy as np

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, ItemPoolObject, ArrangementObject


class NodeRenderer(ABC):
    """
    Base Class for node-specific rendering engines.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        return build_node_object(node_data).render(system=system)


class TrackRenderer(NodeRenderer):
    """Rendering engine specific to Track nodes (container/mixer nodes)."""


class SampleRenderer(NodeRenderer):
    """Rendering engine specific to Sample nodes (leaf audio sample nodes)."""


class SequenceRenderer(NodeRenderer):
    """Rendering engine specific to Sequence nodes (rhythmic pattern step sequencer)."""


class ArrangementRenderer(NodeRenderer):
    """Rendering engine specific to Arrangement nodes."""


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
    val = data.get(key) if isinstance(data, dict) else getattr(data, key, None)
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
    original_bpm = _get_val(node_data, "original_bpm", None)
    raw_chain = _get_val(node_data, "chain", None) or []
    chain_list = [dict(c.dict() if hasattr(c, 'dict') else (c.model_dump() if hasattr(c, 'model_dump') else c)) for c in raw_chain]
    top_gain_db = _get_val(node_data, "gain", None)
    if top_gain_db is not None and not chain_list:
        try:
            g_db = float(top_gain_db)
            g_lin = 0.0 if g_db <= -35.9 else float(10.0 ** (g_db / 20.0))
            chain_list = [{
                "id": "post_gain_0",
                "type": "gain",
                "name": "Post Gain",
                "enabled": True,
                "fixed": True,
                "params": {"gain": g_lin, "gain_db": g_db}
            }]
        except (TypeError, ValueError):
            pass

    target_bpm_raw = _get_val(node_data, "target_bpm", None)
    target_bpm = None
    if target_bpm_raw is not None and str(target_bpm_raw).lower() != "global":
        try:
            target_bpm = float(target_bpm_raw)
        except (ValueError, TypeError):
            target_bpm = None

    node_id = _get_val(node_data, "node_id", None)
    common_dsp_kwargs = dict(
        name=node_name,
        original_bpm=original_bpm,
        chain=chain_list,
        sample_type=sample_type,
        transpose=_get_val(node_data, "transpose", 0.0),
        cents=_get_val(node_data, "cents", 0.0),
        stretch_mode=_get_val(node_data, "stretch_mode", "time_stretch"),
        stretch_factor=_get_val(node_data, "stretch_factor", 1.0),
        stretch_algorithm=_get_val(node_data, "stretch_algorithm", "rubberband"),
        total_bars=_get_val(node_data, "total_bars", None),
        key_match_mode=_get_val(node_data, "key_match_mode", "off"),
        key_match_algorithm=_get_val(node_data, "key_match_algorithm", "nearest"),
        node_id=node_id,
    )
    crop_kwargs = dict(
        crop_start=_get_val(node_data, "crop_start", 0.0),
        crop_end=_get_val(node_data, "crop_end", 1.0),
        target_bpm=target_bpm,
    )

    if node_type == "sequence":
        obj = SequenceObject(
            **common_dsp_kwargs,
            sequence=_get_val(node_data, "sequence", None) or [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_parameters=_get_val(node_data, "step_parameters", None),
            step_length=_get_val(node_data, "step_length", 0.25),
            play_mode=_get_val(node_data, "play_mode", None) or _get_val(node_data, "playMode", None) or "gate",
            release=_get_val(node_data, "release", 0.0),
            fade_ms=_get_val(node_data, "fade_ms", 0.0),
            seed=_get_val(node_data, "seed", None),
            seed_mode=_get_val(node_data, "seed_mode", "moving"),
            filepath=actual_path,
            slots=_get_val(node_data, "slots", None),
            sample_slot=_get_val(node_data, "sample_slot", "0"),
            step_slots=_get_val(node_data, "step_slots", None),
            cycle_seeds=_get_val(node_data, "cycle_seeds", None),
        )
    elif node_type == "arrangement":
        obj = ArrangementObject(
            name=node_name,
            total_bars=_get_val(node_data, "total_bars", 4.0),
            probability=_get_val(node_data, "probability", 1.0),
            seed=_get_val(node_data, "seed", None),
            original_bpm=original_bpm,
            chain=chain_list,
            section_points=_get_val(node_data, "section_points", None),
            section_enabled=_get_val(node_data, "section_enabled", None),
            section_probability=_get_val(node_data, "section_probability", None),
            section_sample_start=_get_val(node_data, "section_sample_start", None),
            section_quant=_get_val(node_data, "section_quant", None),
            section_quant_anchor=_get_val(node_data, "section_quant_anchor", None),
            section_slots=_get_val(node_data, "section_slots", None),
            cycle_seeds=_get_val(node_data, "cycle_seeds", None),
            quant=_get_val(node_data, "quant", "auto"),
            quant_anchor=_get_val(node_data, "quant_anchor", "start"),
            node_id=node_id,
            node_type=node_type
        )
    elif node_type == "sample":
        refresh_mode = str(_get_val(node_data, "refresh_mode", "off") or "off").strip().casefold()
        selected_items = _get_val(node_data, "selected_items", []) or []
        raw_slots = _get_val(node_data, "slots", []) or []
        has_multi_slots = len(raw_slots) > 1 or any(
            (s.get("filepath") if isinstance(s, dict) else getattr(s, "filepath", None))
            for s in raw_slots[1:]
        )
        has_populated_slots = any(
            (s.get("filepath") if isinstance(s, dict) else getattr(s, "filepath", None))
            for s in raw_slots
        )
        is_dynamic_pool_mode = refresh_mode in {
            "local", "local_refresh", "self_render",
            "parent", "parent_refresh", "parent_render",
        }
        is_global_pool_mode = refresh_mode in {"global", "global_refresh"}
        if not has_multi_slots and selected_items and (
            is_dynamic_pool_mode
            or (is_global_pool_mode and not (actual_path or has_populated_slots))
        ):
            obj = ItemPoolObject(
                **common_dsp_kwargs,
                **crop_kwargs,
                selected_items=selected_items,
                playback_mode=_get_val(node_data, "playbackMode", "Random"),
                seed=_get_val(node_data, "seed", None),
                refresh_mode=refresh_mode,
                node_type="asset_filter",
            )
        else:
            obj = SampleObject(
                **common_dsp_kwargs,
                **crop_kwargs,
                filepath=actual_path,
                node_type="sample",
                slots=raw_slots,
            )
    else:
        obj = AudioObject(
            **common_dsp_kwargs,
            **crop_kwargs,
            mix_mode=_get_val(node_data, "mix_mode", "sum"),
            filepath=actual_path,
            node_type=node_type,
        )

    if node_id is not None:
        obj.node_id = int(node_id)
    obj.node_type = str(node_type or "track")

    from core.dag_cache import GLOBAL_DAG_CACHE

    children = _get_val(node_data, "children", []) or []
    for child_data in children:
        start_beat = _get_val(child_data, "start_beat", 0.0)
        child_obj = build_node_object(child_data)
        obj.add_child(child_obj, start_beat)
        if obj.node_id is not None and getattr(child_obj, "node_id", None) is not None:
            GLOBAL_DAG_CACHE.register_edge(parent_id=obj.node_id, child_id=child_obj.node_id)

    if isinstance(node_data, dict):
        summary = {k: v for k, v in node_data.items() if k not in ("children", "filename", "audio_data")}
    elif hasattr(node_data, "model_dump"):
        summary = {k: v for k, v in node_data.model_dump().items() if k not in ("children", "filename", "audio_data")}
    elif hasattr(node_data, "dict"):
        summary = {k: v for k, v in node_data.dict().items() if k not in ("children", "filename", "audio_data")}
    else:
        summary = {"name": node_name, "type": node_type}
    if obj.children:
        summary["child_fingerprints"] = [
            (round(float(sb), 6), getattr(c, "fingerprint", None))
            for sb, c in obj.children
        ]
    obj.fingerprint = GLOBAL_DAG_CACHE.compute_fingerprint(summary)

    return obj
