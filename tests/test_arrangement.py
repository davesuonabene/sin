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
                            filepath="assets/SongA_Stems/Drums.wav"
                        )
                    ]
                )
            ]
        )
        result = render_graph(arr_model)
        self.assertEqual(result["status"], "success")

    def test_quant_auto_with_sample_object_none_total_bars(self):
        system = System(bpm=120.0, sample_rate=44100)
        sample = SampleObject(name="SampleWithNoneTotalBars", filepath="assets/SongA_Stems/Drums.wav")
        arrangement = ArrangementObject(total_bars=4.0, quant="auto", probability=1.0)
        arrangement.add_child(sample, 0.0)
        out = arrangement.render(system)
        self.assertIsInstance(out, np.ndarray)
        self.assertGreater(len(out), 0)

    def test_quant_none_plays_once_per_section(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            quant="none",
            probability=1.0,
            seed=1
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertEqual(len(output), 400)
        self.assertTrue(np.all(output[0:50] == 1))
        self.assertTrue(np.all(output[50:200] == 0))
        self.assertTrue(np.all(output[200:250] == 1))
        self.assertTrue(np.all(output[250:400] == 0))

    def test_disabled_section_places_no_audio(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot",
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_enabled=[True, False],
            quant="none",
            probability=1.0,
            seed=1,
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertEqual(len(output), 400)
        self.assertTrue(np.all(output[:50] == 1))
        self.assertTrue(np.all(output[50:] == 0))

    def test_quant_anchor_can_align_sample_to_cell_end(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        arrangement = ArrangementObject(
            total_bars=1.0,
            quant="0.5",
            quant_anchor="end",
            probability=1.0,
            seed=1
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertTrue(np.all(output[0:50] == 0))
        self.assertTrue(np.all(output[50:100] == 1))
        self.assertTrue(np.all(output[100:150] == 0))
        self.assertTrue(np.all(output[150:200] == 1))

    def test_track_total_bars_is_render_authority(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="LongSample",
            audio_data=np.ones(300, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        track = AudioObject(name="Master", total_bars=1.0)
        track.add_child(sample, 0.0)

        output = track.render(system)

        self.assertEqual(len(output), 200)
        self.assertTrue(np.all(output == 1))

    def test_section_probability_override(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_probability=[1.0, 0.0],
            quant="none",
            probability=1.0,
            seed=1
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertEqual(len(output), 400)
        self.assertTrue(np.all(output[0:50] == 1))
        self.assertTrue(np.all(output[50:200] == 0))
        self.assertTrue(np.all(output[200:] == 0))

    def test_section_quant_override(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_quant=["none", "0.5"],
            quant="none",
            probability=1.0,
            seed=1
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertEqual(len(output), 400)
        # Section 1 (bars 0-1): quant="none" -> plays at index 0..50, then silence 50..200
        self.assertTrue(np.all(output[0:50] == 1))
        self.assertTrue(np.all(output[50:200] == 0))
        # Section 2 (bars 1-2): quant="0.5" -> cell 1 (bars 1-1.5): index 200..250 = 1, 250..300 = 0. cell 2 (bars 1.5-2): index 300..350 = 1, 350..400 = 0.
        self.assertTrue(np.all(output[200:250] == 1))
        self.assertTrue(np.all(output[250:300] == 0))
        self.assertTrue(np.all(output[300:350] == 1))
        self.assertTrue(np.all(output[350:400] == 0))

    def test_section_quant_anchor_override(self):
        system = System(bpm=120.0, sample_rate=100)
        sample = AudioObject(
            name="QuarterBar",
            audio_data=np.ones(50, dtype=np.float32),
            original_bpm=120.0,
            sample_type="one_shot"
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_quant=["0.5", "0.5"],
            section_quant_anchor=["start", "end"],
            probability=1.0,
            seed=1
        )
        arrangement.add_child(sample, 0.0)

        output = arrangement.render(system)

        self.assertEqual(len(output), 400)
        # Section 1 start-anchored: cells at bar 0 and 0.5 -> samples at [0..50] and [100..150]
        self.assertTrue(np.all(output[0:50] == 1))
        self.assertTrue(np.all(output[50:100] == 0))
        self.assertTrue(np.all(output[100:150] == 1))
        self.assertTrue(np.all(output[150:200] == 0))
        # Section 2 end-anchored (cells 200..300 and 300..400):
        # Cell 1 (200..300) end-anchored -> [250..300] sample.
        # Cell 2 (300..400) end-anchored -> [350..400] sample.
        self.assertTrue(np.all(output[200:250] == 0))
        self.assertTrue(np.all(output[250:300] == 1))
        self.assertTrue(np.all(output[300:350] == 0))
        self.assertTrue(np.all(output[350:400] == 1))


if __name__ == "__main__":
    unittest.main()
