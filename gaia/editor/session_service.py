"""Unified session resolution and strict project-bound persistence."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import crud, models, project_manifest, project_service
from . import checkpoints, registry
from .engines.simple_media import simple_media_engine
from .engines.sin_engine import sin_engine

ENGINE_MAP = {
    "sin": sin_engine,
    "simple_media": simple_media_engine,
}


def default_session_envelope(db: Session, project: models.ProjectItem) -> dict[str, Any]:
    engine_id = getattr(project, "editor_engine", None) or "sin"
    engine = ENGINE_MAP.get(engine_id, sin_engine)
    return {
        "engine": engine_id,
        "schema_version": 1,
        "data": engine.default_session_data(db, project),
    }


def get_or_init_project_session_envelope(db: Session, project: models.ProjectItem) -> dict[str, Any]:
    stored = project_manifest.read_project_session(project)
    engine_id = getattr(project, "editor_engine", None) or "sin"
    if isinstance(stored, dict) and stored.get("engine") == engine_id and isinstance(stored.get("data"), dict):
        return stored
    return default_session_envelope(db, project)


def initialize_project_session_on_create(
    db: Session,
    project: models.ProjectItem,
    *,
    initial_session: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Initialize project.json session during project creation or ephemeral promotion."""
    engine_id = getattr(project, "editor_engine", None) or "sin"
    engine = ENGINE_MAP.get(engine_id)
    if not engine:
        raise ValueError(f"Unsupported project editor engine: {engine_id}")

    if isinstance(initial_session, dict):
        incoming_engine = str(initial_session.get("engine") or "").strip().lower()
        incoming_data = initial_session.get("data") if isinstance(initial_session.get("data"), dict) else initial_session
        if incoming_engine == engine_id:
            merged = engine.validate_and_merge_session(db, project, incoming_data, engine.default_session_data(db, project))
        elif engine_id == "sin" and incoming_engine == "simple_media":
            merged = sin_engine.build_session_from_simple_media(db, project, incoming_data)
        else:
            raise ValueError(f"Cannot seed '{engine_id}' project from '{incoming_engine}' session")
    else:
        merged = engine.default_session_data(db, project)

    envelope = {
        "engine": engine_id,
        "schema_version": 1,
        "data": merged,
    }
    project_manifest.write_project_session(db, project.id, envelope)
    return envelope


def open_session(
    db: Session,
    item_id: int,
    target_id: str | None = None,
    *,
    force_ephemeral: bool = False,
) -> dict[str, Any]:
    """Open an editor session for a Project (persistent) or any item (ephemeral simple_media)."""
    item = crud.get_item(db, item_id)
    if not item:
        raise ValueError("Item not found")

    owning_proj = None if force_ephemeral else project_service._find_owning_project(db, item)
    if owning_proj is not None:
        if owning_proj.id != item.id and not target_id:
            target_id = f"item:{item.id}"
        project = owning_proj
        engine_id = getattr(project, "editor_engine", None) or "sin"
        project_kind = getattr(project, "project_kind", None) or "audio"
        engine = ENGINE_MAP.get(engine_id)
        if not engine:
            raise ValueError(f"Unsupported project editor engine: {engine_id}")

        engine_payload = engine.build_project_session(db, project, target_id=target_id)
        engine_spec = registry.ENGINES[engine_id]
        kind_spec = registry.PROJECT_KINDS[project_kind]
        return {
            "persistence": "project",
            "can_save": True,
            "project_id": project.id,
            "root_item_id": project.id,
            "root_type": "project",
            "title": getattr(project, "title", None) or Path(project.absolute_path).name,
            "project_kind": project_kind,
            "project_kind_label": kind_spec.label,
            "editor_engine": engine_id,
            "editor_engine_label": engine_spec.label,
            "checkpoints": checkpoints.list_checkpoints(db, project.id),
            **engine_payload,
        }

    # Non-project or explicit scratch mode -> ALWAYS ephemeral simple_media
    inferred_kind = registry.infer_project_kind([item])
    engine_id = registry.EPHEMERAL_DEFAULT_ENGINE
    engine_payload = simple_media_engine.build_ephemeral_session(db, item, target_id=target_id)
    engine_spec = registry.ENGINES[engine_id]
    kind_spec = registry.PROJECT_KINDS[inferred_kind]
    return {
        "persistence": "ephemeral",
        "can_save": False,
        "project_id": None,
        "root_item_id": item.id,
        "root_type": item.type,
        "title": getattr(item, "title", None) or Path(item.absolute_path).name,
        "project_kind": inferred_kind,
        "project_kind_label": kind_spec.label,
        "editor_engine": engine_id,
        "editor_engine_label": engine_spec.label,
        "checkpoints": [],
        **engine_payload,
    }


def save_project_session(
    db: Session,
    project_id: int,
    engine_id: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    """Strictly persist a project's session; non-projects and mismatched engines are rejected."""
    item = crud.get_item(db, project_id)
    if not item:
        raise ValueError("Project not found")
    if not isinstance(item, models.ProjectItem):
        raise ValueError("Only projects can save an editor session; create a project first")

    project_engine = getattr(item, "editor_engine", None) or "sin"
    requested_engine = (engine_id or "").strip().lower()
    if requested_engine != project_engine:
        raise ValueError(
            f"Project '{getattr(item, 'title', item.id)}' uses engine '{project_engine}', not '{requested_engine}'"
        )
    engine = ENGINE_MAP.get(project_engine)
    if not engine:
        raise ValueError(f"Unsupported editor engine: {project_engine}")

    existing_envelope = get_or_init_project_session_envelope(db, item)
    existing_data = dict(existing_envelope.get("data") or {})
    merged = engine.validate_and_merge_session(db, item, data, existing_data)
    new_envelope = {
        "engine": project_engine,
        "schema_version": 1,
        "data": merged,
    }
    project_manifest.write_project_session(db, item.id, new_envelope)
    return {
        "status": "saved",
        "project_id": item.id,
        "project_kind": getattr(item, "project_kind", "audio"),
        "editor_engine": project_engine,
        "session": new_envelope,
    }
