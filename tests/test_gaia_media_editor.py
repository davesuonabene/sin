from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from gaia import crud, integrity, media_editor, models, project_service, reference_service, schemas, vaults
from tests.support import GaiaTestCase


class TestGaiaMediaEditor(GaiaTestCase):
    def register_audio(self, name: str):
        audio_path = self.write_audio(vaults.vault_store(self.vault) / "test-inputs", name, seconds=0.2)
        return crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=self.vault.id,
                file_hash=integrity.calculate_file_hash(str(audio_path)),
                size_bytes=audio_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

    def edit_request(self, source_id: int, destination: schemas.MediaEditDestination):
        return schemas.MediaEditRequest(
            source_item_id=source_id,
            target_id=f"item:{source_id}",
            active_layer_ids=[source_id],
            destination=destination,
        )

    def test_override_target_must_be_the_selected_session_item(self):
        selected = self.register_audio("Selected.wav")
        unrelated = self.register_audio("Unrelated.wav")
        request = self.edit_request(
            selected.id,
            schemas.MediaEditDestination(mode="override", override_item_id=unrelated.id),
        )

        with self.assertRaisesRegex(ValueError, "selected editor target"):
            media_editor.validate_edit(self.db, request)

    def test_failed_override_commit_restores_the_original_file(self):
        source = self.register_audio("Original.wav")
        source_path = Path(source.absolute_path)
        original_bytes = source_path.read_bytes()
        request = self.edit_request(
            source.id,
            schemas.MediaEditDestination(mode="override", override_item_id=source.id),
        )

        with patch.object(self.db, "commit", side_effect=RuntimeError("database unavailable")):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                media_editor.render_edit(self.db, request)

        self.assertEqual(source_path.read_bytes(), original_bytes)
        self.assertFalse(any(source_path.parent.glob(".gaia-override-*")))

    def test_project_render_survives_manifest_failure_and_uses_stage_directories(self):
        source = self.register_audio("Take.wav")
        project = project_service.create_project(self.db, "Take edit", "project", self.vault.id)
        request = self.edit_request(
            source.id,
            schemas.MediaEditDestination(mode="project", project_id=project.id),
        )

        with patch.object(project_service, "sync_project_manifest", side_effect=OSError("read-only projection")):
            result = media_editor.render_edit(self.db, request)

        self.assertTrue(result["warnings"])
        self.assertTrue(Path(result["items"][0]["absolute_path"]).is_relative_to(
            Path(project.absolute_path) / "files" / "cuts"
        ))
        self.assertFalse(any((Path(project.absolute_path) / "files" / "edit").glob("edit-*.json")))
        self.assertIsNone(result["edit_item_id"])
        self.assertIsNotNone(crud.get_item(self.db, result["items"][0]["id"]))

    def test_project_render_creates_one_output_for_every_cut(self):
        source = self.register_audio("Cuts.wav")
        project = project_service.create_project(self.db, "Cut exports", "project", self.vault.id)
        request = self.edit_request(
            source.id,
            schemas.MediaEditDestination(mode="project", project_id=project.id),
        )
        request.segments = [
            schemas.MediaEditSegment(id="first", start_frame=0, end_frame=400, label="First"),
            schemas.MediaEditSegment(id="second", start_frame=400, end_frame=800, label="Second"),
        ]

        result = media_editor.render_edit(self.db, request)

        self.assertEqual(len(result["items"]), 2)
        self.assertTrue(all(
            Path(item["absolute_path"]).is_relative_to(Path(project.absolute_path) / "files" / "cuts")
            for item in result["items"]
        ))

    def test_cut_render_names_versions_and_labels_outputs_by_cut_name(self):
        source = self.register_audio("Sample.wav")
        project = project_service.create_project(self.db, "Versioned cuts", "project", self.vault.id)
        request = self.edit_request(
            source.id,
            schemas.MediaEditDestination(mode="project", project_id=project.id),
        )
        request.segments = [
            schemas.MediaEditSegment(id="loop", start_frame=0, end_frame=400, label="loop-1"),
        ]

        first = media_editor.render_edit(self.db, request)
        first_path = Path(first["items"][0]["absolute_path"])
        self.assertEqual(first_path.name, "Sample-loop-1.wav")
        first_reference = (
            self.db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.to_item_id == first["items"][0]["id"],
            )
            .one()
        )
        self.assertEqual(first_reference.revision_label, "CUT")
        self.assertEqual(
            media_editor.project_output_conflicts(self.db, request),
            [{"filename": "Sample-loop-1.wav", "cut_label": "loop-1"}],
        )

        with self.assertRaisesRegex(ValueError, "Choose New version or Override"):
            media_editor.render_edit(self.db, request)

        request.destination.existing_output = "new_version"
        versioned = media_editor.render_edit(self.db, request)
        self.assertEqual(Path(versioned["items"][0]["absolute_path"]).name, "Sample-loop-1.2.wav")

        request.destination.existing_output = "override"
        overridden = media_editor.render_edit(self.db, request)
        self.assertEqual(overridden["items"][0]["id"], first["items"][0]["id"])
        self.assertEqual(
            self.db.query(models.Item)
            .filter(models.Item.absolute_path == str(first_path.resolve()))
            .count(),
            1,
        )

    def test_waveform_range_returns_detailed_uncancelled_stereo_envelope(self):
        audio_path = self.temp_path / "Opposite polarity.wav"
        mono = np.full(1600, 0.5, dtype=np.float32)
        sf.write(audio_path, np.column_stack([mono, -mono]), self.sample_rate, subtype="FLOAT")

        waveform = media_editor.waveform_for_path(
            audio_path,
            resolution=128,
            start_frame=200,
            end_frame=600,
        )

        self.assertEqual(waveform["frames"], 1600)
        self.assertEqual(waveform["start_frame"], 200)
        self.assertEqual(waveform["end_frame"], 600)
        self.assertLessEqual(len(waveform["peaks"]), 128)
        self.assertTrue(waveform["peaks"])
        self.assertLess(waveform["peaks"][0][0], -0.49)
        self.assertGreater(waveform["peaks"][0][1], 0.49)

    def test_waveform_range_rejects_an_empty_selection(self):
        audio_path = self.write_audio(self.temp_path, "Range.wav", seconds=0.2)

        with self.assertRaisesRegex(ValueError, "range end"):
            media_editor.waveform_for_path(
                audio_path,
                start_frame=500,
                end_frame=500,
            )

    def test_zoom_multitrack_uses_child_layer_urls_and_defaults_only_source_stems_active(self):
        folder = vaults.vault_store(self.vault) / "zoom-h4"
        filenames = ("260721_194345_Tr1.WAV", "260721_194345_TrLR.WAV", "260721_194345_TrMic.WAV")
        paths = [self.write_audio(folder, filename) for filename in filenames]
        multitrack = crud.create_item(
            self.db,
            schemas.MultitrackItemCreate(
                absolute_path=str(folder.resolve()),
                vault_id=self.vault.id,
                title="Zoom H4",
                source_kind="folder",
                stems=[
                    schemas.StemInfo(
                        filename=path.name,
                        relative_path=path.name,
                        absolute_path=str(path.resolve()),
                        duration_seconds=0.1,
                    )
                    for path in paths[:2]
                ],
            ),
        )
        layers = {}
        for path, profile_role in zip(paths, ("source_channel", "mixdown", "source_channel")):
            layer = crud.create_item(
                self.db,
                schemas.AudioItemCreate(
                    absolute_path=str(path.resolve()),
                    vault_id=self.vault.id,
                    parent_id=multitrack.id,
                    attributes={"profile_role": profile_role},
                ),
            )
            layers[path.name] = layer

        self.db.expire_all()
        session = media_editor.build_editor_session(self.db, multitrack.id)
        descriptors = {layer["filename"]: layer for layer in session["editor"]["layers"]}

        self.assertEqual(set(descriptors), set(filenames))
        self.assertEqual(
            set(session["editor"]["active_layer_ids"]),
            {
                layers["260721_194345_Tr1.WAV"].id,
                layers["260721_194345_TrMic.WAV"].id,
            },
        )
        for filename, layer in layers.items():
            descriptor = descriptors[filename]
            self.assertEqual(descriptor["active"], filename != "260721_194345_TrLR.WAV")
            self.assertNotIn("profile_role", descriptor)
            self.assertEqual(descriptor["stream_url"], f"/items/{layer.id}/stream")
            self.assertEqual(descriptor["waveform_url"], f"/items/{layer.id}/waveform")

    def test_project_editor_state_updates_one_manifest_and_restores_it(self):
        source = self.register_audio("Working take.wav")
        project = project_service.create_from_items(
            self.db,
            [source.id],
            "single",
            "Working edit",
            "project",
            self.vault.id,
        )[0]
        state = schemas.MediaEditorState(
            source_item_id=source.id,
            target_id=f"item:{source.id}",
            active_layer_ids=[source.id],
            main_start_frame=100,
            main_end_frame=1200,
            segments=[
                schemas.MediaEditSegment(id="keeper", start_frame=200, end_frame=800, label="Keeper"),
            ],
            layers=[schemas.MediaEditLayer(item_id=source.id, pre_gain_db=1.5, gain_db=-2.0)],
            output_format="wav",
            view=schemas.MediaEditorViewState(
                selected_segment_id="keeper",
                waveform_zoom=4,
                view_start_frame=100,
            ),
        )

        first = media_editor.save_project_editor_state(self.db, project.id, state)
        state.layers[0].gain_db = -3.5
        second = media_editor.save_project_editor_state(self.db, project.id, state)

        state_path = Path(project.absolute_path) / "files" / "edit" / "current.json"
        self.assertTrue(state_path.is_file())
        self.assertEqual(first["schema"], "gaia-media-edit")
        self.assertEqual(second["layers"][0]["gain_db"], -3.5)
        manifest = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual((manifest["schema"], manifest["project_id"]), ("gaia-project-state", project.id))
        self.assertEqual(manifest["editor"]["layers"][0]["gain_db"], -3.5)
        self.assertEqual([entry["item"]["id"] for entry in manifest["references"]], [source.id])
        self.assertFalse(
            self.db.query(models.Item)
            .filter(models.Item.absolute_path == str(state_path.resolve()))
            .count()
        )

        session = media_editor.build_editor_session(self.db, project.id)
        self.assertEqual(session["current_target"]["id"], f"item:{source.id}")
        self.assertEqual(session["editor_state"]["segments"][0]["label"], "Keeper")
        self.assertEqual(session["editor_state"]["layers"][0]["gain_db"], -3.5)
        self.assertEqual(session["editor_state"]["view"]["waveform_zoom"], 4.0)

        media_editor.render_edit(
            self.db,
            self.edit_request(
                source.id,
                schemas.MediaEditDestination(mode="project", project_id=project.id),
            ),
        )
        restored_after_render = media_editor.build_editor_session(self.db, project.id)
        self.assertNotEqual(
            reference_service.resolve_master(self.db, project.id)["resolved_item_id"],
            source.id,
        )
        self.assertEqual(restored_after_render["current_target"]["id"], f"item:{source.id}")
        self.assertEqual(restored_after_render["editor_state"]["segments"][0]["id"], "keeper")

    def test_project_editor_state_rejects_a_target_outside_the_project(self):
        source = self.register_audio("Project source.wav")
        unrelated = self.register_audio("Unrelated source.wav")
        project = project_service.create_from_items(
            self.db,
            [source.id],
            "single",
            "Scoped edit",
            "project",
            self.vault.id,
        )[0]

        with self.assertRaisesRegex(ValueError, "not part of this session"):
            media_editor.save_project_editor_state(
                self.db,
                project.id,
                schemas.MediaEditorState(
                    source_item_id=unrelated.id,
                    target_id=f"item:{unrelated.id}",
                    active_layer_ids=[unrelated.id],
                ),
            )

    def test_failed_project_editor_state_commit_restores_the_previous_document(self):
        source = self.register_audio("Recoverable state.wav")
        project = project_service.create_from_items(
            self.db,
            [source.id],
            "single",
            "Recoverable edit",
            "project",
            self.vault.id,
        )[0]
        state = schemas.MediaEditorState(
            source_item_id=source.id,
            target_id=f"item:{source.id}",
            active_layer_ids=[source.id],
            layers=[schemas.MediaEditLayer(item_id=source.id, gain_db=-2)],
        )
        media_editor.save_project_editor_state(self.db, project.id, state)
        state_path = Path(project.absolute_path) / "files" / "edit" / "current.json"
        original = state_path.read_bytes()
        state.layers[0].gain_db = -8

        with patch.object(self.db, "commit", side_effect=RuntimeError("database unavailable")):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                media_editor.save_project_editor_state(self.db, project.id, state)

        self.assertEqual(state_path.read_bytes(), original)
