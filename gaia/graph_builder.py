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


def _build_graph_from_items(
    items: List[models.Item],
    project: Optional[models.ProjectItem] = None,
    multitrack: Optional[models.MultitrackItem] = None,
) -> Dict[str, Any]:
    project_root = Path(project.absolute_path).resolve() if project else None

    nodes: List[Dict[str, Any]] = []
    connections: List[Dict[str, Any]] = []

    # Calculate default BPM and bars from first item if available
    default_bpm = 120.0
    default_bars = 4.0
    for it in items:
        bpm_val = (it.attributes or {}).get("bpm") or getattr(it, "bpm", None)
        if bpm_val:
            try:
                default_bpm = float(bpm_val)
                break
            except (ValueError, TypeError):
                pass

    use_group = multitrack is not None and len(items) > 1
    grp_id = f"grp-{multitrack.id}" if use_group and multitrack else None

    for item in items:
        attrs = item.attributes or {}
        is_loop = bool(attrs.get("is_loop", False))
        item_path = Path(item.absolute_path)
        filepath = _relative_or_posix(item_path, project_root)
        src_id = f"src-{item.id}"
        ch_id = f"ch-{item.id}"

        # Sample source node with neutral pass-through
        nodes.append({
            "id": src_id,
            "type": "sample",
            "properties": {
                "node_name": _title(item),
                "filepath": filepath,
                "asset_ref": item.id,
                "sample_type": "loop" if is_loop else "one_shot",
                "crop_start": 0.0,
                "crop_end": 1.0,
                "original_bpm": default_bpm,
                "target_bpm": default_bpm,
                "stretch_mode": "off",
                "stretch_factor": 1.0,
            },
        })

        # Channel bus node with pre/fader/mute chain
        nodes.append({
            "id": ch_id,
            "type": "track",
            "properties": {
                "node_name": f"{_title(item)} Bus",
                "chain": default_channel_chain(volume=1.0, pre_gain=1.0, muted=False),
            },
        })

        # Wire source to channel
        connections.append({"from": src_id, "to": ch_id, "type": "audio"})

        # Wire channel to group or master
        target_bus = grp_id if use_group else "master"
        connections.append({"from": ch_id, "to": target_bus, "type": "audio"})

    if use_group and multitrack:
        nodes.append({
            "id": grp_id,
            "type": "track",
            "properties": {
                "node_name": f"{_title(multitrack)} Group",
                "chain": [],
            },
        })
        connections.append({"from": grp_id, "to": "master", "type": "audio"})

    # Master output track node
    nodes.append({
        "id": "master",
        "type": "track",
        "role": "master",
        "properties": {
            "node_name": "Master Output",
            "chain": [],
        },
    })

    return {
        "format": "sin-graph",
        "version": 1,
        "settings": {
            "bpm": default_bpm,
            "total_bars": default_bars,
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
            project_manifest.write_project_manifest(root, manifest_doc)
            return graph

        graph = _build_graph_from_items(playables, project=root)
        manifest_doc["graph"] = graph
        manifest_doc.setdefault("snapshots", [])
        manifest_doc.setdefault("view", {})
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


def add_sample_to_project_graph(
    db: Session,
    project: models.ProjectItem,
    sample_item: models.Item,
) -> Dict[str, Any]:
    """Drag-and-drop sample ingestion: copy into files/ if external and wire into graph."""
    # Ensure sample is safely copied/adopted into project files
    project_root = Path(project.absolute_path).resolve()
    files_dir = project_service.project_files_dir(project)

    # Link/reference the item in project if not already
    if not project_service._project_link_exists(db, project.id, sample_item.id):
        reference_service.create_source_reference(
            db=db,
            project_id=project.id,
            source_item_id=sample_item.id,
        )

    manifest_doc = project_manifest.read_project_manifest(project)
    graph = manifest_doc.get("graph")
    if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
        graph = build_item_sin_graph(project.id, db)
        manifest_doc = project_manifest.read_project_manifest(project)

    nodes = graph.setdefault("nodes", [])
    connections = graph.setdefault("connections", [])

    src_id = f"src-{sample_item.id}"
    ch_id = f"ch-{sample_item.id}"

    # Check if node already in graph
    if not any(n.get("id") == src_id for n in nodes):
        item_path = Path(sample_item.absolute_path)
        filepath = _relative_or_posix(item_path, project_root)
        attrs = sample_item.attributes or {}
        is_loop = bool(attrs.get("is_loop", False))
        bpm = float(attrs.get("bpm") or graph.get("settings", {}).get("bpm", 120.0))

        nodes.append({
            "id": src_id,
            "type": "sample",
            "properties": {
                "node_name": _title(sample_item),
                "filepath": filepath,
                "asset_ref": sample_item.id,
                "sample_type": "loop" if is_loop else "one_shot",
                "crop_start": 0.0,
                "crop_end": 1.0,
                "original_bpm": bpm,
                "target_bpm": bpm,
                "stretch_mode": "off",
                "stretch_factor": 1.0,
            },
        })

        nodes.append({
            "id": ch_id,
            "type": "track",
            "properties": {
                "node_name": f"{_title(sample_item)} Bus",
                "chain": default_channel_chain(volume=1.0, pre_gain=1.0, muted=False),
            },
        })

        connections.append({"from": src_id, "to": ch_id, "type": "audio"})
        connections.append({"from": ch_id, "to": "master", "type": "audio"})

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
    graph = manifest_doc.get("graph")
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

    manifest_doc["graph"] = graph
    project_manifest.write_project_manifest(project, manifest_doc)
    return graph
