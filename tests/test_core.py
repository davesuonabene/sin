from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from fastapi import HTTPException
from starlette.requests import Request
import api as iride_api

from api import (
    AudioNodeModel,
    RAM_PREVIEW_STORE,
    StageSaveRequest,
    export_ram_preview,
    load_current_stage,
    preview_graph_ram,
    render_graph,
    resolve_pool,
    save_current_stage,
    stream_ram_preview,
)
from core.analyzers import BPMAnalyzer
from core.audio_object import AudioObject, ArrangementObject, ItemPoolObject, SequenceObject
from core.dsp import load_sample, process_sample_transform
from core.runtime_trace import collect_runtime_trace
from core.engines import (
    ArrangementRenderer,
    SampleRenderer,
    SequenceRenderer,
    TrackRenderer,
    build_node_object,
    get_renderer_for_node,
)
from core.fx import apply_delay, process_chain
from core.system import System
from ermes import PoolResolveRequest
from tests.support import AudioFixtureTestCase, working_directory


class CountingPoolSample(AudioObject):
    def __init__(self, refresh_mode: str):
        super().__init__(name=f"{refresh_mode} pool")
        self.is_dynamic = refresh_mode == "local"
        self.render_count = 0

    def render(self, system=None, **kwargs):
        self.render_count += 1
        return np.ones(100, dtype=np.float32) * self.render_count


