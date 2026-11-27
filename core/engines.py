from abc import ABC
from typing import Dict, Any, Type
import numpy as np

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, ItemPoolObject, ArrangementObject


class NodeRenderer(ABC):
    """
    Base Class for node-specific rendering engines.
    Packs the node graph into a flat `SinRenderPlan` via `core.plan_packer` and executes
    mixing/resampling/gain staging natively in `libsin_dsp` whenever available.
    """

    def render(self, node_data: Any, system: System) -> np.ndarray:
        root_obj = build_node_object(node_data)
        from core.audio_engine import is_native_engine_available, render_plan_offline
        if is_native_engine_available():
            from core.plan_packer import pack_audio_object
            plan = pack_audio_object(root_obj, system)
            tap_ids = None
            if system is not None and system.render_mode == "preview":
                tap_ids = [
                    b.bus_id for b in plan.buses
                    if b.node_type in ("track", "master", "bus", "arrangement", "sequence", "null", "sample", "preamp_denoise", "voice_isolator")
                    and b.node_key.isdigit()
                ][:64]
            audio_out, taps = render_plan_offline(plan, sample_rate=system.sample_rate, bus_tap_ids=tap_ids)
            if system is not None and system.render_mode == "preview":
                for b in plan.buses:
                    if b.bus_id in taps and b.node_key.isdigit():
                        stem_arr = taps[b.bus_id]
                        dur = float(stem_arr.shape[-1]) / float(system.sample_rate)
                        system.record_node_stem(int(b.node_key), b.node_type, b.node_name, stem_arr, dur)
            return audio_out
        return root_obj.render(system=system)


class TrackRenderer(NodeRenderer):
    """Rendering engine specific to Track nodes (container/mixer nodes)."""


class SampleRenderer(NodeRenderer):
    """Rendering engine specific to Sample nodes (leaf audio sample nodes)."""


class SequenceRenderer(NodeRenderer):
    """Rendering engine specific to Sequence nodes (rhythmic pattern step sequencer)."""


class ArrangementRenderer(NodeRenderer):
    """Rendering engine specific to Arrangement nodes."""


class NullRenderer(NodeRenderer):
    """Rendering engine specific to single-input Null pass-through nodes."""


class PreampDenoiseRenderer(NodeRenderer):
    """Rendering engine specific to standalone Preamp De-Noise processor nodes."""


class VoiceIsolatorRenderer(NodeRenderer):
    """Rendering engine specific to standalone 3-way Voice Isolator processor nodes."""


RENDERER_REGISTRY: Dict[str, Type[NodeRenderer]] = {
    "track": TrackRenderer,
    "sample": SampleRenderer,
    "sequence": SequenceRenderer,
    "arrangement": ArrangementRenderer,
    "null": NullRenderer,
    "preamp_denoise": PreampDenoiseRenderer,
    "voice_isolator": VoiceIsolatorRenderer,
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
    chain_list = [dict(c.model_dump() if hasattr(c, "model_dump") else (c.dict() if hasattr(c, "dict") else c)) for c in raw_chain]
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
        repeat=_get_val(node_data, "repeat", None),
        warp=_get_val(node_data, "warp", None),
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
            active_slot=_get_val(node_data, "active_slot", 0),
            sample_slot=_get_val(node_data, "sample_slot", "*"),
            step_slots=_get_val(node_data, "step_slots", None),
            cycle_seeds=_get_val(node_data, "cycle_seeds", None),
            pool_query=_get_val(node_data, "pool_query", None),
            selected_items=_get_val(node_data, "selected_items", []) or [],
            field_operators=_get_val(node_data, "field_operators", None),
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
        has_pool_query_or_ops = (
            bool(_get_val(node_data, "pool_query", None))
            or bool(_get_val(node_data, "field_operators", None))
            or any(
                (
                    bool(s.get("pool_query")) or bool(s.get("field_operators"))
                    if isinstance(s, dict)
                    else bool(getattr(s, "pool_query", None)) or bool(getattr(s, "field_operators", None))
                )
                for s in raw_slots
            )
        )
        is_dynamic_pool_mode = refresh_mode in {
            "local", "local_refresh", "self_render",
            "parent", "parent_refresh", "parent_render",
        }
        is_global_pool_mode = refresh_mode in {"global", "global_refresh"}
        if not has_multi_slots and not has_pool_query_or_ops and selected_items and (
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
                active_slot=_get_val(node_data, "active_slot", 0),
                pool_query=_get_val(node_data, "pool_query", None),
                selected_items=selected_items,
                field_operators=_get_val(node_data, "field_operators", None),
                seed=_get_val(node_data, "seed", None),
            )
    elif str(node_type or "").lower() == "null":
        obj = AudioObject(
            **common_dsp_kwargs,
            **crop_kwargs,
            mix_mode="first",
            filepath=actual_path,
            node_type="null",
        )
    elif str(node_type or "").lower() == "preamp_denoise":
        from core.processor_nodes import PreampDenoiseObject

        obj = PreampDenoiseObject(
            **common_dsp_kwargs,
            **crop_kwargs,
            mix_mode=_get_val(node_data, "mix_mode", "sum"),
            filepath=actual_path,
            processor_params=dict(_get_val(node_data, "processor_params", None) or {}),
        )
    elif str(node_type or "").lower() == "voice_isolator":
        from core.processor_nodes import VoiceIsolatorObject

        obj = VoiceIsolatorObject(
            **common_dsp_kwargs,
            **crop_kwargs,
            mix_mode=_get_val(node_data, "mix_mode", "sum"),
            filepath=actual_path,
            processor_params=dict(_get_val(node_data, "processor_params", None) or {}),
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
    obj.muted = bool(_get_val(node_data, "muted", False))
    obj.solo = bool(_get_val(node_data, "solo", False))
    try:
        obj.pan = max(-1.0, min(1.0, float(_get_val(node_data, "pan", 0.0) or 0.0)))
    except (TypeError, ValueError):
        obj.pan = 0.0
    resolved_wrapper_bars = _get_val(node_data, "wrapper_bars", None)
    if resolved_wrapper_bars is None:
        resolved_wrapper_bars = _get_val(node_data, "global_bars", None)
    obj.wrapper_bars = resolved_wrapper_bars
    obj.global_bars = resolved_wrapper_bars
    obj.global_seed = _get_val(node_data, "global_seed", None)
    obj.field_seed = _get_val(node_data, "field_seed", None)
    obj.pool_node_id = _get_val(node_data, "pool_node_id", None)
    if not hasattr(obj, "field_operators") or obj.field_operators is None:
        obj.field_operators = dict(_get_val(node_data, "field_operators", None) or {})

    from core.dag_cache import GLOBAL_DAG_CACHE

    children = _get_val(node_data, "children", []) or []
    if obj.node_type.lower() == "null":
        children = children[:1]
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
