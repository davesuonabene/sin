"""GAIA Canonical Node Graph Builder & Topology Bridge.

Constructs canonical 'sin-graph' documents from GAIA library items, projects,
and multitracks with deterministic node naming, fixed 3-module channel FX chains
(pre, fader, mute), and neutral pass-through audio defaults.
"""

from __future__ import annotations

import copy
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import uuid

import soundfile as sf
from sqlalchemy.orm import Session

from . import crud, media_editor, models, project_manifest, project_service, reference_service


def _title(item: models.Item) -> str:
    return getattr(item, "title", None) or (item.attributes or {}).get("title") or Path(item.absolute_path).name


def _relative_or_posix(item_path: Path, project_root: Optional[Path]) -> str:
    resolved_item = item_path.resolve()
    if project_root:
        resolved_root = project_root.resolve()
        try:
            return resolved_item.relative_to(resolved_root).as_posix()
        except ValueError:
            pass
    return resolved_item.as_posix()


def default_channel_chain(
    volume: float = 1.0,
    pre_gain: float = 1.0,
    muted: bool = False,
) -> List[Dict[str, Any]]:
    """Return the fixed 3-module FX chain for a channel bus."""
    return [
        {"id": "pre", "name": "Pre-Gain", "type": "gain", "enabled": True, "params": {"gain": float(pre_gain)}},
        {"id": "fader", "name": "Fader", "type": "gain", "enabled": True, "params": {"gain": float(volume)}},
        {"id": "mute", "name": "Mute", "type": "gain", "enabled": bool(muted), "params": {"gain": 0.0}},
    ]


def get_control_map(graph: Dict[str, Any]) -> Dict[str, str]:
    """Return whitelist mapping UI control keys to exact property paths on the graph."""
    control_map: Dict[str, str] = {}
    nodes = graph.get("nodes", [])
    for node in nodes:
        nid = node.get("id", "")
        if nid.startswith("ch-"):
            stem_id = nid[3:]
            control_map[f"layer:{stem_id}:volume"] = f"{nid}.chain.fader.params.gain"
            control_map[f"layer:{stem_id}:mute"] = f"{nid}.chain.mute.enabled"
            control_map[f"layer:{stem_id}:pre_gain"] = f"{nid}.chain.pre.params.gain"
        elif nid.startswith("src-"):
            stem_id = nid[4:]
            control_map[f"layer:{stem_id}:crop_start"] = f"{nid}.crop_start"
            control_map[f"layer:{stem_id}:crop_end"] = f"{nid}.crop_end"
    return control_map


def apply_control_updates(
    graph: Dict[str, Any],
    updates: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """Apply validated property updates to graph nodes and chains."""
    control_map = get_control_map(graph)
    applied: List[str] = []
    node_by_id = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}

    for key, val in updates.items():
        target_path = control_map.get(key, key)
        parts = target_path.split(".")
        nid = parts[0]
        if nid not in node_by_id:
            continue

        node = node_by_id[nid]
        props = node.setdefault("properties", {})

        if len(parts) == 2:
            # Direct property e.g. src-123.crop_start
            prop_name = parts[1]
            try:
                props[prop_name] = float(val) if isinstance(val, (int, float, str)) and prop_name in ("crop_start", "crop_end") else val
                applied.append(key)
            except (ValueError, TypeError):
                continue

        elif len(parts) == 5 and parts[1] == "chain" and parts[3] == "params":
            # e.g. ch-123.chain.fader.params.gain
            module_id = parts[2]
            param_name = parts[4]
            for mod in props.get("chain", []):
                if mod.get("id") == module_id:
                    try:
                        mod.setdefault("params", {})[param_name] = float(val)
                        applied.append(key)
                    except (ValueError, TypeError):
                        pass
                    break

        elif len(parts) == 4 and parts[1] == "chain" and parts[3] == "enabled":
            # e.g. ch-123.chain.mute.enabled
            module_id = parts[2]
            for mod in props.get("chain", []):
                if mod.get("id") == module_id:
                    mod["enabled"] = bool(val)
                    applied.append(key)
                    break

    return graph, applied


def _default_muted_ids_for_multitrack(stems: List[models.Item]) -> set[int]:
    active_ids = set(media_editor._default_active_layer_ids(stems))
    return {stem.id for stem in stems if stem.id not in active_ids}


