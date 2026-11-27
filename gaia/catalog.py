"""Zero-ORM SQLite catalog engine: columnar snapshots, incremental deltas, FTS5 search, and SSE push.

This module powers instant (<1ms) client-side browsing in GAIA Manager and SIN Editor
while keeping SQLite as the authoritative local source of truth.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
import gzip
import json
import os
from pathlib import Path
import re
import threading
from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import Session

from . import database, paths, type_registry

SNAPSHOT_COLUMNS = (
    "id",
    "vault_id",
    "parent_id",
    "type",
    "title",
    "absolute_path",
    "size_bytes",
    "mime_type",
    "storage_mode",
    "availability",
    "updated_at",
    "bpm",
    "key",
    "is_loop",
    "favourite",
    "duration_seconds",
    "source_kind",
    "source_path",
    "project_kind",
    "editor_engine",
    "content_count",
    "tag_ids",
    "audio_meta",
    "extra",
)

_AUDIO_META_KEYS = (
    "author",
    "album",
    "album_artist",
    "release_year",
    "genre",
    "track_number",
    "disc_number",
    "comment",
)

_MAX_DELTA_ITEMS = 500
_CHANGELOG_PRUNE_THRESHOLD = 25000
_CHANGELOG_KEEP_ROWS = 10000
_SNAPSHOT_CACHE_MAX = 16


class _CatalogRuntime:
    """Thread-safe snapshot cache and async SSE broadcaster for catalog revisions."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._initialized_dbs: set[str] = set()
        # key -> (rev, raw_json_bytes, gzip_bytes)
        self._snapshot_cache: OrderedDict[tuple[Any, ...], tuple[int, bytes, bytes]] = OrderedDict()
        # (asyncio.AbstractEventLoop, asyncio.Queue)
        self._subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._last_known_rev: dict[str, int] = {}

    def db_identity(self, raw_conn) -> str:
        try:
            rows = raw_conn.execute("PRAGMA database_list").fetchall()
            for row in rows:
                if row[1] == "main":
                    db_file = row[2] or ""
                    if db_file:
                        return os.path.normcase(os.path.abspath(db_file))
        except Exception:
            pass
        return f"mem:{id(raw_conn)}"

    def ensure_schema(self, raw_conn) -> str:
        db_key = self.db_identity(raw_conn)
        with self._lock:
            already = db_key in self._initialized_dbs
        if already:
            # Verify cheaply for in-memory or recreated temp test DBs
            if not db_key.startswith("mem:"):
                try:
                    row = raw_conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_meta'"
                    ).fetchone()
                    if row is not None:
                        return db_key
                except Exception:
                    pass
        database.ensure_catalog_acceleration_raw(raw_conn)
        try:
            raw_conn.commit()
        except Exception:
            pass
        with self._lock:
            self._initialized_dbs.add(db_key)
        return db_key

    def get_cached_snapshot(self, cache_key: tuple[Any, ...], rev: int) -> tuple[bytes, bytes] | None:
        with self._lock:
            entry = self._snapshot_cache.get(cache_key)
            if entry and entry[0] == rev:
                self._snapshot_cache.move_to_end(cache_key)
                return entry[1], entry[2]
        return None

    def put_cached_snapshot(self, cache_key: tuple[Any, ...], rev: int, raw_bytes: bytes, gz_bytes: bytes) -> None:
        with self._lock:
            self._snapshot_cache[cache_key] = (rev, raw_bytes, gz_bytes)
            self._snapshot_cache.move_to_end(cache_key)
            while len(self._snapshot_cache) > _SNAPSHOT_CACHE_MAX:
                self._snapshot_cache.popitem(last=False)

    def invalidate_db(self, db_key: str, new_rev: int | None = None) -> None:
        with self._lock:
            stale_keys = [k for k in self._snapshot_cache if k[0] == db_key]
            for key in stale_keys:
                self._snapshot_cache.pop(key, None)
            prev_rev = self._last_known_rev.get(db_key)
            if new_rev is not None:
                if prev_rev == new_rev:
                    return
                self._last_known_rev[db_key] = new_rev
            subscribers = list(self._subscribers)

        if new_rev is not None and subscribers:
            for loop, queue in subscribers:
                try:
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(_enqueue_latest, queue, new_rev)
                except Exception:
                    pass

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=16)
        with self._lock:
            self._subscribers.add((loop, queue))
        return queue

    def unsubscribe(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.discard((loop, queue))


def _enqueue_latest(queue: asyncio.Queue, rev: int) -> None:
    try:
        while queue.full():
            queue.get_nowait()
        queue.put_nowait(rev)
    except Exception:
        pass


catalog_runtime = _CatalogRuntime()


def unwrap_raw_connection(db: Session):
    """Return the underlying sqlite3.Connection from a SQLAlchemy Session."""
    sa_conn = db.connection()
    raw = sa_conn.connection
    return getattr(raw, "driver_connection", raw)


def get_library_rev(raw_conn) -> int:
    try:
        row = raw_conn.execute("SELECT value FROM library_meta WHERE key = 'library_rev'").fetchone()
        if row and row[0] is not None:
            return int(row[0])
    except Exception:
        pass
    return 1


def _on_session_after_commit(session: Session) -> None:
    """Notify SSE listeners and invalidate snapshot caches whenever a commit advances library_rev."""
    try:
        bind = session.get_bind()
        if bind is None or "sqlite" not in str(getattr(bind, "url", "")):
            return
        raw_conn = bind.raw_connection()
        try:
            driver = getattr(raw_conn, "driver_connection", raw_conn)
            db_key = catalog_runtime.db_identity(driver)
            rev = get_library_rev(driver)
        finally:
            raw_conn.close()
        catalog_runtime.invalidate_db(db_key, rev)
    except Exception:
        pass


event.listen(Session, "after_commit", _on_session_after_commit)


def _vault_paths_from_row(storage_key: str, custom_path: str | None, custom_layout: str | None) -> tuple[str, str]:
    root = Path(custom_path).expanduser().resolve() if custom_path else paths.vaults_directory().resolve()
    if custom_path and (custom_layout or "root") == "vault":
        store = root
    else:
        store = root / storage_key
    return str(store), str(root)


def _load_vaults_raw(raw_conn) -> list[dict[str, Any]]:
    vault_rows = raw_conn.execute(
        """
        SELECT id, name, description, preset, storage_key, custom_path, custom_layout, preview, created_at
        FROM vaults
        ORDER BY name ASC
        """
    ).fetchall()
    mirrors_by_vault: dict[int, list[dict[str, Any]]] = {}
    try:
        mirror_rows = raw_conn.execute(
            """
            SELECT id, vault_id, source_path, target_folder_path, root_item_id, mode, enabled,
                   last_synced_at, created_at, updated_at
            FROM vault_mirrors
            ORDER BY id ASC
            """
        ).fetchall()
        for m in mirror_rows:
            mirrors_by_vault.setdefault(int(m[1]), []).append(
                {
                    "id": int(m[0]),
                    "vault_id": int(m[1]),
                    "source_path": m[2],
                    "target_folder_path": m[3] or "",
                    "root_item_id": int(m[4]) if m[4] is not None else None,
                    "mode": m[5] or "reference_1to1",
                    "mirror_mode": m[5] or "reference_1to1",
                    "enabled": bool(m[6]),
                    "last_synced_at": m[7],
                    "created_at": m[8],
                    "updated_at": m[9],
                }
            )
    except Exception:
        pass

    result: list[dict[str, Any]] = []
    for row in vault_rows:
        vid = int(row[0])
        store_path, root_path = _vault_paths_from_row(row[4], row[5], row[6])
        result.append(
            {
                "id": vid,
                "name": row[1],
                "description": row[2],
                "preset": row[3] or "general",
                "storage_key": row[4],
                "custom_path": row[5],
                "custom_layout": row[6] or "root",
                "preview": row[7] or "quick",
                "path": store_path,
                "root_path": root_path,
                "created_at": row[8],
                "mirrors": mirrors_by_vault.get(vid, []),
            }
        )
    return result


def _load_playlists_raw(raw_conn) -> list[dict[str, Any]]:
    try:
        pl_rows = raw_conn.execute(
            "SELECT id, name, created_at, updated_at FROM playlists ORDER BY name ASC"
        ).fetchall()
        entry_rows = raw_conn.execute(
            "SELECT playlist_id, item_id FROM playlist_items ORDER BY playlist_id ASC, position ASC, id ASC"
        ).fetchall()
    except Exception:
        return []

    items_by_playlist: dict[int, list[int]] = {}
    for pl_id, item_id in entry_rows:
        items_by_playlist.setdefault(int(pl_id), []).append(int(item_id))

    result: list[dict[str, Any]] = []
    for row in pl_rows:
        pid = int(row[0])
        item_ids = items_by_playlist.get(pid, [])
        result.append(
            {
                "id": pid,
                "name": row[1],
                "item_count": len(item_ids),
                "item_ids": item_ids,
                "created_at": row[2],
                "updated_at": row[3],
            }
        )
    return result


def _pack_item_rows(
    raw_conn,
    *,
    where_sql: str = "",
    params: tuple[Any, ...] = (),
) -> list[list[Any]]:
    """Run one zero-ORM joined SQLite query and pack items into compact positional arrays."""
    sql = f"""
        SELECT i.id, i.vault_id, i.parent_id, i.type, i.absolute_path,
               i.size_bytes, i.mime_type, i.storage_mode, i.availability,
               i.updated_at, i.metadata_json,
               COALESCE(s.bpm, m.bpm, mt.bpm) AS bpm,
               COALESCE(s.key, m.key, mt.key) AS key,
               s.is_loop,
               c.title AS col_title,
               c.source_kind,
               c.source_path AS col_source_path,
               c.content_count,
               p.project_kind,
               p.editor_engine,
               mt.stems_json,
               mt.is_valid_length,
               mt.length_variance
        FROM items i
        LEFT JOIN sample_items s ON s.id = i.id
        LEFT JOIN midi_items m ON m.id = i.id
        LEFT JOIN multitrack_items mt ON mt.id = i.id
        LEFT JOIN collection_items c ON c.id = i.id
        LEFT JOIN project_items p ON p.id = i.id
        {where_sql}
    """
    rows = raw_conn.execute(sql, params).fetchall()
    if not rows:
        return []

    # Bulk-load tags for selected rows (or all rows if unfiltered)
    tags_by_item: dict[int, list[int]] = {}
    if not where_sql:
        for item_id, tag_id in raw_conn.execute("SELECT item_id, tag_id FROM item_tags").fetchall():
            tags_by_item.setdefault(int(item_id), []).append(int(tag_id))
    else:
        ids = [int(r[0]) for r in rows]
        for offset in range(0, len(ids), 900):
            batch = ids[offset : offset + 900]
            ph = ",".join("?" for _ in batch)
            for item_id, tag_id in raw_conn.execute(
                f"SELECT item_id, tag_id FROM item_tags WHERE item_id IN ({ph})", batch
            ).fetchall():
                tags_by_item.setdefault(int(item_id), []).append(int(tag_id))

    packed: list[list[Any]] = []
    for row in rows:
        (
            item_id,
            vault_id,
            parent_id,
            item_type,
            abs_path,
            size_bytes,
            mime_type,
            storage_mode,
            availability,
            updated_at,
            metadata_json,
            bpm,
            key,
            is_loop,
            col_title,
            source_kind,
            col_source_path,
            content_count,
            project_kind,
            editor_engine,
            stems_json,
            is_valid_length,
            length_variance,
        ) = row

        attrs: dict[str, Any] = {}
        if metadata_json and metadata_json != "{}":
            try:
                parsed = json.loads(metadata_json)
                if isinstance(parsed, dict):
                    attrs = parsed
            except (TypeError, ValueError):
                pass

        analysis = attrs.get("analysis") if isinstance(attrs.get("analysis"), dict) else {}
        video_meta = attrs.get("video_metadata") if isinstance(attrs.get("video_metadata"), dict) else {}
        audio_meta_raw = attrs.get("audio_metadata") if isinstance(attrs.get("audio_metadata"), dict) else {}
        import_meta = attrs.get("import") if isinstance(attrs.get("import"), dict) else {}

        itype = item_type or "item"
        path_str = abs_path or ""
        basename = os.path.basename(path_str.rstrip("/\\"))

        if itype in {"audio", "track", "sample"}:
            title = audio_meta_raw.get("title") or col_title or attrs.get("title") or basename
        else:
            title = col_title or attrs.get("title") or basename

        eff_bpm = bpm if bpm is not None else analysis.get("bpm")
        eff_key = key if key is not None else analysis.get("key")
        eff_is_loop = bool(is_loop) if is_loop is not None else analysis.get("is_loop")
        favourite = bool(attrs.get("favourite", False))
        duration = analysis.get("duration_seconds")
        if duration is None:
            duration = video_meta.get("duration_seconds")

        eff_source_path = col_source_path or import_meta.get("source_path")
        eff_avail = "ready" if availability in {"ready", "available", None, ""} else availability

        audio_meta: dict[str, Any] | None = None
        if audio_meta_raw:
            compact_audio = {k: audio_meta_raw[k] for k in _AUDIO_META_KEYS if audio_meta_raw.get(k) not in (None, "")}
            if compact_audio:
                audio_meta = compact_audio

        extra: dict[str, Any] = {}
        if attrs.get("is_folder"):
            extra["is_folder"] = True
        if attrs.get("folder"):
            extra["folder"] = attrs["folder"]
        if attrs.get("profile_id"):
            extra["profile_id"] = attrs["profile_id"]
        if attrs.get("profile_label"):
            extra["profile_label"] = attrs["profile_label"]
        if attrs.get("profile_bundle_id"):
            extra["profile_bundle_id"] = attrs["profile_bundle_id"]
        if stems_json:
            try:
                stems = json.loads(stems_json)
                if isinstance(stems, list) and stems:
                    extra["stems"] = stems
                    if is_valid_length is not None:
                        extra["is_valid_length"] = bool(is_valid_length)
                    if length_variance is not None:
                        extra["length_variance"] = float(length_variance)
            except (TypeError, ValueError):
                pass

        packed.append(
            [
                int(item_id),
                int(vault_id),
                int(parent_id) if parent_id is not None else None,
                itype,
                title,
                path_str,
                size_bytes,
                mime_type,
                storage_mode or "managed",
                eff_avail,
                updated_at,
                eff_bpm,
                eff_key,
                eff_is_loop,
                favourite,
                duration,
                source_kind,
                eff_source_path,
                project_kind,
                editor_engine,
                content_count,
                tags_by_item.get(int(item_id), []),
                audio_meta,
                extra or None,
            ]
        )

    return packed


def build_snapshot_dict(
    db: Session,
    *,
    vault_id: int | None = None,
    vault_preview: str | None = None,
) -> dict[str, Any]:
    """Build the compact columnar catalog snapshot dict directly from SQLite."""
    raw_conn = unwrap_raw_connection(db)
    catalog_runtime.ensure_schema(raw_conn)
    rev = get_library_rev(raw_conn)

    vaults_list = _load_vaults_raw(raw_conn)
    playlists_list = _load_playlists_raw(raw_conn)
    tags_map = {str(r[0]): r[1] for r in raw_conn.execute("SELECT id, name FROM tags").fetchall()}

    where_sql = ""
    params: tuple[Any, ...] = ()
    if vault_id is not None:
        where_sql = "WHERE i.vault_id = ?"
        params = (int(vault_id),)
    elif vault_preview is not None:
        matching_vids = [v["id"] for v in vaults_list if v["preview"] == vault_preview]
        if matching_vids:
            ph = ",".join("?" for _ in matching_vids)
            where_sql = f"WHERE i.vault_id IN ({ph})"
            params = tuple(matching_vids)
        else:
            where_sql = "WHERE 1 = 0"

    rows = _pack_item_rows(raw_conn, where_sql=where_sql, params=params)
    return {
        "schema": "gaia-catalog-v1",
        "rev": rev,
        "total_items": len(rows),
        "columns": list(SNAPSHOT_COLUMNS),
        "tags": tags_map,
        "vaults": vaults_list,
        "playlists": playlists_list,
        "types": type_registry.type_definitions(),
        "rows": rows,
    }


def get_snapshot_payload(
    db: Session,
    *,
    vault_id: int | None = None,
    vault_preview: str | None = None,
    accept_gzip: bool = False,
) -> tuple[int, bytes, bool]:
    """Return (rev, payload_bytes, is_gzipped) using the in-memory revision cache."""
    raw_conn = unwrap_raw_connection(db)
    db_key = catalog_runtime.ensure_schema(raw_conn)
    rev = get_library_rev(raw_conn)
    cache_key = (db_key, vault_id, vault_preview)

    cached = catalog_runtime.get_cached_snapshot(cache_key, rev)
    if cached is not None:
        raw_bytes, gz_bytes = cached
        return rev, (gz_bytes if accept_gzip else raw_bytes), accept_gzip

    doc = build_snapshot_dict(db, vault_id=vault_id, vault_preview=vault_preview)
    raw_bytes = json.dumps(doc, separators=(",", ":"), default=str).encode("utf-8")
    gz_bytes = gzip.compress(raw_bytes, compresslevel=1)
    catalog_runtime.put_cached_snapshot(cache_key, rev, raw_bytes, gz_bytes)
    return rev, (gz_bytes if accept_gzip else raw_bytes), accept_gzip


def get_catalog_delta(
    db: Session,
    *,
    since_rev: int,
    vault_id: int | None = None,
    vault_preview: str | None = None,
) -> dict[str, Any]:
    """Return incremental item/vault/playlist deltas since `since_rev`, or `full_reload: True`."""
    raw_conn = unwrap_raw_connection(db)
    catalog_runtime.ensure_schema(raw_conn)
    current_rev = get_library_rev(raw_conn)

    if since_rev >= current_rev:
        return {
            "rev": current_rev,
            "full_reload": False,
            "upserted": [],
            "deleted_ids": [],
            "changed_project_ids": [],
        }

    min_row = raw_conn.execute("SELECT MIN(rev), COUNT(*) FROM library_changelog").fetchone()
    min_rev = int(min_row[0]) if min_row and min_row[0] is not None else current_rev
    total_log_rows = int(min_row[1]) if min_row and min_row[1] is not None else 0

    if since_rev > 0 and since_rev < min_rev - 1:
        return {"rev": current_rev, "full_reload": True}

    changes = raw_conn.execute(
        "SELECT rev, entity, entity_id, op, vault_id FROM library_changelog WHERE rev > ? ORDER BY rev ASC",
        (int(since_rev),),
    ).fetchall()

    item_ops: dict[int, str] = {}
    vaults_changed = False
    playlists_changed = False
    tags_changed = False
    changed_project_ids: set[int] = set()

    for _rev, entity, entity_id, op, _vid in changes:
        eid = int(entity_id)
        if entity == "item":
            item_ops[eid] = op
        elif entity == "vault":
            vaults_changed = True
        elif entity == "playlist":
            playlists_changed = True
        elif entity == "tag":
            tags_changed = True
        elif entity == "project_ref":
            changed_project_ids.add(eid)

    if len(item_ops) > _MAX_DELTA_ITEMS:
        return {"rev": current_rev, "full_reload": True}

    deleted_ids = [iid for iid, op in item_ops.items() if op == "delete"]
    upsert_ids = [iid for iid, op in item_ops.items() if op != "delete"]

    upserted_rows: list[list[Any]] = []
    if upsert_ids:
        ph = ",".join("?" for _ in upsert_ids)
        extra_clauses = [f"i.id IN ({ph})"]
        params: list[Any] = list(upsert_ids)
        if vault_id is not None:
            extra_clauses.append("i.vault_id = ?")
            params.append(int(vault_id))
        elif vault_preview is not None:
            extra_clauses.append("i.vault_id IN (SELECT id FROM vaults WHERE preview = ?)")
            params.append(vault_preview)
        upserted_rows = _pack_item_rows(
            raw_conn,
            where_sql="WHERE " + " AND ".join(extra_clauses),
            params=tuple(params),
        )
        # If an item moved OUT of the filtered vault scope, tell the scoped client to delete it.
        returned_ids = {row[0] for row in upserted_rows}
        for uid in upsert_ids:
            if uid not in returned_ids:
                deleted_ids.append(uid)

    # Opportunistic changelog pruning so the table stays tiny over months of use
    if total_log_rows > _CHANGELOG_PRUNE_THRESHOLD:
        try:
            cutoff = current_rev - _CHANGELOG_KEEP_ROWS
            raw_conn.execute("DELETE FROM library_changelog WHERE rev < ?", (cutoff,))
            raw_conn.commit()
        except Exception:
            pass

    payload: dict[str, Any] = {
        "rev": current_rev,
        "full_reload": False,
        "columns": list(SNAPSHOT_COLUMNS),
        "upserted": upserted_rows,
        "deleted_ids": deleted_ids,
        "changed_project_ids": sorted(changed_project_ids),
    }
    if tags_changed or upserted_rows:
        payload["tags"] = {str(r[0]): r[1] for r in raw_conn.execute("SELECT id, name FROM tags").fetchall()}
    if vaults_changed:
        payload["vaults"] = _load_vaults_raw(raw_conn)
    if playlists_changed:
        payload["playlists"] = _load_playlists_raw(raw_conn)
    return payload


def get_direct_children_rows(db: Session, parent_id: int) -> dict[str, Any]:
    """Return 1-level direct children of a folder/collection using a single raw SQL query."""
    raw_conn = unwrap_raw_connection(db)
    catalog_runtime.ensure_schema(raw_conn)
    rows = _pack_item_rows(
        raw_conn,
        where_sql="WHERE i.parent_id = ? ORDER BY (i.type NOT IN ('folder', 'collection', 'multitrack', 'zoom_h4', 'project')), LOWER(i.absolute_path), i.id",
        params=(int(parent_id),),
    )
    tags_map = {str(r[0]): r[1] for r in raw_conn.execute("SELECT id, name FROM tags").fetchall()}
    return {
        "parent_id": int(parent_id),
        "rev": get_library_rev(raw_conn),
        "columns": list(SNAPSHOT_COLUMNS),
        "tags": tags_map,
        "rows": rows,
    }


def _extract_fts_row_fields(row: tuple[Any, ...], tags_str: str) -> tuple[Any, ...]:
    item_id, vault_id, itype, abs_path, meta_json, col_title, key_val, bpm_val = row
    path_str = abs_path or ""
    fname = os.path.basename(path_str.rstrip("/\\"))
    attrs: dict[str, Any] = {}
    if meta_json and meta_json != "{}":
        try:
            parsed = json.loads(meta_json)
            if isinstance(parsed, dict):
                attrs = parsed
        except (TypeError, ValueError):
            pass
    audio_meta = attrs.get("audio_metadata") if isinstance(attrs.get("audio_metadata"), dict) else {}
    title = audio_meta.get("title") or col_title or attrs.get("title") or fname
    meta_parts = [
        str(audio_meta.get(k) or "")
        for k in ("author", "album", "album_artist", "genre", "comment")
    ]
    if key_val:
        meta_parts.append(str(key_val))
    if bpm_val is not None:
        meta_parts.append(str(bpm_val))
    if attrs.get("folder"):
        meta_parts.append(str(attrs["folder"]))
    if attrs.get("profile_label"):
        meta_parts.append(str(attrs["profile_label"]))
    if attrs.get("profile_id"):
        meta_parts.append(str(attrs["profile_id"]))
    meta_text = " ".join(p for p in meta_parts if p)
    return (
        int(item_id),
        int(vault_id),
        itype or "item",
        fname,
        str(title or fname),
        path_str,
        tags_str,
        meta_text,
    )


def sync_fts_index(raw_conn) -> bool:
    """Incrementally bring `items_fts` up to `library_rev` using `library_changelog`."""
    try:
        fts_exists = raw_conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='items_fts'"
        ).fetchone()
        if not fts_exists:
            return False
    except Exception:
        return False

    current_rev = get_library_rev(raw_conn)
    synced_row = raw_conn.execute(
        "SELECT value FROM library_meta WHERE key = 'fts_synced_rev'"
    ).fetchone()
    synced_rev = int(synced_row[0]) if synced_row and synced_row[0] is not None else 0

    if synced_rev >= current_rev and synced_rev > 0:
        return True

    min_row = raw_conn.execute("SELECT MIN(rev) FROM library_changelog").fetchone()
    min_rev = int(min_row[0]) if min_row and min_row[0] is not None else current_rev

    full_rebuild = synced_rev == 0 or (synced_rev < min_rev - 1)
    if not full_rebuild:
        changed_rows = raw_conn.execute(
            "SELECT DISTINCT entity_id, op FROM library_changelog WHERE rev > ? AND entity = 'item'",
            (synced_rev,),
        ).fetchall()
        tag_changed = raw_conn.execute(
            "SELECT 1 FROM library_changelog WHERE rev > ? AND entity = 'tag' LIMIT 1",
            (synced_rev,),
        ).fetchone()
        if tag_changed:
            full_rebuild = True

    if full_rebuild:
        raw_conn.execute("DELETE FROM items_fts")
        rows = raw_conn.execute(
            """
            SELECT i.id, i.vault_id, i.type, i.absolute_path, i.metadata_json,
                   c.title, COALESCE(s.key, m.key, mt.key), COALESCE(s.bpm, m.bpm, mt.bpm)
            FROM items i
            LEFT JOIN collection_items c ON c.id = i.id
            LEFT JOIN sample_items s ON s.id = i.id
            LEFT JOIN midi_items m ON m.id = i.id
            LEFT JOIN multitrack_items mt ON mt.id = i.id
            """
        ).fetchall()
        tags_map: dict[int, list[str]] = {}
        for iid, tname in raw_conn.execute(
            "SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id"
        ).fetchall():
            tags_map.setdefault(int(iid), []).append(tname)

        fts_rows = [
            _extract_fts_row_fields(r, " ".join(tags_map.get(int(r[0]), [])))
            for r in rows
        ]
        raw_conn.executemany(
            "INSERT INTO items_fts(item_id, vault_id, type, filename, title, path_text, tags, meta_text) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            fts_rows,
        )
    else:
        affected_ids = sorted({int(r[0]) for r in changed_rows})
        if affected_ids:
            for offset in range(0, len(affected_ids), 500):
                batch = affected_ids[offset : offset + 500]
                ph = ",".join("?" for _ in batch)
                raw_conn.execute(f"DELETE FROM items_fts WHERE item_id IN ({ph})", batch)
                rows = raw_conn.execute(
                    f"""
                    SELECT i.id, i.vault_id, i.type, i.absolute_path, i.metadata_json,
                           c.title, COALESCE(s.key, m.key, mt.key), COALESCE(s.bpm, m.bpm, mt.bpm)
                    FROM items i
                    LEFT JOIN collection_items c ON c.id = i.id
                    LEFT JOIN sample_items s ON s.id = i.id
                    LEFT JOIN midi_items m ON m.id = i.id
                    LEFT JOIN multitrack_items mt ON mt.id = i.id
                    WHERE i.id IN ({ph})
                    """,
                    batch,
                ).fetchall()
                if not rows:
                    continue
                tags_map = {}
                for iid, tname in raw_conn.execute(
                    f"SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id IN ({ph})",
                    batch,
                ).fetchall():
                    tags_map.setdefault(int(iid), []).append(tname)
                fts_rows = [
                    _extract_fts_row_fields(r, " ".join(tags_map.get(int(r[0]), [])))
                    for r in rows
                ]
                raw_conn.executemany(
                    "INSERT INTO items_fts(item_id, vault_id, type, filename, title, path_text, tags, meta_text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    fts_rows,
                )

    raw_conn.execute(
        "INSERT OR REPLACE INTO library_meta(key, value) VALUES ('fts_synced_rev', ?)",
        (str(current_rev),),
    )
    raw_conn.commit()
    return True


