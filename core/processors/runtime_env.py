"""Cross-OS ML runtime capability discovery and sanitized external-process bridge.

SIN's startup scripts (`start_win.ps1`, `start_mac.sh`) isolate `.venv` by exporting
`PYTHONNOUSERSITE=1` and `VIRTUAL_ENV`. This module probes:
  1. Pure in-venv `numpy`/`scipy` (always available)
  2. In-venv `onnxruntime` (primary multi-OS inference runtime)
  3. Optional in-venv `torch` (generic `mps` / `cuda` / `cpu` selection)
  4. External global Python / CLI installations (e.g., Python 3.11 / `demucs`) invoked via
     a **sanitized child environment** that strips `.venv` isolation vars so global
     packages load reliably across minor Python version boundaries.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import importlib.util
import json
import logging
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import threading
from typing import Any, Dict, List, Optional, Sequence

from core.env_config import SinEnvConfig, get_env_config

logger = logging.getLogger("sin.processors.runtime_env")

_ISOLATION_ENV_VARS = (
    "VIRTUAL_ENV",
    "PYTHONNOUSERSITE",
    "PYTHONHOME",
    "PYTHONPATH",
    "__PYVENV_LAUNCHER__",
)

_CAPS_LOCK = threading.RLock()
_CACHED_CAPS: Optional["RuntimeCapabilities"] = None


def build_external_subprocess_env(
    cfg: Optional[SinEnvConfig] = None,
    extra_env: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    """Build a child process environment safe for invoking global Python/CLI installations.

    Strips `.venv` isolation variables injected by `start_win.ps1` / `start_mac.sh`
    while forwarding shared model cache roots (`HF_HOME`, `TORCH_HOME`).
    """
    resolved_cfg = cfg or get_env_config()
    env = os.environ.copy()
    for var in _ISOLATION_ENV_VARS:
        env.pop(var, None)

    # Remove `.venv/Scripts` or `.venv/bin` prefix from PATH so global CLIs resolve cleanly
    venv_dir = str(Path(sys.prefix).resolve()).casefold()
    raw_path = env.get("PATH") or env.get("Path") or ""
    if raw_path:
        cleaned_segments = []
        for seg in raw_path.split(os.pathsep):
            s = seg.strip()
            if not s:
                continue
            try:
                if str(Path(s).resolve()).casefold().startswith(venv_dir):
                    continue
            except OSError:
                pass
            cleaned_segments.append(s)
        new_path = os.pathsep.join(cleaned_segments)
        env["PATH"] = new_path
        if "Path" in env and "Path" != "PATH":
            env["Path"] = new_path

    env["HF_HOME"] = str(resolved_cfg.hf_home)
    env["TORCH_HOME"] = str(resolved_cfg.torch_home)
    if extra_env:
        env.update(extra_env)
    return env


def _probe_in_venv_module(name: str) -> Optional[str]:
    if importlib.util.find_spec(name) is None:
        return None
    try:
        mod = __import__(name)
        return str(getattr(mod, "__version__", "installed"))
    except Exception:
        return None


def _probe_onnx_providers() -> List[str]:
    if importlib.util.find_spec("onnxruntime") is None:
        return []
    try:
        import onnxruntime as ort  # type: ignore

        return [str(p) for p in ort.get_available_providers()]
    except Exception:
        return []


def _probe_torch_device(preferred: str = "auto") -> Optional[str]:
    if importlib.util.find_spec("torch") is None:
        return None
    try:
        import torch  # type: ignore

        if preferred == "cpu":
            return "cpu"
        if preferred == "mps":
            if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                return "mps"
            return "cpu"
        if preferred == "cuda":
            return "cuda" if torch.cuda.is_available() else "cpu"
        # Generalized multi-OS auto order without vendor-specific hacks
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    except Exception:
        return None


def _discover_external_python(cfg: SinEnvConfig) -> Optional[str]:
    """Find a configured or PATH-visible Python executable outside SIN's `.venv`."""
    current_exe = str(Path(sys.executable).resolve()).casefold()
    current_prefix = str(Path(sys.prefix).resolve()).casefold()

    candidates: List[str] = []
    if cfg.external_python:
        candidates.append(cfg.external_python)

    child_env = build_external_subprocess_env(cfg)
    search_path = child_env.get("PATH") or ""
    for bin_name in ("python3", "python"):
        found = shutil.which(bin_name, path=search_path)
        if found:
            candidates.append(found)

    for cand in candidates:
        try:
            p = Path(cand)
            if not p.is_file():
                continue
            resolved = str(p.resolve())
            if resolved.casefold() == current_exe:
                continue
            if resolved.casefold().startswith(current_prefix):
                continue
            # Ignore Windows Store stub (`WindowsApps\python.exe`) which exits 9009 / opens Store
            if "windowsapps" in resolved.casefold():
                continue
            return resolved
        except OSError:
            continue
    return None


