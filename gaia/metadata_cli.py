"""Small, dependency-free entry point for inspecting and editing track metadata.

Examples, run from the repository root::

    python -m gaia.metadata_cli list --query "artist or title"
    python -m gaia.metadata_cli show 42
    python -m gaia.metadata_cli set 42 release_year=1997 album="Archive Session"
    python -m gaia.metadata_cli apply metadata-changes.json --dry-run

The ``apply`` file is a JSON array of objects with an ``item_id`` or exact
``path`` and either a nested ``changes`` object or metadata fields beside the
selector. All changes are validated before the transaction is committed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any, Iterable


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
INTEGER_FIELDS = {"release_year", "track_number", "disc_number"}


class MetadataEditError(ValueError):
    pass


def database_path(value: str | None = None) -> Path:
    configured = value or os.environ.get("GAIA_DATABASE_URL") or "gaia.db"
    if configured.startswith("sqlite:///"):
        configured = configured.removeprefix("sqlite:///")
    elif "://" in configured:
        raise MetadataEditError("The metadata CLI currently supports GAIA's SQLite database only")
    return Path(configured).expanduser().resolve()


def connect(value: str | None = None) -> sqlite3.Connection:
    path = database_path(value)
    if not path.is_file():
        raise MetadataEditError(f"GAIA database not found: {path}")
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    return connection


def _attributes(row: sqlite3.Row) -> dict[str, Any]:
    try:
        value = json.loads(row["metadata_json"] or "{}")
    except (TypeError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def _record(row: sqlite3.Row) -> dict[str, Any]:
    attributes = _attributes(row)
    metadata = attributes.get("audio_metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "item_id": row["id"],
        "type": row["type"],
        "path": row["absolute_path"],
        **{field: metadata.get(field) for field in TRACK_METADATA_FIELDS},
    }


def _find_item(connection: sqlite3.Connection, selector: int | str) -> sqlite3.Row:
    selector_text = str(selector).strip()
    if selector_text.isdigit():
        row = connection.execute(
            "SELECT id, type, absolute_path, metadata_json FROM items WHERE id = ?",
            (int(selector_text),),
        ).fetchone()
    else:
        row = connection.execute(
            "SELECT id, type, absolute_path, metadata_json FROM items WHERE absolute_path = ?",
            (str(Path(selector_text).expanduser().resolve()),),
        ).fetchone()
    if row is None:
        raise MetadataEditError(f"No GAIA item matches {selector!r}")
    if row["type"] != "track":
        raise MetadataEditError(f"GAIA item {row['id']} is {row['type']!r}, not a track")
    return row


def list_tracks(connection: sqlite3.Connection, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
    limit = min(1000, max(1, int(limit)))
    if query.strip():
        pattern = f"%{query.strip()}%"
        rows = connection.execute(
            """
            SELECT id, type, absolute_path, metadata_json
            FROM items
            WHERE type = 'track' AND (absolute_path LIKE ? OR metadata_json LIKE ?)
            ORDER BY id
            LIMIT ?
            """,
            (pattern, pattern, limit),
        ).fetchall()
    else:
        rows = connection.execute(
            """
            SELECT id, type, absolute_path, metadata_json
            FROM items WHERE type = 'track' ORDER BY id LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_record(row) for row in rows]


def show_track(connection: sqlite3.Connection, selector: int | str) -> dict[str, Any]:
    return _record(_find_item(connection, selector))


def normalize_changes(changes: dict[str, Any]) -> dict[str, Any]:
    unknown = set(changes) - set(TRACK_METADATA_FIELDS)
    if unknown:
        raise MetadataEditError(f"Unsupported metadata fields: {', '.join(sorted(unknown))}")
    if not changes:
        raise MetadataEditError("No metadata changes were supplied")

    normalized: dict[str, Any] = {}
    for field, value in changes.items():
        if value is None or (isinstance(value, str) and not value.strip()):
            normalized[field] = None
            continue
        if field in INTEGER_FIELDS:
            if isinstance(value, bool):
                raise MetadataEditError(f"{field} must be an integer")
            try:
                value = int(value)
            except (TypeError, ValueError) as exc:
                raise MetadataEditError(f"{field} must be an integer") from exc
            if field == "release_year" and not 1 <= value <= 9999:
                raise MetadataEditError("release_year must be between 1 and 9999")
            if field in {"track_number", "disc_number"} and value < 1:
                raise MetadataEditError(f"{field} must be at least 1")
            normalized[field] = value
        elif isinstance(value, (str, int, float)):
            normalized[field] = str(value).strip()
        else:
            raise MetadataEditError(f"{field} must be text or null")
    return normalized


