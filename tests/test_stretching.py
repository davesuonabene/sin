from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from core.stretching import (
    StretchAlgorithm,
    _find_rubberband_executable,
    rubberband_options_for,
    stretch_with_rubberband,
)
from core.dsp import process_sample_transform


class TestRubberBandPresets(unittest.TestCase):
    def test_material_presets_select_the_intended_engine_options(self):
        self.assertEqual(rubberband_options_for(StretchAlgorithm.RUBBERBAND), {"--fine": ""})
        self.assertEqual(
            rubberband_options_for(StretchAlgorithm.RUBBERBAND_VOCAL),
            {"--fine": "", "--formant": ""},
        )
        self.assertEqual(
            rubberband_options_for(StretchAlgorithm.RUBBERBAND_PERCUSSIVE),
            {"--fast": "", "--crisp": "6"},
        )

    def test_preview_selects_fast_engine_without_changing_offline_default(self):
        audio = np.ones(128, dtype=np.float32)
        with patch("core.dsp.stretch_with_rubberband", return_value=audio) as stretch:
            process_sample_transform(
                audio,
                sr=8_000,
                original_bpm=100,
                target_bpm=120,
                fast_preview=True,
            )
            self.assertTrue(stretch.call_args.kwargs["fast_engine"])

            process_sample_transform(
                audio,
                sr=8_000,
                original_bpm=100,
                target_bpm=120,
            )
            self.assertFalse(stretch.call_args.kwargs["fast_engine"])

    @unittest.skipUnless(_find_rubberband_executable(), "Rubber Band executable is not installed")
    def test_every_preset_preserves_stereo_layout_and_requested_duration(self):
        phase = np.linspace(0.0, 8.0 * np.pi, 4_096, dtype=np.float32)
        stereo = np.stack([np.sin(phase), np.cos(phase)]).astype(np.float32)

        for algorithm in (
            StretchAlgorithm.RUBBERBAND,
            StretchAlgorithm.RUBBERBAND_VOCAL,
            StretchAlgorithm.RUBBERBAND_PERCUSSIVE,
        ):
            with self.subTest(algorithm=algorithm.value):
                result = stretch_with_rubberband(
                    stereo,
                    8_000,
                    algorithm=algorithm,
                    tempo_rate=2.0,
                    semitones=-5.0,
                )
                self.assertEqual(result.shape[0], 2)
                self.assertAlmostEqual(result.shape[-1], 2_048, delta=2)
                self.assertTrue(np.isfinite(result).all())
