import json
import os
import re
import datetime
from pathlib import Path
from sqlalchemy import delete, func, insert, or_, update
from sqlalchemy.orm import Session, aliased, selectin_polymorphic, selectinload
from . import models, schemas, type_registry

TRACK_METADATA_FIELDS = (
    "title",
    "author",
    "album",
    "album_artist",
    "release_year",
    "genre",
    "track_number",
    "disc_number",
    "comment",
)


ITEM_POLYMORPHIC_TYPES = (
    models.MidiItem,
    models.SequenceItem,
    models.AudioItem,
    models.TrackItem,
    models.SampleItem,
    models.VideoItem,
    models.FolderItem,
    models.CollectionItem,
    models.MultitrackItem,
    models.ZoomH4Item,
    models.ProjectItem,
)


def _audio_metadata(item, attributes: dict | None = None) -> dict:
    attrs = attributes if attributes is not None else (getattr(item, "attributes", {}) or {})
    metadata = attrs.get("audio_metadata") or {}
    return dict(metadata) if isinstance(metadata, dict) else {}


def _source_path(item, attributes: dict | None = None) -> str | None:
    """Return the pre-import location stored in generic item metadata."""
    direct = getattr(item, "source_path", None)
    if direct:
        return direct
    attrs = attributes if attributes is not None else (getattr(item, "attributes", {}) or {})
    import_attributes = attrs.get("import") or {}
    return import_attributes.get("source_path") if isinstance(import_attributes, dict) else None


def _apply_audio_metadata_fields(item, attributes: dict | None = None) -> dict:
    metadata = _audio_metadata(item, attributes)
    for field in TRACK_METADATA_FIELDS:
        setattr(item, field, metadata.get(field))
    if item.type == "track" and metadata.get("title"):
        item.title = metadata["title"]
    elif not getattr(item, "title", None):
        item.title = metadata.get("title") or os.path.basename(
            str(getattr(item, "absolute_path", "")).rstrip("/\\")
        )
    item.audio_metadata = metadata
    return metadata


def _manifest_contents(item: models.FolderItem) -> list[dict]:
    raw = getattr(item, "manifest_json", None)
    if not raw or raw == "[]":
        return []
    try:
        contents = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [dict(entry) for entry in contents if isinstance(entry, dict)] if isinstance(contents, list) else []


def _content_path_key(value: str) -> str:
    return os.path.normcase(os.path.normpath(value or ""))


def _fast_relative_posix(root_path: str, child_path: str) -> str | None:
    """Compute a POSIX relative path using pure string normalization (zero filesystem syscalls)."""
    if not root_path or not child_path:
        return None
    norm_root = os.path.normpath(root_path)
    norm_child = os.path.normpath(child_path)
    if os.path.normcase(norm_child).startswith(os.path.normcase(norm_root) + os.sep):
        return norm_child[len(norm_root) + 1:].replace("\\", "/")
    try:
        rel = os.path.relpath(norm_child, norm_root)
        if not rel.startswith("..") and rel != ".":
            return rel.replace("\\", "/")
    except ValueError:
        pass
    return None


def _child_relative_path(
    collection: models.FolderItem,
    child: models.Item,
    *,
    child_attrs: dict | None = None,
) -> str:
    rel = _fast_relative_posix(collection.absolute_path, child.absolute_path)
    if rel:
        return rel
    attrs = child_attrs if child_attrs is not None else (getattr(child, "attributes", {}) or {})
    col_src = getattr(collection, "source_path", None)
    ch_src = _source_path(child, attrs)
    if col_src and ch_src:
        rel_src = _fast_relative_posix(col_src, ch_src)
        if rel_src:
            return rel_src
    folder_attr = attrs.get("folder")
    if folder_attr:
        return f"{folder_attr}/{os.path.basename(child.absolute_path)}"
    return os.path.basename(child.absolute_path)


def _child_content(
    collection: models.FolderItem,
    child: models.Item,
    existing: dict | None = None,
    *,
    fallback_index: int | None = None,
) -> dict:
    existing = dict(existing or {})
    child_attrs = getattr(child, "attributes", {}) or {}
    child_analysis = child_attrs.get("analysis") or {}
    if not isinstance(child_analysis, dict):
        child_analysis = {}
    child_video = child_attrs.get("video_metadata") or {}
    if not isinstance(child_video, dict):
        child_video = {}
    child_metadata = _audio_metadata(child, child_attrs)
    relative_path = _child_relative_path(collection, child, child_attrs=child_attrs)
    filename = os.path.basename(child.absolute_path)
    child_bpm = getattr(child, "bpm", None)
    child_key = getattr(child, "key", None)
    return {
        **existing,
        "index": existing.get("index", fallback_index),
        "filename": filename,
        "title": (
            getattr(child, "title", None)
            or child_metadata.get("title")
            or existing.get("title")
            or filename
        ),
        "author": child_metadata.get("author") or existing.get("author"),
        "album": child_metadata.get("album") or existing.get("album"),
        "album_artist": child_metadata.get("album_artist") or existing.get("album_artist"),
        "release_year": child_metadata.get("release_year") or existing.get("release_year"),
        "genre": child_metadata.get("genre") or existing.get("genre"),
        "track_number": child_metadata.get("track_number") or existing.get("track_number"),
        "disc_number": child_metadata.get("disc_number") or existing.get("disc_number"),
        "comment": child_metadata.get("comment") or existing.get("comment"),
        "audio_metadata": child_metadata or existing.get("audio_metadata") or {},
        "relative_path": relative_path,
        "source_path": _source_path(child, child_attrs) or existing.get("source_path"),
        "type": child.type,
        "mime_type": child.mime_type,
        "size_bytes": child.size_bytes,
        "duration_seconds": existing.get(
            "duration_seconds",
            child_analysis.get("duration_seconds")
            if child_analysis.get("duration_seconds") is not None
            else child_video.get("duration_seconds"),
        ),
        "bpm": child_bpm if child_bpm is not None else child_analysis.get("bpm"),
        "key": child_key if child_key is not None else child_analysis.get("key"),
        "is_loop": getattr(child, "is_loop", None) if child.type == "sample" else child_analysis.get("is_loop"),
        "favourite": bool(child_attrs.get("favourite") or existing.get("favourite", False)),
        "tags": [tag.name for tag in getattr(child, "tags", [])],
        "streamable": child.type in {"audio", "track", "sample", "video"},
        "child_id": child.id,
        "storage_mode": child.storage_mode,
        "availability": "ready" if getattr(child, "availability", None) in {"ready", "available", None} else child.availability,
        "attributes": dict(child_attrs or existing.get("attributes") or {}),
    }


def _merge_collection_contents(
    collection: models.FolderItem,
    manifest_contents: list[dict],
    children: list[models.Item],
) -> list[dict]:
    contents_by_path = {
        _content_path_key(entry.get("relative_path", "")): dict(entry)
        for entry in manifest_contents
        if entry.get("relative_path")
    }
    content_order = [
        _content_path_key(entry.get("relative_path", ""))
        for entry in manifest_contents
        if entry.get("relative_path")
    ]
    for child in sorted(children, key=lambda value: value.absolute_path.casefold()):
        relative_path = _child_relative_path(collection, child)
        path_key = _content_path_key(relative_path)
        contents_by_path[path_key] = _child_content(collection, child, contents_by_path.get(path_key))
        if path_key not in content_order:
            content_order.append(path_key)
    contents = [contents_by_path[key] for key in content_order if key in contents_by_path]
    for index, content in enumerate(contents):
        if content.get("index") is None:
            content["index"] = index
    return contents


