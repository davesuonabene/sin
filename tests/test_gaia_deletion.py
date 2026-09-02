from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import BackgroundTasks

from gaia import crud, deletion_service, models, project_service, reference_service, schemas, vaults
from gaia.routers import items as items_router
from tests.support import GaiaTestCase


class TestGaiaDeletion(GaiaTestCase):
    def register_json(
        self,
        path: Path,
        payload: str,
        *,
        parent_id: int | None = None,
    ) -> models.Item:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
        return crud.create_item(
            self.db,
            schemas.ItemCreate(
                absolute_path=str(path.resolve()),
                vault_id=self.vault.id,
                parent_id=parent_id,
                type="item",
                size_bytes=path.stat().st_size,
                mime_type="application/json",
            ),
        )

    def test_one_command_deletes_items_contents_and_project_links(self):
        store = vaults.vault_store(self.vault)
        source_path = store / "files" / "source.json"
        source = self.register_json(source_path, '{"source": true}')
        project = project_service.create_project(
            self.db, "Deletion project", "project", self.vault.id
        )
        source_reference = reference_service.create_source_reference(
            self.db, project.id, source.id
        )

        artifact_path = (
            project_service.project_stage_directory(project, "working")
            / "old-state.json"
        )
        artifact = self.register_json(
            artifact_path,
            '{"old": true}',
            parent_id=project.id,
        )
        reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=source.id,
                to_item_id=artifact.id,
                relation_kind="derived",
            ),
            context_id=project.id,
        )
        artifact_content = next(
            entry
            for entry in crud.get_item(self.db, project.id).contents
            if entry.get("child_id") == artifact.id
        )

        loose_path = store / "files" / "loose.json"
        loose = self.register_json(loose_path, '{"loose": true}')

        legacy_root = store / "legacy-collection"
        legacy_root.mkdir(parents=True)
        legacy_path = legacy_root / "old-manifest.json"
        legacy_path.write_text('{"legacy": true}', encoding="utf-8")
        legacy_collection = crud.create_item(
            self.db,
            schemas.CollectionItemCreate(
                absolute_path=str(legacy_root.resolve()),
                vault_id=self.vault.id,
                title="Legacy collection",
                source_kind="managed",
                source_path=str(legacy_root.resolve()),
                contents=[
                    schemas.CollectionContent(
                        index=7,
                        filename=legacy_path.name,
                        relative_path=legacy_path.name,
                        type="item",
                        size_bytes=legacy_path.stat().st_size,
                        mime_type="application/json",
                    )
                ],
            ),
        )

        request = schemas.LibraryEntriesDeleteRequest(
            entries=[
                schemas.ProjectReferenceDeleteLocator(
                    project_id=project.id,
                    reference_id=source_reference.id,
                ),
                schemas.CollectionContentDeleteLocator(
                    collection_id=project.id,
                    content_index=artifact_content["index"],
                ),
                schemas.ItemDeleteLocator(item_id=loose.id),
                schemas.CollectionContentDeleteLocator(
                    collection_id=legacy_collection.id,
                    content_index=7,
                ),
            ]
        )
        background_tasks = BackgroundTasks()

        result = items_router.delete_library_entries(
            request, background_tasks, self.db
        )
        asyncio.run(background_tasks())

        self.assertEqual(result["status"], "success")
        self.assertEqual(
            [entry["kind"] for entry in result["deleted"]],
            ["reference", "content", "item", "content"],
        )
        self.assertTrue(source_path.is_file())
        self.assertIsNotNone(crud.get_item(self.db, source.id))
        self.assertIsNone(crud.get_item(self.db, artifact.id))
        self.assertIsNone(crud.get_item(self.db, loose.id))
        self.assertFalse(artifact_path.exists())
        self.assertFalse(loose_path.exists())
        self.assertFalse(legacy_path.exists())
        self.assertFalse(reference_service.list_references(self.db, project.id))
        self.assertEqual(crud.get_item(self.db, legacy_collection.id).contents, [])

    def test_failed_batch_restores_staged_files_and_database_rows(self):
        store = vaults.vault_store(self.vault)
        source_path = store / "files" / "protected.json"
        source = self.register_json(source_path, '{"protected": true}')
        project = project_service.create_project(
            self.db, "Protected source", "project", self.vault.id
        )
        reference_service.create_source_reference(self.db, project.id, source.id)
        loose_path = store / "files" / "rollback.json"
        loose = self.register_json(loose_path, '{"rollback": true}')

        with self.assertRaisesRegex(ValueError, "referenced by a project"):
            deletion_service.delete_entries(
                self.db,
                [
                    schemas.ItemDeleteLocator(item_id=loose.id),
                    schemas.ItemDeleteLocator(item_id=source.id),
                ],
            )

        self.assertTrue(source_path.is_file())
        self.assertTrue(loose_path.is_file())
        self.assertIsNotNone(crud.get_item(self.db, source.id))
        self.assertIsNotNone(crud.get_item(self.db, loose.id))
        self.assertEqual(len(reference_service.list_references(self.db, project.id)), 1)

    def test_overlapping_parent_and_child_targets_delete_once(self):
        project = project_service.create_project(
            self.db, "Overlapping selection", "project", self.vault.id
        )
        artifact_path = (
            project_service.project_stage_directory(project, "working")
            / "selected-child.json"
        )
        artifact = self.register_json(
            artifact_path,
            '{"selected": true}',
            parent_id=project.id,
        )

        result = deletion_service.delete_entries(
            self.db,
            [
                schemas.ItemDeleteLocator(item_id=project.id),
                schemas.ItemDeleteLocator(item_id=artifact.id),
            ],
        )

        self.assertEqual(len(result["deleted"]), 2)
        self.assertIsNone(crud.get_item(self.db, project.id))
        self.assertIsNone(crud.get_item(self.db, artifact.id))
        self.assertFalse(Path(project.absolute_path).exists())

    def test_batch_can_delete_more_than_one_thousand_root_items(self):
        records = [
            {
                "absolute_path": str(
                    (vaults.vault_store(self.vault) / "files" / f"bulk-{index}.json").resolve()
                ),
                "vault_id": self.vault.id,
                "type": "item",
                "metadata_json": "{}",
            }
            for index in range(1001)
        ]
        self.db.bulk_insert_mappings(models.Item, records)
        self.db.commit()
        item_ids = [
            row[0]
            for row in self.db.query(models.Item.id)
            .filter(models.Item.vault_id == self.vault.id)
            .order_by(models.Item.id)
            .all()
        ]

        result = deletion_service.delete_entries(
            self.db,
            [schemas.ItemDeleteLocator(item_id=item_id) for item_id in item_ids],
        )

        self.assertEqual(len(result["deleted"]), 1001)
        self.assertEqual(
            self.db.query(models.Item).filter(models.Item.vault_id == self.vault.id).count(),
            0,
        )