def _node_bpm(item: models.Item, fallback: float = 120.0) -> float:
    attrs = item.attributes or {}
    val = attrs.get("bpm") or (attrs.get("analysis") or {}).get("bpm") or getattr(item, "bpm", None)
    if val is not None:
        try:
            num = float(val)
            if 20.0 <= num <= 400.0:
                return num
        except (ValueError, TypeError):
            pass
    return fallback


def _append_audio_channel(
    nodes: List[Dict[str, Any]],
    connections: List[Dict[str, Any]],
    item: models.Item,
    *,
    project_root: Optional[Path],
    target_bus: str,
    default_bpm: float,
    crop_start: float = 0.0,
    crop_end: float = 1.0,
    pre_gain: float = 1.0,
    volume: float = 1.0,
    muted: bool = False,
) -> bool:
    src_id = f"src-{item.id}"
    ch_id = f"ch-{item.id}"
    if any(n.get("id") == src_id for n in nodes):
        return False

    attrs = item.attributes or {}
    analysis = attrs.get("analysis") or {}
    is_loop = bool(getattr(item, "is_loop", False) or attrs.get("is_loop", False) or analysis.get("is_loop", False))
    item_bpm = _node_bpm(item, default_bpm)
    filepath = _relative_or_posix(Path(item.absolute_path), project_root)

    nodes.append({
        "id": src_id,
        "type": "sample",
        "properties": {
            "node_name": _title(item),
            "filepath": filepath,
            "asset_ref": item.id,
            "sample_type": "loop" if is_loop else "one_shot",
            "crop_start": round(float(crop_start), 6),
            "crop_end": round(float(crop_end), 6),
            "original_bpm": item_bpm,
            "target_bpm": default_bpm,
            "stretch_mode": "off",
            "stretch_factor": 1.0,
        },
    })
    nodes.append({
        "id": ch_id,
        "type": "track",
        "properties": {
            "node_name": f"{_title(item)} Bus",
            "total_bars": "auto",
            "chain": default_channel_chain(volume=volume, pre_gain=pre_gain, muted=muted),
        },
    })
    connections.append({"from": src_id, "to": ch_id, "type": "audio"})
    connections.append({"from": ch_id, "to": target_bus, "type": "audio"})
    return True


def _build_graph_from_items(
    items: List[models.Item],
    project: Optional[models.ProjectItem] = None,
    multitrack: Optional[models.MultitrackItem] = None,
) -> Dict[str, Any]:
    project_root = Path(project.absolute_path).resolve() if project else None

    nodes: List[Dict[str, Any]] = []
    connections: List[Dict[str, Any]] = []

    multitrack_items: List[models.MultitrackItem] = []
    leaf_audio_items: List[models.Item] = []
    seen_ids: set[int] = set()

    if multitrack is not None and isinstance(multitrack, models.MultitrackItem):
        multitrack_items.append(multitrack)
        stems = [s for s in items if s.type in media_editor.AUDIO_TYPES]
        muted_ids = _default_muted_ids_for_multitrack(stems)
        default_bpm = _node_bpm(multitrack, 120.0)
        for s in stems:
            if default_bpm == 120.0:
                default_bpm = _node_bpm(s, default_bpm)
        use_group = len(stems) > 1
        grp_id = f"grp-{multitrack.id}" if use_group else None
        for s in stems:
            _append_audio_channel(
                nodes,
                connections,
                s,
                project_root=project_root,
                target_bus=grp_id if grp_id else "master",
                default_bpm=default_bpm,
                muted=s.id in muted_ids,
            )
            seen_ids.add(s.id)
        if grp_id:
            nodes.append({
                "id": grp_id,
                "type": "track",
                "properties": {
                    "node_name": f"{_title(multitrack)} Group",
                    "total_bars": "auto",
                    "chain": [],
                },
            })
            connections.append({"from": grp_id, "to": "master", "type": "audio"})
    else:
        for it in items:
            if isinstance(it, models.MultitrackItem):
                multitrack_items.append(it)
            elif it.type in media_editor.AUDIO_TYPES:
                leaf_audio_items.append(it)

        default_bpm = 120.0
        for it in [*multitrack_items, *leaf_audio_items]:
            cand = _node_bpm(it, 120.0)
            if cand != 120.0:
                default_bpm = cand
                break

        for mt in multitrack_items:
            stems = media_editor._multitrack_layers(mt)
            if not stems:
                continue
            muted_ids = _default_muted_ids_for_multitrack(stems)
            grp_id = f"grp-{mt.id}" if len(stems) > 1 else None
            for stem in stems:
                if stem.id in seen_ids:
                    continue
                _append_audio_channel(
                    nodes,
                    connections,
                    stem,
                    project_root=project_root,
                    target_bus=grp_id if grp_id else "master",
                    default_bpm=default_bpm,
                    muted=stem.id in muted_ids,
                )
                seen_ids.add(stem.id)
            if grp_id and any(n.get("id") == grp_id for n in nodes) is False:
                nodes.append({
                    "id": grp_id,
                    "type": "track",
                    "properties": {
                        "node_name": f"{_title(mt)} Group",
                        "total_bars": "auto",
                        "chain": [],
                    },
                })
                connections.append({"from": grp_id, "to": "master", "type": "audio"})

        for leaf in leaf_audio_items:
            if leaf.id in seen_ids:
                continue
            _append_audio_channel(
                nodes,
                connections,
                leaf,
                project_root=project_root,
                target_bus="master",
                default_bpm=default_bpm,
            )
            seen_ids.add(leaf.id)

    nodes.append({
        "id": "master",
        "type": "track",
        "role": "master",
        "properties": {
            "node_name": "Master Output",
            "total_bars": "auto",
            "chain": [],
        },
    })

    return {
        "format": "sin-graph",
        "version": 1,
        "settings": {
            "bpm": default_bpm,
            "total_bars": "auto",
            "output": {
                "export_directory": "files/derived",
                "format": "wav",
                "normalize": False,
                "target_peak_db": -1.0,
            },
        },
        "output": "master",
        "nodes": nodes,
        "connections": connections,
    }


