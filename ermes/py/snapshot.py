"""ERMES Generic sin-snapshot Engine (Python).

Handles partial parameter delta snapshots over canonical sin-graph documents.
Used for cuts, audition variations, and non-destructive presets.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Tuple


SNAPSHOT_FORMAT = "sin-snapshot"
SNAPSHOT_VERSION = 1


def _set_nested_prop(properties: Dict[str, Any], path: str, value: Any) -> None:
    """Sets a property value by key or dotted path, supporting chain.<module_id>.<subpath>."""
    if not path:
        return

    # Direct top-level property
    if "." not in path:
        properties[path] = value
        return

    parts = path.split(".")
    # FX Chain handling: chain.<module_id>.params.<param_name> or chain.<module_id>.enabled
    if parts[0] == "chain" and len(parts) >= 3:
        module_id = parts[1]
        chain = properties.get("chain", [])
        if not isinstance(chain, list):
            chain = []
            properties["chain"] = chain

        target_module = None
        for mod in chain:
            if isinstance(mod, dict) and mod.get("id") == module_id:
                target_module = mod
                break

        if target_module is None:
            # Create a placeholder module if missing
            target_module = {"id": module_id, "type": "gain", "enabled": True, "params": {}}
            chain.append(target_module)

        sub_key = parts[2]
        if sub_key == "enabled":
            target_module["enabled"] = bool(value)
        elif sub_key == "params" and len(parts) >= 4:
            param_key = parts[3]
            params = target_module.setdefault("params", {})
            params[param_key] = value
        else:
            target_module[sub_key] = value
        return

    # General dotted path dictionary traversal
    curr = properties
    for part in parts[:-1]:
        curr = curr.setdefault(part, {})
    curr[parts[-1]] = value


def apply_snapshot(
    graph: Dict[str, Any],
    snapshot: Optional[Dict[str, Any]] = None,
    transient_overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Returns a deep-copied sin-graph with snapshot overrides and transient overrides applied.

    1. Base graph structure, topology, and properties are preserved.
    2. Snapshot overrides are layered on matching node IDs.
    3. Missing node IDs are skipped safely without raising an error.
    4. Transient overrides (e.g. temporary solo, audition fader) are applied last.
    """
    resolved = copy.deepcopy(graph)
    nodes = resolved.get("nodes", [])
    node_map = {node["id"]: node for node in nodes if isinstance(node, dict) and "id" in node}

    # 1. Apply Snapshot Overrides
    if snapshot and isinstance(snapshot, dict):
        overrides = snapshot.get("overrides", {})
        if isinstance(overrides, dict):
            for node_id, prop_overrides in overrides.items():
                if node_id in node_map and isinstance(prop_overrides, dict):
                    node = node_map[node_id]
                    props = node.setdefault("properties", {})
                    for prop_path, value in prop_overrides.items():
                        _set_nested_prop(props, prop_path, value)

    # 2. Apply Transient Overrides (Audition / Solo)
    if transient_overrides and isinstance(transient_overrides, dict):
        for node_id, prop_overrides in transient_overrides.items():
            if node_id in node_map and isinstance(prop_overrides, dict):
                node = node_map[node_id]
                props = node.setdefault("properties", {})
                for prop_path, value in prop_overrides.items():
                    _set_nested_prop(props, prop_path, value)

    return resolved


def diff_snapshot(
    base_graph: Dict[str, Any],
    modified_graph: Dict[str, Any],
    snapshot_id: str,
    label: str = "",
    root: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Computes a minimal sin-snapshot containing only property deltas between base and modified."""
    base_nodes = {n["id"]: n for n in base_graph.get("nodes", []) if isinstance(n, dict) and "id" in n}
    mod_nodes = {n["id"]: n for n in modified_graph.get("nodes", []) if isinstance(n, dict) and "id" in n}

    overrides: Dict[str, Dict[str, Any]] = {}

    for node_id, mod_node in mod_nodes.items():
        base_node = base_nodes.get(node_id)
        if not base_node:
            continue

        base_props = base_node.get("properties", {}) or {}
        mod_props = mod_node.get("properties", {}) or {}

        node_overrides: Dict[str, Any] = {}

        # Check top-level properties
        all_keys = set(base_props.keys()) | set(mod_props.keys())
        for key in all_keys:
            if key == "chain":
                # Compare FX modules
                base_chain = {m["id"]: m for m in base_props.get("chain", []) if isinstance(m, dict) and "id" in m}
                mod_chain = {m["id"]: m for m in mod_props.get("chain", []) if isinstance(m, dict) and "id" in m}
                for mod_id, m_mod in mod_chain.items():
                    b_mod = base_chain.get(mod_id, {})
                    if m_mod.get("enabled") != b_mod.get("enabled"):
                        node_overrides[f"chain.{mod_id}.enabled"] = m_mod.get("enabled")
                    m_params = m_mod.get("params", {}) or {}
                    b_params = b_mod.get("params", {}) or {}
                    for p_key, p_val in m_params.items():
                        if p_val != b_params.get(p_key):
                            node_overrides[f"chain.{mod_id}.params.{p_key}"] = p_val
            else:
                b_val = base_props.get(key)
                m_val = mod_props.get(key)
                if b_val != m_val and m_val is not None:
                    node_overrides[key] = m_val

        if node_overrides:
            overrides[node_id] = node_overrides

    return {
        "format": SNAPSHOT_FORMAT,
        "version": SNAPSHOT_VERSION,
        "id": snapshot_id,
        "label": label or snapshot_id,
        "root": root or modified_graph.get("output", "master"),
        "overrides": overrides,
        "meta": meta or {},
    }


def validate_snapshot(graph: Dict[str, Any], snapshot: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Validates that a snapshot conforms to schema and refers to valid nodes."""
    errors: List[str] = []

    if not isinstance(snapshot, dict):
        return False, ["Snapshot must be a JSON dictionary"]

    if snapshot.get("format") != SNAPSHOT_FORMAT:
        errors.append(f"Invalid format: expected '{SNAPSHOT_FORMAT}', got '{snapshot.get('format')}'")

    if not snapshot.get("id"):
        errors.append("Snapshot must have a non-empty 'id'")

    overrides = snapshot.get("overrides")
    if not isinstance(overrides, dict):
        errors.append("Snapshot 'overrides' must be a dictionary")
    else:
        node_ids = {n["id"] for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}
        for node_id, prop_dict in overrides.items():
            if node_id not in node_ids:
                # Warning rather than hard failure, as stale nodes can happen
                pass
            if not isinstance(prop_dict, dict):
                errors.append(f"Overrides for node '{node_id}' must be a dictionary of property paths")

    return len(errors) == 0, errors
