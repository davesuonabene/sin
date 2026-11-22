"""Pure Python data packer compiling GAIA canonical `sin-graph` documents and SIN
`AudioNodeModel` workspaces into flat `SinRenderPlan` structures for `libsin_dsp`.

Responsibilities:
- Python owns graph resolution, GAIA path resolution, ERMES pseudolanguage (`slot_language.py`),
  3-tier dirty caching (`DagNodeCache`), and Tier-2 offline cooking (Rubber Band R3).
- C++ (`libsin_dsp`) owns all file decoding, multi-GB disk streaming, resampling (48kHz default /
  any SR), cropping, looping, fades, voice mixing, bus gain/pan/mute/solo, and device/offline output.
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from core.render_plan import (
    SIN_CLIP_LIVE_CROP_BOUND,
    SIN_CLIP_LIVE_RATE_BOUND,
    SIN_CLIP_LOOP_SOURCE,
    SIN_DEFAULT_SAMPLE_RATE,
    BusSpec,
    ClipSpec,
    SinRenderPlan,
    SourceSpec,
)
from core.system import System
from core.dsp import load_sample, process_sample_transform
from core.dag_cache import GLOBAL_DAG_CACHE
from ermes.py.snapshot import apply_snapshot
from ermes.py.compiler import (
    compile_canonical_graph_to_audio_node_model,
    compile_workspace_to_audio_node_model,
)


def _linear_to_db(gain: float) -> float:
    if gain <= 1e-6:
        return -120.0
    return float(20.0 * math.log10(gain))


def _chain_to_bus_gains(chain: Optional[List[Dict[str, Any]]], top_gain_db: Optional[float] = None) -> Tuple[float, float, float, bool]:
    """Extract (pre_gain_db, volume_linear, post_gain_db, muted) from an ERMES FX chain."""
    pre_db = 0.0
    volume = 1.0
    post_db = 0.0
    muted = False

    modules = chain or []
    if not modules and top_gain_db is not None:
        try:
            g_db = float(top_gain_db)
            post_db = -120.0 if g_db <= -35.9 else g_db
        except (TypeError, ValueError):
            pass
        return pre_db, volume, post_db, muted

    extra_lin = 1.0
    for mod in modules:
        if not isinstance(mod, dict):
            continue
        mod_id = str(mod.get("id") or "").lower()
        mod_type = str(mod.get("type") or "").lower()
        enabled = bool(mod.get("enabled", True))
        params = mod.get("params") or {}

        if mod_id == "mute":
            if enabled:
                muted = True
            continue
        if not enabled or mod_type != "gain":
            continue

        if mod_id == "pre":
            if params.get("gain_db") is not None:
                db = float(params["gain_db"])
                pre_db += (-120.0 if db <= -35.9 else db)
            elif params.get("gain") is not None:
                pre_db += _linear_to_db(float(params["gain"]))
        elif mod_id == "fader":
            if params.get("gain") is not None:
                volume *= max(0.0, float(params["gain"]))
            elif params.get("gain_db") is not None:
                db = float(params["gain_db"])
                volume *= (0.0 if db <= -35.9 else float(10.0 ** (db / 20.0)))
        else:
            if params.get("gain") is not None:
                extra_lin *= max(0.0, float(params["gain"]))
            elif params.get("gain_db") is not None:
                db = float(params["gain_db"])
                extra_lin *= (0.0 if db <= -35.9 else float(10.0 ** (db / 20.0)))

    if abs(extra_lin - 1.0) > 1e-7:
        post_db = _linear_to_db(extra_lin)
    return pre_db, volume, post_db, muted


def _resolve_relative_filepath(raw_path: Optional[str], project_root: Optional[Path]) -> Optional[str]:
    if not raw_path:
        return None
    raw_str = str(raw_path)
    if os.path.isabs(raw_str):
        return raw_str
    if project_root:
        root_path = Path(project_root).resolve()
        cand = (root_path / raw_str).resolve()
        if cand.is_file():
            return str(cand)
        cand_in_files = (root_path / "files" / Path(raw_str).name).resolve()
        if cand_in_files.is_file():
            return str(cand_in_files)
    alt = os.path.join("assets", raw_str)
    if os.path.exists(alt):
        return os.path.abspath(alt)
    return raw_str


def _is_auto_bars(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("", "auto", "free", "none"):
            return True
        try:
            return float(s) <= 0.0
        except ValueError:
            return True
    try:
        return float(value) <= 0.0
    except (TypeError, ValueError):
        return True


def _needs_offline_stretch(props: Dict[str, Any], target_bpm: float) -> bool:
    mode = str(props.get("stretch_mode") or "off").lower()
    if mode in ("off", "pitch_shift", "repitch", "varispeed"):
        return False
    transpose = float(props.get("transpose") or 0.0)
    cents = float(props.get("cents") or 0.0)
    if abs(transpose + cents / 100.0) > 1e-4:
        return True
    factor = float(props.get("stretch_factor") or 1.0)
    if abs(factor - 1.0) > 1e-4:
        return True
    sample_type = str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower()
    orig_bpm = props.get("original_bpm")
    if sample_type not in ("one_shot", "oneshot") and orig_bpm is not None:
        try:
            if float(orig_bpm) > 0 and target_bpm > 0 and abs(float(orig_bpm) - float(target_bpm)) > 1e-4:
                return True
        except (TypeError, ValueError):
            pass
    return False


def _varispeed_rate(props: Dict[str, Any], target_bpm: float) -> float:
    mode = str(props.get("stretch_mode") or "off").lower()
    if mode not in ("pitch_shift", "repitch", "varispeed"):
        return 1.0
    semis = float(props.get("transpose") or 0.0) + float(props.get("cents") or 0.0) / 100.0
    pitch_rate = 2.0 ** (semis / 12.0)
    factor = float(props.get("stretch_factor") or 1.0)
    if factor <= 0:
        factor = 1.0
    bpm_rate = 1.0
    sample_type = str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower()
    orig_bpm = props.get("original_bpm")
    if sample_type not in ("one_shot", "oneshot") and orig_bpm is not None:
        try:
            if float(orig_bpm) > 0 and target_bpm > 0:
                bpm_rate = float(target_bpm) / float(orig_bpm)
        except (TypeError, ValueError):
            pass
    return max(0.05, float(pitch_rate * factor * bpm_rate))


def _cook_stretched_sample(filepath: str, props: Dict[str, Any], target_bpm: float, sr: int) -> Tuple[np.ndarray, int]:
    """Tier-2 lazy Python cooker for Rubber Band / librosa time-stretch, cached in DagNodeCache."""
    cook_key = {
        "op": "tier2_cook",
        "path": filepath,
        "sr": sr,
        "target_bpm": round(float(target_bpm), 4),
        "original_bpm": props.get("original_bpm"),
        "transpose": float(props.get("transpose") or 0.0),
        "cents": float(props.get("cents") or 0.0),
        "stretch_mode": str(props.get("stretch_mode") or "time_stretch"),
        "stretch_factor": float(props.get("stretch_factor") or 1.0),
        "stretch_algorithm": str(props.get("stretch_algorithm") or "rubberband"),
        "sample_type": str(props.get("sample_type") or "loop"),
        "key_match_mode": str(props.get("key_match_mode") or "off"),
        "key_match_algorithm": str(props.get("key_match_algorithm") or "nearest"),
    }
    fp_hash = GLOBAL_DAG_CACHE.compute_fingerprint(cook_key)
    cache_node_id = f"cook:{fp_hash}"
    cached = GLOBAL_DAG_CACHE.get(cache_node_id, fp_hash)
    if cached is not None:
        return cached, int(fp_hash[:12], 16)

    audio, _ = load_sample(filepath, target_sr=sr)
    cooked = process_sample_transform(
        audio_data=audio,
        sr=sr,
        original_bpm=props.get("original_bpm"),
        target_bpm=target_bpm,
        transpose=float(props.get("transpose") or 0.0),
        cents=float(props.get("cents") or 0.0),
        stretch_mode=str(props.get("stretch_mode") or "time_stretch"),
        stretch_factor=float(props.get("stretch_factor") or 1.0),
        stretch_algorithm=str(props.get("stretch_algorithm") or "rubberband"),
        sample_type=str(props.get("sample_type") or "loop"),
        key_match_mode=str(props.get("key_match_mode") or "off"),
        key_match_algorithm=str(props.get("key_match_algorithm") or "nearest"),
    )
    GLOBAL_DAG_CACHE.store(cache_node_id, fp_hash, cooked)
    return cooked, int(fp_hash[:12], 16)


def pack_canonical_graph(
    base_graph: Dict[str, Any],
    snapshot: Optional[Dict[str, Any]] = None,
    transient_overrides: Optional[Dict[str, Any]] = None,
    root_id: Optional[str] = None,
    project_root: Optional[Path] = None,
    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
    workspace: Optional[Dict[str, Any]] = None,
    solo_ids: Optional[List[str]] = None,
) -> SinRenderPlan:
    """Pack a GAIA canonical `sin-graph` (or attached SIN workspace) into a flat `SinRenderPlan`.

    Direct unstretched audio files (including 8 GB Zoom H4 multitracks) are registered strictly
    as file paths (`force_ram=False`) so libsin_dsp streams them directly from disk without
    loading gigabytes into Python RAM.
    """
    use_workspace = (
        isinstance(workspace, dict)
        and isinstance(workspace.get("graph"), dict)
        and bool(workspace["graph"].get("nodes"))
        and snapshot is None
        and not transient_overrides
    )
    if use_workspace:
        resolved_ws = copy.deepcopy(workspace)
        graph = resolved_ws.get("graph") if isinstance(resolved_ws.get("graph"), dict) else resolved_ws
        if project_root and isinstance(graph, dict):
            for node in graph.get("nodes", []):
                props = node.get("properties") if isinstance(node, dict) else None
                if isinstance(props, dict):
                    if props.get("filepath"):
                        props["filepath"] = _resolve_relative_filepath(props.get("filepath"), project_root)
                    for slot in props.get("slots") or []:
                        if isinstance(slot, dict) and slot.get("filepath"):
                            slot["filepath"] = _resolve_relative_filepath(slot.get("filepath"), project_root)
        model = compile_workspace_to_audio_node_model(resolved_ws)
        ws_extra = (resolved_ws.get("graph") or {}).get("extra") or {}
        bpm = float((ws_extra.get("global_parameters") or {}).get("bpm", 120.0))
        sys_obj = System(bpm=bpm, sample_rate=sample_rate, render_mode="offline")
        return pack_audio_node_model(model, sys_obj)

    resolved_graph = apply_snapshot(base_graph, snapshot, transient_overrides)
    settings = resolved_graph.get("settings") or {}
    bpm = float(settings.get("bpm") or 120.0)
    output_cfg = settings.get("output") or {}

    nodes_by_id: Dict[str, Dict[str, Any]] = {}
    for n in resolved_graph.get("nodes", []) or []:
        if isinstance(n, dict) and n.get("id"):
            nodes_by_id[str(n["id"])] = n

    output_root_id = str(root_id or resolved_graph.get("output") or "master")
    if output_root_id not in nodes_by_id:
        for nid, n in nodes_by_id.items():
            if n.get("role") == "master":
                output_root_id = nid
                break

    # Build child -> parent routing map from audio connections
    parent_of: Dict[str, str] = {}
    children_of: Dict[str, List[str]] = {}
    for conn in resolved_graph.get("connections", []) or []:
        if not isinstance(conn, dict):
            continue
        if conn.get("type", "audio") != "audio":
            continue
        src = str(conn.get("from") or "")
        dst = str(conn.get("to") or "")
        if src in nodes_by_id and dst in nodes_by_id:
            parent_of[src] = dst
            children_of.setdefault(dst, []).append(src)

    # Check if canonical graph contains sequence/arrangement nodes; if so, delegate via ERMES AudioNodeModel
    has_procedural = any(
        str(n.get("type") or "").lower() in ("sequence", "arrangement")
        for n in nodes_by_id.values()
    )
    if has_procedural:
        for n in nodes_by_id.values():
            props = n.get("properties") or {}
            if props.get("filepath"):
                props["filepath"] = _resolve_relative_filepath(props["filepath"], project_root)
            for slot in props.get("slots") or []:
                if isinstance(slot, dict) and slot.get("filepath"):
                    slot["filepath"] = _resolve_relative_filepath(slot["filepath"], project_root)
        model = compile_canonical_graph_to_audio_node_model(resolved_graph, root_id=root_id)
        sys_obj = System(bpm=bpm, sample_rate=sample_rate, render_mode="offline")
        plan = pack_audio_node_model(model, sys_obj)
        if isinstance(output_cfg, dict):
            plan.normalize = bool(output_cfg.get("normalize", False))
            plan.target_peak_db = float(output_cfg.get("target_peak_db", -1.0))
        return plan

    plan = SinRenderPlan(
        sample_rate=int(sample_rate or SIN_DEFAULT_SAMPLE_RATE),
        bpm=bpm,
        normalize=bool(output_cfg.get("normalize", False)) if isinstance(output_cfg, dict) else False,
        target_peak_db=float(output_cfg.get("target_peak_db", -1.0)) if isinstance(output_cfg, dict) else -1.0,
    )

    solo_set = {str(s) for s in (solo_ids or [])}

    # Explicit total_bars on root or settings ("auto" => 0.0 unconstrained)
    root_node = nodes_by_id.get(output_root_id, {})
    root_props = root_node.get("properties") or {}
    raw_bars = root_props.get("total_bars")
    if raw_bars is None:
        raw_bars = settings.get("total_bars")
    if not _is_auto_bars(raw_bars):
        bars_val = float(raw_bars)
        plan.explicit_duration_sec = bars_val * 4.0 * (60.0 / bpm)

    # Collect reachable nodes from output_root_id
    reachable: List[str] = []
    visited = set()
    stack = [output_root_id]
    while stack:
        nid = stack.pop()
        if nid in visited or nid not in nodes_by_id:
            continue
        visited.add(nid)
        reachable.append(nid)
        for cid in children_of.get(nid, []):
            stack.append(cid)

    # Assign Bus IDs to every non-sample node (master = 1)
    next_bus_id = 1
    bus_node_ids: List[str] = [output_root_id] + [
        nid for nid in reachable
        if nid != output_root_id and str(nodes_by_id[nid].get("type") or "").lower() != "sample"
    ]
    for nid in bus_node_ids:
        bid = next_bus_id
        next_bus_id += 1
        plan.bus_id_map[nid] = bid
        plan.bus_key_map[bid] = nid

    # Build BusSpecs
    bus_by_id: Dict[int, BusSpec] = {}
    for nid in bus_node_ids:
        node = nodes_by_id[nid]
        props = node.get("properties") or {}
        bid = plan.bus_id_map[nid]
        p_nid = parent_of.get(nid)
        parent_bid = plan.bus_id_map.get(p_nid, 0) if (nid != output_root_id and p_nid) else 0
        pre_db, vol, post_db, muted = _chain_to_bus_gains(props.get("chain"), props.get("gain"))
        pan = float(props.get("pan") or 0.0)
        bs = BusSpec(
            bus_id=bid,
            parent_bus_id=parent_bid,
            node_key=nid,
            node_type=str(node.get("type") or "track"),
            node_name=str(props.get("node_name") or nid),
            pre_gain_db=pre_db,
            volume=vol,
            post_gain_db=post_db,
            pan=pan,
            muted=muted,
            solo=(nid in solo_set),
        )
        plan.buses.append(bs)
        bus_by_id[bid] = bs

    # Register sample nodes as sources + clips attached to their parent bus
    next_src_id = 1
    next_clip_id = 1
    for nid in reachable:
        node = nodes_by_id[nid]
        if str(node.get("type") or "").lower() != "sample":
            continue
        props = node.get("properties") or {}
        raw_fp = props.get("filepath")
        if not raw_fp and isinstance(props.get("slots"), list) and props["slots"]:
            active_slot = int(props.get("active_slot") or 0)
            s_idx = active_slot if 0 <= active_slot < len(props["slots"]) else 0
            raw_fp = (props["slots"][s_idx] or {}).get("filepath")
        resolved_fp = _resolve_relative_filepath(raw_fp, project_root)
        if not resolved_fp or not os.path.isfile(resolved_fp):
            continue

        target_nid = parent_of.get(nid, output_root_id)
        target_bid = plan.bus_id_map.get(target_nid, 1)
        # Also allow frontend/caller to address this channel by its sample src_node_id!
        plan.bus_id_map[nid] = target_bid
        if nid in solo_set and target_bid in bus_by_id:
            bus_by_id[target_bid].solo = True

        src_id = next_src_id
        next_src_id += 1

        crop_start = max(0.0, min(1.0, float(props.get("crop_start") or 0.0)))
        crop_end = max(crop_start, min(1.0, float(props.get("crop_end") if props.get("crop_end") is not None else 1.0)))
        sample_type = str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower()
        sample_pre, sample_vol, sample_post, sample_muted = _chain_to_bus_gains(props.get("chain"), props.get("gain"))
        clip_gain = (0.0 if sample_muted else 1.0) * sample_vol * (10.0 ** ((sample_pre + sample_post) / 20.0))

        # Bind crop bounds onto channel bus so live CROP_START / CROP_END updates take effect in <3ms
        if target_bid in bus_by_id:
            bus_by_id[target_bid].crop_start = crop_start
            bus_by_id[target_bid].crop_end = crop_end

        if _needs_offline_stretch(props, bpm):
            cooked_audio, cooked_hash = _cook_stretched_sample(resolved_fp, props, bpm, plan.sample_rate)
            plan.sources.append(SourceSpec(
                source_id=src_id,
                pcm=cooked_audio,
                sample_rate=plan.sample_rate,
                content_hash=cooked_hash,
                num_frames=int(cooked_audio.shape[-1]),
            ))
            rate = 1.0
        else:
            plan.sources.append(SourceSpec(
                source_id=src_id,
                filepath=resolved_fp,
                force_ram=False,  # auto: RAM < 30s, lock-free disk stream >= 30s (8GB safe!)
            ))
            rate = _varispeed_rate(props, bpm)

        flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND
        if sample_type == "loop":
            flags |= SIN_CLIP_LOOP_SOURCE

        start_beat = float(props.get("start_beat") or 0.0)
        start_frame = int(round(start_beat * (60.0 / bpm) * plan.sample_rate))
        clip_len_frames = 0
        if sample_type == "loop" and plan.explicit_duration_sec > 0.0:
            clip_len_frames = max(0, int(round(plan.explicit_duration_sec * plan.sample_rate)) - start_frame)

        plan.clips.append(ClipSpec(
            clip_id=next_clip_id,
            source_id=src_id,
            target_bus_id=target_bid,
            timeline_start_frame=start_frame,
            timeline_length_frames=clip_len_frames,
            source_start_ratio=crop_start,
            source_end_ratio=crop_end,
            gain=float(clip_gain),
            playback_rate=float(rate),
            flags=flags,
        ))
        next_clip_id += 1

    return plan


def pack_audio_node_model(
    node_model: Any,
    system: Optional[System] = None,
) -> SinRenderPlan:
    """Pack a SIN `AudioNodeModel` (or dict) into a flat `SinRenderPlan` for `libsin_dsp`.

    - Preserves 100% of SIN's ERMES `slot_language.py` pseudolanguage, pools, seeds,
      Sequence step/choke/release/fade semantics, and Arrangement section semantics.
    - Assigns every node its own real-time `BusSpec` in `libsin_dsp` so live Gain / Volume /
      Pan / Mute / Solo / Crop / Varispeed edits run natively in C++ in < 5 ms!
    """
    from core.engines import build_node_object

    bpm = float(getattr(node_model, "bpm", None) or (node_model.get("bpm") if isinstance(node_model, dict) else 120.0) or 120.0)
    sr = int(system.sample_rate) if system is not None else SIN_DEFAULT_SAMPLE_RATE
    sys_obj = system if system is not None else System(bpm=bpm, sample_rate=sr, render_mode="preview")
    root_obj = build_node_object(node_model)
    return pack_audio_object(root_obj, sys_obj)


def _hash_array(arr: np.ndarray, salt: str = "") -> int:
    h = hashlib.blake2b(digest_size=8)
    h.update(salt.encode("utf-8"))
    h.update(str(arr.shape).encode("utf-8"))
    if arr.size > 0:
        flat = arr.reshape(-1)
        step = max(1, flat.size // 64)
        h.update(np.ascontiguousarray(flat[::step], dtype=np.float32).tobytes())
    return int.from_bytes(h.digest(), "little")


def pack_audio_object(root_obj: Any, system: System) -> SinRenderPlan:
    """Pack an instantiated `AudioObject` tree into a `SinRenderPlan`.

    Leaf `SampleObject`s without offline stretching register direct disk/RAM file sources with live
    crop & rate bindings; `SequenceObject` / `ArrangementObject` / stretched sources evaluate their
    exact procedural audio via SIN's unchanged symbolic/cooking rules while keeping every bus
    (Track / Bus / Master / Sequence / Sample) live-mixable in `libsin_dsp`!
    """
    sr = int(system.sample_rate or SIN_DEFAULT_SAMPLE_RATE)
    bpm = float(system.bpm or 120.0)
    plan = SinRenderPlan(sample_rate=sr, bpm=bpm)

    root_bars = getattr(root_obj, "total_bars", None)
    if root_bars is not None and float(root_bars) > 0.0:
        plan.explicit_duration_sec = float(root_bars) * 4.0 * (60.0 / bpm)

    # Dedicated transparent output monitor bus so SIN footer Master Volume/Mute
    # never collide with Master Track node's own FX chain Gain!
    monitor_bus = BusSpec(
        bus_id=1,
        parent_bus_id=0,
        node_key="__monitor__",
        node_type="monitor",
        node_name="Monitor",
    )
    plan.buses.append(monitor_bus)
    plan.bus_id_map["__monitor__"] = 1
    plan.bus_key_map[1] = "__monitor__"

    state = {"bus_id": 2, "src_id": 1, "clip_id": 1}

    def _alloc_bus(obj: Any, parent_bus_id: int) -> BusSpec:
        bid = state["bus_id"]
        state["bus_id"] += 1
        raw_nid = getattr(obj, "node_id", None)
        node_key = str(raw_nid) if raw_nid is not None else f"bus_{bid}"
        pre_db, vol, post_db, muted = _chain_to_bus_gains(getattr(obj, "chain", None))
        bs = BusSpec(
            bus_id=bid,
            parent_bus_id=parent_bus_id,
            node_key=node_key,
            node_type=str(getattr(obj, "node_type", "track") or "track"),
            node_name=str(getattr(obj, "name", node_key) or node_key),
            pre_gain_db=pre_db,
            volume=vol,
            post_gain_db=post_db,
            pan=float(getattr(obj, "pan", 0.0) or 0.0),
            crop_start=float(getattr(obj, "crop_start", 0.0) or 0.0),
            crop_end=float(getattr(obj, "crop_end", 1.0) if getattr(obj, "crop_end", None) is not None else 1.0),
            playback_rate=1.0,
            muted=muted,
            solo=False,
        )
        plan.buses.append(bs)
        plan.bus_id_map[node_key] = bid
        plan.bus_key_map[bid] = node_key
        return bs

    def _pack_node(
        obj: Any,
        parent_bus_id: int,
        start_frame_offset: int,
        parent_bars: Optional[float],
        wrapper_idx: int = 0,
        wrapper_progress: Optional[float] = None,
        num_wrapper_cycles: int = 1,
    ) -> int:
        bs = _alloc_bus(obj, parent_bus_id)
        ntype = str(getattr(obj, "node_type", "track") or "track").lower()
        children = getattr(obj, "children", None) or []

        # Composite Track / Master / Bus container: pack children onto child buses -> C++ mixes them!
        if ntype not in ("sequence", "arrangement", "sample", "asset_filter") and children:
            mix_mode = str(getattr(obj, "mix_mode", "sum") or "sum").lower()
            own_bars = getattr(obj, "total_bars", None)
            eff_bars = own_bars if (own_bars is not None and float(own_bars) > 0.0) else parent_bars
            cursor_frames = start_frame_offset
            max_end_frame = start_frame_offset

            for child_start_beat, child_obj in children:
                if mix_mode == "chained":
                    c_start = cursor_frames
                else:
                    c_start = start_frame_offset + int(round(float(child_start_beat) * (60.0 / bpm) * sr))

                c_type = str(getattr(child_obj, "node_type", "track") or "track").lower()
                c_bars = getattr(child_obj, "total_bars", None)
                if (
                    eff_bars is not None
                    and float(eff_bars) > 0.0
                    and c_type in ("track", "arrangement")
                    and c_bars is not None
                    and 0.0 < float(c_bars) < float(eff_bars)
                ):
                    wrapped_cycles = max(1, int(math.ceil(float(eff_bars) / float(c_bars))))
                    child_bar_frames = max(1, int(round(float(c_bars) * 4.0 * (60.0 / bpm) * sr)))
                    total_c_dur = wrapped_cycles * child_bar_frames
                    for w_idx in range(wrapped_cycles):
                        cum_w = wrapper_idx * wrapped_cycles + w_idx
                        w_prog = float(w_idx) / float(wrapped_cycles)
                        _pack_node(
                            child_obj,
                            bs.bus_id,
                            c_start + w_idx * child_bar_frames,
                            float(c_bars),
                            wrapper_idx=cum_w,
                            wrapper_progress=w_prog,
                            num_wrapper_cycles=wrapped_cycles,
                        )
                    c_dur = total_c_dur
                else:
                    c_dur = _pack_node(
                        child_obj,
                        bs.bus_id,
                        c_start,
                        eff_bars,
                        wrapper_idx=wrapper_idx,
                        wrapper_progress=wrapper_progress,
                        num_wrapper_cycles=num_wrapper_cycles,
                    )

                if mix_mode == "chained":
                    cursor_frames += c_dur
                max_end_frame = max(max_end_frame, c_start + c_dur)

            if eff_bars is not None and float(eff_bars) > 0.0:
                return int(round(float(eff_bars) * 4.0 * (60.0 / bpm) * sr))
            return max(0, max_end_frame - start_frame_offset)

        # Direct unstretched Sample leaf fast path (ZERO Python audio decoding/mixing!)
        if ntype == "sample" and not children and getattr(obj, "audio_data", None) is None:
            slots = getattr(obj, "slots", None) or []
            active_slot = int(getattr(obj, "active_slot", 0) or 0)
            slot_cfg = slots[active_slot] if (0 <= active_slot < len(slots) and isinstance(slots[active_slot], dict)) else {}
            fp = slot_cfg.get("filepath") or getattr(obj, "filepath", None)
            has_dynamic_ops = bool(getattr(obj, "field_operators", None) or slot_cfg.get("field_operators") or getattr(obj, "pool_query", None) or slot_cfg.get("pool_query"))
            props_like = {
                "stretch_mode": getattr(obj, "stretch_mode", "time_stretch"),
                "stretch_factor": slot_cfg.get("time_stretch") if slot_cfg.get("time_stretch") is not None else getattr(obj, "stretch_factor", 1.0),
                "transpose": slot_cfg.get("pitch_shift") if slot_cfg.get("pitch_shift") is not None else getattr(obj, "transpose", 0.0),
                "cents": getattr(obj, "cents", 0.0),
                "original_bpm": slot_cfg.get("original_bpm") if slot_cfg.get("original_bpm") is not None else getattr(obj, "original_bpm", None),
                "sample_type": getattr(obj, "sample_type", "loop"),
            }
            resolved_fp = _resolve_relative_filepath(fp, None) if fp else None
            if resolved_fp and os.path.isfile(resolved_fp) and not has_dynamic_ops and not _needs_offline_stretch(props_like, bpm):
                from core.runtime_trace import trace_runtime
                trace_runtime(f"Native libsin_dsp source registered: {Path(resolved_fp).name}")
                src_id = state["src_id"]
                state["src_id"] += 1
                plan.sources.append(SourceSpec(source_id=src_id, filepath=resolved_fp, force_ram=False))

                cs = max(0.0, min(1.0, float(slot_cfg.get("crop_start") if slot_cfg.get("crop_start") is not None else getattr(obj, "crop_start", 0.0))))
                ce = max(cs, min(1.0, float(slot_cfg.get("crop_end") if slot_cfg.get("crop_end") is not None else getattr(obj, "crop_end", 1.0))))
                rate = _varispeed_rate(props_like, bpm)
                bs.crop_start = cs
                bs.crop_end = ce
                bs.playback_rate = rate

                sample_type = str(getattr(obj, "sample_type", "loop") or "loop").lower()
                own_bars = getattr(obj, "total_bars", None)
                eff_bars = own_bars if (own_bars is not None and float(own_bars) > 0.0) else parent_bars
                clip_len = 0
                flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND
                if sample_type == "loop" and eff_bars is not None and float(eff_bars) > 0.0:
                    flags |= SIN_CLIP_LOOP_SOURCE
                    clip_len = int(round(float(eff_bars) * 4.0 * (60.0 / bpm) * sr))

                clip_id = state["clip_id"]
                state["clip_id"] += 1
                plan.clips.append(ClipSpec(
                    clip_id=clip_id,
                    source_id=src_id,
                    target_bus_id=bs.bus_id,
                    timeline_start_frame=start_frame_offset,
                    timeline_length_frames=clip_len,
                    source_start_ratio=cs,
                    source_end_ratio=ce,
                    gain=1.0,
                    playback_rate=1.0,  # scaled live by bs.playback_rate via SIN_CLIP_LIVE_RATE_BOUND
                    flags=flags,
                ))
                if getattr(obj, "node_id", None) is not None:
                    system.record_node_event(obj.node_id, {
                        "time": round(float(start_frame_offset) / float(sr), 4),
                        "duration": round(float(clip_len) / float(sr), 4) if clip_len > 0 else 0.0,
                        "filepath": resolved_fp,
                        "slot": active_slot,
                    })
                return clip_len

        # Procedural / Stretched / Sequence / Arrangement / In-memory node:
        # Evaluate with chain temporarily bypassed so `libsin_dsp` BusSpec owns ALL live gain/pan/mute/solo!
        saved_chain = getattr(obj, "chain", None)
        try:
            obj.chain = []
            render_kwargs: Dict[str, Any] = {
                "wrapper_idx": wrapper_idx,
                "global_idx": wrapper_idx,
                "num_wrapper_cycles": num_wrapper_cycles,
                "num_global_cycles": num_wrapper_cycles,
            }
            if wrapper_progress is not None:
                render_kwargs["wrapper_progress"] = wrapper_progress
                render_kwargs["global_progress"] = wrapper_progress
            if parent_bars is not None and float(parent_bars) > 0.0:
                render_kwargs["parent_total_bars"] = float(parent_bars)
            render_kwargs["timeline_offset_sec"] = float(start_frame_offset) / float(sr)
            pcm = obj.render(system=system, **render_kwargs)
        finally:
            obj.chain = saved_chain

        if pcm is None or pcm.size == 0:
            return 0

        pcm_f32 = np.asarray(pcm, dtype=np.float32)
        n_frames = int(pcm_f32.shape[-1])
        src_id = state["src_id"]
        state["src_id"] += 1
        plan.sources.append(SourceSpec(
            source_id=src_id,
            pcm=pcm_f32,
            sample_rate=sr,
            content_hash=_hash_array(pcm_f32, salt=bs.node_key),
            num_frames=n_frames,
        ))
        clip_id = state["clip_id"]
        state["clip_id"] += 1
        plan.clips.append(ClipSpec(
            clip_id=clip_id,
            source_id=src_id,
            target_bus_id=bs.bus_id,
            timeline_start_frame=start_frame_offset,
            timeline_length_frames=n_frames,
            source_start_ratio=0.0,
            source_end_ratio=1.0,
            gain=1.0,
            playback_rate=1.0,
            flags=0,
        ))
        return n_frames

    _pack_node(root_obj, parent_bus_id=1, start_frame_offset=0, parent_bars=root_bars)
    plan.manifest_nodes = copy.deepcopy(system.manifest.get("nodes", {}))
    return plan