def _build_fts_query(query: str) -> str | None:
    tokens = re.findall(r"[A-Za-z0-9_]+", query or "")
    if not tokens:
        return None
    return " ".join(f'"{tok}"*' for tok in tokens)


def search_fts_item_ids(
    db: Session,
    query: str,
    *,
    vault_id: int | None = None,
    vault_preview: str | None = None,
    limit: int = 500,
) -> tuple[list[int], list[int]]:
    """Search `items_fts` and return `(matched_item_ids, matched_root_ids)` in <3ms."""
    raw_conn = unwrap_raw_connection(db)
    catalog_runtime.ensure_schema(raw_conn)
    needle = (query or "").strip()
    if not needle:
        return [], []

    fts_expr = _build_fts_query(needle)
    matched_ids: list[int] = []
    if fts_expr and sync_fts_index(raw_conn):
        clauses = ["items_fts MATCH ?"]
        params: list[Any] = [fts_expr]
        if vault_id is not None:
            clauses.append("vault_id = ?")
            params.append(int(vault_id))
        elif vault_preview is not None:
            clauses.append("vault_id IN (SELECT id FROM vaults WHERE preview = ?)")
            params.append(vault_preview)
        params.append(max(1, min(int(limit), 50000)))
        rows = raw_conn.execute(
            f"SELECT item_id FROM items_fts WHERE {' AND '.join(clauses)} LIMIT ?",
            params,
        ).fetchall()
        matched_ids = [int(r[0]) for r in rows]

    if not matched_ids:
        # Substring fallback (e.g., query contains non-token chars or mid-word substring)
        pattern = f"%{needle}%"
        clauses = [
            "(i.type LIKE ? OR i.absolute_path LIKE ? OR i.metadata_json LIKE ? OR EXISTS ("
            "SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id "
            "WHERE it.item_id = i.id AND t.name LIKE ?))"
        ]
        params = [pattern, pattern, pattern, pattern]
        if vault_id is not None:
            clauses.append("i.vault_id = ?")
            params.append(int(vault_id))
        elif vault_preview is not None:
            clauses.append("i.vault_id IN (SELECT id FROM vaults WHERE preview = ?)")
            params.append(vault_preview)
        params.append(max(1, min(int(limit), 50000)))
        rows = raw_conn.execute(
            f"SELECT i.id FROM items i WHERE {' AND '.join(clauses)} LIMIT ?",
            params,
        ).fetchall()
        matched_ids = [int(r[0]) for r in rows]

    if not matched_ids:
        return [], []

    # Resolve root ancestor IDs in a single recursive CTE
    ph = ",".join("?" for _ in matched_ids)
    root_rows = raw_conn.execute(
        f"""
        WITH RECURSIVE anc(id, parent_id) AS (
            SELECT id, parent_id FROM items WHERE id IN ({ph})
            UNION
            SELECT i.id, i.parent_id FROM items i JOIN anc a ON i.id = a.parent_id
        )
        SELECT DISTINCT id FROM anc WHERE parent_id IS NULL
        """,
        matched_ids,
    ).fetchall()
    root_ids = [int(r[0]) for r in root_rows]
    return matched_ids, root_ids


