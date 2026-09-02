"""Generic project-scoped relationships and master resolution for GAIA."""

from __future__ import annotations

from pathlib import Path
import re

from sqlalchemy.orm import Session

from . import integrity, models, profiles, schemas


RELATION_KINDS = frozenset({"component", "use", "derived", "supersedes"})

_VERSION_SUFFIX_RE = re.compile(r"^(?P<base>.+)\.(?P<revision>\d{2})(?P<extension>\.[^.]+)$", re.IGNORECASE)


class ReferenceError(ValueError):
    """Raised when a graph operation would violate GAIA's project model."""


def _project(db: Session, project_id: int) -> models.ProjectItem:
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ReferenceError("Project not found")
    return project


def _folder_context(db: Session, context_id: int) -> models.FolderItem:
    folder = db.query(models.FolderItem).filter(models.FolderItem.id == context_id).first()
    if not folder:
        raise ReferenceError("Folder context not found")
    return folder


def _item(db: Session, item_id: int) -> models.Item:
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    if not item:
        raise ReferenceError("Referenced item not found")
    return item


def _clean_optional_label(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > 120:
        raise ReferenceError(f"{field_name} must be 120 characters or fewer")
    return cleaned


def _clean_tags(values) -> list[str]:
    if isinstance(values, str):
        values = [values]
    cleaned: list[str] = []
    for value in values or []:
        tag = str(value).strip()
        if not tag or tag in cleaned:
            continue
        if len(tag) > 120:
            raise ReferenceError("Relationship tags must be 120 characters or fewer")
        cleaned.append(tag)
    return cleaned


def relation_tags(reference: models.ItemReference) -> list[str]:
    values = reference.attributes.get("tags", [])
    return _clean_tags(values)


def file_version_info(path_or_name: str | Path) -> dict[str, str | None]:
    """Return the filename group and two-digit revision encoded by ``.nn``."""
    name = Path(path_or_name).name
    match = _VERSION_SUFFIX_RE.match(name)
    if not match:
        return {"group": name.casefold(), "revision": None, "base_name": name}
    base_name = f"{match.group('base')}{match.group('extension')}"
    return {
        "group": base_name.casefold(),
        "revision": match.group("revision"),
        "base_name": base_name,
    }


def _reference_payload(reference: models.ItemReference) -> dict:
    return {
        "id": reference.id,
        "context_id": reference.context_id,
        "from_item_id": reference.from_item_id,
        "to_item_id": reference.to_item_id,
        "relation_kind": reference.relation_kind,
        "stage_name": reference.stage_name,
        "revision_label": reference.revision_label,
        "is_master": bool(reference.is_master),
        "tags": relation_tags(reference),
        "attributes": reference.attributes,
        "created_at": reference.created_at,
        "updated_at": reference.updated_at,
    }


def _clear_master(db: Session, project_id: int) -> None:
    db.query(models.ItemReference).filter(
        models.ItemReference.context_id == project_id,
        models.ItemReference.is_master.is_(True),
    ).update({models.ItemReference.is_master: False}, synchronize_session=False)
    db.flush()


def _would_create_master_cycle(db: Session, project_id: int, target_item_id: int) -> bool:
    """Return whether making ``target_item_id`` a project's master would cycle."""
    target = _item(db, target_item_id)
    if not isinstance(target, models.ProjectItem):
        return False

    visited: set[int] = set()
    current: models.Item = target
    while isinstance(current, models.ProjectItem):
        if current.id == project_id or current.id in visited:
            return True
        visited.add(current.id)
        master = (
            db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == current.id,
                models.ItemReference.is_master.is_(True),
            )
            .first()
        )
        if not master:
            return False
        current = _item(db, master.to_item_id)
    return False


