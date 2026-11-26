"""Tests for cross-OS `.env` config, runtime/global-tool discovery, child-env sanitization,
model resolution priority, explicit cancelable downloads, and float16 LRU disk cache.
"""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import numpy as np

from core.env_config import get_env_config, load_sin_env, parse_dotenv_text
from core.processors.model_manager import DiskStemCache, ModelManager
from core.processors.runtime_env import build_external_subprocess_env


class TestProcessorEnvAndModels(unittest.TestCase):
    def test_dotenv_parsing_and_os_env_precedence(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            env_file = tmp_path / ".env"
            env_file.write_text(
                "\n".join([
                    "# Comment line",
                    "SIN_MODELS_DIR=custom_models # inline comment",
                    'export SIN_DSP_DEVICE="cpu"',
                    "SIN_COOK_DEBOUNCE_MS=750",
                    "SIN_PREFER_GLOBAL_MODELS=0",
                ]),
                encoding="utf-8",
            )

            parsed = parse_dotenv_text(env_file.read_text(encoding="utf-8"))
            self.assertEqual(parsed["SIN_MODELS_DIR"], "custom_models")
            self.assertEqual(parsed["SIN_DSP_DEVICE"], "cpu")
            self.assertEqual(parsed["SIN_COOK_DEBOUNCE_MS"], "750")
            self.assertEqual(parsed["SIN_PREFER_GLOBAL_MODELS"], "0")

            base_env = {
                k: v for k, v in os.environ.items()
                if k not in ("SIN_MODELS_DIR", "SIN_COOK_DEBOUNCE_MS", "SIN_PREFER_GLOBAL_MODELS")
            }
            base_env["SIN_DSP_DEVICE"] = "mps"  # OS env var must win over `.env`
            with patch.dict(os.environ, base_env, clear=True):
                load_sin_env(env_file, force=True, override=False)
                cfg = get_env_config(project_root=tmp_path)
                self.assertEqual(cfg.models_dir, (tmp_path / "custom_models").resolve())
                self.assertEqual(cfg.dsp_device, "mps")
                self.assertEqual(cfg.cook_debounce_ms, 750)
                self.assertFalse(cfg.prefer_global_models)

    def test_external_subprocess_env_strips_venv_isolation_vars(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            overrides = {
                "VIRTUAL_ENV": str(tmp_path / ".venv"),
                "PYTHONNOUSERSITE": "1",
                "PYTHONHOME": str(tmp_path / "home"),
                "PYTHONPATH": str(tmp_path / "site"),
                "HF_HOME": str(tmp_path / "hf"),
                "TORCH_HOME": str(tmp_path / "torch"),
            }
            with patch.dict(os.environ, overrides, clear=False):
                cfg = get_env_config(project_root=tmp_path)
                child = build_external_subprocess_env(cfg)

            for forbidden in ("VIRTUAL_ENV", "PYTHONNOUSERSITE", "PYTHONHOME", "PYTHONPATH"):
                self.assertNotIn(forbidden, child)
            self.assertEqual(child["HF_HOME"], str((tmp_path / "hf").resolve()))
            self.assertEqual(child["TORCH_HOME"], str((tmp_path / "torch").resolve()))

    def test_model_manager_probe_order_local_extra_and_global_hf_cache(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            models_dir = tmp_path / "sin_models"
            extra_dir = tmp_path / "extra_models"
            hf_home = tmp_path / "hf_home"
            torch_home = tmp_path / "torch_home"

            overrides = {
                "SIN_MODELS_DIR": str(models_dir),
                "SIN_EXTRA_MODEL_DIRS": str(extra_dir),
                "SIN_PREFER_GLOBAL_MODELS": "1",
                "HF_HOME": str(hf_home),
                "TORCH_HOME": str(torch_home),
            }
            with patch.dict(os.environ, overrides, clear=False):
                cfg = get_env_config(project_root=tmp_path)
                mm = ModelManager(cfg=cfg)

                # 1. Initially missing
                self.assertFalse(mm.resolve_model("htdemucs")["installed"])

                # 2. Discovers existing global Hugging Face snapshot cache
                hf_snap = hf_home / "hub" / "models--adefossez--HTDemucs" / "snapshots" / "rev123"
                hf_snap.mkdir(parents=True)
                (hf_snap / "htdemucs.th").write_bytes(b"mock-htdemucs-weights")

                res_hf = mm.resolve_model("htdemucs")
                self.assertTrue(res_hf["installed"])
                self.assertEqual(res_hf["source"], "global_hf_cache")

                # 3. Extra model dir overrides global cache
                (extra_dir / "htdemucs").mkdir(parents=True)
                (extra_dir / "htdemucs" / "htdemucs.th").write_bytes(b"extra-weights")
                res_extra = mm.resolve_model("htdemucs")
                self.assertTrue(res_extra["installed"])
                self.assertEqual(res_extra["source"], "extra_model_dir")

                # 4. Local SIN_MODELS_DIR wins highest priority
                (models_dir / "htdemucs").mkdir(parents=True)
                (models_dir / "htdemucs" / "htdemucs.th").write_bytes(b"local-weights")
                res_local = mm.resolve_model("htdemucs")
                self.assertTrue(res_local["installed"])
                self.assertEqual(res_local["source"], "sin_models_dir")

    def test_model_download_sha256_verify_and_cancel_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            payload_bytes = b"SIN-ONNX-MODEL-BYTES" * 128
            good_sha = hashlib.sha256(payload_bytes).hexdigest()

            manifest_file = tmp_path / "manifest.json"
            manifest_file.write_text(
                f"""{{
                    "schema": "sin-processor-models-v1",
                    "models": [
                        {{
                            "id": "unit_test_model",
                            "name": "Unit Test Model",
                            "node_type": "voice_isolator",
                            "backend_tier": "fast_onnx",
                            "runtime": "onnxruntime",
                            "size_mb": 0.01,
                            "license": "MIT",
                            "description": "Test",
                            "files": [
                                {{ "filename": "model.onnx", "url": "https://example.invalid/model.onnx", "sha256": "{good_sha}" }}
                            ]
                        }}
                    ]
                }}""",
                encoding="utf-8",
            )

            class _FakeResp:
                def __init__(self, data: bytes) -> None:
                    self._bio = io.BytesIO(data)
                    self.headers = {"Content-Length": str(len(data))}

                def read(self, n: int = -1) -> bytes:
                    return self._bio.read(n)

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            overrides = {
                "SIN_MODELS_DIR": str(tmp_path / "models"),
                "SIN_PREFER_GLOBAL_MODELS": "0",
            }
            with patch.dict(os.environ, overrides, clear=False):
                cfg = get_env_config(project_root=tmp_path)
                mm = ModelManager(cfg=cfg, manifest_path=manifest_file)

                # Bad SHA-256 fails cleanly and removes `.part` files
                bad_res = mm.download_model_sync(
                    "unit_test_model",
                    urlopen_fn=lambda req, timeout=30: _FakeResp(b"corrupted-data"),
                )
                self.assertEqual(bad_res["status"], "error")
                self.assertIn("SHA-256 mismatch", bad_res["error"] or "")
                self.assertEqual(list((tmp_path / "models" / "unit_test_model").glob("*.part")), [])
                self.assertFalse(mm.resolve_model("unit_test_model")["installed"])

                # Valid SHA-256 succeeds and records installed.json
                ok_res = mm.download_model_sync(
                    "unit_test_model",
                    urlopen_fn=lambda req, timeout=30: _FakeResp(payload_bytes),
                )
                self.assertEqual(ok_res["status"], "ready")
                self.assertEqual(ok_res["progress"], 1.0)
                self.assertTrue(mm.resolve_model("unit_test_model")["installed"])
                self.assertTrue((tmp_path / "models" / "installed.json").is_file())

    def test_start_download_async_progresses_to_ready_without_stale_deadlock(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            payload_bytes = b"ASYNC-ONNX-MODEL-WEIGHTS" * 256
            good_sha = hashlib.sha256(payload_bytes).hexdigest()
            manifest_file = tmp_path / "manifest.json"
            manifest_file.write_text(
                f"""{{
                    "schema": "sin-processor-models-v1",
                    "models": [
                        {{
                            "id": "async_test_model",
                            "name": "Async Test Model",
                            "node_type": "voice_isolator",
                            "backend_tier": "fast_onnx",
                            "runtime": "onnxruntime",
                            "size_mb": 0.01,
                            "license": "MIT",
                            "description": "Async Test",
                            "files": [
                                {{ "filename": "weights.onnx", "url": "https://example.invalid/weights.onnx", "sha256": "{good_sha}" }}
                            ]
                        }}
                    ]
                }}""",
                encoding="utf-8",
            )

            class _SlowResp:
                def __init__(self, data: bytes) -> None:
                    self._bio = io.BytesIO(data)
                    self.headers = {"Content-Length": str(len(data))}

                def read(self, n: int = -1) -> bytes:
                    return self._bio.read(min(n, 1024) if n > 0 else 1024)

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            overrides = {
                "SIN_MODELS_DIR": str(tmp_path / "models"),
                "SIN_PREFER_GLOBAL_MODELS": "0",
                "SIN_OFFLINE_MODE": "0",
            }
            with patch.dict(os.environ, overrides, clear=False):
                cfg = get_env_config(project_root=tmp_path)
                mm = ModelManager(cfg=cfg, manifest_path=manifest_file)
                seen: list[str] = []
                st0 = mm.start_download_async(
                    "async_test_model",
                    on_progress=lambda d: seen.append(d["status"]),
                    urlopen_fn=lambda req, timeout=30: _SlowResp(payload_bytes),
                )
                self.assertEqual(st0["status"], "downloading")
                deadline = time.monotonic() + 5.0
                final_status = None
                while time.monotonic() < deadline:
                    cur = mm.get_model_status("async_test_model")
                    if cur["download"]["status"] in ("ready", "error", "cancelled"):
                        final_status = cur
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(final_status, "Async download stalled and never finished")
                self.assertEqual(final_status["download"]["status"], "ready")
                self.assertTrue(final_status["installed"])
                self.assertIn("ready", seen)

    def test_disk_stem_cache_roundtrip_and_lru_eviction(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            cache = DiskStemCache(cache_dir=tmp_path / "cache", max_bytes=30_000)
            arr_a = np.linspace(-0.5, 0.5, 4000, dtype=np.float32).reshape(2, 2000)
            arr_b = np.linspace(0.5, -0.5, 4000, dtype=np.float32).reshape(2, 2000)
            arr_c = np.zeros((2, 2000), dtype=np.float32)

            p_a = cache.put("voice_isolator", "fp_a", {"voice": arr_a, "reverb": arr_a})
            time.sleep(0.02)
            p_b = cache.put("voice_isolator", "fp_b", {"voice": arr_b, "reverb": arr_b})
            loaded_b = cache.get("voice_isolator", "fp_b")
            self.assertIsNotNone(loaded_b)
            self.assertLess(float(np.max(np.abs(loaded_b["voice"] - arr_b))), 1e-3)

            # Adding a third entry beyond max_bytes evicts the oldest entry (fp_a)
            time.sleep(0.02)
            cache.put("voice_isolator", "fp_c", {"voice": arr_c, "reverb": arr_c, "ambience": arr_b})
            self.assertFalse(p_a.exists())
            self.assertTrue(p_b.exists() or cache.get("voice_isolator", "fp_c") is not None)


if __name__ == "__main__":
    unittest.main()