def resolve_stream_target(db: Session, item_id: int) -> dict[str, Any] | None:
    """Fast scalar lookup for `/items/{item_id}/stream` and native audio preview (<0.5ms)."""
    raw_conn = unwrap_raw_connection(db)
    row = raw_conn.execute(
        """
        SELECT i.id, i.absolute_path, i.type, i.mime_type, i.availability, mt.stems_json
        FROM items i
        LEFT JOIN multitrack_items mt ON mt.id = i.id
        WHERE i.id = ?
        """,
        (int(item_id),),
    ).fetchone()
    if not row:
        return None
    iid, abs_path, itype, mime_type, availability, stems_json = row
    eff_avail = "ready" if availability in {"ready", "available", None, ""} else availability
    target_path = abs_path
    resolved_mime = mime_type
    if itype in {"multitrack", "zoom_h4"} and stems_json:
        try:
            stems = json.loads(stems_json)
            if isinstance(stems, list) and stems and stems[0].get("absolute_path"):
                stem0 = stems[0]["absolute_path"]
                if os.path.exists(stem0):
                    target_path = stem0
                    resolved_mime = "audio/wav"
        except (TypeError, ValueError):
            pass
    return {
        "id": int(iid),
        "absolute_path": target_path,
        "type": itype or "item",
        "mime_type": resolved_mime,
        "availability": eff_avail,
    }


