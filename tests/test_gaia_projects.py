from __future__ import annotations

import unittest
from pathlib import Path

from gaia import collection_importer, crud, models, project_service, schemas
from gaia.routers import items as items_router
from tests.support import GaiaTestCase


class TestGaiaProjects(GaiaTestCase):
    def register_audio(self, path: Path):
        return crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(path.resolve()),
                vault_id=self.vault.id,
                file_hash="fixture-hash",
                size_bytes=path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

    def test_project_creation_copies_external_and_moves_managed_items(self):
        external_path = self.write_audio(self.temp_path / "external", "Board Mix.wav")
        managed_path = self.write_audio(self.asset_store / "loose", "Recorder.wav")
        external = self.register_audio(external_path)
        managed = self.register_audio(managed_path)

        project = project_service.create_project(
            self.db,
            "Friday Live",
            "live_recording_project",
            self.vault.id,
        )
        self.assertIsInstance(project, models.LiveRecordingProjectItem)
        self.assertIsInstance(project, models.FolderItem)

        updated = project_service.add_items(self.db, project.id, [external.id, managed.id])
        external_after = crud.get_item(self.db, external.id)
        managed_after = crud.get_item(self.db, managed.id)
        self.assertTrue(external_path.exists())
        self.assertFalse(managed_path.exists())
        self.assertEqual({external_after.parent_id, managed_after.parent_id}, {project.id})
        self.assertTrue(Path(external_after.absolute_path).exists())
        self.assertTrue(Path(managed_after.absolute_path).exists())
        self.assertEqual(updated.content_count, 2)

    def test_one_project_per_item_and_delete_history(self):
        first = self.register_audio(self.write_audio(self.temp_path / "external", "First.wav"))
        second = self.register_audio(self.write_audio(self.temp_path / "external", "Second.wav"))
        projects = project_service.create_from_items(
            self.db,
            [first.id, second.id],
            "one_per_item",
            None,
            "live_recording_project",
            self.vault.id,
        )
        self.assertEqual({project.title for project in projects}, {"First", "Second"})

        deleted_id = projects[0].id
        items_router.delete_item(deleted_id, self.db)
        self.assertIsNone(crud.get_item(self.db, deleted_id))
        history = (
            self.db.query(models.VaultImportLog)
            .filter(models.VaultImportLog.action == "project_created_from_items")
            .all()
        )
        self.assertTrue(history)
        deleted_log = next(log for log in history if log.source_path.endswith(projects[0].title))
        self.assertIsNone(deleted_log.item_id)

    def test_import_selection_and_source_safety_rules(self):
        source = self.temp_path / "filtered_pack"
        self.write_audio(source, "Kick.wav")
        self.write_audio(source, "Snare.wav")
        self.write_audio(source, "Hat.wav")

        sample_pack = collection_importer.snapshot_collection_source(
            str(source),
            asset_store=self.asset_store,
            analysis_types=["sample_pack", "collection"],
        )
        self.assertEqual(sample_pack["type"], "sample_pack")

        second_store = self.temp_path / "second-managed"
        collection = collection_importer.snapshot_collection_source(
            str(source),
            asset_store=second_store,
            analysis_types=["collection"],
        )
        self.assertEqual(collection["type"], "collection")

        for unsafe_source in (self.asset_store, self.temp_path):
            with self.subTest(source=unsafe_source), self.assertRaisesRegex(ValueError, "asset store"):
                collection_importer.snapshot_collection_source(
                    str(unsafe_source),
                    asset_store=self.asset_store,
                )
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            collection_importer.snapshot_collection_source(" ", asset_store=self.asset_store)
        with self.assertRaisesRegex(ValueError, "selected on their own"):
            collection_importer.snapshot_collection_source(
                str(source),
                asset_store=self.temp_path / "third-managed",
                analysis_types=["live_recording_project", "collection"],
            )

    def test_auto_scan_falls_back_to_independent_items(self):
        source = self.temp_path / "unmatched-auto-scan"
        self.write_audio(source, "Only file.wav")

        result = items_router.import_asset(
            schemas.CollectionImportRequest(
                source_path=str(source),
                vault_id=self.vault.id,
                analysis_types=["sample_pack", "multitrack"],
                fallback_to_files=True,
            ),
            self.db,
        )

        self.assertEqual(result["type"], "batch")
        self.assertEqual(result["imported"], 1)
        self.assertIsNone(result["items"][0].parent_id)
        self.assertEqual(self.db.query(models.FolderItem).count(), 0)


if __name__ == "__main__":
    unittest.main()
