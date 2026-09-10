import os
import unittest
from unittest.mock import patch
import json
from pathlib import Path

import api


class GaiaContainerLibraryTestCase(unittest.TestCase):
    def test_get_library_populates_project_references_and_subfolders(self):
        """Verify get_library retrieves projects with referenced items and folder categorization."""
        res = api.get_library()
        files = res.get("files", [])
        self.assertIsInstance(files, list)
        self.assertGreater(len(files), 0)

        # Check for FIELD LOOPS project (id 6085)
        field_loops = next((f for f in files if f.get("id") == 6085), None)
        if field_loops:
            self.assertEqual(field_loops.get("type"), "project")
            contents = field_loops.get("contents", [])
            self.assertGreater(len(contents), 10)

            # Check that subfolder metadata is populated
            folders = {c.get("folder") for c in contents if c.get("folder")}
            self.assertTrue("loops" in folders or "one shots" in folders)

            # Check that item paths are valid strings
            for item in contents:
                self.assertTrue(bool(item.get("absolute_path")))
                self.assertIsNotNone(item.get("id"))
                self.assertIsNotNone(item.get("stream_url"))

    def test_get_library_sqlite_fallback_populates_references(self):
        """Verify direct SQLite read populates project item references when Gaia API is offline."""
        with patch("urllib.request.urlopen", side_effect=OSError("Gaia API offline")):
            res = api.get_library()
            files = res.get("files", [])
            self.assertIsInstance(files, list)
            self.assertGreater(len(files), 0)

            field_loops = next((f for f in files if f.get("id") == 6085), None)
            if field_loops:
                self.assertEqual(field_loops.get("type"), "project")
                contents = field_loops.get("contents", [])
                self.assertGreater(len(contents), 10)
                folders = {c.get("folder") for c in contents if c.get("folder")}
                self.assertTrue("loops" in folders or "one shots" in folders)

    def test_prepare_and_filter_library_preserves_external_paths(self):
        """Verify prepare_and_filter_library does not overwrite valid absolute paths with root-joined paths."""
        raw_items = [
            {
                "id": 999,
                "type": "collection",
                "name": "Test Collection",
                "absolute_path": "C:/Projects/Project1",
                "contents": [
                    {
                        "id": 1001,
                        "title": "External Recording.wav",
                        "absolute_path": "D:/External/Sounds/rec.wav",
                        "relative_path": "rec.wav",
                        "folder": "field",
                        "is_external": True,
                        "type": "sample",
                    },
                    {
                        "id": 1002,
                        "title": "Nested Sample.wav",
                        "relative_path": "drums/snare.wav",
                        "type": "sample",
                    },
                ],
            }
        ]

        # Call get_library's internal preparation or simulate via prepare_and_filter_library logic
        # We can run api.get_library with a mocked response returning raw_items
        mock_response_data = json.dumps(raw_items).encode("utf-8")
        class FakeResponse:
            def __init__(self, data):
                self.data = data
                self.status = 200
            def read(self):
                return self.data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        with patch("urllib.request.urlopen", return_value=FakeResponse(mock_response_data)):
            with patch.object(api, "_get_gaia_vaults", return_value=[]):
                res = api.get_library(vault_id=99)
                files = res.get("files", [])
                self.assertEqual(len(files), 1)
                project = files[0]
                contents = project.get("contents", [])
                self.assertEqual(len(contents), 2)

                ext_item = next(c for c in contents if c.get("id") == 1001)
                self.assertEqual(ext_item["absolute_path"], "D:/External/Sounds/rec.wav")
                self.assertEqual(ext_item["folder"], "field")
                self.assertTrue(ext_item["is_external"])

                nested_item = next(c for c in contents if c.get("id") == 1002)
                self.assertEqual(nested_item["folder"], "drums")


if __name__ == "__main__":
    unittest.main()