def _collect_subtree_children(db_item) -> list[models.Item]:
    result: list[models.Item] = []
    seen: set[int] = set()
    queue = list(getattr(db_item, "children", []) or [])
    while queue:
        child = queue.pop(0)
        if child.id in seen:
            continue
        seen.add(child.id)
        result.append(child)
        if getattr(child, "type", None) in {"folder", "collection"}:
            queue.extend(list(getattr(child, "children", []) or []))
    return result


def _bulk_load_subtrees(db: Session, root_items: list[models.Item]) -> dict[int, list[models.Item]]:
    """Fetch all non-folder descendants for the given folder roots in bounded polymorphic batches."""
    folder_roots = [
        item for item in root_items
        if isinstance(item, models.FolderItem) or type_registry.is_folder_type(getattr(item, "type", None))
    ]
    if not folder_roots:
        return {}

    folder_to_root: dict[int, int] = {item.id: item.id for item in folder_roots}
    frontier = [item.id for item in folder_roots]
    while frontier:
        next_frontier: list[int] = []
        for offset in range(0, len(frontier), 900):
            batch = frontier[offset : offset + 900]
            sub_rows = (
                db.query(models.Item.id, models.Item.parent_id)
                .filter(
                    models.Item.parent_id.in_(batch),
                    models.Item.type.in_(["folder", "collection"]),
                )
                .all()
            )
            for sub_id, p_id in sub_rows:
                if sub_id not in folder_to_root and p_id in folder_to_root:
                    folder_to_root[sub_id] = folder_to_root[p_id]
                    next_frontier.append(sub_id)
        frontier = next_frontier

    all_folder_ids = list(folder_to_root.keys())
    leaves_by_root: dict[int, list[models.Item]] = {item.id: [] for item in folder_roots}
    for offset in range(0, len(all_folder_ids), 900):
        batch = all_folder_ids[offset : offset + 900]
        children = (
            db.query(models.Item)
            .options(
                selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
                selectinload(models.Item.tags),
            )
            .filter(
                models.Item.parent_id.in_(batch),
                ~models.Item.type.in_(["folder", "collection"]),
            )
            .all()
        )
        for child in children:
            root_id = folder_to_root.get(child.parent_id)
            if root_id is not None:
                leaves_by_root[root_id].append(child)
    return leaves_by_root


def _populate_item_fields(db_item, *, preloaded_leaves: list[models.Item] | None = None):
    if not db_item:
        return db_item
    attributes = getattr(db_item, "attributes", {}) or {}
    if getattr(db_item, "type", None) in {"audio", "track", "sample"}:
        _apply_audio_metadata_fields(db_item, attributes)
    elif not getattr(db_item, "title", None):
        db_item.title = attributes.get("title") or os.path.basename(
            str(getattr(db_item, "absolute_path", "")).rstrip("/\\")
        )
    if isinstance(db_item, models.FolderItem) or type_registry.is_folder_type(getattr(db_item, "type", None)):
        # Child rows are canonical when present, but merge them over the
        # manifest rather than discarding manifest-only entries. This keeps
        # legacy and interrupted imports readable during gradual backfill.
        if preloaded_leaves is not None:
            leaf_children = preloaded_leaves
        else:
            leaf_children = [
                child for child in _collect_subtree_children(db_item)
                if getattr(child, "type", None) not in {"folder", "collection"}
            ]
        contents = _merge_collection_contents(
            db_item,
            _manifest_contents(db_item),
            leaf_children,
        )
        db_item.contents = contents
        db_item.content_count = len(contents)
        try:
            db_item.warnings = json.loads(getattr(db_item, "warnings_json", None) or "[]")
        except Exception:
            db_item.warnings = []
    if isinstance(db_item, models.MultitrackItem) or getattr(db_item, "type", None) in {"multitrack", "zoom_h4"}:
        stems_raw = getattr(db_item, "stems_json", None)
        if stems_raw:
            try:
                db_item.stems = json.loads(stems_raw)
            except Exception:
                db_item.stems = []
        else:
            db_item.stems = []
    db_item.favourite = bool(attributes.get("favourite", False))
    if not isinstance(db_item, models.FolderItem):
        db_item.source_path = _source_path(db_item, attributes)
    return db_item

# Items
def get_item(db: Session, item_id: int):
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    if not item:
        return None
    leaves_map = _bulk_load_subtrees(db, [item])
    return _populate_item_fields(item, preloaded_leaves=leaves_map.get(item.id))

def get_item_by_path(db: Session, absolute_path: str, vault_id: int | None = None):
    norm_path = os.path.abspath(absolute_path)
    query = db.query(models.Item).filter(models.Item.absolute_path == norm_path)
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
    item = query.first()
    if item:
        return _populate_item_fields(item)

    # Check if norm_path matches source_path or is inside a CollectionItem's source_path
    collections_query = db.query(models.FolderItem).filter(models.FolderItem.source_path.isnot(None))
    if vault_id is not None:
        collections_query = collections_query.filter(models.FolderItem.vault_id == vault_id)
    collections = collections_query.all()
    for col in collections:
        if not col.source_path:
            continue
        try:
            col_source = os.path.abspath(col.source_path)
            if norm_path == col_source:
                return _populate_item_fields(col)
            if os.path.commonpath([col_source, norm_path]) == col_source:
                rel = os.path.relpath(norm_path, col_source)
                target_managed_path = os.path.abspath(os.path.join(col.absolute_path, rel))
                sub_item = db.query(models.Item).filter(models.Item.absolute_path == target_managed_path).first()
                if sub_item:
                    return _populate_item_fields(sub_item)
        except ValueError:
            pass

    # Keep resolving the original source path through the import ledger so
    # callers and repeat scans do not create duplicates after a managed copy.
    source_values = {absolute_path, norm_path}
    log_query = db.query(models.VaultImportLog).filter(
        models.VaultImportLog.source_path.in_(source_values),
        models.VaultImportLog.item_id.isnot(None),
    )
    if vault_id is not None:
        log_query = log_query.filter(models.VaultImportLog.vault_id == vault_id)
    source_log = log_query.order_by(models.VaultImportLog.created_at.desc()).first()
    if source_log:
        source_item = db.query(models.Item).filter(models.Item.id == source_log.item_id).first()
        if source_item:
            return _populate_item_fields(source_item)

    return None

def get_items(db: Session, skip: int = 0, limit: int = 100, vault_id: int | None = None, include_children: bool = False):
    query = db.query(models.Item).options(
        selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
        selectinload(models.Item.tags),
    )
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
        if not include_children:
            parent_alias = aliased(models.Item)
            query = query.outerjoin(parent_alias, models.Item.parent_id == parent_alias.id)
            query = query.filter(
                models.Item.parent_id.is_(None) |
                ~(parent_alias.vault_id == vault_id)
            )
    else:
        if not include_children:
            query = query.filter(models.Item.parent_id.is_(None))
    items = query.offset(skip).limit(limit).all()
    leaves_map = _bulk_load_subtrees(db, items)
    for item in items:
        _populate_item_fields(item, preloaded_leaves=leaves_map.get(item.id))
    return items


