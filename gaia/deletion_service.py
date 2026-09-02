"""Atomic, polymorphic deletion for every GAIA library entry kind."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import shutil
from typing import Any
import uuid

from sqlalchemy.orm import Session

from . import crud, models, project_service, schemas, vaults


class DeletionError(ValueError):
    """A requested library entry cannot be safely deleted."""


@dataclass
class StagedSnapshot:
    """A recoverable filesystem move paired with a pending database delete."""

    original: Path
    staged: Path
    loose_files_root: Path

    def restore(self) -> None:
        if self.staged.exists() and not self.original.exists():
            self.original.parent.mkdir(parents=True, exist_ok=True)
            os.replace(self.staged, self.original)

    def cleanup(self) -> None:
        if self.staged.is_dir():
            shutil.rmtree(self.staged, ignore_errors=True)
        elif self.staged.exists():
            try:
                self.staged.unlink(missing_ok=True)
            except OSError:
                # The database deletion has already committed. A transient file
                # lock must not turn a successful request into a false failure.
                return
        _remove_empty_loose_file_parents(self.original.parent, self.loose_files_root)


def _remove_empty_loose_file_parents(start: Path, files_root: Path) -> None:
    """Prune obsolete loose-import folders without removing ``files/``."""
    current = start.resolve()
    boundary = files_root.resolve()
    try:
        current.relative_to(boundary)
    except ValueError:
        return
    while current != boundary:
        try:
            current.rmdir()
        except OSError:
            return
        current = current.parent


@dataclass
class DeletionContext:
    db: Session
    staged_snapshots: list[StagedSnapshot] = field(default_factory=list)
    affected_project_ids: set[int] = field(default_factory=set)
    deleted_project_ids: set[int] = field(default_factory=set)
    deleted_item_ids: set[int] = field(default_factory=set)

    def _vault_store(self, vault_id: int) -> Path:
        vault = vaults.get_vault(self.db, vault_id)
        if not vault:
            raise DeletionError("Owning vault not found")
        return vaults.vault_store(vault).resolve()

    def stage_item(self, item: models.Item) -> StagedSnapshot | None:
        """Move a managed item aside until the database transaction commits."""
        snapshot = Path(item.absolute_path).resolve()
        store = self._vault_store(item.vault_id)
        if snapshot == store:
            return None
        try:
            snapshot.relative_to(store)
        except ValueError:
            # Legacy external rows lose only their GAIA record. GAIA never
            # deletes a physical path outside its owning vault.
            return None
        if not snapshot.exists():
            return None
        if isinstance(item, models.FolderItem) != snapshot.is_dir():
            return None

        staged = snapshot.parent / f".deleting-{item.id}-{uuid.uuid4().hex}"
        os.replace(snapshot, staged)
        record = StagedSnapshot(snapshot, staged, store / "files")
        self.staged_snapshots.append(record)
        return record

    def stage_content(
        self,
        collection: models.FolderItem,
        content_path: Path,
        content_index: int,
    ) -> StagedSnapshot:
        """Move one manifest-only file aside within its managed collection."""
        snapshot = content_path.resolve()
        collection_root = Path(collection.absolute_path).resolve()
        store = self._vault_store(collection.vault_id)
        try:
            snapshot.relative_to(collection_root)
            snapshot.relative_to(store)
        except ValueError as exc:
            raise DeletionError("Collection content must be inside its managed folder") from exc
        if not snapshot.is_file():
            raise DeletionError("Collection content is missing on disk")

        staged = snapshot.parent / (
            f".deleting-{collection.id}-{content_index}-{uuid.uuid4().hex}"
        )
        os.replace(snapshot, staged)
        record = StagedSnapshot(snapshot, staged, store / "files")
        self.staged_snapshots.append(record)
        return record

    def _item_subtree_ids(self, item_id: int) -> set[int]:
        subtree_ids = {item_id}
        frontier = [item_id]
        while frontier:
            child_ids = [
                row[0]
                for row in self.db.query(models.Item.id)
                .filter(models.Item.parent_id.in_(frontier))
                .all()
                if row[0] not in subtree_ids
            ]
            subtree_ids.update(child_ids)
            frontier = child_ids
        return subtree_ids

    def delete_item(self, item_id: int) -> models.Item | None:
        # A selected container can recursively cover another selected target.
        # Treat the later command as already satisfied instead of failing the
        # otherwise-valid atomic batch with "Item not found".
        if item_id in self.deleted_item_ids:
            return None
        item = crud.get_item(self.db, item_id)
        if not item:
            raise DeletionError("Item not found")
        subtree_ids = self._item_subtree_ids(item.id)
        self.affected_project_ids.update(crud.owning_project_context_ids(self.db, item))
        if isinstance(item, models.ProjectItem):
            self.deleted_project_ids.add(item.id)
        self.stage_item(item)
        crud.delete_item(self.db, item_id, commit=False)
        self.deleted_item_ids.update(subtree_ids)
        return item

    def restore(self) -> None:
        for snapshot in reversed(self.staged_snapshots):
            snapshot.restore()

    def cleanup(self, background_tasks: Any | None) -> None:
        for snapshot in self.staged_snapshots:
            if background_tasks is None:
                snapshot.cleanup()
            else:
                background_tasks.add_task(snapshot.cleanup)


class DeletionTarget:
    """Base command object; each entry kind owns its deletion semantics."""

    priority = 10

    def __init__(self, locator, request_index: int):
        self.locator = locator
        self.request_index = request_index

    @property
    def key(self) -> str:
        raise NotImplementedError

    def delete(self, context: DeletionContext) -> dict:
        raise NotImplementedError


class ItemDeletionTarget(DeletionTarget):
    priority = 30

    @property
    def key(self) -> str:
        return f"item:{self.locator.item_id}"

    def delete(self, context: DeletionContext) -> dict:
        context.delete_item(self.locator.item_id)
        return {
            "key": self.key,
            "kind": "item",
            "item_id": self.locator.item_id,
        }


def _find_collection_content(collection: models.FolderItem, content_index: int) -> dict:
    content = next(
        (
            entry
            for entry in (getattr(collection, "contents", []) or [])
            if entry.get("index") == content_index
        ),
        None,
    )
    if not content:
        raise DeletionError("Collection content not found")
    return content


def _resolve_collection_content_path(collection: models.FolderItem, content: dict) -> Path:
    relative_path = content.get("relative_path", "")
    collection_root = Path(collection.absolute_path).resolve()
    candidate = (collection_root / relative_path).resolve()
    if not candidate.is_file():
        stripped = re.sub(r"^extracted/[^/]+/", "", relative_path)
        alternate = (collection_root / stripped).resolve()
        if alternate.is_file():
            candidate = alternate
    try:
        candidate.relative_to(collection_root)
    except ValueError as exc:
        raise DeletionError("Collection content is outside its managed folder") from exc
    if not candidate.is_file():
        raise DeletionError("Collection content is missing on disk")
    return candidate


class CollectionContentDeletionTarget(DeletionTarget):
    priority = 20

    @property
    def key(self) -> str:
        return f"content:{self.locator.collection_id}:{self.locator.content_index}"

    def delete(self, context: DeletionContext) -> dict:
        collection = crud.get_item(context.db, self.locator.collection_id)
        if not collection:
            raise DeletionError("Collection not found")
        if not isinstance(collection, models.FolderItem):
            raise DeletionError("Item is not a collection")
        content = _find_collection_content(collection, self.locator.content_index)
        child_id = content.get("child_id")
        if child_id:
            context.delete_item(int(child_id))
        else:
            content_path = _resolve_collection_content_path(collection, content)
            context.stage_content(collection, content_path, self.locator.content_index)
            remaining = [
                entry
                for entry in (collection.contents or [])
                if entry.get("index") != self.locator.content_index
            ]
            crud.save_collection_contents(context.db, collection, remaining, commit=False)
            if isinstance(collection, models.ProjectItem):
                context.affected_project_ids.add(collection.id)
        return {
            "key": self.key,
            "kind": "content",
            "collection_id": self.locator.collection_id,
            "content_index": self.locator.content_index,
            "item_id": int(child_id) if child_id else None,
        }


class ProjectReferenceDeletionTarget(DeletionTarget):
    priority = 10

    @property
    def key(self) -> str:
        return f"reference:{self.locator.project_id}:{self.locator.reference_id}"

    def delete(self, context: DeletionContext) -> dict:
        project = (
            context.db.query(models.FolderItem)
            .filter(models.FolderItem.id == self.locator.project_id)
            .first()
        )
        if not project:
            raise DeletionError("Project not found")
        reference = (
            context.db.query(models.ItemReference)
            .filter(
                models.ItemReference.id == self.locator.reference_id,
                models.ItemReference.context_id == self.locator.project_id,
            )
            .first()
        )
        if not reference:
            raise DeletionError("Project reference not found")
        context.db.delete(reference)
        context.db.flush()
        context.affected_project_ids.add(self.locator.project_id)
        return {
            "key": self.key,
            "kind": "reference",
            "project_id": self.locator.project_id,
            "reference_id": self.locator.reference_id,
        }


TARGET_TYPES = {
    "item": ItemDeletionTarget,
    "content": CollectionContentDeletionTarget,
    "reference": ProjectReferenceDeletionTarget,
}


def _target_for(locator, request_index: int) -> DeletionTarget:
    target_type = TARGET_TYPES.get(locator.kind)
    if not target_type:
        raise DeletionError(f"Unsupported deletion target: {locator.kind}")
    return target_type(locator, request_index)


def delete_entries(
    db: Session,
    locators: list[
        schemas.ItemDeleteLocator
        | schemas.CollectionContentDeleteLocator
        | schemas.ProjectReferenceDeleteLocator
    ],
    *,
    background_tasks: Any | None = None,
) -> dict:
    """Delete a heterogeneous entry selection in one recoverable transaction."""
    if not locators:
        raise DeletionError("Select at least one entry to delete")

    unique_targets: dict[str, DeletionTarget] = {}
    for index, locator in enumerate(locators):
        target = _target_for(locator, index)
        unique_targets.setdefault(target.key, target)

    context = DeletionContext(db)
    deleted_with_order: list[tuple[int, dict]] = []
    try:
        for target in sorted(
            unique_targets.values(),
            key=lambda value: (value.priority, value.request_index),
        ):
            deleted_with_order.append((target.request_index, target.delete(context)))
        db.commit()
    except Exception:
        db.rollback()
        context.restore()
        raise

    context.cleanup(background_tasks)
    warnings: list[str] = []
    for project_id in sorted(context.affected_project_ids - context.deleted_project_ids):
        try:
            project_service.sync_project_manifest(db, project_id)
        except (ValueError, OSError) as exc:
            warnings.append(f"Project {project_id} manifest could not be refreshed: {exc}")

    return {
        "status": "success",
        "deleted": [
            value
            for _, value in sorted(deleted_with_order, key=lambda pair: pair[0])
        ],
        "warnings": warnings,
    }
