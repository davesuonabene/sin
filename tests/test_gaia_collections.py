from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

from fastapi import HTTPException
import numpy as np
import soundfile as sf
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import collection_importer, models, schemas, vaults
from gaia.routers import items as items_router


class TestGaiaCollections(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="gaia_collection_test_"))
        self.asset_store = self.temp_dir / "managed" / "collections"
        self.original_store = collection_importer.ASSET_STORE
        collection_importer.ASSET_STORE = self.asset_store

        engine = create_engine(f"sqlite:///{self.temp_dir / 'test.db'}", connect_args={"check_same_thread": False})
        models.Base.metadata.create_all(bind=engine)
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        self.db = session_factory()

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

    def test_folder_snapshot_is_a_read_only_collection_with_streamable_contents(self):
        source = self.temp_dir / "source_pack"
        self.write_audio(source, "Kick One Shot.wav")
        (source / "readme.txt").write_text("pack notes", encoding="utf-8")

        collection = items_router.import_collection(schemas.CollectionImportRequest(source_path=str(source)), self.db)

        self.assertEqual(collection.type, "collection")
        self.assertEqual(collection.source_kind, "folder")
        self.assertEqual(collection.title, "source_pack")
        self.assertTrue(Path(collection.absolute_path).is_dir())
        self.assertTrue((Path(collection.absolute_path) / "readme.txt").is_file())
        self.assertEqual(len(collection.contents), 2)

        audio_content = next(content for content in collection.contents if content["filename"] == "Kick One Shot.wav")
        stream = items_router.stream_collection_content(collection.id, audio_content["index"], self.db)
        self.assertEqual(stream.media_type, "audio/wav")

        with self.assertRaises(HTTPException) as type_change:
            items_router.update_item(collection.id, schemas.ItemUpdate(type="sample_pack"), self.db)
        self.assertEqual(type_change.exception.status_code, 405)
        with self.assertRaises(HTTPException) as deletion:
            items_router.delete_item(collection.id, self.db)
        self.assertEqual(deletion.exception.status_code, 405)

    def test_zip_is_extracted_as_a_collection_snapshot(self):
        source_folder = self.temp_dir / "zip_source"
        self.write_audio(source_folder / "nested", "Loop 120 BPM.wav")
        archive_path = self.temp_dir / "pack.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.write(source_folder / "nested" / "Loop 120 BPM.wav", "nested/Loop 120 BPM.wav")

        collection = items_router.import_collection(schemas.CollectionImportRequest(source_path=str(archive_path)), self.db)

        self.assertEqual(collection.type, "collection")
        self.assertEqual(collection.source_kind, "zip")
        self.assertTrue((Path(collection.absolute_path) / "nested" / "Loop 120 BPM.wav").is_file())

    def test_matching_distinct_stems_become_a_multitrack(self):
        source = self.temp_dir / "song_stems"
        self.write_audio(source, "Drums.wav")
        self.write_audio(source, "Bass.wav")

        multitrack = items_router.import_collection(schemas.CollectionImportRequest(source_path=str(source)), self.db)

        self.assertEqual(multitrack.type, "multitrack")
        self.assertEqual(len(multitrack.stems), 2)
        self.assertTrue(multitrack.is_valid_length)

    def test_unequal_audio_files_remain_a_collection(self):
        source = self.temp_dir / "mixed_lengths"
        self.write_audio(source, "Drums.wav", seconds=1.0)
        self.write_audio(source, "Bass.wav", seconds=1.2)

        collection = items_router.import_collection(schemas.CollectionImportRequest(source_path=str(source)), self.db)

        self.assertEqual(collection.type, "collection")

    def test_vaults_scope_duplicates_and_keep_assets_in_separate_folders(self):
        source = self.temp_dir / "recorder_session"
        self.write_audio(source, "Drums.wav")
        self.write_audio(source, "Bass.wav")

        packs = vaults.create_vault(self.db, "Sample packs", None)
        recordings = vaults.create_vault(self.db, "Live recordings", None)

        sample_pack_item = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=packs.id), self.db
        )
        live_recording_item = items_router.import_collection(
            schemas.CollectionImportRequest(source_path=str(source), vault_id=recordings.id), self.db
        )

        self.assertEqual(sample_pack_item.type, "multitrack")
        self.assertEqual(live_recording_item.type, "multitrack")
        self.assertNotEqual(sample_pack_item.id, live_recording_item.id)
        self.assertNotEqual(Path(sample_pack_item.absolute_path).parent, Path(live_recording_item.absolute_path).parent)

        pack_log = vaults.get_logs(self.db, packs.id)
        recording_log = vaults.get_logs(self.db, recordings.id)
        self.assertEqual(pack_log[0].action, "snapshot_imported")
        self.assertEqual(recording_log[0].action, "snapshot_imported")


if __name__ == "__main__":
    unittest.main()