def _probe_external_python_packages(python_exe: str, cfg: SinEnvConfig) -> Dict[str, Any]:
    """Probe an external Python interpreter in a sanitized subprocess using fast metadata lookup."""
    probe_code = "\n".join([
        "import importlib.metadata as md, importlib.util as iu, json, sys",
        "mapping = {",
        "    'torch': 'torch',",
        "    'onnxruntime': 'onnxruntime',",
        "    'demucs': 'demucs',",
        "    'audio_separator': 'audio-separator',",
        "    'df': 'deepfilternet',",
        "    'scipy': 'scipy',",
        "}",
        "pkgs = {}",
        "for mod_name, dist_name in mapping.items():",
        "    try:",
        "        pkgs[mod_name] = md.version(dist_name)",
        "    except Exception:",
        "        if iu.find_spec(mod_name) is not None:",
        "            pkgs[mod_name] = 'installed'",
        "print(json.dumps({'version': sys.version.split()[0], 'packages': pkgs}))",
    ])
    try:
        proc = subprocess.run(
            [python_exe, "-c", probe_code],
            env=build_external_subprocess_env(cfg),
            capture_output=True,
            text=True,
            timeout=6.0,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            data = json.loads(proc.stdout.strip().splitlines()[-1])
            if isinstance(data, dict):
                return data
    except Exception as exc:
        logger.debug("External Python probe failed for %s: %s", python_exe, exc)
    return {}


@dataclass
class RuntimeCapabilities:
    os_name: str
    python_version: str
    numpy_version: Optional[str]
    scipy_version: Optional[str]
    onnxruntime_version: Optional[str]
    onnx_providers: List[str] = field(default_factory=list)
    torch_version: Optional[str] = None
    torch_device: Optional[str] = None
    external_python: Optional[str] = None
    external_python_version: Optional[str] = None
    external_packages: Dict[str, str] = field(default_factory=dict)
    global_clis: Dict[str, str] = field(default_factory=dict)

    def has_onnx(self) -> bool:
        return bool(self.onnxruntime_version) or ("onnxruntime" in self.external_packages)

    def has_torch(self) -> bool:
        return bool(self.torch_version) or ("torch" in self.external_packages)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "os": self.os_name,
            "python_version": self.python_version,
            "in_venv": {
                "numpy": self.numpy_version,
                "scipy": self.scipy_version,
                "onnxruntime": self.onnxruntime_version,
                "onnx_providers": list(self.onnx_providers),
                "torch": self.torch_version,
                "torch_device": self.torch_device,
            },
            "external": {
                "python": self.external_python,
                "python_version": self.external_python_version,
                "packages": dict(self.external_packages),
                "global_clis": dict(self.global_clis),
            },
        }


