import unittest
import numpy as np
from core.system import System
from core.engines import TrackRenderer, SampleRenderer, SequenceRenderer, get_renderer_for_node
from api import AudioNodeModel


class TestNodeEngines(unittest.TestCase):
    def setUp(self):
        self.system = System(bpm=120.0, sample_rate=44100)

    def test_factory_returns_correct_renderers(self):
        self.assertIsInstance(get_renderer_for_node("track"), TrackRenderer)
        self.assertIsInstance(get_renderer_for_node("sample"), SampleRenderer)
        self.assertIsInstance(get_renderer_for_node("sequence"), SequenceRenderer)

    def test_sample_renderer_empty(self):
        model = AudioNodeModel(node_name="EmptySample", node_type="sample", filepath=None)
        renderer = SampleRenderer()
        out = renderer.render(model, self.system)
        self.assertEqual(len(out), 0)

    def test_sequence_renderer(self):
        sample_model = AudioNodeModel(
            node_name="KickSample",
            node_type="sample",
            filepath="four_on_the_floor_test_Master Track.wav"
        )
        seq_model = AudioNodeModel(
            node_name="SeqPattern",
            node_type="sequence",
            sequence=[1, 0, 0, 0],
            step_length=0.25,
            children=[sample_model]
        )
        renderer = SequenceRenderer()
        out = renderer.render(seq_model, self.system)
        self.assertIsInstance(out, np.ndarray)

    def test_track_renderer(self):
        sample_model = AudioNodeModel(
            node_name="TrackSample",
            node_type="sample",
            filepath="four_on_the_floor_test_Master Track.wav"
        )
        track_model = AudioNodeModel(
            node_name="MainTrack",
            node_type="track",
            children=[sample_model]
        )
        renderer = TrackRenderer()
        out = renderer.render(track_model, self.system)
        self.assertIsInstance(out, np.ndarray)

    def test_api_render_graph(self):
        from api import render_graph
        sample_model = AudioNodeModel(
            node_name="SingleSampleNode",
            node_type="sample",
            filepath="four_on_the_floor_test_Master Track.wav",
            filename="test_render_out"
        )
        res = render_graph(sample_model)
        self.assertEqual(res["status"], "success")
        self.assertTrue(res["file_url"].endswith(".wav"))


if __name__ == '__main__':
    unittest.main()
