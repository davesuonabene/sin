"""Integration & parity tests for the in-process C++20 libsin_dsp engine,
pure Python plan packer (`core/plan_packer.py`), and offline/realtime parity."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf

from core.audio_engine import SinAudioEngine, is_native_engine_available, render_plan_offline
from core.plan_packer import pack_canonical_graph
from core.render_plan import (
    SIN_DEFAULT_SAMPLE_RATE,
    SIN_PARAM_CROP_END,
    SIN_PARAM_CROP_START,
    SIN_PARAM_MUTE,
    SIN_PARAM_PRE_GAIN_DB,
    SIN_PARAM_SOLO,
    SIN_PARAM_VOLUME,
)
from core.shared_dsp import resolve_and_render_graph


class TestSinNativeEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(is_native_engine_available(), "sin_dsp native binary must be built for these tests")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_tone(self, name: str, freq: float, duration_sec: float, sr: int = 44100, amp: float = 0.5) -> Path:
        n = int(round(duration_sec * sr))
        t = np.arange(n, dtype=np.float32) / float(sr)
        sig = (amp * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)
        stereo = np.stack([sig, sig], axis=1)
        path = self.root / name
        sf.write(str(path), stereo, sr)
        return path

    def test_default_48khz_and_arbitrary_sr_resampling(self) -> None:
        wav_44 = self._write_tone("tone44.wav", 440.0, 0.5, sr=44100, amp=0.5)
        graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": "auto"},
            "output": "master",
            "nodes": [
                {"id": "src-1", "type": "sample", "properties": {"filepath": str(wav_44), "sample_type": "one_shot", "stretch_mode": "off"}},
                {"id": "ch-1", "type": "track", "properties": {"chain": []}},
                {"id": "master", "type": "track", "role": "master", "properties": {"total_bars": "auto", "chain": []}},
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "ch-1", "to": "master", "type": "audio"},
            ],
        }
        # Default sample rate is 48000 Hz
        audio48, sr48, qa = resolve_and_render_graph(graph)
        self.assertEqual(sr48, SIN_DEFAULT_SAMPLE_RATE)
        self.assertEqual(audio48.shape[0], 2)
        self.assertAlmostEqual(audio48.shape[1] / float(sr48), 0.5, delta=0.01)
        self.assertFalse(qa["has_clipping"])
        self.assertGreater(float(np.max(np.abs(audio48))), 0.45)

    def test_live_param_updates_and_solo_isolation(self) -> None:
        wav_a = self._write_tone("stem_a.wav", 330.0, 0.4, sr=48000, amp=0.4)
        wav_b = self._write_tone("stem_b.wav", 880.0, 0.4, sr=48000, amp=0.25)
        graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": "auto"},
            "output": "master",
            "nodes": [
                {"id": "src-1", "type": "sample", "properties": {"filepath": str(wav_a), "sample_type": "one_shot", "stretch_mode": "off"}},
                {"id": "src-2", "type": "sample", "properties": {"filepath": str(wav_b), "sample_type": "one_shot", "stretch_mode": "off"}},
                {"id": "ch-1", "type": "track", "properties": {"chain": [{"id": "fader", "type": "gain", "enabled": True, "params": {"gain": 1.0}}]}},
                {"id": "ch-2", "type": "track", "properties": {"chain": [{"id": "fader", "type": "gain", "enabled": True, "params": {"gain": 1.0}}]}},
                {"id": "grp-1", "type": "track", "role": "group", "properties": {"chain": []}},
                {"id": "master", "type": "track", "role": "master", "properties": {"total_bars": "auto", "chain": []}},
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "src-2", "to": "ch-2", "type": "audio"},
                {"from": "ch-1", "to": "grp-1", "type": "audio"},
                {"from": "ch-2", "to": "grp-1", "type": "audio"},
                {"from": "grp-1", "to": "master", "type": "audio"},
            ],
        }
        plan = pack_canonical_graph(graph, sample_rate=48000)
        with SinAudioEngine(sample_rate=48000, offline_mode=True) as eng:
            self.assertTrue(eng.load_plan(plan))
            ch1_id = plan.bus_id_map["ch-1"]
            ch2_id = plan.bus_id_map["ch-2"]

            # Solo ch-2 and lower its volume to 0.5 => peak should be ~0.125
            eng.set_param(ch2_id, SIN_PARAM_SOLO, 1.0, ramp_ms=0.0)
            eng.set_param(ch2_id, SIN_PARAM_VOLUME, 0.5, ramp_ms=0.0)
            out, _ = eng.render_offline(total_frames=4800)
            self.assertAlmostEqual(float(np.max(np.abs(out))), 0.125, delta=0.01)

            # Live crop on ch-1 (solo ch-1, crop 0.25..0.75 => ch-1 plays 0.2s while timeline stays 0.4s due to ch-2)
            eng.set_param(ch2_id, SIN_PARAM_SOLO, 0.0, ramp_ms=0.0)
            eng.set_param(ch1_id, SIN_PARAM_SOLO, 1.0, ramp_ms=0.0)
            eng.set_param(ch1_id, SIN_PARAM_CROP_START, 0.25, ramp_ms=0.0)
            eng.set_param(ch1_id, SIN_PARAM_CROP_END, 0.75, ramp_ms=0.0)
            eng.set_param(ch1_id, SIN_PARAM_PRE_GAIN_DB, 6.0206, ramp_ms=0.0) # ~2x
            out2, _ = eng.render_offline()
            # Active cropped region [0..0.2s) has peak ~0.8; tail [0.22s..0.4s) is silent
            self.assertAlmostEqual(float(np.max(np.abs(out2[:, :9000]))), 0.8, delta=0.02)
            self.assertLess(float(np.max(np.abs(out2[:, 10500:]))), 1e-5)

            # Solo bypasses Mute: muting a soloed channel keeps it audible (~0.8)
            eng.set_param(ch1_id, SIN_PARAM_MUTE, 1.0, ramp_ms=0.0)
            out3, _ = eng.render_offline(total_frames=2400)
            self.assertAlmostEqual(float(np.max(np.abs(out3))), 0.8, delta=0.02)

            # Clearing solo restores ch-1's muted state (only ch-2 plays at 0.125),
            # and muting ch-2 as well produces silence
            eng.set_param(ch1_id, SIN_PARAM_SOLO, 0.0, ramp_ms=0.0)
            out4, _ = eng.render_offline(total_frames=2400)
            self.assertAlmostEqual(float(np.max(np.abs(out4))), 0.125, delta=0.01)

            eng.set_param(ch2_id, SIN_PARAM_MUTE, 1.0, ramp_ms=0.0)
            out5, _ = eng.render_offline(total_frames=2400)
            self.assertLess(float(np.max(np.abs(out5))), 1e-6)

    def test_native_vs_python_parity_on_canonical_graph(self) -> None:
        wav = self._write_tone("parity.wav", 440.0, 1.0, sr=44100, amp=0.6)
        graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": "auto"},
            "output": "master",
            "nodes": [
                {"id": "src-1", "type": "sample", "properties": {"filepath": str(wav), "sample_type": "one_shot", "crop_start": 0.1, "crop_end": 0.6, "stretch_mode": "off"}},
                {"id": "ch-1", "type": "track", "properties": {"chain": [
                    {"id": "pre", "type": "gain", "enabled": True, "params": {"gain_db": -6.0}},
                    {"id": "fader", "type": "gain", "enabled": True, "params": {"gain": 0.5}},
                ]}},
                {"id": "master", "type": "track", "role": "master", "properties": {"total_bars": "auto", "chain": []}},
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "ch-1", "to": "master", "type": "audio"},
            ],
        }
        native_audio, _, _ = resolve_and_render_graph(graph, sample_rate=44100)
        prev = os.environ.get("SIN_ENGINE_BACKEND")
        try:
            os.environ["SIN_ENGINE_BACKEND"] = "python"
            py_audio, _, _ = resolve_and_render_graph(graph, sample_rate=44100)
        finally:
            if prev is None:
                os.environ.pop("SIN_ENGINE_BACKEND", None)
            else:
                os.environ["SIN_ENGINE_BACKEND"] = prev

        n = min(native_audio.shape[-1], py_audio.shape[-1])
        self.assertAlmostEqual(native_audio.shape[-1], py_audio.shape[-1], delta=4)
        np.testing.assert_allclose(native_audio[:, :n], py_audio[:, :n], atol=1e-3)

    def test_realtime_audio_host_canonical_and_node_model_lifecycle(self) -> None:
        from core.realtime_host import RealtimeAudioHost

        wav = self._write_tone("rt_host.wav", 440.0, 0.4, sr=48000, amp=0.5)
        graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": "auto"},
            "output": "master",
            "nodes": [
                {"id": "src-1", "type": "sample", "properties": {"filepath": str(wav), "sample_type": "one_shot", "stretch_mode": "off"}},
                {"id": "ch-1", "type": "track", "properties": {"chain": []}},
                {"id": "master", "type": "track", "role": "master", "properties": {"total_bars": "auto", "chain": []}},
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "ch-1", "to": "master", "type": "audio"},
            ],
        }
        host = RealtimeAudioHost(name="test-host", include_scope=True)
        try:
            self.assertTrue(host.status()["available"])
            res = host.load_canonical_plan(graph)
            self.assertTrue(res["ok"])
            self.assertAlmostEqual(res["duration_sec"], 0.4, delta=0.02)
            self.assertIn("ch-1", res["bus_ids"])

            # Live parameter push should succeed for both channel and sample node aliases
            self.assertTrue(host.set_param("ch-1", "volume", 0.5, 5.0))
            self.assertTrue(host.set_param("src-1", "crop_end", 0.5, 0.0))
            self.assertFalse(host.set_param("nonexistent", "volume", 0.5, 5.0))

            # Node model load (SIN editor path) should return crisp master_peaks, per-bus peaks & manifest
            nm_res = host.load_node_model_plan({
                "node_id": 1,
                "node_name": "Master",
                "node_type": "track",
                "bpm": 120.0,
                "total_bars": 1.0,
                "children": [{
                    "node_id": 10,
                    "node_name": "Sub Bus",
                    "node_type": "track",
                    "bpm": 120.0,
                    "total_bars": 1.0,
                    "children": [{
                        "node_id": 2,
                        "node_name": "Tone",
                        "node_type": "sample",
                        "filepath": str(wav),
                        "sample_type": "one_shot",
                        "stretch_mode": "off",
                    }],
                }],
            }, compute_peaks=True, peak_columns=64)
            self.assertTrue(nm_res["ok"])
            self.assertEqual(len(nm_res["master_peaks"]), 128) # 64 [min, max] pairs
            self.assertGreater(max(abs(v) for v in nm_res["master_peaks"]), 0.4)
            self.assertIn("__monitor__", nm_res["bus_ids"])
            self.assertNotIn("__monitor__", nm_res["bus_peaks"])
            self.assertIn("1", nm_res["bus_peaks"])
            self.assertIn("10", nm_res["bus_peaks"])
            self.assertGreater(max(abs(v) for v in nm_res["bus_peaks"]["10"]), 0.4)

            # Live gain changes via set_param must mirror onto _active_plan so bus/master peaks recompute accurately
            orig_bus_max = max(abs(v) for v in nm_res["bus_peaks"]["10"])
            orig_master_max = max(abs(v) for v in nm_res["master_peaks"])
            self.assertTrue(host.set_param("10", "volume", 2.0, 0.0))
            with host._lock:
                plan_snap = host._snapshot_active_plan_locked()
            self.assertIsNotNone(plan_snap)
            updated_master_peaks, updated_bus_peaks = host._compute_plan_peaks(plan_snap, host._engine.sample_rate, 64)
            self.assertIn("10", updated_bus_peaks)
            self.assertGreater(max(abs(v) for v in updated_bus_peaks["10"]), orig_bus_max * 1.8)
            self.assertGreater(max(abs(v) for v in updated_master_peaks), orig_master_max * 1.8)

            tel_snap = host.read_telemetry()
            self.assertIn("bus_rms", tel_snap)
            self.assertIn("bus_peaks", tel_snap)

            # Sequence & Arrangement buses must also produce C++ bus_peaks
            seq_res = host.load_node_model_plan({
                "node_id": 20,
                "node_name": "SeqRoot",
                "node_type": "sequence",
                "bpm": 120.0,
                "total_bars": 1.0,
                "sequence": [1, 0, 1, 0],
                "step_length": 0.25,
                "children": [{
                    "node_id": 21,
                    "node_name": "Tone",
                    "node_type": "sample",
                    "filepath": str(wav),
                    "sample_type": "one_shot",
                    "stretch_mode": "off",
                }],
            }, compute_peaks=True, peak_columns=32)
            self.assertTrue(seq_res["ok"])
            self.assertIn("20", seq_res["bus_peaks"])
            self.assertGreater(max(abs(v) for v in seq_res["bus_peaks"]["20"]), 0.3)

            # __monitor__ mute isolates footer monitor output without touching Master node volume
            self.assertTrue(host.set_param("__monitor__", "volume", 0.5, 0.0))
            self.assertTrue(host.set_param("__monitor__", "mute", 1.0, 0.0))

            # Simple Media / single-file preview_file path must support live gain/crop & monotonic seek telemetry
            pv_res = host.preview_file(str(wav), play=False, compute_peaks=True, peak_columns=32)
            self.assertTrue(pv_res["ok"])
            self.assertEqual(len(pv_res.get("master_peaks") or []), 64)
            self.assertTrue(host.set_param("preview", "pre_gain_db", 3.0, 5.0))
            self.assertTrue(host.set_param("preview", "volume", 0.75, 5.0))
            self.assertTrue(host.set_param("preview", "crop_start", 0.1, 0.0))
            self.assertTrue(host.set_param("preview", "crop_end", 0.9, 0.0))
            seek_tel = host.set_transport(playing=False, seek_sec=0.25)
            self.assertAlmostEqual(float(seek_tel["playhead_sec"]), 0.25, delta=0.01)
            self.assertFalse(bool(seek_tel["is_playing"]))
            host.stop_and_release()
        finally:
            host.shutdown()

    def test_pack_audio_object_monitor_bus_and_chain_stages(self) -> None:
        from core.audio_object import AudioObject
        from core.audio_engine import SinAudioEngine, render_plan_offline
        from core.plan_packer import pack_audio_object
        from core.render_plan import BusSpec, ChainStageSpec, ClipSpec, SIN_PROC_GAIN, SinRenderPlan, SourceSpec
        from core.system import System

        wav_a = self._write_tone("prune_a.wav", 440.0, 0.2, sr=48000, amp=0.5)
        wav_b = self._write_tone("prune_b.wav", 880.0, 0.2, sr=48000, amp=0.5)

        sys_obj = System(bpm=120.0, sample_rate=48000)
        master = AudioObject(name="Master", node_type="track", node_id=1, total_bars=0.5)
        sample = AudioObject(filepath=str(wav_a), node_type="sample", node_id=2, sample_type="one_shot", stretch_mode="off")
        master.add_child(sample, 0.0)
        plan = pack_audio_object(master, sys_obj)
        self.assertEqual(plan.buses[0].node_key, "__monitor__")
        self.assertEqual(plan.buses[0].parent_bus_id, 0)
        self.assertEqual(plan.bus_id_map["__monitor__"], 1)
        master_bus = next(b for b in plan.buses if b.node_key == "1")
        self.assertEqual(master_bus.parent_bus_id, 1)

        # Verify SourcePool pruning releases obsolete < 90001 sources while ChainStageSpec executes
        pcm = np.ones((2, 1024), dtype=np.float32) * 0.8
        plan1 = SinRenderPlan(
            sample_rate=48000,
            sources=[SourceSpec(source_id=1, filepath=str(wav_a)), SourceSpec(source_id=2, filepath=str(wav_b))],
            buses=[BusSpec(bus_id=1, parent_bus_id=0, node_key="m")],
            clips=[ClipSpec(clip_id=1, source_id=1, target_bus_id=1), ClipSpec(clip_id=2, source_id=2, target_bus_id=1)],
        )
        plan2 = SinRenderPlan(
            sample_rate=48000,
            sources=[SourceSpec(source_id=1, pcm=pcm, sample_rate=48000, content_hash=1234)],
            buses=[BusSpec(bus_id=1, parent_bus_id=0, node_key="m")],
            clips=[ClipSpec(clip_id=1, source_id=1, target_bus_id=1, timeline_length_frames=1024)],
            stages=[ChainStageSpec(bus_id=1, stage_index=0, processor_type=SIN_PROC_GAIN, enabled=True, params=[0.5])],
        )
        with SinAudioEngine(sample_rate=48000, max_block_size=512, offline_mode=True) as eng:
            self.assertTrue(eng.load_plan(plan1))
            self.assertIsNotNone(eng.get_source_info(2))
            self.assertTrue(eng.load_plan(plan2))
            self.assertIsNone(eng.get_source_info(2))
            eng.set_stage_param(1, 0, 0, 0.25, 0.0)
            audio, _ = eng.render_offline(total_frames=512)
            np.testing.assert_allclose(audio[:, 64:], 0.2, atol=1e-4)

        audio_off, _ = render_plan_offline(plan2, total_frames=512)
        np.testing.assert_allclose(audio_off[:, 64:], 0.4, atol=1e-4)


if __name__ == "__main__":
    unittest.main()
