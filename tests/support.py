from __future__ import annotations

import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from gaia import collection_importer, database, models, paths, vaults


@contextmanager
def working_directory(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield path
    finally:
        os.chdir(previous)


class AudioFixtureTestCase(unittest.TestCase):
    """Small, disposable audio fixtures shared by core rendering tests."""

    sample_rate = 8_000

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._temporary_directory = tempfile.TemporaryDirectory(prefix="sin-audio-tests-")
        cls.addClassCleanup(cls._temporary_directory.cleanup)
        cls.temp_path = Path(cls._temporary_directory.name)

    @classmethod
    def write_audio(
        cls,
        name: str,
        *,
        seconds: float = 0.5,
        channels: int = 1,
        value: float | None = None,
    ) -> Path:
        frames = max(32, int(round(cls.sample_rate * seconds)))
        if value is None:
            phase = np.linspace(0.0, 2.0 * np.pi * 220.0 * seconds, frames, endpoint=False)
            mono = (0.25 * np.sin(phase)).astype(np.float32)
        else:
            mono = np.full(frames, value, dtype=np.float32)
        audio = mono if channels == 1 else np.column_stack([mono, -mono])
        path = cls.temp_path / name
        sf.write(path, audio, cls.sample_rate, subtype="FLOAT")
        return path


class GaiaTestCase(unittest.TestCase):
    """Isolated GAIA database and asset store, cleaned even after failures."""

    sample_rate = 8_000

    def setUp(self):
        super().setUp()
        self._temporary_directory = tempfile.TemporaryDirectory(prefix="sin-gaia-tests-")
        self.addCleanup(self._temporary_directory.cleanup)
        self.temp_path = Path(self._temporary_directory.name)

        self.original_import_logs_directory = paths.import_logs_directory
        paths.import_logs_directory = lambda: self.temp_path / "logs"
        self.addCleanup(setattr, paths, "import_logs_directory", self.original_import_logs_directory)

        self.original_asset_store = collection_importer.ASSET_STORE
        self.asset_store = self.temp_path / "managed"
        collection_importer.ASSET_STORE = self.asset_store
        self.addCleanup(setattr, collection_importer, "ASSET_STORE", self.original_asset_store)

        self.engine = create_engine(
            f"sqlite:///{self.temp_path / 'test.db'}",
            connect_args={"check_same_thread": False},
        )
        event.listen(
            self.engine,
            "connect",
            lambda connection, _record: connection.execute("PRAGMA foreign_keys=ON"),
        )
        models.Base.metadata.create_all(bind=self.engine)
        self.addCleanup(self.engine.dispose)

        self.session_factory = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self.engine,
        )
        self.original_session_factory = database.SessionLocal
        database.SessionLocal = self.session_factory
        self.addCleanup(setattr, database, "SessionLocal", self.original_session_factory)

        self.db = self.session_factory()
        self.addCleanup(self.db.close)
        self.vault = vaults.ensure_default_vault(self.db)

    def write_audio(
        self,
        folder: Path,
        name: str,
        *,
        seconds: float = 0.1,
        channels: int = 2,
    ) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        frames = max(32, int(round(self.sample_rate * seconds)))
        audio = np.zeros((frames, channels), dtype=np.float32)
        path = folder / name
        sf.write(path, audio, self.sample_rate, subtype="FLOAT")
        return path

    def wait_for_batch(self, task_id: str, timeout: float = 3.0) -> dict:
        from gaia.routers import items as items_router

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = items_router.get_batch_analysis_status(task_id)
            if status["status"] in {"completed", "failed", "cancelled"}:
                return status
            time.sleep(0.01)
        self.fail(f"GAIA batch task {task_id} did not finish within {timeout:.1f}s")

    def preview_import(self, source_path: Path | str) -> dict:
        """Inspect a source through the public preview-first import service."""
        from gaia.import_jobs import import_job_manager

        return import_job_manager.create_preview(str(source_path), self.vault.id, self.db)

    def start_import(
        self,
        preview: dict,
        *,
        folder_assignments: dict[str, str] | None = None,
        item_types: dict[int, str] | None = None,
        excluded_indexes: list[int] | None = None,
        excluded_types: list[str] | None = None,
        excluded_extensions: list[str] | None = None,
        conflict_action: str | None = None,
    ) -> dict:
        """Queue a background import and wait only for its terminal test state."""
        from gaia import schemas
        from gaia.import_jobs import import_job_manager

        detected_assignments = {
            node["relative_path"]: node["detected_assignment"]
            for node in preview.get("nodes", [])
            if node.get("kind") == "folder" and node.get("detected_assignment")
        }
        job = import_job_manager.create_job(
            schemas.ImportJobCreateRequest(
                preview_id=preview["preview_id"],
                folder_assignments=detected_assignments if folder_assignments is None else folder_assignments,
                item_types=item_types or {},
                excluded_indexes=excluded_indexes or [],
                excluded_types=excluded_types or [],
                excluded_extensions=excluded_extensions or [],
                conflict_action=conflict_action,
            )
        )
        return self.wait_for_import(job["job_id"])

    def wait_for_import(self, job_id: str, timeout: float = 5.0) -> dict:
        from gaia.import_jobs import import_job_manager

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = import_job_manager.get_job(job_id)
            if status and status["status"] in {"completed", "failed", "cancelled", "stale"}:
                self.db.expire_all()
                return status
            time.sleep(0.01)
        self.fail(f"GAIA import job {job_id} did not finish within {timeout:.1f}s")
