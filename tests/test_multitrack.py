import unittest
import os
import shutil
import tempfile
import soundfile as sf
import numpy as np

from gaia import models, schemas, crud, multitrack_analyzer
from gaia.database import SessionLocal, engine, Base

class TestMultitrackMedia(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(bind=engine)
        cls.temp_dir = tempfile.mkdtemp(prefix="gaia_test_multitrack_")

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.temp_dir):
            shutil.rmtree(cls.temp_dir)

    def test_analyzer_equal_lengths(self):
        folder = os.path.join(self.temp_dir, "equal_stems_120bpm_Cmaj")
        os.makedirs(folder, exist_ok=True)

        sr = 44100
        # 1.0 second of silence
        data = np.zeros((44100, 2), dtype=np.float32)

        sf.write(os.path.join(folder, "Drums.wav"), data, sr)
        sf.write(os.path.join(folder, "Bass.wav"), data, sr)
        sf.write(os.path.join(folder, "Vocal.wav"), data, sr)

        res = multitrack_analyzer.analyze_multitrack_folder(folder)

        self.assertTrue(res["is_valid_length"])
        self.assertEqual(res["length_variance"], 0.0)
        self.assertEqual(len(res["stems"]), 3)
        self.assertEqual(res["bpm"], 120)
        self.assertEqual(res["key"], "Cmaj")

    def test_analyzer_mismatched_lengths(self):
        folder = os.path.join(self.temp_dir, "unequal_stems")
        os.makedirs(folder, exist_ok=True)

        sr = 44100
        data1 = np.zeros((44100, 2), dtype=np.float32) # 1.0s
        data2 = np.zeros((88200, 2), dtype=np.float32) # 2.0s

        sf.write(os.path.join(folder, "Drums.wav"), data1, sr)
        sf.write(os.path.join(folder, "Synth.wav"), data2, sr)

        res = multitrack_analyzer.analyze_multitrack_folder(folder)

        self.assertFalse(res["is_valid_length"])
        self.assertAlmostEqual(res["length_variance"], 1.0, places=2)
        self.assertEqual(len(res["stems"]), 2)

    def test_detector_only_claims_the_folder_with_direct_stems(self):
        collection_folder = os.path.join(self.temp_dir, "nested_collection")
        stem_folder = os.path.join(collection_folder, "SongA_Stems")
        os.makedirs(stem_folder, exist_ok=True)

        sr = 44100
        data = np.zeros((44100, 2), dtype=np.float32)
        sf.write(os.path.join(stem_folder, "Drums.wav"), data, sr)
        sf.write(os.path.join(stem_folder, "Bass.wav"), data, sr)

        self.assertFalse(multitrack_analyzer.is_multitrack_folder(collection_folder))
        self.assertTrue(multitrack_analyzer.is_multitrack_folder(stem_folder))

    def test_db_multitrack_crud(self):
        db = SessionLocal()
        try:
            folder = os.path.join(self.temp_dir, "db_multitrack_folder")
            os.makedirs(folder, exist_ok=True)
            sr = 44100
            data = np.zeros((44100, 2), dtype=np.float32)
            sf.write(os.path.join(folder, "Drums.wav"), data, sr)

            stems_input = [
                schemas.StemInfo(
                    filename="Drums.wav",
                    relative_path="Drums.wav",
                    absolute_path=os.path.join(folder, "Drums.wav").replace("\\", "/"),
                    duration_seconds=1.0,
                    sample_rate=44100,
                    channels=2,
                    frames=44100,
                    stem_type="Drums"
                )
            ]

            create_schema = schemas.MultitrackItemCreate(
                absolute_path=folder.replace("\\", "/"),
                type="multitrack",
                stems=stems_input,
                key="Am",
                bpm=128,
                is_valid_length=True,
                length_variance=0.0
            )

            created = crud.create_item(db, create_schema)
            self.assertIsNotNone(created.id)
            self.assertEqual(created.type, "multitrack")

            fetched = crud.get_item(db, item_id=created.id)
            self.assertIsNotNone(fetched)
            self.assertEqual(fetched.type, "multitrack")
            self.assertEqual(len(fetched.stems), 1)
            self.assertEqual(fetched.stems[0]["filename"], "Drums.wav")
            self.assertTrue(fetched.is_valid_length)
        finally:
            db.close()

    def test_crawler_scan_with_multitracks(self):
        from gaia.routers import items as items_router
        db = SessionLocal()
        try:
            root_pack = os.path.join(self.temp_dir, "sample_pack_scan")
            stem_subfolder = os.path.join(root_pack, "SongA_Stems")
            os.makedirs(stem_subfolder, exist_ok=True)

            sr = 44100
            data = np.zeros((44100, 2), dtype=np.float32)

            # Standard single sample in root_pack
            sf.write(os.path.join(root_pack, "SingleKick.wav"), data, sr)

            # Stems inside stem_subfolder
            sf.write(os.path.join(stem_subfolder, "Drums.wav"), data, sr)
            sf.write(os.path.join(stem_subfolder, "Bass.wav"), data, sr)

            req = schemas.DirectoryScanRequest(
                directory_path=root_pack,
                look_for_multitracks=True
            )

            res = items_router.scan_directory(req, db)
            self.assertGreaterEqual(res["imported"], 2)

            # Check that SongA_Stems folder was imported as multitrack
            mt_item = crud.get_item_by_path(db, absolute_path=os.path.abspath(stem_subfolder).replace("\\", "/"))
            self.assertIsNotNone(mt_item)
            self.assertEqual(mt_item.type, "multitrack")
            self.assertEqual(len(mt_item.stems), 2)
        finally:
            db.close()

    def test_crawler_imports_direct_stems_as_one_multitrack(self):
        from gaia.routers import items as items_router
        db = SessionLocal()
        try:
            stem_folder = os.path.join(self.temp_dir, "direct_stem_scan")
            os.makedirs(stem_folder, exist_ok=True)

            sr = 44100
            data = np.zeros((44100, 2), dtype=np.float32)
            drums_path = os.path.join(stem_folder, "Drums.wav")
            bass_path = os.path.join(stem_folder, "Bass.wav")
            sf.write(drums_path, data, sr)
            sf.write(bass_path, data, sr)

            result = items_router.scan_directory(
                schemas.DirectoryScanRequest(
                    directory_path=stem_folder,
                    look_for_multitracks=True,
                ),
                db,
            )

            multitrack_path = os.path.abspath(stem_folder).replace("\\", "/")
            multitrack_item = crud.get_item_by_path(db, absolute_path=multitrack_path)
            self.assertEqual(result["imported"], 1)
            self.assertIsNotNone(multitrack_item)
            self.assertEqual(multitrack_item.type, "multitrack")
            self.assertEqual(len(multitrack_item.stems), 2)
            self.assertIsNone(crud.get_item_by_path(db, absolute_path=drums_path))
            self.assertIsNone(crud.get_item_by_path(db, absolute_path=bass_path))
        finally:
            db.close()

    def test_crawler_imports_a_nested_multitrack_not_its_container(self):
        from gaia.routers import items as items_router
        db = SessionLocal()
        try:
            root_pack = os.path.join(self.temp_dir, "nested_pack_scan")
            album_folder = os.path.join(root_pack, "AlbumA")
            stem_subfolder = os.path.join(album_folder, "SongA_Stems")
            os.makedirs(stem_subfolder, exist_ok=True)

            sr = 44100
            data = np.zeros((44100, 2), dtype=np.float32)
            sf.write(os.path.join(stem_subfolder, "Drums.wav"), data, sr)
            sf.write(os.path.join(stem_subfolder, "Bass.wav"), data, sr)

            result = items_router.scan_directory(
                schemas.DirectoryScanRequest(
                    directory_path=root_pack,
                    look_for_multitracks=True,
                ),
                db,
            )

            stem_path = os.path.abspath(stem_subfolder).replace("\\", "/")
            root_path = os.path.abspath(root_pack).replace("\\", "/")
            album_path = os.path.abspath(album_folder).replace("\\", "/")

            self.assertEqual(result["imported"], 1)
            multitrack_item = crud.get_item_by_path(db, absolute_path=stem_path)
            self.assertIsNotNone(multitrack_item)
            self.assertEqual(multitrack_item.type, "multitrack")
            self.assertEqual(len(multitrack_item.stems), 2)
            self.assertIsNone(crud.get_item_by_path(db, absolute_path=root_path))
            self.assertIsNone(crud.get_item_by_path(db, absolute_path=album_path))

        finally:
            db.close()

    def test_crawler_imports_stems_individually_when_detection_is_disabled(self):
        from gaia.routers import items as items_router
        db = SessionLocal()
        try:
            stem_folder = os.path.join(self.temp_dir, "detection_disabled_stems")
            os.makedirs(stem_folder, exist_ok=True)

            sr = 44100
            data = np.zeros((44100, 2), dtype=np.float32)
            drums_path = os.path.join(stem_folder, "Drums.wav")
            bass_path = os.path.join(stem_folder, "Bass.wav")
            sf.write(drums_path, data, sr)
            sf.write(bass_path, data, sr)

            result = items_router.scan_directory(
                schemas.DirectoryScanRequest(
                    directory_path=stem_folder,
                    look_for_multitracks=False,
                ),
                db,
            )

            self.assertEqual(result["imported"], 2)
            self.assertIsNotNone(crud.get_item_by_path(db, absolute_path=drums_path))
            self.assertIsNotNone(crud.get_item_by_path(db, absolute_path=bass_path))
            self.assertIsNone(
                crud.get_item_by_path(
                    db,
                    absolute_path=os.path.abspath(stem_folder).replace("\\", "/"),
                )
            )
        finally:
            db.close()

if __name__ == "__main__":
    unittest.main()
