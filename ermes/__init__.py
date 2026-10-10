"""
ERMES Serialization & Interop Engine
Provides canonical schemas and serialization logic bridging SIN and GAIA.
"""

from .py.schemas import FxModuleModel, AudioNodeModel, PoolResolveRequest
from .py.compiler import (
    compile_any_to_audio_node_model,
    compile_canonical_graph_to_audio_node_model,
    compile_workspace_to_audio_node_model,
    validate_graph,
    collect_graph_warnings,
    graph_to_workspace,
    compute_auto_layout_positions,
)

__all__ = [
    "FxModuleModel",
    "AudioNodeModel",
    "PoolResolveRequest",
    "compile_any_to_audio_node_model",
    "compile_canonical_graph_to_audio_node_model",
    "compile_workspace_to_audio_node_model",
    "validate_graph",
    "collect_graph_warnings",
    "graph_to_workspace",
    "compute_auto_layout_positions",
]
