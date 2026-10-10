import tempfile
import unittest
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import models, crud, database


class TestGaiaPlaylists(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_gaia.db"
        self.engine = create_engine(
            f"sqlite:///{self.db_path}",
            connect_args={"check_same_thread": False},
        )
        database._enable_sqlite_foreign_keys(self.engine.raw_connection(), None)
        models.Base.metadata.create_all(bind=self.engine)
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.SessionLocal()

        # Create two distinct vaults
        self.vault1 = models.Vault(name="Vault A", storage_key="vault-a")
        self.vault2 = models.Vault(name="Vault B", storage_key="vault-b")
        self.db.add_all([self.vault1, self.vault2])
        self.db.commit()
        self.db.refresh(self.vault1)
        self.db.refresh(self.vault2)

        # Create items in both vaults (including audio and folder items)
        self.item_v1 = models.AudioItem(
            absolute_path="/path/to/vault_a/kick.wav",
            vault_id=self.vault1.id,
            type="audio",
        )
        self.folder_v1 = models.CollectionItem(
            absolute_path="/path/to/vault_a/packs/pack1",
            vault_id=self.vault1.id,
            source_kind="folder",
            type="collection",
            title="Drums Pack",
        )
        self.item_v2 = models.SampleItem(
            absolute_path="/path/to/vault_b/synth_lead.wav",
            vault_id=self.vault2.id,
            type="sample",
            bpm=128,
            key="C min",
        )
        self.db.add_all([self.item_v1, self.folder_v1, self.item_v2])
        self.db.commit()
        self.db.refresh(self.item_v1)
        self.db.refresh(self.folder_v1)
        self.db.refresh(self.item_v2)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.temp_dir.cleanup()

    def test_playlist_lifecycle_and_cross_vault_membership(self):
        # 1. Create playlist
        playlist = crud.create_playlist(self.db, "Favorites Across Vaults")
        self.assertIsNotNone(playlist.id)
        self.assertEqual(playlist.name, "Favorites Across Vaults")

        # 2. Add arbitrary items across Vault A and Vault B
        added = crud.add_playlist_items(
            self.db,
            playlist.id,
            [self.item_v1.id, self.folder_v1.id, self.item_v2.id],
        )
        self.assertEqual(len(added), 3)

        # 3. Retrieve playlist items - verify horizontal cross-vault resolution
        items = crud.get_playlist_items(self.db, playlist.id)
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["id"], self.item_v1.id)
        self.assertEqual(items[0]["vault_id"], self.vault1.id)
        self.assertEqual(items[1]["id"], self.folder_v1.id)
        self.assertEqual(items[1]["title"], "Drums Pack")
        self.assertEqual(items[2]["id"], self.item_v2.id)
        self.assertEqual(items[2]["vault_id"], self.vault2.id)
        self.assertEqual(items[2]["bpm"], 128)

        # 4. Reorder playlist items
        crud.reorder_playlist_items(self.db, playlist.id, [self.item_v2.id, self.item_v1.id, self.folder_v1.id])
        reordered = crud.get_playlist_items(self.db, playlist.id)
        self.assertEqual([item["id"] for item in reordered], [self.item_v2.id, self.item_v1.id, self.folder_v1.id])

        # 5. Remove an item
        self.assertTrue(crud.remove_playlist_item(self.db, playlist.id, self.item_v1.id))
        remaining = crud.get_playlist_items(self.db, playlist.id)
        self.assertEqual(len(remaining), 2)
        self.assertEqual([item["id"] for item in remaining], [self.item_v2.id, self.folder_v1.id])

        # 6. Delete playlist - ensure assets in vaults are untouched
        self.assertTrue(crud.delete_playlist(self.db, playlist.id))
        self.assertIsNone(crud.get_playlist(self.db, playlist.id))
        # Items are still safe and sound
        self.assertIsNotNone(crud.get_item(self.db, self.item_v1.id))
        self.assertIsNotNone(crud.get_item(self.db, self.folder_v1.id))
        self.assertIsNotNone(crud.get_item(self.db, self.item_v2.id))

    def test_cascading_item_deletion_cleans_playlist(self):
        playlist = crud.create_playlist(self.db, "Live Set")
        crud.add_playlist_items(self.db, playlist.id, [self.item_v1.id, self.item_v2.id])
        self.assertEqual(len(crud.get_playlist_items(self.db, playlist.id)), 2)

        # Delete item_v1 from GAIA database
        self.db.delete(self.item_v1)
        self.db.commit()

        # Playlist entry is removed
        items = crud.get_playlist_items(self.db, playlist.id)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], self.item_v2.id)

    def test_playlist_router_endpoints(self):
        from gaia.routers import playlists as pl_router
        from gaia import schemas
        from fastapi import HTTPException

        # 1. Create playlist
        created = pl_router.create_playlist(schemas.PlaylistCreate(name="Ambient Mix"), db=self.db)
        self.assertEqual(created["name"], "Ambient Mix")
        pl_id = created["id"]

        # Duplicate name fails with 400
        with self.assertRaises(HTTPException) as ctx:
            pl_router.create_playlist(schemas.PlaylistCreate(name="Ambient Mix"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

        # 2. List playlists
        listed = pl_router.list_playlists(db=self.db)
        names = [p["name"] for p in listed]
        self.assertIn("Ambient Mix", names)

        # 3. Add items across vaults
        add_res = pl_router.add_items_to_playlist(
            pl_id,
            schemas.PlaylistItemAddRequest(item_ids=[self.item_v1.id, self.item_v2.id]),
            db=self.db,
        )
        self.assertEqual(add_res["added_count"], 2)

        # 4. Get playlist details
        detail = pl_router.read_playlist(pl_id, db=self.db)
        self.assertEqual(detail["item_count"], 2)
        self.assertEqual(len(detail["items"]), 2)

        # 5. Rename playlist
        updated = pl_router.update_playlist(
            pl_id,
            schemas.PlaylistUpdate(name="Chill Ambient Mix"),
            db=self.db,
        )
        self.assertEqual(updated["name"], "Chill Ambient Mix")

        # 6. Reorder playlist
        reorder_res = pl_router.reorder_playlist(
            pl_id,
            schemas.PlaylistItemReorderRequest(item_ids=[self.item_v2.id, self.item_v1.id]),
            db=self.db,
        )
        self.assertTrue(reorder_res["ok"])

        # 7. Remove an item
        del_item_res = pl_router.remove_item_from_playlist(pl_id, self.item_v1.id, db=self.db)
        self.assertTrue(del_item_res["ok"])

        detail = pl_router.read_playlist(pl_id, db=self.db)
        self.assertEqual(detail["item_count"], 1)

        # 8. Delete playlist
        del_res = pl_router.delete_playlist(pl_id, db=self.db)
        self.assertTrue(del_res["ok"])

        # Verify 404
        with self.assertRaises(HTTPException) as ctx:
            pl_router.read_playlist(pl_id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()