def item_summary(item: models.Item, *, content_types=None, content_tags=None, matches_query: bool = False) -> dict:
    """Build the compact row used by the library's root list.

    This deliberately does not call ``_populate_item_fields``. A root-list
    request must not hydrate every child row and manifest just to display a
    collapsed collection.
    """
    attributes = getattr(item, "attributes", {}) or {}
    analysis = attributes.get("analysis") or {}
    if not isinstance(analysis, dict):
        analysis = {}
    video_metadata = attributes.get("video_metadata") or {}
    if not isinstance(video_metadata, dict):
        video_metadata = {}
    audio_metadata = _audio_metadata(item, attributes)
    title = audio_metadata.get("title") if item.type in {"audio", "track", "sample"} else attributes.get("title")
    title = title or getattr(item, "title", None) or os.path.basename(
        str(getattr(item, "absolute_path", "")).rstrip("/\\")
    )
    duration_seconds = analysis.get("duration_seconds")
    if duration_seconds is None:
        duration_seconds = video_metadata.get("duration_seconds")
    item_key = getattr(item, "key", None)
    item_bpm = getattr(item, "bpm", None)
    item_is_loop = getattr(item, "is_loop", None)
    return {
        "absolute_path": item.absolute_path,
        "size_bytes": item.size_bytes,
        "mime_type": item.mime_type,
        "vault_id": item.vault_id,
        "parent_id": item.parent_id,
        "storage_mode": item.storage_mode,
        "availability": "ready" if getattr(item, "availability", None) in {"ready", "available", None} else item.availability,
        "attributes": attributes,
        "id": item.id,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "type": item.type,
        "title": title,
        "author": audio_metadata.get("author"),
        "album": audio_metadata.get("album"),
        "album_artist": audio_metadata.get("album_artist"),
        "release_year": audio_metadata.get("release_year"),
        "genre": audio_metadata.get("genre"),
        "track_number": audio_metadata.get("track_number"),
        "disc_number": audio_metadata.get("disc_number"),
        "comment": audio_metadata.get("comment"),
        "duration_seconds": duration_seconds,
        "key": item_key if item_key is not None else analysis.get("key"),
        "bpm": item_bpm if item_bpm is not None else analysis.get("bpm"),
        "is_loop": item_is_loop if item_is_loop is not None else analysis.get("is_loop"),
        "favourite": bool(attributes.get("favourite", False)),
        "source_kind": getattr(item, "source_kind", None),
        "source_path": _source_path(item, attributes),
        "project_kind": getattr(item, "project_kind", None),
        "editor_engine": getattr(item, "editor_engine", None),
        "content_count": getattr(item, "content_count", None),
        "content_types": sorted(set(content_types or [])),
        "content_tags": sorted(set(content_tags or []), key=str.casefold),
        "tags": [tag.name for tag in getattr(item, "tags", [])],
        "matches_query": bool(matches_query),
    }


def get_item_summaries(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    vault_id: int | None = None,
    vault_preview: str | None = None,
    query_text: str | None = None,
) -> list[dict]:
    """Return root rows without hydrating collection contents.

    Uses FTS5 + recursive CTE root resolution when `query_text` is provided.
    """
    query = (
        db.query(models.Item)
        .options(
            selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
            selectinload(models.Item.tags),
        )
        .filter(models.Item.parent_id.is_(None))
    )
    if vault_id is not None:
        query = query.filter(models.Item.vault_id == vault_id)
    elif vault_preview is not None:
        query = query.join(models.Vault, models.Vault.id == models.Item.vault_id).filter(
            models.Vault.preview == vault_preview
        )
    needle = (query_text or "").strip()
    if needle:
        from . import catalog as catalog_service

        _matched_item_ids, matched_root_ids = catalog_service.search_fts_item_ids(
            db,
            needle,
            vault_id=vault_id,
            vault_preview=vault_preview,
            limit=5000,
        )
        if not matched_root_ids:
            return []
        query = query.filter(models.Item.id.in_(matched_root_ids))
    roots = query.order_by(models.Item.updated_at.desc(), models.Item.id.desc()).offset(skip).limit(limit).all()
    if not roots:
        return []

    root_ids = [item.id for item in roots]
    folder_to_root: dict[int, int] = {item_id: item_id for item_id in root_ids}
    frontier = list(root_ids)
    while frontier:
        sub_rows = (
            db.query(models.Item.id, models.Item.parent_id)
            .filter(
                models.Item.parent_id.in_(frontier),
                models.Item.type.in_(["folder", "collection"]),
            )
            .all()
        )
        next_frontier = []
        for sub_id, p_id in sub_rows:
            if sub_id not in folder_to_root and p_id in folder_to_root:
                folder_to_root[sub_id] = folder_to_root[p_id]
                next_frontier.append(sub_id)
        frontier = next_frontier

    all_folder_ids = list(folder_to_root.keys())
    child_types: dict[int, set[str]] = {item_id: set() for item_id in root_ids}
    for parent_id, child_type in (
        db.query(models.Item.parent_id, models.Item.type)
        .filter(
            models.Item.parent_id.in_(all_folder_ids),
            ~models.Item.type.in_(["folder", "collection"]),
        )
        .distinct()
        .all()
    ):
        root_id = folder_to_root.get(parent_id)
        if root_id is not None and child_type:
            child_types[root_id].add(child_type)

    child_tags: dict[int, set[str]] = {item_id: set() for item_id in root_ids}
    for parent_id, tag_name in (
        db.query(models.Item.parent_id, models.Tag.name)
        .join(models.item_tags, models.item_tags.c.item_id == models.Item.id)
        .join(models.Tag, models.Tag.id == models.item_tags.c.tag_id)
        .filter(models.Item.parent_id.in_(all_folder_ids))
        .distinct()
        .all()
    ):
        root_id = folder_to_root.get(parent_id)
        if root_id is not None and tag_name:
            child_tags[root_id].add(tag_name)

    return [
        item_summary(
            item,
            content_types=child_types[item.id],
            content_tags=child_tags[item.id],
            matches_query=bool(needle),
        )
        for item in roots
    ]


