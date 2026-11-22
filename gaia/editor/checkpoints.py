"""Engine-agnostic project session checkpoints stored under .gaia/snapshots/."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any
import uuid

from sqlalchemy.orm import Session

from .. import models, project_manifest


def _clean_label(value: str | None, fallback: str) -> str:
    cleaned = (value or "").strip()
    return cleaned[:100] or fallback


def _get_project(db: Session, project_id: int) -> models.ProjectItem:
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    return project


def list_checkpoints(db: Session, project_id: int) -> list[dict[str, Any]]:
    project = _get_project(db, project_id)
    doc = project_manifest.read_project_manifest(project)
    checkpoints = doc.get("checkpoints")
    return [dict(c) for c in checkpoints if isinstance(c, dict)] if isinstance(checkpoints, list) else []


def create_checkpoint(db: Session, project_id: int, label: str | None = None) -> dict[str, Any]:
    from . import session_service

    project = _get_project(db, project_id)
    current_session = session_service.get_or_init_project_session_envelope(db, project)

    checkpoint_id = f"chk-{uuid.uuid4().hex[:8]}"
    created_at = datetime.now(timezone.utc).isoformat()
    checkpoints = list_checkpoints(db, project.id)
    fallback_label = f"Checkpoint {len(checkpoints) + 1}"
    resolved_label = _clean_label(label, fallback_label)
    filename = f"{checkpoint_id}.json"

    snapshots_dir = project_manifest.checkpoints_dir(project)
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    target_path = snapshots_dir / filename
    tmp_path = snapshots_dir / f".{filename}.{uuid.uuid4().hex}.tmp"

    snapshot_payload = {
        "format": "gaia-project-checkpoint",
        "version": 1,
        "id": checkpoint_id,
        "label": resolved_label,
        "project_id": project.id,
        "project_kind": getattr(project, "project_kind", "audio"),
        "editor_engine": getattr(project, "editor_engine", "sin"),
        "created_at": created_at,
        "session": current_session,
    }
    try:
        tmp_path.write_text(
            json.dumps(snapshot_payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp_path.replace(target_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    entry = {
        "id": checkpoint_id,
        "label": resolved_label,
        "engine": snapshot_payload["editor_engine"],
        "filename": filename,
        "created_at": created_at,
    }
    checkpoints.append(entry)
    try:
        project_manifest.sync_project_manifest(db, project.id, checkpoints=checkpoints)
    except Exception:
        target_path.unlink(missing_ok=True)
        raise
    return entry


def restore_checkpoint(db: Session, project_id: int, checkpoint_id: str) -> dict[str, Any]:
    project = _get_project(db, project_id)
    checkpoints = list_checkpoints(db, project.id)
    entry = next((c for c in checkpoints if c.get("id") == checkpoint_id), None)
    if not entry:
        raise ValueError("Checkpoint not found")

    filename = entry.get("filename") or f"{checkpoint_id}.json"
    file_path = project_manifest.checkpoints_dir(project) / Path(filename).name
    if not file_path.is_file():
        raise ValueError("Checkpoint snapshot file is missing from disk")

    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError(f"Could not read checkpoint file: {exc}") from exc

    session_doc = payload.get("session")
    if not isinstance(session_doc, dict) or not session_doc.get("engine"):
        raise ValueError("Checkpoint file does not contain a valid session")
    if session_doc.get("engine") != getattr(project, "editor_engine", "sin"):
        raise ValueError("Checkpoint engine does not match this project's engine")

    project_manifest.write_project_session(db, project.id, session_doc)
    return {
        "restored_checkpoint": entry,
        "session": session_doc,
    }


def delete_checkpoint(db: Session, project_id: int, checkpoint_id: str) -> list[dict[str, Any]]:
    project = _get_project(db, project_id)
    checkpoints = list_checkpoints(db, project.id)
    entry = next((c for c in checkpoints if c.get("id") == checkpoint_id), None)
    if not entry:
        raise ValueError("Checkpoint not found")

    remaining = [c for c in checkpoints if c.get("id") != checkpoint_id]
    project_manifest.sync_project_manifest(db, project.id, checkpoints=remaining)

    filename = entry.get("filename") or f"{checkpoint_id}.json"
    file_path = project_manifest.checkpoints_dir(project) / Path(filename).name
    file_path.unlink(missing_ok=True)
    return remaining
