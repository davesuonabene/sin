from pathlib import Path
import shutil

from gaia import crud, deletion_service, mirrors, models, project_service, reconciler, reference_service, schemas, vaults
from gaia.routers import vaults as vaults_router
from tests.support import GaiaTestCase



class TestGaiaReconciler(GaiaTestCase):
    def test_empty_vault_is_in_sync(self):
        status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertTrue(status["in_sync"])
        self.assertEqual(status["untracked"], [])
        self.assertEqual(status["missing"], [])
        self.assertEqual(status["moved"], [])
        self.assertEqual(status["total_discrepancies"], 0)

    def test_detects_manually_added_untracked_files(self):
        store = vaults.vault_store(self.vault)
        # Drop a file directly on disk without using GAIA import
        audio_file = self.write_audio(store / "samples", "Kick_01.wav")
        midi_file = store / "midi" / "Chords.mid"
        midi_file.parent.mkdir(parents=True, exist_ok=True)
        midi_file.write_bytes(b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60")

        # Drop an ignored DAW sidecar and temp file
        (store / "samples" / "Kick_01.wav.asd").write_bytes(b"ableton sidecar")
        (store / "samples" / ".temp.wav").write_bytes(b"temp")

        status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertFalse(status["in_sync"])
        self.assertEqual(len(status["untracked"]), 2)
        filenames = [u["filename"] for u in status["untracked"]]
        self.assertIn("Kick_01.wav", filenames)
        self.assertIn("Chords.mid", filenames)
        self.assertNotIn("Kick_01.wav.asd", filenames)
        self.assertNotIn(".temp.wav", filenames)

        kick_entry = next(u for u in status["untracked"] if u["filename"] == "Kick_01.wav")
        self.assertEqual(kick_entry["type"], "sample")
        self.assertTrue(kick_entry["size_bytes"] > 0)

        chords_entry = next(u for u in status["untracked"] if u["filename"] == "Chords.mid")
        self.assertEqual(chords_entry["type"], "midi")

    def test_reconcile_adds_untracked_files_to_database(self):
        store = vaults.vault_store(self.vault)
        audio_file = self.write_audio(store / "files", "Snare_01.wav")

        res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(add_all_untracked=True),
        )
        self.assertEqual(res.added_count, 1)
        self.assertTrue(res.in_sync)

        # Verify DB item exists and is ready
        db_item = crud.get_item_by_path(self.db, str(audio_file.resolve()), self.vault.id)
        self.assertIsNotNone(db_item)
        self.assertEqual(db_item.type, "sample")
        self.assertEqual(db_item.availability, "ready")

    def test_detects_manually_deleted_missing_files(self):
        store = vaults.vault_store(self.vault)
        audio_file = self.write_audio(store / "files", "Present.wav")
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(audio_file.resolve()),
                vault_id=self.vault.id,
                type="sample",
                size_bytes=audio_file.stat().st_size,
            ),
        )

        status_before = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertTrue(status_before["in_sync"])

        # Manually delete the file on disk
        audio_file.unlink()

        status_after = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertFalse(status_after["in_sync"])
        self.assertEqual(len(status_after["missing"]), 1)
        self.assertEqual(status_after["missing"][0]["id"], item.id)

    def test_reconcile_marks_missing_and_purges(self):
        store = vaults.vault_store(self.vault)
        audio_file = self.write_audio(store / "files", "Disappeared.wav")
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(audio_file.resolve()),
                vault_id=self.vault.id,
                type="sample",
                size_bytes=audio_file.stat().st_size,
            ),
        )
        audio_file.unlink()

        # Mark missing
        res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(mark_missing=[item.id]),
        )
        self.assertEqual(res.marked_missing_count, 1)
        self.db.expire_all()
        refreshed = crud.get_item(self.db, item.id)
        self.assertEqual(refreshed.availability, "missing")

        # Purge missing
        purge_res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(purge_missing=[item.id]),
        )
        self.assertEqual(purge_res.purged_count, 1)
        self.db.expire_all()
        self.assertIsNone(crud.get_item(self.db, item.id))

    def test_detects_and_relinks_moved_files(self):
        store = vaults.vault_store(self.vault)
        old_path = self.write_audio(store / "files", "Loop.wav")
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(old_path.resolve()),
                vault_id=self.vault.id,
                type="sample",
                size_bytes=old_path.stat().st_size,
            ),
        )

        # Move file manually to another subfolder
        new_dir = store / "organized" / "loops"
        new_dir.mkdir(parents=True, exist_ok=True)
        new_path = new_dir / "Loop.wav"
        old_path.replace(new_path)

        status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertFalse(status["in_sync"])
        self.assertEqual(len(status["missing"]), 1)
        self.assertEqual(len(status["untracked"]), 1)
        self.assertEqual(len(status["moved"]), 1)
        self.assertEqual(status["moved"][0]["item_id"], item.id)
        self.assertEqual(status["moved"][0]["new_path"], str(new_path.resolve()))

        # Relink via reconcile
        relink_res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(
                relink_moved=[
                    schemas.RelinkMovedPair(item_id=item.id, new_path=str(new_path.resolve()))
                ]
            ),
        )
        self.assertEqual(relink_res.relinked_count, 1)
        self.assertTrue(relink_res.in_sync)

        self.db.expire_all()
        refreshed = crud.get_item(self.db, item.id)
        self.assertEqual(refreshed.absolute_path, str(new_path.resolve()))
        self.assertEqual(refreshed.availability, "ready")

    def test_sync_status_and_reconcile_api_endpoints(self):
        store = vaults.vault_store(self.vault)

        # 1. Sync status endpoint on empty vault
        data = vaults_router.read_vault_sync_status(self.vault.id, self.db)
        self.assertTrue(data["in_sync"])
        self.assertEqual(data["total_discrepancies"], 0)

        # 2. Add an untracked file
        audio = self.write_audio(store / "drop", "Drop.wav")
        data2 = vaults_router.read_vault_sync_status(self.vault.id, self.db)
        self.assertFalse(data2["in_sync"])
        self.assertEqual(len(data2["untracked"]), 1)

        # 3. Post reconcile to add all untracked
        rec_data = vaults_router.reconcile_vault_endpoint(
            self.vault.id,
            schemas.VaultReconcileRequest(add_all_untracked=True),
            self.db,
        )
        self.assertEqual(rec_data.added_count, 1)
        self.assertTrue(rec_data.in_sync)

    def test_reconcile_places_untracked_file_inside_project_container(self):
        project = project_service.create_project(self.db, "MyProject", "project", self.vault.id)
        proj_dir = Path(project.absolute_path)
        audio = self.write_audio(proj_dir / "files", "Recording.wav")

        res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(add_all_untracked=True),
        )
        self.assertEqual(res.added_count, 1)

        db_item = crud.get_item_by_path(self.db, str(audio.resolve()), self.vault.id)
        self.assertIsNotNone(db_item)
        self.assertEqual(db_item.parent_id, project.id)

        # Reference should be established in the project
        refs = reference_service.list_references(self.db, project.id)
        ref_target_ids = {r.to_item_id for r in refs}
        self.assertIn(db_item.id, ref_target_ids)

    def test_reconcile_establishes_version_compatibility_for_project_reference(self):
        store = vaults.vault_store(self.vault)
        # Create an original sample elsewhere in vault
        orig_file = self.write_audio(store / "sources", "Stem.wav")
        orig_item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(orig_file.resolve()),
                vault_id=self.vault.id,
                type="sample",
                size_bytes=orig_file.stat().st_size,
            ),
        )

        project = project_service.create_project(self.db, "AbletonSession", "project", self.vault.id)
        # Project references orig_item with custom stage and folder attributes
        reference_service.create_reference(
            self.db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=orig_item.id,
                relation_kind="use",
                stage_name="mixdown",
                attributes={"folder": "loops"},
            ),
            context_id=project.id,
        )

        # User edits in Ableton and saves new version Stem.02.wav into project files
        proj_dir = Path(project.absolute_path)
        v2_file = self.write_audio(proj_dir / "files", "Stem.02.wav")

        res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(add_all_untracked=True),
        )
        self.assertEqual(res.added_count, 1)

        v2_item = crud.get_item_by_path(self.db, str(v2_file.resolve()), self.vault.id)
        self.assertIsNotNone(v2_item)
        self.assertEqual(v2_item.parent_id, project.id)

        # Version compatibility: ItemReference created inheriting metadata
        v2_ref = (
            self.db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.to_item_id == v2_item.id,
            )
            .first()
        )
        self.assertIsNotNone(v2_ref)
        self.assertEqual(v2_ref.relation_kind, "use")
        self.assertIn("mixdown", reference_service.relation_tags(v2_ref))
        self.assertEqual(v2_ref.attributes.get("folder"), "loops")

        # Project table should group them into 1 row with 2 versions
        table = reference_service.project_table(self.db, project.id)
        self.assertEqual(len(table), 1)
        row = table[0]
        self.assertEqual(row["version_group"], "stem.wav")
        self.assertEqual(len(row["versions"]), 2)
        # The latest version (.02) should be selected
        self.assertEqual(row["item"].id, v2_item.id)

    def test_reconcile_ignores_current_json_manifest(self):
        project = project_service.create_project(self.db, "ManifestProject", "project", self.vault.id)
        proj_dir = Path(project.absolute_path)
        edit_dir = proj_dir / "files" / "edit"
        edit_dir.mkdir(parents=True, exist_ok=True)
        (edit_dir / "current.json").write_text('{"state": "saved"}', encoding="utf-8")

        status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertTrue(status["in_sync"])
        self.assertEqual(len(status["untracked"]), 0)

    def test_reconcile_repairs_existing_orphaned_project_files(self):
        project = project_service.create_project(self.db, "HealProject", "project", self.vault.id)
        proj_dir = Path(project.absolute_path)
        audio = self.write_audio(proj_dir / "files", "HealMe.wav")

        # Create item directly with parent_id=None (simulating legacy bug)
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(audio.resolve()),
                vault_id=self.vault.id,
                parent_id=None,
                type="sample",
                size_bytes=audio.stat().st_size,
            ),
        )
        self.assertIsNone(item.parent_id)

        # Run reconcile
        reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(),
        )

        self.db.expire_all()
        refreshed = crud.get_item(self.db, item.id)
        self.assertEqual(refreshed.parent_id, project.id)
        refs = reference_service.list_references(self.db, project.id)
        self.assertIn(item.id, {r.to_item_id for r in refs})

    def test_mirror_reference_1to1_and_partial_collect_into_vault(self):
        ext_root = self.temp_path / "ExternalPack"
        kick_src = self.write_audio(ext_root / "Drums", "Kick.wav", seconds=0.1)
        snare_src = self.write_audio(ext_root / "Drums", "Snare.wav", seconds=0.2)
        pad_src = self.write_audio(ext_root, "Pad.wav", seconds=0.3)

        mirror = mirrors.create_mirror(
            self.db,
            self.vault.id,
            schemas.VaultMirrorCreate(
                source_path=str(ext_root),
                target_folder_path="ExternalPack",
                mode="reference_1to1",
            ),
        )
        self.assertIsNotNone(mirror.root_item_id)
        root_folder = crud.get_item(self.db, mirror.root_item_id)
        self.assertEqual(root_folder.type, "folder")
        self.assertEqual(root_folder.storage_mode, "external_reference")

        kick_item = self.db.query(models.Item).filter(models.Item.absolute_path == str(kick_src.resolve())).first()
        snare_item = self.db.query(models.Item).filter(models.Item.absolute_path == str(snare_src.resolve())).first()
        pad_item = self.db.query(models.Item).filter(models.Item.absolute_path == str(pad_src.resolve())).first()
        self.assertIsNotNone(kick_item)
        self.assertIsNotNone(snare_item)
        self.assertIsNotNone(pad_item)
        self.assertEqual(kick_item.storage_mode, "external_reference")
        self.assertEqual(snare_item.storage_mode, "external_reference")

        # Partial collect of Kick.wav into vault
        collected = vaults.collect_items_into_vault(self.db, [kick_item.id])
        self.assertTrue(any(i.id == kick_item.id for i in collected))
        self.db.expire_all()

        kick_after = crud.get_item(self.db, kick_item.id)
        snare_after = crud.get_item(self.db, snare_item.id)
        expected_kick_dest = vaults.vault_store(self.vault) / "ExternalPack" / "Drums" / "Kick.wav"
        self.assertEqual(kick_after.storage_mode, "managed")
        self.assertEqual(Path(kick_after.absolute_path), expected_kick_dest.resolve())
        self.assertTrue(expected_kick_dest.is_file())
        self.assertEqual(kick_after.attributes["import"]["source_path"], str(kick_src.resolve()))

        # Snare remains an external reference at its original path
        self.assertEqual(snare_after.storage_mode, "external_reference")
        self.assertEqual(Path(snare_after.absolute_path), snare_src.resolve())

        # Mirror scanner knows Kick is already in the vault via source_path
        m_status = mirrors.scan_mirror_discrepancies(self.db, mirror)
        self.assertTrue(m_status["in_sync"])
        self.assertEqual(m_status["total_discrepancies"], 0)

    def test_mirror_distill_copy_conflict_versioning_and_reorganization(self):
        ext_root = self.temp_path / "FieldDrops"
        kick_a = self.write_audio(ext_root / "SubA", "Kick.wav", seconds=0.1)
        kick_b = self.write_audio(ext_root / "SubB", "Kick.wav", seconds=0.25)
        dup_a = ext_root / "SubC" / "Kick.wav"
        dup_a.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(kick_a, dup_a)

        mirror = mirrors.create_mirror(
            self.db,
            self.vault.id,
            schemas.VaultMirrorCreate(
                source_path=str(ext_root),
                target_folder_path="Distilled",
                mode="distill_copy",
            ),
        )
        store = vaults.vault_store(self.vault)
        distilled_dir = store / "Distilled"
        self.assertTrue((distilled_dir / "Kick.wav").is_file())
        self.assertTrue((distilled_dir / "Kick [SubB].wav").is_file())

        # Modify SubA/Kick.wav externally -> triggers sync warning and creates .02 revision on sync
        self.write_audio(ext_root / "SubA", "Kick.wav", seconds=0.45)
        vault_status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertFalse(vault_status["in_sync"])
        self.assertEqual(len(vault_status["mirrors"][0]["modified_files"]), 1)

        rec_res = reconciler.reconcile_vault(
            self.db,
            self.vault.id,
            schemas.VaultReconcileRequest(sync_all_mirrors=True),
        )
        self.assertEqual(rec_res.mirrored_count, 1)
        self.assertTrue((distilled_dir / "Kick.02.wav").is_file())
        self.assertTrue((distilled_dir / "Kick.wav").is_file())

        # Reorganize Kick [SubB].wav into another folder inside the vault -> mirror still sees it as in_sync
        other_folder = project_service.create_folder(self.db, "Reorganized", vault_id=self.vault.id)
        kick_b_item = crud.get_item_by_path(self.db, str((distilled_dir / "Kick [SubB].wav").resolve()), self.vault.id)
        project_service.place_items(self.db, other_folder.id, [kick_b_item.id], mode="move")

        m_status_after = mirrors.scan_mirror_discrepancies(self.db, mirror)
        self.assertTrue(m_status_after["in_sync"])

    def test_folder_dissolve_vs_normal_folder_delete(self):
        pack = project_service.create_folder(self.db, "LoopPack", vault_id=self.vault.id)
        sub = project_service.create_folder(self.db, "Sub", vault_id=self.vault.id, parent_id=pack.id)

        f1_src = self.write_audio(self.temp_path / "src", "Loop1.wav")
        f2_src = self.write_audio(self.temp_path / "src", "Loop2.wav")
        f1_dest = Path(pack.absolute_path) / "Loop1.wav"
        f2_dest = Path(sub.absolute_path) / "Loop2.wav"
        shutil.copy2(f1_src, f1_dest)
        shutil.copy2(f2_src, f2_dest)

        item1 = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(f1_dest.resolve()),
                vault_id=self.vault.id,
                parent_id=pack.id,
                type="sample",
                size_bytes=f1_dest.stat().st_size,
            ),
        )
        item2 = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(f2_dest.resolve()),
                vault_id=self.vault.id,
                parent_id=sub.id,
                type="sample",
                size_bytes=f2_dest.stat().st_size,
            ),
        )

        # 1. Explicit Dissolve of Sub moves Loop2.wav into LoopPack and deletes Sub
        dissolve_res = project_service.dissolve_folder(self.db, sub.id)
        self.assertEqual(dissolve_res["parent_id"], pack.id)
        self.assertEqual(dissolve_res["moved_count"], 1)
        self.assertIsNone(crud.get_item(self.db, sub.id))
        self.assertFalse(Path(sub.absolute_path).exists())

        self.db.expire_all()
        item2_after = crud.get_item(self.db, item2.id)
        self.assertEqual(item2_after.parent_id, pack.id)
        self.assertEqual(Path(item2_after.absolute_path), (Path(pack.absolute_path) / "Loop2.wav").resolve())

        # 2. Link Loop1.wav to a Project, then normal-delete LoopPack:
        # Loop2.wav and LoopPack are deleted, while Loop1.wav is preserved at vault root
        project = project_service.create_project(self.db, "RefProject", "project", self.vault.id)
        reference_service.create_source_reference(self.db, project.id, item1.id)

        del_res = deletion_service.delete_entries(self.db, [schemas.ItemDeleteLocator(item_id=pack.id)])
        self.assertEqual(del_res["status"], "success")
        self.assertIsNone(crud.get_item(self.db, pack.id))
        self.assertIsNone(crud.get_item(self.db, item2.id))

        self.db.expire_all()
        item1_preserved = crud.get_item(self.db, item1.id)
        self.assertIsNotNone(item1_preserved)
        self.assertIsNone(item1_preserved.parent_id)
        self.assertTrue(Path(item1_preserved.absolute_path).is_file())

    def test_all_vaults_sync_status_and_reconcile(self):
        vault2 = vaults.create_vault(self.db, "Second Vault", None, preview="hidden")
        store1 = vaults.vault_store(self.vault)
        store2 = vaults.vault_store(vault2)

        self.write_audio(store1 / "FolderA", "Untracked1.wav")
        self.write_audio(store2 / "FolderB", "Untracked2.wav")

        all_status = vaults_router.read_all_vaults_sync_status(self.db)
        self.assertFalse(all_status["in_sync"])
        self.assertEqual(all_status["total_discrepancies"], 2)
        self.assertEqual(len(all_status["untracked"]), 2)
        vault_ids_seen = {u["vault_id"] for u in all_status["untracked"]}
        self.assertEqual(vault_ids_seen, {self.vault.id, vault2.id})

        rec_res = vaults_router.reconcile_all_vaults_endpoint(
            schemas.VaultReconcileRequest(add_all_untracked=True),
            self.db,
        )
        self.assertEqual(rec_res.added_count, 2)
        self.assertTrue(rec_res.in_sync)