def get_collection_contents_page(
    db: Session,
    item_id: int,
    offset: int = 0,
    limit: int = 250,
    query: str | None = None,
) -> dict | None:
    """Build one collection page, paging canonical child rows in SQL without polymorphic N+1."""
    collection = (
        db.query(models.FolderItem)
        .filter(models.FolderItem.id == item_id)
        .first()
    )
    if not collection:
        return None
    safe_offset = max(0, int(offset))
    safe_limit = None if int(limit) <= 0 else min(int(limit), 100000)
    needle = (query or "").strip()

    folder_ids = [item_id]
    current_level = [
        row[0] for row in
        db.query(models.Item.id)
        .filter(models.Item.parent_id == item_id, models.Item.type.in_(["folder", "collection"]))
        .all()
    ]
    while current_level:
        folder_ids.extend(current_level)
        current_level = [
            row[0] for row in
            db.query(models.Item.id)
            .filter(models.Item.parent_id.in_(current_level), models.Item.type.in_(["folder", "collection"]))
            .all()
        ]

    child_count = (
        db.query(func.count(models.Item.id))
        .filter(models.Item.parent_id.in_(folder_ids))
        .scalar()
        or 0
    )
    non_folder_child_count = (
        db.query(func.count(models.Item.id))
        .filter(
            models.Item.parent_id.in_(folder_ids),
            ~models.Item.type.in_(["folder", "collection"]),
        )
        .scalar()
        or 0
    )

    manifest_contents = _manifest_contents(collection) if (child_count == 0 or getattr(collection, "manifest_json", None) not in (None, "", "[]")) else []
    manifest_by_path = {
        _content_path_key(entry.get("relative_path", "")): entry
        for entry in manifest_contents
        if entry.get("relative_path")
    } if manifest_contents else {}

    # A missing or partially backfilled child index is a legacy condition.
    # Preserve those manifest-only rows with the complete merge path; normal
    # imported collections use the SQL-paged canonical child path below.
    partial_index = bool(manifest_by_path) and non_folder_child_count < len(manifest_by_path)
    if child_count == 0 or partial_index:
        children = [] if child_count == 0 else (
            db.query(models.Item)
            .options(
                selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
                selectinload(models.Item.tags),
            )
            .filter(models.Item.parent_id.in_(folder_ids))
            .order_by(models.Item.absolute_path, models.Item.id)
            .all()
        )
        contents = _merge_collection_contents(collection, manifest_contents, children)
        folded_needle = needle.casefold()
        if folded_needle:
            contents = [
                content
                for content in contents
                if folded_needle in " ".join(
                    str(content.get(field) or "")
                    for field in ("title", "filename", "relative_path", "tags")
                ).casefold()
            ]
        page = contents[safe_offset:] if safe_limit is None else contents[safe_offset:safe_offset + safe_limit]
        total = len(contents)
    else:
        child_query = db.query(models.Item).filter(models.Item.parent_id.in_(folder_ids))
        if needle:
            tag_alias = aliased(models.Tag)
            pattern = f"%{needle}%"
            child_query = (
                child_query
                .outerjoin(models.item_tags, models.item_tags.c.item_id == models.Item.id)
                .outerjoin(tag_alias, tag_alias.id == models.item_tags.c.tag_id)
                .filter(or_(
                    models.Item.absolute_path.ilike(pattern),
                    models.Item.metadata_json.ilike(pattern),
                    tag_alias.name.ilike(pattern),
                ))
                .distinct()
            )
        total = child_query.count()
        query_part = (
            child_query
            .options(
                selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
                selectinload(models.Item.tags),
            )
            .order_by(models.Item.absolute_path, models.Item.id)
            .offset(safe_offset)
        )
        if safe_limit is not None:
            query_part = query_part.limit(safe_limit)
        children = query_part.all()

        index_by_id: dict[int, int] = {}
        if not manifest_by_path and children and needle:
            ranked_children = (
                db.query(
                    models.Item.id.label("child_id"),
                    (func.row_number().over(order_by=(models.Item.absolute_path, models.Item.id)) - 1).label("content_index"),
                )
                .filter(models.Item.parent_id.in_(folder_ids))
                .subquery()
            )
            index_by_id = {
                child_id: int(content_index)
                for child_id, content_index in (
                    db.query(ranked_children.c.child_id, ranked_children.c.content_index)
                    .filter(ranked_children.c.child_id.in_([child.id for child in children]))
                    .all()
                )
            }
        page = []
        for position, child in enumerate(children):
            existing = None
            if manifest_by_path:
                relative_path = _child_relative_path(collection, child)
                existing = manifest_by_path.get(_content_path_key(relative_path))
            page.append(_child_content(
                collection,
                child,
                existing,
                fallback_index=index_by_id.get(child.id, safe_offset + position),
            ))
    return {
        "contents": page,
        "offset": safe_offset,
        "limit": safe_limit if safe_limit is not None else total,
        "total": total,
        "has_more": False if safe_limit is None else (safe_offset + len(page) < total),
    }

def create_item(db: Session, item: schemas.ItemCreate, *, commit: bool = True, flush: bool = True):
    if item.vault_id is None:
        raise ValueError("GAIA items require an owning vault")
    # Library rows point only to physical vault-owned paths.  Import services
    # copy external sources before registering them, keeping ownership and
    # filesystem location aligned.
    from . import vaults

    vault = vaults.get_vault(db, item.vault_id)
    if not vault:
        raise ValueError("Vault not found")
    storage_mode = getattr(item, "storage_mode", "managed")
    if storage_mode == "managed":
        try:
            Path(item.absolute_path).resolve().relative_to(vaults.vault_store(vault).resolve())
        except ValueError as exc:
            raise ValueError("Managed item path must be inside its owning vault") from exc
    elif storage_mode != "external_reference":
        raise ValueError("Unsupported item storage mode")

    type_map = {
        "item": models.Item,
        "midi": models.MidiItem,
        "sequence": models.SequenceItem,
        "audio": models.AudioItem,
        "track": models.TrackItem,
        "sample": models.SampleItem,
        "video": models.VideoItem,
        "folder": models.FolderItem,
        "collection": models.CollectionItem,
        "multitrack": models.MultitrackItem,
        "zoom_h4": models.ZoomH4Item,
        "project": models.ProjectItem,
    }
    
    model_class = type_map.get(item.type, models.Item)

    db_item = model_class(
        absolute_path=item.absolute_path,
        vault_id=item.vault_id,
        parent_id=getattr(item, "parent_id", None),
        storage_mode=storage_mode,
        availability=getattr(item, "availability", "ready"),
        file_hash=item.file_hash,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type or ("audio/multitrack" if item.type in {"multitrack", "zoom_h4"} else None)
    )
    attributes = dict(getattr(item, "attributes", {}) or {})
    if item.type in {"audio", "track", "sample"}:
        embedded_metadata = dict(attributes.get("audio_metadata") or {})
        for field in TRACK_METADATA_FIELDS:
            value = getattr(item, field, None)
            if value is not None and (not isinstance(value, str) or value.strip()):
                embedded_metadata[field] = value.strip() if isinstance(value, str) else value
        if embedded_metadata:
            attributes["audio_metadata"] = embedded_metadata
    db_item.metadata_json = json.dumps(attributes)
    
    if hasattr(item, "key") and hasattr(model_class, "key"):
        db_item.key = item.key
    if hasattr(item, "bpm") and hasattr(model_class, "bpm"):
        db_item.bpm = item.bpm
    if hasattr(item, "is_loop") and hasattr(model_class, "is_loop"):
        db_item.is_loop = bool(item.is_loop)

    if issubclass(model_class, models.FolderItem):
        db_item.title = getattr(item, "title", None)
        db_item.source_kind = getattr(item, "source_kind", "folder")
        db_item.source_path = getattr(item, "source_path", None)
        contents_val = getattr(item, "contents", [])
        contents_list = [content.model_dump() if hasattr(content, "model_dump") else content.dict() if hasattr(content, "dict") else content for content in contents_val]
        db_item.manifest_json = json.dumps(contents_list)
        db_item.content_count = len(contents_list)
        db_item.warnings_json = json.dumps(list(getattr(item, "warnings", []) or []))

    if issubclass(model_class, models.MultitrackItem):
        stems_val = getattr(item, "stems", [])
        if isinstance(stems_val, list):
            stems_list = [s.model_dump() if hasattr(s, "model_dump") else s.dict() if hasattr(s, "dict") else s for s in stems_val]
        else:
            stems_list = []
        db_item.stems_json = json.dumps(stems_list)
        db_item.is_valid_length = getattr(item, "is_valid_length", True)
        db_item.length_variance = getattr(item, "length_variance", 0.0)

    if issubclass(model_class, models.ProjectItem):
        db_item.project_kind = getattr(item, "project_kind", None) or "audio"
        db_item.editor_engine = getattr(item, "editor_engine", None) or "sin"

    db.add(db_item)
    if commit:
        db.commit()
        db.refresh(db_item)
    elif flush:
        db.flush()
    return _populate_item_fields(db_item)

def owning_project_context_ids(db: Session, item: models.Item) -> set[int]:
    """Return project ancestors that own ``item`` and its generated files."""
    project_ids: set[int] = set()
    parent_id = item.parent_id
    seen_ids: set[int] = set()
    while parent_id is not None and parent_id not in seen_ids:
        seen_ids.add(parent_id)
        parent = db.query(models.Item).filter(models.Item.id == parent_id).first()
        if not parent:
            break
        if isinstance(parent, models.ProjectItem):
            project_ids.add(parent.id)
        parent_id = parent.parent_id
    return project_ids


