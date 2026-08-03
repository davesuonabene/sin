import unittest
import os
import numpy as np
import soundfile as sf
from core.system import System
from core.audio_object import SampleObject
from core.engines import SampleRenderer
from api import AudioNodeModel


class TestSampleCropping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_wav_path = "temp_test_crop_sample.wav"
        sr = 44100
        duration_sec = 2.0
        t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
        audio_data = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        sf.write(cls.test_wav_path, audio_data, sr)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.test_wav_path):
            try:
                os.remove(cls.test_wav_path)
            except Exception:
                pass

    def setUp(self):
        self.system = System(bpm=120.0, sample_rate=44100)

    def test_sample_object_cropping_full(self):
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            crop_start=0.0,
            crop_end=1.0
        )
        rendered = sample_obj.render(self.system)
        expected_len = 44100 * 2
        self.assertEqual(len(rendered), expected_len)

    def test_sample_object_cropping_half(self):
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            crop_start=0.25,
            crop_end=0.75
        )
        rendered = sample_obj.render(self.system)
        expected_len = int(44100 * 2 * 0.5)
        self.assertAlmostEqual(len(rendered), expected_len, delta=10)

    def test_sample_renderer_cropping(self):
        node_model = AudioNodeModel(
            node_name="CroppedSampleNode",
            node_type="sample",
            filepath=self.test_wav_path,
            original_bpm=120.0,
            target_bpm=120.0,
            crop_start=0.1,
            crop_end=0.6
        )
        renderer = SampleRenderer()
        rendered = renderer.render(node_model, self.system)
        expected_len = int(44100 * 2 * 0.5)
        self.assertAlmostEqual(len(rendered), expected_len, delta=10)


if __name__ == '__main__':
    unittest.main()
