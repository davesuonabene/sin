from __future__ import annotations

import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import soundfile  # noqa: F401
except ModuleNotFoundError:
    # Profile discovery only needs collection_importer.ASSET_STORE.  Keep this
    # isolated unit test runnable in stripped-down Python environments.
    sys.modules["soundfile"] = types.ModuleType("soundfile")

from gaia import collection_importer, profiles


TEMPLATE = Path(__file__).resolve().parents[1] / "gaia" / "profile_templates" / "zoom-recorders.json"


class TestGaiaProfiles(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory(prefix="sin-gaia-profiles-")
        self.addCleanup(self._temporary_directory.cleanup)
        self.asset_store = Path(self._temporary_directory.name) / "assets"

    def test_profiles_directory_uses_current_collection_importer_asset_store(self) -> None:
        with patch.object(collection_importer, "ASSET_STORE", self.asset_store):
            self.assertEqual(profiles.profiles_directory(), self.asset_store.parent / ".gaia" / "profiles")

    def test_discovers_multiple_profiles_from_one_bundle(self) -> None:
        profile_dir = self.asset_store.parent / ".gaia" / "profiles"
        profile_dir.mkdir(parents=True)
        (profile_dir / "bundle.json").write_text(
            json.dumps(
                {
                    "schema": profiles.BUNDLE_SCHEMA,
                    "bundle_id": "test-devices",
                    "profiles": [
                        {
                            "id": "device_a",
                            "label": "Device A",
                            "container_type": "multitrack",
                            "match": {"filename_patterns": ["A*.wav"]},
                            "components": [
                                {"pattern": "A*.wav", "label": "channel", "relation_kind": "component"}
                            ],
                        },
                        {
                            "id": "device_b",
                            "label": "Device B",
                            "container_type": "multitrack",
                            "match": {"filename_patterns": ["B*.wav"]},
                            "components": [
                                {"pattern": "B*.wav", "label": "channel", "relation_kind": "component"}
                            ],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

        bundles = profiles.discover_profile_bundles(profile_dir)
        self.assertEqual([bundle.bundle_id for bundle in bundles], ["test-devices"])
        self.assertEqual([profile.id for profile in profiles.discover_profiles(profile_dir)], ["device_a", "device_b"])
        self.assertEqual(profiles.get_profile("device_b", profiles_dir=profile_dir).label, "Device B")

    def test_invalid_bundle_is_rejected_with_actionable_error(self) -> None:
        invalid = self.asset_store / "invalid.json"
        invalid.parent.mkdir(parents=True)
        invalid.write_text(
            json.dumps(
                {
                    "schema": profiles.BUNDLE_SCHEMA,
                    "bundle_id": "invalid",
                    "profiles": [
                        {
                            "id": "bad profile",
                            "label": "Bad",
                            "container_type": "multitrack",
                            "match": {"filename_patterns": ["*.wav"]},
                            "components": [
                                {"pattern": "*.wav", "label": "channel", "relation_kind": "unknown"}
                            ],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(profiles.ProfileValidationError, r"profiles\[0\]\.id"):
            profiles.load_profile_bundle(invalid)

    def test_zoom_h4_template_matches_and_prioritises_mixdown(self) -> None:
        profile_dir = self.asset_store.parent / ".gaia" / "profiles"
        profile_dir.mkdir(parents=True)
        shutil.copy2(TEMPLATE, profile_dir / TEMPLATE.name)

        matches = profiles.match_profiles(
            "multitrack",
            ["Tr1.WAV", "Tr2.wav", "TrLR.wav", "notes.txt"],
            profiles_dir=profile_dir,
        )
        self.assertEqual([profile.id for profile in matches], ["zoom_h4"])
        suggestions = profiles.suggest_components(matches[0], ["Tr1.WAV", "Tr2.wav", "TrLR.wav"])
        self.assertEqual(
            [(item.relative_path, item.label, item.stage_name, item.suggested_master) for item in suggestions],
            [
                ("Tr1.WAV", "source channel", None, False),
                ("Tr2.wav", "source channel", None, False),
                ("TrLR.wav", "mixdown", "mixdown", True),
            ],
        )

    def test_discovery_rejects_duplicate_profile_ids_across_bundles(self) -> None:
        profile_dir = self.asset_store.parent / ".gaia" / "profiles"
        profile_dir.mkdir(parents=True)
        bundle = {
            "schema": profiles.BUNDLE_SCHEMA,
            "bundle_id": "first-bundle",
            "profiles": [
                {
                    "id": "shared-profile",
                    "label": "Shared",
                    "container_type": "multitrack",
                    "match": {"filename_patterns": ["*.wav"]},
                    "components": [
                        {"pattern": "*.wav", "label": "channel", "relation_kind": "component"}
                    ],
                }
            ],
        }
        (profile_dir / "first.json").write_text(json.dumps(bundle), encoding="utf-8")
        bundle["bundle_id"] = "second-bundle"
        (profile_dir / "second.json").write_text(json.dumps(bundle), encoding="utf-8")

        with self.assertRaisesRegex(profiles.ProfileValidationError, "duplicate profile ids"):
            profiles.discover_profiles(profile_dir)


if __name__ == "__main__":
    unittest.main()