def _remove_child_from_parent_manifest(db: Session, child: models.Item) -> None:
    """Keep a folder's legacy snapshot from reviving a deleted child row."""
    if child.parent_id is None:
        return
    parent = (
        db.query(models.FolderItem)
        .filter(models.FolderItem.id == child.parent_id)
        .first()
    )
    if not parent:
        return

    contents = _manifest_contents(parent)
    if not contents:
        return
    try:
        child_path = _content_path_key(
            Path(child.absolute_path).relative_to(Path(parent.absolute_path)).as_posix()
        )
    except ValueError:
        child_path = _content_path_key(os.path.basename(child.absolute_path))

    def is_deleted_child(entry: dict) -> bool:
        try:
            if int(entry.get("child_id")) == child.id:
                return True
        except (TypeError, ValueError):
            pass
        return _content_path_key(entry.get("relative_path", "")) == child_path

    remaining = [entry for entry in contents if not is_deleted_child(entry)]
    if len(remaining) != len(contents):
        # Content indexes are stable route identifiers, so do not renumber the
        # remaining manifest entries after removing one of them.
        parent.manifest_json = json.dumps(remaining)
        parent.content_count = len(remaining)


def externally_referenced_descendants_for_item(db: Session, db_item: models.Item) -> set[int]:
    """Return descendant IDs of ``db_item`` that are referenced by an external project."""
    subtree_ids = {db_item.id}
    frontier = [db_item.id]
    while frontier:
        child_ids = [
            row[0]
            for row in db.query(models.Item.id)
            .filter(models.Item.parent_id.in_(frontier))
            .all()
            if row[0] not in subtree_ids
        ]
        subtree_ids.update(child_ids)
        frontier = child_ids

    descendant_ids = subtree_ids - {db_item.id}
    if not descendant_ids:
        return set()
    owner_context_ids = owning_project_context_ids(db, db_item)
    return {
        row[0]
        for row in db.query(models.ItemReference.to_item_id)
        .filter(
            models.ItemReference.to_item_id.in_(descendant_ids),
            ~models.ItemReference.context_id.in_(subtree_ids | owner_context_ids),
        )
        .all()
    } | {
        row[0]
        for row in db.query(models.ItemReference.from_item_id)
        .filter(
            models.ItemReference.from_item_id.in_(descendant_ids),
            ~models.ItemReference.context_id.in_(subtree_ids | owner_context_ids),
        )
        .all()
    }


def delete_item(db: Session, item_id: int, *, commit: bool = True):
    db_item = get_item(db, item_id=item_id)
    if not db_item:
        return set()

    subtree_ids = {db_item.id}
    frontier = [db_item.id]
    while frontier:
        child_ids = [
            row[0]
            for row in db.query(models.Item.id)
            .filter(models.Item.parent_id.in_(frontier))
            .all()
            if row[0] not in subtree_ids
        ]
        subtree_ids.update(child_ids)
        frontier = child_ids

    owner_context_ids = owning_project_context_ids(db, db_item)

    # Reject deletion only if db_item itself is directly referenced by an external project
    item_external_references = (
        db.query(models.ItemReference)
        .filter(
            (models.ItemReference.from_item_id == db_item.id)
            | (models.ItemReference.to_item_id == db_item.id)
        )
        .filter(~models.ItemReference.context_id.in_({db_item.id} | owner_context_ids))
        .count()
    )
    if item_external_references:
        raise ValueError("Item is referenced by a project; remove those references before deleting it")

    # Descendants that are referenced outside this subtree/owning project must be preserved,
    # rather than failing container/folder deletion or deleting active external project references.
    descendant_ids = subtree_ids - {db_item.id}
    if descendant_ids:
        externally_referenced_descendants = externally_referenced_descendants_for_item(db, db_item)
        if externally_referenced_descendants:
            preserved_ids = set(externally_referenced_descendants)
            frontier = list(externally_referenced_descendants)
            while frontier:
                child_ids = [
                    row[0]
                    for row in db.query(models.Item.id)
                    .filter(models.Item.parent_id.in_(frontier))
                    .all()
                    if row[0] not in preserved_ids
                ]
                preserved_ids.update(child_ids)
                frontier = child_ids

            preserved_items = db.query(models.Item).filter(
                models.Item.id.in_(externally_referenced_descendants),
            ).all()
            parent_item = get_item(db, db_item.parent_id) if db_item.parent_id else None
            for preserved_item in preserved_items:
                preserved_item.parent_id = db_item.parent_id
                preserved_item.parent = parent_item
            if "children" in db_item.__dict__:
                db_item.children = [c for c in db_item.children if c.id not in preserved_ids]
            db.flush()

            subtree_ids -= preserved_ids

    db.query(models.VaultMirror).filter(
        models.VaultMirror.root_item_id.in_(subtree_ids)
    ).update({models.VaultMirror.root_item_id: None}, synchronize_session=False)

    _remove_child_from_parent_manifest(db, db_item)
    # Project-owned generated files may be linked in their owning project's
    # context. Remove those links with the file, while retaining the guard
    # against deleting externally referenced source assets.
    reference_filter = models.ItemReference.context_id.in_(subtree_ids)
    if owner_context_ids:
        reference_filter |= (
            models.ItemReference.context_id.in_(owner_context_ids)
            & (
                models.ItemReference.from_item_id.in_(subtree_ids)
                | models.ItemReference.to_item_id.in_(subtree_ids)
            )
        )
    db.query(models.ItemReference).filter(reference_filter).delete(synchronize_session=False)
    db.query(models.VaultImportLog).filter(
        models.VaultImportLog.item_id.in_(subtree_ids)
    ).update({models.VaultImportLog.item_id: None}, synchronize_session=False)

    remaining_descendants = subtree_ids - {db_item.id}
    if remaining_descendants:
        for child_id in remaining_descendants:
            child_item = get_item(db, child_id)
            if child_item:
                db.delete(child_item)

    db.delete(db_item)
    try:
        if commit:
            db.commit()
        else:
            db.flush()
    except Exception:
        db.rollback()
        raise
    return subtree_ids

def add_tag_to_item(db: Session, item_id: int, tag_id: int):
    db_item = get_item(db, item_id=item_id)
    db_tag = get_tag(db, tag_id=tag_id)
    if db_item and db_tag and db_tag not in db_item.tags:
        db_item.tags.append(db_tag)
        db.commit()
        db.refresh(db_item)
    return db_item


def set_item_tags(db: Session, item_id: int, names: list[str], *, commit: bool = True):
    db_item = get_item(db, item_id)
    if not db_item:
        return None
    clean_names = []
    seen_names = set()
    for raw_name in names:
        name = raw_name.strip() if raw_name else ""
        normalized = name.casefold()
        if name and normalized not in seen_names:
            seen_names.add(normalized)
            clean_names.append(name)
    existing = {
        tag.name.casefold(): tag
        for tag in db.query(models.Tag)
        .filter(func.lower(models.Tag.name).in_([name.casefold() for name in clean_names]))
        .all()
    }
    tags = []
    for name in clean_names:
        tag = existing.get(name.casefold())
        if not tag:
            tag = models.Tag(name=name)
            db.add(tag)
            existing[name.casefold()] = tag
        tags.append(tag)
    db_item.tags = tags
    if commit:
        db.commit()
        db.refresh(db_item)
    else:
        db.flush()
    return _populate_item_fields(db_item)


