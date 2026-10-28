"""ERMES Headless Compiler & Interop Bridge.

Translates between canonical 'sin-graph' documents, LiteGraph workspace presets,
and compiled AudioNodeModel trees for the Python audio engine.
Provides deterministic auto-layout so CLI/agent presets without coordinates
render cleanly and beautifully in the browser canvas.
"""

from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple, Set
from ermes.py.schemas import AudioNodeModel, FxModuleModel


def parse_musical_key(value: str) -> Optional[Tuple[int, Optional[str]]]:
    """Parse a key string like 'Dm', 'C#min', 'F', 'Eb' into (pitch_class, mode)."""
    if not value or not isinstance(value, str):
        return None
    val = value.strip().replace("♯", "#").replace("♭", "b")
    m = re.match(r"^([A-Ga-g])([#b]?)(?:[\s_-]*(maj(?:or)?|min(?:or)?|m))?$", val, re.IGNORECASE)
    if not m:
        return None
    natural = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    letter = m.group(1).upper()
    acc = 1 if m.group(2) == "#" else (-1 if m.group(2) == "b" else 0)
    pitch_class = (natural.get(letter, 0) + acc + 12) % 12
    suffix = (m.group(3) or "").lower()
    mode = "minor" if (suffix == "m" or suffix.startswith("min")) else ("major" if suffix.startswith("maj") else None)
    return pitch_class, mode


def calculate_key_match_transpose(source_key: str, lead_key: str, algorithm: str = "nearest") -> float:
    """Calculate transposition semitones matching SampleNode.calculateKeyMatch in frontend."""
    src = parse_musical_key(source_key)
    lead = parse_musical_key(lead_key)
    if not src or not lead:
        return 0.0
    src_pitch, src_mode = src
    lead_pitch, lead_mode = lead
    target_pitch = lead_pitch
    if src_mode and lead_mode and src_mode != lead_mode:
        target_pitch = (lead_pitch + 3) % 12 if lead_mode == "minor" else (lead_pitch + 9) % 12
    upward = (target_pitch - src_pitch + 12) % 12
    algo = (algorithm or "nearest").lower().strip()
    if algo == "higher":
        transpose = upward
    elif algo == "lower":
        transpose = 0 if upward == 0 else upward - 12
    else:
        transpose = upward - 12 if upward > 6 else upward
    return float(transpose)


DEFAULT_NODE_NAMES = {
    "sample": "Sample",
    "sequence": "Sequence",
    "arrangement": "Arrangement",
    "track": "Track",
    "asset_filter": "Asset Pool",
    "modulator": "Modulator",
    "random": "Random",
    "disabled": "Disabled Node",
}

LITE_GRAPH_TYPE_MAP = {
    "sample": "Audio/Sample",
    "sequence": "Audio/Sequence",
    "arrangement": "Audio/Arrangement",
    "track": "Audio/Track",
    "asset_filter": "Audio/AssetFilter",
    "modulator": "Audio/Modulator",
    "random": "Audio/Random",
    "disabled": "Audio/Disabled",
}

REVERSE_LITE_GRAPH_TYPE_MAP = {v: k for k, v in LITE_GRAPH_TYPE_MAP.items()}


