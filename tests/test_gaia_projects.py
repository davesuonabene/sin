from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
import shutil
from fastapi import BackgroundTasks, HTTPException

from gaia import crud, models, profiles, project_service, reference_service, schemas, vaults
from gaia.routers import items as items_router, projects as projects_router
from tests.support import GaiaTestCase


class TestGaiaProjects(GaiaTestCase):
    def register_audio(self, path: Path):
        managed_path = vaults.vault_store(self.vault) / "test-inputs" / path.name
        managed_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, managed_path)
        return crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(managed_path.resolve()),
                vault_id=self.vault.id,
                file_hash="fixture-hash",
                size_bytes=managed_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

    @staticmethod
    def project_manifest(project):
        path = Path(project.absolute_path) / "files" / "edit" / "current.json"
        return path, json.loads(path.read_text(encoding="utf-8"))

    def test_sources_stay_read_only_while_projects_own_relationships(self):
        external_path = self.write_audio(self.temp_path / "external", "Board Mix.wav")
        managed_path = self.write_audio(self.asset_store / "loose", "Recorder.wav")
        external = self.register_audio(external_path)
        managed = self.register_audio(managed_path)

        project = project_service.create_project(self.db, "Friday Live", "project", self.vault.id)
        updated = project_service.add_items(self.db, project.id, [external.id, managed.id])

        self.assertIsInstance(updated, models.ProjectItem)
        self.assertIsInstance(updated, models.FolderItem)
        self.assertEqual(Path(project.absolute_path).parent, vaults.vault_store(self.vault))
        self.assertTrue(external_path.exists())
        self.assertTrue(managed_path.exists())
        self.assertIsNone(crud.get_item(self.db, external.id).parent_id)
        self.assertIsNone(crud.get_item(self.db, managed.id).parent_id)
        self.assertEqual(
            {(row.from_item_id, row.to_item_id, row.relation_kind) for row in reference_service.list_references(self.db, project.id)},
            {(project.id, external.id, "use"), (project.id, managed.id, "use")},
        )
        manifest_path, manifest = self.project_manifest(project)
        self.assertTrue(manifest_path.is_file())
        self.assertEqual(manifest["schema"], "gaia-project-state")
        self.assertEqual({entry["item"]["id"] for entry in manifest["references"]}, {external.id, managed.id})
        self.assertFalse(any(Path(project.absolute_path).glob("*.md")))
        self.assertFalse(any(child.parent_id == project.id for child in self.db.query(models.Item).all()))

    def test_project_delete_removes_its_context_edges_before_item_delete(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        project = project_service.create_from_items(
            self.db, [source.id], "single", None, "project", self.vault.id
        )[0]
        project_path = Path(project.absolute_path)
        self.assertEqual(project.title, "Take.wav")

        with self.assertRaises(HTTPException) as deletion_error:
            items_router.delete_item(source.id, self.db)
        self.assertEqual(deletion_error.exception.status_code, 400)
        self.assertIn("referenced by a project", str(deletion_error.exception.detail))
        self.assertIsNotNone(crud.get_item(self.db, source.id))

        items_router.delete_item(project.id, self.db)

        self.assertIsNone(crud.get_item(self.db, project.id))
        self.assertFalse(project_path.exists())
        self.assertTrue(self.db.query(models.ItemReference).count() == 0)
        self.assertIsNotNone(crud.get_item(self.db, source.id))

    def test_project_owned_file_can_be_deleted_from_nested_contents(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        project = project_service.create_project(self.db, "Cleanup edit", "project", self.vault.id)
        state_path = project_service.project_stage_directory(project, "working") / "old-state.json"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text('{"version": 1}', encoding="utf-8")
        item_schema, tags = project_service.file_schema_for_path(
            state_path, self.vault.id, project.id
        )
        artifact = crud.create_item(self.db, item_schema)
        if tags:
            crud.set_item_tags(self.db, artifact.id, tags)
        reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=source.id,
                to_item_id=artifact.id,
                relation_kind="derived",
            ),
            context_id=project.id,
        )
        content = next(
            entry for entry in crud.get_item(self.db, project.id).contents
            if entry["child_id"] == artifact.id
        )

        background_tasks = BackgroundTasks()
        result = items_router.delete_collection_content(
            project.id, content["index"], background_tasks, self.db
        )
        asyncio.run(background_tasks())

        self.assertEqual(result["status"], "success")
        self.assertIsNone(crud.get_item(self.db, artifact.id))
        self.assertFalse(state_path.exists())
        self.assertFalse(reference_service.list_references(self.db, project.id))
        refreshed = crud.get_item(self.db, project.id)
        self.assertFalse(any(entry.get("child_id") == artifact.id for entry in refreshed.contents))

    def test_project_references_are_listed_and_project_preview_resolves(self):
        first = self.register_audio(self.write_audio(self.temp_path / "sources", "First.wav"))
        second = self.register_audio(self.write_audio(self.temp_path / "sources", "Second.wav"))
        project = project_service.create_from_items(
            self.db, [first.id, second.id], "single", "Pair edit", "project", self.vault.id
        )[0]

        referenced = projects_router.get_project_referenced_items(project.id, self.db)
        self.assertEqual([item.id for item in referenced], [first.id, second.id])
        preview = items_router.read_item_preview(project.id, self.db)
        self.assertEqual(preview.id, first.id)

    def test_project_adopts_only_unparented_files_and_prunes_legacy_import_folders(self):
        store = vaults.vault_store(self.vault)
        first_path = self.write_audio(store / "files" / "import-one", "Take.wav")
        second_path = self.write_audio(store / "files" / "import-two", "Take.wav")
        first = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(first_path.resolve()), vault_id=self.vault.id),
        )
        second = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(second_path.resolve()), vault_id=self.vault.id),
        )
        unrelated_path = self.write_audio(store / "files" / "unrelated-import", "Unrelated.wav")
        unrelated = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(unrelated_path.resolve()), vault_id=self.vault.id),
        )

        held_folder = store / "held-folder"
        held_folder.mkdir(parents=True)
        held = crud.create_item(
            self.db,
            schemas.CollectionItemCreate(
                absolute_path=str(held_folder.resolve()),
                vault_id=self.vault.id,
                title="Held folder",
                source_kind="managed",
                source_path=str(held_folder.resolve()),
            ),
        )
        held_path = self.write_audio(held_folder, "Held.wav")
        held_child = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(held_path.resolve()),
                vault_id=self.vault.id,
                parent_id=held.id,
            ),
        )
        project = project_service.create_project(self.db, "Adoption project", "project", self.vault.id)
        source_reference = reference_service.create_source_reference(self.db, project.id, first.id)
        component_reference = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=first.id,
                to_item_id=second.id,
                relation_kind="component",
            ),
            context_id=project.id,
        )

        result = projects_router.adopt_project_orphans(project.id, self.db)

        self.assertEqual(result["adopted"], 2)
        adopted = [crud.get_item(self.db, item_id) for item_id in (first.id, second.id)]
        self.assertTrue(all(item.parent_id == project.id for item in adopted))
        self.assertTrue(all(Path(item.absolute_path).parent == Path(project.absolute_path) for item in adopted))
        self.assertEqual({Path(item.absolute_path).name for item in adopted}, {"Take.wav", "Take_2.wav"})
        self.assertFalse(first_path.parent.exists())
        self.assertFalse(second_path.parent.exists())
        self.assertEqual(crud.get_item(self.db, held_child.id).parent_id, held.id)
        self.assertTrue(held_path.exists())
        self.assertIsNone(crud.get_item(self.db, unrelated.id).parent_id)
        self.assertEqual(Path(crud.get_item(self.db, unrelated.id).absolute_path), unrelated_path.resolve())
        self.assertTrue(unrelated_path.exists())
        self.assertEqual(
            {(row.id, row.from_item_id, row.to_item_id, row.relation_kind) for row in reference_service.list_references(self.db, project.id)},
            {
                (source_reference.id, project.id, first.id, "use"),
                (component_reference.id, first.id, second.id, "component"),
            },
        )
        self.assertEqual(project_service.adopt_orphans(self.db, project.id)["adopted"], 0)

    def test_project_table_rename_moves_the_folder_and_rewrites_child_paths(self):
        project = project_service.create_project(self.db, "Old project", "project", self.vault.id)
        old_root = Path(project.absolute_path)
        child_path = self.write_audio(old_root / "files" / "mixdown", "Mix.wav")
        child = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(child_path.resolve()),
                vault_id=self.vault.id,
                parent_id=project.id,
            ),
        )

        renamed = items_router.update_item(
            project.id,
            schemas.ItemUpdate(title="New project"),
            self.db,
        )

        new_root = vaults.vault_store(self.vault) / "New project"
        self.assertEqual((renamed.title, Path(renamed.absolute_path)), ("New project", new_root.resolve()))
        self.assertFalse(old_root.exists())
        self.assertTrue((new_root / "files" / "mixdown" / "Mix.wav").is_file())
        self.db.expire_all()
        self.assertEqual(
            Path(crud.get_item(self.db, child.id).absolute_path),
            (new_root / "files" / "mixdown" / "Mix.wav").resolve(),
        )
        self.assertEqual(Path(crud.get_item(self.db, project.id).source_path), new_root.resolve())
        manifest_path, manifest = self.project_manifest(renamed)
        self.assertTrue(manifest_path.is_file())
        self.assertEqual(manifest["project_id"], project.id)
        self.assertFalse((new_root / "PROJECT_CONTEXT.md").exists())

    def test_folder_drop_can_reference_then_fully_move_an_item(self):
        store = vaults.vault_store(self.vault)
        target_path = store / "Destination"
        target_path.mkdir()
        target = crud.create_item(
            self.db,
            schemas.CollectionItemCreate(
                absolute_path=str(target_path.resolve()),
                vault_id=self.vault.id,
                title="Destination",
                source_kind="managed",
                source_path=str(target_path.resolve()),
            ),
        )
        source_path = self.write_audio(store / "files" / "incoming", "Take.wav")
        source = crud.create_item(
            self.db,
            schemas.AudioItemCreate(absolute_path=str(source_path.resolve()), vault_id=self.vault.id),
        )

        referenced = project_service.place_items(self.db, target.id, [source.id], "reference")
        self.assertEqual(referenced["mode"], "reference")
        self.assertTrue(source_path.exists())
        self.assertIsNone(crud.get_item(self.db, source.id).parent_id)
        reference = reference_service.list_references(self.db, target.id)[0]
        self.assertEqual((reference.from_item_id, reference.to_item_id, reference.relation_kind), (target.id, source.id, "use"))

        moved = project_service.place_items(self.db, target.id, [source.id], "move")
        self.assertEqual(moved["mode"], "move")
        placed = crud.get_item(self.db, source.id)
        self.assertEqual((placed.parent_id, placed.vault_id), (target.id, target.vault_id))
        self.assertEqual(Path(placed.absolute_path), (target_path / "Take.wav").resolve())
        self.assertFalse(source_path.exists())
        self.assertEqual(len(reference_service.list_references(self.db, target.id)), 1)

    def test_project_drop_moves_across_vaults_as_an_editable_source(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Board Mix.wav"))
        destination_vault = vaults.create_vault(self.db, "Editing", None)
        project = project_service.create_project(self.db, "Live edit", "project", destination_vault.id)

        result = project_service.place_items(self.db, project.id, [source.id], "move")

        self.assertEqual(result["item_ids"], [source.id])
        moved = crud.get_item(self.db, source.id)
        expected_path = Path(project.absolute_path) / "Board Mix.wav"
        self.assertEqual((moved.vault_id, moved.parent_id, Path(moved.absolute_path)), (destination_vault.id, project.id, expected_path.resolve()))
        reference = reference_service.list_references(self.db, project.id)[0]
        self.assertEqual(reference.relation_kind, "use")

        updated = projects_router.update_project_reference(
            project.id,
            reference.id,
            schemas.ProjectReferenceUpdate(revision_label="mixdown"),
            self.db,
        )
        self.assertEqual(updated.revision_label, "mixdown")
        _, manifest = self.project_manifest(project)
        entry = next(entry for entry in manifest["references"] if entry["reference_id"] == reference.id)
        self.assertEqual(entry["revision_label"], "mixdown")

    def test_project_creation_move_files_moves_orphan_files_into_new_project(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Orphan.wav"))
        original_path = Path(source.absolute_path)

        project = project_service.create_from_items(
            self.db,
            [source.id],
            "single",
            "Moved files",
            "project",
            self.vault.id,
            move_files=True,
        )[0]

        moved = crud.get_item(self.db, source.id)
        moved_path = Path(moved.absolute_path)
        self.assertFalse(original_path.exists())
        self.assertTrue(moved_path.is_file())
        self.assertEqual(moved.parent_id, project.id)
        self.assertEqual(moved_path.parent, Path(project.absolute_path))
        self.assertEqual(
            [(row.from_item_id, row.to_item_id, row.relation_kind) for row in reference_service.list_references(self.db, project.id)],
            [(project.id, source.id, "use")],
        )

    def test_project_creation_move_files_copies_files_owned_by_another_project(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Owned.wav"))
        source_project = project_service.create_project(self.db, "Source project", "project", self.vault.id)
        project_service.place_items(self.db, source_project.id, [source.id], "move")
        original_path = Path(crud.get_item(self.db, source.id).absolute_path)

        target_project = project_service.create_from_items(
            self.db,
            [source.id],
            "single",
            "Copied files",
            "project",
            self.vault.id,
            move_files=True,
        )[0]

        original = crud.get_item(self.db, source.id)
        target_reference = reference_service.list_references(self.db, target_project.id)[0]
        copied = crud.get_item(self.db, target_reference.to_item_id)
        self.assertNotEqual(copied.id, original.id)
        self.assertTrue(original_path.is_file())
        self.assertTrue(Path(copied.absolute_path).is_file())
        self.assertEqual(original.parent_id, source_project.id)
        self.assertEqual(copied.parent_id, target_project.id)
        self.assertEqual(Path(copied.absolute_path).parent, Path(target_project.absolute_path))
        self.assertEqual(copied.file_hash, original.file_hash)

    def test_project_creation_can_mix_linked_and_moved_files(self):
        moved_source = self.register_audio(self.write_audio(self.temp_path / "sources", "Move.wav"))
        linked_source = self.register_audio(self.write_audio(self.temp_path / "sources", "Link.wav"))
        original_moved_path = Path(moved_source.absolute_path)
        original_linked_path = Path(linked_source.absolute_path)

        project = project_service.create_from_items(
            self.db,
            [moved_source.id, linked_source.id],
            "single",
            "Mixed files",
            "project",
            self.vault.id,
            move_item_ids=[moved_source.id],
        )[0]

        moved = crud.get_item(self.db, moved_source.id)
        linked = crud.get_item(self.db, linked_source.id)
        self.assertFalse(original_moved_path.exists())
        self.assertTrue(Path(moved.absolute_path).is_file())
        self.assertEqual(moved.parent_id, project.id)
        self.assertTrue(original_linked_path.is_file())
        self.assertIsNone(linked.parent_id)
        self.assertEqual(
            {row.to_item_id for row in reference_service.list_references(self.db, project.id)},
            {moved_source.id, linked_source.id},
        )

    def test_zoom_h4_profile_creates_project_scoped_components_and_master(self):
        h4_folder = self.temp_path / "H4-session"
        self.write_audio(h4_folder, "260721_194345_Tr1.WAV")
        self.write_audio(h4_folder, "260721_194345_TrMic.wav")
        mixdown_path = self.write_audio(h4_folder, "260721_194345_Board Mix.wav")

        profiles.ensure_builtin_profile_bundles()
        preview = self.preview_import(h4_folder)
        self.assertIn("zoom_h4", [profile["id"] for profile in preview["profiles"]])
        h4_job = self.start_import(
            preview,
            folder_assignments={".": "profile:zoom_h4"},
        )
        self.assertEqual(h4_job["status"], "completed")
        h4 = crud.get_item(self.db, h4_job["result_items"][0]["id"])
        self.assertEqual(h4.type, "multitrack")
        self.assertEqual(h4.attributes["profile_id"], "zoom_h4")

        project = project_service.create_from_items(
            self.db, [h4.id], "single", "H4 edit", "project", self.vault.id
        )[0]
        reference_service.apply_profile(
            self.db,
            project.id,
            h4.id,
            "zoom_h4",
            mark_suggested_master=True,
        )
        project_service.sync_project_manifest(self.db, project.id)
        references = reference_service.list_references(self.db, project.id)
        components = [row for row in references if row.from_item_id == h4.id]
        self.assertEqual(len(components), 3)
        mixdown = next(child for child in h4.children if Path(child.absolute_path).name == mixdown_path.name)
        self.assertEqual(mixdown.attributes["profile_role"], "mixdown")
        master = reference_service.resolve_master(self.db, project.id)
        self.assertEqual((master["status"], master["resolved_item_id"]), ("resolved", mixdown.id))
        self.assertEqual(Path(mixdown.absolute_path).name, mixdown_path.name)
        self.assertTrue(Path(h4.absolute_path).is_dir())
        self.assertFalse((Path(h4.absolute_path) / "PROJECT_CONTEXT.md").exists())

    def test_derived_results_are_copied_inside_the_project_and_versioned(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        project = project_service.create_from_items(
            self.db, [source.id], "single", "Take edit", "project", self.vault.id
        )[0]
        external_result = self.write_audio(self.temp_path / "renders", "Take edit.wav")

        artifact, reference = project_service.register_derived_path(
            self.db,
            project.id,
            schemas.ProjectDerivedPathRequest(
                source_path=str(external_result),
                from_item_id=source.id,
                relation_kind="derived",
                stage_name="edit",
                revision_label="02",
                is_master=True,
                target_type="track",
            ),
        )

        artifact_path = Path(artifact.absolute_path)
        self.assertEqual(artifact.type, "track")
        self.assertEqual(artifact.parent_id, project.id)
        self.assertTrue(artifact_path.is_file())
        self.assertTrue(artifact_path.is_relative_to(Path(project.absolute_path) / "files" / "edit"))
        self.assertTrue(external_result.exists())
        self.assertEqual((reference.relation_kind, reference.revision_label, reference.is_master), ("derived", "02", True))
        self.assertEqual(reference_service.resolve_master(self.db, project.id)["resolved_item_id"], artifact.id)
        _, manifest = self.project_manifest(project)
        entry = next(entry for entry in manifest["references"] if entry["reference_id"] == reference.id)
        self.assertEqual((entry["relation_kind"], entry["revision_label"], entry["is_master"]), ("derived", "02", True))
        self.assertFalse((Path(project.absolute_path) / "stages").exists())

    def test_manifest_migrates_generated_markdown_without_touching_user_notes(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        project = project_service.create_from_items(
            self.db, [source.id], "single", "Manifest migration", "project", self.vault.id
        )[0]
        root = Path(project.absolute_path)
        placeholder = root / "Take.wav.md"
        placeholder.write_text(
            f"# GAIA linked asset\n\ngaia:item:{source.id}\n",
            encoding="utf-8",
        )
        context = root / "PROJECT_CONTEXT.md"
        context.write_text(
            "This file is generated by GAIA. The SQLite reference graph is canonical.\n",
            encoding="utf-8",
        )
        generated_version = root / "stages" / "edit" / "VERSION_01.md"
        generated_version.parent.mkdir(parents=True)
        generated_version.write_text('```json\n{"reference_id": 1}\n```\n', encoding="utf-8")
        note = root / "README.md"
        note.write_text("Keep this user note.\n", encoding="utf-8")

        result = project_service.sync_project_manifest(self.db, project.id)

        manifest_path, manifest = self.project_manifest(project)
        self.assertEqual(result["manifest"], str(manifest_path))
        self.assertFalse(placeholder.exists())
        self.assertFalse(context.exists())
        self.assertFalse(generated_version.exists())
        self.assertTrue(note.is_file())
        self.assertEqual([entry["item"]["id"] for entry in manifest["references"]], [source.id])

    def test_nested_project_masters_resolve_and_cycles_are_reported(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        first = project_service.create_from_items(
            self.db, [source.id], "single", "First", "project", self.vault.id
        )[0]
        first_source = next(row for row in reference_service.list_references(self.db, first.id) if row.to_item_id == source.id)
        reference_service.set_master(self.db, first.id, first_source.id)

        second = project_service.create_project(self.db, "Second", "project", self.vault.id)
        nested = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=second.id,
                to_item_id=first.id,
                relation_kind="use",
                is_master=True,
            ),
            context_id=second.id,
        )
        self.assertEqual(reference_service.resolve_master(self.db, second.id)["resolved_item_id"], source.id)

        with self.assertRaisesRegex(reference_service.ReferenceError, "project cycle"):
            reference_service.create_reference(
                self.db,
                schemas.ProjectReferenceCreate(
                    from_item_id=first.id,
                    to_item_id=second.id,
                    relation_kind="use",
                    is_master=True,
                ),
                context_id=first.id,
            )
        self.assertTrue(nested.is_master)
        self.assertEqual(reference_service.resolve_master(self.db, second.id)["resolved_item_id"], source.id)

    def test_references_require_a_folder_context(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Take.wav"))
        with self.assertRaisesRegex(reference_service.ReferenceError, "Folder context not found"):
            reference_service.create_reference(
                self.db,
                schemas.ItemReferenceCreate(
                    context_id=source.id,
                    from_item_id=source.id,
                    to_item_id=source.id + 1,
                    relation_kind="use",
                ),
            )


if __name__ == "__main__":
    unittest.main()
