from __future__ import annotations

import struct
import datetime as dt
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from api import LibraryBpmUpdateRequest, update_library_bpm
from gaia import crud, midi_parser, models, profiles, schemas, text_analyzer, vaults
from gaia.import_jobs import ImportPreviewError, import_job_manager
from gaia.routers import items as items_router
from tests.support import GaiaTestCase


class TestGaiaLibrary(GaiaTestCase):
    def test_import_source_browser_lists_folders_and_files(self):
        source = self.temp_path / "source-browser"
        source.mkdir()
        (source / "Folder").mkdir()
        (source / ".hidden").mkdir()
        (source / "Take.wav").write_bytes(b"audio")
        (source / "Pack.zip").write_bytes(b"archive")

        result = items_router.browse_import_source(str(source))

        self.assertEqual(result["path"], str(source.resolve()))
        self.assertEqual(result["parent"], str(source.resolve().parent))
        self.assertIsNone(result["selected_path"])
        self.assertEqual([entry["name"] for entry in result["entries"]], ["Folder", "Pack.zip", "Take.wav"])
        self.assertTrue(next(entry for entry in result["entries"] if entry["name"] == "Pack.zip")["is_archive"])
        self.assertTrue(result["locations"])

    def test_import_source_browser_reveals_a_typed_file_and_rejects_missing_paths(self):
        source = self.temp_path / "source-browser-file"
        source.mkdir()
        selected = source / "Take.wav"
        selected.write_bytes(b"audio")

        result = items_router.browse_import_source(str(selected))

        self.assertEqual(result["path"], str(source.resolve()))
        self.assertEqual(result["selected_path"], str(selected.resolve()))
        with self.assertRaisesRegex(HTTPException, "does not exist"):
            items_router.browse_import_source(str(source / "missing"))

    def test_vault_storage_uses_unique_name_only_slug(self):
        vault = vaults.create_vault(self.db, "Field Recordings", None)
        self.assertEqual(vault.storage_key, "field-recordings")
        self.assertTrue(vaults.vault_store(vault).is_dir())
        with self.assertRaisesRegex(ValueError, "conflicts with an existing vault folder"):
            vaults.create_vault(self.db, "Field-Recordings", None)

    def test_vault_metadata_can_be_renamed_and_empty_vaults_can_be_deleted(self):
        vault = vaults.create_vault(self.db, "Field Recordings", "Original")
        renamed = vaults.update_vault(self.db, vault.id, "Field Takes", "Updated")
        self.assertEqual((renamed.name, renamed.description, renamed.storage_key), ("Field Takes", "Updated", "field-recordings"))

        vaults.delete_vault(self.db, renamed.id)
        self.assertIsNone(vaults.get_vault(self.db, renamed.id))
        with self.assertRaisesRegex(ValueError, "last vault"):
            vaults.delete_vault(self.db, self.vault.id)

    def test_text_analysis_midi_parsing_and_typed_crud(self):
        expectations = [
            (r"Pack\Midi Hats (130 - 150)\Midi Hat.mid", "midi", None, "none", False),
            (r"Pack\Drums\Kick C# minor.wav", "audio", None, "none", False),
            (r"Drum Kit\808\Kick 808 C.wav", "audio", None, "C", False),
            (r"Pack\Bass One Shots\Sub Bass F# minor.wav", "audio", None, "F#", False),
            (r"Pack\Melody Loops\Piano C# minor 120 BPM.wav", "audio", 120, "C#min", True),
        ]
        for path, item_type, bpm, key, is_loop in expectations:
            with self.subTest(path=path):
                analysis = text_analyzer.analyze_path(path)
                self.assertEqual(analysis["type"], item_type)
                self.assertEqual(analysis["bpm"], bpm)
                self.assertEqual(analysis["key"], key)
                self.assertEqual(analysis["is_loop"], is_loop)
        self.assertIn(
            "BPM 130-150",
            text_analyzer.analyze_path(expectations[0][0])["tags"],
        )

        events = [
            {"beat": 0.0, "velocity": 127},
            {"beat": 0.125, "velocity": 64},
            {"beat": 0.475, "velocity": 100},
        ]
        sequence, parameters = midi_parser.build_step_sequence(events)
        self.assertEqual(sequence[0], 1)
        self.assertEqual(parameters[0]["subdivisions"], 2)
        self.assertEqual(sequence[2], 1)
        self.assertAlmostEqual(parameters[2]["offset"], -0.1)

        track = (
            b"\x00\xff\x51\x03\x07\xa1\x20"
            b"\x00\xff\x59\x02\x00\x00"
            b"\x00\x90\x3c\x7f"
            b"\x00\xff\x2f\x00"
        )
        midi_path = vaults.vault_store(self.vault) / "fixtures" / "minimal.mid"
        midi_path.parent.mkdir(parents=True, exist_ok=True)
        midi_path.write_bytes(
            b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480)
            + b"MTrk" + struct.pack(">I", len(track)) + track
        )
        parsed = midi_parser.parse_midi_file(str(midi_path))
        self.assertEqual((parsed["bpm"], parsed["key"]), (120, "C"))
        self.assertEqual(parsed["sequence"][0], 1)

        item = crud.create_item(
            self.db,
            schemas.MidiItemCreate(
                absolute_path=str(midi_path),
                vault_id=self.vault.id,
                type="midi",
                bpm=120,
                key="C",
            ),
        )
        self.assertIsInstance(crud.get_item(self.db, item.id), models.MidiItem)

    def test_folder_snapshot_metadata_edit_stream_and_delete(self):
        source = self.temp_path / "source_pack"
        self.write_audio(
            source / "Melody Loops",
            "Deep Groove 120 BPM C# min.wav",
            seconds=0.2,
        )
        (source / "readme.txt").write_text("pack notes", encoding="utf-8")

        managed_before_preview = list(vaults.vault_store(self.vault).rglob("*"))
        preview = self.preview_import(source)
        self.assertEqual(self.db.query(models.Item).count(), 0, "preview must not create items")
        self.assertEqual(list(vaults.vault_store(self.vault).rglob("*")), managed_before_preview, "preview must not copy into the vault")
        job = self.start_import(preview, folder_assignments={".": "profile:sample_pack"})
        self.assertEqual(job["status"], "completed")
        collection = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(collection.source_kind, "folder")
        self.assertEqual(collection.content_count, 2)
        self.assertNotEqual(Path(collection.absolute_path), source)

        content = next(entry for entry in collection.contents if entry["streamable"])
        self.assertEqual((content["type"], content["bpm"], content["key"], content["is_loop"]), ("audio", 120, "C#min", True))
        edited = items_router.update_collection_content(
            collection.id,
            content["index"],
            schemas.CollectionContentUpdate(bpm=128, key="D minor", tags=["Dark", "Peak time"]),
            self.db,
        )
        self.assertEqual((edited["bpm"], edited["key"]), (128, "D minor"))
        self.assertEqual(edited["tags"], ["Dark", "Peak time"])
        self.assertEqual(
            items_router.stream_collection_content(collection.id, content["index"], self.db).media_type,
            "audio/wav",
        )

        snapshot_path = Path(collection.absolute_path)
        items_router.delete_item(collection.id, self.db)
        self.assertFalse(snapshot_path.exists())
        self.assertTrue(source.exists())
        self.assertTrue((source / "readme.txt").exists())

    def test_zip_and_multitrack_import_variants(self):
        archive_source = self.temp_path / "zip_source"
        archived_audio = self.write_audio(archive_source / "nested", "Loop 120 BPM.wav")
        archive_path = self.temp_path / "pack.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.write(archived_audio, "nested/Loop 120 BPM.wav")

        archive_job = self.start_import(
            self.preview_import(archive_path),
            folder_assignments={".": "profile:sample_pack"},
        )
        self.assertEqual(archive_job["status"], "completed")
        archive_item = crud.get_item(self.db, archive_job["result_items"][0]["id"])
        self.assertEqual(archive_item.source_kind, "zip")
        self.assertTrue((Path(archive_item.absolute_path) / "nested" / archived_audio.name).is_file())

        equal_stems = self.temp_path / "song_stems_120bpm_Cmaj"
        self.write_audio(equal_stems, "Drums.wav")
        self.write_audio(equal_stems, "Bass.wav")
        multitrack_job = self.start_import(
            self.preview_import(equal_stems), conflict_action="new_snapshot"
        )
        self.assertEqual(multitrack_job["status"], "completed")
        multitrack = crud.get_item(self.db, multitrack_job["result_items"][0]["id"])
        self.assertEqual(multitrack.type, "multitrack")
        self.assertTrue(multitrack.is_valid_length)
        self.assertEqual(len(multitrack.stems), 2)

        unequal_stems = self.temp_path / "unequal_stems"
        self.write_audio(unequal_stems, "Drums.wav", seconds=0.1)
        self.write_audio(unequal_stems, "Bass.wav", seconds=0.2)
        explicit_job = self.start_import(
            self.preview_import(unequal_stems),
            folder_assignments={".": "type:multitrack"},
            conflict_action="new_snapshot",
        )
        self.assertEqual(explicit_job["status"], "completed")
        explicit = crud.get_item(self.db, explicit_job["result_items"][0]["id"])
        self.assertEqual(explicit.type, "multitrack")
        self.assertFalse(explicit.is_valid_length)
        self.assertTrue(explicit.warnings)

    def test_hierarchy_duplicate_scan_and_physical_vault_move(self):
        source = self.temp_path / "hierarchy_pack"
        first = self.write_audio(source, "Kick.wav")
        self.write_audio(source, "Snare.wav")
        collection_job = self.start_import(
            self.preview_import(source),
            folder_assignments={".": "profile:sample_pack"},
        )
        collection = crud.get_item(self.db, collection_job["result_items"][0]["id"])

        top_level = items_router.read_items(db=self.db)
        all_items = items_router.read_items(include_children=True, db=self.db)
        children = [item for item in all_items if item.parent_id == collection.id]
        self.assertEqual([item.id for item in top_level], [collection.id])
        self.assertEqual(len(children), 2)
        self.assertTrue(any(Path(child.absolute_path).name == first.name for child in children))

        second_vault = vaults.create_vault(self.db, "Drums", None)
        original_root = Path(collection.absolute_path)
        moved = vaults.move_items_to_vault(self.db, [children[0].id], second_vault.id)
        self.assertEqual([collection.id], [item.id for item in moved])
        moved_collection = crud.get_item(self.db, collection.id)
        moved_children = [item for item in items_router.read_items(include_children=True, db=self.db) if item.parent_id == collection.id]
        self.assertEqual(moved_collection.vault_id, second_vault.id)
        self.assertTrue(Path(moved_collection.absolute_path).is_dir())
        self.assertFalse(original_root.exists())
        self.assertTrue(Path(moved_collection.absolute_path).is_relative_to(vaults.vault_store(second_vault)))
        self.assertTrue(all(item.vault_id == second_vault.id for item in moved_children))

    def test_batch_analysis_expands_and_updates_collection_children(self):
        source = self.temp_path / "batch_pack"
        self.write_audio(source, "Deep Groove 120 BPM C# min.wav", seconds=0.2)
        self.write_audio(source, "Kick.wav")
        collection_job = self.start_import(
            self.preview_import(source),
            folder_assignments={".": "profile:sample_pack"},
        )
        collection = crud.get_item(self.db, collection_job["result_items"][0]["id"])

        response = items_router.start_batch_analysis(
            schemas.BatchAnalysisRequest(item_ids=[collection.id]),
            self.db,
        )
        self.assertEqual((response["children_found"], response["total"]), (2, 2))
        status = self.wait_for_batch(response["task_id"])
        self.assertEqual(status["status"], "completed")
        self.assertEqual((status["completed"], status["failed"]), (2, 0))

        refreshed = crud.get_item(self.db, collection.id)
        loop_content = next(entry for entry in refreshed.contents if "Deep Groove" in entry["filename"])
        loop_child = crud.get_item(self.db, loop_content["child_id"])
        self.assertEqual(loop_child.type, "audio")
        self.assertEqual(loop_child.attributes["analysis"], {"is_loop": True, "bpm": 120, "key": "C#min"})

    def test_individual_file_imports_are_managed_and_conflicts_are_explicit(self):
        source_file = self.write_audio(
            self.temp_path / "external",
            "Groove 124 BPM.wav",
            seconds=0.2,
        )
        file_job = self.start_import(self.preview_import(source_file))
        self.assertEqual(file_job["status"], "completed")
        item = crud.get_item(self.db, file_job["result_items"][0]["id"])
        self.assertEqual((item.type, item.attributes["analysis"]["bpm"]), ("audio", 124))
        self.assertTrue(Path(item.absolute_path).is_file())
        self.assertNotEqual(Path(item.absolute_path), source_file.resolve())
        self.assertEqual(Path(item.absolute_path).parent, vaults.vault_store(self.vault) / "files")
        self.assertFalse((vaults.vault_store(self.vault) / "files" / source_file.stem).exists())

        folder = self.temp_path / "loose_folder"
        self.write_audio(folder, "Hat.wav")
        self.write_audio(folder / "nested", "Hat.wav")
        first_preview = self.preview_import(folder)
        first = self.start_import(first_preview, folder_assignments={})
        self.assertEqual((first["imported"], first["skipped"], first["excluded"]), (2, 0, 0))
        repeated_preview = self.preview_import(folder)
        self.assertTrue(repeated_preview["conflicts"])
        repeated = self.start_import(repeated_preview, folder_assignments={}, conflict_action="skip")
        self.assertEqual((repeated["imported"], repeated["skipped"]), (0, 2))
        self.assertTrue(all(item.parent_id is None for item in self.db.query(models.Item).all()))
        self.assertTrue(
            all(Path(row.absolute_path).parent == vaults.vault_store(self.vault) / "files" for row in self.db.query(models.Item).all())
        )
        self.assertTrue(
            {"Hat.wav", "Hat_2.wav"}.issubset({Path(row.absolute_path).name for row in self.db.query(models.Item).all()})
        )

    def test_deleting_loose_appledouble_item_removes_its_managed_file_and_legacy_folder(self):
        files_root = vaults.vault_store(self.vault) / "files"
        legacy_import_folder = files_root / "Live recording"
        sidecar = legacy_import_folder / "._260721_194345_Tr1.WAV"
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_bytes(b"AppleDouble metadata")
        item = crud.create_item(
            self.db,
            schemas.ItemCreate(
                absolute_path=str(sidecar.resolve()),
                vault_id=self.vault.id,
                type="item",
                size_bytes=sidecar.stat().st_size,
            ),
        )

        items_router.delete_item(item.id, self.db)

        self.assertIsNone(crud.get_item(self.db, item.id))
        self.assertFalse(sidecar.exists())
        self.assertFalse(legacy_import_folder.exists())
        self.assertTrue(files_root.is_dir())

    def test_preview_revalidation_leaves_no_staging_data_and_writes_one_job_log(self):
        source = self.temp_path / "mutable_source"
        self.write_audio(source, "Kick.wav")
        preview = self.preview_import(source)
        self.write_audio(source, "Snare.wav")

        stale = self.start_import(preview, folder_assignments={".": "profile:sample_pack"})
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(self.db.query(models.Item).count(), 0)
        self.assertFalse(any(vaults.vault_store(self.vault).rglob(".gaia-import-*.staging")))
        stale_log = Path(stale["log_path"])
        self.assertTrue(stale_log.is_file())
        self.assertIn("preview_invalidated", stale_log.read_text(encoding="utf-8"))

        pack_source = self.temp_path / "licensed_pack"
        self.write_audio(pack_source / "Audio", "Loop 120 BPM.wav")
        self.write_audio(pack_source / "Audio", "Kick.wav")
        self.write_audio(pack_source / "Audio", "Hat.wav")
        (pack_source / "LICENSE.txt").write_text("CC-BY-4.0", encoding="utf-8")
        pack_preview = self.preview_import(pack_source)
        root = next(node for node in pack_preview["nodes"] if node["relative_path"] == ".")
        self.assertEqual(root["suggested_assignment"], "profile:sample_pack")
        completed = self.start_import(
            pack_preview,
            folder_assignments={".": "profile:sample_pack"},
        )
        self.assertEqual(completed["status"], "completed")
        pack = crud.get_item(self.db, completed["result_items"][0]["id"])
        self.assertEqual(pack.type, "collection")
        self.assertEqual(pack.attributes["profile_id"], "sample_pack")
        self.assertEqual(pack.attributes["profile_label"], "Sample pack")
        self.assertTrue(pack.attributes["import"]["immutable"])
        self.assertTrue((Path(pack.absolute_path) / "LICENSE.txt").is_file())
        log = Path(completed["log_path"])
        self.assertTrue(log.is_file())
        self.assertEqual(log.parent.name, dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"))
        self.assertIn("\"event\": \"completed\"", log.read_text(encoding="utf-8"))

    def test_zoom_h4_naming_overrides_sample_pack_in_the_preview(self):
        profiles.ensure_builtin_profile_bundles()
        source = self.temp_path / "zoom-h4"
        self.write_audio(source, "260721_194345_Tr1.WAV")
        self.write_audio(source, "260721_194345_Tr2.wav")
        self.write_audio(source, "260721_194345_TrLR.wav")

        preview = self.preview_import(source)
        root = next(node for node in preview["nodes"] if node["relative_path"] == ".")
        self.assertEqual(root["detected_assignment"], "profile:zoom_h4")
        self.assertEqual(root["detection_label"], "Zoom H4")
        self.assertIn("zoom_h4", [profile["id"] for profile in preview["profiles"]])

    def test_h4_artifacts_can_be_excluded_without_losing_the_container(self):
        source = self.temp_path / "h4-with-sidecars"
        self.write_audio(source, "260721_194345_Tr1.WAV")
        self.write_audio(source, "260721_194345_TrMic.WAV")
        renamed_mix = self.write_audio(source, "260721_194345_Forest ambience.WAV")
        artifact = source / "260721_194345_TrMic.WAV.asd"
        artifact.write_bytes(b"analysis sidecar")

        preview = self.preview_import(source)
        root = next(node for node in preview["nodes"] if node["relative_path"] == ".")
        artifact_entry = next(entry for entry in preview["entries"] if entry["filename"].endswith(".asd"))
        mix_entry = next(entry for entry in preview["entries"] if entry["filename"] == renamed_mix.name)
        self.assertEqual(root["detected_assignment"], "profile:zoom_h4")
        self.assertEqual(root["warning_count"], 1)
        self.assertTrue(artifact_entry["artifact"])
        self.assertEqual(mix_entry["profile_role"], "mixdown")

        job = self.start_import(preview, excluded_indexes=[artifact_entry["index"]])
        self.assertEqual((job["status"], job["excluded"]), ("completed", 1))
        h4 = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(h4.type, "multitrack")
        self.assertFalse((Path(h4.absolute_path) / artifact.name).exists())
        self.assertTrue((Path(h4.absolute_path) / renamed_mix.name).is_file())
        managed_mix = next(child for child in h4.children if Path(child.absolute_path).name == renamed_mix.name)
        self.assertEqual(managed_mix.attributes["profile_role"], "mixdown")

    def test_preview_is_path_only_and_does_not_run_content_analysis(self):
        source = self.temp_path / "quick-preview"
        self.write_audio(source, "260721_194345_Tr1.WAV")
        self.write_audio(source, "260721_194345_TrMic.WAV")
        with (
            patch("gaia.integrity.calculate_file_hash", side_effect=AssertionError("preview hashed content")),
            patch("gaia.collection_importer.analyze_manifest_entry", side_effect=AssertionError("preview analyzed audio")),
            patch("gaia.multitrack_analyzer.analyze_multitrack_folder", side_effect=AssertionError("preview analyzed stems")),
        ):
            preview = self.preview_import(source)
        self.assertEqual(preview["file_count"], 2)
        self.assertGreaterEqual(preview["inspection_ms"], 0)
        with self.assertRaisesRegex(ImportPreviewError, "cannot be assigned type midi"):
            import_job_manager.create_job(
                schemas.ImportJobCreateRequest(
                    preview_id=preview["preview_id"],
                    item_types={0: "midi"},
                )
            )

    def test_bpm_update_uses_gaia_service_without_network_or_legacy_files(self):
        audio_path = self.write_audio(vaults.vault_store(self.vault) / "library", "Loop.wav")
        sample = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=self.vault.id,
                type="sample",
                bpm=120,
                is_loop=True,
            ),
        )

        with patch.object(urllib.request, "urlopen", side_effect=OSError("offline")):
            response = update_library_bpm(
                LibraryBpmUpdateRequest(file_id=sample.id, bpm=135.0)
            )
        self.assertEqual(response, {"status": "success", "bpm": 135.0, "updated": True})
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, sample.id).bpm, 135)

        for invalid in (10, 500):
            with self.subTest(bpm=invalid), self.assertRaises(HTTPException):
                update_library_bpm(LibraryBpmUpdateRequest(file_id=sample.id, bpm=invalid))


if __name__ == "__main__":
    unittest.main()
