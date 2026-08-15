"""Narrow compatibility operations for databases predating GAIA's ORM schema."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3


def update_bpm(
    database_path: str | Path,
    bpm: int,
    *,
    filepath: str | None = None,
    item_id: int | None = None,
) -> bool:
    """Update BPM through GAIA when only the historical minimal schema exists."""
    path = Path(database_path)
    if not path.is_file():
        return False
    target_abs = os.path.abspath(filepath) if filepath else None
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        cursor = connection.cursor()
        tables = {
            row[0]
            for row in cursor.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "items" not in tables:
            return False
        row = None
        if item_id is not None:
            row = cursor.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
        elif target_abs:
            row = cursor.execute(
                "SELECT id FROM items WHERE absolute_path IN (?, ?)",
                (filepath, target_abs),
            ).fetchone()
        updated = False
        if row and "loop_sample_items" in tables:
            resolved_id = row["id"]
            cursor.execute("UPDATE items SET type = 'loop' WHERE id = ?", (resolved_id,))
            if "audio_items" in tables:
                cursor.execute("INSERT OR IGNORE INTO audio_items (id) VALUES (?)", (resolved_id,))
            if "sample_items" in tables:
                cursor.execute(
                    "INSERT OR IGNORE INTO sample_items (id, key) VALUES (?, NULL)",
                    (resolved_id,),
                )
            cursor.execute(
                "INSERT OR REPLACE INTO loop_sample_items (id, bpm) VALUES (?, ?)",
                (resolved_id, bpm),
            )
            updated = True

        if target_abs and "collection_items" in tables:
            columns = {
                row[1]
                for row in cursor.execute("PRAGMA table_info(collection_items)")
            }
            if {"id", "absolute_path", "manifest_json"}.issubset(columns):
                folders = cursor.execute(
                    "SELECT id, absolute_path, manifest_json FROM collection_items"
                ).fetchall()
                for folder in folders:
                    try:
                        manifest = json.loads(folder["manifest_json"] or "[]")
                    except (TypeError, ValueError):
                        continue
                    changed = False
                    for entry in manifest:
                        candidate = os.path.abspath(
                            os.path.join(
                                folder["absolute_path"] or "",
                                entry.get("relative_path") or "",
                            )
                        )
                        if candidate == target_abs:
                            entry["bpm"] = bpm
                            changed = True
                    if changed:
                        cursor.execute(
                            "UPDATE collection_items SET manifest_json = ? WHERE id = ?",
                            (json.dumps(manifest), folder["id"]),
                        )
                        updated = True
        connection.commit()
        return updated
    finally:
        connection.close()