def update_track(
    connection: sqlite3.Connection,
    selector: int | str,
    changes: dict[str, Any],
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    row = _find_item(connection, selector)
    normalized = normalize_changes(changes)
    before = _record(row)
    attributes = _attributes(row)
    metadata = attributes.get("audio_metadata") or {}
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    for field, value in normalized.items():
        if value is None:
            metadata.pop(field, None)
        else:
            metadata[field] = value
    if metadata:
        attributes["audio_metadata"] = metadata
    else:
        attributes.pop("audio_metadata", None)
    after = {**before, **{field: metadata.get(field) for field in TRACK_METADATA_FIELDS}}
    if not dry_run:
        connection.execute(
            "UPDATE items SET metadata_json = ?, updated_at = ? WHERE id = ?",
            (
                json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
                dt.datetime.now(dt.timezone.utc).isoformat(),
                row["id"],
            ),
        )
    return {"before": before, "after": after}


def _batch_entries(document: Any) -> Iterable[tuple[int | str, dict[str, Any]]]:
    entries = document.get("changes") if isinstance(document, dict) else document
    if not isinstance(entries, list):
        raise MetadataEditError("Batch JSON must be an array or an object containing a changes array")
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise MetadataEditError(f"Batch entry {index} must be an object")
        selector = entry.get("item_id", entry.get("path"))
        if selector is None:
            raise MetadataEditError(f"Batch entry {index} needs item_id or path")
        changes = entry.get("changes")
        if changes is None:
            changes = {field: entry[field] for field in TRACK_METADATA_FIELDS if field in entry}
        if not isinstance(changes, dict):
            raise MetadataEditError(f"Batch entry {index} changes must be an object")
        yield selector, changes


def apply_batch(
    connection: sqlite3.Connection,
    document: Any,
    *,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    entries = list(_batch_entries(document))
    resolved_ids: set[int] = set()
    validated: list[tuple[int, dict[str, Any]]] = []
    for selector, changes in entries:
        row = _find_item(connection, selector)
        if row["id"] in resolved_ids:
            raise MetadataEditError(f"Track {row['id']} occurs more than once in the batch")
        resolved_ids.add(row["id"])
        validated.append((row["id"], normalize_changes(changes)))

    results = [
        update_track(connection, item_id, changes, dry_run=dry_run)
        for item_id, changes in validated
    ]
    return results


def _assignment(value: str) -> tuple[str, Any]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("changes must use field=value")
    field, raw_value = value.split("=", 1)
    field = field.strip()
    if field not in TRACK_METADATA_FIELDS:
        raise argparse.ArgumentTypeError(f"unsupported metadata field: {field}")
    if raw_value.strip().casefold() in {"null", "none"}:
        return field, None
    return field, raw_value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect and edit GAIA track metadata")
    parser.add_argument("--database", help="SQLite path or sqlite:/// URL (defaults to GAIA_DATABASE_URL or ./gaia.db)")
    commands = parser.add_subparsers(dest="command", required=True)

    list_command = commands.add_parser("list", help="List track metadata")
    list_command.add_argument("--query", default="", help="Match the managed path or metadata")
    list_command.add_argument("--limit", type=int, default=100)

    show_command = commands.add_parser("show", help="Show one track by item ID or exact managed path")
    show_command.add_argument("selector")

    set_command = commands.add_parser("set", help="Set field=value pairs on one track")
    set_command.add_argument("selector")
    set_command.add_argument("assignments", nargs="+", type=_assignment)
    set_command.add_argument("--dry-run", action="store_true")

    apply_command = commands.add_parser("apply", help="Atomically apply a JSON batch file")
    apply_command.add_argument("file", type=Path)
    apply_command.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        with connect(args.database) as connection:
            if args.command == "list":
                result: Any = list_tracks(connection, args.query, args.limit)
            elif args.command == "show":
                result = show_track(connection, args.selector)
            elif args.command == "set":
                result = update_track(connection, args.selector, dict(args.assignments), dry_run=args.dry_run)
                if not args.dry_run:
                    connection.commit()
            else:
                with args.file.open("r", encoding="utf-8") as source:
                    document = json.load(source)
                result = apply_batch(connection, document, dry_run=args.dry_run)
                if not args.dry_run:
                    connection.commit()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (MetadataEditError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
        print(f"metadata edit failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
