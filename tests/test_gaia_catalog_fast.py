"""Tests for GAIA's accelerated catalog engine: snapshots, atomic deltas, FTS5, 1-level children, fast streaming, and native preview."""

from __future__ import annotations

import gzip
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import event

import api
from core.audio_engine import is_native_engine_available
from core.realtime_host import RealtimeAudioHost
from gaia import catalog, crud, database, models, schemas, vaults
from gaia.routers import catalog as catalog_router, items as items_router
from tests.support import GaiaTestCase


class _FakeRequest:
    def __init__(self, headers: dict[str, str] | None = None):
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}


class TestGaiaCatalogAcceleration(GaiaTestCase):
    def test_snapshot_gzip_etag_and_delta_triggers_cover_all_mutations(self):
        # 1. Create folder + nested subfolder + sample
        folder_dir = vaults.vault_store(self.vault) / "Drums"
        sub_dir = folder_dir / "Kicks"
        kick_path = self.write_audio(sub_dir, "Punchy_Kick_124.wav")

        folder = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(folder_dir.resolve()),
                vault_id=self.vault.id,
                title="Drums",
                source_kind="managed",
                type="folder",
            ),
        )
        sub = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(sub_dir.resolve()),
                vault_id=self.vault.id,
                parent_id=folder.id,
                title="Kicks",
                source_kind="managed",
                type="folder",
            ),
        )
        kick = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(kick_path.resolve()),
                vault_id=self.vault.id,
                parent_id=sub.id,
                type="sample",
                bpm=124,
                key="C",
                is_loop=False,
            ),
        )
        crud.set_item_tags(self.db, kick.id, ["Kick", "Punchy"])

        # 2. Full gzipped snapshot + ETag 304 check
        resp = catalog_router.read_catalog_snapshot(
            _FakeRequest({"accept-encoding": "gzip"}),
            db=self.db,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("content-encoding"), "gzip")
        etag = resp.headers.get("etag")
        self.assertTrue(etag and etag.startswith('"rev-'))

        snap = json.loads(gzip.decompress(resp.body).decode("utf-8"))
        self.assertEqual(snap["schema"], "gaia-catalog-v1")
        rev0 = snap["rev"]
        self.assertGreaterEqual(rev0, 1)
        row_by_id = {r[0]: r for r in snap["rows"]}
        self.assertIn(folder.id, row_by_id)
        self.assertIn(sub.id, row_by_id)
        self.assertIn(kick.id, row_by_id)
        self.assertEqual(row_by_id[kick.id][2], sub.id)
        self.assertEqual(row_by_id[kick.id][11], 124)  # bpm
        self.assertEqual(row_by_id[kick.id][12], "C")  # key
        kick_tag_names = {snap["tags"][str(tid)] for tid in row_by_id[kick.id][21]}
        self.assertEqual(kick_tag_names, {"Kick", "Punchy"})

        # Conditional 304 on matching ETag
        not_mod = catalog_router.read_catalog_snapshot(
            _FakeRequest({"accept-encoding": "gzip", "if-none-match": etag}),
            db=self.db,
        )
        self.assertEqual(not_mod.status_code, 304)

        # Unchanged delta returns empty
        delta_empty = catalog_router.read_catalog_delta(since_rev=rev0, db=self.db)
        self.assertFalse(delta_empty["full_reload"])
        self.assertEqual(delta_empty["rev"], rev0)
        self.assertEqual(delta_empty["upserted"], [])
        self.assertEqual(delta_empty["deleted_ids"], [])

        # 3. Mutate metadata (subtype bpm + favourite + tags) -> triggers bump rev & record delta
        items_router.update_item(
            kick.id,
            schemas.ItemUpdate(bpm=128, favourite=True, tags=["Kick", "Analog"]),
            db=self.db,
        )
        delta1 = catalog_router.read_catalog_delta(since_rev=rev0, db=self.db)
        self.assertFalse(delta1["full_reload"])
        self.assertGreater(delta1["rev"], rev0)
        upserted_map = {r[0]: r for r in delta1["upserted"]}
        self.assertIn(kick.id, upserted_map)
        self.assertEqual(upserted_map[kick.id][11], 128)
        self.assertTrue(upserted_map[kick.id][14])  # favourite
        new_tags = {delta1["tags"][str(tid)] for tid in upserted_map[kick.id][21]}
        self.assertEqual(new_tags, {"Kick", "Analog"})

        # 4. Playlist creation + addition -> triggers playlist delta
        rev1 = delta1["rev"]
        pl = crud.create_playlist(self.db, "Favorites")
        crud.add_playlist_items(self.db, pl.id, [kick.id])
        delta2 = catalog_router.read_catalog_delta(since_rev=rev1, db=self.db)
        self.assertGreater(delta2["rev"], rev1)
        self.assertIn("playlists", delta2)
        self.assertEqual(delta2["playlists"][0]["item_ids"], [kick.id])

        # 5. Delete sample -> triggers delete delta
        rev2 = delta2["rev"]
        crud.delete_item(self.db, kick.id)
        delta3 = catalog_router.read_catalog_delta(since_rev=rev2, db=self.db)
        self.assertGreater(delta3["rev"], rev2)
        self.assertIn(kick.id, delta3["deleted_ids"])

    def test_direct_children_and_fts5_incremental_search(self):
        root_dir = vaults.vault_store(self.vault) / "PackA"
        sub_dir = root_dir / "Bass"
        wav_path = self.write_audio(sub_dir, "Sub_808_Fmin.wav")

        root = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(root_dir.resolve()),
                vault_id=self.vault.id,
                title="PackA",
                source_kind="managed",
                type="folder",
            ),
        )
        sub = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(sub_dir.resolve()),
                vault_id=self.vault.id,
                parent_id=root.id,
                title="Bass",
                source_kind="managed",
                type="folder",
            ),
        )
        sample = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(wav_path.resolve()),
                vault_id=self.vault.id,
                parent_id=sub.id,
                type="sample",
                key="Fm",
                bpm=140,
            ),
        )

        # Direct 1-level children of root must return ONLY `sub`, not deep leaf `sample`
        direct = items_router.get_item_direct_children(root.id, db=self.db)
        self.assertEqual([r[0] for r in direct["rows"]], [sub.id])

        # FTS5 search locates deep leaf AND resolves root ancestor via recursive CTE
        search1 = catalog_router.search_catalog(q="808", db=self.db)
        self.assertIn(sample.id, search1["item_ids"])
        self.assertEqual(search1["root_ids"], [root.id])

        # Adding a tag updates FTS5 incrementally on the next search
        crud.set_item_tags(self.db, sample.id, ["DistortedSub"])
        search2 = catalog_router.search_catalog(q="DistortedSub", db=self.db)
        self.assertIn(sample.id, search2["item_ids"])
        self.assertEqual(search2["root_ids"], [root.id])

        # Deleting removes it from FTS5 incrementally
        crud.delete_item(self.db, sample.id)
        search3 = catalog_router.search_catalog(q="DistortedSub", db=self.db)
        self.assertEqual(search3["item_ids"], [])

    def test_fast_stream_avoids_folder_hydration_n_plus_one(self):
        pack_dir = vaults.vault_store(self.vault) / "BigPack"
        pack = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(pack_dir.resolve()),
                vault_id=self.vault.id,
                title="BigPack",
                source_kind="managed",
                type="folder",
            ),
        )
        sub_dir = pack_dir / "Hits"
        sub = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(sub_dir.resolve()),
                vault_id=self.vault.id,
                parent_id=pack.id,
                title="Hits",
                source_kind="managed",
                type="folder",
            ),
        )
        first_item = None
        for idx in range(25):
            wav = self.write_audio(sub_dir, f"hit_{idx:02d}.wav")
            created = crud.create_item(
                self.db,
                schemas.SampleItemCreate(
                    absolute_path=str(wav.resolve()),
                    vault_id=self.vault.id,
                    parent_id=sub.id,
                    type="sample",
                ),
            )
            if first_item is None:
                first_item = created

        queries: list[str] = []
        listener = lambda _c, _cur, stmt, _p, _ctx, _m: queries.append(stmt)
        event.listen(self.engine, "before_cursor_execute", listener)
        try:
            resp_direct = items_router.stream_item(first_item.id, db=self.db)
            direct_count = len(queries)
            queries.clear()
            resp_content = items_router.stream_collection_content(pack.id, 0, db=self.db)
            content_count = len(queries)
        finally:
            event.remove(self.engine, "before_cursor_execute", listener)

        self.assertEqual(Path(resp_direct.path).resolve(), Path(first_item.absolute_path).resolve())
        self.assertEqual(Path(resp_content.path).resolve(), Path(first_item.absolute_path).resolve())
        self.assertLessEqual(direct_count, 2, f"stream_item ran too many queries: {direct_count}")
        self.assertLessEqual(content_count, 4, f"stream_collection_content ran too many queries: {content_count}")

    def test_sin_api_library_unpacks_gzipped_catalog_snapshot(self):
        pack_dir = vaults.vault_store(self.vault) / "SinPack"
        wav_path = self.write_audio(pack_dir / "Perc", "Clap.wav")
        pack = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str(pack_dir.resolve()),
                vault_id=self.vault.id,
                title="SinPack",
                source_kind="managed",
                type="folder",
            ),
        )
        perc = crud.create_item(
            self.db,
            schemas.FolderItemCreate(
                absolute_path=str((pack_dir / "Perc").resolve()),
                vault_id=self.vault.id,
                parent_id=pack.id,
                title="Perc",
                source_kind="managed",
                type="folder",
            ),
        )
        clap = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(wav_path.resolve()),
                vault_id=self.vault.id,
                parent_id=perc.id,
                type="sample",
                bpm=120,
            ),
        )
        _rev, gz_bytes, _is_gz = catalog.get_snapshot_payload(self.db, vault_id=self.vault.id, accept_gzip=True)

        class _FakeResp:
            status = 200
            headers = {"Content-Encoding": "gzip"}
            def read(self):
                return gz_bytes
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        with patch("urllib.request.urlopen", return_value=_FakeResp()):
            result = api.get_library(vault_id=self.vault.id)

        files = result["files"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["id"], pack.id)
        self.assertEqual(len(files[0]["contents"]), 1)
        self.assertEqual(files[0]["contents"][0]["id"], clap.id)
        self.assertEqual(files[0]["contents"][0]["folder"], "Perc")

    def test_realtime_host_preview_item_reuses_native_engine(self):
        if not is_native_engine_available():
            self.skipTest("Native libsin_dsp DLL unavailable in this environment")
        wav_path = self.write_audio(vaults.vault_store(self.vault) / "audition", "Snap.wav", seconds=0.2)
        item = crud.create_item(
            self.db,
            schemas.SampleItemCreate(
                absolute_path=str(wav_path.resolve()),
                vault_id=self.vault.id,
                type="sample",
            ),
        )
        host = RealtimeAudioHost(
            name="test-preview",
            item_path_resolver=lambda iid: str(wav_path.resolve()) if iid == item.id else None,
        )
        try:
            # Verify plan packing + load without requiring an interactive OS audio output device
            res = host.preview_item(item.id, play=False)
            self.assertTrue(res.get("ok"), f"preview_item failed: {res}")
            self.assertGreater(res.get("duration_sec", 0.0), 0.1)
            # Second preview of same file hits the 16-slot C++ RAM LRU
            res2 = host.preview_item(item.id, play=False)
            self.assertTrue(res2.get("ok"))
        finally:
            host.shutdown()


if __name__ == "__main__":
    unittest.main()
