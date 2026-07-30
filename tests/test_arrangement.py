import unittest
import numpy as np
from pathlib import Path

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, ArrangementObject
from core.engines import get_renderer_for_node, ArrangementRenderer
from api import AudioNodeModel, build_audio_object, render_graph


class TestArrangementNode(unittest.TestCase):
    def setUp(self):
        self.system = System(bpm=120.0, sample_rate=44100)

    def test_arrangement_renderer_registered(self):
        renderer = get_renderer_for_node("arrangement")
        self.assertIsInstance(renderer, ArrangementRenderer)

    def test_arrangement_extends_loop_to_total_bars(self):
        # Create a 1-bar sequence (4 beats = 2.0s at 120bpm = 88200 samples)
        seq_obj = SequenceObject(
            name="1BarSeq",
            sequence=[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_length=0.25
        )
        assets_dir = Path(__file__).parent.parent / "assets"
        sample_files = list(assets_dir.glob("*.wav"))
        if sample_files:
            sample_child = SampleObject(name="Sample", filepath=sample_files[0])
            seq_obj.add_child(sample_child, start_beat=0.0)

        # Extend 1-bar loop to 4 bars with probability 1.0 (100%)
        arr_obj = ArrangementObject(
            name="ArrangementTest",
            total_bars=4.0,
            probability=1.0,
            seed=42
        )
        arr_obj.add_child(seq_obj, start_beat=0.0)

        output = arr_obj.render(self.system)
        expected_samples = self.system.beat_to_samples(4.0 * 4.0) # 4 bars = 16 beats
        self.assertEqual(len(output), expected_samples)

    def test_arrangement_probability_zero(self):
        seq_obj = SequenceObject(
            name="1BarSeq",
            sequence=[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_length=0.25
        )
        assets_dir = Path(__file__).parent.parent / "assets"
        sample_files = list(assets_dir.glob("*.wav"))
        if sample_files:
            sample_child = SampleObject(name="Sample", filepath=sample_files[0])
            seq_obj.add_child(sample_child, start_beat=0.0)

        # Extend to 4 bars with probability 0.0 -> all skipped (silent)
        arr_obj = ArrangementObject(
            name="ArrangementTest",
            total_bars=4.0,
            probability=0.0,
            seed=42
        )
        arr_obj.add_child(seq_obj, start_beat=0.0)

        output = arr_obj.render(self.system)
        expected_samples = self.system.beat_to_samples(16.0)
        self.assertEqual(len(output), expected_samples)
        # Verify buffer is all zeros (silence)
        self.assertTrue(np.all(output == 0))

    def test_api_render_graph_arrangement(self):
        arr_model = AudioNodeModel(
            node_name="ArrangementNode",
            node_type="arrangement",
            total_bars=2.0,
            probability=1.0,
            bpm=120.0,
            children=[
                AudioNodeModel(
                    node_name="SeqPattern",
                    node_type="sequence",
                    sequence=[1, 0, 0, 0],
                    step_length=0.25,
                    children=[
                        AudioNodeModel(
                            node_name="Sample",
                            node_type="sample",
                            filepath="assets/KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav"
                        )
                    ]
                )
            ]
        )
        result = render_graph(arr_model)
        self.assertEqual(result["status"], "success")


if __name__ == "__main__":
    unittest.main()
