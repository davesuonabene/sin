import shutil
import tempfile
import unittest
from pathlib import Path
import soundfile as sf
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import collection_importer, crud, models, schemas, vaults
from gaia.routers import items as items_router


class TestGaiaDispatch(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="gaia_dispatch_test_"))
        self.asset_store = self.temp_dir / "assets"
        self.original_store = collection_importer.ASSET_STORE
        collection_importer.ASSET_STORE = self.asset_store

        engine = create_engine(f"sqlite:///{self.temp_dir / 'test.db'}", connect_args={"check_same_thread": False})
        models.Base.metadata.create_all(bind=engine)
        vaults.initialise_schema(engine)
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        self.db = session_factory()
        self.default_vault = vaults.ensure_default_vault(self.db)

    def tearDown(self):
        self.db.close()
        collection_importer.ASSET_STORE = self.original_store
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def write_audio(self, folder: Path, name: str, seconds: float = 1.0):
        folder.mkdir(parents=True, exist_ok=True)
        audio = np.zeros((int(44100 * seconds), 2), dtype=np.float32)
        path = folder / name
        sf.write(path, audio, 44100)
        return path

    def test_import_and_dispatch_to_multiple_vaults(self):
        # 1. Create a sample pack source directory with subfolders
        source = self.temp_dir / "Heavy_Drums_Pack"
        kick = self.write_audio(source / "Kicks", "Kick_01.wav")
        snare = self.write_audio(source / "Snares", "Snare_01.wav")

        # 2. Import into default vault
        collection = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=self.default_vault.id),
            self.db
        )

        self.assertEqual(collection.title, "Heavy_Drums_Pack")
        # Structure preserved in central storage
        self.assertTrue((self.asset_store / "Heavy_Drums_Pack" / "Kicks" / "Kick_01.wav").exists())
        self.assertTrue((self.asset_store / "Heavy_Drums_Pack" / "Snares" / "Snare_01.wav").exists())

        # 3. Verify individual items were indexed
        kick_item = crud.get_item_by_path(self.db, str((self.asset_store / "Heavy_Drums_Pack" / "Kicks" / "Kick_01.wav").resolve()))
        snare_item = crud.get_item_by_path(self.db, str((self.asset_store / "Heavy_Drums_Pack" / "Snares" / "Snare_01.wav").resolve()))
        self.assertIsNotNone(kick_item)
        self.assertIsNotNone(snare_item)

        # 4. Create new vault and dispatch snare item to it
        hiphop_vault = vaults.create_vault(self.db, "Hip Hop Samples", "Hip hop assets")
        dispatched = crud.dispatch_items_to_vault(self.db, [snare_item.id], hiphop_vault.id)

        self.assertEqual(len(dispatched), 1)
        self.assertIn(hiphop_vault.id, dispatched[0].vault_ids)
        self.assertIn(self.default_vault.id, dispatched[0].vault_ids)

        # 5. Query vault views
        hiphop_items = crud.get_items(self.db, vault_id=hiphop_vault.id)
        self.assertEqual(len(hiphop_items), 1)
        self.assertEqual(hiphop_items[0].id, snare_item.id)

        # 6. Remove from default vault while retaining in hiphop vault
        updated = crud.remove_item_from_vault(self.db, snare_item.id, self.default_vault.id)
        self.assertNotIn(self.default_vault.id, updated.vault_ids)
        self.assertIn(hiphop_vault.id, updated.vault_ids)


if __name__ == "__main__":
    unittest.main()