def create_reference(
    db: Session,
    data: schemas.ItemReferenceCreate | schemas.ProjectReferenceCreate,
    *,
    context_id: int | None = None,
    commit: bool = True,
) -> models.ItemReference:
    project_id = context_id if context_id is not None else getattr(data, "context_id", None)
    if project_id is None:
        raise ReferenceError("A folder context is required")
    _folder_context(db, project_id)
    _item(db, data.from_item_id)
    _item(db, data.to_item_id)
    if data.relation_kind not in RELATION_KINDS:
        raise ReferenceError("Unknown relationship kind")
    if data.from_item_id == data.to_item_id:
        raise ReferenceError("A relationship cannot point to the same item")

    # Stage metadata is retained only for reading legacy rows. New project
    # links keep the same context as a generic relation tag.
    stage_tag = _clean_optional_label(data.stage_name, "Stage name")
    stage_name = None
    revision_label = _clean_optional_label(data.revision_label, "Revision label")
    attributes = dict(getattr(data, "attributes", {}) or {})
    explicit_tags = getattr(data, "tags", None) or []
    stored_tags = attributes.get("tags", [])
    if isinstance(stored_tags, str):
        stored_tags = [stored_tags]
    if stage_tag:
        stored_tags = [*stored_tags, stage_tag]
    attributes["tags"] = _clean_tags([*stored_tags, *explicit_tags])
    if data.is_master:
        _project(db, project_id)
        if _would_create_master_cycle(db, project_id, data.to_item_id):
            raise ReferenceError("Master assignment would create a project cycle")
        _clear_master(db, project_id)

    reference = models.ItemReference(
        context_id=project_id,
        from_item_id=data.from_item_id,
        to_item_id=data.to_item_id,
        relation_kind=data.relation_kind,
        stage_name=stage_name,
        revision_label=revision_label,
        is_master=bool(data.is_master),
        attributes=attributes,
    )
    db.add(reference)
    if commit:
        db.commit()
        db.refresh(reference)
    else:
        db.flush()
    return reference


def create_source_reference(
    db: Session,
    project_id: int,
    source_item_id: int,
    *,
    commit: bool = True,
) -> models.ItemReference:
    # Kept as a compatibility shim for older callers. Projects now store a
    # generic link rather than a source relationship.
    return create_reference(
        db,
        schemas.ProjectReferenceCreate(
            from_item_id=project_id,
            to_item_id=source_item_id,
            relation_kind="use",
        ),
        context_id=project_id,
        commit=commit,
    )


def list_references(db: Session, project_id: int) -> list[models.ItemReference]:
    _folder_context(db, project_id)
    return (
        db.query(models.ItemReference)
        .filter(models.ItemReference.context_id == project_id)
        .order_by(models.ItemReference.created_at, models.ItemReference.id)
        .all()
    )


def project_table(db: Session, project_id: int) -> list[dict]:
    """Return one visible row per filename revision group.

    The individual assets and reference rows remain intact. This projection is
    only for consumers that want a compact project table with a version
    selector.
    """
    from . import crud

    references = list_references(db, project_id)
    groups: dict[str, list[tuple[models.ItemReference, models.Item, dict]]] = {}
    for reference in references:
        item = _item(db, reference.to_item_id)
        info = file_version_info(item.absolute_path)
        groups.setdefault(str(info["group"]), []).append((reference, item, info))

    rows: list[dict] = []
    for group, entries in groups.items():
        def sort_key(entry):
            revision = entry[2].get("revision")
            return (revision is not None, int(revision or 0), entry[1].absolute_path.casefold())

        ordered = sorted(entries, key=sort_key)
        selected = ordered[-1]
        versions = []
        for reference, item, info in ordered:
            label = reference.revision_label or info.get("revision") or "base"
            versions.append({
                "item": crud.get_item(db, item.id),
                "reference": _reference_payload(reference),
                "label": str(label),
            })
        rows.append({
            "item": crud.get_item(db, selected[1].id),
            "reference": _reference_payload(selected[0]),
            "version_group": group,
            "versions": versions,
        })
    return rows


def update_reference(
    db: Session,
    context_id: int,
    reference_id: int,
    data: schemas.ProjectReferenceUpdate,
) -> models.ItemReference:
    _folder_context(db, context_id)
    reference = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.id == reference_id,
            models.ItemReference.context_id == context_id,
        )
        .first()
    )
    if not reference:
        raise ReferenceError("Reference not found")
    reference.revision_label = _clean_optional_label(data.revision_label, "Revision label")
    if data.tags is not None:
        attributes = dict(reference.attributes)
        attributes["tags"] = _clean_tags(data.tags)
        reference.attributes = attributes
    db.commit()
    db.refresh(reference)
    return reference


