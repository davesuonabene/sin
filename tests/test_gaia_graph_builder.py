"""Unit tests for GAIA canonical graph builder and topology bridge."""

import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import database, graph_builder, models, project_manifest, project_service


class TestGaiaGraphBuilder(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.vault_dir = self.root / "assets" / "vaults" / "main"
        self.vault_dir.mkdir(parents=True, exist_ok=True)

        # In-memory SQLite for test
        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(bind=self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        # Create dummy WAV file
        self.wav_path = self.vault_dir / "kick.wav"
        sr = 44100
        data = np.sin(2 * np.pi * 440 * np.linspace(0, 0.5, int(sr * 0.5))).astype(np.float32)
        sf.write(str(self.wav_path), data, sr)

        # Create Vault
        self.vault = models.Vault(id=1, name="main", storage_key="main", custom_path=str(self.vault_dir))
        self.db.add(self.vault)
        self.db.flush()

        self.item = models.SampleItem(
            id=101,
            vault_id=1,
            absolute_path=str(self.wav_path),
            type="sample",
            bpm=128,
            is_loop=False,
        )
        self.db.add(self.item)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp_dir.cleanup()

    def test_build_single_item_graph(self):
        graph = graph_builder.build_item_sin_graph(self.item.id, self.db)
        self.assertEqual(graph["format"], "sin-graph")
        self.assertEqual(graph["output"], "master")
        self.assertEqual(graph["settings"]["bpm"], 128.0)

        nodes = {n["id"]: n for n in graph["nodes"]}
        self.assertIn("src-101", nodes)
        self.assertIn("ch-101", nodes)
        self.assertIn("master", nodes)

        src_node = nodes["src-101"]
        self.assertEqual(src_node["type"], "sample")
        self.assertEqual(src_node["properties"]["crop_start"], 0.0)
        self.assertEqual(src_node["properties"]["crop_end"], 1.0)

        ch_node = nodes["ch-101"]
        self.assertEqual(ch_node["type"], "track")
        chain = ch_node["properties"]["chain"]
        self.assertEqual(len(chain), 3)
        self.assertEqual(chain[0]["id"], "pre")
        self.assertEqual(chain[1]["id"], "fader")
        self.assertEqual(chain[2]["id"], "mute")

        # Connections
        conns = graph["connections"]
        self.assertIn({"from": "src-101", "to": "ch-101", "type": "audio"}, conns)
        self.assertIn({"from": "ch-101", "to": "master", "type": "audio"}, conns)

    def test_control_map_and_updates(self):
        graph = graph_builder.build_item_sin_graph(self.item.id, self.db)
        control_map = graph_builder.get_control_map(graph)
        self.assertIn("layer:101:volume", control_map)
        self.assertIn("layer:101:mute", control_map)
        self.assertIn("layer:101:pre_gain", control_map)
        self.assertIn("layer:101:crop_start", control_map)

        updates = {
            "layer:101:volume": 0.75,
            "layer:101:mute": True,
            "layer:101:crop_start": 0.25,
        }
        updated_graph, applied = graph_builder.apply_control_updates(graph, updates)
        self.assertEqual(set(applied), set(updates.keys()))

        nodes = {n["id"]: n for n in updated_graph["nodes"]}
        self.assertEqual(nodes["src-101"]["properties"]["crop_start"], 0.25)
        ch_chain = {c["id"]: c for c in nodes["ch-101"]["properties"]["chain"]}
        self.assertEqual(ch_chain["fader"]["params"]["gain"], 0.75)
        self.assertTrue(ch_chain["mute"]["enabled"])

    def test_add_sample_and_switch_version_in_project(self):
        # Create a ProjectItem
        proj_dir = self.vault_dir / "MySong"
        proj_dir.mkdir(parents=True, exist_ok=True)
        (proj_dir / "files").mkdir(parents=True, exist_ok=True)
        (proj_dir / "files" / "derived").mkdir(parents=True, exist_ok=True)

        project = models.ProjectItem(
            id=200,
            vault_id=1,
            title="MySong",
            absolute_path=str(proj_dir),
            type="project",
            source_kind="managed",
        )
        self.db.add(project)
        self.db.commit()

        # Add sample to project
        graph = graph_builder.add_sample_to_project_graph(self.db, project, self.item)
        node_ids = [n["id"] for n in graph["nodes"]]
        self.assertIn("src-101", node_ids)
        self.assertIn("ch-101", node_ids)

        # Create a version 2 sample
        snare_wav = self.vault_dir / "snare_v2.wav"
        sf.write(str(snare_wav), np.zeros(22050, dtype=np.float32), 44100)
        snare_item = models.SampleItem(
            id=102,
            vault_id=1,
            absolute_path=str(snare_wav),
            type="sample",
            metadata_json='{"title": "Snare v2"}',
        )
        self.db.add(snare_item)
        self.db.commit()

        # Switch version on ch-101
        updated_graph = graph_builder.switch_sample_version_in_graph(
            self.db, project, "ch-101", snare_item
        )
        nodes = {n["id"]: n for n in updated_graph["nodes"]}
        self.assertEqual(nodes["src-101"]["properties"]["asset_ref"], 102)
        self.assertEqual(nodes["src-101"]["properties"]["node_name"], "Snare v2")

    def test_legacy_migration_discards_non_rendered_cuts(self):
        # Create legacy state with 1 rendered cut and 1 unrendered cut
        rendered_cut_path = self.vault_dir / "rendered_cut.wav"
        sf.write(str(rendered_cut_path), np.zeros(1000, dtype=np.float32), 44100)

        legacy_state = {
            "layers": [
                {"item_id": 101, "volume": 0.8, "pre_gain_db": 3.0, "muted": False}
            ],
            "segments": [
                {
                    "id": "cut-rendered",
                    "name": "Keep Me",
                    "start_ratio": 0.1,
                    "end_ratio": 0.5,
                    "file_path": str(rendered_cut_path),
                },
                {
                    "id": "cut-unrendered",
                    "name": "Discard Me",
                    "start_ratio": 0.6,
                    "end_ratio": 0.9,
                    "file_path": str(self.vault_dir / "non_existent.wav"),
                },
            ],
        }

        base_graph, snapshots = graph_builder.migrate_legacy_editor_state(
            legacy_state, [self.item]
        )
        # Verify layer values mapped
        ch_node = next(n for n in base_graph["nodes"] if n["id"] == "ch-101")
        ch_chain = {c["id"]: c for c in ch_node["properties"]["chain"]}
        self.assertEqual(ch_chain["fader"]["params"]["gain"], 0.8)

        # Verify only 1 snapshot kept (the rendered one), unrendered discarded
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["label"], "Keep Me")
        self.assertIn("src-101", snapshots[0]["overrides"])
        self.assertEqual(snapshots[0]["overrides"]["src-101"]["crop_start"], 0.1)


if __name__ == "__main__":
    unittest.main()
