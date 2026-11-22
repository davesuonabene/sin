"""Base interface for GAIA project editor engines."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from sqlalchemy.orm import Session

from .. import models


class EditorEngine(ABC):
    """Contract implemented by every GAIA editor engine backend."""

    engine_id: str

    @abstractmethod
    def default_session_data(self, db: Session, project: models.ProjectItem) -> dict[str, Any]:
        """Return initial session data for a newly created or uninitialized project."""

    @abstractmethod
    def build_project_session(
        self,
        db: Session,
        project: models.ProjectItem,
        target_id: str | None = None,
    ) -> dict[str, Any]:
        """Build the UI-ready session payload for a project."""

    @abstractmethod
    def validate_and_merge_session(
        self,
        db: Session,
        project: models.ProjectItem,
        incoming_data: dict[str, Any],
        existing_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate and merge incoming session edits with the stored session."""
