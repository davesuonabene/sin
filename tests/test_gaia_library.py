from __future__ import annotations

import asyncio
import struct
import datetime as dt
import threading
import unittest
import urllib.request
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from mutagen.id3 import TALB, TCON, TIT2, TPE1, TRCK
from mutagen.wave import WAVE
from sqlalchemy import event

from api import (
    LibraryBpmUpdateRequest,
    LibraryFavouriteUpdateRequest,
    update_library_bpm,
    update_library_favourite,
)
from gaia import collection_importer, crud, deletion_service, import_jobs as import_jobs_module, midi_parser, models, profiles, schemas, text_analyzer, vaults
from gaia.import_jobs import ImportPreviewError, import_job_manager
from gaia.routers import items as items_router, sin_proposals as sin_proposals_router
from tests.support import GaiaTestCase


class TestGaiaLibrary(GaiaTestCase):
    def test_sin_metadata_proposal_is_staged_until_gaia_accepts_it(self):
        audio_path = self.write_audio(vaults.vault_store(self.vault) / "library", "StagedLoop.wav")
        sample = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=self.vault.id,
                type="sample",
                bpm=120,
                key="C",
                is_loop=True,
            ),
        )

        first = sin_proposals_router.create_metadata_proposal(
            schemas.SinMetadataProposalCreate(
                asset_ref=str(sample.id),
                absolute_path=sample.absolute_path,
                field="bpm",
                proposed_value=128,
                previous_value=120,
                source_node_id=9,
            ),
            self.db,
        )
        replacement = sin_proposals_router.create_metadata_proposal(
            schemas.SinMetadataProposalCreate(
                asset_ref=str(sample.id),
                absolute_path=sample.absolute_path,
                field="bpm",
                proposed_value=130,
                previous_value=128,
                source_node_id=9,
            ),
            self.db,
        )

        self.assertEqual(first["id"], replacement["id"])
        self.assertEqual(replacement["status"], "pending")
        self.assertEqual(replacement["proposed_value"], 130)
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, sample.id).bpm, 120)

        accepted = sin_proposals_router.accept_metadata_proposal(replacement["id"], self.db)
        self.assertEqual(accepted["status"], "accepted")
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, sample.id).bpm, 130)

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

    def test_vault_can_use_a_custom_path_and_lazy_loading_policy(self):
        custom_path = self.temp_path / "external-vault"
        (custom_path / "another-vault").mkdir(parents=True)
        vault = vaults.create_vault(
            self.db,
            "External recordings",
            None,
            str(custom_path),
            "lazy",
        )

        self.assertEqual(vault.preview, "lazy")
        expected_store = (custom_path / "external-recordings").resolve()
        self.assertEqual(vault.root_path, str(custom_path.resolve()))
        self.assertEqual(vault.path, str(expected_store))
        self.assertEqual(vaults.vault_store(vault), expected_store)
        self.assertTrue(expected_store.is_dir())
        self.assertNotIn(vault.id, [row.id for row in vaults.get_vaults(self.db) if row.preview == "quick"])

    def test_vault_migration_moves_files_and_rewrites_tracked_paths(self):
        source = self.temp_path / "custom-source"
        vault = vaults.create_vault(self.db, "Portable", None, str(source), "hidden")
        audio_path = self.write_audio(vaults.vault_store(vault) / "files", "Take.wav")
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=vault.id,
                attributes={"preview_path": str(audio_path.resolve())},
            ),
        )
        target = self.temp_path / "custom-target"
        target.mkdir()

        migrated = vaults.migrate_vault(self.db, vault.id, str(target))
        self.db.expire_all()
        refreshed = crud.get_item(self.db, item.id)

        self.assertEqual(migrated.preview, "hidden")
        migrated_store = (target / "portable").resolve()
        self.assertEqual(migrated.root_path, str(target.resolve()))
        self.assertEqual(migrated.path, str(migrated_store))
        self.assertFalse((source / "portable").exists())
        self.assertTrue((migrated_store / "files" / "Take.wav").is_file())
        self.assertEqual(refreshed.absolute_path, str((migrated_store / "files" / "Take.wav").resolve()))
        self.assertEqual(refreshed.attributes["preview_path"], refreshed.absolute_path)

    def test_legacy_custom_vault_folder_is_upgraded_into_its_storage_root(self):
        root = self.temp_path / "legacy-root"
        root.mkdir()
        legacy_file = self.write_audio(root / "files", "Legacy.wav")
        legacy = models.Vault(
            name="Legacy archive",
            storage_key="legacy-archive",
            custom_path=str(root),
            custom_layout="vault",
            preview="quick",
        )
        self.db.add(legacy)
        self.db.commit()
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(legacy_file.resolve()),
                vault_id=legacy.id,
                attributes={"managed_copy": str(legacy_file.resolve())},
            ),
        )

        vaults.migrate_custom_vault_layouts(self.db)
        self.db.expire_all()
        upgraded = vaults.get_vault(self.db, legacy.id)
        refreshed = crud.get_item(self.db, item.id)
        expected = (root / "legacy-archive" / "files" / "Legacy.wav").resolve()

        self.assertEqual(upgraded.custom_layout, "root")
        self.assertEqual(upgraded.root_path, str(root.resolve()))
        self.assertEqual(upgraded.path, str((root / "legacy-archive").resolve()))
        self.assertTrue(expected.is_file())
        self.assertEqual(refreshed.absolute_path, str(expected))
        self.assertEqual(refreshed.attributes["managed_copy"], str(expected))

    def test_quick_summary_scope_does_not_hydrate_lazy_or_hidden_vaults(self):
        quick_file = self.write_audio(vaults.vault_store(self.vault) / "files", "Quick.wav")
        quick_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(quick_file.resolve()), vault_id=self.vault.id),
        )
        lazy = vaults.create_vault(self.db, "Slow archive", None, None, "lazy")
        lazy_file = self.write_audio(vaults.vault_store(lazy) / "files", "Lazy.wav")
        lazy_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(lazy_file.resolve()), vault_id=lazy.id),
        )

        automatic = crud.get_item_summaries(self.db, limit=100, vault_preview="quick")
        explicit = crud.get_item_summaries(self.db, limit=100, vault_id=lazy.id)

        self.assertEqual([row["id"] for row in automatic], [quick_item.id])
        self.assertEqual([row["id"] for row in explicit], [lazy_item.id])

    def test_vault_metadata_can_be_renamed_and_empty_vaults_can_be_deleted(self):
        vault = vaults.create_vault(self.db, "Field Recordings", "Original")
        renamed = vaults.update_vault(self.db, vault.id, "Field Takes", "Updated")
        self.assertEqual((renamed.name, renamed.description, renamed.storage_key), ("Field Takes", "Updated", "field-recordings"))

        vaults.delete_vault(self.db, renamed.id)
        self.assertIsNone(vaults.get_vault(self.db, renamed.id))
        with self.assertRaisesRegex(ValueError, "last vault"):
            vaults.delete_vault(self.db, self.vault.id)

    def test_vault_delete_can_atomically_purge_more_than_one_thousand_items(self):
        doomed = vaults.create_vault(self.db, "Large disposable vault", None)
        store = vaults.vault_store(doomed)
        physical_file = store / "files" / "present.wav"
        physical_file.parent.mkdir(parents=True)
        physical_file.write_bytes(b"test")
        crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(physical_file.resolve()),
                vault_id=doomed.id,
                size_bytes=physical_file.stat().st_size,
                mime_type="audio/wav",
            ),
        )
        self.db.bulk_insert_mappings(
            models.Item,
            [
                {
                    "absolute_path": str(
                        (store / "files" / f"asset-{index}.wav").resolve()
                    ),
                    "vault_id": doomed.id,
                    "type": "item",
                    "metadata_json": "{}",
                }
                for index in range(1001)
            ],
        )
        self.db.commit()

        vaults.delete_vault(self.db, doomed.id, delete_contents=True)

        self.assertIsNone(
            self.db.query(models.Vault).filter(models.Vault.id == doomed.id).first()
        )
        self.assertEqual(
            self.db.query(models.Item).filter(models.Item.vault_id == doomed.id).count(),
            0,
        )
        self.assertFalse(store.exists())

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

    def test_import_preserves_original_sources(self):
        source = self.temp_path / "nested-source-pack"
        original = self.write_audio(source / "Drums" / "Kicks", "Kick.wav")

        collection_job = self.start_import(
            self.preview_import(source),
            folder_assignments={".": "profile:sample_pack"},
        )
        self.assertEqual(collection_job["status"], "completed")
        collection = crud.get_item(self.db, collection_job["result_items"][0]["id"])
        content = collection.contents[0]
        child = crud.get_item(self.db, content["child_id"])

        self.assertEqual(content["source_path"], str(original.resolve()))
        self.assertEqual(child.attributes["import"]["source_path"], str(original.resolve()))
        self.assertNotEqual(Path(child.absolute_path), original.resolve())

        loose_source = self.temp_path / "normal-folder"
        loose_original = self.write_audio(loose_source / "Percussion" / "Closed Hats", "Hat.wav")
        loose_job = self.start_import(self.preview_import(loose_source), folder_assignments={})
        loose = crud.get_item(self.db, loose_job["result_items"][0]["id"])

        self.assertEqual(loose.source_path, str(loose_original.resolve()))
        self.assertEqual(crud.item_summary(loose)["source_path"], str(loose_original.resolve()))
        self.assertNotEqual(Path(loose.absolute_path), loose_original.resolve())

        with self.assertRaises(ValueError):
            schemas.ItemUpdate.model_validate({"source_path": "changed"})
        with self.assertRaises(ValueError):
            schemas.CollectionContentUpdate.model_validate({"source_path": "changed"})
        with self.assertRaises(HTTPException) as immutable:
            items_router.update_item(
                loose.id,
                schemas.ItemUpdate(attributes={"import": {"source_path": "changed"}}),
                self.db,
            )
        self.assertEqual(immutable.exception.detail, "An imported asset's source is immutable")
        updated = items_router.update_item(
            loose.id,
            schemas.ItemUpdate(attributes={"custom": "value"}),
            self.db,
        )
        self.assertEqual(updated.attributes["import"]["source_path"], str(loose_original.resolve()))

    def test_large_folder_import_batches_post_copy_work(self):
        source = self.temp_path / "large-folder"
        for index in range(1001):
            path = source / f"Group {index % 10}" / f"asset-{index:04d}.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(index), encoding="utf-8")

        def analyzed(_root, entry):
            return {
                **entry,
                "title": Path(entry["filename"]).stem,
                "type": "file",
                "tags": [],
                "streamable": False,
            }

        with (
            patch("gaia.collection_importer.analyze_manifest_entry", side_effect=analyzed),
            patch("gaia.integrity.calculate_file_hash", return_value="test-hash"),
        ):
            preview = self.preview_import(source)
            queued = import_job_manager.create_job(
                schemas.ImportJobCreateRequest(preview_id=preview["preview_id"])
            )
            job = self.wait_for_import(queued["job_id"], timeout=30.0)

        self.assertEqual((job["status"], job["completed"], job["total"]), ("completed", 1001, 1001))
        self.assertEqual(self.db.query(models.Item).count(), 1001)
        self.assertEqual(self.db.query(models.VaultImportLog).count(), 1001)
        imported = self.db.query(models.Item).filter(models.Item.absolute_path.like("%asset-0000.txt")).one()
        self.assertEqual(imported.attributes["import"]["source_path"], str((source / "Group 0" / "asset-0000.txt").resolve()))

    def test_track_import_can_skip_content_analysis(self):
        source = self.write_audio(self.temp_path / "large-track", "Unanalyzed.wav")
        preview = self.preview_import(source)

        with patch(
            "gaia.collection_importer.analyze_manifest_entry",
            side_effect=AssertionError("track analysis should be skipped"),
        ):
            job = self.start_import(
                preview,
                item_types={preview["entries"][0]["index"]: "track"},
                skip_track_analysis=True,
            )

        self.assertEqual(job["status"], "completed")
        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(imported.type, "track")
        self.assertEqual(imported.attributes["import"]["state"], "analysis_skipped")
        self.assertNotIn("analyzed_at", imported.attributes["import"])
        self.assertIsNone(imported.author)
        self.assertIsNone(imported.album)

    def test_import_reports_staging_then_processing_progress(self):
        source = self.temp_path / "two-phase-progress"
        (source / "first").mkdir(parents=True)
        (source / "first" / "one.txt").write_text("one", encoding="utf-8")
        (source / "second").mkdir()
        (source / "second" / "two.txt").write_text("two", encoding="utf-8")
        preview = self.preview_import(source)

        original_copy = import_jobs_module._copy_file_to_staging
        original_analyze = collection_importer.analyze_manifest_entry
        second_copy_started = threading.Event()
        release_copy = threading.Event()
        analysis_started = threading.Event()
        release_analysis = threading.Event()
        copy_lock = threading.Lock()
        copy_count = 0

        def controlled_copy(source_path, destination_path, progress):
            nonlocal copy_count
            with copy_lock:
                copy_count += 1
                current = copy_count
            if current == 2:
                second_copy_started.set()
                release_copy.wait(3.0)
            return original_copy(source_path, destination_path, progress)

        def controlled_analysis(root, entry):
            analysis_started.set()
            release_analysis.wait(3.0)
            return original_analyze(root, entry)

        try:
            with (
                patch("gaia.import_jobs._copy_file_to_staging", side_effect=controlled_copy),
                patch("gaia.collection_importer.analyze_manifest_entry", side_effect=controlled_analysis),
            ):
                queued = import_job_manager.create_job(
                    schemas.ImportJobCreateRequest(preview_id=preview["preview_id"])
                )
                self.assertTrue(second_copy_started.wait(3.0))
                staging = import_job_manager.get_job(queued["job_id"])
                self.assertEqual((staging["phase"], staging["staging_completed"]), ("transferring", 1))
                self.assertEqual(staging["processing_completed"], 0)
                self.assertGreater(staging["staging_bytes_completed"], 0)
                self.assertLess(staging["staging_bytes_completed"], staging["staging_bytes_total"])

                release_copy.set()
                self.assertTrue(analysis_started.wait(3.0))
                processing = import_job_manager.get_job(queued["job_id"])
                self.assertEqual(processing["phase"], "analyzing")
                self.assertEqual(processing["staging_completed"], processing["staging_total"])
                self.assertEqual(processing["processing_completed"], 0)

                release_analysis.set()
                completed = self.wait_for_import(queued["job_id"])
        finally:
            release_copy.set()
            release_analysis.set()

        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["staging_completed"], completed["staging_total"])
        self.assertEqual(completed["processing_completed"], completed["processing_total"])

    def test_automatic_analysis_failure_does_not_fail_or_lose_import(self):
        source = self.temp_path / "analysis-fallback"
        original = self.write_audio(source / "Nested", "Keep.wav")

        with patch(
            "gaia.collection_importer.analyze_manifest_entry",
            side_effect=RuntimeError("analysis service unavailable"),
        ):
            job = self.start_import(self.preview_import(source), folder_assignments={})

        self.assertEqual((job["status"], job["failed"], job["completed"]), ("completed", 0, 1))
        self.assertTrue(any("can be analyzed later" in warning for warning in job["warnings"]))
        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertTrue(Path(imported.absolute_path).is_file())
        self.assertNotEqual(Path(imported.absolute_path), original.resolve())
        self.assertEqual(imported.attributes["import"]["source_path"], str(original.resolve()))
        self.assertFalse(any(vaults.vault_store(self.vault).glob(".gaia-import-*.staging")))

    def test_keep_import_registers_external_reference_without_touching_source(self):
        source = self.write_audio(self.temp_path / "external", "Keep.wav")
        original_bytes = source.read_bytes()

        job = self.start_import(
            self.preview_import(source),
            folder_assignments={},
            transfer_mode="keep",
        )

        self.assertEqual(job["status"], "completed")
        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(imported.storage_mode, "external_reference")
        self.assertEqual(imported.availability, "ready")
        self.assertEqual(Path(imported.absolute_path), source.resolve())
        self.assertEqual(imported.attributes["import"]["source_path"], str(source.resolve()))
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertFalse((vaults.vault_store(self.vault) / "files" / source.name).exists())

    def test_copy_import_leaves_source_and_publishes_managed_file(self):
        source = self.write_audio(self.temp_path / "copy-source", "Copy.wav")
        original_bytes = source.read_bytes()

        job = self.start_import(
            self.preview_import(source),
            folder_assignments={},
            transfer_mode="copy",
        )

        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual((imported.storage_mode, imported.availability), ("managed", "ready"))
        self.assertNotEqual(Path(imported.absolute_path), source.resolve())
        self.assertEqual(Path(imported.absolute_path).read_bytes(), original_bytes)
        self.assertEqual(source.read_bytes(), original_bytes)

    def test_move_import_requires_confirmation_and_removes_confirmed_source(self):
        source = self.write_audio(self.temp_path / "move-source", "Move.wav")
        preview = self.preview_import(source)
        with self.assertRaisesRegex(ImportPreviewError, "requires confirmation"):
            import_job_manager.create_job(
                schemas.ImportJobCreateRequest(
                    preview_id=preview["preview_id"],
                    transfer_mode="move",
                )
            )

        job = self.start_import(
            preview,
            folder_assignments={},
            transfer_mode="move",
            move_confirmed=True,
        )

        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertFalse(source.exists())
        self.assertTrue(Path(imported.absolute_path).is_file())
        self.assertEqual((imported.storage_mode, imported.availability), ("managed", "ready"))
        self.assertEqual(imported.attributes["import"]["source_path"], str(source.resolve()))

    def test_deleting_external_reference_never_deletes_source(self):
        source = self.write_audio(self.temp_path / "external-delete", "Safe.wav")
        job = self.start_import(
            self.preview_import(source),
            folder_assignments={},
            transfer_mode="keep",
        )
        item_id = job["result_items"][0]["id"]

        result = deletion_service.delete_entries(
            self.db,
            [schemas.ItemDeleteLocator(item_id=item_id)],
        )

        self.assertEqual(result["status"], "success")
        self.assertIsNone(crud.get_item(self.db, item_id))
        self.assertTrue(source.is_file())

    def test_external_reference_can_be_copied_or_explicitly_moved_to_vault(self):
        source = self.write_audio(self.temp_path / "materialize", "Reference.wav")
        keep_job = self.start_import(self.preview_import(source), transfer_mode="keep")
        item = crud.get_item(self.db, keep_job["result_items"][0]["id"])
        destination_vault = vaults.create_vault(self.db, "Materialized", None)

        copied = vaults.move_items_to_vault(self.db, [item.id], destination_vault.id, mode="copy")[0]
        self.assertEqual(copied.storage_mode, "managed")
        self.assertTrue(Path(copied.absolute_path).is_file())
        self.assertEqual(copied.attributes["import"]["source_path"], str(source.resolve()))
        self.assertTrue(source.is_file())

        source2 = self.write_audio(self.temp_path / "materialize", "Moved.wav")
        keep_job2 = self.start_import(self.preview_import(source2), transfer_mode="keep")
        item2 = crud.get_item(self.db, keep_job2["result_items"][0]["id"])
        moved = vaults.move_items_to_vault(self.db, [item2.id], destination_vault.id, mode="move")[0]
        self.assertEqual(moved.storage_mode, "managed")
        self.assertFalse(source2.exists())
        self.assertTrue(Path(moved.absolute_path).is_file())

    def test_manifest_only_collection_content_can_be_deleted(self):
        root = vaults.vault_store(self.vault) / "legacy-project"
        root.mkdir(parents=True)
        stale_file = root / "old-state.json"
        stale_file.write_text('{"obsolete": true}', encoding="utf-8")
        collection = crud.create_item(
            self.db,
            schemas.CollectionItemCreate(
                absolute_path=str(root.resolve()),
                vault_id=self.vault.id,
                title="Legacy project",
                source_kind="managed",
                source_path=str(root.resolve()),
                contents=[
                    schemas.CollectionContent(
                        index=7,
                        filename=stale_file.name,
                        relative_path=stale_file.name,
                        type="item",
                        size_bytes=stale_file.stat().st_size,
                        mime_type="application/json",
                    )
                ],
            ),
        )

        background_tasks = BackgroundTasks()
        result = items_router.delete_collection_content(
            collection.id, 7, background_tasks, self.db
        )
        asyncio.run(background_tasks())

        self.assertEqual(result["status"], "success")
        self.assertFalse(stale_file.exists())
        refreshed = crud.get_item(self.db, collection.id)
        self.assertEqual(refreshed.contents, [])

    def test_import_can_exclude_file_types_and_extensions_before_copying(self):
        source = self.temp_path / "internet-archive-download"
        self.write_audio(source, "Concert.wav")
        (source / "README.txt").write_text("notes", encoding="utf-8")

        preview = self.preview_import(source)
        self.assertEqual(
            {option["value"] for option in preview["filter_options"]["types"]},
            {"audio", "file"},
        )
        self.assertIn(
            {"value": ".txt", "label": ".txt", "count": 1},
            preview["filter_options"]["extensions"],
        )

        job = self.start_import(preview, excluded_types=["file"], excluded_extensions=[".txt"])
        self.assertEqual((job["status"], job["imported"], job["excluded"]), ("completed", 1, 1))
        imported = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(Path(imported.absolute_path).name, "Concert.wav")

    def test_track_import_preserves_optional_embedded_audio_metadata(self):
        class TaggedAudio:
            tags = {
                "title": ["Live at the Forum"],
                "artist": ["The Example Band"],
                "album": ["Archive Session"],
                "date": ["1997-04-12"],
                "tracknumber": ["3/9"],
            }

        source = self.temp_path / "tagged-track"
        self.write_audio(source, "downloaded-file.wav")
        with patch("gaia.collection_importer.MutagenFile", return_value=TaggedAudio()):
            preview = self.preview_import(source)
            job = self.start_import(preview, item_types={0: "track"})

        track = crud.get_item(self.db, job["result_items"][0]["id"])
        self.assertEqual(track.type, "track")
        self.assertEqual(
            (track.title, track.author, track.album, track.release_year, track.track_number),
            ("Live at the Forum", "The Example Band", "Archive Session", 1997, 3),
        )
        self.assertEqual(track.attributes["audio_metadata"]["title"], "Live at the Forum")

        analyzed = items_router.analyze_item(track.id, self.db)
        self.assertEqual(analyzed.type, "track")
        self.assertEqual(analyzed.attributes["audio_metadata"]["author"], "The Example Band")
        self.assertIn("analysis", analyzed.attributes)

        edited = items_router.update_item(
            track.id,
            schemas.ItemUpdate(release_year=2001, album_artist="Catalog Curator"),
            self.db,
        )
        self.assertEqual((edited.release_year, edited.album_artist), (2001, "Catalog Curator"))

    def test_wav_riff_info_metadata_is_loaded_by_manifest_and_analysis(self):
        source = vaults.vault_store(self.vault) / "files" / "riff-tagged-track"
        wav_path = self.write_audio(source, "unlabelled.wav")

        def info_field(field: bytes, value: str) -> bytes:
            payload = value.encode("utf-8") + b"\x00"
            return field + struct.pack("<I", len(payload)) + payload + (b"\x00" if len(payload) & 1 else b"")

        info_payload = b"INFO" + b"".join(
            (
                info_field(b"INAM", "The RIFF Title"),
                info_field(b"IART", "The RIFF Artist"),
                info_field(b"IPRD", "The RIFF Album"),
                info_field(b"ICRD", "2004-09-18"),
                info_field(b"ITRK", "7/12"),
                info_field(b"IGNR", "Field Recording"),
            )
        )
        list_chunk = b"LIST" + struct.pack("<I", len(info_payload)) + info_payload
        wav_bytes = bytearray(wav_path.read_bytes())
        wav_bytes.extend(list_chunk)
        struct.pack_into("<I", wav_bytes, 4, len(wav_bytes) - 8)
        wav_path.write_bytes(wav_bytes)

        with patch("gaia.collection_importer.MutagenFile", None):
            manifest = collection_importer.build_manifest(source)

        self.assertEqual(manifest[0]["type"], "track")
        self.assertEqual(
            (
                manifest[0]["title"],
                manifest[0]["author"],
                manifest[0]["album"],
                manifest[0]["release_year"],
                manifest[0]["track_number"],
                manifest[0]["genre"],
            ),
            ("The RIFF Title", "The RIFF Artist", "The RIFF Album", 2004, 7, "Field Recording"),
        )

        track = crud.create_item(
            self.db,
            schemas.TrackItemCreate(
                absolute_path=str(wav_path),
                vault_id=self.vault.id,
                size_bytes=wav_path.stat().st_size,
                mime_type="audio/wav",
                attributes={"audio_metadata": {"title": "Stale title", "release_year": 1900}},
            ),
        )
        with patch("gaia.collection_importer.MutagenFile", None):
            analyzed = items_router.analyze_item(track.id, self.db)
        self.assertEqual((analyzed.title, analyzed.release_year), ("The RIFF Title", 2004))

    def test_wav_id3_frame_names_are_normalized(self):
        class Frame:
            def __init__(self, *values):
                self.text = list(values)

        class Id3Tags(dict):
            def getall(self, name):
                return [Frame("A frame comment")] if name == "COMM" else []

        class TaggedWav:
            tags = Id3Tags(
                TIT2=Frame("Frame Title"),
                TPE1=Frame("Frame Artist"),
                TALB=Frame("Frame Album"),
                TDRC=Frame("1988-06-01"),
                TRCK=Frame("2/10"),
            )

        wav_path = self.write_audio(self.temp_path / "id3-tags", "frames.wav")
        with patch("gaia.collection_importer.MutagenFile", return_value=TaggedWav()):
            metadata = collection_importer._read_audio_tags(wav_path)
        self.assertEqual(
            metadata,
            {
                "title": "Frame Title",
                "author": "Frame Artist",
                "album": "Frame Album",
                "comment": "A frame comment",
                "release_year": 1988,
                "track_number": 2,
            },
        )

    def test_collection_analysis_resolves_legacy_extracted_prefix(self):
        collection_root = vaults.vault_store(self.vault) / "files" / "legacy-pack"
        audio_path = self.write_audio(collection_root, "song.wav")

        class TaggedAudio:
            tags = {"title": ["Recovered song"], "artist": ["Archive artist"], "date": ["1940"]}

        content = {
            "index": 0,
            "filename": audio_path.name,
            "relative_path": "extracted/archive/song.wav",
            "type": "audio",
            "duration_seconds": None,
            "tags": [],
        }
        with patch("gaia.collection_importer.MutagenFile", return_value=TaggedAudio()):
            analyzed = items_router._analyze_collection_content(
                SimpleNamespace(absolute_path=str(collection_root)),
                content,
            )

        self.assertEqual(analyzed["relative_path"], "extracted/archive/song.wav")
        self.assertEqual((analyzed["title"], analyzed["author"], analyzed["release_year"]), ("Recovered song", "Archive artist", 1940))

    def test_single_item_vorbis_analysis_skips_rejected_aliases_and_persists_metadata(self):
        class StrictVorbisTags(dict):
            def get(self, key, default=None):
                if not key.isascii():
                    raise ValueError("invalid Vorbis comment key")
                return super().get(key.casefold(), default)

        class TaggedFlac:
            tags = StrictVorbisTags(
                title=["St. Louis blues"],
                artist=["Bessie Smith"],
                album=["Great blues singers"],
                date=["1929"],
                genre=["Blues"],
                tracknumber=["1"],
            )

        wav_fixture = self.write_audio(vaults.vault_store(self.vault) / "files", "bessie.wav")
        flac_path = wav_fixture.with_suffix(".flac")
        wav_fixture.replace(flac_path)
        track = crud.create_item(
            self.db,
            schemas.TrackItemCreate(
                absolute_path=str(flac_path),
                vault_id=self.vault.id,
                size_bytes=flac_path.stat().st_size,
                mime_type="audio/flac",
            ),
        )
        with patch("gaia.collection_importer.MutagenFile", return_value=TaggedFlac()):
            metadata = collection_importer._read_audio_tags(flac_path)
            analyzed = items_router.analyze_item(track.id, self.db)
        self.assertEqual(
            metadata,
            {
                "title": "St. Louis blues",
                "author": "Bessie Smith",
                "album": "Great blues singers",
                "release_year": 1929,
                "genre": "Blues",
                "track_number": 1,
            },
        )
        self.assertEqual(
            (analyzed.title, analyzed.author, analyzed.album, analyzed.release_year, analyzed.genre, analyzed.track_number),
            ("St. Louis blues", "Bessie Smith", "Great blues singers", 1929, "Blues", 1),
        )

    def test_audio_analysis_promotes_likely_full_recording_to_track(self):
        source = self.temp_path / "untyped-recording"
        self.write_audio(source, "archive-recording.wav")
        item_job = self.start_import(self.preview_import(source))
        audio = crud.get_item(self.db, item_job["result_items"][0]["id"])
        self.assertEqual(audio.type, "audio")

        with patch(
            "gaia.collection_importer._audio_metadata",
            return_value={
                "duration_seconds": 142.0,
                "audio_metadata": {
                    "title": "Archive Recording",
                    "author": "The Example Band",
                    "release_year": 1997,
                },
            },
        ):
            analyzed = items_router.analyze_item(audio.id, self.db)

        self.assertEqual(analyzed.type, "track")
        self.assertEqual(
            (analyzed.title, analyzed.author, analyzed.release_year),
            ("Archive Recording", "The Example Band", 1997),
        )
        self.assertIn("analysis", analyzed.attributes)

    def test_single_and_batch_audio_analysis_persist_all_embedded_fields(self):
        class TaggedAudio:
            tags = {
                "title": ["Catalog title"],
                "artist": ["Catalog artist"],
                "album": ["Catalog album"],
                "albumartist": ["Catalog album artist"],
                "date": ["1941-07-02"],
                "genre": ["Blues"],
                "tracknumber": ["3/10"],
                "discnumber": ["2/2"],
                "comment": ["Catalog comment"],
            }

        files_root = vaults.vault_store(self.vault) / "files"
        paths = [self.write_audio(files_root, name) for name in ("catalog-one.wav", "catalog-two.wav")]
        tracks = [
            crud.create_item(
                self.db,
                schemas.TrackItemCreate(
                    absolute_path=str(path),
                    vault_id=self.vault.id,
                    size_bytes=path.stat().st_size,
                    mime_type="audio/wav",
                ),
            )
            for path in paths
        ]
        sample_path = self.write_audio(files_root, "catalog-sample.wav")
        sample = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(sample_path),
                vault_id=self.vault.id,
                size_bytes=sample_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

        with patch("gaia.collection_importer.MutagenFile", return_value=TaggedAudio()):
            single = items_router.analyze_item(sample.id, self.db)
            batch = items_router.start_batch_analysis(
                schemas.BatchAnalysisRequest(item_ids=[track.id for track in tracks]),
                self.db,
            )
            status = self.wait_for_batch(batch["task_id"])

        self.assertEqual(
            (single.title, single.author, single.release_year, single.track_number),
            ("Catalog title", "Catalog artist", 1941, 3),
        )
        self.assertEqual(single.attributes["audio_metadata"]["album_artist"], "Catalog album artist")
        # Generic audio-family items retain embedded tags and expose the same
        # editable metadata fields as promoted track items.
        updated_sample = items_router.update_item(
            sample.id,
            schemas.ItemUpdate(author="Edited sample artist", release_year=1942),
            self.db,
        )
        self.assertEqual((updated_sample.author, updated_sample.release_year), ("Edited sample artist", 1942))
        self.assertEqual((status["completed"], status["failed"]), (2, 0))
        for update in status["updated_items"]:
            payload = update["item"]
            self.assertEqual(
                (payload["title"], payload["author"], payload["release_year"], payload["track_number"]),
                ("Catalog title", "Catalog artist", 1941, 3),
            )

    def test_real_tag_reader_batch_persists_metadata_visible_after_reload(self):
        """Exercise the installed tag reader instead of a mock of its API."""
        path = self.write_audio(vaults.vault_store(self.vault) / "files", "real-tags.wav")
        tagged = WAVE(str(path))
        tagged.add_tags()
        tagged.tags.add(TIT2(encoding=3, text=["Persistent title"]))
        tagged.tags.add(TPE1(encoding=3, text=["Persistent artist"]))
        tagged.tags.add(TALB(encoding=3, text=["Persistent album"]))
        tagged.tags.add(TCON(encoding=3, text=["Jazz"]))
        tagged.tags.add(TRCK(encoding=3, text=["4/12"]))
        tagged.save()

        track = crud.create_item(
            self.db,
            schemas.TrackItemCreate(
                absolute_path=str(path),
                vault_id=self.vault.id,
                size_bytes=path.stat().st_size,
                mime_type="audio/wav",
            ),
        )
        batch = items_router.start_batch_analysis(
            schemas.BatchAnalysisRequest(item_ids=[track.id]),
            self.db,
        )
        status = self.wait_for_batch(batch["task_id"])

        self.assertEqual((status["status"], status["completed"], status["failed"]), ("completed", 1, 0))
        self.db.expire_all()
        persisted = crud.get_item(self.db, track.id)
        self.assertEqual(
            (persisted.title, persisted.author, persisted.album, persisted.genre, persisted.track_number),
            ("Persistent title", "Persistent artist", "Persistent album", "Jazz", 4),
        )
        self.assertGreater(persisted.attributes["analysis"]["duration_seconds"], 0)
        summary = next(item for item in crud.get_item_summaries(self.db) if item["id"] == track.id)
        self.assertEqual((summary["title"], summary["author"], summary["track_number"]), ("Persistent title", "Persistent artist", 4))
        self.assertGreater(summary["duration_seconds"], 0)
        self.assertEqual(status["updated_items"][0]["item"]["author"], "Persistent artist")

    def test_batch_analysis_reports_all_target_failures_as_failed(self):
        missing = crud.create_item(
            self.db,
            schemas.TrackItemCreate(
                absolute_path=str(vaults.vault_store(self.vault) / "files" / "missing.wav"),
                vault_id=self.vault.id,
                mime_type="audio/wav",
            ),
        )
        batch = items_router.start_batch_analysis(
            schemas.BatchAnalysisRequest(item_ids=[missing.id]),
            self.db,
        )
        status = self.wait_for_batch(batch["task_id"])

        self.assertEqual((status["status"], status["completed"], status["failed"]), ("failed", 1, 1))
        self.assertEqual(status["errors"][0]["error"], "Asset is missing on disk")

    def test_compact_root_summaries_and_paginated_collection_contents(self):
        source = self.temp_path / "summary_pack"
        self.write_audio(source, "Kick.wav")
        self.write_audio(source, "Snare.wav")
        job = self.start_import(
            self.preview_import(source),
            folder_assignments={".": "profile:sample_pack"},
        )
        collection = crud.get_item(self.db, job["result_items"][0]["id"])

        summaries = items_router.read_item_summaries(db=self.db)
        summary = next(item for item in summaries if item["id"] == collection.id)
        self.assertNotIn("contents", summary)
        self.assertEqual(summary["content_count"], 2)
        self.assertIn("audio", summary["content_types"])
        self.assertEqual(
            [item["id"] for item in items_router.read_item_summaries(query="Kick", db=self.db)],
            [collection.id],
        )
        self.assertIn(
            collection.id,
            [item["id"] for item in items_router.read_item_summaries(query="audio", db=self.db)],
        )
        crud.set_item_tags(self.db, collection.id, ["root-favorite"])
        self.assertEqual(
            [item["id"] for item in items_router.read_item_summaries(query="root-favorite", db=self.db)],
            [collection.id],
        )

        statements: list[str] = []
        listener = lambda _connection, _cursor, statement, _parameters, _context, _many: statements.append(statement)
        event.listen(self.engine, "before_cursor_execute", listener)
        try:
            page = items_router.get_collection_contents_page(collection.id, limit=1, db=self.db)
        finally:
            event.remove(self.engine, "before_cursor_execute", listener)
        self.assertEqual((page["total"], len(page["contents"]), page["offset"]), (2, 1, 0))
        self.assertTrue(page["has_more"])
        self.assertTrue(
            any("FROM items" in statement and "LIMIT" in statement.upper() for statement in statements),
            "canonical collection children should be limited by SQL",
        )
        next_page = items_router.get_collection_contents_page(collection.id, offset=1, limit=1, db=self.db)
        self.assertEqual((len(next_page["contents"]), next_page["offset"], next_page["has_more"]), (1, 1, False))

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

    def test_bpm_update_is_staged_without_network_or_legacy_files(self):
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
        self.assertEqual(response["status"], "pending")
        self.assertEqual(response["field"], "bpm")
        self.assertEqual(response["proposed_value"], 135)
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, sample.id).bpm, 120)

        sin_proposals_router.accept_metadata_proposal(response["id"], self.db)
        self.db.expire_all()
        self.assertEqual(crud.get_item(self.db, sample.id).bpm, 135)

        for invalid in (10, 500):
            with self.subTest(bpm=invalid), self.assertRaises(HTTPException):
                update_library_bpm(LibraryBpmUpdateRequest(file_id=sample.id, bpm=invalid))

    def test_favourite_toggle_and_serialization(self):
        audio_path = self.write_audio(vaults.vault_store(self.vault) / "library", "FavSample.wav")
        sample = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(audio_path.resolve()),
                vault_id=self.vault.id,
                type="sample",
                bpm=128,
                is_loop=True,
            ),
        )

        # Initially favourite is False
        summary = crud.item_summary(sample)
        self.assertFalse(summary["favourite"])
        hydrated = crud.get_item(self.db, sample.id)
        self.assertFalse(hydrated.favourite)

        # Update favourite to True via items_router
        updated = items_router.update_item(sample.id, schemas.ItemUpdate(favourite=True), self.db)
        self.assertTrue(updated.favourite)

        self.db.expire_all()
        summary = crud.item_summary(crud.get_item(self.db, sample.id))
        self.assertTrue(summary["favourite"])

        # Update favourite via SIN backend API endpoint (with mock offline HTTP fallback)
        with patch.object(urllib.request, "urlopen", side_effect=OSError("offline")):
            resp = update_library_favourite(
                LibraryFavouriteUpdateRequest(file_id=sample.id, favourite=False)
            )
        self.assertEqual(resp["status"], "pending")
        self.assertEqual(resp["field"], "favourite")
        self.assertFalse(resp["proposed_value"])

        self.db.expire_all()
        hydrated = crud.get_item(self.db, sample.id)
        self.assertTrue(hydrated.favourite)

        sin_proposals_router.accept_metadata_proposal(resp["id"], self.db)
        self.db.expire_all()
        hydrated = crud.get_item(self.db, sample.id)
        self.assertFalse(hydrated.favourite)

    def test_import_folder_action_contain_and_ignore(self):
        source = self.temp_path / "folder-actions"
        self.write_audio(source / "Pack" / "Drums", "Kick.wav")
        self.write_audio(source / "Pack" / "Synth", "Lead.wav")

        preview = self.preview_import(source / "Pack")
        self.assertIn("folder_type_options", preview)
        values = [opt["value"] for opt in preview["folder_type_options"]]
        self.assertIn("action:contain", values)
        self.assertIn("action:ignore", values)

        job = self.start_import(
            preview,
            folder_assignments={"Drums": "action:contain", "Synth": "action:ignore"},
        )
        self.assertEqual(job["status"], "completed")


if __name__ == "__main__":
    unittest.main()
