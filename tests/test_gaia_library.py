from __future__ import annotations

import struct
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from api import LibraryBpmUpdateRequest, update_library_bpm
from gaia import crud, midi_parser, models, schemas, text_analyzer, vaults
from gaia.routers import items as items_router
from tests.support import GaiaTestCase


class TestGaiaLibrary(GaiaTestCase):
    def test_text_analysis_midi_parsing_and_typed_crud(self):
        expectations = [
            (r"Pack\Midi Hats (130 - 150)\Midi Hat.mid", "midi", None, "none"),
            (r"Pack\Drums\Kick C# minor.wav", "one_shot", None, "none"),
            (r"Drum Kit\808\Kick 808 C.wav", "one_shot", None, "C"),
            (r"Pack\Bass One Shots\Sub Bass F# minor.wav", "one_shot", None, "F#"),
            (r"Pack\Melody Loops\Piano C# minor 120 BPM.wav", "loop", 120, "C#min"),
        ]
        for path, item_type, bpm, key in expectations:
            with self.subTest(path=path):
                analysis = text_analyzer.analyze_path(path)
                self.assertEqual(analysis["type"], item_type)
                self.assertEqual(analysis["bpm"], bpm)
                self.assertEqual(analysis["key"], key)
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
        midi_path = self.temp_path / "minimal.mid"
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

        collection = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=self.vault.id),
            self.db,
        )
        self.assertEqual(collection.source_kind, "folder")
        self.assertEqual(collection.content_count, 2)
        self.assertNotEqual(Path(collection.absolute_path), source)

        content = next(entry for entry in collection.contents if entry["streamable"])
        self.assertEqual((content["type"], content["bpm"], content["key"]), ("loop", 120, "C#min"))
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

        archive_item = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(archive_path), vault_id=self.vault.id),
            self.db,
        )
        self.assertEqual(archive_item.source_kind, "zip")
        self.assertTrue((Path(archive_item.absolute_path) / "nested" / archived_audio.name).is_file())

        equal_stems = self.temp_path / "song_stems_120bpm_Cmaj"
        self.write_audio(equal_stems, "Drums.wav")
        self.write_audio(equal_stems, "Bass.wav")
        multitrack = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(equal_stems), vault_id=self.vault.id),
            self.db,
        )
        self.assertEqual(multitrack.type, "multitrack")
        self.assertTrue(multitrack.is_valid_length)
        self.assertEqual(len(multitrack.stems), 2)

        unequal_stems = self.temp_path / "unequal_stems"
        self.write_audio(unequal_stems, "Drums.wav", seconds=0.1)
        self.write_audio(unequal_stems, "Bass.wav", seconds=0.2)
        explicit = items_router.import_collection(
            schemas.CollectionImportRequest(
                source_path=str(unequal_stems),
                vault_id=self.vault.id,
                expected_type="multitrack",
            ),
            self.db,
        )
        self.assertEqual(explicit.type, "multitrack")
        self.assertFalse(explicit.is_valid_length)
        self.assertTrue(explicit.warnings)

    def test_hierarchy_duplicate_scan_and_vault_dispatch(self):
        source = self.temp_path / "hierarchy_pack"
        first = self.write_audio(source, "Kick.wav")
        self.write_audio(source, "Snare.wav")
        collection = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=self.vault.id),
            self.db,
        )

        top_level = items_router.read_items(db=self.db)
        all_items = items_router.read_items(include_children=True, db=self.db)
        children = [item for item in all_items if item.parent_id == collection.id]
        self.assertEqual([item.id for item in top_level], [collection.id])
        self.assertEqual(len(children), 2)
        self.assertIsNotNone(crud.get_item_by_path(self.db, str(first)))

        scan = items_router.scan_directory(
            schemas.DirectoryScanRequest(directory_path=str(source)),
            self.db,
        )
        self.assertEqual(scan["imported"], 0)

        second_vault = vaults.create_vault(self.db, "Drums", None)
        dispatched = crud.dispatch_items_to_vault(self.db, [children[0].id], second_vault.id)[0]
        self.assertIn(self.vault.id, dispatched.vault_ids)
        self.assertIn(second_vault.id, dispatched.vault_ids)
        updated = crud.remove_item_from_vault(self.db, dispatched.id, self.vault.id)
        self.assertNotIn(self.vault.id, updated.vault_ids)
        self.assertIn(second_vault.id, updated.vault_ids)

    def test_batch_analysis_expands_and_updates_collection_children(self):
        source = self.temp_path / "batch_pack"
        self.write_audio(source, "Deep Groove 120 BPM C# min.wav", seconds=0.2)
        self.write_audio(source, "Kick.wav")
        collection = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=self.vault.id),
            self.db,
        )

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
        self.assertEqual((loop_child.type, loop_child.bpm, loop_child.key), ("loop", 120, "C#min"))

    def test_standalone_and_items_only_imports_are_managed_and_idempotent(self):
        source_file = self.write_audio(
            self.temp_path / "external",
            "Groove 124 BPM.wav",
            seconds=0.2,
        )
        item = items_router.import_asset(
            schemas.CollectionImportRequest(
                source_path=str(source_file),
                vault_id=self.vault.id,
                expected_type="auto",
            ),
            self.db,
        )
        self.assertEqual((item.type, item.bpm), ("loop", 124))
        self.assertTrue(Path(item.absolute_path).is_file())
        self.assertNotEqual(Path(item.absolute_path), source_file.resolve())

        folder = self.temp_path / "loose_folder"
        self.write_audio(folder, "Hat.wav")
        self.write_audio(folder / "nested", "Snare.wav")
        request = schemas.CollectionImportRequest(
            source_path=str(folder),
            vault_id=self.vault.id,
            analysis_types=[],
        )
        first = items_router.import_asset(request, self.db)
        repeated = items_router.import_asset(request, self.db)
        self.assertEqual((first["type"], first["imported"], first["skipped"]), ("batch", 2, 0))
        self.assertEqual((repeated["imported"], repeated["skipped"]), (0, 2))
        self.assertTrue(all(imported.parent_id is None for imported in first["items"]))

    def test_bpm_update_uses_gaia_service_without_network_or_legacy_files(self):
        audio_path = self.write_audio(self.temp_path / "library", "Loop.wav")
        loop = crud.create_item(
            self.db,
            schemas.LoopSampleItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=self.vault.id,
                type="loop",
                bpm=120,
            ),
        )

        with patch.object(urllib.request, "urlopen", side_effect=OSError("offline")):
            response = update_library_bpm(
                LibraryBpmUpdateRequest(file_id=loop.id, bpm=135.0)
            )
        self.assertEqual(response, {"status": "success", "bpm": 135.0, "updated": True})
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, loop.id).bpm, 135)

        for invalid in (10, 500):
            with self.subTest(bpm=invalid), self.assertRaises(HTTPException):
                update_library_bpm(LibraryBpmUpdateRequest(file_id=loop.id, bpm=invalid))


if __name__ == "__main__":
    unittest.main()
