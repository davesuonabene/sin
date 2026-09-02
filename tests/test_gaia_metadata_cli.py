from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from gaia import metadata_cli


class TestGaiaMetadataCli(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="gaia-metadata-cli-")
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = Path(self.temporary_directory.name) / "gaia.db"
        self.connection = sqlite3.connect(self.database)
        self.connection.row_factory = sqlite3.Row
        self.addCleanup(self.connection.close)
        self.connection.execute(
            """
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                type TEXT NOT NULL,
                absolute_path TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                updated_at TEXT
            )
            """
        )
        self.connection.executemany(
            "INSERT INTO items (id, type, absolute_path, metadata_json) VALUES (?, ?, ?, ?)",
            (
                (1, "track", str(Path(self.temporary_directory.name) / "one.wav"), json.dumps({"audio_metadata": {"title": "One", "release_year": 1991}})),
                (2, "track", str(Path(self.temporary_directory.name) / "two.wav"), json.dumps({"audio_metadata": {"title": "Two"}})),
                (3, "sample", str(Path(self.temporary_directory.name) / "sample.wav"), "{}"),
            ),
        )
        self.connection.commit()

    def test_list_show_and_update_track_metadata(self):
        self.assertEqual([row["item_id"] for row in metadata_cli.list_tracks(self.connection)], [1, 2])
        self.assertEqual(metadata_cli.show_track(self.connection, 1)["release_year"], 1991)

        result = metadata_cli.update_track(
            self.connection,
            1,
            {"release_year": "2004", "album": "Catalog Album", "comment": None},
        )
        self.connection.commit()

        self.assertEqual(result["before"]["release_year"], 1991)
        self.assertEqual((result["after"]["release_year"], result["after"]["album"]), (2004, "Catalog Album"))
        self.assertEqual(metadata_cli.show_track(self.connection, 1)["release_year"], 2004)

    def test_batch_is_validated_before_writes_and_supports_dry_run(self):
        document = [
            {"item_id": 1, "changes": {"release_year": 2001}},
            {"item_id": 2, "release_year": 2002},
        ]
        preview = metadata_cli.apply_batch(self.connection, document, dry_run=True)
        self.assertEqual([row["after"]["release_year"] for row in preview], [2001, 2002])
        self.assertEqual(metadata_cli.show_track(self.connection, 1)["release_year"], 1991)

        with self.assertRaises(metadata_cli.MetadataEditError):
            metadata_cli.apply_batch(
                self.connection,
                [
                    {"item_id": 1, "release_year": 2001},
                    {"item_id": 3, "release_year": 2003},
                ],
            )
        self.assertEqual(metadata_cli.show_track(self.connection, 1)["release_year"], 1991)

        metadata_cli.apply_batch(self.connection, document)
        self.connection.commit()
        self.assertEqual(metadata_cli.show_track(self.connection, 2)["release_year"], 2002)


if __name__ == "__main__":
    unittest.main()