def set_items_tags(
    db: Session,
    assignments: list[tuple[models.Item, list[str]]],
    *,
    flush: bool = True,
) -> None:
    """Assign tags to many items with one lookup and one optional flush."""
    names_by_key: dict[str, str] = {}
    cleaned_assignments: list[tuple[models.Item, list[str]]] = []
    for item, raw_names in assignments:
        item_names: list[str] = []
        seen: set[str] = set()
        for raw_name in raw_names:
            name = raw_name.strip() if raw_name else ""
            key = name.casefold()
            if name and key not in seen:
                seen.add(key)
                names_by_key.setdefault(key, name)
                item_names.append(key)
        cleaned_assignments.append((item, item_names))

    existing: dict[str, models.Tag] = {}
    name_keys = list(names_by_key)
    for offset in range(0, len(name_keys), 500):
        existing.update({
            tag.name.casefold(): tag
            for tag in db.query(models.Tag)
            .filter(func.lower(models.Tag.name).in_(name_keys[offset:offset + 500]))
            .all()
        })
    for key, name in names_by_key.items():
        if key not in existing:
            existing[key] = models.Tag(name=name)
            db.add(existing[key])
    for item, item_names in cleaned_assignments:
        item.tags = [existing[key] for key in item_names]
    if flush:
        db.flush()


def save_collection_contents(
    db: Session,
    item: models.FolderItem,
    contents: list[dict],
    *,
    commit: bool = True,
    flush: bool = True,
):
    item.manifest_json = json.dumps(contents)
    item.content_count = len(contents)
    if commit:
        db.commit()
        db.refresh(item)
    elif flush:
        db.flush()
    return _populate_item_fields(item)


CONTAINER_RECLASSIFY_TYPES = frozenset({"folder", "collection", "multitrack", "zoom_h4"})
CONTAINER_TARGET_TYPES = frozenset({"folder", "sample_pack", "multitrack", "zoom_h4"})
_H4_ROLE_PATTERN = re.compile(r"(?:^|[_\s-])tr(?P<role>lr|mic|\d{1,2})(?=$|[_\s.-])", re.I)


def effective_item_type(item: models.Item | None) -> str:
    """Return the user-facing logical type for an item, distinguishing sample packs from plain folders."""
    if not item:
        return "item"
    raw_type = getattr(item, "type", None) or "item"
    if raw_type in {"folder", "collection"}:
        attrs = getattr(item, "attributes", None) or {}
        if attrs.get("profile_id") == "sample_pack":
            return "sample_pack"
        return "folder"
    return raw_type


def reclassify_audio(db: Session, item_id: int, new_type: str):
    """Move an item among the concrete audio, sample, and track types."""
    db_item = get_item(db, item_id)
    audio_types = {"audio", "sample", "track"}
    if not db_item or db_item.type not in audio_types or new_type not in audio_types:
        return None
    if db_item.type == new_type:
        return db_item

    attrs = dict(getattr(db_item, "attributes", None) or {})
    analysis = attrs.get("analysis") if isinstance(attrs.get("analysis"), dict) else {}
    preserved_bpm = getattr(db_item, "bpm", None)
    if preserved_bpm is None:
        preserved_bpm = analysis.get("bpm")
    preserved_key = getattr(db_item, "key", None)
    if not preserved_key:
        preserved_key = analysis.get("key")
    preserved_is_loop = bool(getattr(db_item, "is_loop", False) or analysis.get("is_loop", False))

    db.expunge(db_item)
    db.execute(delete(models.TrackItem.__table__).where(models.TrackItem.__table__.c.id == item_id))
    if new_type != "sample":
        db.execute(delete(models.SampleItem.__table__).where(models.SampleItem.__table__.c.id == item_id))
    if new_type == "sample":
        db.execute(
            insert(models.SampleItem.__table__)
            .prefix_with("OR IGNORE")
            .values(
                id=item_id,
                key=preserved_key,
                bpm=preserved_bpm,
                is_loop=preserved_is_loop,
            )
        )
    elif new_type == "track":
        db.execute(insert(models.TrackItem.__table__).prefix_with("OR IGNORE").values(id=item_id))
    db.execute(
        update(models.Item.__table__)
        .where(models.Item.__table__.c.id == item_id)
        .values(type=new_type, updated_at=datetime.datetime.utcnow())
    )
    db.commit()
    return get_item(db, item_id)


def _sync_zoom_h4_child_roles(db: Session, direct_audio_children: list[models.Item], *, assign: bool) -> None:
    """Assign or clear Zoom H4 mixdown/source_channel role metadata on direct audio children."""
    now = datetime.datetime.utcnow()
    if not assign:
        for child in direct_audio_children:
            attrs = dict(getattr(child, "attributes", None) or {})
            if "profile_role" in attrs or "profile_role_reason" in attrs:
                attrs.pop("profile_role", None)
                attrs.pop("profile_role_reason", None)
                db.execute(
                    update(models.Item.__table__)
                    .where(models.Item.__table__.c.id == child.id)
                    .values(metadata_json=json.dumps(attrs), updated_at=now)
                )
        return

    role_pairs: list[tuple[models.Item, str | None]] = []
    for child in direct_audio_children:
        stem = Path(child.absolute_path).stem.casefold()
        match = _H4_ROLE_PATTERN.search(stem)
        role_pairs.append((child, match.group("role") if match else None))

    has_lr = any(role == "lr" for _, role in role_pairs)
    unnamed_audio = [child for child, role in role_pairs if role is None]
    inferred_mixdown_id = unnamed_audio[0].id if (not has_lr and len(role_pairs) > 1 and len(unnamed_audio) == 1) else None

    for child, role in role_pairs:
        attrs = dict(getattr(child, "attributes", None) or {})
        if role == "lr":
            attrs["profile_role"] = "mixdown"
            attrs["profile_role_reason"] = "Zoom TrLR mixdown"
        elif role:
            attrs["profile_role"] = "source_channel"
            attrs["profile_role_reason"] = f"Zoom Tr{role} source channel"
        elif child.id == inferred_mixdown_id:
            attrs["profile_role"] = "mixdown"
            attrs["profile_role_reason"] = "Only renamed audio file; inferred Zoom mixdown because TrLR is absent"
        else:
            attrs.pop("profile_role", None)
            attrs.pop("profile_role_reason", None)
        db.execute(
            update(models.Item.__table__)
            .where(models.Item.__table__.c.id == child.id)
            .values(metadata_json=json.dumps(attrs), updated_at=now)
        )


def _promote_subtree_audio_to_samples(db: Session, root_folder_id: int) -> set[int]:
    """Upgrade unclassified 'audio' descendants under a Sample pack to concrete 'sample' items."""
    folder_ids = [root_folder_id]
    frontier = [root_folder_id]
    while frontier:
        sub_ids = [
            row[0]
            for row in db.query(models.Item.id)
            .filter(
                models.Item.parent_id.in_(frontier),
                models.Item.type.in_(["folder", "collection"]),
            )
            .all()
            if row[0] not in folder_ids
        ]
        folder_ids.extend(sub_ids)
        frontier = sub_ids

    audio_rows = (
        db.query(models.Item.id, models.Item.metadata_json)
        .filter(
            models.Item.parent_id.in_(folder_ids),
            models.Item.type == "audio",
        )
        .all()
    )
    if not audio_rows:
        return set()

    promoted_ids: set[int] = set()
    now = datetime.datetime.utcnow()
    for child_id, meta_json in audio_rows:
        promoted_ids.add(int(child_id))
        analysis = {}
        if meta_json and meta_json != "{}":
            try:
                parsed = json.loads(meta_json)
                if isinstance(parsed, dict) and isinstance(parsed.get("analysis"), dict):
                    analysis = parsed["analysis"]
            except (TypeError, ValueError):
                pass
        db.execute(
            insert(models.SampleItem.__table__)
            .prefix_with("OR IGNORE")
            .values(
                id=int(child_id),
                key=analysis.get("key"),
                bpm=analysis.get("bpm"),
                is_loop=bool(analysis.get("is_loop", False)),
            )
        )

    id_list = sorted(promoted_ids)
    for offset in range(0, len(id_list), 500):
        batch = id_list[offset : offset + 500]
        db.execute(
            update(models.Item.__table__)
            .where(models.Item.__table__.c.id.in_(batch))
            .values(type="sample", updated_at=now)
        )
    return promoted_ids


