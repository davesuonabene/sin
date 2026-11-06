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
from ermes.py.schemas import AudioNodeModel, FxModuleModel, NodeSlotModel
from ermes.py.slot_language import (
    mulberry32,
    resolve_cycle_seeds,
    resolve_modifier_slot_seeds,
    resolve_section_slot,
    resolve_step_slots,
    wrap_slot_index,
)


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
COMPILER_CONSUMED_PROPERTIES = frozenset({
    "node_name",
    "key_match_transpose",
    "gain",
    "seed_refresh",
    "active_slot",
    "library_item_id",
    "asset_modifier_id",
})


def _normalize_gain_into_chain(props: Dict[str, Any], remove_top_gain: bool = False) -> List[Dict[str, Any]]:
    """Normalizes top-level properties.gain (in dB) into a Post Gain chain module when chain is empty."""
    raw_chain = [copy.deepcopy(m) for m in (props.get("chain") or []) if isinstance(m, dict)]
    top_gain = props.get("gain")
    if remove_top_gain and "gain" in props:
        props.pop("gain", None)
    if top_gain is not None and not raw_chain:
        try:
            g_db = float(top_gain)
            g_lin = 0.0 if g_db <= -35.9 else round(float(10.0 ** (g_db / 20.0)), 6)
            raw_chain = [{
                "id": "post_gain_0",
                "type": "gain",
                "name": "Post Gain",
                "enabled": True,
                "fixed": True,
                "params": {"gain": g_lin, "gain_db": g_db},
            }]
        except (TypeError, ValueError):
            pass
    if raw_chain:
        props["chain"] = raw_chain
    return raw_chain