def delete_reference(db: Session, project_id: int, reference_id: int) -> None:
    reference = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.id == reference_id,
            models.ItemReference.context_id == project_id,
        )
        .first()
    )
    if not reference:
        raise ReferenceError("Reference not found")
    db.delete(reference)
    db.commit()


def set_master(db: Session, project_id: int, reference_id: int) -> models.ItemReference:
    reference = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.id == reference_id,
            models.ItemReference.context_id == project_id,
        )
        .first()
    )
    if not reference:
        raise ReferenceError("Reference not found")
    if _would_create_master_cycle(db, project_id, reference.to_item_id):
        raise ReferenceError("Master assignment would create a project cycle")
    _clear_master(db, project_id)
    reference.is_master = True
    db.commit()
    db.refresh(reference)
    return reference


def integrity_status(item: models.Item) -> str:
    path = Path(item.absolute_path)
    if not path.exists():
        return "missing"
    if not item.file_hash or not path.is_file():
        return "unknown"
    return "verified" if integrity.verify_file_integrity(str(path), item.file_hash) else "modified"


def _profile_component_suggestions(
    profile: profiles.Profile,
    child_by_relative: dict[str, models.Item],
) -> list[profiles.ComponentSuggestion]:
    suggestions = {
        suggestion.relative_path: suggestion
        for suggestion in profiles.suggest_components(profile, child_by_relative)
    }
    if profile.id == "zoom_h4":
        for relative_path, child in child_by_relative.items():
            if child.attributes.get("profile_role") != "mixdown":
                continue
            suggestions[relative_path] = profiles.ComponentSuggestion(
                profile_id=profile.id,
                bundle_id=profile.bundle_id,
                relative_path=relative_path,
                label="mixdown",
                relation_kind="component",
                stage_name="mixdown",
                suggested_master=True,
            )
    return [suggestions[path] for path in child_by_relative if path in suggestions]


def _profile_preview_item(db: Session, folder: models.FolderItem) -> models.Item | None:
    profile_id = folder.attributes.get("profile_id")
    if not profile_id:
        return None
    profile = profiles.get_profile(profile_id)
    if not profile:
        return None
    root = Path(folder.absolute_path)
    child_by_relative: dict[str, models.Item] = {}
    for child in folder.children:
        try:
            relative = child.absolute_path and Path(child.absolute_path).relative_to(root).as_posix()
        except ValueError:
            continue
        child_by_relative[relative] = child
    for suggestion in _profile_component_suggestions(profile, child_by_relative):
        if suggestion.suggested_master:
            return child_by_relative.get(suggestion.relative_path)
    return None


def resolve_master(db: Session, project_id: int, _visited: set[int] | None = None) -> dict:
    """Resolve a project's effective preview item without allowing cycles."""
    visited = set(_visited or set())
    if project_id in visited:
        return {"status": "cycle", "project_id": project_id, "trail": sorted(visited)}
    visited.add(project_id)
    _project(db, project_id)
    reference = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project_id,
            models.ItemReference.is_master.is_(True),
        )
        .first()
    )
    if not reference:
        return {"status": "unset", "project_id": project_id, "trail": sorted(visited)}

    target = _item(db, reference.to_item_id)
    if isinstance(target, models.ProjectItem):
        nested = resolve_master(db, target.id, visited)
        return {
            "status": nested["status"],
            "project_id": project_id,
            "reference": _reference_payload(reference),
            "target_item_id": target.id,
            "resolved_item_id": nested.get("resolved_item_id", target.id),
            "trail": nested.get("trail", sorted(visited)),
        }

    if isinstance(target, models.FolderItem):
        preview = _profile_preview_item(db, target)
        resolved = preview or target
    else:
        resolved = target
    return {
        "status": "resolved",
        "project_id": project_id,
        "reference": _reference_payload(reference),
        "target_item_id": target.id,
        "resolved_item_id": resolved.id,
        "integrity_status": integrity_status(resolved),
        "trail": sorted(visited),
    }


