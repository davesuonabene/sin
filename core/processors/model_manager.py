"""Model registry, cross-OS cache discovery, explicit lazy downloading, and LRU float16 disk cache.

Model lookup priority (read-only probe BEFORE downloading):
  1. `SIN_MODELS_DIR/<model_id>/` (default `<repo>/.gaia/models/<model_id>/`)
  2. `SIN_EXTRA_MODEL_DIRS`
  3. Global Hugging Face cache (`HF_HOME/hub/models--<org>--<repo>/snapshots/*`)
  4. Global PyTorch hub checkpoints (`TORCH_HOME/hub/checkpoints/`)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.request
import numpy as np

from core.env_config import SinEnvConfig, get_env_config

logger = logging.getLogger("sin.processors.model_manager")

MANIFEST_PATH = Path(__file__).with_name("models_manifest.json")


@dataclass(frozen=True)
class ModelFileSpec:
    filename: str
    url: str
    sha256: str = ""


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    node_type: str
    backend_tier: str
    runtime: str
    size_mb: float
    license: str
    description: str
    files: Tuple[ModelFileSpec, ...]
    hf_repos: Tuple[str, ...] = ()
    torch_files: Tuple[str, ...] = ()


@dataclass
class DownloadState:
    model_id: str
    status: str = "idle"  # idle | downloading | ready | cancelled | error
    progress: float = 0.0
    bytes_downloaded: int = 0
    bytes_total: int = 0
    current_file: str = ""
    error: Optional[str] = None
    target_dir: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    worker_thread: Optional[threading.Thread] = field(default=None, repr=False)

    def is_actively_downloading(self) -> bool:
        if self.status != "downloading":
            return False
        if self.worker_thread is not None and not self.worker_thread.is_alive():
            return False
        return True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "status": self.status,
            "progress": round(float(self.progress), 4),
            "bytes_downloaded": int(self.bytes_downloaded),
            "bytes_total": int(self.bytes_total),
            "current_file": self.current_file,
            "error": self.error,
            "target_dir": self.target_dir,
        }


def load_models_manifest(path: Path = MANIFEST_PATH) -> Dict[str, ModelSpec]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: Dict[str, ModelSpec] = {}
    for entry in raw.get("models", []):
        files = tuple(
            ModelFileSpec(
                filename=str(f["filename"]),
                url=str(f["url"]),
                sha256=str(f.get("sha256") or "").strip().lower(),
            )
            for f in (entry.get("files") or [])
        )
        hints = entry.get("global_cache_hints") or {}
        spec = ModelSpec(
            id=str(entry["id"]),
            name=str(entry.get("name") or entry["id"]),
            node_type=str(entry.get("node_type") or ""),
            backend_tier=str(entry.get("backend_tier") or ""),
            runtime=str(entry.get("runtime") or "onnxruntime"),
            size_mb=float(entry.get("size_mb") or 0.0),
            license=str(entry.get("license") or "Unknown"),
            description=str(entry.get("description") or ""),
            files=files,
            hf_repos=tuple(str(r) for r in (hints.get("hf_repos") or [])),
            torch_files=tuple(str(t) for t in (hints.get("torch_files") or [])),
        )
        out[spec.id] = spec
    return out


class ModelManager:
    """Manages local `.gaia/models/` storage, global cache probing, and cancelable downloads."""

    def __init__(
        self,
        cfg: Optional[SinEnvConfig] = None,
        manifest_path: Path = MANIFEST_PATH,
    ) -> None:
        self._cfg_override = cfg
        self._manifest_path = manifest_path
        self._manifest: Dict[str, ModelSpec] = load_models_manifest(manifest_path)
        self._lock = threading.RLock()
        self._downloads: Dict[str, DownloadState] = {}

    @property
    def cfg(self) -> SinEnvConfig:
        return self._cfg_override or get_env_config()

    def get_spec(self, model_id: str) -> Optional[ModelSpec]:
        return self._manifest.get(str(model_id))

    def list_specs(self, node_type: Optional[str] = None) -> List[ModelSpec]:
        specs = list(self._manifest.values())
        if node_type:
            nt = str(node_type).strip().lower()
            specs = [s for s in specs if s.node_type == nt]
        return specs

    def target_dir(self, model_id: str) -> Path:
        return (self.cfg.models_dir / str(model_id)).resolve()

    def _find_in_directory(self, base_dir: Path, spec: ModelSpec) -> Optional[Dict[str, Path]]:
        if not base_dir.is_dir():
            return None
        resolved: Dict[str, Path] = {}
        for fspec in spec.files:
            direct = base_dir / fspec.filename
            if direct.is_file() and direct.stat().st_size > 0:
                resolved[fspec.filename] = direct.resolve()
                continue
            return None
        return resolved if resolved else None

    def _probe_hf_cache(self, spec: ModelSpec) -> Optional[Tuple[Path, Dict[str, Path]]]:
        hub_dir = self.cfg.hf_home / "hub"
        if not hub_dir.is_dir() or not spec.hf_repos:
            return None
        for repo in spec.hf_repos:
            slug = "models--" + repo.replace("/", "--")
            repo_dir = hub_dir / slug
            if not repo_dir.is_dir():
                continue
            snapshots_dir = repo_dir / "snapshots"
            if snapshots_dir.is_dir():
                for snap in sorted(snapshots_dir.iterdir(), reverse=True):
                    if not snap.is_dir():
                        continue
                    found = self._find_in_directory(snap, spec)
                    if found is not None:
                        return snap.resolve(), found
                # Even if filename differs (e.g. HF repo has weights under a different name),
                # report a non-empty snapshot directory for multi-file repos like HTDemucs.
                for snap in sorted(snapshots_dir.iterdir(), reverse=True):
                    if snap.is_dir() and any(snap.iterdir()):
                        return snap.resolve(), {}
        return None

    def _probe_torch_cache(self, spec: ModelSpec) -> Optional[Tuple[Path, Dict[str, Path]]]:
        ckpt_dir = self.cfg.torch_home / "hub" / "checkpoints"
        if not ckpt_dir.is_dir():
            return None
        found = self._find_in_directory(ckpt_dir, spec)
        if found is not None:
            return ckpt_dir.resolve(), found
        for hint_name in spec.torch_files:
            cand = ckpt_dir / hint_name
            if cand.is_file() and cand.stat().st_size > 0:
                return ckpt_dir.resolve(), {hint_name: cand.resolve()}
        return None

    def resolve_model(self, model_id: str) -> Dict[str, Any]:
        """Resolve a model across local `.gaia/models/`, extra dirs, and global ML caches."""
        spec = self.get_spec(model_id)
        if spec is None:
            return {"installed": False, "error": f"Unknown model '{model_id}'"}

        # 1. SIN_MODELS_DIR/<id>/
        local_dir = self.target_dir(model_id)
        local_files = self._find_in_directory(local_dir, spec)
        if local_files is not None:
            return {
                "installed": True,
                "source": "sin_models_dir",
                "location": str(local_dir),
                "files": {k: str(v) for k, v in local_files.items()},
            }

        # 2. SIN_EXTRA_MODEL_DIRS
        for extra_root in self.cfg.extra_model_dirs:
            for candidate_dir in (extra_root / model_id, extra_root):
                extra_files = self._find_in_directory(candidate_dir, spec)
                if extra_files is not None:
                    return {
                        "installed": True,
                        "source": "extra_model_dir",
                        "location": str(candidate_dir.resolve()),
                        "files": {k: str(v) for k, v in extra_files.items()},
                    }

        # 3 & 4. Global HF_HOME and TORCH_HOME caches
        if self.cfg.prefer_global_models:
            hf_hit = self._probe_hf_cache(spec)
            if hf_hit is not None:
                snap_dir, hf_files = hf_hit
                return {
                    "installed": True,
                    "source": "global_hf_cache",
                    "location": str(snap_dir),
                    "files": {k: str(v) for k, v in hf_files.items()},
                }
            torch_hit = self._probe_torch_cache(spec)
            if torch_hit is not None:
                ckpt_dir, torch_files = torch_hit
                return {
                    "installed": True,
                    "source": "global_torch_cache",
                    "location": str(ckpt_dir),
                    "files": {k: str(v) for k, v in torch_files.items()},
                }

        return {
            "installed": False,
            "source": None,
            "location": str(local_dir),
            "files": {},
        }

    def get_model_status(self, model_id: str) -> Dict[str, Any]:
        spec = self.get_spec(model_id)
        if spec is None:
            return {"id": model_id, "known": False, "installed": False}
        res = self.resolve_model(model_id)
        with self._lock:
            dl = self._downloads.get(model_id)
            if dl is not None and dl.status == "downloading" and not dl.is_actively_downloading():
                # Self-heal stale downloading state if a background worker died unexpectedly
                dl.status = "error"
                dl.error = dl.error or "Download worker stopped unexpectedly; retry download."
            dl_dict = dl.to_dict() if dl is not None else {
                "model_id": model_id,
                "status": "ready" if res["installed"] else "idle",
                "progress": 1.0 if res["installed"] else 0.0,
                "bytes_downloaded": 0,
                "bytes_total": 0,
                "current_file": "",
                "error": None,
                "target_dir": str(self.target_dir(model_id)),
            }
        return {
            "id": spec.id,
            "name": spec.name,
            "node_type": spec.node_type,
            "backend_tier": spec.backend_tier,
            "runtime": spec.runtime,
            "size_mb": spec.size_mb,
            "license": spec.license,
            "description": spec.description,
            "installed": bool(res["installed"]),
            "source": res.get("source"),
            "location": res.get("location"),
            "target_dir": str(self.target_dir(model_id)),
            "files": res.get("files") or {},
            "download": dl_dict,
        }

    def list_models_status(self, node_type: Optional[str] = None) -> List[Dict[str, Any]]:
        return [self.get_model_status(s.id) for s in self.list_specs(node_type=node_type)]

    def _update_installed_index(self, spec: ModelSpec, dest_dir: Path) -> None:
        index_path = self.cfg.models_dir / "installed.json"
        index_path.parent.mkdir(parents=True, exist_ok=True)
        existing: Dict[str, Any] = {"schema": "gaia-installed-models-v1", "models": {}}
        if index_path.is_file():
            try:
                loaded = json.loads(index_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and isinstance(loaded.get("models"), dict):
                    existing = loaded
            except Exception:
                pass
        existing["models"][spec.id] = {
            "id": spec.id,
            "name": spec.name,
            "node_type": spec.node_type,
            "license": spec.license,
            "path": str(dest_dir.resolve()),
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "files": [f.filename for f in spec.files],
        }
        tmp = index_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        os.replace(tmp, index_path)

    def _execute_download(
        self,
        spec: ModelSpec,
        state: DownloadState,
        dest_dir: Path,
        *,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        urlopen_fn: Optional[Callable[..., Any]] = None,
    ) -> Dict[str, Any]:
        """Run the actual HTTP download loop for an owned `DownloadState`."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        opener = urlopen_fn or urllib.request.urlopen
        part_paths: List[Path] = []
        total_files = max(1, len(spec.files))
        last_emit_ts = 0.0
        last_emit_prog = -1.0

        def _emit(force: bool = False) -> None:
            nonlocal last_emit_ts, last_emit_prog
            if not on_progress:
                return
            now = time.monotonic()
            if force or (now - last_emit_ts) >= 0.12 or abs(state.progress - last_emit_prog) >= 0.02:
                last_emit_ts = now
                last_emit_prog = state.progress
                try:
                    on_progress(state.to_dict())
                except Exception as cb_exc:
                    logger.debug("Download progress callback failed for %s: %s", spec.id, cb_exc)

        try:
            if self.cfg.offline_mode and urlopen_fn is None:
                raise RuntimeError(
                    "SIN_OFFLINE_MODE=1 is enabled. Disable SIN_OFFLINE_MODE or place model weights in "
                    f"{dest_dir} manually."
                )

            _emit(force=True)
            for file_idx, fspec in enumerate(spec.files):
                if state.cancel_event.is_set():
                    raise InterruptedError("Download cancelled by user")

                final_path = dest_dir / fspec.filename
                if final_path.is_file() and final_path.stat().st_size > 0:
                    if not fspec.sha256 or _sha256_file(final_path) == fspec.sha256:
                        state.progress = float(file_idx + 1) / float(total_files)
                        _emit(force=True)
                        continue

                part_path = dest_dir / f"{fspec.filename}.part"
                part_paths.append(part_path)
                state.current_file = fspec.filename
                state.bytes_downloaded = 0
                state.bytes_total = 0
                _emit(force=True)
                hasher = hashlib.sha256()

                req = urllib.request.Request(fspec.url, headers={"User-Agent": "SIN-GAIA-ModelManager/1.0"})
                with opener(req, timeout=30) as resp:
                    cl_header = resp.headers.get("Content-Length") if getattr(resp, "headers", None) else None
                    file_total = int(cl_header) if cl_header and str(cl_header).isdigit() else 0
                    state.bytes_total = file_total
                    file_done = 0

                    with open(part_path, "wb") as out_f:
                        while True:
                            if state.cancel_event.is_set():
                                raise InterruptedError("Download cancelled by user")
                            chunk = resp.read(262144)
                            if not chunk:
                                break
                            out_f.write(chunk)
                            hasher.update(chunk)
                            file_done += len(chunk)
                            state.bytes_downloaded = file_done
                            file_frac = (file_done / float(file_total)) if file_total > 0 else 0.5
                            state.progress = min(0.999, (file_idx + file_frac) / float(total_files))
                            _emit(force=False)

                if fspec.sha256:
                    digest = hasher.hexdigest().lower()
                    if digest != fspec.sha256:
                        raise ValueError(
                            f"SHA-256 mismatch for {fspec.filename}: expected {fspec.sha256}, got {digest}"
                        )

                os.replace(part_path, final_path)
                state.progress = min(0.999, float(file_idx + 1) / float(total_files))
                _emit(force=True)

            meta_path = dest_dir / "metadata.json"
            meta_path.write_text(
                json.dumps(
                    {
                        "id": spec.id,
                        "name": spec.name,
                        "node_type": spec.node_type,
                        "license": spec.license,
                        "downloaded_at": datetime.now(timezone.utc).isoformat(),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            self._update_installed_index(spec, dest_dir)
            state.status = "ready"
            state.progress = 1.0
            state.current_file = ""
            state.error = None
            _emit(force=True)
            logger.info("Downloaded model '%s' into %s", spec.id, dest_dir)
            return state.to_dict()

        except InterruptedError:
            _cleanup_parts(part_paths)
            state.status = "cancelled"
            state.error = None
            state.progress = 0.0
            state.current_file = ""
            _emit(force=True)
            logger.info("Cancelled download for model '%s'", spec.id)
            return state.to_dict()

        except Exception as exc:
            _cleanup_parts(part_paths)
            state.status = "error"
            state.error = str(exc)
            state.current_file = ""
            _emit(force=True)
            logger.warning("Download failed for model '%s': %s", spec.id, exc)
            return state.to_dict()

    def download_model_sync(
        self,
        model_id: str,
        *,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        urlopen_fn: Optional[Callable[..., Any]] = None,
    ) -> Dict[str, Any]:
        """Download a model lazily into `.gaia/models/<model_id>/` with SHA-256 check & atomic swap."""
        spec = self.get_spec(model_id)
        if spec is None:
            raise ValueError(f"Unknown model '{model_id}'")

        dest_dir = self.target_dir(model_id)
        with self._lock:
            existing = self._downloads.get(model_id)
            if existing is not None and existing.is_actively_downloading():
                return existing.to_dict()
            state = DownloadState(
                model_id=model_id,
                status="downloading",
                target_dir=str(dest_dir),
                worker_thread=threading.current_thread(),
            )
            self._downloads[model_id] = state

        return self._execute_download(
            spec,
            state,
            dest_dir,
            on_progress=on_progress,
            urlopen_fn=urlopen_fn,
        )

    def start_download_async(
        self,
        model_id: str,
        *,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        urlopen_fn: Optional[Callable[..., Any]] = None,
    ) -> Dict[str, Any]:
        spec = self.get_spec(model_id)
        if spec is None:
            raise ValueError(f"Unknown model '{model_id}'")
        dest_dir = self.target_dir(model_id)
        with self._lock:
            existing = self._downloads.get(model_id)
            if existing is not None and existing.is_actively_downloading():
                return existing.to_dict()
            state = DownloadState(
                model_id=model_id,
                status="downloading",
                target_dir=str(dest_dir),
            )

            def _worker() -> None:
                self._execute_download(
                    spec,
                    state,
                    dest_dir,
                    on_progress=on_progress,
                    urlopen_fn=urlopen_fn,
                )

            t = threading.Thread(target=_worker, name=f"sin-model-dl-{model_id}", daemon=True)
            state.worker_thread = t
            self._downloads[model_id] = state
            t.start()
            return state.to_dict()

    def cancel_download(self, model_id: str) -> Dict[str, Any]:
        with self._lock:
            state = self._downloads.get(model_id)
            if state is None:
                return {"model_id": model_id, "status": "idle", "cancelled": False}
            state.cancel_event.set()
            if not state.is_actively_downloading():
                state.status = "cancelled"
                state.progress = 0.0
                state.error = None
                dest_dir = self.target_dir(model_id)
                if dest_dir.is_dir():
                    _cleanup_parts(list(dest_dir.glob("*.part")))
                return {"model_id": model_id, "status": "cancelled", "cancelled": True}
            return {"model_id": model_id, "status": "cancelling", "cancelled": True}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(262144), b""):
            h.update(chunk)
    return h.hexdigest().lower()


def _cleanup_parts(paths: List[Path]) -> None:
    for p in paths:
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass


class DiskStemCache:
    """Ephemeral float16 NPZ disk cache in `.runtime/dsp_cache/` with LRU size eviction."""

    def __init__(self, cache_dir: Optional[Path] = None, max_bytes: Optional[int] = None) -> None:
        self._dir_override = cache_dir
        self._max_bytes_override = max_bytes
        self._lock = threading.RLock()

    @property
    def cache_dir(self) -> Path:
        return self._dir_override if self._dir_override is not None else get_env_config().dsp_cache_dir

    @property
    def max_bytes(self) -> int:
        if self._max_bytes_override is not None:
            return int(self._max_bytes_override)
        return int(get_env_config().dsp_cache_max_gb * (1024 ** 3))

    def _entry_path(self, namespace: str, fingerprint: str) -> Path:
        safe_ns = "".join(c for c in namespace if c.isalnum() or c in ("_", "-")) or "default"
        safe_fp = "".join(c for c in fingerprint if c.isalnum() or c in ("_", "-"))[:40]
        return self.cache_dir / safe_ns / f"{safe_fp}.npz"

    def get(self, namespace: str, fingerprint: str) -> Optional[Dict[str, np.ndarray]]:
        path = self._entry_path(namespace, fingerprint)
        with self._lock:
            if not path.is_file():
                return None
            try:
                now = time.time()
                os.utime(path, (now, now))
                with np.load(path, allow_pickle=False) as data:
                    return {k: np.asarray(data[k], dtype=np.float32) for k in data.files}
            except Exception as exc:
                logger.warning("Corrupt disk cache entry %s removed: %s", path, exc)
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
                return None

    def put(self, namespace: str, fingerprint: str, arrays: Dict[str, np.ndarray]) -> Path:
        path = self._entry_path(namespace, fingerprint)
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = path.with_suffix(".tmp.npz")
            packed = {k: np.asarray(v, dtype=np.float16) for k, v in arrays.items()}
            np.savez(tmp_path, **packed)
            os.replace(tmp_path, path)
            self._evict_if_needed()
            return path

    def _evict_if_needed(self) -> None:
        root = self.cache_dir
        if not root.is_dir():
            return
        entries: List[Tuple[float, int, Path]] = []
        total = 0
        for p in root.rglob("*.npz"):
            try:
                st = p.stat()
                entries.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            except OSError:
                continue
        limit = max(1024, self.max_bytes)
        if total <= limit:
            return
        entries.sort(key=lambda item: item[0])  # oldest mtime first
        for _mtime, sz, p in entries:
            if total <= limit:
                break
            try:
                p.unlink(missing_ok=True)
                total -= sz
            except OSError:
                continue


GLOBAL_MODEL_MANAGER = ModelManager()
GLOBAL_DISK_STEM_CACHE = DiskStemCache()
