"""Single JSON manifest for a project's editor state and logical file links.

GAIA's SQLite ``ItemReference`` rows remain the authority for project
relationships.  This module writes a compact, human-readable snapshot beside
the project's generated files instead of materialising a Markdown file for
each linked asset.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import uuid

from sqlalchemy.orm import Session

from . import models, reference_service


MANIFEST_SCHEMA = "gaia-project-state"
MANIFEST_SCHEMA_VERSION = 3
PROJECT_FORMAT = "gaia-project"
PROJECT_FORMAT_VERSION = 3
EDITOR_STATE_SCHEMA = "gaia-media-edit"
MANIFEST_STAGE = "edit"
MANIFEST_FILENAME = "current.json"
PROJECT_DOCUMENT_FILENAME = "project.json"
_KEEP_EDITOR_STATE = object()
_KEEP_SESSION = object()
_KEEP_CHECKPOINTS = object()


def checkpoints_dir(project: models.ProjectItem) -> Path:
    """Return the internal GAIA checkpoints directory ignored by vault reconciliation."""
    return Path(project.absolute_path).resolve() / ".gaia" / "snapshots"


def _legacy_v2_to_session(project: models.ProjectItem | None, document: dict[str, Any]) -> dict[str, Any] | None:
    engine = getattr(project, "editor_engine", None) or document.get("editor_engine") or "sin"
    if engine == "simple_media":
        edits = document.get("edits") if isinstance(document.get("edits"), dict) else {}
        editor = document.get("editor") if isinstance(document.get("editor"), dict) else None
        targets: dict[str, Any] = {}
        active_target_id: str | None = None
        for key, raw_state in edits.items():
            if isinstance(raw_state, dict):
                targets[str(key)] = _legacy_media_edit_to_target(str(key), raw_state)
        if editor and editor.get("target_id"):
            active_target_id = str(editor["target_id"])
            if active_target_id not in targets:
                targets[active_target_id] = _legacy_media_edit_to_target(active_target_id, editor)
        elif targets:
            active_target_id = next(iter(targets))
        if not targets and not editor and not edits:
            return None
        return {
            "engine": "simple_media",
            "schema_version": 1,
            "data": {
                "active_target_id": active_target_id,
                "targets": targets,
            },
        }
    if isinstance(document.get("graph"), dict) and document["graph"].get("format") == "sin-graph":
        view = document.get("view") if isinstance(document.get("view"), dict) else {}
        return {
            "engine": "sin",
            "schema_version": 1,
            "data": {
                "graph": document["graph"],
                "workspace": None,
                "snapshots": list(document.get("snapshots") or []),
                "active_snapshot_id": view.get("selected_snapshot_id"),
            },
        }
    return None


def _legacy_media_edit_to_target(target_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    item_id = raw.get("source_item_id")
    layers = raw.get("layers") if isinstance(raw.get("layers"), list) else []
    primary = next((l for l in layers if isinstance(l, dict) and l.get("item_id") == item_id), None)
    if primary is None and layers and isinstance(layers[0], dict):
        primary = layers[0]
    pre_gain_db = float((primary or {}).get("pre_gain_db") or 0.0)
    if primary and primary.get("volume") is not None:
        volume = float(primary["volume"])
    elif primary and primary.get("gain_db") is not None:
        volume = 10.0 ** (float(primary["gain_db"]) / 20.0)
    else:
        volume = 1.0
    view = raw.get("view") if isinstance(raw.get("view"), dict) else {}
    return {
        "item_id": int(item_id) if item_id is not None else None,
        "target_id": target_id,
        "main_start_frame": raw.get("main_start_frame"),
        "main_end_frame": raw.get("main_end_frame"),
        "main_start_sec": None,
        "main_end_sec": None,
        "cuts": list(raw.get("segments") or []),
        "pre_gain_db": pre_gain_db,
        "volume": max(0.0, min(1.0, volume)),
        "normalize": bool(raw.get("normalize", False)),
        "target_peak_db": float(raw.get("target_peak_db", -1.0)),
        "output_format": raw.get("output_format") or "wav",
        "view": {
            "waveform_zoom": float(view.get("waveform_zoom") or 1.0),
            "view_start_frame": int(view.get("view_start_frame") or 0),
            "selected_cut_id": view.get("selected_segment_id"),
        },
    }


def read_project_session(project: models.ProjectItem) -> dict[str, Any] | None:
    """Read the engine-namespaced session document from project.json (with lazy v2 fallback)."""
    document = _read_document(manifest_path(project))
    if not document:
        return None
    session = document.get("session")
    if isinstance(session, dict) and session.get("engine"):
        return dict(session)
    return _legacy_v2_to_session(project, document)


def write_project_session(
    db: Session,
    project_id: int,
    session_envelope: dict[str, Any],
    *,
    commit: bool = True,
) -> dict[str, Any]:
    """Atomically write the project's engine session envelope inside project.json."""
    return sync_project_manifest(
        db,
        project_id,
        editor_session=session_envelope,
        commit=commit,
    )


