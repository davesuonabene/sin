"""Shared in-process DSP audio engine for SIN and GAIA.

Packs canonical `sin-graph` documents (and optional attached SIN workspaces) via
`core.plan_packer` and renders directly through the native C++20 `libsin_dsp` shared
library (`core.audio_engine`) for fast, memory-safe, bit-exact offline bounces,
with transparent fallback to legacy Python rendering only if the native binary is absent.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

from core.audio_engine import is_native_engine_available, render_plan_offline
from core.plan_packer import _resolve_relative_filepath, pack_canonical_graph
from core.qa import analyze_audio_buffer
from core.render_plan import SIN_DEFAULT_SAMPLE_RATE


def _resolve_workspace_paths(workspace: Dict[str, Any], project_root: Optional[Path]) -> Dict[str, Any]:
    resolved = copy.deepcopy(workspace)
    graph = resolved.get("graph") if isinstance(resolved.get("graph"), dict) else resolved
    if project_root and isinstance(graph, dict):
        for node in graph.get("nodes", []):
            if not isinstance(node, dict):
                continue
            props = node.get("properties")
            if isinstance(props, dict):
                if props.get("filepath"):
                    props["filepath"] = _resolve_relative_filepath(props.get("filepath"), project_root)
                for slot in props.get("slots") or []:
                    if isinstance(slot, dict) and slot.get("filepath"):
                        slot["filepath"] = _resolve_relative_filepath(slot.get("filepath"), project_root)
    return resolved


def resolve_and_render_graph(
    base_graph: Dict[str, Any],
    snapshot: Optional[Dict[str, Any]] = None,
    transient_overrides: Optional[Dict[str, Any]] = None,
    root_id: Optional[str] = None,
    project_root: Optional[Path] = None,
    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
    workspace: Optional[Dict[str, Any]] = None,
) -> Tuple[np.ndarray, int, Dict[str, Any]]:
    """1. Applies snapshot + transient overrides onto base_graph (or uses workspace if unmodified).
    2. Resolves relative file paths against project_root.
    3. Packs a flat `SinRenderPlan` via `core.plan_packer` and renders natively through `libsin_dsp`
       (streaming multi-GB files straight from disk in C++ with exact live-to-export parity).
    4. Applies output post-processing: normalization and target peak ceiling.
    5. Returns (audio_buffer, sample_rate, qa_metrics).
    """
    eff_sr = int(sample_rate or SIN_DEFAULT_SAMPLE_RATE)

    if is_native_engine_available():
        plan = pack_canonical_graph(
            base_graph=base_graph,
            snapshot=snapshot,
            transient_overrides=transient_overrides,
            root_id=root_id,
            project_root=project_root,
            sample_rate=eff_sr,
            workspace=workspace,
        )
        audio_out, _ = render_plan_offline(plan, sample_rate=eff_sr)
        normalize = plan.normalize
        target_peak_db = plan.target_peak_db
    else:
        # Clean graceful fallback when running on a machine where libsin_dsp has not been compiled yet
        from ermes.py.snapshot import apply_snapshot
        from ermes.py.compiler import (
            compile_canonical_graph_to_audio_node_model,
            compile_workspace_to_audio_node_model,
        )
        from core.system import System
        from core.engines import get_renderer_for_node

        use_workspace = (
            isinstance(workspace, dict)
            and isinstance(workspace.get("graph"), dict)
            and bool(workspace["graph"].get("nodes"))
            and snapshot is None
            and not transient_overrides
        )
        if use_workspace:
            resolved_ws = _resolve_workspace_paths(workspace, project_root)
            audio_node_model = compile_workspace_to_audio_node_model(resolved_ws)
            ws_extra = (resolved_ws.get("graph") or {}).get("extra") or {}
            bpm = float((ws_extra.get("global_parameters") or {}).get("bpm", 120.0))
            resolved_graph = base_graph
        else:
            resolved_graph = apply_snapshot(base_graph, snapshot, transient_overrides)
            for node in resolved_graph.get("nodes", []):
                props = node.get("properties", {})
                if props.get("filepath"):
                    props["filepath"] = _resolve_relative_filepath(props.get("filepath"), project_root)
                for slot in props.get("slots") or []:
                    if isinstance(slot, dict) and slot.get("filepath"):
                        slot["filepath"] = _resolve_relative_filepath(slot.get("filepath"), project_root)
            audio_node_model = compile_canonical_graph_to_audio_node_model(resolved_graph, root_id=root_id)
            bpm = float(resolved_graph.get("settings", {}).get("bpm", 120.0))

        sys_obj = System(bpm=bpm, sample_rate=eff_sr, render_mode="offline")
        renderer = get_renderer_for_node(audio_node_model.node_type)
        audio_out = renderer.render(audio_node_model, sys_obj)
        output_cfg = resolved_graph.get("settings", {}).get("output", {})
        normalize = bool(output_cfg.get("normalize", False)) if isinstance(output_cfg, dict) else False
        target_peak_db = float(output_cfg.get("target_peak_db", -1.0)) if isinstance(output_cfg, dict) else -1.0

    if audio_out is None or audio_out.size == 0:
        audio_out = np.zeros((2, max(1, eff_sr // 10)), dtype=np.float32)

    if normalize:
        peak_val = float(np.max(np.abs(audio_out)))
        target_lin = 10.0 ** (target_peak_db / 20.0)
        if peak_val > 0.0:
            audio_out = (audio_out * (target_lin / peak_val)).astype(np.float32, copy=False)

    audio_out = np.clip(audio_out, -1.0, 1.0).astype(np.float32, copy=False)
    qa_result = analyze_audio_buffer(audio_out, eff_sr).to_dict()
    return audio_out, eff_sr, qa_result