class TestSamplePipeline(AudioFixtureTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.mono_path = cls.write_audio("loop_120bpm.wav", seconds=0.5)
        cls.stereo_path = cls.write_audio(
            "opposed-stereo.wav",
            seconds=0.1,
            channels=2,
            value=0.25,
        )

    def test_detection_loading_crop_and_sample_modes(self):
        for filename in ("sample_120bpm.wav", "track_120_bpm.wav", "loop 120 BPM.wav"):
            with self.subTest(filename=filename):
                self.assertEqual(BPMAnalyzer.from_filename(filename), 120.0)
        self.assertIsNone(BPMAnalyzer.from_filename("drums.wav"))
        self.assertAlmostEqual(BPMAnalyzer.from_duration(8.0), 120.0)

        with patch("core.dsp.librosa.load", side_effect=AssertionError("WAV used slow loader")):
            stereo, duration = load_sample(self.stereo_path, target_sr=self.sample_rate)
        self.assertEqual(stereo.shape, (2, 800))
        self.assertAlmostEqual(duration, 0.1)
        np.testing.assert_allclose(stereo[0], 0.25)
        np.testing.assert_allclose(stereo[1], -0.25)

        cropped = build_node_object(
            AudioNodeModel(
                node_name="Cropped one-shot",
                node_type="sample",
                filepath=str(self.mono_path),
                original_bpm=120.0,
                sample_type="one_shot",
                stretch_mode="off",
                crop_start=0.25,
                crop_end=0.75,
            )
        ).render(System(bpm=240.0, sample_rate=self.sample_rate))
        self.assertEqual(cropped.shape[-1], 2_000)

        loop_model = AudioNodeModel(
            node_name="Loop",
            node_type="sample",
            filepath=str(self.mono_path),
            original_bpm=120.0,
            sample_type="loop",
        )
        one_shot_model = loop_model.model_copy(
            update={"node_name": "One shot", "sample_type": "one_shot"}
        )
        system = System(bpm=240.0, sample_rate=self.sample_rate)
        self.assertAlmostEqual(SampleRenderer().render(loop_model, system).shape[-1], 2_000, delta=4)
        self.assertEqual(SampleRenderer().render(one_shot_model, system).shape[-1], 4_000)

    def test_render_trace_uses_request_local_file_cache(self):
        with collect_runtime_trace() as trace:
            first, _ = load_sample(self.stereo_path, target_sr=self.sample_rate)
            second, _ = load_sample(self.stereo_path, target_sr=self.sample_rate)

        self.assertIs(first, second)
        messages = [entry["message"] for entry in trace]
        self.assertTrue(any(message.startswith("File loaded via SoundFile") for message in messages))
        self.assertTrue(any(message.startswith("File cache hit") for message in messages))

    def test_transform_modes_preserve_channels_and_expected_duration(self):
        phase = np.linspace(0.0, 8.0 * np.pi, 4_096, dtype=np.float32)
        stereo = np.stack([np.sin(phase), np.cos(phase)]).astype(np.float32)

        stretched = process_sample_transform(
            stereo,
            sr=self.sample_rate,
            sample_type="one_shot",
            stretch_mode="time_stretch",
            stretch_factor=2.0,
        )
        repitched = process_sample_transform(
            stereo,
            sr=self.sample_rate,
            sample_type="one_shot",
            stretch_mode="pitch_shift",
            transpose=12.0,
        )

        self.assertEqual(stretched.shape[0], 2)
        self.assertAlmostEqual(stretched.shape[-1], 2_048, delta=2)
        self.assertEqual(repitched.shape[0], 2)
        self.assertAlmostEqual(repitched.shape[-1], 2_048, delta=2)

    def test_stereo_mix_and_effect_chain(self):
        system = System(bpm=120.0, sample_rate=1_000)
        stereo = AudioObject(
            audio_data=np.stack([
                np.full(256, 0.2, dtype=np.float32),
                np.full(256, 0.4, dtype=np.float32),
            ]),
            sample_type="one_shot",
            stretch_mode="off",
        )
        mono = AudioObject(
            audio_data=np.full(256, 0.1, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        track = AudioObject(name="Stereo mix")
        track.add_child(stereo, 0.0)
        track.add_child(mono, 0.0)
        mixed = track.render(system)
        self.assertEqual(mixed.shape, (2, 256))
        np.testing.assert_allclose(mixed[0], 0.3)
        np.testing.assert_allclose(mixed[1], 0.5)

        chain = [
            {"type": "gain", "params": {"gain": 0.9}},
            {"type": "eq", "params": {"low_gain": 0.8, "mid_gain": 1.1}},
            {"type": "compressor", "params": {"threshold": -20.0, "ratio": 2.0}},
            {"type": "delay", "params": {"delay_time": 0.01, "feedback": 0.2, "mix": 0.2}},
            {"type": "reverb", "params": {"room_size": 0.2, "mix": 0.2}},
            {"type": "filter", "params": {"mode": "lowpass", "cutoff": 300.0}},
            {"type": "distortion", "params": {"drive": 1.5, "mix": 0.2}},
            {"type": "chorus", "params": {"rate": 1.0, "depth": 0.002, "mix": 0.2}},
            {"type": "limiter", "params": {"threshold": -0.1}},
        ]
        processed = process_chain(mixed, chain, sample_rate=system.sample_rate)
        self.assertEqual(processed.shape, mixed.shape)
        self.assertTrue(np.all(np.isfinite(processed)))

        impulse = np.zeros((2, 32), dtype=np.float32)
        impulse[0, 0] = 1.0
        delayed = apply_delay(
            impulse,
            {"delay_time": 0.01, "feedback": 0.5, "mix": 1.0},
            sr=100,
        )
        self.assertGreater(delayed[0, 1], 0.0)
        np.testing.assert_array_equal(delayed[1], np.zeros(32, dtype=np.float32))


class TestGraphRendering(AudioFixtureTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sample_path = cls.write_audio("graph-sample.wav", seconds=0.05, value=0.25)

    def test_recursive_builder_and_renderer_registry(self):
        expected_renderers = {
            "track": TrackRenderer,
            "sample": SampleRenderer,
            "sequence": SequenceRenderer,
            "arrangement": ArrangementRenderer,
        }
        for node_type, renderer_type in expected_renderers.items():
            with self.subTest(node_type=node_type):
                self.assertIsInstance(get_renderer_for_node(node_type), renderer_type)

        payload = AudioNodeModel(
            node_name="Master",
            node_type="track",
            bpm=120.0,
            total_bars=0.25,
            children=[
                AudioNodeModel(
                    node_name="Pattern",
                    node_type="sequence",
                    sequence=[1, 0, 1, 0],
                    step_length=0.25,
                    play_mode="trigger",
                    children=[
                        AudioNodeModel(
                            node_name="Sample",
                            node_type="sample",
                            filepath=str(self.sample_path),
                            sample_type="one_shot",
                            stretch_mode="off",
                        )
                    ],
                )
            ],
        )
        graph = build_node_object(payload)
        self.assertIsInstance(graph.children[0][1], SequenceObject)
        rendered = TrackRenderer().render(payload, System(bpm=120.0, sample_rate=self.sample_rate))
        self.assertEqual(rendered.shape[-1], 4_000)
        self.assertGreater(float(np.max(rendered)), 0.0)

    def test_sequence_timing_modes_and_fades(self):
        system = System(bpm=60.0, sample_rate=100)
        impulse = AudioObject(
            audio_data=np.ones(1, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        sequence = SequenceObject(
            sequence=[1, 1, 1],
            step_length=1.0,
            step_parameters=[
                {"offset": 0.5, "velocity": 0.5, "probability": 100},
                {"probability": 100, "subdivisions": 2},
                {"probability": 0},
            ],
        )
        sequence.add_child(impulse, 0.0)
        output = sequence.render(system)
        self.assertEqual(output[50], np.float32(0.5))
        self.assertEqual(output[100], np.float32(1.0))
        self.assertEqual(output[150], np.float32(1.0))
        self.assertEqual(output[200], np.float32(0.0))

        long_sample = AudioObject(
            audio_data=np.ones(100, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        mode_outputs = {}
        for mode in ("gate", "trigger"):
            candidate = SequenceObject(sequence=[1, 0, 0, 0], step_length=0.25, play_mode=mode)
            candidate.add_child(long_sample, 0.0)
            mode_outputs[mode] = candidate.render(system)
        self.assertTrue(np.all(mode_outputs["gate"][25:] == 0.0))
        self.assertTrue(np.all(mode_outputs["trigger"] == 1.0))

        stereo_sample = AudioObject(
            audio_data=np.ones((2, 20), dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        faded = SequenceObject(
            sequence=[1],
            step_length=0.01,
            play_mode="gate",
            fade_ms=2.0,
        )
        faded.add_child(stereo_sample, 0.0)
        faded_output = faded.render(System(bpm=60.0, sample_rate=1_000))
        expected = np.array([0.0, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.0])
        np.testing.assert_allclose(faded_output[0], expected)
        np.testing.assert_allclose(faded_output[1], expected)

    def test_sequence_seed_and_pool_refresh_contracts(self):
        system = System(bpm=60.0, sample_rate=100)
        impulse = AudioObject(
            audio_data=np.ones(1, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        parameters = [{"probability": 50.0} for _ in range(16)]
        fixed = SequenceObject(
            sequence=[1] * 16,
            step_length=0.25,
            step_parameters=parameters,
            seed=12345,
            seed_mode="fixed",
        )
        fixed.add_child(impulse, 0.0)
        np.testing.assert_array_equal(fixed.render(system, iteration=0), fixed.render(system, iteration=1))

        moving = SequenceObject(
            sequence=[1] * 16,
            step_length=0.25,
            step_parameters=parameters,
            seed=12345,
            seed_mode="moving",
        )
        moving.add_child(impulse, 0.0)
        self.assertFalse(np.array_equal(
            moving.render(system, iteration=0),
            moving.render(system, iteration=1),
        ))

        local_pool = CountingPoolSample("local")
        local_sequence = SequenceObject(sequence=[1, 1, 1, 1], step_length=0.25)
        local_sequence.add_child(local_pool, 0.0)
        local_sequence.render(system)
        self.assertEqual(local_pool.render_count, 4)

        parent_pool = CountingPoolSample("parent")
        parent_sequence = SequenceObject(sequence=[1, 1, 1, 1], step_length=0.25)
        parent_sequence.add_child(parent_pool, 0.0)
        arrangement = ArrangementObject(total_bars=1.0, seed=4, section_quant=["auto"])
        arrangement.add_child(parent_sequence, 0.0)
        arrangement.render(system)
        self.assertEqual(parent_pool.render_count, 4)

        pool = ItemPoolObject(
            selected_items=[{"id": index, "absolute_path": f"{name}.wav"}
                            for index, name in enumerate(("one", "two", "three"), start=1)],
            playback_mode="Sequential",
            refresh_mode="local",
        )
        self.assertEqual(
            [pool.getNextSample(advance=True) for _ in range(3)],
            ["one.wav", "two.wav", "three.wav"],
        )
        explicit_pool = ItemPoolObject(
            selected_items=[
                {"id": 10, "absolute_path": "kick-one.wav", "type": "sample"},
                {"id": 11, "absolute_path": "kick-two.wav", "type": "sample"},
            ],
            playback_mode="Sequential",
            refresh_mode="local",
        )
        self.assertEqual(
            [item["absolute_path"] for item in explicit_pool.current_pool],
            ["kick-one.wav", "kick-two.wav"],
        )
        with patch.object(iride_api, "get_library", return_value={
            "files": [{
                "id": 352,
                "absolute_path": "gaia-kick.wav",
                "name": "Kick 01.wav",
                "type": "sample",
                "bpm": 120.0,
            }]
        }):
            resolved_key = resolve_pool(PoolResolveRequest(
                selected_items=[{"id": 352, "absolute_path": "stale-wrong-file.wav"}],
                playbackMode="Sequential",
            ))
            self.assertEqual(resolved_key["sample"], "gaia-kick.wav")
            self.assertEqual(resolved_key["items"][0]["id"], 352)
            with self.assertRaises(HTTPException):
                resolve_pool(PoolResolveRequest(
                    selected_items=[{"id": 999999, "absolute_path": "stale-wrong-file.wav"}],
                    playbackMode="Sequential",
                ))
        with patch.object(iride_api, "get_library", return_value={
            "files": [{"id": 41, "absolute_path": "loop.wav", "bpm": 140.0}]
        }):
            resolved = resolve_pool(
                PoolResolveRequest(
                    selected_items=[{"id": 41, "bpm": 140.0}],
                    playbackMode="Sequential",
                )
            )
        self.assertEqual((resolved["sample"], resolved["bpm"]), ("loop.wav", 140.0))

        # The editor has already refreshed these exact IDs in one batch. Pool
        # selection must not rebuild the full library or decode audio metadata.
        with patch.object(iride_api, "get_library", side_effect=AssertionError("full library loaded")):
            resolved_snapshot = resolve_pool(PoolResolveRequest(
                selected_items=[{"id": 41, "absolute_path": "already-resolved.wav"}],
                playbackMode="Sequential",
                items_resolved=True,
            ))
        self.assertEqual(resolved_snapshot["sample"], "already-resolved.wav")

        different_snapshot = resolve_pool(PoolResolveRequest(
            selected_items=[
                {"id": 41, "absolute_path": "first.wav"},
                {"id": 42, "absolute_path": "second.wav"},
            ],
            playbackMode="Sequential",
            items_resolved=True,
            previous_sample="first.wav",
            prefer_different=True,
        ))
        self.assertEqual(different_snapshot["sample"], "second.wav")

    def test_arrangement_sections_quantization_and_timeline(self):
        system = System(bpm=120.0, sample_rate=100)
        ramp = AudioObject(
            audio_data=np.arange(100, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        )
        arrangement = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_probability=[1.0, 1.0],
            section_sample_start=[0.0, 0.5],
            section_quant=["none", "0.5"],
            section_quant_anchor=["start", "end"],
            seed=1,
        )
        arrangement.add_child(ramp, 0.0)
        output = arrangement.render(system)
        self.assertEqual(output.shape[-1], 400)
        np.testing.assert_array_equal(output[:100], np.arange(100, dtype=np.float32))
        self.assertTrue(np.all(output[100:200] == 0.0))
        self.assertTrue(np.all(output[200:250] == 0.0))
        np.testing.assert_array_equal(output[250:300], np.arange(50, 100, dtype=np.float32))
        self.assertTrue(np.all(output[300:350] == 0.0))
        np.testing.assert_array_equal(output[350:400], np.arange(50, 100, dtype=np.float32))

        probability_zero = ArrangementObject(
            total_bars=2.0,
            section_points=[1.0],
            section_probability=[1.0, 0.0],
            section_quant=["none", "none"],
        )
        probability_zero.add_child(AudioObject(
            audio_data=np.ones(50, dtype=np.float32),
            sample_type="one_shot",
            stretch_mode="off",
        ), 0.0)
        probability_zero_output = probability_zero.render(system)
        self.assertTrue(np.all(probability_zero_output[:50] == 1.0))
        self.assertTrue(np.all(probability_zero_output[50:] == 0.0))

        # Legacy node-wide settings are folded into every local section at the
        # API boundary, so old work remains faithful without runtime globals.
        legacy = ArrangementObject(
            total_bars=1.0,
            probability=0.4,
            quant="auto",
            quant_anchor="end",
            section_quant=["global"],
            section_quant_anchor=["global"],
        )
        self.assertEqual(legacy.get_section_quant(0), "auto")
        self.assertEqual(legacy.get_section_quant_anchor(0), "end")
        self.assertEqual(legacy.get_section_probability(0), 0.4)

        legacy_disabled = ArrangementObject(section_enabled=[False])
        self.assertEqual(legacy_disabled.get_section_probability(0), 0.0)


class TestApiAudioFlow(AudioFixtureTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.stereo_path = cls.write_audio(
            "api-stereo.wav",
            seconds=0.1,
            channels=2,
            value=0.25,
        )

    def test_preview_range_export_and_render_are_disposable(self):
        payload = AudioNodeModel(
            node_name="API sample",
            node_type="sample",
            filepath=str(self.stereo_path),
            original_bpm=120.0,
            sample_type="one_shot",
            stretch_mode="off",
            filename="api_test",
        )

        with tempfile.TemporaryDirectory(prefix="sin-api-test-") as directory:
            with working_directory(Path(directory)):
                preview_response = preview_graph_ram(payload)
                self.assertTrue(preview_response["runtime_log"])
                self.assertTrue(any(
                    "File loaded via SoundFile" in entry["message"]
                    for entry in preview_response["runtime_log"]
                ))
                cached_response = preview_graph_ram(payload)
                self.assertTrue(cached_response["cached"])
                self.assertTrue(any(
                    "Preview cache hit" in entry["message"]
                    for entry in cached_response["runtime_log"]
                ))
                preview_id = preview_response["preview_id"]
                self.addCleanup(RAM_PREVIEW_STORE.pop, preview_id, None)

                full_request = Request({
                    "type": "http",
                    "method": "GET",
                    "path": f"/api/preview/stream/{preview_id}",
                    "headers": [],
                })
                full_response = stream_ram_preview(preview_id, full_request)
                self.assertEqual(full_response.media_type, "audio/wav")
                self.assertEqual(full_response.headers["accept-ranges"], "bytes")
                self.assertIn("max-age=300", full_response.headers["cache-control"])

                range_request = Request({
                    "type": "http",
                    "method": "GET",
                    "path": f"/api/preview/stream/{preview_id}",
                    "headers": [(b"range", b"bytes=10-29")],
                })
                range_response = stream_ram_preview(preview_id, range_request)
                self.assertEqual(range_response.status_code, 206)
                self.assertEqual(len(range_response.body), 20)

                preview = RAM_PREVIEW_STORE[preview_id]
                with sf.SoundFile(__import__("io").BytesIO(preview["wav_bytes"])) as wav:
                    self.assertEqual(wav.channels, 2)

                export_response = export_ram_preview(preview_id, payload)
                self.assertTrue((Path("export") / export_response["filename"]).is_file())

                render_response = render_graph(payload)
                self.assertTrue((Path("temp_renders") / render_response["filename"]).is_file())


class TestCurrentStagePersistence(unittest.TestCase):
    def test_current_stage_is_replaced_atomically_and_can_be_loaded(self):
        original_saves_dir = iride_api.SAVES_DIR
        original_stage_path = iride_api.STAGE_SAVE_PATH
        with tempfile.TemporaryDirectory(prefix="sin-current-stage-") as directory:
            stage_dir = Path(directory) / "saves"
            iride_api.SAVES_DIR = stage_dir
            iride_api.STAGE_SAVE_PATH = stage_dir / ".current-stage.json"
            try:
                first_stage = {"version": 2, "graph": {"nodes": [], "links": []}}
                second_stage = {"version": 2, "graph": {"nodes": [{"id": 7}], "links": []}}

                self.assertEqual(save_current_stage(StageSaveRequest(stage=first_stage))["status"], "saved")
                self.assertEqual(load_current_stage()["stage"], first_stage)

                self.assertEqual(save_current_stage(StageSaveRequest(stage=second_stage))["status"], "saved")
                self.assertEqual(load_current_stage()["stage"], second_stage)
                self.assertFalse((stage_dir / ".current-stage.tmp").exists())
            finally:
                iride_api.SAVES_DIR = original_saves_dir
                iride_api.STAGE_SAVE_PATH = original_stage_path


if __name__ == "__main__":
    unittest.main()
