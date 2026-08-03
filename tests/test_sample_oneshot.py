import unittest
import os
import numpy as np
import soundfile as sf
from core.system import System
from core.audio_object import SampleObject
from core.engines import SampleRenderer
from api import AudioNodeModel


class TestSampleOneShot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_wav_path = "temp_test_oneshot_sample.wav"
        cls.sr = 44100
        duration_sec = 2.0
        t = np.linspace(0, duration_sec, int(cls.sr * duration_sec), endpoint=False)
        audio_data = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        sf.write(cls.test_wav_path, audio_data, cls.sr)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.test_wav_path):
            try:
                os.remove(cls.test_wav_path)
            except Exception:
                pass

    def setUp(self):
        # Target BPM set to 180 (faster than 120 original BPM)
        self.system = System(bpm=180.0, sample_rate=44100)

    def test_loop_stretches_audio(self):
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop"
        )
        rendered = sample_obj.render(self.system)
        raw_len = int(self.sr * 2.0)
        # Stretched to 180 BPM should be shorter (~ 120/180 of raw_len)
        self.assertNotEqual(len(rendered), raw_len)

    def test_oneshot_bypasses_stretching(self):
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="one_shot"
        )
        rendered = sample_obj.render(self.system)
        raw_len = int(self.sr * 2.0)
        # One-shot should keep raw un-stretched length
        self.assertEqual(len(rendered), raw_len)

    def test_renderer_oneshot(self):
        node_model = AudioNodeModel(
            node_name="OneShotSampleNode",
            node_type="sample",
            sample_type="one_shot",
            filepath=self.test_wav_path,
            original_bpm=120.0,
            bpm=180.0
        )
        renderer = SampleRenderer()
        rendered = renderer.render(node_model, self.system)
        raw_len = int(self.sr * 2.0)
        self.assertEqual(len(rendered), raw_len)


if __name__ == '__main__':
    unittest.main()
