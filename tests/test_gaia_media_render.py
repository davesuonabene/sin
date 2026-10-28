"""Integration test for GAIA media rendering with unified DSP engine."""

from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import models, graph_builder, project_service
from core.shared_dsp import resolve_and_render_graph


class TestGaiaMediaRender(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.vault_dir = self.root / "assets" / "vaults" / "main"
        self.vault_dir.mkdir(parents=True, exist_ok=True)

        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(bind=self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.vault = models.Vault(id=1, name="main", storage_key="main", custom_path=str(self.vault_dir))
        self.db.add(self.vault)
        self.db.flush()

        # Project folder
        self.proj_dir = self.vault_dir / "RockProject"
        self.proj_dir.mkdir(parents=True, exist_ok=True)
        self.files_dir = self.proj_dir / "files"
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.derived_dir = self.files_dir / "derived"
        self.derived_dir.mkdir(parents=True, exist_ok=True)

        self.project = models.ProjectItem(
            id=10,
            vault_id=1,
            title="RockProject",
            absolute_path=str(self.proj_dir),
            type="project",
            source_kind="managed",
        )
        self.db.add(self.project)
        self.db.commit()

        # Stem 1: Drums
        self.sr = 44100
        t = np.linspace(0, 0.5, int(self.sr * 0.5), endpoint=False)
        drums_data = (0.4 * np.sin(2 * np.pi * 100.0 * t)).astype(np.float32)
        drums_path = self.files_dir / "drums.wav"
        sf.write(str(drums_path), drums_data, self.sr)
        self.drum_item = models.SampleItem(
            id=101,
            vault_id=1,
            parent_id=self.project.id,
            absolute_path=str(drums_path),
            type="sample",
        )
        self.db.add(self.drum_item)

        # Stem 2: Bass
        bass_data = (0.4 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
        bass_path = self.files_dir / "bass.wav"
        sf.write(str(bass_path), bass_data, self.sr)
        self.bass_item = models.SampleItem(
            id=102,
            vault_id=1,
            parent_id=self.project.id,
            absolute_path=str(bass_path),
            type="sample",
        )
        self.db.add(self.bass_item)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp_dir.cleanup()

    def test_multitrack_render_to_derived_with_faders(self):
        # 1. Build canonical graph
        graph = graph_builder.build_item_sin_graph(self.project.id, self.db)
        self.assertEqual(graph["format"], "sin-graph")

        # 2. Adjust faders: mute bass, lower drums
        updates = {
            "layer:101:volume": 0.5,
            "layer:102:mute": True,
        }
        updated_graph, applied = graph_builder.apply_control_updates(graph, updates)
        self.assertEqual(len(applied), 2)

        # 3. Render via shared DSP
        audio_out, sr, qa = resolve_and_render_graph(
            base_graph=updated_graph,
            project_root=self.proj_dir,
            sample_rate=self.sr,
        )

        self.assertFalse(qa["has_clipping"])
        self.assertFalse(qa["is_silent"])

        # Write to files/derived/
        out_wav = self.derived_dir / "RockProject-mix.wav"
        sf.write(
            str(out_wav),
            np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
            sr,
        )

        self.assertTrue(out_wav.is_file())
        self.assertGreater(out_wav.stat().st_size, 1000)

        # Check that bass was muted (the output frequency should only have 100Hz drum, no 220Hz bass)
        read_back, _ = sf.read(str(out_wav))
        peak_amp = np.max(np.abs(read_back))
        # Drums original was 0.4, with volume 0.5 peak should be ~0.2
        self.assertAlmostEqual(peak_amp, 0.2, places=1)


if __name__ == "__main__":
    unittest.main()
