"""Cross-OS `.env` loader and typed environment configuration for SIN & GAIA DSP processors.

Uses Python's standard library only (zero extra dependencies). OS environment variables
always take precedence over `.env` values so shell/CI overrides work identically on
Windows, macOS, and Linux.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import threading
from typing import Dict, Optional, Tuple


PROJECT_ROOT = Path(__file__).resolve().parent.parent

_ENV_LOCK = threading.RLock()
_ENV_LOADED = False
_LOADED_ENV_PATH: Optional[Path] = None


def _strip_inline_comment(raw: str) -> str:
    """Strip unquoted `# ...` comments from a `.env` value."""
    in_single = False
    in_double = False
    escaped = False
    out: list[str] = []
    for ch in raw:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\" and in_double:
            out.append(ch)
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            out.append(ch)
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            out.append(ch)
            continue
        if ch == "#" and not in_single and not in_double:
            break
        out.append(ch)
    return "".join(out).strip()


def parse_dotenv_text(text: str) -> Dict[str, str]:
    """Parse standard `.env` syntax into a key -> value dict."""
    parsed: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export ") and len(line) > 7:
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, raw_val = line.split("=", 1)
        key = key.strip()
        if not key or any(c.isspace() for c in key):
            continue
        val = _strip_inline_comment(raw_val.strip())
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            quote = val[0]
            val = val[1:-1]
            if quote == '"':
                val = (
                    val.replace('\\"', '"')
                    .replace("\\n", "\n")
                    .replace("\\r", "\r")
                    .replace("\\t", "\t")
                    .replace("\\\\", "\\")
                )
        parsed[key] = val
    return parsed


def load_sin_env(
    env_path: Optional[Path | str] = None,
    *,
    force: bool = False,
    override: bool = False,
) -> Dict[str, str]:
    """Load `.env` from `env_path` (default `<repo>/.env`) idempotently.

    By default (`override=False`), existing OS environment variables always take precedence.
    """
    global _ENV_LOADED, _LOADED_ENV_PATH
    target = Path(env_path).resolve() if env_path is not None else (PROJECT_ROOT / ".env")
    with _ENV_LOCK:
        if _ENV_LOADED and not force and _LOADED_ENV_PATH == target:
            return {}
        loaded: Dict[str, str] = {}
        if target.is_file():
            try:
                text = target.read_text(encoding="utf-8")
                parsed = parse_dotenv_text(text)
                for k, v in parsed.items():
                    if override or k not in os.environ:
                        os.environ[k] = v
                        loaded[k] = v
            except OSError:
                pass
        _ENV_LOADED = True
        _LOADED_ENV_PATH = target
        return loaded


def _resolve_path(raw: Optional[str], default_rel: str, root: Path = PROJECT_ROOT) -> Path:
    val = (raw or "").strip()
    if not val:
        return (root / default_rel).resolve()
    expanded = Path(os.path.expandvars(val)).expanduser()
    if expanded.is_absolute():
        return expanded.resolve()
    return (root / expanded).resolve()


def _parse_extra_dirs(raw: Optional[str], root: Path = PROJECT_ROOT) -> Tuple[Path, ...]:
    val = (raw or "").strip()
    if not val:
        return ()
    # Split on platform pathsep (`;` on Win, `:` on POSIX) and commas, preserving Windows drive letters (`C:\...`)
    if os.pathsep == ";":
        chunks = [c for seg in val.split(";") for c in seg.split(",")]
    else:
        chunks = [c for seg in val.split(":") for c in seg.split(",")]
    resolved: list[Path] = []
    seen: set[str] = set()
    for chunk in chunks:
        c = chunk.strip()
        if not c:
            continue
        p = Path(os.path.expandvars(c)).expanduser()
        if not p.is_absolute():
            p = root / p
        rp = p.resolve()
        key = str(rp).casefold()
        if key not in seen:
            seen.add(key)
            resolved.append(rp)
    return tuple(resolved)


def _parse_bool(raw: Optional[str], default: bool = True) -> bool:
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off")


def _parse_float(raw: Optional[str], default: float, min_val: float = 0.0) -> float:
    if raw is None or not str(raw).strip():
        return default
    try:
        return max(min_val, float(raw))
    except ValueError:
        return default


def _parse_int(raw: Optional[str], default: int, min_val: int = 0) -> int:
    if raw is None or not str(raw).strip():
        return default
    try:
        return max(min_val, int(float(raw)))
    except ValueError:
        return default


@dataclass(frozen=True)
class SinEnvConfig:
    """Resolved cross-OS DSP processor environment configuration."""

    project_root: Path
    models_dir: Path
    extra_model_dirs: Tuple[Path, ...]
    prefer_global_models: bool
    dsp_cache_dir: Path
    dsp_cache_max_gb: float
    external_python: Optional[str]
    dsp_device: str
    cook_workers: int
    cook_debounce_ms: int
    preview_window_sec: float
    hf_home: Path
    torch_home: Path
    preamp_profiles_dir: Path
    offline_mode: bool = False
    tile_ram_mb: int = 256
    tile_sec: float = 8.0
    default_precook_sec: float = 24.0
    wait_for_fx_default: bool = False

    def to_public_dict(self) -> Dict[str, object]:
        return {
            "models_dir": str(self.models_dir),
            "extra_model_dirs": [str(p) for p in self.extra_model_dirs],
            "prefer_global_models": self.prefer_global_models,
            "dsp_cache_dir": str(self.dsp_cache_dir),
            "dsp_cache_max_gb": self.dsp_cache_max_gb,
            "external_python": self.external_python or "",
            "dsp_device": self.dsp_device,
            "cook_workers": self.cook_workers,
            "cook_debounce_ms": self.cook_debounce_ms,
            "preview_window_sec": self.preview_window_sec,
            "hf_home": str(self.hf_home),
            "torch_home": str(self.torch_home),
            "preamp_profiles_dir": str(self.preamp_profiles_dir),
            "offline_mode": self.offline_mode,
            "tile_ram_mb": self.tile_ram_mb,
            "tile_sec": self.tile_sec,
            "default_precook_sec": self.default_precook_sec,
            "wait_for_fx_default": self.wait_for_fx_default,
        }


def get_env_config(
    *,
    project_root: Optional[Path] = None,
    reload_dotenv: bool = False,
) -> SinEnvConfig:
    """Return resolved `SinEnvConfig` using OS env with `.env` defaults."""
    root = Path(project_root).resolve() if project_root is not None else PROJECT_ROOT
    load_sin_env(root / ".env", force=reload_dotenv)

    models_dir = _resolve_path(os.environ.get("SIN_MODELS_DIR"), ".gaia/models", root)
    extra_model_dirs = _parse_extra_dirs(os.environ.get("SIN_EXTRA_MODEL_DIRS"), root)
    prefer_global = _parse_bool(os.environ.get("SIN_PREFER_GLOBAL_MODELS"), True)
    dsp_cache_dir = _resolve_path(os.environ.get("SIN_DSP_CACHE_DIR"), ".runtime/dsp_cache", root)
    dsp_cache_max_gb = _parse_float(os.environ.get("SIN_DSP_CACHE_MAX_GB"), 4.0, min_val=0.1)

    ext_py_raw = (os.environ.get("SIN_EXTERNAL_PYTHON") or "").strip()
    external_python = str(Path(os.path.expandvars(ext_py_raw)).expanduser()) if ext_py_raw else None

    device_raw = (os.environ.get("SIN_DSP_DEVICE") or "auto").strip().lower()
    dsp_device = device_raw if device_raw in ("auto", "cpu", "mps", "cuda") else "auto"

    cook_workers = _parse_int(os.environ.get("SIN_COOK_WORKERS"), 1, min_val=1)
    cook_debounce_ms = _parse_int(os.environ.get("SIN_COOK_DEBOUNCE_MS"), 500, min_val=0)
    preview_window_sec = _parse_float(os.environ.get("SIN_PREVIEW_WINDOW_SEC"), 12.0, min_val=2.0)

    hf_raw = (os.environ.get("HF_HOME") or "").strip()
    hf_home = Path(os.path.expandvars(hf_raw)).expanduser().resolve() if hf_raw else (Path.home() / ".cache" / "huggingface").resolve()

    torch_raw = (os.environ.get("TORCH_HOME") or "").strip()
    torch_home = Path(os.path.expandvars(torch_raw)).expanduser().resolve() if torch_raw else (Path.home() / ".cache" / "torch").resolve()

    preamp_profiles_dir = _resolve_path(
        os.environ.get("SIN_PREAMP_PROFILES_DIR"),
        ".gaia/profiles/preamp_profiles",
        root,
    )
    offline_mode = _parse_bool(os.environ.get("SIN_OFFLINE_MODE"), False)
    tile_ram_mb = _parse_int(os.environ.get("SIN_TILE_RAM_MB"), 256, min_val=32)
    tile_sec = _parse_float(os.environ.get("SIN_TILE_SEC"), 8.0, min_val=2.0)
    default_precook_sec = _parse_float(os.environ.get("SIN_PRECOOK_WINDOW_SEC"), 24.0, min_val=4.0)
    wait_for_fx_default = _parse_bool(os.environ.get("SIN_WAIT_FOR_FX"), False)

    return SinEnvConfig(
        project_root=root,
        models_dir=models_dir,
        extra_model_dirs=extra_model_dirs,
        prefer_global_models=prefer_global,
        dsp_cache_dir=dsp_cache_dir,
        dsp_cache_max_gb=dsp_cache_max_gb,
        external_python=external_python,
        dsp_device=dsp_device,
        cook_workers=cook_workers,
        cook_debounce_ms=cook_debounce_ms,
        preview_window_sec=preview_window_sec,
        hf_home=hf_home,
        torch_home=torch_home,
        preamp_profiles_dir=preamp_profiles_dir,
        offline_mode=offline_mode,
        tile_ram_mb=tile_ram_mb,
        tile_sec=tile_sec,
        default_precook_sec=default_precook_sec,
        wait_for_fx_default=wait_for_fx_default,
    )
