import unittest
from pathlib import Path
import numpy as np
from core.analyzers import BPMAnalyzer
from core.dsp import stretch_audio, load_sample
from core.audio_object import AudioObject
from core.system import System


class TestAnalyzers(unittest.TestCase):
    def test_bpm_analyzer_from_filename(self):
        self.assertEqual(BPMAnalyzer.from_filename("sample_120bpm.wav"), 120.0)
        self.assertEqual(BPMAnalyzer.from_filename("track_120_bpm.wav"), 120.0)
        self.assertEqual(BPMAnalyzer.from_filename("loop 120 BPM.wav"), 120.0)
        self.assertEqual(BPMAnalyzer.from_filename("KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav"), 171.0)
        self.assertIsNone(BPMAnalyzer.from_filename("drums.wav"))

    def test_bpm_analyzer_from_duration(self):
        # 4 bars at 120 BPM in 4/4 time = 16 beats = 8.0 seconds
        bpm_8s = BPMAnalyzer.from_duration(8.0)
        self.assertAlmostEqual(bpm_8s, 120.0, delta=0.01)

        # 4 bars at 170 BPM = 16 beats = 16 / (170/60) = 5.647 seconds
        bpm_5_64s = BPMAnalyzer.from_duration(5.6470588)
        self.assertAlmostEqual(bpm_5_64s, 170.0, delta=0.1)

    def test_stretch_audio(self):
        # Generate 1 second of 44.1kHz audio
        audio = np.random.uniform(-1, 1, 44100).astype(np.float32)
        # Speed up 120 -> 240 BPM (rate = 2.0) should halve the length
        stretched = stretch_audio(audio, original_bpm=120.0, target_bpm=240.0)
        self.assertTrue(len(stretched) < len(audio))
        self.assertIsInstance(stretched, np.ndarray)


if __name__ == "__main__":
    unittest.main()
