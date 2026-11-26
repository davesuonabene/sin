"""Tests for standalone PreampDenoiseObject, VoiceIsolatorObject, async cook scheduler,
Zoom/interface preamp calibration, ERMES/plan_packer integration, and export preflight.
"""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf

from core.audio_engine import is_native_engine_available, render_plan_offline
from core.audio_object import AudioObject
from core.engines import build_node_object
from core.env_config import get_env_config
from core.plan_packer import pack_audio_object
from core.processor_nodes import (
    PreampDenoiseObject,
    VoiceIsolatorObject,
    _ProcessorAnalysisStore,
    inspect_export_preflight,
)
from core.processors.cook_scheduler import ProcessorCookScheduler
from core.processors.model_manager import ModelManager
from core.processors.preamp_denoise import compute_preview_curves, find_quietest_window
from core.processors.preamp_profiles import calibrate_preamp_from_wav, list_preamp_profiles
from core.processors.voice_isolator import ModelNotInstalledError
from core.system import System
from ermes.py.compiler import compile_workspace_to_audio_node_model


def _make_pink_plus_white(rng: np.random.Generator, n: int, sr: int, fc: float = 240.0) -> np.ndarray:
    w = rng.standard_normal(n).astype(np.float64)
    spec = np.fft.rfft(w)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    shape = np.sqrt(1.0 + np.power(fc / np.maximum(freqs, 15.0), 1.15))
    y = np.fft.irfft(spec * shape, n=n)
    y = y / max(float(np.std(y)), 1e-9)
    return y.astype(np.float32)


def _snr_db(clean: np.ndarray, test: np.ndarray) -> float:
    sig_p = float(np.mean(clean.astype(np.float64) ** 2))
    err_p = float(np.mean((test.astype(np.float64) - clean.astype(np.float64)) ** 2))
    return float(10.0 * np.log10(max(sig_p, 1e-12) / max(err_p, 1e-12)))