def resolve_collection_content_stream_target(
    db: Session,
    collection_id: int,
    content_index: int,
) -> dict[str, Any] | None:
    """Fast scalar lookup for `/items/{id}/contents/{idx}/stream` without hydrating the folder."""
    raw_conn = unwrap_raw_connection(db)
    col_row = raw_conn.execute(
        """
        SELECT i.id, i.absolute_path, i.type, c.manifest_json
        FROM items i
        JOIN collection_items c ON c.id = i.id
        WHERE i.id = ?
        """,
        (int(collection_id),),
    ).fetchone()
    if not col_row:
        return None

    col_id, col_path, _col_type, manifest_json = col_row
    # 1. Direct child by id == content_index
    direct = raw_conn.execute(
        "SELECT id, absolute_path, mime_type, availability FROM items WHERE parent_id = ? AND id = ?",
        (int(col_id), int(content_index)),
    ).fetchone()
    if direct and direct[1] and os.path.isfile(direct[1]):
        return {
            "path": os.path.abspath(direct[1]),
            "mime_type": direct[2],
            "availability": "ready" if direct[3] in {"ready", "available", None, ""} else direct[3],
        }

    # 2. Check manifest entry matching index (only if present)
    if manifest_json and manifest_json != "[]":
        try:
            entries = json.loads(manifest_json)
            if isinstance(entries, list):
                entry = next((e for e in entries if isinstance(e, dict) and e.get("index") == content_index), None)
                if entry:
                    avail = entry.get("availability", "ready")
                    if avail in {"available", None, ""}:
                        avail = "ready"
                    child_id = entry.get("child_id")
                    if child_id:
                        ch = raw_conn.execute(
                            "SELECT absolute_path, mime_type, availability FROM items WHERE id = ?",
                            (int(child_id),),
                        ).fetchone()
                        if ch and ch[0] and os.path.isfile(ch[0]):
                            ch_avail = "ready" if ch[2] in {"ready", "available", None, ""} else ch[2]
                            return {"path": os.path.abspath(ch[0]), "mime_type": ch[1] or entry.get("mime_type"), "availability": ch_avail}
                    rel = entry.get("relative_path", "")
                    if rel and col_path:
                        col_root = os.path.abspath(col_path)
                        cand = os.path.abspath(os.path.join(col_root, rel))
                        if not os.path.isfile(cand):
                            stripped = re.sub(r"^extracted/[^/]+/", "", rel)
                            alt = os.path.abspath(os.path.join(col_root, stripped))
                            if os.path.isfile(alt):
                                cand = alt
                        if os.path.commonpath([col_root, cand]) == col_root and os.path.isfile(cand):
                            return {"path": cand, "mime_type": entry.get("mime_type"), "availability": avail}
        except (TypeError, ValueError):
            pass

    # 3. Positional fallback over sorted subtree children (SQL OFFSET 1 row!)
    if content_index >= 0:
        row = raw_conn.execute(
            """
            WITH RECURSIVE sub(id) AS (
                SELECT ?
                UNION ALL
                SELECT i.id FROM items i JOIN sub s ON i.parent_id = s.id
                WHERE i.type IN ('folder', 'collection')
            )
            SELECT i.absolute_path, i.mime_type, i.availability
            FROM items i
            WHERE i.parent_id IN (SELECT id FROM sub)
              AND i.type NOT IN ('folder', 'collection')
            ORDER BY i.absolute_path, i.id
            LIMIT 1 OFFSET ?
            """,
            (int(col_id), int(content_index)),
        ).fetchone()
        if row and row[0] and os.path.isfile(row[0]):
            return {
                "path": os.path.abspath(row[0]),
                "mime_type": row[1],
                "availability": "ready" if row[2] in {"ready", "available", None, ""} else row[2],
            }
    return None
