import unittest
import tempfile
import os
import sqlite3
import json
from pathlib import Path
from fastapi import HTTPException
from api import update_library_bpm, LibraryBpmUpdateRequest

class TestGaiaBpmUpdate(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="gaia_bpm_test_"))
        self.db_path = self.temp_dir / "gaia.db"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_invalid_bpm_raises_exception(self):
        req_too_low = LibraryBpmUpdateRequest(filepath="dummy.wav", bpm=10)
        with self.assertRaises(HTTPException) as ctx:
            update_library_bpm(req_too_low)
        self.assertEqual(ctx.exception.status_code, 400)

        req_too_high = LibraryBpmUpdateRequest(filepath="dummy.wav", bpm=500)
        with self.assertRaises(HTTPException) as ctx:
            update_library_bpm(req_too_high)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_update_library_bpm_sqlite(self):
        # Create temporary sqlite gaia.db schema and data
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                absolute_path TEXT NOT NULL,
                type TEXT
            )
        """)
        cursor.execute("""
            CREATE TABLE loop_sample_items (
                id INTEGER PRIMARY KEY,
                bpm INTEGER
            )
        """)
        cursor.execute("""
            CREATE TABLE collection_items (
                id INTEGER PRIMARY KEY,
                absolute_path TEXT,
                manifest_json TEXT
            )
        """)

        test_file = os.path.abspath(str(self.temp_dir / "sample_loop.wav"))
        cursor.execute("INSERT INTO items (id, absolute_path, type) VALUES (1, ?, 'sample')", (test_file,))
        cursor.execute("INSERT INTO loop_sample_items (id, bpm) VALUES (1, 120)")

        # Collection item test
        coll_dir = os.path.abspath(str(self.temp_dir / "pack"))
        coll_file = os.path.abspath(os.path.join(coll_dir, "loop_b.wav"))
        manifest = [{"filename": "loop_b.wav", "relative_path": "loop_b.wav", "bpm": 100}]
        cursor.execute("INSERT INTO collection_items (id, absolute_path, manifest_json) VALUES (2, ?, ?)",
                       (coll_dir, json.dumps(manifest)))
        conn.commit()
        conn.close()

        # Monkeypatch os.path.exists for test db path if needed, or run update
        cwd = os.getcwd()
        try:
            os.chdir(self.temp_dir)
            req = LibraryBpmUpdateRequest(filepath=test_file, bpm=135.0)
            res = update_library_bpm(req)
            self.assertEqual(res["status"], "success")
            self.assertEqual(res["bpm"], 135.0)

            # Check DB
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT bpm FROM loop_sample_items WHERE id = 1")
            row = cursor.fetchone()
            self.assertEqual(row[0], 135)

            # Update collection item
            req_coll = LibraryBpmUpdateRequest(filepath=coll_file, bpm=140.0)
            res_coll = update_library_bpm(req_coll)
            self.assertEqual(res_coll["status"], "success")

            cursor.execute("SELECT manifest_json FROM collection_items WHERE id = 2")
            updated_manifest = json.loads(cursor.fetchone()[0])
            self.assertEqual(updated_manifest[0]["bpm"], 140)
            conn.close()
        finally:
            os.chdir(cwd)

if __name__ == '__main__':
    unittest.main()
