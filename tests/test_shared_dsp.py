"""Unit tests for shared DSP engine, null-test, and normalization."""

import math
from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf

from core.shared_dsp import resolve_and_render_graph


class TestSharedDSP(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        # Generate a test sine WAV
        self.sr = 44100
        t = np.linspace(0, 1.0, self.sr, endpoint=False)
        self.raw_audio = (0.5 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
        # Store as stereo (2, N)
        self.stereo_audio = np.stack([self.raw_audio, self.raw_audio], axis=0)
        self.wav_path = self.root / "sine.wav"
        sf.write(str(self.wav_path), self.stereo_audio.T, self.sr)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_null_test_pass_through(self):
        base_graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {
                "bpm": 120.0,
                "total_bars": 2.0,
                "output": {
                    "export_directory": "files/derived",
                    "format": "wav",
                    "normalize": False,
                },
            },
            "output": "master",
            "nodes": [
                {
                    "id": "src-1",
                    "type": "sample",
                    "properties": {
                        "node_name": "Sine",
                        "filepath": str(self.wav_path),
                        "sample_type": "one_shot",
                        "crop_start": 0.0,
                        "crop_end": 1.0,
                        "stretch_mode": "off",
                        "stretch_factor": 1.0,
                    },
                },
                {
                    "id": "ch-1",
                    "type": "track",
                    "properties": {
                        "node_name": "Sine Bus",
                        "chain": [
                            {"id": "pre", "type": "gain", "enabled": True, "params": {"gain": 1.0}},
                            {"id": "fader", "type": "gain", "enabled": True, "params": {"gain": 1.0}},
                            {"id": "mute", "type": "gain", "enabled": False, "params": {"gain": 0.0}},
                        ],
                    },
                },
                {
                    "id": "master",
                    "type": "track",
                    "role": "master",
                    "properties": {
                        "node_name": "Master",
                        "chain": [],
                    },
                },
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "ch-1", "to": "master", "type": "audio"},
            ],
        }

        audio_out, sr, qa = resolve_and_render_graph(base_graph, sample_rate=self.sr)
        self.assertEqual(sr, self.sr)
        self.assertFalse(qa["has_clipping"])

        # Compare output against input within float epsilon
        # Check first N samples match
        min_len = min(audio_out.shape[-1], self.stereo_audio.shape[-1])
        rendered_slice = audio_out[:, :min_len] if audio_out.ndim > 1 else audio_out[:min_len]
        input_slice = self.stereo_audio[:, :min_len]

        np.testing.assert_allclose(rendered_slice, input_slice, atol=1e-3)

    def test_normalization_target_peak(self):
        base_graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {
                "bpm": 120.0,
                "total_bars": 2.0,
                "output": {
                    "export_directory": "files/derived",
                    "format": "wav",
                    "normalize": True,
                    "target_peak_db": -6.0,
                },
            },
            "output": "master",
            "nodes": [
                {
                    "id": "src-1",
                    "type": "sample",
                    "properties": {
                        "node_name": "Sine",
                        "filepath": str(self.wav_path),
                        "sample_type": "one_shot",
                        "crop_start": 0.0,
                        "crop_end": 1.0,
                        "stretch_mode": "off",
                    },
                },
                {
                    "id": "master",
                    "type": "track",
                    "role": "master",
                    "properties": {"chain": []},
                },
            ],
            "connections": [
                {"from": "src-1", "to": "master", "type": "audio"},
            ],
        }

        audio_out, sr, qa = resolve_and_render_graph(base_graph, sample_rate=self.sr)
        peak_lin = np.max(np.abs(audio_out))
        target_lin = 10.0 ** (-6.0 / 20.0)
        self.assertAlmostEqual(peak_lin, target_lin, places=2)

    def test_null_node_validation_and_python_fx_fallback_parity(self):
        from core.fx import process_chain
        from ermes.py.compiler import validate_graph

        # Null node rejects >1 incoming connection
        bad_doc = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": 1.0},
            "output": "master",
            "nodes": [
                {"id": "s1", "type": "sample"},
                {"id": "s2", "type": "sample"},
                {"id": "n1", "type": "null"},
                {"id": "master", "type": "track", "role": "master"},
            ],
            "connections": [
                {"from": "s1", "to": "n1", "type": "audio"},
                {"from": "s2", "to": "n1", "type": "audio"},
                {"from": "n1", "to": "master", "type": "audio"},
            ],
        }
        ok, errors = validate_graph(bad_doc)
        self.assertFalse(ok)
        self.assertTrue(any("Null node" in e for e in errors))

        # Python NumPy fallback processors execute serially
        dry = np.ones((2, 2048), dtype=np.float32) * 0.8
        fx_out = process_chain(
            dry,
            [
                {"id": "eq", "type": "param_eq", "enabled": True, "params": {"b2_freq": 1000.0, "b2_gain": 3.0}},
                {"id": "cp", "type": "comp", "enabled": True, "params": {"threshold_db": -12.0, "ratio": 4.0, "attack_ms": 1.0, "release_ms": 50.0, "knee_db": 0.0, "makeup_db": 0.0, "mix": 100.0}},
                {"id": "cl", "type": "clipper", "enabled": True, "params": {"mode": 0, "drive_db": 0.0, "ceiling_db": -6.0, "softness": 0.5, "output_db": 0.0}},
                {"id": "lm", "type": "limiter", "enabled": True, "params": {"input_gain_db": 0.0, "ceiling_db": -12.0, "release_ms": 50.0, "lookahead_ms": 2.0}},
            ],
            sample_rate=48000,
        )
        self.assertEqual(fx_out.shape, dry.shape)
        self.assertLessEqual(float(np.max(np.abs(fx_out))), 0.255)

        # Param EQ Low Cut Q controls dB/oct slope (6 dB/oct vs 48 dB/oct on 200Hz sine cut at 1000Hz)
        t_eq = np.arange(4096, dtype=np.float32) / 48000.0
        low_sine = np.stack([0.5 * np.sin(2.0 * np.pi * 200.0 * t_eq)] * 2, axis=0).astype(np.float32)
        gentle = process_chain(
            low_sine,
            [{"id": "eq", "type": "param_eq", "enabled": True, "params": {"b1_type": 0, "b1_freq": 1000.0, "b1_q": 0.2}}],
            sample_rate=48000,
        )
        steep = process_chain(
            low_sine,
            [{"id": "eq", "type": "param_eq", "enabled": True, "params": {"b1_type": 0, "b1_freq": 1000.0, "b1_q": 12.0}}],
            sample_rate=48000,
        )
        gentle_peak = float(np.max(np.abs(gentle[:, 2048:])))
        steep_peak = float(np.max(np.abs(steep[:, 2048:])))
        self.assertGreater(gentle_peak, 0.05)
        self.assertLess(steep_peak, 0.005)
        self.assertLess(steep_peak, gentle_peak * 0.05)


if __name__ == "__main__":
    unittest.main()