def compute_auto_layout_positions(doc: Dict[str, Any]) -> Dict[str, Tuple[int, int]]:
    """Compute non-overlapping 2D layout coordinates for a canonical sin-graph."""
    nodes = doc.get("nodes", [])
    connections = doc.get("connections", [])
    attachments = doc.get("attachments", [])

    modifier_to_owner: Dict[str, str] = {}
    owner_to_modifiers: Dict[str, List[str]] = {}
    for att in attachments:
        owner = att.get("owner")
        modifier = att.get("modifier")
        if owner and modifier:
            modifier_to_owner[modifier] = owner
            owner_to_modifiers.setdefault(owner, []).append(modifier)

    incoming: Dict[str, List[str]] = {}
    outgoing: Dict[str, List[str]] = {}
    for conn in connections:
        c_from = conn.get("from")
        c_to = conn.get("to")
        if c_from and c_to:
            incoming.setdefault(c_to, []).append(c_from)
            outgoing.setdefault(c_from, []).append(c_to)

    audio_nodes = [n for n in nodes if n.get("id") not in modifier_to_owner]
    source_nodes = [n for n in audio_nodes if not incoming.get(n.get("id"))]

    row_spacing = 160
    start_y = 120
    col_spacing = 280
    source_x = 320

    node_y: Dict[str, int] = {}
    for row_idx, src in enumerate(source_nodes):
        node_y[src["id"]] = start_y + row_idx * row_spacing

    node_col: Dict[str, int] = {src["id"]: 1 for src in source_nodes}

    # Iterative column propagation based on signal flow
    changed = True
    iteration = 0
    while changed and iteration < 20:
        changed = False
        iteration += 1
        for conn in connections:
            c_from = conn.get("from")
            c_to = conn.get("to")
            from_col = node_col.get(c_from, 1)
            current_to_col = node_col.get(c_to, 1)
            if from_col + 1 > current_to_col:
                node_col[c_to] = from_col + 1
                changed = True

    output_id = doc.get("output")
    max_col = max(node_col.values()) if node_col else 1
    if output_id and output_id in node_col:
        node_col[output_id] = max(max_col, node_col[output_id])

    # Position unassigned audio nodes by averaging incoming Y
    remaining_nodes = [n for n in audio_nodes if n.get("id") not in node_y]
    remaining_nodes.sort(key=lambda n: node_col.get(n.get("id"), 0))
    for node in remaining_nodes:
        nid = node["id"]
        inc = incoming.get(nid, [])
        known_ys = [node_y[i] for i in inc if i in node_y]
        if known_ys:
            node_y[nid] = int(sum(known_ys) / len(known_ys))
        else:
            node_y[nid] = start_y + len(node_y) * row_spacing

    positions: Dict[str, Tuple[int, int]] = {}
    for node in audio_nodes:
        nid = node["id"]
        col = node_col.get(nid, 1)
        x = source_x + (col - 1) * col_spacing
        y = node_y.get(nid, start_y)
        positions[nid] = (x, y)

    # Place modifiers to the left of their owners
    for modifier_id, owner_id in modifier_to_owner.items():
        owner_pos = positions.get(owner_id, (source_x, start_y))
        modifiers = owner_to_modifiers.get(owner_id, [modifier_id])
        mod_idx = modifiers.index(modifier_id) if modifier_id in modifiers else 0
        x = owner_pos[0] - 220
        y = owner_pos[1] + (mod_idx * 90)
        positions[modifier_id] = (x, y)

    # Any remaining orphan nodes
    for node in nodes:
        nid = node["id"]
        if nid not in positions:
            positions[nid] = (source_x, start_y + len(positions) * row_spacing)

    return positions