def resolve_item_preview(
    db: Session,
    item_id: int,
    _visited: set[int] | None = None,
) -> models.Item | None:
    """Return the effective playable preview for a project or folder item.

    Projects prefer their resolved master. Folder-like sources prefer the
    profile-designated master and otherwise use their first playable child as
    a useful fallback for the library preview.
    """
    visited = set(_visited or set())
    if item_id in visited:
        return None
    visited.add(item_id)
    item = _item(db, item_id)

    if isinstance(item, models.ProjectItem):
        resolved = resolve_master(db, item.id)
        resolved_id = resolved.get("resolved_item_id")
        if resolved_id and resolved_id != item.id:
            candidate = _item(db, resolved_id)
            if isinstance(candidate, models.ProjectItem):
                return resolve_item_preview(db, candidate.id, visited)
            return candidate if candidate.type in {"audio", "track", "sample"} else None

        # A newly-created project may not have an explicit master yet. Keep
        # the row useful by previewing its first referenced playable source.
        references = list_references(db, item.id)
        for reference in references:
            candidate = _item(db, reference.to_item_id)
            preview = resolve_item_preview(db, candidate.id, visited)
            if preview:
                return preview
        return None

    if isinstance(item, models.FolderItem):
        profile_preview = _profile_preview_item(db, item)
        if profile_preview:
            return profile_preview
        return next(
            (
                child
                for child in sorted(item.children, key=lambda value: value.absolute_path.casefold())
                if child.type in {"audio", "track", "sample"}
            ),
            None,
        )

    return item if item.type in {"audio", "track", "sample"} else None


def graph_for_item(db: Session, item_id: int, project_id: int | None = None) -> dict:
    _item(db, item_id)
    query = db.query(models.ItemReference).filter(
        (models.ItemReference.from_item_id == item_id)
        | (models.ItemReference.to_item_id == item_id)
    )
    if project_id is not None:
        _project(db, project_id)
        query = query.filter(models.ItemReference.context_id == project_id)
    references = query.order_by(models.ItemReference.created_at, models.ItemReference.id).all()
    return {
        "item_id": item_id,
        "references": [_reference_payload(reference) for reference in references],
    }


def apply_profile(
    db: Session,
    project_id: int,
    source_item_id: int,
    profile_id: str,
    *,
    mark_suggested_master: bool = False,
) -> list[models.ItemReference]:
    _project(db, project_id)
    source = _item(db, source_item_id)
    source_reference = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project_id,
            models.ItemReference.from_item_id == project_id,
            models.ItemReference.to_item_id == source_item_id,
            models.ItemReference.relation_kind == "use",
        )
        .first()
    )
    if not source_reference:
        raise ReferenceError("Link the folder to the project before applying a profile")
    if not isinstance(source, models.FolderItem):
        raise ReferenceError("Profiles can only interpret folder-like source items")
    profile = profiles.get_profile(profile_id)
    if not profile:
        raise ReferenceError("Profile not found")
    if source.type != profile.container_type:
        raise ReferenceError("Profile does not match this source item type")

    root = Path(source.absolute_path)
    child_by_relative: dict[str, models.Item] = {}
    for child in source.children:
        try:
            child_by_relative[Path(child.absolute_path).relative_to(root).as_posix()] = child
        except ValueError:
            continue
    suggestions = _profile_component_suggestions(profile, child_by_relative)
    created: list[models.ItemReference] = []
    for suggestion in suggestions:
        child = child_by_relative.get(suggestion.relative_path)
        if not child:
            continue
        existing = (
            db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project_id,
                models.ItemReference.from_item_id == source.id,
                models.ItemReference.to_item_id == child.id,
                models.ItemReference.relation_kind == suggestion.relation_kind,
                models.ItemReference.stage_name == suggestion.stage_name,
            )
            .first()
        )
        is_master = bool(mark_suggested_master and suggestion.suggested_master)
        attributes = {
            "label": suggestion.label,
            "profile_id": suggestion.profile_id,
            "profile_bundle_id": suggestion.bundle_id,
        }
        if existing:
            existing.attributes = attributes
            if is_master:
                _clear_master(db, project_id)
                existing.is_master = True
            created.append(existing)
            continue
        created.append(
            create_reference(
                db,
                schemas.ProjectReferenceCreate(
                    from_item_id=source.id,
                    to_item_id=child.id,
                    relation_kind=suggestion.relation_kind,
                    stage_name=suggestion.stage_name,
                    is_master=is_master,
                    attributes=attributes,
                ),
                context_id=project_id,
                commit=False,
            )
        )
    db.commit()
    for reference in created:
        db.refresh(reference)
    return created
