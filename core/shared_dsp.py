"""Shared in-process DSP audio engine for SIN and GAIA.

Resolves canonical sin-graph documents, applies snapshot and transient overrides,
compiles via ERMES to AudioNodeModel trees, and renders through core.engines
with deterministic post-processing (normalization, peak limiting) and QA verification.
"""

from __future__ import annotations

import copy
import math
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

from ermes.py.snapshot import apply_snapshot
from ermes.py.compiler import compile_canonical_graph_to_audio_node_model
from core.system import System
from core.engines import get_renderer_for_node
from core.qa import analyze_audio_buffer


def resolve_and_render_graph(
    base_graph: Dict[str, Any],
    snapshot: Optional[Dict[str, Any]] = None,
    transient_overrides: Optional[Dict[str, Any]] = None,
    root_id: Optional[str] = None,
    project_root: Optional[Path] = None,
    sample_rate: int = 44100,
) -> Tuple[np.ndarray, int, Dict[str, Any]]:
    """1. Applies snapshot + transient overrides onto base_graph.
    2. Resolves relative file paths against project_root.
    3. Compiles via ERMES to AudioNodeModel.
    4. Renders via core.engines.
    5. Applies output post-processing: normalization and target peak ceiling.
    6. Returns (audio_buffer, sample_rate, qa_metrics).
    """
    # 1. Apply snapshots and transient overrides
    resolved_graph = apply_snapshot(base_graph, snapshot, transient_overrides)

    # 2. Resolve relative paths
    if project_root:
        root_path = Path(project_root).resolve()
        for node in resolved_graph.get("nodes", []):
            props = node.get("properties", {})
            filepath = props.get("filepath")
            if filepath and not os.path.isabs(filepath):
                cand = (root_path / filepath).resolve()
                if not cand.is_file():
                    # Fallback into files/ folder
                    cand_in_files = (root_path / "files" / Path(filepath).name).resolve()
                    if cand_in_files.is_file():
                        cand = cand_in_files
                props["filepath"] = str(cand)

    # 3. Compile to AudioNodeModel
    audio_node_model = compile_canonical_graph_to_audio_node_model(resolved_graph, root_id=root_id)

    # 4. Render through core engine
    bpm = float(resolved_graph.get("settings", {}).get("bpm", 120.0))
    sys = System(bpm=bpm, sample_rate=sample_rate, render_mode="offline")
    renderer = get_renderer_for_node(audio_node_model.node_type)
    audio_out = renderer.render(audio_node_model, sys)

    if audio_out is None or audio_out.size == 0:
        audio_out = np.zeros((2, max(1, sys.sample_rate // 10)), dtype=np.float32)

    # 5. Output Post-Processing: Normalization & Peak Limiting
    output_cfg = resolved_graph.get("settings", {}).get("output", {})
    if isinstance(output_cfg, dict) and output_cfg.get("normalize", False):
        peak_val = float(np.max(np.abs(audio_out)))
        target_db = float(output_cfg.get("target_peak_db", -1.0))
        target_lin = 10.0 ** (target_db / 20.0)
        if peak_val > 0.0:
            audio_out = audio_out * (target_lin / peak_val)

    # Ceiling guard (prevent digital wrap-around clipping)
    audio_out = np.clip(audio_out, -1.0, 1.0)

    # 6. QA Metrics
    qa_result = analyze_audio_buffer(audio_out, sys.sample_rate).to_dict()

    return audio_out, sys.sample_rate, qa_result