def detect_runtime_capabilities(
    *,
    cfg: Optional[SinEnvConfig] = None,
    refresh: bool = False,
    probe_external: bool = True,
) -> RuntimeCapabilities:
    """Detect installed in-venv and global runtimes safely across Windows/macOS/Linux."""
    global _CACHED_CAPS
    with _CAPS_LOCK:
        if _CACHED_CAPS is not None and not refresh:
            return _CACHED_CAPS

        resolved_cfg = cfg or get_env_config()
        np_ver = _probe_in_venv_module("numpy")
        sp_ver = _probe_in_venv_module("scipy")
        ort_ver = _probe_in_venv_module("onnxruntime")
        ort_providers = _probe_onnx_providers() if ort_ver else []
        torch_ver = _probe_in_venv_module("torch")
        torch_dev = _probe_torch_device(resolved_cfg.dsp_device) if torch_ver else None

        ext_py: Optional[str] = None
        ext_ver: Optional[str] = None
        ext_pkgs: Dict[str, str] = {}
        global_clis: Dict[str, str] = {}

        if probe_external:
            child_env = build_external_subprocess_env(resolved_cfg)
            search_path = child_env.get("PATH") or ""
            for cli_name in ("demucs", "audio-separator"):
                found = shutil.which(cli_name, path=search_path)
                if found:
                    global_clis[cli_name] = str(Path(found).resolve())

            ext_py = _discover_external_python(resolved_cfg)
            if ext_py:
                info = _probe_external_python_packages(ext_py, resolved_cfg)
                ext_ver = info.get("version")
                raw_pkgs = info.get("packages")
                if isinstance(raw_pkgs, dict):
                    ext_pkgs = {str(k): str(v) for k, v in raw_pkgs.items()}

        caps = RuntimeCapabilities(
            os_name=platform.system(),
            python_version=platform.python_version(),
            numpy_version=np_ver,
            scipy_version=sp_ver,
            onnxruntime_version=ort_ver,
            onnx_providers=ort_providers,
            torch_version=torch_ver,
            torch_device=torch_dev,
            external_python=ext_py,
            external_python_version=ext_ver,
            external_packages=ext_pkgs,
            global_clis=global_clis,
        )
        _CACHED_CAPS = caps
        return caps


def select_onnx_providers(cfg: Optional[SinEnvConfig] = None) -> List[str]:
    """Return generalized cross-OS ONNX Runtime execution provider order."""
    resolved_cfg = cfg or get_env_config()
    available = _probe_onnx_providers()
    if not available:
        return ["CPUExecutionProvider"]
    if resolved_cfg.dsp_device == "cpu":
        return ["CPUExecutionProvider"]

    preferred_order = [
        "CoreMLExecutionProvider",
        "DmlExecutionProvider",
        "CUDAExecutionProvider",
        "CPUExecutionProvider",
    ]
    if resolved_cfg.dsp_device == "cuda":
        preferred_order = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    elif resolved_cfg.dsp_device == "mps":
        preferred_order = ["CoreMLExecutionProvider", "CPUExecutionProvider"]

    selected = [p for p in preferred_order if p in available]
    if "CPUExecutionProvider" not in selected and "CPUExecutionProvider" in available:
        selected.append("CPUExecutionProvider")
    return selected or ["CPUExecutionProvider"]


def run_external_python_worker(
    code_or_script: str,
    args: Sequence[str],
    *,
    is_file: bool = False,
    cfg: Optional[SinEnvConfig] = None,
    timeout_sec: float = 300.0,
    cancel_event: Optional[threading.Event] = None,
) -> subprocess.CompletedProcess[str]:
    """Execute a Python worker inside the discovered global interpreter with sanitized env."""
    resolved_cfg = cfg or get_env_config()
    caps = detect_runtime_capabilities(cfg=resolved_cfg)
    if not caps.external_python:
        raise RuntimeError(
            "No external Python interpreter found. Configure SIN_EXTERNAL_PYTHON in .env or install runtime in .venv."
        )
    cmd = [caps.external_python, code_or_script, *args] if is_file else [caps.external_python, "-c", code_or_script, *args]
    proc = subprocess.Popen(
        cmd,
        env=build_external_subprocess_env(resolved_cfg),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=3.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                raise InterruptedError("External worker cancelled")
            try:
                stdout, stderr = proc.communicate(timeout=0.2)
                return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                timeout_sec -= 0.2
                if timeout_sec <= 0.0:
                    proc.kill()
                    raise TimeoutError("External Python worker timed out")
    finally:
        if proc.poll() is None:
            proc.kill()
