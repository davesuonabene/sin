"""Tests for the SIN command-line interface."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typer.testing import CliRunner
from cli import app

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRESETS_DIR = PROJECT_ROOT / "presets" / "drums"
ALL_PRESETS = [
    PRESETS_DIR / "drum_lab_trap_bounce.json",
    PRESETS_DIR / "drum_lab_dilla_lofi.json",
    PRESETS_DIR / "drum_lab_boom_bap_turnaround.json",
    PRESETS_DIR / "drum_lab_memphis_phonk.json",
    PRESETS_DIR / "drum_lab_west_coast_gfunk.json",
]


class TestSinCli(unittest.TestCase):
    """Test suite for SIN CLI commands, validation, interop, and headless rendering."""

    def setUp(self):
        self.runner = CliRunner()

    def test_cli_and_subcommands_help(self):
        """Consolidated test verifying root and all subcommands render help without errors."""
        invocations = [
            ([], ["serve", "render", "compose", "library"]),
            (["serve", "--help"], ["--host", "--port"]),
            (["render", "--help"], ["--out", "--dry-run", "--qa", "--stems", "--isolate"]),
            (["compose", "--help"], ["validate", "info", "compile", "convert"]),
            (["library", "--help"], ["search", "verify"]),
        ]
        for args, expected_tokens in invocations:
            result = self.runner.invoke(app, args if args else ["--help"])
            self.assertEqual(result.exit_code, 0, f"Help failed for args: {args}")
            for token in expected_tokens:
                self.assertIn(token, result.stdout)

    def test_compose_validate_presets(self):
        """All canonical presets must validate without topological or syntax errors."""
        for preset_path in ALL_PRESETS:
            self.assertTrue(preset_path.is_file(), f"Preset missing: {preset_path}")
            result = self.runner.invoke(app, ["compose", "validate", str(preset_path), "--json"])
            self.assertEqual(result.exit_code, 0, f"Validation failed on {preset_path}: {result.stdout}")
            payload = json.loads(result.stdout)
            self.assertTrue(payload.get("valid"))
            self.assertEqual(payload.get("errors"), [])

    def test_compose_validate_warnings_and_strict(self):
        """Unused audio-node properties emit non-fatal warnings by default, fatal in strict mode."""
        dummy_graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120, "total_bars": 4, "key": "C"},
            "output": "master",
            "nodes": [
                {
                    "id": "master",
                    "type": "track",
                    "properties": {
                        "node_name": "Master",
                        "unsupported_random_field": 42,
                        "chain": [{"type": "unknown_fx_filter_type", "enabled": True}],
                    },
                }
            ],
            "connections": [],
            "attachments": [],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(dummy_graph, tf)
            tf_path = Path(tf.name)

        try:
            # Non-strict: valid, but emits warnings in json payload
            result_lenient = self.runner.invoke(app, ["compose", "validate", str(tf_path), "--json"])
            self.assertEqual(result_lenient.exit_code, 0)
            data_lenient = json.loads(result_lenient.stdout)
            self.assertTrue(data_lenient["valid"])
            self.assertGreater(len(data_lenient["warnings"]), 0)

            # Strict: treated as invalid
            result_strict = self.runner.invoke(app, ["compose", "validate", str(tf_path), "--strict", "--json"])
            self.assertEqual(result_strict.exit_code, 1)
            data_strict = json.loads(result_strict.stdout)
            self.assertFalse(data_strict["valid"])
            self.assertTrue(any("Strict mode" in err for err in data_strict["errors"]))
        finally:
            if tf_path.is_file():
                tf_path.unlink()

    def test_compose_info_json(self):
        result = self.runner.invoke(app, ["compose", "info", str(ALL_PRESETS[0]), "--json"])
        self.assertEqual(result.exit_code, 0)
        info = json.loads(result.stdout)
        self.assertEqual(info["format"], "sin-graph")
        self.assertEqual(info["bpm"], 140)
        self.assertEqual(info["total_bars"], 16)
        self.assertEqual(info["key"], "Fm")
        self.assertEqual(info["total_nodes"], 25)

    def test_compose_compile(self):
        result = self.runner.invoke(app, ["compose", "compile", str(ALL_PRESETS[1])])
        self.assertEqual(result.exit_code, 0)
        model_dict = json.loads(result.stdout)
        self.assertEqual(model_dict["node_name"], "Master Output")
        self.assertEqual(model_dict["bpm"], 84.0)
        self.assertGreater(len(model_dict["children"]), 0)

    def test_render_dry_run_json(self):
        result = self.runner.invoke(app, ["render", str(ALL_PRESETS[0]), "--dry-run", "--json"])
        self.assertEqual(result.exit_code, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "success")
        self.assertTrue(payload["dry_run"])
        self.assertEqual(payload["bpm"], 140.0)
        self.assertEqual(payload["children_count"], 2)

    def test_compose_convert_auto_layout(self):
        result = self.runner.invoke(app, ["compose", "convert", str(ALL_PRESETS[2]), "--to", "workspace"])
        self.assertEqual(result.exit_code, 0)
        ws = json.loads(result.stdout)
        self.assertEqual(ws["version"], 2)
        nodes = ws["graph"]["nodes"]
        self.assertEqual(len(nodes), 25)
        for node in nodes:
            self.assertIn("pos", node)
            self.assertEqual(len(node["pos"]), 2)
            self.assertIsInstance(node["pos"][0], (int, float))
            self.assertIsInstance(node["pos"][1], (int, float))

    def test_library_search_json(self):
        result = self.runner.invoke(app, ["library", "search", "--tag", "Kick", "--limit", "3", "--json"])
        self.assertEqual(result.exit_code, 0)
        items = json.loads(result.stdout)
        self.assertIsInstance(items, list)
        self.assertLessEqual(len(items), 3)

    def test_library_verify_presets(self):
        for preset in (ALL_PRESETS[0], ALL_PRESETS[3], ALL_PRESETS[4]):
            result = self.runner.invoke(app, ["library", "verify", str(preset), "--json"])
            self.assertEqual(result.exit_code, 0)
            report = json.loads(result.stdout)
            self.assertTrue(report["verified"])
            self.assertEqual(len(report["missing_references"]), 0)

    def test_render_canonical_preset_qa(self):
        """Render preset with automated QA metrics, verifying no clipping and proper duration."""
        with tempfile.TemporaryDirectory() as td:
            out_wav = Path(td) / "rendered_qa.wav"
            result = self.runner.invoke(app, [
                "render",
                str(ALL_PRESETS[3]),
                "-o", str(out_wav),
                "--qa",
                "--json",
            ])
            self.assertEqual(result.exit_code, 0, f"Render failed: {result.stdout}")
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "success")
            metrics = payload["metrics"]
            self.assertFalse(metrics["has_clipping"], f"Unexpected clipping detected: {metrics}")
            self.assertFalse(metrics["is_silent"], "Rendered audio is unexpectedly silent")
            self.assertGreater(metrics["duration_seconds"], 20.0)


if __name__ == "__main__":
    unittest.main()
