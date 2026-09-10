"""Filesystem locations owned by the GAIA library manager.

The managed asset store is deliberately separate from GAIA configuration.
Profiles are configuration bundles, while each vault owns a directory inside
the asset store.
"""

from __future__ import annotations

import os
from pathlib import Path

import shutil
import stat

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


def safe_unlink(path: Path | str) -> None:
    """Remove a file, clearing read-only attributes on Windows if necessary."""
    p = Path(path)
    if not p.exists() and not p.is_symlink():
        return
    try:
        p.unlink(missing_ok=True)
    except PermissionError:
        try:
            os.chmod(p, stat.S_IWRITE | stat.S_IREAD)
            p.unlink(missing_ok=True)
        except OSError:
            pass
    except OSError:
        pass


def safe_rmtree(path: Path | str) -> None:
    """Recursively remove a directory, clearing read-only attributes on Windows."""
    p = Path(path)
    if not p.exists():
        return

    def _on_error(func, subpath, exc_info):
        try:
            os.chmod(subpath, stat.S_IWRITE | stat.S_IREAD)
            func(subpath)
        except OSError:
            pass

    try:
        shutil.rmtree(p, onexc=lambda action, sp, exc: _on_error(action, sp, exc))
    except TypeError:
        shutil.rmtree(p, onerror=_on_error)