class TestProcessorNodes(unittest.TestCase):
    def test_preamp_denoise_coincident_xy_zoom_h4_snr_and_signal_preservation(self):
        sr = 48000
        dur = 2.5
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float64) / sr
        rng = np.random.default_rng(1234)

        # Coincident X/Y clean field signal: bird-like FM chirp bursts + crisp transient impulse
        env = np.zeros(n, dtype=np.float64)
        for start_s in (0.4, 1.2, 1.9):
            i0 = int(start_s * sr)
            i1 = min(n, i0 + int(0.28 * sr))
            env[i0:i1] = np.hanning(i1 - i0)
        bird_fm = 0.25 * env * np.sin(2.0 * np.pi * (2400.0 * t + 320.0 * np.sin(2.0 * np.pi * 6.0 * t)))
        imp_idx = int(0.85 * sr)
        imp_len = 256
        imp = 0.45 * np.exp(-np.arange(imp_len) / 38.0) * np.sin(2.0 * np.pi * 1600.0 * np.arange(imp_len) / sr)
        bird_fm[imp_idx : imp_idx + imp_len] += imp

        clean = np.stack([bird_fm * 0.95, bird_fm * 1.0], axis=0).astype(np.float32)

        # Uncorrelated L/R Zoom H4 preamp thermal + 1/f noise + 60 Hz hum + 1 kHz LCD spur
        noise_l = 0.035 * _make_pink_plus_white(rng, n, sr, fc=260.0)
        noise_r = 0.035 * _make_pink_plus_white(rng, n, sr, fc=260.0)
        spurs = (0.015 * np.sin(2.0 * np.pi * 60.0 * t) + 0.015 * np.sin(2.0 * np.pi * 1000.0 * t)).astype(np.float32)
        noisy = clean + np.stack([noise_l + spurs, noise_r + spurs], axis=0)

        src = AudioObject(name="ZoomTake", audio_data=noisy, sample_type="one_shot", node_id=1, node_type="sample")
        proc = PreampDenoiseObject(
            name="Preamp",
            node_id=2,
            processor_params={
                "profile_id": "zoom_h4n_pro",
                "input_topology": "coincident_xy_stereo",
                "stft_mode": "hq_dual_res",
                "reduction_db": 22.0,
                "sensitivity": 2.0,
                "profile_weight": 0.75,
                "stereo_coherence": 0.75,
                "hp_hz": 45.0,
                "spur_notch": 0.85,
                "psychoacoustic_preserve": 0.7,
                "natural_floor": 0.05,
                "output_mode": "denoised",
            },
            analysis_store=_ProcessorAnalysisStore(),
        )
        proc.add_child(src, 0.0)

        sys_obj = System(bpm=120.0, sample_rate=sr, render_mode="offline")
        denoised = proc.render(sys_obj)

        # Measure noise floor drop during quiet regions (0.05s..0.35s)
        q0, q1 = int(0.05 * sr), int(0.35 * sr)
        noise_before = float(np.mean(noisy[:, q0:q1] ** 2))
        noise_after = float(np.mean(denoised[:, q0:q1] ** 2))
        floor_drop_db = 10.0 * np.log10(noise_before / max(noise_after, 1e-12))
        self.assertGreaterEqual(floor_drop_db, 10.0, f"Expected >= 10 dB drop, got {floor_drop_db:.2f} dB")

        # Verify non-speech bird FM chirp energy preserved (> 80% retention)
        b0, b1 = int(0.45 * sr), int(0.63 * sr)
        clean_bird_e = float(np.mean(clean[:, b0:b1] ** 2))
        den_bird_e = float(np.mean(denoised[:, b0:b1] ** 2))
        self.assertGreaterEqual(den_bird_e / max(clean_bird_e, 1e-12), 0.80)

        # Verify crisp transient peak preserved (attenuation < 2.5 dB)
        peak_clean = float(np.max(np.abs(clean[:, imp_idx - 16 : imp_idx + 128])))
        peak_den = float(np.max(np.abs(denoised[:, imp_idx - 16 : imp_idx + 128])))
        trans_loss_db = 20.0 * np.log10(peak_clean / max(peak_den, 1e-9))
        self.assertLess(trans_loss_db, 2.5, f"Transient attenuated too much: {trans_loss_db:.2f} dB")

        # Verify exact diff identity: denoised + noise_only == noisy
        proc.processor_params["output_mode"] = "noise_only"
        noise_only = proc.render(sys_obj)
        self.assertLess(float(np.max(np.abs((denoised + noise_only) - noisy))), 1e-5)

    def test_preamp_denoise_mono_dual_mono_interface_preserves_independent_channels(self):
        sr = 48000
        n = sr * 2
        t = np.arange(n, dtype=np.float64) / sr
        rng = np.random.default_rng(77)

        # Completely independent signals on L (440 Hz) and R (730 Hz) -> MSC ~ 0!
        sig_l = 0.25 * np.sin(2.0 * np.pi * 440.0 * t)
        sig_r = 0.25 * np.sin(2.0 * np.pi * 730.0 * t)
        clean = np.stack([sig_l, sig_r], axis=0).astype(np.float32)
        hiss = 0.02 * np.stack([_make_pink_plus_white(rng, n, sr, 140.0), _make_pink_plus_white(rng, n, sr, 140.0)], axis=0)
        noisy = clean + hiss

        src = AudioObject(name="InterfaceTake", audio_data=noisy, sample_type="one_shot", node_id=10, node_type="sample")
        proc = PreampDenoiseObject(
            name="USB Preamp",
            node_id=11,
            processor_params={
                "profile_id": "usb_interface",
                "input_topology": "mono_or_dual_mono",
                "stft_mode": "fast_single_res",
                "reduction_db": 18.0,
                "stereo_coherence": 1.0,  # Must be strictly ignored in mono_or_dual_mono!
                "hp_hz": 30.0,
                "spur_notch": 0.5,
            },
            analysis_store=_ProcessorAnalysisStore(),
        )
        proc.add_child(src, 0.0)
        out = proc.render(System(bpm=120.0, sample_rate=sr, render_mode="offline"))

        self.assertGreater(_snr_db(clean[0], out[0]), _snr_db(clean[0], noisy[0]) + 4.0)
        self.assertGreater(_snr_db(clean[1], out[1]), _snr_db(clean[1], noisy[1]) + 4.0)
        self.assertGreater(float(np.sqrt(np.mean(out[0] ** 2))), 0.14)
        self.assertGreater(float(np.sqrt(np.mean(out[1] ** 2))), 0.14)

    def test_preamp_calibration_roundtrip_and_preview_curves(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            sr = 48000
            n = sr * 2
            t = np.arange(n, dtype=np.float64) / sr
            rng = np.random.default_rng(99)
            hiss_l = 0.02 * _make_pink_plus_white(rng, n, sr, fc=280.0)
            hiss_r = 0.02 * _make_pink_plus_white(rng, n, sr, fc=280.0)
            spur_1k = (0.012 * np.sin(2.0 * np.pi * 1000.0 * t)).astype(np.float32)
            cal_audio = np.stack([hiss_l + spur_1k, hiss_r + spur_1k], axis=0)

            wav_path = tmp_path / "zoom_dark_take.wav"
            sf.write(str(wav_path), cal_audio.T, sr, subtype="FLOAT")

            profiles_dir = tmp_path / "preamp_profiles"
            res = calibrate_preamp_from_wav(
                wav_path,
                profile_id="my_zoom_h4_unit",
                label="My Zoom H4 (Gain 80)",
                device_family="zoom_h4",
                default_topology="coincident_xy_stereo",
                calibrated_gain_setting=80,
                output_dir=profiles_dir,
            )
            self.assertTrue(res["ok"])
            self.assertTrue(Path(res["path"]).is_file())
            self.assertTrue(any(abs(s["freq_hz"] - 1000.0) < 35.0 for s in res["spurs"]))

            listed = list_preamp_profiles(profiles_dir=profiles_dir)
            ids = [p.id for p in listed]
            self.assertIn("my_zoom_h4_unit", ids)
            self.assertIn("generic_adc", ids)

            curves = compute_preview_curves(
                cal_audio,
                sr,
                {"profile_id": "my_zoom_h4_unit", "reduction_db": 14.0},
                profiles_dir=profiles_dir,
            )
            self.assertEqual(len(curves["freqs_hz"]), 128)
            self.assertEqual(len(curves["output_db"]), 128)
            q0, q1 = find_quietest_window(cal_audio, sr, window_sec=0.5)
            self.assertTrue(0.0 <= q0 < q1 <= 1.0)

    def test_voice_isolator_zero_db_null_two_level_cache_and_missing_model_guard(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            sr = 48000
            n = sr
            t = np.arange(n, dtype=np.float64) / sr
            voice = (0.3 * np.sin(2.0 * np.pi * 220.0 * t) + 0.15 * np.sin(2.0 * np.pi * 660.0 * t)).astype(np.float32)
            amb = (0.03 * np.random.default_rng(7).standard_normal(n)).astype(np.float32)
            stereo = np.stack([voice + amb, voice + amb * 0.9], axis=0)

            with patch.dict(os.environ, {"SIN_DSP_CACHE_DIR": str(tmp_path / "dsp_cache")}, clear=False):
                store = _ProcessorAnalysisStore()
                src = AudioObject(name="Dialogue", audio_data=stereo, sample_type="one_shot", node_id=20, node_type="sample")
                iso = VoiceIsolatorObject(
                    name="VoiceIso",
                    node_id=21,
                    processor_params={
                        "backend": "dsp_lite",
                        "voice_db": 0.0,
                        "reverb_db": 0.0,
                        "ambience_db": 0.0,
                        "mask_sharpness": 0.0,
                    },
                    analysis_store=store,
                )
                iso.add_child(src, 0.0)

                cook_calls = 0
                orig_cook = iso.cook_analysis

                def _counted_cook(*args, **kwargs):
                    nonlocal cook_calls
                    cook_calls += 1
                    return orig_cook(*args, **kwargs)

                iso.cook_analysis = _counted_cook  # type: ignore[method-assign]
                sys_obj = System(bpm=120.0, sample_rate=sr, render_mode="offline")

                # 1. Exact 0 dB null test (time-domain & Wiener mode)
                out_td = iso.render(sys_obj)
                self.assertLess(float(np.max(np.abs(out_td - stereo))), 1e-5)

                iso.processor_params["mask_sharpness"] = 0.5
                out_w = iso.render(sys_obj)
                self.assertLess(float(np.max(np.abs(out_w - stereo))), 1e-5)

                # 2. Sweep faders 5x -> Level-1 cook_analysis must stay at 1!
                for v_db, r_db, a_db in [
                    (3.0, -12.0, -60.0),
                    (0.0, -60.0, -60.0),
                    (-60.0, 0.0, -60.0),
                    (1.5, -6.0, -18.0),
                    (0.0, 0.0, 0.0),
                ]:
                    iso.processor_params["voice_db"] = v_db
                    iso.processor_params["reverb_db"] = r_db
                    iso.processor_params["ambience_db"] = a_db
                    y = iso.render(sys_obj)
                    self.assertEqual(y.shape, stereo.shape)
                self.assertEqual(cook_calls, 1)

            # 3. Missing model enforcement (fast_onnx without weights installed)
            with patch.dict(
                os.environ,
                {"SIN_MODELS_DIR": str(tmp_path / "empty_models"), "SIN_PREFER_GLOBAL_MODELS": "0"},
                clear=False,
            ):
                mm = ModelManager(cfg=get_env_config(project_root=tmp_path))
                iso_missing = VoiceIsolatorObject(
                    name="VoiceMissing",
                    node_id=22,
                    processor_params={"backend": "fast_onnx"},
                    model_manager=mm,
                    analysis_store=_ProcessorAnalysisStore(),
                )
                iso_missing.add_child(src, 0.0)

                sys_prev = System(bpm=120.0, sample_rate=sr, render_mode="preview", allow_async_cook=True)
                prev_out = iso_missing.render(sys_prev)
                self.assertLess(float(np.max(np.abs(prev_out - stereo))), 1e-6)
                self.assertEqual(sys_prev.processor_statuses["22"]["state"], "model_missing")

                with self.assertRaises(ModelNotInstalledError):
                    iso_missing.render(System(bpm=120.0, sample_rate=sr, render_mode="offline"))
                bypassed_exp = iso_missing.render(
                    System(bpm=120.0, sample_rate=sr, render_mode="offline", allow_bypassed_export=True)
                )
                self.assertLess(float(np.max(np.abs(bypassed_exp - stereo))), 1e-6)

    def test_async_bypass_debounce_windowed_preview_and_manual_cook(self):
        sr = 16000
        n = sr * 5
        stereo = (0.1 * np.random.default_rng(5).standard_normal((2, n))).astype(np.float32)

        store = _ProcessorAnalysisStore()
        src = AudioObject(name="LongTake", audio_data=stereo, sample_type="one_shot", node_id=30, node_type="sample")
        proc = PreampDenoiseObject(
            name="AsyncPreamp",
            node_id=31,
            processor_params={"stft_mode": "fast_single_res", "cook_mode": "auto"},
            analysis_store=store,
        )
        proc.add_child(src, 0.0)

        t0 = time.perf_counter()
        sys_prev = System(bpm=120.0, sample_rate=sr, render_mode="preview", allow_async_cook=True, playhead_sec=1.5)
        dry_pass = proc.render(sys_prev)
        self.assertLess(time.perf_counter() - t0, 0.25)
        self.assertLess(float(np.max(np.abs(dry_pass - stereo))), 1e-6)
        self.assertEqual(sys_prev.processor_statuses["31"]["state"], "cooking_bypassed")
        self.assertEqual(len(sys_prev.pending_cooks), 1)

        seen_states: list[str] = []
        ready_ev = threading.Event()

        def _on_status(_nid: str, st: dict):
            seen_states.append(st["state"])
            if st["state"] == "ready":
                ready_ev.set()

        sched = ProcessorCookScheduler(on_status=_on_status, debounce_ms=40, preview_window_sec=2.0)
        sched.schedule(sys_prev.pending_cooks[0])
        self.assertTrue(ready_ev.wait(timeout=10.0), f"Cook never reached ready; states={seen_states}")
        self.assertIn("partial_ready", seen_states)
        self.assertEqual(seen_states[-1], "ready")

        # Manual cook mode holds stale_bypassed without enqueuing work when upstream changes
        proc.processor_params["cook_mode"] = "manual"
        proc.processor_params["hp_hz"] = 90.0
        sys_manual = System(bpm=120.0, sample_rate=sr, render_mode="preview", allow_async_cook=True)
        proc.render(sys_manual)
        self.assertEqual(sys_manual.processor_statuses["31"]["state"], "stale_bypassed")
        self.assertEqual(len(sys_manual.pending_cooks), 0)

    def test_ermes_workspace_compilation_plan_packer_and_export_preflight(self):
        with tempfile.TemporaryDirectory() as td:
            tmp_path = Path(td)
            sr = 48000
            wav_path = tmp_path / "loop.wav"
            t = np.arange(sr, dtype=np.float32) / sr
            sf.write(str(wav_path), np.stack([0.2 * np.sin(2 * np.pi * 220 * t)] * 2, axis=1), sr)

            workspace = {
                "graph": {
                    "nodes": [
                        {
                            "id": 1,
                            "type": "Audio/Sample",
                            "title": "Sample",
                            "properties": {"node_name": "Loop", "filepath": str(wav_path), "sample_type": "one_shot"},
                        },
                        {
                            "id": 2,
                            "type": "Audio/PreampDenoise",
                            "title": "Preamp De-Noise",
                            "properties": {
                                "node_name": "Zoom Cleaner",
                                "profile_id": "zoom_h4n_pro",
                                "input_topology": "coincident_xy_stereo",
                                "stft_mode": "fast_single_res",
                                "reduction_db": 12.0,
                                "bypass": True,
                            },
                        },
                        {
                            "id": 3,
                            "type": "Audio/Track",
                            "title": "Master",
                            "properties": {"node_name": "Master"},
                        },
                    ],
                    "links": [
                        [1, 1, 0, 2, 0, "audio"],
                        [2, 2, 0, 3, 0, "audio"],
                    ],
                    "extra": {"global_parameters": {"bpm": 120, "total_bars": 0}},
                }
            }

            model = compile_workspace_to_audio_node_model(workspace)
            self.assertEqual(model.node_type, "track")
            self.assertEqual(model.children[0].node_type, "preamp_denoise")
            self.assertEqual(model.children[0].processor_params["profile_id"], "zoom_h4n_pro")
            self.assertTrue(model.children[0].processor_params["bypass"])

            preflight = inspect_export_preflight(model)
            self.assertTrue(preflight["has_warnings"])
            self.assertEqual(preflight["issues"][0]["state"], "bypassed")

            root_obj = build_node_object(model)
            sys_obj = System(bpm=120.0, sample_rate=sr, render_mode="offline")
            plan = pack_audio_object(root_obj, sys_obj)
            self.assertTrue(any(b.node_type == "preamp_denoise" for b in plan.buses))
            if is_native_engine_available():
                audio_out, _ = render_plan_offline(plan, sample_rate=sr)
                self.assertEqual(audio_out.shape, (2, sr))


if __name__ == "__main__":
    unittest.main()
