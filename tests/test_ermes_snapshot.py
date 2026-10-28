"""Tests for the ERMES sin-snapshot engine."""

import unittest
from ermes.py.snapshot import apply_snapshot, diff_snapshot, validate_snapshot, SNAPSHOT_FORMAT


class TestErmesSnapshot(unittest.TestCase):
    def setUp(self):
        self.base_graph = {
            "format": "sin-graph",
            "version": 1,
            "settings": {"bpm": 120.0, "total_bars": 4.0},
            "output": "master",
            "nodes": [
                {
                    "id": "src-1",
                    "type": "sample",
                    "properties": {
                        "filepath": "files/kick.wav",
                        "crop_start": 0.0,
                        "crop_end": 1.0,
                    },
                },
                {
                    "id": "ch-1",
                    "type": "track",
                    "properties": {
                        "node_name": "Kick Bus",
                        "chain": [
                            {"id": "pre", "type": "gain", "enabled": true if hasattr(__builtins__, 'true') else True, "params": {"gain": 1.0}},
                            {"id": "fader", "type": "gain", "enabled": True, "params": {"gain": 0.8}},
                            {"id": "mute", "type": "gain", "enabled": False, "params": {"gain": 0.0}},
                        ],
                    },
                },
                {
                    "id": "master",
                    "type": "track",
                    "role": "master",
                    "properties": {"node_name": "Master Output"},
                },
            ],
            "connections": [
                {"from": "src-1", "to": "ch-1", "type": "audio"},
                {"from": "ch-1", "to": "master", "type": "audio"},
            ],
        }

    def test_apply_snapshot_overrides_properties(self):
        snapshot = {
            "format": SNAPSHOT_FORMAT,
            "version": 1,
            "id": "cut-1",
            "label": "Cut 1",
            "root": "master",
            "overrides": {
                "src-1": {"crop_start": 0.25, "crop_end": 0.75},
                "ch-1": {
                    "chain.fader.params.gain": 0.5,
                    "chain.mute.enabled": True,
                },
            },
        }

        resolved = apply_snapshot(self.base_graph, snapshot)

        # Base graph is not mutated
        self.assertEqual(self.base_graph["nodes"][0]["properties"]["crop_start"], 0.0)

        # Resolved graph has snapshot overrides
        src_props = resolved["nodes"][0]["properties"]
        self.assertEqual(src_props["crop_start"], 0.25)
        self.assertEqual(src_props["crop_end"], 0.75)

        ch_chain = resolved["nodes"][1]["properties"]["chain"]
        fader = next(m for m in ch_chain if m["id"] == "fader")
        mute = next(m for m in ch_chain if m["id"] == "mute")
        self.assertEqual(fader["params"]["gain"], 0.5)
        self.assertTrue(mute["enabled"])

    def test_apply_transient_overrides_on_top(self):
        snapshot = {
            "format": SNAPSHOT_FORMAT,
            "version": 1,
            "id": "cut-1",
            "overrides": {
                "ch-1": {"chain.fader.params.gain": 0.5},
            },
        }
        transient = {
            "ch-1": {"chain.fader.params.gain": 0.99},
        }

        resolved = apply_snapshot(self.base_graph, snapshot, transient_overrides=transient)
        fader = next(m for m in resolved["nodes"][1]["properties"]["chain"] if m["id"] == "fader")
        self.assertEqual(fader["params"]["gain"], 0.99)

    def test_diff_snapshot_computes_minimal_delta(self):
        modified = apply_snapshot(
            self.base_graph,
            {
                "overrides": {
                    "src-1": {"crop_start": 0.3},
                    "ch-1": {"chain.mute.enabled": True},
                }
            },
        )

        diff = diff_snapshot(self.base_graph, modified, "cut-diff", "Cut Diff")
        self.assertEqual(diff["format"], SNAPSHOT_FORMAT)
        self.assertEqual(diff["id"], "cut-diff")
        self.assertEqual(diff["overrides"]["src-1"], {"crop_start": 0.3})
        self.assertEqual(diff["overrides"]["ch-1"], {"chain.mute.enabled": True})

    def test_validate_snapshot(self):
        valid_snap = {
            "format": SNAPSHOT_FORMAT,
            "version": 1,
            "id": "snap-ok",
            "overrides": {"src-1": {"crop_start": 0.1}},
        }
        is_valid, errors = validate_snapshot(self.base_graph, valid_snap)
        self.assertTrue(is_valid)
        self.assertEqual(errors, [])

        invalid_snap = {
            "format": "wrong-format",
            "id": "",
            "overrides": "not-a-dict",
        }
        is_valid, errors = validate_snapshot(self.base_graph, invalid_snap)
        self.assertFalse(is_valid)
        self.assertTrue(len(errors) >= 2)


if __name__ == "__main__":
    unittest.main()
