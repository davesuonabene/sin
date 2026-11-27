"""End-to-end tests for SIN 1h+ long-track tiled streaming, caching, peak pyramid,
hybrid PreampDenoise baseline, Free (-1) global bars, and native C++ LayeredTileStreamer.
"""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import time
import unittest
import numpy as np
import soundfile as sf

from core.audio_engine import SinAudioEngine, is_native_engine_available
from core.audio_object import AudioObject, SampleObject, SequenceObject
from core.plan_packer import pack_audio_object
from core.processor_nodes import PreampDenoiseObject, VoiceIsolatorObject
from core.processors.preamp_denoise import analyze_preamp, scan_preamp_global_baseline, synthesize_preamp
from core.processors.tile_cache import (
    HybridTileCache,
    PeakPyramidCache,
    TIER_COMPLEX_ML,
    TIER_FAST_DSP,
    TIER_RAW,
    TIER_STALE,
    TiledWaveformOverlay,
    compute_interleaved_peaks,
)
from core.processors.tile_scheduler import (
    TiledCookScheduler,
    TiledStageSpec,
    TiledTrackSessionSpec,
    classify_stage_tier,
)
from core.system import System


def _write_test_wav(path: Path, dur_sec: float, sr: int = 8000) -> Path:
    n = int(round(dur_sec * sr))
    t = np.arange(n, dtype=np.float32) / float(sr)
    rng = np.random.default_rng(42)
    hiss = rng.normal(0.0, 0.015, size=(2, n)).astype(np.float32)
    # Put tone in second half so quiet first half and loud second half test cross-tile baseline
    tone = np.zeros(n, dtype=np.float32)
    tone[n // 2 :] = 0.35 * np.sin(2.0 * np.pi * 440.0 * t[n // 2 :])
    audio = np.stack([tone + hiss[0], tone + hiss[1]], axis=0)
    sf.write(str(path), audio.T, sr, subtype="PCM_16")
    return path


class TestLongTrackTiling(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="sin_long_track_test_")
        self.tmp_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_hybrid_tile_cache_ram_budget_and_disk_spill(self) -> None:
        cache = HybridTileCache(cache_dir=self.tmp_dir / "cache", ram_budget_mb=32, disk_budget_gb=0.5)
        pcm = np.full((2, 8000), 0.25, dtype=np.float32)
        peaks = compute_interleaved_peaks(pcm, 32)
        cache.put_pcm_tile("synth_fp_a", 0, pcm, peaks, tier=TIER_FAST_DSP, generation=1, persist_disk=True)

        # RAM hit
        hit = cache.get_pcm_tile("synth_fp_a", 0)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.tier, TIER_FAST_DSP)
        self.assertAlmostEqual(float(hit.pcm[0, 10]), 0.25, places=4)

        # Evict RAM only and verify instant disk spill hit
        cache._pcm_ram.clear()
        cache._ram_bytes = 0
        disk_hit = cache.get_pcm_tile("synth_fp_a", 0)
        self.assertIsNotNone(disk_hit)
        self.assertAlmostEqual(float(disk_hit.pcm[0, 10]), 0.25, places=4)

        st = cache.stats()
        self.assertGreaterEqual(st["disk_entries"], 1)
        cache.clear()
        self.assertEqual(cache.stats()["ram_entries"], 0)
        self.assertEqual(cache.stats()["disk_entries"], 0)

    def test_peak_pyramid_and_dual_color_overlay(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "long_24s.wav", dur_sec=24.0, sr=8000)
        pyr_cache = PeakPyramidCache(cache_dir=self.tmp_dir / "peaks")
        pyr = pyr_cache.get_or_build(str(wav))
        self.assertIsNotNone(pyr)
        self.assertAlmostEqual(pyr.duration_sec, 24.0, places=2)

        # Zoomed viewport query (12s..18s)
        zoomed = pyr.query(12.0, 18.0, 64)
        self.assertEqual(len(zoomed), 128)
        self.assertGreater(max(abs(v) for v in zoomed), 0.2)

        # Dual-color overlay precedence: tile 0 = Fast DSP, tile 1 = Complex ML, tile 2 = Raw
        overlay = TiledWaveformOverlay(pyr, duration_sec=24.0, tile_sec=8.0, num_tiles=3)
        overlay.set_tile(0, TIER_FAST_DSP, np.full(64, 0.5, dtype=np.float32))
        overlay.set_tile(1, TIER_COMPLEX_ML, np.full(64, 0.8, dtype=np.float32))

        peaks, tiers = overlay.query_viewport(0.0, 24.0, 30)
        self.assertEqual(len(peaks), 60)
        self.assertEqual(len(tiers), 30)
        self.assertEqual(tiers[2], TIER_FAST_DSP)
        self.assertEqual(tiers[15], TIER_COMPLEX_ML)
        self.assertEqual(tiers[27], TIER_RAW)

        # Stale-hold marks cooked tiles amber without losing raw state
        overlay.mark_all_stale()
        _, stale_tiers = overlay.query_viewport(0.0, 24.0, 30)
        self.assertEqual(stale_tiers[2], TIER_STALE)
        self.assertEqual(stale_tiers[15], TIER_STALE)
        self.assertEqual(stale_tiers[27], TIER_RAW)

    def test_preamp_hybrid_global_baseline_consistency(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "preamp_base.wav", dur_sec=20.0, sr=8000)
        baseline = scan_preamp_global_baseline(
            str(wav),
            8000,
            profile_id="generic_adc",
            hp_hz=40.0,
            stft_mode="fast_single_res",
        )
        self.assertIsNotNone(baseline)
        # Analyze a loud second-half slice using the global baseline -> must not absorb tone into noise floor
        with sf.SoundFile(str(wav)) as f:
            f.seek(int(12.0 * 8000))
            loud_slice = f.read(int(4.0 * 8000), dtype="float32", always_2d=True).T
        analysis = analyze_preamp(
            loud_slice,
            8000,
            profile_id="generic_adc",
            hp_hz=40.0,
            stft_mode="fast_single_res",
            global_baseline=baseline,
        )
        out = synthesize_preamp(analysis, loud_slice, {"reduction_db": 12.0, "mix": 1.0})
        self.assertEqual(out.shape, loud_slice.shape)
        # 440 Hz tone energy must remain well-preserved (> 50% RMS of input)
        in_rms = float(np.sqrt(np.mean(loud_slice ** 2)))
        out_rms = float(np.sqrt(np.mean(out ** 2)))
        self.assertGreater(out_rms, in_rms * 0.5)

    def test_free_minus_one_bars_and_zero_ram_tiled_packing(self) -> None:
        long_wav = _write_test_wav(self.tmp_dir / "track_24s.wav", dur_sec=24.0, sr=8000)
        short_wav = _write_test_wav(self.tmp_dir / "hit_1s.wav", dur_sec=1.0, sr=8000)

        root = AudioObject(name="Master", node_id=1, node_type="track", total_bars=-1)
        long_sample = SampleObject(name="Long", node_id=2, filepath=str(long_wav), sample_type="one_shot")
        preamp = PreampDenoiseObject(name="Preamp", node_id=3, processor_params={"stft_mode": "fast_single_res"})
        preamp.add_child(long_sample, 0.0)

        loop_sample = SampleObject(name="Loop", node_id=4, filepath=str(short_wav), sample_type="loop")
        root.add_child(preamp, 0.0)
        root.add_child(loop_sample, 0.0)

        sys_obj = System(bpm=120.0, sample_rate=8000, render_mode="preview", allow_async_cook=True)
        plan = pack_audio_object(root, sys_obj)

        # Free (-1) => explicit_duration_sec == 0.0 (unconstrained auto)
        self.assertEqual(plan.explicit_duration_sec, 0.0)
        # Long Preamp chain must emit a layered SourceSpec + pending_tiled_cooks (ZERO full-file RAM decode!)
        layered_srcs = [s for s in plan.sources if s.layered_tile_frames > 0]
        self.assertEqual(len(layered_srcs), 1)
        self.assertEqual(len(sys_obj.pending_tiled_cooks), 1)
        self.assertEqual(sys_obj.pending_tiled_cooks[0].num_tiles, 3)

        # Looping sample in Free (-1) mode repeats to match the 24s longest finite source!
        loop_clips = [c for c in plan.clips if c.source_id != layered_srcs[0].source_id]
        self.assertEqual(len(loop_clips), 1)
        self.assertAlmostEqual(loop_clips[0].timeline_length_frames / 8000.0, 24.0, delta=0.1)

    def test_tiled_scheduler_fast_propagation_and_cpp_layered_publish(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "sched_24s.wav", dur_sec=24.0, sr=8000)
        cache = HybridTileCache(cache_dir=self.tmp_dir / "tcache", ram_budget_mb=64)
        published_tiles: dict[int, tuple[np.ndarray, int]] = {}
        visual_events: list[dict] = []

        eng = SinAudioEngine(sample_rate=8000, max_block_size=256, offline_mode=True) if is_native_engine_available() else None
        try:
            if eng is not None and eng.supports_layered_tiles():
                self.assertTrue(eng.register_layered_source(10, str(wav), 64000, 3, 8000, 192000))

            def _on_pub(sid: int, tidx: int, pcm: np.ndarray | None, gen: int) -> None:
                if pcm is not None:
                    published_tiles[tidx] = (pcm, gen)
                if eng is not None and eng.supports_layered_tiles():
                    eng.set_layered_tile(sid, tidx, pcm, generation=gen)

            sched = TiledCookScheduler(
                tile_cache=cache,
                on_tile_publish=_on_pub,
                on_tile_visual=lambda ev: visual_events.append(ev),
            )
            try:
                spec = TiledTrackSessionSpec(
                    source_id=10,
                    base_filepath=str(wav),
                    sample_rate=8000,
                    file_sample_rate=8000,
                    total_frames=192000,
                    duration_sec=24.0,
                    tile_sec=8.0,
                    tile_frames=64000,
                    num_tiles=3,
                    stages=[
                        TiledStageSpec(
                            node_id="3",
                            node_type="preamp_denoise",
                            node_name="Preamp",
                            processor_params={"stft_mode": "fast_single_res", "reduction_db": 12.0, "mix": 1.0},
                        )
                    ],
                )
                sched.start_session(spec, playhead_sec=0.0)
                self.assertTrue(sched.wait_for_playhead_tile(0.0, timeout_sec=5.0))
                # Wait for Fast DSP background sweep to finish all 3 tiles
                deadline = time.monotonic() + 8.0
                while len(published_tiles) < 3 and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(set(published_tiles.keys()), {0, 1, 2})

                # Live-drag fast param update (commit=False) re-synthesizes playhead tile quickly without clearing tile 2
                prev_gen = published_tiles[0][1]
                res = sched.update_param("3", "reduction_db", 20.0, commit=False)
                self.assertIsNotNone(res)
                self.assertEqual(res["mode"], "live_synth")
                deadline = time.monotonic() + 4.0
                while published_tiles[0][1] == prev_gen and time.monotonic() < deadline:
                    time.sleep(0.03)
                self.assertGreater(published_tiles[0][1], prev_gen)

                # Verify strict DSP vs. ML tier classification
                self.assertEqual(classify_stage_tier("preamp_denoise", {}), TIER_FAST_DSP)
                self.assertEqual(classify_stage_tier("voice_isolator", {"backend": "dsp_lite"}), TIER_FAST_DSP)
                self.assertEqual(classify_stage_tier("voice_isolator", {"backend": "fast_onnx"}), TIER_COMPLEX_ML)
                self.assertEqual(classify_stage_tier("voice_isolator", {"backend": "studio_hq"}), TIER_COMPLEX_ML)
            finally:
                sched.shutdown()
        finally:
            if eng is not None:
                eng.close()

    def test_cropped_tiled_track_cooks_active_window_and_emits_timeline_coordinates(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "crop_40s.wav", dur_sec=40.0, sr=8000)

        # Build Master (8 bars = 16s @ 120 BPM) <- PreampDenoise <- Sample(crop_start=0.5 => t=20s, Pre Gain -6dB)
        root = AudioObject(name="Master", node_id=1, node_type="track", total_bars=8.0)
        sample = SampleObject(
            name="LongCropped",
            node_id=2,
            filepath=str(wav),
            sample_type="one_shot",
            crop_start=0.5,
            crop_end=1.0,
        )
        sample.chain = [{"id": "pre_gain_1", "type": "gain", "enabled": True, "params": {"gain_db": -6.0}}]
        preamp = PreampDenoiseObject(name="Preamp", node_id=3, processor_params={"stft_mode": "fast_single_res"})
        preamp.add_child(sample, 0.0)
        root.add_child(preamp, 0.0)

        sys_obj = System(bpm=120.0, sample_rate=8000, render_mode="preview", allow_async_cook=True)
        plan = pack_audio_object(root, sys_obj)

        self.assertEqual(len(sys_obj.pending_tiled_cooks), 1)
        spec = sys_obj.pending_tiled_cooks[0]
        self.assertAlmostEqual(spec.crop_start, 0.5, places=4)
        self.assertAlmostEqual(spec.crop_start_sec, 20.0, places=2)
        self.assertAlmostEqual(spec.active_timeline_sec, 16.0, places=2)
        # Leaf Sample Pre Gain (-6 dB) must be preserved on the ClipSpec!
        self.assertEqual(len(plan.clips), 1)
        self.assertAlmostEqual(plan.clips[0].gain, 10.0 ** (-6.0 / 20.0), places=3)

        # Run scheduler at playhead_sec = 0.0 -> MUST cook file tile #2 (16..24s) FIRST, NOT tile #0!
        cache = HybridTileCache(cache_dir=self.tmp_dir / "crop_cache", ram_budget_mb=32)
        visual_events: list[dict] = []
        cooked_order: list[int] = []
        sched = TiledCookScheduler(
            tile_cache=cache,
            on_tile_publish=lambda sid, tidx, pcm, gen: cooked_order.append(tidx) if pcm is not None else None,
            on_tile_visual=lambda ev: visual_events.append(ev),
        )
        try:
            sched.start_session(spec, playhead_sec=0.0)
            self.assertTrue(sched.wait_for_playhead_tile(0.0, timeout_sec=5.0))
            self.assertGreaterEqual(len(cooked_order), 1)
            self.assertEqual(cooked_order[0], 2)

            # Visual tile_update for tile #2 must be mapped into TIMELINE coords [0.0 .. 4.0] (NOT file coords 16..24!)
            first_vis = next((e for e in visual_events if e.get("tile_index") == 2), None)
            self.assertIsNotNone(first_vis)
            self.assertAlmostEqual(first_vis["start_sec"], 0.0, places=3)
            self.assertAlmostEqual(first_vis["end_sec"], 4.0, places=3)
            self.assertAlmostEqual(first_vis["duration_sec"], 16.0, places=3)

            # Overlay viewport query at timeline [0..16s] must show TIER_FAST_DSP at start
            _, tiers = sched.overlay.query_viewport(0.0, 16.0, 32)
            self.assertEqual(tiers[0], TIER_FAST_DSP)

            # Bypassing must emit clear_all=True visual reset
            sched.update_param("3", "bypass", True, commit=True)
            self.assertTrue(any(e.get("clear_all") is True for e in visual_events))
        finally:
            sched.shutdown()

    def test_quick_overview_peaks_fast_and_cropped(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "quick_24s.wav", dur_sec=24.0, sr=8000)
        pyr_cache = PeakPyramidCache(cache_dir=self.tmp_dir / "qpeaks")

        quiet = pyr_cache.scan_quick_overview(str(wav), 0.0, 8.0, 64)
        loud = pyr_cache.scan_quick_overview(str(wav), 14.0, 22.0, 64)
        self.assertIsNotNone(quiet)
        self.assertIsNotNone(loud)
        self.assertEqual(len(quiet[0]), 128)
        self.assertEqual(len(loud[0]), 128)
        self.assertLess(max(abs(v) for v in quiet[0]), 0.15)
        self.assertGreater(max(abs(v) for v in loud[0]), 0.25)

    def test_audio_peaks_api_endpoint(self) -> None:
        from api import get_audio_peaks

        wav = _write_test_wav(self.tmp_dir / "api_peaks_24s.wav", dur_sec=24.0, sr=8000)
        res = get_audio_peaks(filepath=str(wav), columns=128, start_sec=12.0, end_sec=24.0)
        self.assertEqual(res["columns"], 128)
        self.assertEqual(len(res["peaks"]), 256)
        self.assertAlmostEqual(res["duration_seconds"], 24.0, places=2)
        self.assertGreater(max(abs(v) for v in res["peaks"]), 0.25)

    def test_bus_mute_solo_pan_preserved_through_packer(self) -> None:
        from core.plan_packer import pack_audio_node_model
        from ermes.py.schemas import AudioNodeModel

        model = AudioNodeModel(
            node_id=10,
            node_name="Master",
            node_type="track",
            total_bars=2.0,
            children=[
                AudioNodeModel(
                    node_id=11,
                    node_name="Drums",
                    node_type="track",
                    muted=True,
                    solo=False,
                    pan=-0.35,
                ),
                AudioNodeModel(
                    node_id=12,
                    node_name="Vocals",
                    node_type="track",
                    muted=False,
                    solo=True,
                    pan=0.25,
                ),
            ],
        )
        plan = pack_audio_node_model(model, System(bpm=120.0, sample_rate=48000, render_mode="preview"))
        bus_by_key = {b.node_key: b for b in plan.buses}
        self.assertIn("11", bus_by_key)
        self.assertIn("12", bus_by_key)
        self.assertTrue(bus_by_key["11"].muted)
        self.assertFalse(bus_by_key["11"].solo)
        self.assertAlmostEqual(bus_by_key["11"].pan, -0.35, places=3)
        self.assertFalse(bus_by_key["12"].muted)
        self.assertTrue(bus_by_key["12"].solo)
        self.assertAlmostEqual(bus_by_key["12"].pan, 0.25, places=3)

    def test_tile_visual_emits_bus_and_stage_node_ids(self) -> None:
        wav = _write_test_wav(self.tmp_dir / "scoped_24s.wav", dur_sec=24.0, sr=8000)
        cache = HybridTileCache(cache_dir=self.tmp_dir / "scoped_cache", ram_budget_mb=32)
        visual_events: list[dict] = []
        sched = TiledCookScheduler(
            tile_cache=cache,
            on_tile_visual=lambda ev: visual_events.append(ev),
        )
        try:
            spec = TiledTrackSessionSpec(
                source_id=77,
                base_filepath=str(wav),
                sample_rate=8000,
                file_sample_rate=8000,
                total_frames=192000,
                duration_sec=24.0,
                tile_sec=8.0,
                tile_frames=64000,
                num_tiles=3,
                bus_node_ids=["2", "3", "5"],
                stages=[
                    TiledStageSpec(
                        node_id="2",
                        node_type="preamp_denoise",
                        node_name="Preamp",
                        processor_params={"stft_mode": "fast_single_res"},
                    )
                ],
            )
            sched.start_session(spec, playhead_sec=0.0)
            self.assertTrue(sched.wait_for_playhead_tile(0.0, timeout_sec=5.0))
            tile_ev = next((e for e in visual_events if e.get("tile_index") == 0), None)
            self.assertIsNotNone(tile_ev)
            self.assertEqual(tile_ev.get("bus_node_ids"), ["2", "3", "5"])
            self.assertEqual(tile_ev.get("stage_node_ids"), ["2"])
        finally:
            sched.shutdown()

    def test_long_sample_bypasses_offline_stretch_and_streams_from_disk(self) -> None:
        from core.plan_packer import pack_audio_node_model
        from ermes.py.schemas import AudioNodeModel

        wav = _write_test_wav(self.tmp_dir / "long_recording_65s.wav", dur_sec=65.0, sr=8000)

        # 1. Direct long Sample with loop/120bpm defaults at global 121 BPM must NOT run offline Rubber Band
        direct_model = AudioNodeModel(
            node_id=3,
            node_name="Master Track",
            node_type="track",
            bpm=121.0,
            total_bars=-1.0,
            children=[
                AudioNodeModel(
                    node_id=1,
                    node_name="Live Rec",
                    node_type="sample",
                    filepath=str(wav),
                    sample_type="loop",
                    original_bpm=120.0,
                    bpm=121.0,
                    stretch_mode="time_stretch",
                    stretch_algorithm="rubberband",
                )
            ],
        )
        direct_sys = System(bpm=121.0, sample_rate=44100, render_mode="preview", allow_async_cook=True)
        direct_plan = pack_audio_node_model(direct_model, direct_sys)
        self.assertEqual(len(direct_plan.sources), 1)
        self.assertIsNone(direct_plan.sources[0].pcm)
        self.assertEqual(direct_plan.sources[0].filepath, str(wav))
        self.assertFalse(direct_plan.sources[0].force_ram)
        self.assertEqual(len(direct_plan.clips), 1)

        # 2. Long Sample feeding an RX processor at 121 BPM must still engage zero-RAM tiled cooking
        rx_model = AudioNodeModel(
            node_id=3,
            node_name="Master Track",
            node_type="track",
            bpm=121.0,
            total_bars=-1.0,
            children=[
                AudioNodeModel(
                    node_id=2,
                    node_name="Preamp De-Noise",
                    node_type="preamp_denoise",
                    processor_params={"stft_mode": "fast_single_res"},
                    children=[
                        AudioNodeModel(
                            node_id=1,
                            node_name="Live Rec",
                            node_type="sample",
                            filepath=str(wav),
                            sample_type="loop",
                            original_bpm=120.0,
                            bpm=121.0,
                            stretch_mode="time_stretch",
                            stretch_algorithm="rubberband",
                        )
                    ],
                )
            ],
        )
        rx_sys = System(bpm=121.0, sample_rate=44100, render_mode="preview", allow_async_cook=True)
        rx_plan = pack_audio_node_model(rx_model, rx_sys)
        self.assertEqual(len(rx_sys.pending_tiled_cooks), 1)
        self.assertIsNone(rx_plan.sources[0].pcm)
        self.assertEqual(rx_plan.sources[0].filepath, str(wav))

    def test_crop_aware_single_pass_and_tiled_rubberband_with_orthogonal_repeat_warp(self) -> None:
        from core.plan_packer import pack_audio_node_model
        from core.render_plan import SIN_CLIP_LOOP_SOURCE, SIN_CLIP_TILE_TIME_STRETCHED
        from ermes.py.schemas import AudioNodeModel

        wav = _write_test_wav(self.tmp_dir / "long_warp_40s.wav", dur_sec=40.0, sr=8000)

        # 1. Long 40s file cropped to a 4s slice (0.20..0.30) with Warp ON & Repeat OFF:
        #    MUST cook ONLY the 4s slice in a single pass (~2.67s at 1.5x), NOT all 40s!
        cropped_model = AudioNodeModel(
            node_id=10,
            node_name="CroppedWarp",
            node_type="sample",
            filepath=str(wav),
            repeat=False,
            warp=True,
            crop_start=0.20,
            crop_end=0.30,
            stretch_factor=1.5,
            stretch_algorithm="librosa",  # deterministic in CI even without rubberband.exe
        )
        crop_sys = System(bpm=120.0, sample_rate=8000, render_mode="preview", allow_async_cook=True)
        crop_plan = pack_audio_node_model(cropped_model, crop_sys)
        self.assertEqual(len(crop_plan.sources), 1)
        self.assertIsNotNone(crop_plan.sources[0].pcm)
        self.assertEqual(len(crop_sys.pending_tiled_cooks), 0)
        cooked_dur = crop_plan.sources[0].num_frames / 8000.0
        self.assertAlmostEqual(cooked_dur, 4.0 / 1.5, delta=0.15)
        self.assertEqual(crop_plan.clips[0].source_start_ratio, 0.0)
        self.assertEqual(crop_plan.clips[0].source_end_ratio, 1.0)
        self.assertEqual(crop_plan.clips[0].flags & SIN_CLIP_LOOP_SOURCE, 0)

        # 2. Long 40s file (uncropped >16s) with Warp ON -> zero-RAM Tiled Rubber Band over LayeredTileStore!
        tiled_model = AudioNodeModel(
            node_id=11,
            node_name="LongWarp",
            node_type="sample",
            filepath=str(wav),
            repeat=False,
            warp=True,
            original_bpm=100.0,
            target_bpm=125.0,
            bpm=125.0,
            stretch_algorithm="librosa",
        )
        tiled_sys = System(bpm=125.0, sample_rate=8000, render_mode="preview", allow_async_cook=True)
        tiled_plan = pack_audio_node_model(tiled_model, tiled_sys)
        self.assertEqual(len(tiled_plan.sources), 1)
        self.assertIsNone(tiled_plan.sources[0].pcm)
        self.assertGreater(tiled_plan.sources[0].layered_tile_frames, 0)
        self.assertNotEqual(tiled_plan.clips[0].flags & SIN_CLIP_TILE_TIME_STRETCHED, 0)
        self.assertEqual(len(tiled_sys.pending_tiled_cooks), 1)
        spec = tiled_sys.pending_tiled_cooks[0]
        self.assertTrue(spec.tile_time_stretched)
        self.assertAlmostEqual(spec.stretch_tempo_rate, 1.25, places=3)
        self.assertEqual(spec.stages[0].node_type, "rubberband_stretch")
        # 40s / 1.25 = 32s stretched output -> 4 tiles @ 8s
        self.assertEqual(spec.num_tiles, 4)

        # Execute tile 0 through TiledCookScheduler and verify core tile length + timeline mapping
        cache = HybridTileCache(cache_dir=self.tmp_dir / "rb_tile_cache", ram_budget_mb=32)
        cooked_tiles: dict[int, np.ndarray] = {}
        vis_events: list[dict] = []
        sched = TiledCookScheduler(
            tile_cache=cache,
            on_tile_publish=lambda sid, tidx, pcm, gen: cooked_tiles.__setitem__(tidx, pcm) if pcm is not None else None,
            on_tile_visual=lambda ev: vis_events.append(ev),
        )
        try:
            sched.start_session(spec, playhead_sec=0.0)
            self.assertTrue(sched.wait_for_playhead_tile(0.0, timeout_sec=8.0))
            self.assertIn(0, cooked_tiles)
            self.assertEqual(cooked_tiles[0].shape, (2, spec.tile_frames))
            ev0 = next((e for e in vis_events if e.get("tile_index") == 0), None)
            self.assertIsNotNone(ev0)
            self.assertAlmostEqual(ev0["start_sec"], 0.0, places=3)
            self.assertAlmostEqual(ev0["end_sec"], 8.0, places=3)
            self.assertAlmostEqual(ev0["duration_sec"], 32.0, places=2)
        finally:
            sched.shutdown()

        # 3. Warp OFF (Tape mode) with Repeat ON and original_bpm != target_bpm:
        #    Target BPM must NOT change playback_rate (only transpose/cents/stretch_factor apply)
        tape_model = AudioNodeModel(
            node_id=12,
            node_name="TapeMode",
            node_type="sample",
            filepath=str(wav),
            repeat=True,
            warp=False,
            original_bpm=90.0,
            target_bpm=140.0,
            bpm=140.0,
            transpose=12.0,  # +1 octave => 2.0x tape speed
        )
        tape_sys = System(bpm=140.0, sample_rate=8000, render_mode="preview", allow_async_cook=True)
        tape_plan = pack_audio_node_model(tape_model, tape_sys)
        self.assertEqual(len(tape_sys.pending_tiled_cooks), 0)
        self.assertIsNone(tape_plan.sources[0].pcm)
        sample_bus = next(b for b in tape_plan.buses if b.node_key == "12")
        self.assertAlmostEqual(sample_bus.playback_rate, 2.0, places=3)


if __name__ == "__main__":
    unittest.main()
