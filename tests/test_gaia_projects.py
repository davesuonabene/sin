from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
import shutil
from unittest.mock import patch
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

    def test_project_table_dynamic_version_inheritance(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Vocal.wav"))
        project = project_service.create_project(self.db, "Song Session", "project", self.vault.id)
        project_service.place_items(self.db, project.id, [source.id], mode="reference")

        # Before sibling exists
        table = reference_service.project_table(self.db, project.id)
        self.assertEqual(len(table), 1)
        self.assertEqual(len(table[0]["versions"]), 1)
        self.assertEqual(table[0]["versions"][0]["label"], "Original")

        # Now create a sibling version at the original location
        source_dir = Path(source.absolute_path).parent
        v2_path = source_dir / "Vocal.2.wav"
        shutil.copy2(source.absolute_path, v2_path)
        v2_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(v2_path.resolve()),
                vault_id=source.vault_id,
                parent_id=source.parent_id,
                file_hash="fixture-v2-hash",
                size_bytes=v2_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

        # Re-fetching project_table dynamically discovers and links Vocal.2.wav
        updated_table = reference_service.project_table(self.db, project.id)
        self.assertEqual(len(updated_table), 1)
        self.assertEqual(len(updated_table[0]["versions"]), 2)
        version_labels = [v["label"] for v in updated_table[0]["versions"]]
        self.assertEqual(version_labels, ["Original", ".2"])
        # Verify the active item is the latest version
        self.assertEqual(updated_table[0]["item"].id, v2_item.id)
        self.assertTrue(updated_table[0]["is_external"])
        self.assertTrue(updated_table[0]["versions"][0]["is_external"])
        self.assertTrue(updated_table[0]["versions"][1]["is_external"])

        # Now create Vocal.3.wav inside the project's own files directory
        v3_dir = Path(project.absolute_path) / "files"
        v3_dir.mkdir(parents=True, exist_ok=True)
        v3_path = v3_dir / "Vocal.3.wav"
        shutil.copy2(source.absolute_path, v3_path)
        v3_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(v3_path.resolve()),
                vault_id=self.vault.id,
                parent_id=project.id,
                file_hash="fixture-v3-hash",
                size_bytes=v3_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )

        final_table = reference_service.project_table(self.db, project.id)
        self.assertEqual(len(final_table), 1)
        self.assertEqual(len(final_table[0]["versions"]), 3)
        self.assertEqual(final_table[0]["item"].id, v3_item.id)
        # Vocal.3 is inside project -> is_external must be False!
        self.assertFalse(final_table[0]["is_external"])
        self.assertTrue(final_table[0]["versions"][0]["is_external"])
        self.assertTrue(final_table[0]["versions"][1]["is_external"])
        self.assertFalse(final_table[0]["versions"][2]["is_external"])

    def test_project_place_items_copy_mode(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Loop.wav"))
        project = project_service.create_project(self.db, "Beat Session", "project", self.vault.id)

        result = project_service.place_items(self.db, project.id, [source.id], mode="copy")
        self.assertEqual(result["mode"], "copy")
        cloned_id = result["item_ids"][0]
        cloned_item = crud.get_item(self.db, cloned_id)
        self.assertEqual(cloned_item.parent_id, project.id)
        self.assertTrue(Path(cloned_item.absolute_path).is_file())
        self.assertTrue(Path(cloned_item.absolute_path).is_relative_to(Path(project.absolute_path)))
        # Verify ItemReference edge was created for the copy
        refs = reference_service.list_references(self.db, project.id)
        self.assertTrue(any(r.to_item_id == cloned_id for r in refs))

    def test_vault_place_items_copy_and_reference(self):
        source = self.register_audio(self.write_audio(self.temp_path / "sources", "Sample.wav"))
        # Test copy mode into vault
        copy_result = vaults.place_items_in_vault(self.db, self.vault.id, [source.id], mode="copy")
        self.assertEqual(copy_result["mode"], "copy")
        self.assertEqual(len(copy_result["item_ids"]), 1)
        cloned_id = copy_result["item_ids"][0]
        self.assertNotEqual(cloned_id, source.id)
        cloned = crud.get_item(self.db, cloned_id)
        self.assertEqual(cloned.vault_id, self.vault.id)
        self.assertIsNone(cloned.parent_id)
        self.assertTrue(Path(cloned.absolute_path).exists())

        # Test reference mode into vault with external file
        ext_file = self.write_audio(self.temp_path / "external", "ExternalTrack.wav")
        ext_source = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(ext_file.resolve()),
                vault_id=self.vault.id,
                file_hash="ext-hash",
                size_bytes=ext_file.stat().st_size,
                mime_type="audio/wav",
                storage_mode="external_reference",
            ),
        )
        # Create a second vault to test referencing across vaults
        second_vault = vaults.create_vault(self.db, "Second Vault", None, None, "quick")
        ref_result = vaults.place_items_in_vault(self.db, second_vault.id, [ext_source.id], mode="reference")
        self.assertEqual(ref_result["mode"], "reference")
        second_items = self.db.query(models.Item).filter(models.Item.vault_id == second_vault.id).all()
        self.assertEqual(len(second_items), 1)
        self.assertEqual(second_items[0].storage_mode, "external_reference")
        self.assertEqual(second_items[0].absolute_path, str(ext_file.resolve()))

    def test_create_folder_in_vault(self):
        folder = project_service.create_folder(self.db, "Drums", vault_id=self.vault.id)
        self.assertIsInstance(folder, models.CollectionItem)
        self.assertEqual(folder.title, "Drums")
        self.assertEqual(folder.vault_id, self.vault.id)
        folder_disk = Path(folder.absolute_path)
        self.assertTrue(folder_disk.is_dir())
        self.assertEqual(folder_disk.parent, vaults.vault_store(self.vault))
        self.assertTrue(folder.attributes.get("is_folder"))

    def test_create_folder_and_move_managed_and_external_items(self):
        managed_file = self.write_audio(self.asset_store / "loose", "Kick.wav")
        managed = self.register_audio(managed_file)

        ext_dir = self.temp_path / "ext_drive"
        ext_dir.mkdir(parents=True, exist_ok=True)
        ext_file = self.write_audio(ext_dir, "SnareRef.wav")
        external = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(ext_file.resolve()),
                vault_id=self.vault.id,
                file_hash="snare-hash",
                size_bytes=ext_file.stat().st_size,
                mime_type="audio/wav",
                storage_mode="external_reference",
            ),
        )

        folder = project_service.create_folder(
            self.db,
            "Kit",
            vault_id=self.vault.id,
            item_ids=[managed.id, external.id],
        )
        self.assertEqual(folder.content_count, 2)

        # Managed file must be moved physically into the folder
        reloaded_managed = crud.get_item(self.db, managed.id)
        self.assertEqual(reloaded_managed.parent_id, folder.id)
        self.assertEqual(Path(reloaded_managed.absolute_path).parent, Path(folder.absolute_path))
        self.assertTrue(Path(reloaded_managed.absolute_path).is_file())

        # External file must NOT be moved on disk, but its folder parameter tracks the folder
        reloaded_ext = crud.get_item(self.db, external.id)
        self.assertEqual(reloaded_ext.parent_id, folder.id)
        self.assertEqual(reloaded_ext.absolute_path, str(ext_file.resolve()))
        self.assertTrue(ext_file.is_file())
        self.assertEqual(reloaded_ext.attributes.get("folder"), "Kit")

    def test_create_folder_api_endpoint(self):
        req = schemas.FolderCreateRequest(
            name="Samples",
            vault_id=self.vault.id,
        )
        created = items_router.create_folder(req, db=self.db)
        self.assertEqual(created.title, "Samples")
        self.assertEqual(created.vault_id, self.vault.id)
        self.assertTrue(Path(created.absolute_path).is_dir())

    def test_create_folder_in_project_with_references_preserves_files_on_disk(self):
        project = project_service.create_project(self.db, "Song Alpha", "project", self.vault.id)

        # 1. External reference
        ext_dir = self.temp_path / "outside_audio"
        ext_dir.mkdir(parents=True, exist_ok=True)
        ext_file = self.write_audio(ext_dir, "ExternalLead.wav")
        ext_original_path = str(ext_file.resolve())
        external_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=ext_original_path,
                vault_id=self.vault.id,
                file_hash="ext-lead-hash",
                size_bytes=ext_file.stat().st_size,
                mime_type="audio/wav",
                storage_mode="external_reference",
            ),
        )

        # 2. Managed library item
        lib_file = self.write_audio(self.asset_store / "library_loose", "VocalLoop.wav")
        managed_item = self.register_audio(lib_file)
        managed_original_path = managed_item.absolute_path

        # Link both items into the project as references
        ref_ext = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=external_item.id,
                relation_kind="use",
            ),
            context_id=project.id,
        )
        ref_managed = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=managed_item.id,
                relation_kind="use",
            ),
            context_id=project.id,
        )

        # Create folder "Vocals" inside the project using reference_ids
        folder = project_service.create_folder(
            self.db,
            "Vocals",
            parent_id=project.id,
            reference_ids=[ref_ext.id, ref_managed.id],
        )

        self.assertEqual(folder.title, "Vocals")
        self.assertEqual(folder.parent_id, project.id)
        self.assertEqual(folder.content_count, 2)

        # Verify reference attributes updated to folder
        reloaded_ref_ext = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref_ext.id).first()
        self.assertEqual(reloaded_ref_ext.attributes.get("folder"), "Vocals")
        reloaded_ref_managed = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref_managed.id).first()
        self.assertEqual(reloaded_ref_managed.attributes.get("folder"), "Vocals")

        # CRITICAL: Files on disk must NOT have moved!
        self.assertEqual(external_item.absolute_path, ext_original_path)
        self.assertTrue(ext_file.is_file())
        reloaded_managed = crud.get_item(self.db, managed_item.id)
        self.assertEqual(reloaded_managed.absolute_path, managed_original_path)
        self.assertTrue(Path(managed_original_path).is_file())

        # CRITICAL: Managed library item's parent_id must NOT be altered
        self.assertNotEqual(reloaded_managed.parent_id, folder.id)

        # Verify folder label in crud summary
        folder_summary = crud.item_summary(folder)
        self.assertEqual(folder_summary.get("attributes", {}).get("profile_label"), "Folder")

    def test_place_items_inside_project_folder_does_not_move_project_references(self):
        project = project_service.create_project(self.db, "Song Beta", "project", self.vault.id)
        lib_file = self.write_audio(self.asset_store / "loose_samples", "Guitar.wav")
        managed_item = self.register_audio(lib_file)
        managed_original_path = managed_item.absolute_path

        ref = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=managed_item.id,
                relation_kind="use",
            ),
            context_id=project.id,
        )

        folder = project_service.create_folder(self.db, "Instruments", parent_id=project.id)

        # Place the item into the folder via item_ids
        project_service.place_items(self.db, folder.id, [managed_item.id], mode="move")

        # The file on disk must NOT be moved because it's a project reference
        self.assertTrue(Path(managed_original_path).is_file())
        reloaded_item = crud.get_item(self.db, managed_item.id)
        self.assertEqual(reloaded_item.absolute_path, managed_original_path)
        self.assertNotEqual(reloaded_item.parent_id, folder.id)

        # The project reference attributes must have the folder
        reloaded_ref = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertEqual(reloaded_ref.attributes.get("folder"), "Instruments")

        # Now move the item back to the root of the project (out of the folder)
        project_service.place_items(self.db, project.id, [managed_item.id], mode="move")

        # The project reference attributes must NO LONGER have the folder attribute, and must NOT be "."
        reloaded_ref_root = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertNotIn("folder", reloaded_ref_root.attributes or {})

    def test_delete_project_folder_cleans_reference_folder_attributes_and_keeps_files(self):
        project = project_service.create_project(self.db, "Song Gamma", "project", self.vault.id)
        lib_file = self.write_audio(self.asset_store / "loose_samples", "Vocal.wav")
        managed_item = self.register_audio(lib_file)
        managed_original_path = managed_item.absolute_path

        ref = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=managed_item.id,
                relation_kind="use",
            ),
            context_id=project.id,
        )

        folder = project_service.create_folder(self.db, "Vocals", parent_id=project.id)
        project_service.place_items(self.db, folder.id, [managed_item.id], mode="move")

        reloaded_ref = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertEqual(reloaded_ref.attributes.get("folder"), "Vocals")

        # Now delete the folder item via items_router.delete_item
        background_tasks = BackgroundTasks()
        result = items_router.delete_item(folder.id, self.db, background_tasks)
        self.assertEqual(result["status"], "success")

        # The folder item is deleted
        self.assertIsNone(crud.get_item(self.db, folder.id))

        # The referenced file on disk must NOT be touched
        self.assertTrue(Path(managed_original_path).is_file())

        # The reference must still exist in the project, but without the "folder" attribute
        reloaded_ref_after = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertIsNotNone(reloaded_ref_after)
        self.assertNotIn("folder", reloaded_ref_after.attributes or {})

        # The project manifest must be synced and present
        manifest_path, manifest = self.project_manifest(project)
        self.assertTrue(manifest_path.is_file())
        ref_in_manifest = next(r for r in manifest["references"] if r["item"]["id"] == managed_item.id)
        self.assertNotIn("folder", (ref_in_manifest.get("attributes") or {}))

    def test_delete_folder_with_externally_referenced_descendants_succeeds_and_preserves_items(self):
        project1 = project_service.create_project(self.db, "Project One", "project", self.vault.id)
        project2 = project_service.create_project(self.db, "Project Two", "project", self.vault.id)

        folder = project_service.create_folder(self.db, "subfolder", parent_id=project2.id)

        cut_file = self.write_audio(Path(folder.absolute_path), "cut.wav")
        cut_item = self.register_audio(cut_file)
        cut_item.parent_id = folder.id
        self.db.commit()

        # project1 references cut_item (external to project2)
        ref_proj1 = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project1.id,
                to_item_id=cut_item.id,
                relation_kind="derived",
            ),
            context_id=project1.id,
        )

        # project2 also references cut_item
        ref_proj2 = reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project2.id,
                to_item_id=cut_item.id,
                relation_kind="use",
            ),
            context_id=project2.id,
        )

        # Deleting folder must succeed and must NOT throw 'Item is referenced by a project'
        background_tasks = BackgroundTasks()
        result = items_router.delete_item(folder.id, self.db, background_tasks)
        self.assertEqual(result["status"], "success")

        # Folder is deleted
        self.assertIsNone(crud.get_item(self.db, folder.id))

        # cut_item is preserved, reparented to project2.id
        reloaded_cut = crud.get_item(self.db, cut_item.id)
        self.assertIsNotNone(reloaded_cut)
        self.assertEqual(reloaded_cut.parent_id, project2.id)

        # Reference in project1 remains intact
        reloaded_ref1 = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref_proj1.id).first()
        self.assertIsNotNone(reloaded_ref1)

        # Attempting to delete cut_item directly fails because project1 references it
        with self.assertRaises(HTTPException) as ctx:
            items_router.delete_item(cut_item.id, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Item is referenced by a project", ctx.exception.detail)

    def test_place_items_virtual_bins_reference_mode_and_folder_parameter(self):
        project = project_service.create_project(self.db, "Virtual Bin Test", "project", self.vault.id)
        lib_file = self.write_audio(self.asset_store / "loose_samples", "Clap.wav")
        managed_item = self.register_audio(lib_file)
        original_path = managed_item.absolute_path

        # 1. Place unreferenced item into virtual folder "Percussion" via reference mode with folder param
        result = project_service.place_items(
            self.db, project.id, [managed_item.id], mode="reference", folder="Percussion"
        )
        self.assertEqual(result["mode"], "reference")
        # File on disk must NOT be moved
        self.assertTrue(Path(original_path).is_file())
        reloaded_item = crud.get_item(self.db, managed_item.id)
        self.assertEqual(reloaded_item.absolute_path, original_path)

        # Reference must exist and have folder attribute
        ref = self.db.query(models.ItemReference).filter(
            models.ItemReference.context_id == project.id,
            models.ItemReference.to_item_id == managed_item.id,
        ).first()
        self.assertIsNotNone(ref)
        self.assertEqual(ref.attributes.get("folder"), "Percussion")

        # 2. Move existing reference to a nested folder "Percussion/Claps"
        project_service.place_items(
            self.db, project.id, [managed_item.id], mode="reference", folder="Percussion/Claps"
        )
        self.assertTrue(Path(original_path).is_file())
        reloaded_ref = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertEqual(reloaded_ref.attributes.get("folder"), "Percussion/Claps")

        # 3. Move back to root by passing folder=""
        project_service.place_items(
            self.db, project.id, [managed_item.id], mode="reference", folder=""
        )
        self.assertTrue(Path(original_path).is_file())
        reloaded_ref_root = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertNotIn("folder", reloaded_ref_root.attributes or {})

        # 4. Move via HTTP router endpoint items_router.place_items_in_folder
        req = schemas.FolderPlacementRequest(
            item_ids=[managed_item.id],
            mode="reference",
            folder="Final",
        )
        http_result = items_router.place_items_in_folder(project.id, req, self.db)
        self.assertEqual(http_result["mode"], "reference")
        reloaded_ref_http = self.db.query(models.ItemReference).filter(models.ItemReference.id == ref.id).first()
        self.assertEqual(reloaded_ref_http.attributes.get("folder"), "Final")
        self.assertTrue(Path(original_path).is_file())

    def test_locate_original_item(self):
        vstore = vaults.vault_store(self.vault)
        sub_dir = vstore / "Subfolder"
        sub_dir.mkdir(parents=True, exist_ok=True)
        file_path = sub_dir / "sample.wav"
        file_path.write_text("dummy audio", encoding="utf-8")
        folder = crud.create_item(
            self.db,
            schemas.ItemCreate(
                absolute_path=str(sub_dir),
                vault_id=self.vault.id,
                type="folder",
            ),
        )
        sample = crud.create_item(
            self.db,
            schemas.ItemCreate(
                absolute_path=str(file_path),
                vault_id=self.vault.id,
                parent_id=folder.id,
                type="sample",
            ),
        )
        loc = crud.locate_item(self.db, sample.id)
        self.assertIsNotNone(loc)
        self.assertEqual(loc["item_id"], sample.id)
        self.assertEqual(loc["vault_id"], self.vault.id)
        self.assertEqual(loc["ancestor_ids"], [folder.id])
        self.assertEqual(loc["filename"], "sample.wav")

        endpoint_loc = items_router.locate_item_location(sample.id, self.db)
        self.assertEqual(endpoint_loc["item_id"], sample.id)
        self.assertEqual(endpoint_loc["ancestor_ids"], [folder.id])

        # Test referencing this sample in a project
        project = project_service.create_project(self.db, "Locate Test Project", "project", self.vault.id)
        project_service.add_items(self.db, project.id, [sample.id])
        ref = self.db.query(models.ItemReference).filter(
            models.ItemReference.context_id == project.id,
            models.ItemReference.to_item_id == sample.id,
        ).first()
        self.assertIsNotNone(ref)
        ref_loc = crud.locate_item(self.db, ref.to_item_id)
        self.assertEqual(ref_loc["item_id"], sample.id)
        self.assertEqual(ref_loc["ancestor_ids"], [folder.id])

    def test_empty_project_creation_prepares_stage_directories_and_manifest(self):
        project = project_service.create_project(self.db, "Empty New Project", "project", self.vault.id)
        self.assertIsNotNone(project)
        project_root = Path(project.absolute_path)
        self.assertTrue(project_root.is_dir())
        files_root = project_root / "files"
        self.assertTrue(files_root.is_dir())
        self.assertTrue((files_root / "edit").is_dir())
        self.assertTrue((files_root / "source").is_dir())
        self.assertTrue((files_root / "derived").is_dir())
        manifest_file = files_root / "edit" / "current.json"
        self.assertTrue(manifest_file.is_file())
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "gaia-project-state")
        self.assertEqual(manifest["references"], [])

    def test_open_file_location_endpoint(self):
        sample_path = self.write_audio(self.asset_store / "loose", "LocationTest.wav")
        sample = self.register_audio(sample_path)

        with patch("gaia.routers.items._open_file_in_os_file_manager") as mock_open:
            resp = items_router.open_item_location(
                schemas.OpenLocationRequest(item_id=sample.id),
                self.db,
            )
            self.assertEqual(resp["status"], "opened")
            mock_open.assert_called_once()
            called_path = mock_open.call_args[0][0]
            self.assertEqual(str(Path(called_path).resolve()), str(Path(sample.absolute_path).resolve()))

        with self.assertRaises(HTTPException):
            items_router.open_item_location(
                schemas.OpenLocationRequest(item_id=999999),
                self.db,
            )


if __name__ == "__main__":
    unittest.main()


