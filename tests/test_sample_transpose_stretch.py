import unittest
import os
import numpy as np
import soundfile as sf
from core.system import System
from core.audio_object import SampleObject
from core.engines import SampleRenderer
from api import AudioNodeModel


class TestSampleTransposeStretch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_wav_path = "temp_test_transpose_sample.wav"
        cls.sr = 44100
        duration_sec = 1.0
        t = np.linspace(0, duration_sec, int(cls.sr * duration_sec), endpoint=False)
        # Create a pure sine wave at 440 Hz (A4)
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
        self.system = System(bpm=120.0, sample_rate=44100)

    def test_default_rendering_backward_compatible(self):
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop"
        )
        rendered = sample_obj.render(self.system)
        expected_len = int(self.sr * 1.0)
        self.assertAlmostEqual(len(rendered), expected_len, delta=100)

    def test_transpose_semitones_time_stretch(self):
        sample_obj_normal = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop",
            transpose=0.0
        )
        sample_obj_transposed = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop",
            transpose=7.0  # Perfect fifth up
        )
        rendered_normal = sample_obj_normal.render(self.system)
        rendered_transposed = sample_obj_transposed.render(self.system)

        # Length in time_stretch mode should remain equal to original
        self.assertAlmostEqual(len(rendered_transposed), len(rendered_normal), delta=100)
        # Audio contents should be altered by pitch shift
        self.assertFalse(np.allclose(rendered_normal[:1000], rendered_transposed[:1000]))

    def test_varispeed_mode(self):
        # Pitching up 12 semitones in varispeed mode should double speed (half duration)
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop",
            transpose=12.0,
            stretch_mode="varispeed"
        )
        rendered = sample_obj.render(self.system)
        expected_half_len = int(self.sr * 0.5)
        self.assertAlmostEqual(len(rendered), expected_half_len, delta=200)

    def test_stretch_factor(self):
        # Stretch factor of 2.0 (2x speed) should halve duration
        sample_obj = SampleObject(
            filepath=self.test_wav_path,
            original_bpm=120.0,
            sample_type="loop",
            stretch_factor=2.0,
            stretch_mode="time_stretch"
        )
        rendered = sample_obj.render(self.system)
        expected_half_len = int(self.sr * 0.5)
        self.assertAlmostEqual(len(rendered), expected_half_len, delta=200)

    def test_renderer_with_model(self):
        model = AudioNodeModel(
            node_name="TransposedSample",
            node_type="sample",
            filepath=self.test_wav_path,
            original_bpm=120.0,
            transpose=4.0,
            cents=50.0,
            stretch_mode="time_stretch",
            stretch_factor=1.0
        )
        renderer = SampleRenderer()
        rendered = renderer.render(model, self.system)
        self.assertGreater(len(rendered), 0)

    def test_track_with_connected_sample_child(self):
        track_model = AudioNodeModel(
            node_name="ParentTrack",
            node_type="track",
            bpm=140.0,
            children=[
                AudioNodeModel(
                    node_name="ChildSample",
                    node_type="sample",
                    filepath=self.test_wav_path,
                    original_bpm=120.0,
                    target_bpm=140.0,
                    transpose=5.0,
                    cents=0.0,
                    stretch_mode="time_stretch",
                    stretch_factor=1.0,
                    start_beat=0.0
                )
            ]
        )
        from core.engines import TrackRenderer
        renderer = TrackRenderer()
        system = System(bpm=140.0, sample_rate=44100)
        rendered = renderer.render(track_model, system)
        self.assertGreater(len(rendered), 0)


if __name__ == '__main__':
    unittest.main()