def manifest_path(project: models.ProjectItem) -> Path:
    """Return the one managed document for a project."""
    project_root = Path(project.absolute_path).resolve()
    canonical = project_root / PROJECT_DOCUMENT_FILENAME
    legacy = project_root / "files" / MANIFEST_STAGE / MANIFEST_FILENAME
    if canonical.is_file():
        return canonical
    if legacy.is_file():
        return legacy
    return canonical


def _read_document(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("The project manifest is not a regular file")
    try:
        content = path.read_text(encoding="utf-8")
        if not content.strip():
            return {}
        document = json.loads(content)
    except (OSError, TypeError, ValueError) as exc:
        raise ValueError(f"The project manifest could not be read: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError("The project manifest must contain a JSON object")
    return document


def read_project_manifest(project: models.ProjectItem) -> dict[str, Any]:
    """Read the parsed project document from project.json (or fallback)."""
    path = manifest_path(project)
    doc = _read_document(path)
    return doc if isinstance(doc, dict) else {}


def write_project_manifest(project: models.ProjectItem, document: dict[str, Any]) -> None:
    """Atomically write the project document to project.json."""
    project_root = Path(project.absolute_path).resolve()
    canonical_path = project_root / PROJECT_DOCUMENT_FILENAME
    _atomic_write(canonical_path, document)


def editor_state_document(project: models.ProjectItem, target_id: str | None = None) -> dict[str, Any] | None:
    """Read either the current envelope or the previous editor-only document."""
    document = _read_document(manifest_path(project))
    if document is None or document == {}:
        return None
    if document.get("schema") == MANIFEST_SCHEMA or document.get("format") == PROJECT_FORMAT:
        if target_id:
            edits = document.get("edits")
            if isinstance(edits, dict) and target_id in edits:
                target_state = edits[target_id]
                if isinstance(target_state, dict):
                    return dict(target_state)
        editor = document.get("editor")
        if editor is None:
            return None
        if not isinstance(editor, dict):
            raise ValueError("The project manifest editor state is invalid")
        if target_id and editor.get("target_id") != target_id:
            return None
        return dict(editor)
    if document.get("schema") == EDITOR_STATE_SCHEMA:
        # Version-one editor documents are upgraded atomically the next time
        # the project manifest is written.
        if target_id and document.get("target_id") != target_id:
            return None
        return document
    raise ValueError("The saved editor state uses an unknown format")


def _timestamp(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _path_descriptor(project: models.ProjectItem, item: models.Item) -> dict[str, str]:
    item_path = Path(item.absolute_path).resolve()
    project_root = Path(project.absolute_path).resolve()
    try:
        return {
            "scope": "project",
            "relative_path": item_path.relative_to(project_root).as_posix(),
        }
    except ValueError:
        return {
            "scope": "library",
            "absolute_path": str(item_path),
        }


def _reference_entry(
    project: models.ProjectItem,
    item: models.Item,
    reference: models.ItemReference,
) -> dict[str, Any]:
    return {
        "reference_id": reference.id,
        "from_item_id": reference.from_item_id,
        "to_item_id": reference.to_item_id,
        "relation_kind": reference.relation_kind,
        "stage_name": reference.stage_name,
        "revision_label": reference.revision_label,
        "is_master": bool(reference.is_master),
        "tags": reference_service.relation_tags(reference),
        "attributes": dict(reference.attributes or {}),
        "created_at": _timestamp(reference.created_at),
        "updated_at": _timestamp(reference.updated_at),
        "item": {
            "id": item.id,
            "type": item.type,
            "title": getattr(item, "title", None) or Path(item.absolute_path).name,
            "path": _path_descriptor(project, item),
            "file_hash": item.file_hash,
            "size_bytes": item.size_bytes,
            "mime_type": item.mime_type,
        },
    }


def _remove_legacy_editor_item(db: Session, project: models.ProjectItem, path: Path) -> None:
    """Detach the old database row for ``current.json`` without deleting it.

    Earlier editor saves registered the state file as a normal library asset
    and added a derived relationship to it.  It is now project metadata, not
    an asset-table row.  Only the precisely identified legacy record is
    removed; any user-created relationship keeps its item intact.
    """
    candidates = (
        db.query(models.Item)
        .filter(
            models.Item.absolute_path == str(path.resolve()),
            models.Item.parent_id == project.id,
        )
        .all()
    )
    for item in candidates:
        if (item.attributes or {}).get("gaia_role") != "editor_state":
            continue
        relationships = (
            db.query(models.ItemReference)
            .filter(
                (models.ItemReference.from_item_id == item.id)
                | (models.ItemReference.to_item_id == item.id)
            )
            .all()
        )
        if any(
            reference.context_id != project.id or reference.to_item_id != item.id
            for reference in relationships
        ):
            continue
        for reference in relationships:
            db.delete(reference)
        db.flush()
        db.delete(item)
        db.flush()


def _drop_placeholder_metadata(db: Session, project_id: int) -> None:
    for reference in reference_service.list_references(db, project_id):
        attributes = dict(reference.attributes or {})
        if "placeholder_name" in attributes:
            attributes.pop("placeholder_name", None)
            reference.attributes = attributes


def _is_generated_link_placeholder(content: str) -> bool:
    return "# GAIA linked asset" in content and "gaia:item:" in content


def _is_generated_legacy_document(name: str, content: str) -> bool:
    if name == "SOURCES.md":
        return content.startswith("# Sources —") and "gaia:item:" in content
    if name == "PROJECT_CONTEXT.md":
        return "This file is generated by GAIA. The SQLite reference graph is canonical." in content
    return False


def _delete_if_generated(path: Path, predicate) -> bool:
    if not path.is_file():
        return False
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    if not predicate(content):
        return False
    path.unlink(missing_ok=True)
    return True


def _prune_empty_generated_directories(root: Path) -> None:
    stages = root / "stages"
    if stages.is_dir():
        for directory in sorted(
            (path for path in stages.rglob("*") if path.is_dir()),
            key=lambda path: len(path.parts),
            reverse=True,
        ):
            try:
                directory.rmdir()
            except OSError:
                pass
        try:
            stages.rmdir()
        except OSError:
            pass
    notes = root / "notes"
    if notes.is_dir():
        try:
            notes.rmdir()
        except OSError:
            pass


def remove_legacy_markdown(project: models.ProjectItem) -> list[str]:
    """Delete only Markdown files that can be identified as GAIA-generated."""
    root = Path(project.absolute_path).resolve()
    if not root.is_dir():
        return []
    removed: list[str] = []
    for candidate in root.glob("*.md"):
        if _delete_if_generated(candidate, _is_generated_link_placeholder):
            removed.append(str(candidate))
            continue
        if _delete_if_generated(
            candidate,
            lambda content, name=candidate.name: _is_generated_legacy_document(name, content),
        ):
            removed.append(str(candidate))
    stages = root / "stages"
    if stages.is_dir():
        for candidate in stages.rglob("VERSION_*.md"):
            if _delete_if_generated(
                candidate,
                lambda content: '"reference_id"' in content and "```json" in content,
            ):
                removed.append(str(candidate))
    _prune_empty_generated_directories(root)
    return removed


def _atomic_write(path: Path, document: dict[str, Any]) -> bytes | None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not path.is_file():
        raise ValueError("The project manifest is not a regular file")
    previous = path.read_bytes() if path.is_file() else None
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return previous


def restore_manifest(project: models.ProjectItem, previous: bytes | None) -> None:
    """Restore a manifest after the surrounding database transaction fails."""
    path = manifest_path(project)
    if previous is None:
        path.unlink(missing_ok=True)
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.restore")
    try:
        temporary.write_bytes(previous)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def sync_project_manifest(
    db: Session,
    project_id: int,
    *,
    editor_state: Any = _KEEP_EDITOR_STATE,
    editor_session: Any = _KEEP_SESSION,
    checkpoints: Any = _KEEP_CHECKPOINTS,
    commit: bool = True,
) -> dict[str, Any]:
    """Atomically refresh the compact manifest from canonical project rows."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")

    project_root = Path(project.absolute_path).resolve()
    canonical_path = project_root / PROJECT_DOCUMENT_FILENAME
    legacy_path = project_root / "files" / MANIFEST_STAGE / MANIFEST_FILENAME

    existing_doc = _read_document(manifest_path(project)) or {}
    existing_edits: dict[str, Any] = {}
    if existing_doc and isinstance(existing_doc.get("edits"), dict):
        existing_edits = dict(existing_doc["edits"])

    if editor_state is _KEEP_EDITOR_STATE:
        editor = editor_state_document(project)
        edits = existing_edits
    elif editor_state is None:
        editor = None
        edits = {}
    elif isinstance(editor_state, dict):
        editor = dict(editor_state)
        edits = existing_edits
        target_key = editor.get("target_id")
        if target_key:
            edits[str(target_key)] = editor
    else:
        raise ValueError("The project manifest editor state is invalid")

    project_kind = getattr(project, "project_kind", None) or existing_doc.get("project_kind") or "audio"
    editor_engine = getattr(project, "editor_engine", None) or existing_doc.get("editor_engine") or "sin"

    if editor_session is not _KEEP_SESSION:
        session_doc = dict(editor_session) if isinstance(editor_session, dict) else None
    elif isinstance(existing_doc.get("session"), dict) and existing_doc["session"].get("engine"):
        session_doc = dict(existing_doc["session"])
    else:
        session_doc = _legacy_v2_to_session(project, existing_doc)

    if checkpoints is not _KEEP_CHECKPOINTS:
        checkpoint_list = list(checkpoints or [])
    elif isinstance(existing_doc.get("checkpoints"), list):
        checkpoint_list = list(existing_doc["checkpoints"])
    else:
        checkpoint_list = []

    _remove_legacy_editor_item(db, project, canonical_path)
    _remove_legacy_editor_item(db, project, legacy_path)
    _drop_placeholder_metadata(db, project.id)
    references: list[dict[str, Any]] = []
    for reference in reference_service.list_references(db, project.id):
        item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
        if item:
            references.append(_reference_entry(project, item, reference))

    document: dict[str, Any] = {
        "format": PROJECT_FORMAT,
        "version": PROJECT_FORMAT_VERSION,
        "schema": MANIFEST_SCHEMA,
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "project_id": project.id,
        "project_kind": project_kind,
        "editor_engine": editor_engine,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "session": session_doc,
        "checkpoints": checkpoint_list,
        "references": references,
    }

    # Retain legacy media-editor fields only when legacy editor-state paths wrote them,
    # keeping legacy callers/tests compatible without ever clobbering `session`.
    if editor is not None or edits:
        document["editor"] = editor
        document["edits"] = edits

    # Mirror SIN session graph/snapshots at top level only when engine == "sin" and present
    # in session so older SIN manifest readers stay compatible, without mutating session.
    if editor_engine == "sin" and isinstance(session_doc, dict) and session_doc.get("engine") == "sin":
        s_data = session_doc.get("data") or {}
        if isinstance(s_data.get("graph"), dict):
            document["graph"] = s_data["graph"]
        if isinstance(s_data.get("snapshots"), list):
            document["snapshots"] = s_data["snapshots"]
        if s_data.get("active_snapshot_id") is not None:
            document["view"] = {"selected_snapshot_id": s_data.get("active_snapshot_id")}
    elif editor_engine == "sin":
        if isinstance(existing_doc.get("graph"), dict):
            document["graph"] = existing_doc["graph"]
        if isinstance(existing_doc.get("snapshots"), list):
            document["snapshots"] = existing_doc["snapshots"]
        if isinstance(existing_doc.get("view"), dict):
            document["view"] = existing_doc["view"]

    previous = _atomic_write(canonical_path, document)
    if legacy_path.is_file() and canonical_path.is_file():
        legacy_path.unlink(missing_ok=True)
        try:
            legacy_path.parent.rmdir()
        except OSError:
            pass

    try:
        if commit:
            db.commit()
    except Exception:
        restore_manifest(project, previous)
        raise
    # Generated Markdown is removed only after the manifest and any legacy
    # metadata cleanup have committed.  A filesystem cleanup failure is safe:
    # the old projection can simply be retried on the next sync.
    removed_markdown = remove_legacy_markdown(project) if commit else []
    return {
        "manifest": str(canonical_path),
        "removed_markdown": removed_markdown,
        "previous": previous,
    }


def migrate_v1_project_layouts(db: Session) -> dict[str, Any]:
    """Migrate legacy project layouts to the canonical project.json and files/ layout."""
    from . import vaults

    migrated_projects = 0
    moved_files_count = 0
    path_rewrites = []

    for project in db.query(models.ProjectItem).all():
        project_root = Path(project.absolute_path).resolve()
        if not project_root.is_dir():
            continue

        canonical_json = project_root / PROJECT_DOCUMENT_FILENAME
        legacy_json = project_root / "files" / MANIFEST_STAGE / MANIFEST_FILENAME

        # 1. Ensure project.json exists
        if not canonical_json.is_file():
            if legacy_json.is_file():
                try:
                    sync_project_manifest(db, project.id, commit=False)
                    migrated_projects += 1
                except Exception:
                    pass
            else:
                canonical_json.write_text("{}\n", encoding="utf-8")
                migrated_projects += 1

        # 2. Ensure files/ and files/derived/ directories exist
        files_dir = project_root / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        derived_dir = files_dir / "derived"
        derived_dir.mkdir(parents=True, exist_ok=True)

        # 3. Move files from legacy locations (files/source, files/cuts, files/mixdown)
        for stage_name, target_dir in [
            ("source", files_dir),
            ("cuts", derived_dir),
            ("mixdown", derived_dir),
        ]:
            legacy_stage_dir = files_dir / stage_name
            if legacy_stage_dir.is_dir():
                for p in list(legacy_stage_dir.iterdir()):
                    if p.is_file() and p.name != MANIFEST_FILENAME:
                        dest = target_dir / p.name
                        if dest.exists() and dest != p:
                            stem, suffix = p.stem, p.suffix
                            cnt = 2
                            while (target_dir / f"{stem}_{cnt}{suffix}").exists():
                                cnt += 1
                            dest = target_dir / f"{stem}_{cnt}{suffix}"
                        if dest != p:
                            p.replace(dest)
                            path_rewrites.append({"source": str(p.resolve()), "target": str(dest.resolve())})
                            moved_files_count += 1
                try:
                    legacy_stage_dir.rmdir()
                except OSError:
                    pass

        # Also clean up legacy files/edit if current.json was removed and it's empty
        legacy_edit_dir = files_dir / "edit"
        if legacy_edit_dir.is_dir():
            legacy_file = legacy_edit_dir / MANIFEST_FILENAME
            if legacy_file.is_file() and canonical_json.is_file():
                legacy_file.unlink(missing_ok=True)
            try:
                legacy_edit_dir.rmdir()
            except OSError:
                pass

    if path_rewrites:
        vaults.rewrite_managed_paths(db.connection(), path_rewrites)
        db.commit()

    return {"migrated_projects": migrated_projects, "moved_files": moved_files_count}