def reclassify_container(db: Session, item_id: int, target_type: str) -> models.Item:
    """Switch a library container among Folder, Sample pack, Multitrack, and Zoom H4."""
    from . import multitrack_analyzer, project_service

    db_item = get_item(db, item_id)
    if not db_item:
        raise ValueError("Item not found")
    if isinstance(db_item, models.ProjectItem) or db_item.type == "project":
        raise ValueError("Projects cannot be converted to another container type")
    if db_item.type not in CONTAINER_RECLASSIFY_TYPES:
        raise ValueError("This asset cannot be changed to the selected container type")
    if target_type not in CONTAINER_TARGET_TYPES:
        raise ValueError(f"Unsupported container type: {target_type}")
    if project_service._find_owning_project(db, db_item) is not None:
        raise ValueError("Folders inside a project cannot be changed to another container type")

    current_effective = effective_item_type(db_item)
    previous_type = db_item.type
    target_db_type = "folder" if target_type in {"folder", "sample_pack"} else target_type
    if current_effective == target_type and previous_type == target_db_type:
        return db_item

    attrs = dict(getattr(db_item, "attributes", None) or {})
    import_meta = dict(attrs["import"]) if isinstance(attrs.get("import"), dict) else None
    source_kind = getattr(db_item, "source_kind", "folder") or "folder"
    abs_path = db_item.absolute_path
    existing_bpm = getattr(db_item, "bpm", None)
    existing_key = getattr(db_item, "key", None)
    existing_warnings = list(getattr(db_item, "warnings", None) or [])
    cleaned_warnings = [
        w for w in existing_warnings
        if not str(w).startswith("Stem lengths differ by ")
    ]

    direct_audio_children = (
        db.query(models.Item)
        .filter(
            models.Item.parent_id == item_id,
            models.Item.type.in_(["audio", "track", "sample"]),
        )
        .order_by(models.Item.absolute_path, models.Item.id)
        .all()
    )

    manifest_entries = _manifest_contents(db_item) if isinstance(db_item, models.FolderItem) else []
    now = datetime.datetime.utcnow()

    # Prepare target attributes & subtype rows
    multitrack_values: dict | None = None
    if target_type == "folder":
        attrs["is_folder"] = True
        attrs["profile_id"] = "folder"
        attrs["profile_label"] = "Folder"
        attrs.pop("profile_bundle_id", None)
        if import_meta is not None:
            import_meta["immutable"] = False
            attrs["import"] = import_meta
        new_mime = "application/zip" if source_kind == "zip" else "inode/directory"
    elif target_type == "sample_pack":
        attrs.pop("is_folder", None)
        attrs["profile_id"] = "sample_pack"
        attrs["profile_bundle_id"] = "sample-packs"
        attrs["profile_label"] = "Sample pack"
        if import_meta is not None:
            import_meta["immutable"] = True
            attrs["import"] = import_meta
        else:
            attrs["import"] = {"immutable": True}
        new_mime = "application/zip" if source_kind == "zip" else "inode/directory"
    else:
        # multitrack or zoom_h4
        attrs.pop("is_folder", None)
        if target_type == "zoom_h4":
            attrs["profile_id"] = "zoom_h4"
            attrs["profile_bundle_id"] = "zoom-recorders"
            attrs["profile_label"] = "Zoom H4"
        else:
            attrs.pop("profile_id", None)
            attrs.pop("profile_bundle_id", None)
            attrs.pop("profile_label", None)
        if import_meta is not None:
            import_meta["immutable"] = False
            attrs["import"] = import_meta
        new_mime = "audio/multitrack"

        analysis: dict = {}
        if abs_path and os.path.isdir(abs_path):
            try:
                analysis = multitrack_analyzer.analyze_multitrack_folder(
                    abs_path,
                    recursive=False,
                    detect_key_from_audio=False,
                )
            except Exception:
                analysis = {}
        stems = list(analysis.get("stems") or [])
        if not stems and direct_audio_children:
            child_paths = [c.absolute_path for c in direct_audio_children if c.absolute_path and os.path.isfile(c.absolute_path)]
            if child_paths:
                try:
                    analysis = multitrack_analyzer.analyze_multitrack_files(
                        abs_path or str(Path(child_paths[0]).parent),
                        child_paths,
                        detect_key_from_audio=False,
                    )
                    stems = list(analysis.get("stems") or [])
                except Exception:
                    stems = []

        for stem in stems:
            stem_path = stem.get("absolute_path")
            if stem_path:
                try:
                    stem["absolute_path"] = str(Path(stem_path).resolve())
                except OSError:
                    pass

        is_valid_length = bool(analysis.get("is_valid_length", False)) if stems else True
        length_variance = float(analysis.get("length_variance") or 0.0) if stems else 0.0
        if stems and not is_valid_length:
            cleaned_warnings.append(f"Stem lengths differ by {length_variance:.4f} seconds.")

        detected_bpm = existing_bpm if existing_bpm is not None else analysis.get("bpm")
        detected_key = existing_key or analysis.get("key")
        multitrack_values = {
            "stems_json": json.dumps(stems),
            "key": detected_key,
            "bpm": detected_bpm,
            "is_valid_length": is_valid_length,
            "length_variance": length_variance,
        }

    # Expunge before core SQL polymorphic table changes
    db.expunge(db_item)
    for child in direct_audio_children:
        if child in db:
            db.expunge(child)

    if target_type in {"folder", "sample_pack"}:
        db.execute(delete(models.MultitrackItem.__table__).where(models.MultitrackItem.__table__.c.id == item_id))
        if previous_type == "zoom_h4":
            _sync_zoom_h4_child_roles(db, direct_audio_children, assign=False)
    else:
        existing_mt = db.execute(
            models.MultitrackItem.__table__.select().where(models.MultitrackItem.__table__.c.id == item_id)
        ).first()
        if existing_mt:
            db.execute(
                update(models.MultitrackItem.__table__)
                .where(models.MultitrackItem.__table__.c.id == item_id)
                .values(**multitrack_values)
            )
        else:
            db.execute(
                insert(models.MultitrackItem.__table__).values(id=item_id, **multitrack_values)
            )
        if target_type == "zoom_h4":
            _sync_zoom_h4_child_roles(db, direct_audio_children, assign=True)
        elif previous_type == "zoom_h4":
            _sync_zoom_h4_child_roles(db, direct_audio_children, assign=False)

    if target_type == "sample_pack":
        promoted_ids = _promote_subtree_audio_to_samples(db, item_id)
        if promoted_ids and manifest_entries:
            for entry in manifest_entries:
                if entry.get("child_id") in promoted_ids:
                    entry["type"] = "sample"

    col_updates: dict = {"warnings_json": json.dumps(cleaned_warnings)}
    if manifest_entries:
        col_updates["manifest_json"] = json.dumps(manifest_entries)
    db.execute(
        update(models.FolderItem.__table__)
        .where(models.FolderItem.__table__.c.id == item_id)
        .values(**col_updates)
    )
    db.execute(
        update(models.Item.__table__)
        .where(models.Item.__table__.c.id == item_id)
        .values(
            type=target_db_type,
            mime_type=new_mime,
            metadata_json=json.dumps(attrs),
            updated_at=now,
        )
    )
    db.commit()
    return get_item(db, item_id)


