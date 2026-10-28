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


if __name__ == "__main__":
    unittest.main()
