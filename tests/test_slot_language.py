"""Unit tests for the TouchDesigner-style multi-slot pseudo-language, PRNG, and multi-slot DSP."""

from __future__ import annotations

import os
import tempfile
import unittest
import numpy as np
import soundfile as sf

from ermes.py.slot_language import (
    hash_seed,
    mulberry32,
    wrap_slot_index,
    resolve_step_slots,
    resolve_cycle_seeds,
    resolve_modifier_slot_seeds,
    roll_seed_expression,
)
from ermes.py.compiler import compile_canonical_graph_to_audio_node_model
from core.audio_object import (
    SampleObject,
    SequenceObject,
    ArrangementObject,
)
from core.system import System
from core.dag_cache import DagNodeCache


class TestSlotLanguageAndMultiSlotDsp(unittest.TestCase):
    def test_prng_determinism(self):
        seed_a = hash_seed(42, 0, 1)
        seed_b = hash_seed(42, 0, 1)
        self.assertEqual(seed_a, seed_b)

        gen_a = mulberry32(seed_a)
        gen_b = mulberry32(seed_b)
        seq_a = [gen_a() for _ in range(10)]
        seq_b = [gen_b() for _ in range(10)]
        self.assertEqual(seq_a, seq_b)
        for val in seq_a:
            self.assertGreaterEqual(val, 0.0)
            self.assertLess(val, 1.0)

    def test_wrap_slot_index(self):
        self.assertEqual(wrap_slot_index(0, 1), 0)
        self.assertEqual(wrap_slot_index(5, 1), 0)
        self.assertEqual(wrap_slot_index(0, 2), 0)
        self.assertEqual(wrap_slot_index(1, 2), 1)
        self.assertEqual(wrap_slot_index(2, 2), 0)
        self.assertEqual(wrap_slot_index(3, 2), 1)

    def test_resolve_step_slots_patterns_and_modulo(self):
        # Single slot repeats across all 16 steps
        slots_single = resolve_step_slots("1", 16, 2, 42)
        self.assertEqual(slots_single, [1] * 16)

        # Overflow wraps modulo upstream slot count (1 % 1 == 0)
        slots_overflow = resolve_step_slots("1", 8, 1, 42)
        self.assertEqual(slots_overflow, [0] * 8)

        # Whitespace-separated sequence loops across 8 steps
        slots_loop = resolve_step_slots("0 1", 8, 2, 42)
        self.assertEqual(slots_loop, [0, 1, 0, 1, 0, 1, 0, 1])

        # Multi-token pattern with modulo wrap
        slots_pattern = resolve_step_slots("0 0 1 2", 8, 2, 42)
        self.assertEqual(slots_pattern, [0, 0, 1, 0, 0, 0, 1, 0])

        # 'rand' produces deterministic slots for a given seed
        rand_a = resolve_step_slots("rand", 16, 3, 42)
        rand_b = resolve_step_slots("rand", 16, 3, 42)
        self.assertEqual(rand_a, rand_b)
        self.assertTrue(all(0 <= idx < 3 for idx in rand_a))

    def test_resolve_cycle_and_modifier_seeds(self):
        # Single seed repeats across cycles, derives distinct per-slot modifier seeds
        cycles_fixed = resolve_cycle_seeds("42", 4, 1)
        self.assertEqual(cycles_fixed, [42, 42, 42, 42])

        mod_slots = resolve_modifier_slot_seeds("42", 3, 1)
        self.assertEqual(len(mod_slots), 3)
        self.assertEqual(mod_slots[0], 42)
        self.assertNotEqual(mod_slots[0], mod_slots[1])

        # Multi-seed sequence cycles deterministically
        cycles_seq = resolve_cycle_seeds("42 108", 4, 1)
        self.assertEqual(cycles_seq, [42, 108, 42, 108])

        mod_seq = resolve_modifier_slot_seeds("42 108", 4, 1)
        self.assertEqual(mod_seq, [42, 108, 42, 108])

        # 'rand' produces distinct deterministic seeds per cycle
        cycles_rand = resolve_cycle_seeds("rand", 4, 1)
        self.assertEqual(len(set(cycles_rand)), 4)

    def test_roll_seed_expression(self):
        self.assertEqual(roll_seed_expression("rand"), "rand")
        rolled_single = roll_seed_expression("42")
        self.assertTrue(rolled_single.isdigit())
        self.assertNotEqual(rolled_single, "42")

        rolled_pair = roll_seed_expression("42 108")
        parts = rolled_pair.split(" ")
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(p.isdigit() for p in parts))

    def test_dag_cache_slot_isolation(self):
        cache = DagNodeCache()
        audio_0 = np.ones((1, 100), dtype=np.float32) * 0.25
        audio_1 = np.ones((1, 100), dtype=np.float32) * 0.75
        cache.store(10, "sig_a", audio_0, slot=0)
        cache.store(10, "sig_a", audio_1, slot=1)

        got_0 = cache.get(10, "sig_a", slot=0)
        got_1 = cache.get(10, "sig_a", slot=1)
        self.assertIsNotNone(got_0)
        self.assertIsNotNone(got_1)
        self.assertAlmostEqual(float(got_0[0, 0]), 0.25)
        self.assertAlmostEqual(float(got_1[0, 0]), 0.75)

        cache.invalidate_downstream(10)
        self.assertIsNone(cache.get(10, "sig_a", slot=0))
        self.assertIsNone(cache.get(10, "sig_a", slot=1))

    def test_multi_slot_sample_sequence_and_arrangement_dsp(self):
        sr = 44100
        system = System(sample_rate=sr, bpm=120.0, render_mode="preview")

        with tempfile.TemporaryDirectory() as tmpdir:
            path_a = os.path.join(tmpdir, "slot_a.wav")
            path_b = os.path.join(tmpdir, "slot_b.wav")
            # Slot 0 has amplitude +0.2, Slot 1 has amplitude +0.8
            sf.write(path_a, np.full((sr, 1), 0.2, dtype=np.float32), sr)
            sf.write(path_b, np.full((sr, 1), 0.8, dtype=np.float32), sr)

            sample_obj = SampleObject(
                filepath=path_a,
                sample_type="one_shot",
                slots=[
                    {"index": 0, "filepath": path_a, "sample_start": 0.0, "sample_end": 1.0},
                    {"index": 1, "filepath": path_b, "sample_start": 0.0, "sample_end": 1.0},
                ],
                node_id=1,
            )

            buf_0 = sample_obj.render_slot(0, system)
            buf_1 = sample_obj.render_slot(1, system)
            self.assertGreater(float(np.max(np.abs(buf_1))), float(np.max(np.abs(buf_0))) * 2.0)

            # Sequence with 2 slots:
            # Sequence Slot 0 triggers Sample Slot 0 on beat 0
            # Sequence Slot 1 triggers Sample Slot 1 on beat 0
            seq_obj = SequenceObject(
                sequence=[1, 0, 0, 0],
                step_length=1.0,
                total_bars=1.0,
                sample_slot="0",
                slots=[
                    {"index": 0, "sequence": [1, 0, 0, 0], "sample_slot": "0", "step_length": 1.0},
                    {"index": 1, "sequence": [1, 0, 0, 0], "sample_slot": "1", "step_length": 1.0},
                ],
                node_id=2,
            )
            seq_obj.add_child(sample_obj, 0.0)

            # Arrangement with 2 sections across 2 bars:
            # Section 0 (bar 0..1) selects Sequence Slot 0
            # Section 1 (bar 1..2) selects Sequence Slot 1
            arr_obj = ArrangementObject(
                total_bars=2.0,
                section_points=[1.0],
                section_slots=[0, 1],
                node_id=3,
            )
            arr_obj.add_child(seq_obj, 0.0)

            rendered = arr_obj.render(system)
            flat_rendered = rendered.reshape(-1) if rendered.ndim == 1 else np.max(np.abs(rendered), axis=0)
            bar_samples = int(4 * (60.0 / 120.0) * sr)
            peak_bar_0 = float(np.max(np.abs(flat_rendered[:bar_samples // 4])))
            peak_bar_1 = float(np.max(np.abs(flat_rendered[bar_samples:bar_samples + bar_samples // 4])))
            self.assertGreater(peak_bar_1, peak_bar_0 * 2.0)

    def test_compiler_resolves_slots_and_random_modulations(self):
        doc = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": 4.0, "key": "C"},
            "output": "seq1",
            "nodes": [
                {
                    "id": "kick",
                    "type": "sample",
                    "name": "Kick",
                    "properties": {
                        "filepath": "kick0.wav",
                        "slots": [
                            {"index": 0, "filepath": "kick0.wav"},
                            {"index": 1, "filepath": "kick1.wav"},
                        ],
                    },
                },
                {
                    "id": "seq1",
                    "type": "sequence",
                    "name": "Seq",
                    "properties": {
                        "sample_slot": "0 1",
                        "seed": "42 108",
                        "sequence": [1, 0, 1, 0],
                        "slots": [
                            {"index": 0, "sequence": [1, 0, 1, 0]},
                            {"index": 1, "sequence": [1, 1, 1, 1]},
                        ],
                    },
                },
                {
                    "id": "rnd1",
                    "type": "random",
                    "name": "Rnd",
                    "properties": {
                        "seed": "42 108",
                        "destinations": [
                            {
                                "id": "d1",
                                "paramKey": "velocity",
                                "paramLabel": "Velocity",
                                "minPercent": -50,
                                "maxPercent": 0,
                                "baseValue": 1.0,
                                "enabled": True,
                            }
                        ],
                    },
                },
            ],
            "connections": [
                {"from": "kick", "to": "seq1", "type": "audio"},
            ],
            "attachments": [
                {"owner": "seq1", "modifier": "rnd1", "type": "random"},
            ],
        }
        compiled = compile_canonical_graph_to_audio_node_model(doc)
        self.assertEqual(compiled.step_slots[:4], [0, 1, 0, 1])
        self.assertEqual(compiled.cycle_seeds[:2], [42, 108])
        # Slot 0 and Slot 1 of Sequence should have distinct modulated velocities from seeds 42 and 108
        vel_slot_0 = [s["velocity"] for s in compiled.slots[0]["step_parameters"]]
        vel_slot_1 = [s["velocity"] for s in compiled.slots[1]["step_parameters"]]
        self.assertNotEqual(vel_slot_0, vel_slot_1)

    def test_item_pool_handles_string_and_rand_seeds_and_sample_manifest_preserves_slot_0(self):
        from core.audio_object import ItemPoolObject

        pool = ItemPoolObject(
            selected_items=[
                {"id": 1, "filepath": "a.wav"},
                {"id": 2, "filepath": "b.wav"},
                {"id": 3, "filepath": "c.wav"},
            ],
            playback_mode="Sequential",
            seed="rand",
        )
        first_pick = pool.getNextSample(advance=True)
        second_pick = pool.getNextSample(advance=True)
        self.assertIn(first_pick, {"a.wav", "b.wav", "c.wav"})
        self.assertIn(second_pick, {"a.wav", "b.wav", "c.wav"})
        self.assertNotEqual(first_pick, second_pick)

        sr = 44100
        system = System(sample_rate=sr, bpm=120.0, render_mode="preview")
        with tempfile.TemporaryDirectory() as tmpdir:
            path_a = os.path.join(tmpdir, "slot_a.wav")
            path_b = os.path.join(tmpdir, "slot_b.wav")
            sf.write(path_a, np.full((sr // 10, 1), 0.25, dtype=np.float32), sr)
            sf.write(path_b, np.full((sr // 10, 1), 0.75, dtype=np.float32), sr)

            sample_obj = SampleObject(
                filepath=path_a,
                sample_type="one_shot",
                slots=[
                    {"slot": 0, "filepath": path_a, "crop_start": 0.0, "crop_end": 1.0},
                    {"slot": 1, "filepath": path_b, "crop_start": 0.0, "crop_end": 1.0},
                ],
                node_id=99,
            )
            sample_obj.render_slot(1, system)
            manifest_entry = system.manifest.get("nodes", {}).get("99", {})
            self.assertEqual(manifest_entry.get("filepath"), path_a)
            self.assertTrue(manifest_entry.get("is_dynamic_pool"))


if __name__ == "__main__":
    unittest.main()