def get_collection_by_source(db: Session, source_path: str, vault_id: int | None = None):
    query = db.query(models.FolderItem).filter(models.FolderItem.source_path == source_path)
    if vault_id is not None:
        query = query.filter(models.FolderItem.vault_id == vault_id)
    return (
        query.first()
    )

# Tags
def get_tag(db: Session, tag_id: int):
    return db.query(models.Tag).filter(models.Tag.id == tag_id).first()

def get_tag_by_name(db: Session, name: str):
    return db.query(models.Tag).filter(models.Tag.name == name).first()

def get_tags(db: Session, skip: int = 0, limit: int = 100):
    return db.query(models.Tag).offset(skip).limit(limit).all()

def create_tag(db: Session, tag: schemas.TagCreate):
    db_tag = models.Tag(name=tag.name)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag

def get_or_create_tag(db: Session, name: str):
    db_tag = get_tag_by_name(db, name=name)
    if db_tag:
        return db_tag
    db_tag = models.Tag(name=name)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag


def locate_item(db: Session, item_id: int) -> dict | None:
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    if not item:
        return None

    target = item
    visited = {target.id}
    while True:
        attrs = target.attributes if hasattr(target, "attributes") and isinstance(target.attributes, dict) else {}
        source_id = attrs.get("source_item_id")
        if source_id and isinstance(source_id, int) and source_id not in visited:
            candidate = db.query(models.Item).filter(models.Item.id == source_id).first()
            if candidate:
                target = candidate
                visited.add(target.id)
                continue
        ref = (
            db.query(models.ItemReference)
            .filter(
                models.ItemReference.to_item_id == target.id,
                models.ItemReference.from_item_id != models.ItemReference.context_id,
            )
            .first()
        )
        if ref and ref.from_item_id not in visited:
            candidate = db.query(models.Item).filter(models.Item.id == ref.from_item_id).first()
            if candidate:
                target = candidate
                visited.add(target.id)
                continue
        break

    vault = db.query(models.Vault).filter(models.Vault.id == target.vault_id).first()
    vault_name = vault.name if vault else ""

    ancestor_ids: list[int] = []
    curr = target.parent
    seen_parents = {target.id}
    while curr and curr.id not in seen_parents:
        seen_parents.add(curr.id)
        ancestor_ids.insert(0, curr.id)
        curr = curr.parent

    target_attrs = target.attributes if hasattr(target, "attributes") and isinstance(target.attributes, dict) else {}
    folder_path = target_attrs.get("folder")
    from pathlib import Path
    fname = Path(target.absolute_path).name if target.absolute_path else None
    title = getattr(target, "title", None) or fname

    return {
        "item_id": target.id,
        "vault_id": target.vault_id,
        "vault_name": vault_name,
        "ancestor_ids": ancestor_ids,
        "folder_path": folder_path,
        "title": title,
        "filename": fname,
        "type": target.type or "file",
    }


def get_playlists(db: Session) -> list[dict]:
    """Return all playlists with their item counts."""
    rows = (
        db.query(
            models.Playlist,
            func.count(models.PlaylistItem.id).label("item_count"),
        )
        .outerjoin(models.PlaylistItem, models.PlaylistItem.playlist_id == models.Playlist.id)
        .group_by(models.Playlist.id)
        .order_by(models.Playlist.name.asc())
        .all()
    )
    result = []
    for playlist, count in rows:
        result.append({
            "id": playlist.id,
            "name": playlist.name,
            "item_count": count,
            "created_at": playlist.created_at,
            "updated_at": playlist.updated_at,
        })
    return result


def get_playlist(db: Session, playlist_id: int) -> models.Playlist | None:
    return db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()


def get_playlist_by_name(db: Session, name: str) -> models.Playlist | None:
    return db.query(models.Playlist).filter(func.lower(models.Playlist.name) == name.strip().lower()).first()


def create_playlist(db: Session, name: str) -> models.Playlist:
    playlist = models.Playlist(name=name.strip())
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return playlist


def update_playlist(db: Session, playlist_id: int, name: str) -> models.Playlist | None:
    playlist = get_playlist(db, playlist_id)
    if not playlist:
        return None
    playlist.name = name.strip()
    db.commit()
    db.refresh(playlist)
    return playlist


def delete_playlist(db: Session, playlist_id: int) -> bool:
    playlist = get_playlist(db, playlist_id)
    if not playlist:
        return False
    db.delete(playlist)
    db.commit()
    return True


def add_playlist_items(db: Session, playlist_id: int, item_ids: list[int]) -> list[models.PlaylistItem]:
    playlist = get_playlist(db, playlist_id)
    if not playlist:
        raise ValueError("Playlist not found")

    existing_ids = {
        row[0]
        for row in db.query(models.PlaylistItem.item_id)
        .filter(models.PlaylistItem.playlist_id == playlist_id)
        .all()
    }

    max_pos = (
        db.query(func.max(models.PlaylistItem.position))
        .filter(models.PlaylistItem.playlist_id == playlist_id)
        .scalar()
    )
    next_pos = (max_pos + 1) if max_pos is not None else 0

    added = []
    valid_items = {
        item.id
        for item in db.query(models.Item.id).filter(models.Item.id.in_(item_ids)).all()
    }

    for item_id in item_ids:
        if item_id in valid_items and item_id not in existing_ids:
            entry = models.PlaylistItem(
                playlist_id=playlist_id,
                item_id=item_id,
                position=next_pos,
            )
            db.add(entry)
            existing_ids.add(item_id)
            added.append(entry)
            next_pos += 1

    if added:
        playlist.updated_at = datetime.datetime.utcnow()
        db.commit()

    return added


def remove_playlist_item(db: Session, playlist_id: int, item_id: int) -> bool:
    entry = (
        db.query(models.PlaylistItem)
        .filter(
            models.PlaylistItem.playlist_id == playlist_id,
            models.PlaylistItem.item_id == item_id,
        )
        .first()
    )
    if not entry:
        return False
    db.delete(entry)
    playlist = get_playlist(db, playlist_id)
    if playlist:
        playlist.updated_at = datetime.datetime.utcnow()
    db.commit()
    return True


def reorder_playlist_items(db: Session, playlist_id: int, item_ids: list[int]) -> bool:
    playlist = get_playlist(db, playlist_id)
    if not playlist:
        return False

    entries = (
        db.query(models.PlaylistItem)
        .filter(models.PlaylistItem.playlist_id == playlist_id)
        .all()
    )
    entry_map = {e.item_id: e for e in entries}

    for pos, item_id in enumerate(item_ids):
        if item_id in entry_map:
            entry_map[item_id].position = pos

    playlist.updated_at = datetime.datetime.utcnow()
    db.commit()
    return True


def get_playlist_items(db: Session, playlist_id: int) -> list[dict]:
    """Return serialized item summaries for all entries in the playlist in order."""
    entries = (
        db.query(models.PlaylistItem)
        .filter(models.PlaylistItem.playlist_id == playlist_id)
        .order_by(models.PlaylistItem.position.asc(), models.PlaylistItem.id.asc())
        .all()
    )
    if not entries:
        return []

    item_ids = [e.item_id for e in entries]
    db_items = (
        db.query(models.Item)
        .options(
            selectin_polymorphic(models.Item, ITEM_POLYMORPHIC_TYPES),
            selectinload(models.Item.tags),
        )
        .filter(models.Item.id.in_(item_ids))
        .all()
    )
    items_by_id = {item.id: item for item in db_items}

    result = []
    for entry in entries:
        item = items_by_id.get(entry.item_id)
        if not item:
            continue
        summary = item_summary(item)
        summary["position"] = entry.position
        result.append(summary)

    return result


