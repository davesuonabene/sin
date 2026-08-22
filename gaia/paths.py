"""Filesystem locations owned by the GAIA library manager.

The managed asset store is deliberately separate from GAIA configuration.
Profiles are configuration bundles, while each vault owns a directory inside
the asset store.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import collection_importer


def asset_store() -> Path:
    """Return GAIA's managed asset-store root."""
    return Path(collection_importer.ASSET_STORE).resolve()


def gaia_home() -> Path:
    """Return the non-asset configuration root for the current GAIA store."""
    configured = os.environ.get("GAIA_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    return asset_store().parent / ".gaia"


def profiles_directory() -> Path:
    return gaia_home() / "profiles"


def vaults_directory() -> Path:
    return asset_store() / "vaults"


def import_logs_directory() -> Path:
    """Return GAIA's durable per-import diagnostic log directory."""
    return Path(__file__).resolve().parent / "log" / "imports"