def migrate_legacy_editor_state(
    legacy_state: Dict[str, Any],
    items: List[models.Item],
    project: Optional[models.ProjectItem] = None,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Convert legacy MediaEditorState into canonical sin-graph + snapshots.
    
    Non-rendered cuts are discarded to avoid migration divergence.
    """
    base_graph = _build_graph_from_items(items, project=project)
    snapshots: List[Dict[str, Any]] = []

    # Map legacy layers (volume, gain_db, pre_gain_db, muted)
    layers = legacy_state.get("layers", [])
    layer_by_item_id = {l.get("item_id"): l for l in layers if isinstance(l, dict) and "item_id" in l}

    for node in base_graph.get("nodes", []):
        nid = node.get("id", "")
        if nid.startswith("ch-"):
            try:
                item_id = int(nid[3:])
            except ValueError:
                continue
            layer = layer_by_item_id.get(item_id)
            if not layer:
                continue

            vol = 1.0
            if layer.get("volume") is not None:
                vol = float(layer["volume"])
            elif layer.get("gain_db") is not None:
                vol = 10.0 ** (float(layer["gain_db"]) / 20.0)

            pre_db = float(layer.get("pre_gain_db", 0.0) or 0.0)
            pre_gain = 10.0 ** (pre_db / 20.0)
            muted = bool(layer.get("muted", False))

            node["properties"]["chain"] = default_channel_chain(volume=vol, pre_gain=pre_gain, muted=muted)

    # Discard non-rendered cuts, keep only rendered cuts as snapshots if audio exists
    project_root = Path(project.absolute_path).resolve() if project else None
    segments = legacy_state.get("segments", [])
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        cut_file = seg.get("file_path") or seg.get("output_path")
        is_rendered = False
        if cut_file:
            path_cand = Path(cut_file)
            if not path_cand.is_absolute() and project_root:
                path_cand = project_root / path_cand
            if path_cand.is_file():
                is_rendered = True

        # User directive: discard non-rendered cuts during migration
        if not is_rendered:
            continue

        # For rendered cuts, create snapshot entry
        seg_id = str(seg.get("id") or uuid.uuid4().hex[:6])
        start_ratio = float(seg.get("start_ratio", 0.0) or 0.0)
        end_ratio = float(seg.get("end_ratio", 1.0) or 1.0)

        overrides: Dict[str, Any] = {}
        for it in items:
            src_id = f"src-{it.id}"
            overrides[src_id] = {
                "crop_start": start_ratio,
                "crop_end": end_ratio,
            }

        snapshots.append({
            "format": "sin-snapshot",
            "version": 1,
            "id": f"cut-{seg_id}",
            "label": str(seg.get("name") or f"Cut {seg_id}"),
            "root": "master",
            "overrides": overrides,
            "meta": {
                "is_loop": bool(seg.get("is_loop", False)),
                "rendered_file": str(cut_file),
            },
        })

    return base_graph, snapshots


def resolve_master_sample(
    root: models.Item,
    db: Session,
    target_id: Optional[str] = None,
) -> Tuple[models.Item, Optional[models.ProjectItem]]:
    """Resolve the single master sample item being edited and its owning project if any."""
    import re
    owning_proj = project_service._find_owning_project(db, root)
    proj = owning_proj or (root if isinstance(root, models.ProjectItem) else None)

    if target_id:
        target_str = str(target_id).strip()
        match = re.fullmatch(r"(?:root|item|stem):(?P<item_id>\d+)", target_str)
        tid = int(match.group("item_id")) if match else (int(target_str) if target_str.isdigit() else None)
        if tid is not None:
            target_item = crud.get_item(db, tid)
            if target_item:
                if target_item.type in media_editor.AUDIO_TYPES:
                    return target_item, proj
                if isinstance(target_item, models.FolderItem):
                    child_audios = [c for c in (target_item.children or []) if c.type in media_editor.AUDIO_TYPES]
                    if child_audios:
                        return child_audios[0], proj

    if root.type in media_editor.AUDIO_TYPES:
        return root, proj

    if isinstance(root, models.MultitrackItem):
        stems = media_editor._multitrack_layers(root)
        if stems:
            return stems[0], proj

    if isinstance(root, models.FolderItem):
        playables = media_editor._project_playables(db, root) if isinstance(root, models.ProjectItem) else media_editor._child_playables(root)
        audios = [p for p in playables if p.type in media_editor.AUDIO_TYPES]
        if audios:
            return audios[0], proj
        if playables:
            return playables[0], proj

    raise ValueError(f"No playable audio master sample found for '{root.type}' item {root.id}")


def build_item_sin_graph(
    item_id: int,
    db: Session,
    target_id: Optional[str] = None,
    master_only: bool = False,
) -> Dict[str, Any]:
    """Retrieve or construct the canonical sin-graph for an item or project."""
    root = crud.get_item(db, item_id)
    if not root:
        raise ValueError("Item not found")

    # If master_only is set or target_id is provided or item is an audio file:
    # Build the canonical processing graph for ONLY the master sample!
    if master_only or target_id or root.type in media_editor.AUDIO_TYPES:
        master_sample, proj = resolve_master_sample(root, db, target_id=target_id)
        return _build_graph_from_items([master_sample], project=proj)

    # If item belongs to a project, resolve the owning project
    owning_proj = project_service._find_owning_project(db, root)
    if owning_proj and owning_proj.id != root.id:
        root = owning_proj

    if isinstance(root, models.ProjectItem):
        project_session = project_manifest.read_project_session(root)
        if isinstance(project_session, dict) and project_session.get("engine") == "sin":
            s_graph = (project_session.get("data") or {}).get("graph")
            if isinstance(s_graph, dict) and s_graph.get("format") == "sin-graph":
                return s_graph

        manifest_doc = project_manifest.read_project_manifest(root)
        existing_graph = manifest_doc.get("graph")
        if isinstance(existing_graph, dict) and existing_graph.get("format") == "sin-graph":
            return existing_graph

        playables = media_editor._project_playables(db, root)
        # Check if legacy editor document exists to migrate
        legacy_state = manifest_doc.get("editor") or (manifest_doc.get("edits", {}).get(target_id) if target_id else None)
        if isinstance(legacy_state, dict) and "layers" in legacy_state:
            graph, snapshots = migrate_legacy_editor_state(legacy_state, playables, project=root)
            manifest_doc["graph"] = graph
            manifest_doc["snapshots"] = snapshots
            if getattr(root, "editor_engine", "sin") == "sin":
                manifest_doc["session"] = {
                    "engine": "sin",
                    "schema_version": 1,
                    "data": {
                        "graph": graph,
                        "workspace": None,
                        "snapshots": snapshots,
                        "active_snapshot_id": None,
                    },
                }
            project_manifest.write_project_manifest(root, manifest_doc)
            return graph

        graph = _build_graph_from_items(playables, project=root)
        manifest_doc["graph"] = graph
        manifest_doc.setdefault("snapshots", [])
        manifest_doc.setdefault("view", {})
        if getattr(root, "editor_engine", "sin") == "sin":
            manifest_doc["session"] = {
                "engine": "sin",
                "schema_version": 1,
                "data": {
                    "graph": graph,
                    "workspace": None,
                    "snapshots": list(manifest_doc.get("snapshots") or []),
                    "active_snapshot_id": (manifest_doc.get("view") or {}).get("selected_snapshot_id"),
                },
            }
        project_manifest.write_project_manifest(root, manifest_doc)
        return graph

    if isinstance(root, models.MultitrackItem):
        stems = media_editor._multitrack_layers(root)
        return _build_graph_from_items(stems, multitrack=root)

    if isinstance(root, models.FolderItem):
        child_playables = media_editor._child_playables(root)
        if not child_playables:
            raise ValueError("This folder has no playable media")
        target_item = child_playables[0]
        if isinstance(target_item, models.MultitrackItem):
            stems = media_editor._multitrack_layers(target_item)
            return _build_graph_from_items(stems, multitrack=target_item)
        return _build_graph_from_items([target_item])

    raise ValueError(f"Cannot build node graph for item type '{root.type}'")


def _cut_list_to_snapshots(
    item: models.Item,
    cuts: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    try:
        info = sf.info(str(Path(item.absolute_path).resolve()))
        total_frames = int(info.frames)
        total_sec = float(info.duration)
    except Exception:
        total_frames = None
        total_sec = None

    snapshots: List[Dict[str, Any]] = []
    for idx, cut in enumerate(cuts, start=1):
        if not isinstance(cut, dict):
            continue
        c_start_ratio = 0.0
        c_end_ratio = 1.0
        if cut.get("crop_start") is not None and cut.get("crop_end") is not None:
            c_start_ratio = max(0.0, min(1.0, float(cut["crop_start"])))
            c_end_ratio = max(c_start_ratio, min(1.0, float(cut["crop_end"])))
        else:
            if total_frames and total_frames > 0 and cut.get("start_frame") is not None:
                c_start_ratio = max(0.0, min(1.0, float(cut["start_frame"]) / total_frames))
            elif total_sec and total_sec > 0 and cut.get("start_sec") is not None:
                c_start_ratio = max(0.0, min(1.0, float(cut["start_sec"]) / total_sec))
            if total_frames and total_frames > 0 and cut.get("end_frame") is not None:
                c_end_ratio = max(c_start_ratio, min(1.0, float(cut["end_frame"]) / total_frames))
            elif total_sec and total_sec > 0 and cut.get("end_sec") is not None:
                c_end_ratio = max(c_start_ratio, min(1.0, float(cut["end_sec"]) / total_sec))

        cut_id = str(cut.get("id") or f"cut-{idx}-{uuid.uuid4().hex[:6]}")
        snapshots.append({
            "format": "sin-snapshot",
            "version": 1,
            "id": cut_id,
            "label": str(cut.get("label") or f"Cut {idx}"),
            "root": "master",
            "overrides": {
                f"src-{item.id}": {
                    "crop_start": round(c_start_ratio, 6),
                    "crop_end": round(c_end_ratio, 6),
                }
            },
            "meta": {"source_engine": "simple_media"},
        })
    return snapshots


def add_sample_to_project_graph(
    db: Session,
    project: models.ProjectItem,
    sample_item: models.Item,
    *,
    crop_start: float = 0.0,
    crop_end: float = 1.0,
    pre_gain_db: float = 0.0,
    volume: float = 1.0,
    muted: bool = False,
    cuts: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Load an audio file or multitrack folder into a SIN project graph."""
    if not isinstance(sample_item, models.MultitrackItem) and sample_item.type not in media_editor.AUDIO_TYPES:
        raise ValueError("Only audio files or multitrack folders can be loaded into a SIN graph")

    project_root = Path(project.absolute_path).resolve()

    if not project_service._project_link_exists(db, project.id, sample_item.id):
        reference_service.create_source_reference(
            db=db,
            project_id=project.id,
            source_item_id=sample_item.id,
        )

    manifest_doc = project_manifest.read_project_manifest(project)
    session_obj = project_manifest.read_project_session(project)
    graph = (
        ((session_obj or {}).get("data") or {}).get("graph")
        if isinstance(session_obj, dict) and session_obj.get("engine") == "sin"
        else manifest_doc.get("graph")
    )
    if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
        graph = build_item_sin_graph(project.id, db)
        manifest_doc = project_manifest.read_project_manifest(project)
        session_obj = project_manifest.read_project_session(project)

    nodes = graph.setdefault("nodes", [])
    connections = graph.setdefault("connections", [])
    settings = graph.setdefault("settings", {})
    settings.setdefault("bpm", 120.0)
    settings["total_bars"] = "auto"
    default_bpm = float(settings.get("bpm", 120.0))

    master_node = next((n for n in nodes if n.get("id") == "master"), None)
    if master_node is None:
        master_node = {
            "id": "master",
            "type": "track",
            "role": "master",
            "properties": {"node_name": "Master Output", "total_bars": "auto", "chain": []},
        }
        nodes.append(master_node)
    else:
        master_node.setdefault("properties", {})["total_bars"] = "auto"

    if isinstance(sample_item, models.MultitrackItem):
        stems = media_editor._multitrack_layers(sample_item)
        if not stems:
            raise ValueError(f"Multitrack '{_title(sample_item)}' contains no playable stems")
        muted_ids = _default_muted_ids_for_multitrack(stems)
        use_group = len(stems) > 1
        grp_id = f"grp-{sample_item.id}" if use_group else "master"
        for stem in stems:
            _append_audio_channel(
                nodes,
                connections,
                stem,
                project_root=project_root,
                target_bus=grp_id,
                default_bpm=default_bpm,
                muted=stem.id in muted_ids,
            )
        if use_group and not any(n.get("id") == grp_id for n in nodes):
            nodes.append({
                "id": grp_id,
                "type": "track",
                "properties": {
                    "node_name": f"{_title(sample_item)} Group",
                    "total_bars": "auto",
                    "chain": [],
                },
            })
            connections.append({"from": grp_id, "to": "master", "type": "audio"})
    else:
        c0 = max(0.0, min(1.0, float(crop_start)))
        c1 = max(c0, min(1.0, float(crop_end)))
        pre_lin = 10.0 ** (float(pre_gain_db or 0.0) / 20.0)
        vol = max(0.0, min(1.0, float(volume)))
        _append_audio_channel(
            nodes,
            connections,
            sample_item,
            project_root=project_root,
            target_bus="master",
            default_bpm=default_bpm,
            crop_start=c0,
            crop_end=c1,
            pre_gain=pre_lin,
            volume=vol,
            muted=bool(muted),
        )

    existing_snaps = list(
        ((session_obj or {}).get("data") or {}).get("snapshots")
        or manifest_doc.get("snapshots")
        or []
    )
    if cuts and not isinstance(sample_item, models.MultitrackItem):
        existing_ids = {s.get("id") for s in existing_snaps if isinstance(s, dict)}
        for snap in _cut_list_to_snapshots(sample_item, cuts):
            if snap["id"] not in existing_ids:
                existing_snaps.append(snap)
                existing_ids.add(snap["id"])

    if not isinstance(session_obj, dict) or session_obj.get("engine") != "sin":
        session_obj = {
            "engine": "sin",
            "schema_version": 1,
            "data": {
                "graph": graph,
                "workspace": None,
                "snapshots": existing_snaps,
                "active_snapshot_id": None,
            },
        }
    else:
        data = dict(session_obj.get("data") or {})
        data["graph"] = graph
        data["snapshots"] = existing_snaps
        session_obj["data"] = data

    manifest_doc["session"] = session_obj
    manifest_doc["graph"] = graph
    manifest_doc["snapshots"] = existing_snaps
    project_manifest.write_project_manifest(project, manifest_doc)
    return graph


def remove_channel_from_project_graph(
    db: Session,
    project: models.ProjectItem,
    node_id: str,
) -> Dict[str, Any]:
    """Remove a channel/source pair (and empty multitrack groups) from a SIN graph without deleting files."""
    manifest_doc = project_manifest.read_project_manifest(project)
    session_obj = project_manifest.read_project_session(project)
    graph = (
        copy.deepcopy(((session_obj or {}).get("data") or {}).get("graph"))
        if isinstance(session_obj, dict) and session_obj.get("engine") == "sin"
        else copy.deepcopy(manifest_doc.get("graph"))
    )
    if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
        raise ValueError("Project has no active SIN graph")

    raw = str(node_id).strip()
    if raw.startswith("ch-"):
        suffix = raw[3:]
    elif raw.startswith("src-"):
        suffix = raw[4:]
    else:
        suffix = raw

    remove_ids = {raw, f"ch-{suffix}", f"src-{suffix}"}
    nodes = [n for n in graph.get("nodes", []) if n.get("id") not in remove_ids]
    connections = [
        c for c in graph.get("connections", [])
        if c.get("from") not in remove_ids and c.get("to") not in remove_ids
    ]

    # Prune empty multitrack group busses
    incoming_targets = {c.get("to") for c in connections}
    empty_groups = {
        n.get("id")
        for n in nodes
        if str(n.get("id", "")).startswith("grp-") and n.get("id") not in incoming_targets
    }
    if empty_groups:
        nodes = [n for n in nodes if n.get("id") not in empty_groups]
        connections = [
            c for c in connections
            if c.get("from") not in empty_groups and c.get("to") not in empty_groups
        ]

    graph["nodes"] = nodes
    graph["connections"] = connections

    if isinstance(session_obj, dict) and session_obj.get("engine") == "sin":
        data = dict(session_obj.get("data") or {})
        data["graph"] = graph
        session_obj["data"] = data
        manifest_doc["session"] = session_obj
    manifest_doc["graph"] = graph
    project_manifest.write_project_manifest(project, manifest_doc)
    return graph


def switch_sample_version_in_graph(
    db: Session,
    project: models.ProjectItem,
    channel_id: str,
    new_sample_item: models.Item,
) -> Dict[str, Any]:
    """Switch version of a channel in the project graph, updating filepath and asset_ref."""
    manifest_doc = project_manifest.read_project_manifest(project)
    session_obj = project_manifest.read_project_session(project)
    graph = ((session_obj or {}).get("data") or {}).get("graph") if isinstance(session_obj, dict) and session_obj.get("engine") == "sin" else manifest_doc.get("graph")
    if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
        raise ValueError("Project has no active canonical graph")

    nodes = graph.get("nodes", [])
    connections = graph.get("connections", [])

    # Find which src node feeds this channel_id or match directly
    src_id = None
    if channel_id:
        if any(n.get("id") == channel_id and n.get("type") == "sample" for n in nodes):
            src_id = channel_id
        else:
            for conn in connections:
                if conn.get("to") == channel_id and conn.get("type", "audio") == "audio":
                    src_id = conn.get("from")
                    break

            if not src_id and channel_id.startswith("ch-"):
                cand = f"src-{channel_id[3:]}"
                if any(n.get("id") == cand for n in nodes):
                    src_id = cand

    if not src_id:
        # Match by version group / sibling versions
        info = reference_service.file_version_info(new_sample_item.absolute_path)
        group = info.get("group")
        if group:
            for n in nodes:
                if n.get("type") == "sample":
                    ref_id = n.get("properties", {}).get("asset_ref")
                    if ref_id:
                        cand_item = db.query(models.Item).filter(models.Item.id == ref_id).first()
                        if cand_item:
                            cand_info = reference_service.file_version_info(cand_item.absolute_path)
                            if cand_info.get("group") == group:
                                src_id = n.get("id")
                                break

    if not src_id:
        raise ValueError(f"No source node found connected to channel '{channel_id}' or matching version group")

    project_root = Path(project.absolute_path).resolve()
    new_path = Path(new_sample_item.absolute_path)
    rel_path = _relative_or_posix(new_path, project_root)

    # Link new version into project references if needed
    if not project_service._project_link_exists(db, project.id, new_sample_item.id):
        reference_service.create_source_reference(
            db=db,
            project_id=project.id,
            source_item_id=new_sample_item.id,
        )

    # Update properties of src node
    for n in nodes:
        if n.get("id") == src_id:
            props = n.setdefault("properties", {})
            props["filepath"] = rel_path
            props["asset_ref"] = new_sample_item.id
            props["node_name"] = _title(new_sample_item)
            break

    if isinstance(session_obj, dict) and session_obj.get("engine") == "sin":
        data = dict(session_obj.get("data") or {})
        data["graph"] = graph
        session_obj["data"] = data
        manifest_doc["session"] = session_obj
    manifest_doc["graph"] = graph
    project_manifest.write_project_manifest(project, manifest_doc)
    return graph