def validate_graph(doc: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Validate canonical sin-graph document syntax and topology."""
    errors: List[str] = []
    if not isinstance(doc, dict):
        return False, ["Document must be a JSON object."]

    if doc.get("format") != "sin-graph":
        errors.append("Invalid format: document must specify 'format': 'sin-graph'.")

    settings = doc.get("settings")
    if not isinstance(settings, dict):
        errors.append("Missing or invalid 'settings' object.")
    else:
        bpm = settings.get("bpm")
        if bpm is None or not (20 <= float(bpm) <= 400):
            errors.append(f"Invalid BPM setting: {bpm}")

    nodes = doc.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        errors.append("Document must contain at least one node in 'nodes'.")

    node_ids: Set[str] = set()
    node_by_id: Dict[str, Dict[str, Any]] = {}
    for node in nodes:
        nid = node.get("id")
        if not nid:
            errors.append("All nodes must have an 'id'.")
            continue
        if nid in node_ids:
            errors.append(f"Duplicate node id: '{nid}'.")
        node_ids.add(nid)
        node_by_id[nid] = node

    output_id = doc.get("output")
    if not output_id:
        errors.append("Document missing 'output' node specification.")
    elif output_id not in node_ids:
        errors.append(f"Output node '{output_id}' not found in 'nodes'.")

    connections = doc.get("connections", [])
    for conn in connections:
        c_from = conn.get("from")
        c_to = conn.get("to")
        if not c_from or c_from not in node_ids:
            errors.append(f"Connection from non-existent node: '{c_from}'.")
        if not c_to or c_to not in node_ids:
            errors.append(f"Connection to non-existent node: '{c_to}'.")

    # Cycle detection on audio connections
    adj: Dict[str, List[str]] = {nid: [] for nid in node_ids}
    for conn in connections:
        if conn.get("from") in adj and conn.get("to") in node_ids:
            adj[conn["from"]].append(conn["to"])

    visited: Set[str] = set()
    rec_stack: Set[str] = set()

    def has_cycle(curr: str) -> bool:
        visited.add(curr)
        rec_stack.add(curr)
        for neighbor in adj.get(curr, []):
            if neighbor not in visited:
                if has_cycle(neighbor):
                    return True
            elif neighbor in rec_stack:
                return True
        rec_stack.remove(curr)
        return False

    for nid in node_ids:
        if nid not in visited:
            if has_cycle(nid):
                errors.append(f"Audio connection cycle detected involving node '{nid}'.")
                break

    return len(errors) == 0, errors


# Node types whose properties are compiled into AudioNodeModel fields.
AUDIO_NODE_TYPES = frozenset({"sample", "sequence", "arrangement", "track"})

# Properties the compiler reads that are not AudioNodeModel fields themselves.
COMPILER_CONSUMED_PROPERTIES = frozenset({"node_name", "key_match_transpose"})

# Must stay in sync with core.fx.FX_PROCESSORS (gain staging only).
KNOWN_FX_TYPES = frozenset({
    "gain",
})


def collect_graph_warnings(doc: Dict[str, Any]) -> List[str]:
    """Report settings that are syntactically valid but never reach the audio engine.

    Unknown audio-node properties are silently dropped by the compiler, so a
    preset can validate yet render without its intended gain or effects.
    """
    warnings: List[str] = []
    if not isinstance(doc, dict) or doc.get("format") != "sin-graph":
        return warnings

    accepted = (set(AudioNodeModel.model_fields) - {"children"}) | COMPILER_CONSUMED_PROPERTIES
    for node in doc.get("nodes", []):
        if not isinstance(node, dict) or node.get("type", "track") not in AUDIO_NODE_TYPES:
            continue
        nid = node.get("id", "?")
        props = node.get("properties", {}) or {}
        ignored = sorted(key for key in props if key not in accepted)
        if ignored:
            warnings.append(
                f"Node '{nid}': properties ignored by the audio engine: {', '.join(ignored)}."
            )
        for module in props.get("chain", []) or []:
            fx_type = str(module.get("type", "")).lower() if isinstance(module, dict) else ""
            if fx_type not in KNOWN_FX_TYPES:
                warnings.append(f"Node '{nid}': unknown FX type '{fx_type}' in chain will be skipped.")
    return warnings


def graph_to_workspace(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a canonical sin-graph into a LiteGraph workspace preset with auto-layout."""
    valid, errors = validate_graph(doc)
    if not valid:
        raise ValueError(f"Invalid sin-graph document: {'; '.join(errors)}")

    auto_positions = compute_auto_layout_positions(doc)
    nodes = doc.get("nodes", [])
    connections = doc.get("connections", [])
    attachments = doc.get("attachments", [])
    settings = doc.get("settings", {"bpm": 120, "total_bars": 4, "key": "C"})

    numeric_ids: Dict[str, int] = {node["id"]: idx + 1 for idx, node in enumerate(nodes)}
    nodes_by_id: Dict[str, Dict[str, Any]] = {node["id"]: node for node in nodes}

    incoming_counts: Dict[str, int] = {}
    target_slots: Dict[int, int] = {}
    outgoing_links: Dict[int, List[int]] = {}

    for idx, conn in enumerate(connections):
        target_id = numeric_ids.get(conn["to"])
        source_id = numeric_ids.get(conn["from"])
        if target_id is None or source_id is None:
            continue
        slot = incoming_counts.get(conn["to"], 0)
        incoming_counts[conn["to"]] = slot + 1
        target_slots[idx] = slot
        outgoing_links.setdefault(source_id, []).append(idx + 1)

    lite_nodes: List[Dict[str, Any]] = []
    for idx, node in enumerate(nodes):
        nid = node["id"]
        num_id = numeric_ids[nid]
        pos = node.get("position") or auto_positions.get(nid, (idx * 260, 180))
        ntype = node.get("type", "track")
        lite_type = LITE_GRAPH_TYPE_MAP.get(ntype, "Audio/Track")

        incoming_count = incoming_counts.get(nid, 0)
        inputs: List[Dict[str, Any]] = []
        if ntype in ("track", "sequence", "arrangement"):
            for slot in range(max(1, incoming_count + 1)):
                link_id = None
                for c_idx, conn in enumerate(connections):
                    if conn.get("to") == nid and target_slots.get(c_idx) == slot:
                        link_id = c_idx + 1
                        break
                inputs.append({"name": "Input", "type": "audio", "link": link_id})

        links = outgoing_links.get(num_id)
        outputs = [{"name": "Audio", "type": "audio", "links": links, "slot_index": 0}] if ntype in (
            "track", "sample", "sequence", "arrangement"
        ) else []

        props = copy.deepcopy(node.get("properties", {}))
        props.setdefault("node_name", node.get("name", DEFAULT_NODE_NAMES.get(ntype, "AudioNode")))
        props.setdefault("node_type", ntype)

        if "chain" in props and isinstance(props["chain"], list):
            for mod in props["chain"]:
                if isinstance(mod, dict) and not mod.get("name"):
                    mod["name"] = mod.get("id", "Module").capitalize()

        # Attachments mapping
        for att in attachments:
            owner_nid = att.get("owner")
            mod_nid = att.get("modifier")
            att_type = att.get("type")
            mod_node = nodes_by_id.get(mod_nid, {})
            mod_type = mod_node.get("type")

            # Only asset_pool attachments (or asset_filter nodes) set asset_modifier_id on the owner
            if owner_nid == nid and mod_nid in numeric_ids:
                if att_type == "asset_pool" or mod_type == "asset_filter":
                    props["asset_modifier_id"] = numeric_ids[mod_nid]

            # All modifiers (asset_pool, random, modulator, etc.) record their parent owner via parentId
            if mod_nid == nid and owner_nid in numeric_ids:
                props["parentId"] = numeric_ids[owner_nid]

        lite_nodes.append({
            "id": num_id,
            "type": lite_type,
            "pos": list(pos),
            "size": [44, 44],
            "flags": {"collapsed": False, "hidden": False},
            "order": idx,
            "mode": 0,
            "inputs": inputs,
            "outputs": outputs,
            "title": node.get("name", DEFAULT_NODE_NAMES.get(ntype, "AudioNode")),
            "properties": props,
        })

    links_list = []
    for idx, conn in enumerate(connections):
        source_id = numeric_ids[conn["from"]]
        target_id = numeric_ids[conn["to"]]
        links_list.append([
            idx + 1,
            source_id,
            0,
            target_id,
            target_slots.get(idx, 0),
            conn.get("type", "audio"),
        ])

    output_num_id = numeric_ids.get(doc.get("output", ""), 1)

    return {
        "version": 2,
        "savedAt": "2026-10-10T12:00:00.000Z",
        "graph": {
            "last_node_id": len(nodes),
            "last_link_id": len(connections),
            "nodes": lite_nodes,
            "links": links_list,
            "groups": [],
            "config": {"links_ontop": True},
            "extra": {
                "global_parameters": dict(settings),
                "main_preview": {"node_id": output_num_id, "mode": "auto"},
            },
            "version": 0.4,
        },
    }


def compile_canonical_graph_to_audio_node_model(doc: Dict[str, Any], root_id: Optional[str] = None) -> AudioNodeModel:
    """Compile a canonical sin-graph document directly to an AudioNodeModel tree."""
    valid, errors = validate_graph(doc)
    if not valid:
        raise ValueError(f"Invalid sin-graph document: {'; '.join(errors)}")

    nodes = doc.get("nodes", [])
    nodes_by_id: Dict[str, Dict[str, Any]] = {n["id"]: n for n in nodes}
    connections = doc.get("connections", [])
    attachments = doc.get("attachments", [])
    settings = doc.get("settings", {"bpm": 120.0, "total_bars": 4.0, "key": "C"})

    global_bpm = float(settings.get("bpm", 120.0))
    global_bars = float(settings.get("total_bars", 4.0))

    # Index incoming audio children: target_id -> list of source_ids
    incoming_audio: Dict[str, List[str]] = {}
    for conn in connections:
        if conn.get("type", "audio") == "audio":
            incoming_audio.setdefault(conn["to"], []).append(conn["from"])

    # Index modifiers by owner: owner_id -> list of modifier_nodes
    modifiers_by_owner: Dict[str, List[Dict[str, Any]]] = {}
    for att in attachments:
        owner = att.get("owner")
        modifier = att.get("modifier")
        if owner and modifier and modifier in nodes_by_id:
            modifiers_by_owner.setdefault(owner, []).append(nodes_by_id[modifier])

    target_root = root_id or doc.get("output")
    if not target_root or target_root not in nodes_by_id:
        raise ValueError(f"Root node '{target_root}' not found in graph.")

    # Detect lead key for key matching
    lead_key = None
    for n in nodes:
        n_props = n.get("properties", {})
        if n_props.get("key_match_mode") == "lead" and n_props.get("key"):
            lead_key = str(n_props.get("key")).strip()
            break
    if not lead_key:
        lead_key = str(settings.get("key", "C")).strip()

    def build_node(nid: str, parent_total_bars: Optional[float] = None) -> AudioNodeModel:
        raw_node = nodes_by_id[nid]
        props = copy.deepcopy(raw_node.get("properties", {}))
        ntype = raw_node.get("type", "track")
        name = raw_node.get("name") or props.get("node_name") or DEFAULT_NODE_NAMES.get(ntype, "AudioNode")

        # Attached modifiers (asset pools, randomizers, modulators)
        attached_modifiers = modifiers_by_owner.get(nid, [])
        for mod in attached_modifiers:
            mod_props = mod.get("properties", {})
            mod_type = mod.get("type")
            if mod_type == "asset_filter":
                props.setdefault("selected_items", mod_props.get("selected_items", []))
                props.setdefault("playbackMode", mod_props.get("playbackMode", "Random"))
                props.setdefault("refresh_mode", mod_props.get("refresh_mode", "global"))
                props.setdefault("seed", mod_props.get("seed"))
                if mod_props.get("output_value") and not props.get("filepath"):
                    props["filepath"] = mod_props["output_value"]
            elif mod_type == "random":
                props.setdefault("random_destinations", mod_props.get("destinations", []))
                props.setdefault("seed", mod_props.get("seed"))

        # Chain modules
        raw_chain = props.get("chain", [])
        fx_chain: List[FxModuleModel] = []
        for fx in raw_chain:
            if isinstance(fx, dict):
                fx_chain.append(FxModuleModel(
                    id=fx.get("id", "fx"),
                    type=fx.get("type", "gain"),
                    name=fx.get("name", "FX"),
                    enabled=fx.get("enabled", True),
                    fixed=fx.get("fixed", False),
                    params=fx.get("params", {}),
                ))

        target_bpm = props.get("target_bpm") or props.get("bpm") or global_bpm
        if str(target_bpm).lower() == "global":
            target_bpm = global_bpm

        raw_total_bars = props.get("total_bars")
        if raw_total_bars is None or str(raw_total_bars).lower() == "global":
            total_bars = parent_total_bars if parent_total_bars is not None else (global_bars if ntype in ("sequence", "arrangement", "track") else None)
        else:
            total_bars = float(raw_total_bars)

        # Children recursion
        child_ids = incoming_audio.get(nid, [])
        children: List[AudioNodeModel] = []
        for cid in child_ids:
            if cid in nodes_by_id:
                children.append(build_node(cid, parent_total_bars=total_bars))

        base_transpose = float(props.get("transpose", 0.0))
        if props.get("key_match_mode") == "follow":
            if props.get("key_match_transpose") is not None:
                base_transpose += float(props.get("key_match_transpose", 0.0))
            elif lead_key:
                src_key = str(props.get("key") or "C").strip()
                algo = str(props.get("key_match_algorithm", "nearest")).strip()
                base_transpose += calculate_key_match_transpose(src_key, lead_key, algo)

        return AudioNodeModel(
            node_name=name,
            node_type=ntype,
            sample_type=props.get("sample_type", "loop"),
            filepath=props.get("filepath"),
            original_bpm=props.get("original_bpm", 120.0),
            target_bpm=float(target_bpm),
            key=props.get("key", ""),
            start_beat=float(props.get("start_beat", 0.0)),
            bpm=float(target_bpm),
            sequence=props.get("sequence"),
            step_parameters=props.get("step_parameters"),
            step_length=props.get("step_length"),
            play_mode=props.get("play_mode", "gate"),
            release=float(props.get("release", 0.0)),
            fade_ms=float(props.get("fade_ms", 0.0)),
            selected_items=props.get("selected_items"),
            playbackMode=props.get("playbackMode"),
            seed=props.get("seed"),
            seed_mode=props.get("seed_mode", "moving"),
            refresh_mode=props.get("refresh_mode", "off"),
            total_bars=float(total_bars) if total_bars is not None else None,
            probability=props.get("probability", 1.0),
            section_points=props.get("section_points", []),
            section_enabled=props.get("section_enabled", []),
            section_probability=props.get("section_probability", []),
            section_sample_start=props.get("section_sample_start", []),
            section_quant=props.get("section_quant", []),
            section_quant_anchor=props.get("section_quant_anchor", []),
            quant=props.get("quant", "auto"),
            quant_anchor=props.get("quant_anchor", "start"),
            crop_start=float(props.get("crop_start", 0.0)),
            crop_end=float(props.get("crop_end", 1.0)),
            transpose=base_transpose,
            cents=float(props.get("cents", 0.0)),
            stretch_mode=props.get("stretch_mode", "time_stretch"),
            stretch_factor=float(props.get("stretch_factor", 1.0)),
            stretch_algorithm=props.get("stretch_algorithm", "rubberband"),
            key_match_mode=props.get("key_match_mode", "off"),
            key_match_algorithm=props.get("key_match_algorithm", "nearest"),
            chain=fx_chain,
            children=children,
        )

    return build_node(target_root)


def compile_workspace_to_audio_node_model(preset: Dict[str, Any], root_num_id: Optional[int] = None) -> AudioNodeModel:
    """Compile a LiteGraph workspace preset dictionary directly to an AudioNodeModel tree."""
    graph = preset.get("graph", {})
    nodes = graph.get("nodes", [])
    links = graph.get("links", [])
    extra = graph.get("extra", {})
    globals_params = extra.get("global_parameters", {"bpm": 120.0, "total_bars": 4.0, "key": "C"})

    global_bpm = float(globals_params.get("bpm", 120.0))
    global_bars = float(globals_params.get("total_bars", 4.0))

    nodes_by_num_id: Dict[int, Dict[str, Any]] = {n["id"]: n for n in nodes if "id" in n}

    # Links: [id, origin_id, origin_slot, target_id, target_slot, type]
    incoming_audio: Dict[int, List[int]] = {}
    for link in links:
        if len(link) >= 6 and link[5] == "audio":
            origin_id = link[1]
            target_id = link[3]
            incoming_audio.setdefault(target_id, []).append(origin_id)

    target_root_id = root_num_id
    if target_root_id is None:
        target_root_id = extra.get("main_preview", {}).get("node_id")

    if target_root_id is None:
        # Fallback to master node or highest id
        for n in nodes:
            if n.get("properties", {}).get("role") == "master" or n.get("properties", {}).get("is_main_preview"):
                target_root_id = n["id"]
                break
        if target_root_id is None and nodes:
            target_root_id = nodes[-1]["id"]

    if target_root_id not in nodes_by_num_id:
        raise ValueError(f"Root node {target_root_id} not found in workspace preset.")

    # Detect lead key for key matching
    lead_key = None
    for n in nodes:
        n_props = n.get("properties", {})
        if n_props.get("key_match_mode") == "lead" and n_props.get("key"):
            lead_key = str(n_props.get("key")).strip()
            break
    if not lead_key:
        lead_key = str(globals_params.get("key", "C")).strip()

    def build_node(num_id: int, parent_total_bars: Optional[float] = None) -> AudioNodeModel:
        raw_node = nodes_by_num_id[num_id]
        props = copy.deepcopy(raw_node.get("properties", {}))
        lite_type = raw_node.get("type", "Audio/Track")
        ntype = REVERSE_LITE_GRAPH_TYPE_MAP.get(lite_type, props.get("node_type", "track"))
        name = props.get("node_name") or raw_node.get("title") or DEFAULT_NODE_NAMES.get(ntype, "AudioNode")

        # Resolve asset pool if modifier attached
        modifier_id = props.get("asset_modifier_id")
        if not modifier_id or (modifier_id in nodes_by_num_id and nodes_by_num_id[modifier_id].get("type") != "Audio/AssetFilter"):
            for cand in nodes:
                if cand.get("type") == "Audio/AssetFilter" and cand.get("properties", {}).get("parentId") == num_id:
                    modifier_id = cand.get("id")
                    break

        if modifier_id and modifier_id in nodes_by_num_id:
            mod_node = nodes_by_num_id[modifier_id]
            if mod_node.get("type") == "Audio/AssetFilter":
                mod_props = mod_node.get("properties", {})
                props.setdefault("selected_items", mod_props.get("selected_items", []))
                props.setdefault("playbackMode", mod_props.get("playbackMode", "Random"))
                props.setdefault("refresh_mode", mod_props.get("refresh_mode", "global"))
                props.setdefault("seed", mod_props.get("seed"))
                if mod_props.get("output_value") and not props.get("filepath"):
                    props["filepath"] = mod_props["output_value"]

        # Resolve random modifiers attached via parentId
        for cand in nodes:
            if cand.get("type") == "Audio/Random" and cand.get("properties", {}).get("parentId") == num_id:
                cand_props = cand.get("properties", {})
                props.setdefault("random_destinations", cand_props.get("destinations", []))
                props.setdefault("seed", cand_props.get("seed"))

        raw_chain = props.get("chain", [])
        fx_chain: List[FxModuleModel] = []
        for fx in raw_chain:
            if isinstance(fx, dict):
                fx_chain.append(FxModuleModel(
                    id=fx.get("id", "fx"),
                    type=fx.get("type", "gain"),
                    name=fx.get("name", "FX"),
                    enabled=fx.get("enabled", True),
                    fixed=fx.get("fixed", False),
                    params=fx.get("params", {}),
                ))

        target_bpm = props.get("target_bpm") or props.get("bpm") or global_bpm
        if str(target_bpm).lower() == "global":
            target_bpm = global_bpm

        raw_total_bars = props.get("total_bars")
        if raw_total_bars is None or str(raw_total_bars).lower() == "global":
            total_bars = parent_total_bars if parent_total_bars is not None else (global_bars if ntype in ("sequence", "arrangement", "track") else None)
        else:
            total_bars = float(raw_total_bars)

        child_ids = incoming_audio.get(num_id, [])
        children: List[AudioNodeModel] = []
        for cid in child_ids:
            if cid in nodes_by_num_id:
                children.append(build_node(cid, parent_total_bars=total_bars))

        base_transpose = float(props.get("transpose", 0.0))
        if props.get("key_match_mode") == "follow":
            if props.get("key_match_transpose") is not None:
                base_transpose += float(props.get("key_match_transpose", 0.0))
            elif lead_key:
                src_key = str(props.get("key") or "C").strip()
                algo = str(props.get("key_match_algorithm", "nearest")).strip()
                base_transpose += calculate_key_match_transpose(src_key, lead_key, algo)

        return AudioNodeModel(
            node_name=name,
            node_type=ntype,
            sample_type=props.get("sample_type", "loop"),
            filepath=props.get("filepath"),
            original_bpm=props.get("original_bpm", 120.0),
            target_bpm=float(target_bpm),
            key=props.get("key", ""),
            start_beat=float(props.get("start_beat", 0.0)),
            bpm=float(target_bpm),
            sequence=props.get("sequence"),
            step_parameters=props.get("step_parameters"),
            step_length=props.get("step_length"),
            play_mode=props.get("play_mode", "gate"),
            release=float(props.get("release", 0.0)),
            fade_ms=float(props.get("fade_ms", 0.0)),
            selected_items=props.get("selected_items"),
            playbackMode=props.get("playbackMode"),
            seed=props.get("seed"),
            seed_mode=props.get("seed_mode", "moving"),
            refresh_mode=props.get("refresh_mode", "off"),
            total_bars=float(total_bars) if total_bars is not None else None,
            probability=props.get("probability", 1.0),
            section_points=props.get("section_points", []),
            section_enabled=props.get("section_enabled", []),
            section_probability=props.get("section_probability", []),
            section_sample_start=props.get("section_sample_start", []),
            section_quant=props.get("section_quant", []),
            section_quant_anchor=props.get("section_quant_anchor", []),
            quant=props.get("quant", "auto"),
            quant_anchor=props.get("quant_anchor", "start"),
            crop_start=float(props.get("crop_start", 0.0)),
            crop_end=float(props.get("crop_end", 1.0)),
            transpose=base_transpose,
            cents=float(props.get("cents", 0.0)),
            stretch_mode=props.get("stretch_mode", "time_stretch"),
            stretch_factor=float(props.get("stretch_factor", 1.0)),
            stretch_algorithm=props.get("stretch_algorithm", "rubberband"),
            key_match_mode=props.get("key_match_mode", "off"),
            key_match_algorithm=props.get("key_match_algorithm", "nearest"),
            chain=fx_chain,
            children=children,
        )

    return build_node(target_root_id)


def compile_any_to_audio_node_model(data: Dict[str, Any], isolate_target: Optional[str] = None) -> AudioNodeModel:
    """Universal compiler: inspects format and produces canonical AudioNodeModel."""
    if data.get("format") == "sin-graph":
        return compile_canonical_graph_to_audio_node_model(data, root_id=isolate_target)
    elif "graph" in data and "nodes" in data.get("graph", {}):
        num_target = int(isolate_target) if isolate_target and isolate_target.isdigit() else None
        return compile_workspace_to_audio_node_model(data, root_num_id=num_target)
    elif "node_name" in data and ("children" in data or "node_type" in data):
        return AudioNodeModel(**data)
    else:
        raise ValueError("Unrecognized graph payload: must be 'sin-graph', workspace preset, or AudioNodeModel.")
