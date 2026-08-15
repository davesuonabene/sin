"""
ERMES Serialization & Interop Engine
Provides canonical schemas and serialization logic bridging IRIDE and GAIA.
"""

from .py.schemas import FxModuleModel, AudioNodeModel, PoolResolveRequest

__all__ = ["FxModuleModel", "AudioNodeModel", "PoolResolveRequest"]
