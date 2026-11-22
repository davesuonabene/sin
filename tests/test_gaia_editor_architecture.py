from __future__ import annotations

import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, text

import api as sin_api
from gaia import (
    collection_importer,
    crud,
    database,
    models,
    project_manifest,
    project_service,
    reconciler,
    schemas,
    vaults,
)
from gaia.routers import (
    editor as editor_router,
    items as items_router,
    media_edits as media_edits_router,
    projects as projects_router,
)
from tests.support import GaiaTestCase


class TestGaiaEditorArchitecture(GaiaTestCase):
    def _register_external_audio(self, name: str = "Take.wav", seconds: float = 0.5) -> tuple[Path, models.Item]:
        wav_path = self.write_audio(self.temp_path / "external_src", name, seconds=seconds)
        item = crud.create_item(
            self.db,
            schemas.AudioItemCreate(
                absolute_path=str(wav_path.resolve()),
                vault_id=self.vault.id,
                title=name,
                storage_mode="external_reference",
                file_hash="hash-" + name,
                size_bytes=wav_path.stat().st_size,
                mime_type="audio/wav",
            ),
        )
        self.db.commit()
        return wav_path, item

    def _register_managed_video(self, name: str = "clip.mp4") -> tuple[Path, models.VideoItem]:
        video_dir = vaults.vault_store(self.vault) / "videos"
        video_dir.mkdir(parents=True, exist_ok=True)
        video_path = video_dir / name
        video_path.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomVIDEO_DATA")
        schema, tags = project_service.file_schema_for_path(video_path, self.vault.id, None)
        self.assertIsInstance(schema, schemas.VideoItemCreate)
        item = crud.create_item(self.db, schema)
        if tags:
            crud.set_item_tags(self.db, item.id, tags)
        self.db.commit()
        return video_path, item

    def _poll_media_job(self, job_id: str, timeout: float = 6.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            data = media_edits_router.read_media_job(job_id)
            if data["status"] in {"completed", "failed"}:
                return data
            time.sleep(0.05)
        self.fail(f"Media job {job_id} did not finish within {timeout}s")

    def test_video_classification_streaming_and_sin_exclusion(self):
        self.assertEqual(reconciler.infer_file_type(Path("clip.mp4")), "video")
        self.assertEqual(reconciler.infer_file_type(Path("take.mov")), "video")
        self.assertEqual(reconciler.infer_file_type(Path("rough.mkv")), "video")
        self.assertIn(reconciler.infer_file_type(Path("voice.m4a")), {"audio", "sample", "track"})
        self.assertIn(".mp4", collection_importer.VIDEO_EXTENSIONS)
        self.assertNotIn(".mp4", collection_importer.AUDIO_EXTENSIONS)
        self.assertIn(".m4a", collection_importer.AUDIO_EXTENSIONS)

        video_path, video_item = self._register_managed_video("studio_cut.mp4")
        _, audio_item = self._register_external_audio("bassline.wav")
        audio_proj = project_service.create_project(
            self.db, "Audio SIN Proj", "project", self.vault.id, project_kind="audio", editor_engine="sin"
        )
        video_proj = project_service.create_project(
            self.db, "Video Cut Proj", "project", self.vault.id, project_kind="video"
        )
        self.db.commit()

        # Streaming video resolves video/* FileResponse pointing to the managed file
        stream_resp = items_router.stream_item(video_item.id, self.db)
        self.assertIsInstance(stream_resp, FileResponse)
        self.assertTrue((stream_resp.media_type or "").startswith("video/"))
        self.assertEqual(Path(stream_resp.path).resolve(), video_path.resolve())

        # SIN /api/library SQLite fallback excludes both VideoItem and video ProjectItem
        with (
            patch("urllib.request.urlopen", side_effect=OSError("Gaia API offline")),
            patch.object(sin_api, "_gaia_db_path", return_value=self.temp_path / "test.db"),
        ):
            lib = sin_api.get_library()

        returned_ids = {int(entry["id"]) for entry in lib.get("files", [])}
        self.assertIn(audio_item.id, returned_ids)
        self.assertIn(audio_proj.id, returned_ids)
        self.assertNotIn(video_item.id, returned_ids)
        self.assertNotIn(video_proj.id, returned_ids)

    def test_project_kind_engine_registry_defaults_and_validation(self):
        reg = editor_router.list_editor_engines()
        self.assertEqual(reg["ephemeral_default_engine"], "simple_media")
        self.assertEqual({e["id"] for e in reg["engines"]}, {"sin", "simple_media"})

        audio_default = projects_router.create_project(
            schemas.ProjectCreateRequest(name="Default Audio", project_kind="audio", vault_id=self.vault.id),
            self.db,
        )
        self.assertEqual(audio_default.project_kind, "audio")
        self.assertEqual(audio_default.editor_engine, "sin")

        audio_simple = projects_router.create_project(
            schemas.ProjectCreateRequest(
                name="Simple Audio",
                project_kind="audio",
                editor_engine="simple_media",
                vault_id=self.vault.id,
            ),
            self.db,
        )
        self.assertEqual(audio_simple.editor_engine, "simple_media")

        video_default = projects_router.create_project(
            schemas.ProjectCreateRequest(name="Default Video", project_kind="video", vault_id=self.vault.id),
            self.db,
        )
        self.assertEqual(video_default.project_kind, "video")
        self.assertEqual(video_default.editor_engine, "simple_media")

        with self.assertRaises(HTTPException) as ctx:
            projects_router.create_project(
                schemas.ProjectCreateRequest(
                    name="Invalid Video SIN",
                    project_kind="video",
                    editor_engine="sin",
                    vault_id=self.vault.id,
                ),
                self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_migrate_project_engines_backfills_legacy_rows(self):
        legacy_db_path = self.temp_path / "legacy_projects.sqlite"
        eng = create_engine(f"sqlite:///{legacy_db_path}")

        proj_edited = self.temp_path / "legacy_edited"
        proj_edited.mkdir()
        (proj_edited / "project.json").write_text(
            json.dumps({"schema": "gaia-project-state", "version": 2, "editor": {"target_id": "item:1"}}),
            encoding="utf-8",
        )
        proj_plain = self.temp_path / "legacy_plain"
        proj_plain.mkdir()
        (proj_plain / "project.json").write_text(
            json.dumps({"schema": "gaia-project-state", "version": 2}),
            encoding="utf-8",
        )

        try:
            with eng.begin() as conn:
                conn.execute(text("CREATE TABLE items (id INTEGER PRIMARY KEY, absolute_path TEXT)"))
                conn.execute(
                    text(
                        "CREATE TABLE project_items (id INTEGER PRIMARY KEY, source_kind TEXT, "
                        "source_path TEXT, contents_json TEXT, warnings_json TEXT)"
                    )
                )
                conn.execute(text("INSERT INTO items (id, absolute_path) VALUES (1, :p)"), {"p": str(proj_edited)})
                conn.execute(text("INSERT INTO items (id, absolute_path) VALUES (2, :p)"), {"p": str(proj_plain)})
                conn.execute(
                    text("INSERT INTO project_items (id, source_kind) VALUES (1, 'managed'), (2, 'managed')")
                )

            with patch.object(database, "engine", eng):
                database.migrate_project_engines()

            with eng.connect() as conn:
                rows = dict(
                    conn.execute(text("SELECT id, project_kind || ':' || editor_engine FROM project_items")).fetchall()
                )
            self.assertEqual(rows[1], "audio:simple_media")
            self.assertEqual(rows[2], "audio:sin")
        finally:
            eng.dispose()

    def test_empty_projects_open_cleanly_in_both_engines(self):
        sin_proj = project_service.create_project(
            self.db, "Empty SIN", "project", self.vault.id, project_kind="audio", editor_engine="sin"
        )
        simple_proj = project_service.create_project(
            self.db, "Empty Simple", "project", self.vault.id, project_kind="audio", editor_engine="simple_media"
        )
        self.db.commit()

        sin_data = editor_router.open_editor_session(sin_proj.id, db=self.db)
        self.assertEqual(sin_data["persistence"], "project")
        self.assertTrue(sin_data["can_save"])
        self.assertTrue(sin_data["is_empty"])
        self.assertEqual(sin_data["editor_engine"], "sin")
        self.assertEqual([n["id"] for n in sin_data["session_data"]["graph"]["nodes"]], ["master"])
        self.assertEqual(sin_data["session_data"]["graph"]["connections"], [])

        simple_data = editor_router.open_editor_session(simple_proj.id, db=self.db)
        self.assertEqual(simple_data["persistence"], "project")
        self.assertTrue(simple_data["can_save"])
        self.assertTrue(simple_data["is_empty"])
        self.assertEqual(simple_data["editor_engine"], "simple_media")
        self.assertEqual(simple_data["targets"], [])
        self.assertIsNone(simple_data["current_target"])

    def test_multifile_simple_media_preserves_independent_targets_and_v3_manifest(self):
        _, a1 = self._register_external_audio("stem_a.wav", seconds=0.6)
        _, a2 = self._register_external_audio("stem_b.wav", seconds=0.6)
        created = projects_router.create_projects_from_items(
            schemas.ProjectFromItemsRequest(
                item_ids=[a1.id, a2.id],
                mode="single",
                name="Multi Cut Proj",
                project_kind="audio",
                editor_engine="simple_media",
                vault_id=self.vault.id,
            ),
            self.db,
        )
        proj_id = created[0].id

        editor_router.save_project_editor_session(
            proj_id,
            schemas.ProjectSessionSaveRequest(
                engine="simple_media",
                data={
                    "active_target_id": f"item:{a1.id}",
                    "targets": {
                        f"item:{a1.id}": {
                            "main_start_sec": 0.1,
                            "main_end_sec": 0.5,
                            "pre_gain_db": -3.0,
                            "volume": 0.9,
                            "cuts": [{"id": "c1", "label": "Kick", "start_sec": 0.1, "end_sec": 0.3}],
                        }
                    },
                },
            ),
            self.db,
        )

        editor_router.save_project_editor_session(
            proj_id,
            schemas.ProjectSessionSaveRequest(
                engine="simple_media",
                data={
                    "active_target_id": f"item:{a2.id}",
                    "targets": {
                        f"item:{a2.id}": {
                            "main_start_sec": 0.05,
                            "main_end_sec": 0.4,
                            "pre_gain_db": 2.0,
                            "cuts": [],
                        }
                    },
                },
            ),
            self.db,
        )

        sess = editor_router.open_editor_session(proj_id, db=self.db)
        targets_map = sess["session_data"]["targets"]
        self.assertIn(f"item:{a1.id}", targets_map)
        self.assertIn(f"item:{a2.id}", targets_map)
        self.assertEqual(targets_map[f"item:{a1.id}"]["cuts"][0]["label"], "Kick")
        self.assertEqual(targets_map[f"item:{a2.id}"]["pre_gain_db"], 2.0)

        proj_row = crud.get_item(self.db, proj_id)
        doc = project_manifest.read_project_manifest(proj_row)
        self.assertEqual(doc["version"], 3)
        self.assertEqual(doc["schema"], "gaia-project-state")
        self.assertEqual(doc["project_kind"], "audio")
        self.assertEqual(doc["editor_engine"], "simple_media")

        # Verify v2 fallback read when a legacy manifest lacks 'session'
        legacy_dir = self.temp_path / "v2_fallback_proj"
        legacy_dir.mkdir(exist_ok=True)
        (legacy_dir / "project.json").write_text(
            json.dumps({
                "schema": "gaia-project-state",
                "version": 2,
                "editor": {"target_id": f"item:{a1.id}", "gain_db": -1.5},
            }),
            encoding="utf-8",
        )
        dummy_proj = models.ProjectItem(
            id=9999,
            type="project",
            absolute_path=str(legacy_dir),
            vault_id=self.vault.id,
            project_kind="audio",
            editor_engine="simple_media",
        )
        v2_session = project_manifest.read_project_session(dummy_proj)
        self.assertIsNotNone(v2_session)
        self.assertEqual(v2_session["engine"], "simple_media")

    def test_strict_project_bound_persistence_and_ephemeral_guards(self):
        _, audio_item = self._register_external_audio("loose.wav")
        _, video_item = self._register_managed_video("loose.mp4")

        for item_id, expected_kind in ((audio_item.id, "audio"), (video_item.id, "video")):
            body = editor_router.open_editor_session(item_id, db=self.db)
            self.assertEqual(body["persistence"], "ephemeral")
            self.assertFalse(body["can_save"])
            self.assertEqual(body["editor_engine"], "simple_media")
            self.assertEqual(body["project_kind"], expected_kind)
            self.assertIsNone(body["project_id"])

            with self.assertRaises(HTTPException) as put_err:
                editor_router.save_project_editor_session(
                    item_id,
                    schemas.ProjectSessionSaveRequest(engine="simple_media", data={}),
                    self.db,
                )
            self.assertEqual(put_err.exception.status_code, 400)

        sin_proj = project_service.create_project(
            self.db, "Mismatch Proj", "project", self.vault.id, project_kind="audio", editor_engine="sin"
        )
        self.db.commit()
        with self.assertRaises(HTTPException) as mismatch_err:
            editor_router.save_project_editor_session(
                sin_proj.id,
                schemas.ProjectSessionSaveRequest(engine="simple_media", data={}),
                self.db,
            )
        self.assertEqual(mismatch_err.exception.status_code, 400)

    def test_ephemeral_promotion_to_sin_autocreates_graph_and_snapshots(self):
        _, audio_item = self._register_external_audio("promote_me.wav", seconds=0.5)
        promo = projects_router.create_projects_from_items(
            schemas.ProjectFromItemsRequest(
                item_ids=[audio_item.id],
                mode="single",
                name="Promoted SIN",
                project_kind="audio",
                editor_engine="sin",
                vault_id=self.vault.id,
                initial_session={
                    "engine": "simple_media",
                    "data": {
                        "target_id": f"item:{audio_item.id}",
                        "main_start_sec": 0.1,
                        "main_end_sec": 0.4,
                        "pre_gain_db": -6.0,
                        "volume": 0.8,
                        "cuts": [
                            {"id": "cut-v", "label": "Verse", "start_sec": 0.1, "end_sec": 0.25},
                            {"id": "cut-c", "label": "Chorus", "start_sec": 0.25, "end_sec": 0.4},
                        ],
                    },
                },
            ),
            self.db,
        )
        proj_id = promo[0].id

        graph_payload = media_edits_router.read_item_graph(proj_id, db=self.db)
        node_by_id = {n["id"]: n for n in graph_payload["graph"]["nodes"]}
        src_node = node_by_id[f"src-{audio_item.id}"]
        self.assertAlmostEqual(src_node["properties"]["crop_start"], 0.2, places=2)
        self.assertAlmostEqual(src_node["properties"]["crop_end"], 0.8, places=2)

        snaps = graph_payload["snapshots"]
        self.assertEqual(len(snaps), 2)
        self.assertEqual([s["label"] for s in snaps], ["Verse", "Chorus"])
        self.assertEqual(snaps[0]["format"], "sin-snapshot")

        # Non-SIN projects reject /items/{id}/graph
        simple_proj = project_service.create_project(
            self.db, "No Graph Proj", "project", self.vault.id, project_kind="audio", editor_engine="simple_media"
        )
        self.db.commit()
        with self.assertRaises(HTTPException) as reject_err:
            media_edits_router.read_item_graph(simple_proj.id, db=self.db)
        self.assertEqual(reject_err.exception.status_code, 400)

    def test_project_checkpoints_ignored_by_reconciler(self):
        _, audio_item = self._register_external_audio("ckpt_src.wav", seconds=0.5)
        created = projects_router.create_projects_from_items(
            schemas.ProjectFromItemsRequest(
                item_ids=[audio_item.id],
                mode="single",
                name="Checkpoint Proj",
                project_kind="audio",
                editor_engine="simple_media",
                vault_id=self.vault.id,
            ),
            self.db,
        )
        proj_id = created[0].id

        editor_router.save_project_editor_session(
            proj_id,
            schemas.ProjectSessionSaveRequest(
                engine="simple_media",
                data={
                    "active_target_id": f"item:{audio_item.id}",
                    "targets": {f"item:{audio_item.id}": {"pre_gain_db": -3.0, "cuts": []}},
                },
            ),
            self.db,
        )

        cp_res = editor_router.create_project_checkpoint(
            proj_id,
            schemas.ProjectCheckpointCreateRequest(label="Before chop"),
            self.db,
        )
        cp = cp_res["checkpoint"]

        proj_row = crud.get_item(self.db, proj_id)
        cp_file = Path(proj_row.absolute_path) / ".gaia" / "snapshots" / cp["filename"]
        self.assertTrue(cp_file.is_file())

        # Reconciler must NOT treat .gaia/snapshots/* as untracked media files
        sync_status = reconciler.scan_vault_discrepancies(self.db, self.vault.id)
        self.assertEqual(sync_status["untracked"], [])

        # Mutate session and restore checkpoint
        editor_router.save_project_editor_session(
            proj_id,
            schemas.ProjectSessionSaveRequest(
                engine="simple_media",
                data={
                    "active_target_id": f"item:{audio_item.id}",
                    "targets": {f"item:{audio_item.id}": {"pre_gain_db": 6.0, "cuts": []}},
                },
            ),
            self.db,
        )
        editor_router.restore_project_checkpoint(proj_id, cp["id"], self.db)
        after_sess = editor_router.open_editor_session(proj_id, db=self.db)
        self.assertEqual(
            after_sess["session_data"]["targets"][f"item:{audio_item.id}"]["pre_gain_db"],
            -3.0,
        )

        editor_router.delete_project_checkpoint(proj_id, cp["id"], self.db)
        self.assertFalse(cp_file.exists())

    def test_non_destructive_export_vault_and_external_folder(self):
        ext_wav, ext_item = self._register_external_audio("field_take.wav", seconds=0.5)
        vault_store_root = vaults.vault_store(self.vault).resolve()

        # 1) Vault export (default) must materialize inside vault_store even for external_reference
        start_job = editor_router.start_media_export(
            schemas.MediaExportRequest(
                source_item_id=ext_item.id,
                main_start_sec=0.05,
                main_end_sec=0.35,
                output_format="wav",
                destination=schemas.MediaExportDestination(
                    mode="vault",
                    vault_id=self.vault.id,
                    filename="chopped",
                    existing_output="cancel",
                ),
            ),
            self.db,
        )
        job = self._poll_media_job(start_job["job_id"])
        self.assertEqual(job["status"], "completed", job.get("error"))
        result = job["result"]
        self.assertTrue(result["registered"])
        out_path = Path(result["exported_paths"][0]).resolve()
        self.assertTrue(out_path.is_file())
        self.assertEqual(out_path.parent, vault_store_root)
        self.assertNotEqual(out_path.parent, ext_wav.parent.resolve())

        conflicts = editor_router.check_export_conflicts(
            schemas.MediaExportRequest(
                source_item_id=ext_item.id,
                output_format="wav",
                destination=schemas.MediaExportDestination(
                    mode="vault",
                    vault_id=self.vault.id,
                    filename="chopped",
                ),
            ),
            self.db,
        )
        self.assertEqual(len(conflicts["conflicts"]), 1)

        # Sequential version export avoids overwrite
        job_v2_start = editor_router.start_media_export(
            schemas.MediaExportRequest(
                source_item_id=ext_item.id,
                output_format="wav",
                destination=schemas.MediaExportDestination(
                    mode="vault",
                    vault_id=self.vault.id,
                    filename="chopped",
                    existing_output="new_version",
                ),
            ),
            self.db,
        )
        job_v2 = self._poll_media_job(job_v2_start["job_id"])
        self.assertEqual(job_v2["status"], "completed", job_v2.get("error"))
        v2_path = Path(job_v2["result"]["exported_paths"][0]).resolve()
        self.assertTrue(v2_path.is_file())
        self.assertNotEqual(v2_path, out_path)

        # 2) External folder export skips GAIA DB registration completely
        db_count_before = self.db.query(models.Item).count()
        ext_out_dir = self.temp_path / "outside_gaia_exports"
        ext_out_dir.mkdir(parents=True, exist_ok=True)
        job_ext_start = editor_router.start_media_export(
            schemas.MediaExportRequest(
                source_item_id=ext_item.id,
                output_format="wav",
                destination=schemas.MediaExportDestination(
                    mode="external_folder",
                    directory_path=str(ext_out_dir),
                    filename="disk_only",
                    existing_output="cancel",
                ),
            ),
            self.db,
        )
        job_ext = self._poll_media_job(job_ext_start["job_id"])
        self.assertEqual(job_ext["status"], "completed", job_ext.get("error"))
        ext_result = job_ext["result"]
        self.assertFalse(ext_result["registered"])
        self.assertEqual(ext_result["items"], [])
        self.assertTrue((ext_out_dir / "disk_only.wav").is_file())
        self.db.expire_all()
        self.assertEqual(self.db.query(models.Item).count(), db_count_before)

    def test_full_length_track_renders_without_four_bar_truncation(self):
        from core.shared_dsp import resolve_and_render_graph
        from ermes.py.compiler import graph_to_workspace

        _, long_item = self._register_external_audio("long_field_take.wav", seconds=10.0)
        created = projects_router.create_projects_from_items(
            schemas.ProjectFromItemsRequest(
                item_ids=[long_item.id],
                mode="single",
                name="Long Track SIN",
                project_kind="audio",
                editor_engine="sin",
                vault_id=self.vault.id,
            ),
            self.db,
        )
        proj = created[0]
        sess = editor_router.open_editor_session(proj.id, db=self.db)
        graph = sess["session_data"]["graph"]
        self.assertEqual(graph["settings"]["total_bars"], "auto")

        # At 120 BPM, 4 bars is only 8.0s; a 10.0s track must render all ~10.0s!
        preview = media_edits_router.render_item_preview(
            proj.id,
            media_edits_router.PreviewRenderRequest(),
            self.db,
        )
        self.assertEqual(preview["status"], "success")
        self.assertGreaterEqual(preview["duration_seconds"], 9.95)
        self.assertEqual(preview["frames"], int(round(preview["duration_seconds"] * preview["sample_rate"])))
        self.assertGreater(len(preview["peaks"]), 100)

        # Workspace compilation path must ALSO preserve full ~10.0s duration!
        ws = graph_to_workspace(graph)
        audio_ws, sr_ws, _ = resolve_and_render_graph(
            base_graph=graph,
            project_root=Path(proj.absolute_path),
            workspace=ws,
        )
        self.assertGreaterEqual(audio_ws.shape[-1] / float(sr_ws), 9.95)

    def test_multitrack_project_autosets_stems_and_zoom_mixdown_mute(self):
        mt_dir = vaults.vault_store(self.vault) / "260720_test_zoom"
        mt_dir.mkdir(parents=True, exist_ok=True)
        zoom = crud.create_item(
            self.db,
            schemas.ZoomH4ItemCreate(
                absolute_path=str(mt_dir.resolve()),
                vault_id=self.vault.id,
                title="260720_test_zoom",
                source_kind="managed",
                source_path=str(mt_dir.resolve()),
            ),
        )
        tr1_p = self.write_audio(mt_dir, "260720_Tr1.WAV", seconds=9.5)
        tr_mic_p = self.write_audio(mt_dir, "260720_TrMic.WAV", seconds=9.5)
        tr_lr_p = self.write_audio(mt_dir, "260720_TrLR.WAV", seconds=9.5)

        stems = {}
        for name, p, role in (
            ("Tr1", tr1_p, "source_channel"),
            ("TrMic", tr_mic_p, "source_channel"),
            ("TrLR", tr_lr_p, "mixdown"),
        ):
            stems[name] = crud.create_item(
                self.db,
                schemas.TrackItemCreate(
                    absolute_path=str(p.resolve()),
                    vault_id=self.vault.id,
                    parent_id=zoom.id,
                    title=name,
                    mime_type="audio/wav",
                    file_hash="h-" + name,
                    size_bytes=p.stat().st_size,
                    attributes={"profile_role": role},
                ),
            )
        self.db.commit()

        created = projects_router.create_projects_from_items(
            schemas.ProjectFromItemsRequest(
                item_ids=[zoom.id],
                mode="single",
                name="Zoom Auto SIN",
                project_kind="audio",
                editor_engine="sin",
                vault_id=self.vault.id,
            ),
            self.db,
        )
        proj = created[0]
        sess = editor_router.open_editor_session(proj.id, db=self.db)
        self.assertTrue(sess["is_multitrack"])
        self.assertFalse(sess["is_empty"])

        graph_nodes = sess["session_data"]["graph"]["nodes"]
        node_ids = {n["id"] for n in graph_nodes}
        self.assertNotIn(f"src-{zoom.id}", node_ids)
        self.assertIn(f"grp-{zoom.id}", node_ids)

        layers_by_item = {l["item_id"]: l for l in sess["layers"]}
        self.assertEqual(set(layers_by_item.keys()), {stems["Tr1"].id, stems["TrMic"].id, stems["TrLR"].id})
        self.assertFalse(layers_by_item[stems["Tr1"].id]["muted"])
        self.assertFalse(layers_by_item[stems["TrMic"].id]["muted"])
        self.assertTrue(layers_by_item[stems["TrLR"].id]["muted"])
        self.assertTrue(layers_by_item[stems["TrLR"].id]["is_mixdown"])

        preview = media_edits_router.render_item_preview(
            proj.id,
            media_edits_router.PreviewRenderRequest(),
            self.db,
        )
        self.assertGreaterEqual(preview["duration_seconds"], 9.45)

    def test_graph_add_remove_reset_and_transient_overrides(self):
        _, audio_item = self._register_external_audio("chop_src.wav", seconds=2.0)
        sin_proj = projects_router.create_project(
            schemas.ProjectCreateRequest(
                name="Clean Start SIN",
                project_kind="audio",
                editor_engine="sin",
                vault_id=self.vault.id,
            ),
            self.db,
        )

        # Load sample + cuts into empty SIN graph
        updated_sess = editor_router.add_item_to_project_graph(
            sin_proj.id,
            editor_router.GraphAddItemRequest(
                item_id=audio_item.id,
                crop_start=0.25,
                crop_end=0.75,
                pre_gain_db=-3.0,
                volume=0.8,
                cuts=[{"id": "cut-drop", "label": "Drop", "start_sec": 0.5, "end_sec": 1.0}],
            ),
            self.db,
        )
        self.assertEqual(len(updated_sess["layers"]), 1)
        layer = updated_sess["layers"][0]
        self.assertAlmostEqual(layer["crop_start"], 0.25, places=3)
        self.assertAlmostEqual(layer["crop_end"], 0.75, places=3)
        self.assertAlmostEqual(layer["pre_gain_db"], -3.0, places=1)
        self.assertAlmostEqual(layer["volume"], 0.8, places=2)
        self.assertEqual([s["label"] for s in updated_sess["session_data"]["snapshots"]], ["Drop"])

        # Preview with transient override cropping to 0.25..0.5 -> ~0.5s output
        preview = media_edits_router.render_item_preview(
            sin_proj.id,
            media_edits_router.PreviewRenderRequest(
                transient_overrides={f"src-{audio_item.id}": {"crop_start": 0.25, "crop_end": 0.5}}
            ),
            self.db,
        )
        self.assertAlmostEqual(preview["duration_seconds"], 0.5, places=1)

        # Remove channel without deleting underlying DB item
        after_remove = editor_router.remove_project_graph_channel(sin_proj.id, layer["ch_node_id"], self.db)
        self.assertEqual(after_remove["layers"], [])
        self.assertIsNotNone(crud.get_item(self.db, audio_item.id))

        # Add again then reset graph cleanly
        editor_router.add_item_to_project_graph(
            sin_proj.id,
            editor_router.GraphAddItemRequest(item_id=audio_item.id),
            self.db,
        )
        after_reset = editor_router.reset_project_sin_graph(sin_proj.id, self.db)
        self.assertTrue(after_reset["is_empty"])
        self.assertEqual(after_reset["layers"], [])


if __name__ == "__main__":
    unittest.main()