def _normalize_random_destinations(mod_props: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Normalizes legacy 'targets' or canonical 'destinations' on a random modifier node."""
    dests = mod_props.get("destinations")
    if isinstance(dests, list) and dests:
        return copy.deepcopy(dests)
    targets = mod_props.get("targets")
    if not isinstance(targets, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for idx, t in enumerate(targets):
        if not isinstance(t, dict):
            continue
        raw_field = str(t.get("paramKey") or t.get("field") or "").strip()
        if not raw_field:
            continue
        if raw_field.startswith("step_parameters.") and raw_field.count(".") == 1:
            param_key = raw_field.split(".", 1)[1]
        else:
            param_key = raw_field
        default_base = 1.0 if param_key == "velocity" else (100.0 if param_key == "probability" else 0.0)
        normalized.append({
            "id": str(t.get("id") or f"dest_{idx}"),
            "paramKey": param_key,
            "paramLabel": str(t.get("paramLabel") or param_key.capitalize()),
            "minPercent": float(t.get("minPercent", t.get("min", 0.0))),
            "maxPercent": float(t.get("maxPercent", t.get("max", 0.0))),
            "baseValue": float(t.get("baseValue", default_base)),
            "enabled": bool(t.get("enabled", True)),
        })
    return normalized


def _apply_seeded_random_to_single_dict(
    target_dict: Dict[str, Any],
    destinations: List[Dict[str, Any]],
    numeric_seed: int,
    fallback_seq: Optional[List[int]] = None,
) -> None:
    rng = mulberry32(numeric_seed)
    field_spans = {
        "velocity": (0.0, 1.0, 1.0),
        "offset": (-0.5, 0.5, 1.0),
        "probability": (0.0, 100.0, 100.0),
        "subdivisions": (1.0, 8.0, 7.0),
        "sample_start": (0.0, 1.0, 1.0),
        "gate_length": (0.01, 1.0, 0.99),
        "transpose": (-24.0, 24.0, 48.0),
        "cents": (-100.0, 100.0, 200.0),
        "release": (0.0, 1.0, 1.0),
        "fade_ms": (0.0, 5.0, 5.0),
    }

    def _eval_rel(base_val: float, min_pct: float, max_pct: float, key: str) -> float:
        lo_bound, hi_bound, span = field_spans.get(key, (None, None, abs(base_val) if abs(base_val) > 1e-4 else 1.0))
        min_off = (min_pct / 100.0) * span
        max_off = (max_pct / 100.0) * span
        lo, hi = min(min_off, max_off), max(min_off, max_off)
        val = base_val + (lo + rng() * (hi - lo))
        if lo_bound is not None:
            val = max(lo_bound, val)
        if hi_bound is not None:
            val = min(hi_bound, val)
        return round(val, 4)

    for dest in destinations:
        if not isinstance(dest, dict) or not dest.get("enabled", True):
            continue
        pkey = str(dest.get("paramKey") or "")
        min_pct = float(dest.get("minPercent", 0.0))
        max_pct = float(dest.get("maxPercent", 0.0))
        if pkey in ("velocity", "offset", "probability", "subdivisions", "sample_start", "gate_length"):
            seq = target_dict.get("sequence") or fallback_seq
            step_count = len(seq) if isinstance(seq, list) and len(seq) > 0 else 16
            step_params = target_dict.get("step_parameters")
            if not isinstance(step_params, list) or len(step_params) == 0:
                step_params = [
                    {"velocity": 1.0, "offset": 0.0, "probability": 100.0, "subdivisions": 1, "subdivision_enabled": False}
                    for _ in range(step_count)
                ]
                target_dict["step_parameters"] = step_params
            for sp in step_params:
                if not isinstance(sp, dict):
                    continue
                default_v = 1.0 if pkey in ("velocity", "gate_length", "subdivisions") else (100.0 if pkey == "probability" else 0.0)
                base_v = float(sp.get(pkey, dest.get("baseValue", default_v)))
                if pkey in ("velocity", "gate_length", "probability", "subdivisions") and base_v <= 0.0:
                    fallback_base = float(dest.get("baseValue", default_v) or default_v)
                    base_v = fallback_base if fallback_base > 0.0 else default_v
                new_v = _eval_rel(base_v, min_pct, max_pct, pkey)
                if pkey == "subdivisions":
                    new_int = max(1, int(round(new_v)))
                    sp["subdivisions"] = new_int
                    sp["subdivision_enabled"] = new_int > 1
                else:
                    sp[pkey] = new_v
        elif pkey in target_dict or dest.get("baseValue") is not None:
            try:
                base_v = float(target_dict.get(pkey, dest.get("baseValue", 0.0)))
                target_dict[pkey] = _eval_rel(base_v, min_pct, max_pct, pkey)
            except (TypeError, ValueError):
                pass


def _apply_seeded_random_to_props(props: Dict[str, Any], destinations: List[Dict[str, Any]], seed: Any) -> None:
    """Applies deterministic seeded random modulation to sequence step_parameters, slots, or scalar properties."""
    if not destinations:
        return
    raw_slots = props.get("slots")
    slot_count = len(raw_slots) if isinstance(raw_slots, list) and len(raw_slots) > 0 else 1
    slot_seeds = resolve_modifier_slot_seeds(seed if seed is not None else 42, slot_count)
    _apply_seeded_random_to_single_dict(props, destinations, slot_seeds[0])

    if isinstance(raw_slots, list) and len(raw_slots) > 0:
        fallback_seq = props.get("sequence")
        for s_idx, slot_dict in enumerate(raw_slots):
            if isinstance(slot_dict, dict):
                _apply_seeded_random_to_single_dict(
                    slot_dict,
                    destinations,
                    slot_seeds[s_idx % len(slot_seeds)],
                    fallback_seq=fallback_seq,
                )


def _resolve_node_slots_and_selectors(
    ntype: str,
    props: Dict[str, Any],
    total_bars: Optional[float],
    children: List[AudioNodeModel],
    node_id_salt: int = 1,
) -> Tuple[List[NodeSlotModel], str, List[int], List[int], List[int]]:
    """Normalizes node `slots` and resolves connected-path slot selectors (`sample_slot`, `step_slots`, `cycle_seeds`, `section_slots`)."""
    upstream_slot_count = max(1, len(children[0].slots) if children and children[0].slots else 1)
    upstream_active_slot = max(0, int(getattr(children[0], "active_slot", 0) or 0)) if children else 0
    active_slot_idx = max(0, int(props.get("active_slot", 0) or 0))
    raw_slots = props.get("slots") if isinstance(props.get("slots"), list) else []
    slots: List[NodeSlotModel] = []

    if ntype == "sample":
        filepath = props.get("filepath")
        original_bpm = props.get("original_bpm")
        key = props.get("key")
        crop_start = float(props.get("crop_start", 0.0))
        crop_end = float(props.get("crop_end", 1.0))
        if raw_slots:
            for idx, s in enumerate(raw_slots):
                if not isinstance(s, dict):
                    continue
                slots.append(NodeSlotModel(
                    slot=idx,
                    label=s.get("label"),
                    filepath=s.get("filepath") if s.get("filepath") is not None else (filepath if idx == active_slot_idx else None),
                    library_item_id=s.get("library_item_id") if s.get("library_item_id") is not None else (props.get("library_item_id") if idx == active_slot_idx else None),
                    original_bpm=s.get("original_bpm") if s.get("original_bpm") is not None else (original_bpm if idx == active_slot_idx else None),
                    key=s.get("key") if s.get("key") is not None else (key if idx == active_slot_idx else None),
                    duration_seconds=s.get("duration_seconds"),
                    crop_start=float(s.get("crop_start", crop_start)),
                    crop_end=float(s.get("crop_end", crop_end)),
                ))
        if not slots:
            slots.append(NodeSlotModel(
                slot=0,
                filepath=filepath,
                library_item_id=props.get("library_item_id"),
                original_bpm=original_bpm,
                key=key,
                crop_start=crop_start,
                crop_end=crop_end,
            ))
    elif ntype == "sequence":
        sequence = props.get("sequence") or [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        step_parameters = props.get("step_parameters")
        step_length = float(props.get("step_length") or 0.25)
        sample_slot_expr = str(props.get("sample_slot") if props.get("sample_slot") is not None else "*")
        seed_val = props.get("seed") if props.get("seed") is not None else 42
        seq_len = len(sequence) if isinstance(sequence, list) and len(sequence) > 0 else 16
        pattern_beats = max(0.25, seq_len * step_length)
        total_beats = float(total_bars or 4.0) * 4.0
        num_cycles = max(1, int(round((total_beats + pattern_beats - 1e-9) // pattern_beats)))

        if raw_slots:
            for idx, s in enumerate(raw_slots):
                if not isinstance(s, dict):
                    continue
                slot_seq = list(s.get("sequence") if isinstance(s.get("sequence"), list) else sequence)
                slot_step_params = copy.deepcopy(s.get("step_parameters") if isinstance(s.get("step_parameters"), list) else step_parameters)
                slot_sample_slot = str(s.get("sample_slot") if s.get("sample_slot") is not None else sample_slot_expr)
                slot_seed = s.get("seed") if s.get("seed") is not None else seed_val
                slot_cycle_seeds = resolve_cycle_seeds(slot_seed, num_cycles, node_id_salt + idx)
                slot_step_slots = resolve_step_slots(slot_sample_slot, len(slot_seq) or 16, upstream_slot_count, slot_cycle_seeds[0], upstream_active_slot)
                slots.append(NodeSlotModel(
                    slot=idx,
                    label=s.get("label"),
                    sequence=slot_seq,
                    step_parameters=slot_step_params,
                    sample_slot=slot_sample_slot,
                    step_slots=slot_step_slots,
                    seed=slot_seed,
                    cycle_seeds=slot_cycle_seeds,
                ))
        if not slots:
            cycle_seeds_0 = resolve_cycle_seeds(seed_val, num_cycles, node_id_salt)
            step_slots_0 = resolve_step_slots(sample_slot_expr, seq_len, upstream_slot_count, cycle_seeds_0[0], upstream_active_slot)
            slots.append(NodeSlotModel(
                slot=0,
                sequence=list(sequence),
                step_parameters=copy.deepcopy(step_parameters) if isinstance(step_parameters, list) else None,
                sample_slot=sample_slot_expr,
                step_slots=step_slots_0,
                seed=seed_val,
                cycle_seeds=cycle_seeds_0,
            ))

    clamped_active = min(active_slot_idx, len(slots) - 1) if slots else 0
    sample_slot_out = str(props.get("sample_slot") if props.get("sample_slot") is not None else "*")
    step_slots_out = list(slots[clamped_active].step_slots or []) if ntype == "sequence" and slots else []
    section_points = props.get("section_points") if isinstance(props.get("section_points"), list) else []
    num_sections = len(section_points) + 1

    if ntype == "sequence" and slots:
        cycle_seeds_out = list(slots[clamped_active].cycle_seeds or [])
    elif ntype == "arrangement":
        cycle_seeds_out = resolve_cycle_seeds(props.get("seed") if props.get("seed") is not None else 42, num_sections, node_id_salt)
    else:
        cycle_seeds_out = []

    raw_section_slots = props.get("section_slots") if isinstance(props.get("section_slots"), list) else []
    section_slots_out = (
        [
            resolve_section_slot(
                raw_section_slots[i] if i < len(raw_section_slots) else "*",
                upstream_slot_count,
                upstream_active_slot,
                cycle_seeds_out[i] if i < len(cycle_seeds_out) else (props.get("seed") if props.get("seed") is not None else 42),
                i,
            )
            for i in range(num_sections)
        ]
        if ntype == "arrangement"
        else []
    )
    return slots, sample_slot_out, step_slots_out, cycle_seeds_out, section_slots_out

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

        if ntype in AUDIO_NODE_TYPES:
            _normalize_gain_into_chain(props, remove_top_gain=True)
        elif ntype == "random":
            norm_dests = _normalize_random_destinations(props)
            if norm_dests and not props.get("destinations"):
                props["destinations"] = norm_dests
            props.pop("targets", None)

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

    def build_node(
        nid: str,
        parent_total_bars: Optional[float] = None,
        parent_ntype: Optional[str] = None,
    ) -> AudioNodeModel:
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
                dests = _normalize_random_destinations(mod_props)
                _apply_seeded_random_to_props(props, dests, mod_props.get("seed"))
                props.setdefault("seed", mod_props.get("seed"))

        # Chain modules (normalize top-level gain in dB into chain if needed)
        raw_chain = _normalize_gain_into_chain(props, remove_top_gain=False)
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
        if raw_total_bars is None or str(raw_total_bars).lower() == "global" or props.get("length_inherited"):
            if ntype == "sample":
                is_loop = props.get("sample_type", "loop") == "loop"
                total_bars = parent_total_bars if (is_loop and parent_ntype in (None, "track")) else None
            else:
                total_bars = parent_total_bars if parent_total_bars is not None else (global_bars if ntype in ("sequence", "arrangement", "track") else None)
        else:
            total_bars = float(raw_total_bars)

        # Children recursion
        child_ids = incoming_audio.get(nid, [])
        children: List[AudioNodeModel] = []
        for cid in child_ids:
            if cid in nodes_by_id:
                children.append(build_node(cid, parent_total_bars=total_bars, parent_ntype=ntype))

        base_transpose = float(props.get("transpose", 0.0))
        if props.get("key_match_mode") == "follow":
            if props.get("key_match_transpose") is not None:
                base_transpose += float(props.get("key_match_transpose", 0.0))
            elif lead_key:
                src_key = str(props.get("key") or "C").strip()
                algo = str(props.get("key_match_algorithm", "nearest")).strip()
                base_transpose += calculate_key_match_transpose(src_key, lead_key, algo)

        node_id_val = int(nid) if str(nid).isdigit() else None
        slots, sample_slot_val, step_slots_val, cycle_seeds_val, section_slots_val = (
            _resolve_node_slots_and_selectors(ntype, props, total_bars, children, node_id_val or 1)
        )
        return AudioNodeModel(
            node_id=node_id_val,
            node_name=name,
            node_type=ntype,
            sample_type=props.get("sample_type", "loop"),
            filepath=props.get("filepath"),
            original_bpm=props.get("original_bpm"),
            target_bpm=float(target_bpm),
            key=props.get("key", ""),
            start_beat=float(props.get("start_beat", 0.0)),
            mix_mode=props.get("mix_mode", "sum"),
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
            slots=slots,
            active_slot=max(0, int(props.get("active_slot", 0) or 0)),
            sample_slot=sample_slot_val,
            step_slots=step_slots_val,
            cycle_seeds=cycle_seeds_val,
            section_slots=section_slots_val,
            total_bars=float(total_bars) if total_bars is not None else None,
            probability=props.get("probability", 1.0),
            section_points=props.get("section_points", []),
            section_enabled=props.get("section_enabled", []),
            section_probability=props.get("section_probability", []),
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
    graph = preset.get("graph") if "graph" in preset and "nodes" not in preset else preset
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

    def build_node(
        num_id: int,
        parent_total_bars: Optional[float] = None,
        parent_ntype: Optional[str] = None,
    ) -> AudioNodeModel:
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
                dests = _normalize_random_destinations(cand_props)
                _apply_seeded_random_to_props(props, dests, cand_props.get("seed"))
                props.setdefault("seed", cand_props.get("seed"))

        raw_chain = _normalize_gain_into_chain(props, remove_top_gain=False)
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
        if raw_total_bars is None or str(raw_total_bars).lower() == "global" or props.get("length_inherited"):
            if ntype == "sample":
                is_loop = props.get("sample_type", "loop") == "loop"
                total_bars = parent_total_bars if (is_loop and parent_ntype in (None, "track")) else None
            else:
                total_bars = parent_total_bars if parent_total_bars is not None else (global_bars if ntype in ("sequence", "arrangement", "track") else None)
        else:
            total_bars = float(raw_total_bars)

        child_ids = incoming_audio.get(num_id, [])
        children: List[AudioNodeModel] = []
        for cid in child_ids:
            if cid in nodes_by_num_id:
                children.append(build_node(cid, parent_total_bars=total_bars, parent_ntype=ntype))

        base_transpose = float(props.get("transpose", 0.0))
        if props.get("key_match_mode") == "follow":
            if props.get("key_match_transpose") is not None:
                base_transpose += float(props.get("key_match_transpose", 0.0))
            elif lead_key:
                src_key = str(props.get("key") or "C").strip()
                algo = str(props.get("key_match_algorithm", "nearest")).strip()
                base_transpose += calculate_key_match_transpose(src_key, lead_key, algo)

        slots, sample_slot_val, step_slots_val, cycle_seeds_val, section_slots_val = (
            _resolve_node_slots_and_selectors(ntype, props, total_bars, children, int(num_id))
        )
        return AudioNodeModel(
            node_id=int(num_id),
            node_name=name,
            node_type=ntype,
            sample_type=props.get("sample_type", "loop"),
            filepath=props.get("filepath"),
            original_bpm=props.get("original_bpm"),
            target_bpm=float(target_bpm),
            key=props.get("key", ""),
            start_beat=float(props.get("start_beat", 0.0)),
            mix_mode=props.get("mix_mode", "sum"),
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
            slots=slots,
            active_slot=max(0, int(props.get("active_slot", 0) or 0)),
            sample_slot=sample_slot_val,
            step_slots=step_slots_val,
            cycle_seeds=cycle_seeds_val,
            section_slots=section_slots_val,
            total_bars=float(total_bars) if total_bars is not None else None,
            probability=props.get("probability", 1.0),
            section_points=props.get("section_points", []),
            section_enabled=props.get("section_enabled", []),
            section_probability=props.get("section_probability", []),
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
