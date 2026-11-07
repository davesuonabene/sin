"""Vault folder mirroring (1-1 Reference and Distill & Copy) and non-destructive sync."""

from __future__ import annotations

import datetime
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
from typing import Any

from sqlalchemy.orm import Session

from . import (
    collection_importer,
    crud,
    integrity,
    midi_parser,
    models,
    reconciler,
    reference_service,
    schemas,
    text_analyzer,
    vaults,
)


def _norm_path(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(str(value)))


def _clean_rel_folder_path(raw: str | None, fallback_name: str) -> str:
    text = (raw or "").strip().replace("\\", "/").strip("/")
    parts = [
        re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", segment).strip(". ")
        for segment in text.split("/")
        if segment and segment not in {".", ".."}
    ]
    parts = [p for p in parts if p]
    if not parts:
        fallback = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (fallback_name or "Mirror").strip()).strip(". ")
        return fallback or "Mirror"
    return "/".join(parts)


def _next_version_destination(folder: Path, filename: str) -> Path:
    """Return the next available ``stem.NN.ext`` revision path inside ``folder``."""
    info = reference_service.file_version_info(filename)
    base_name = info.get("base_name") or filename
    stem = Path(base_name).stem or "asset"
    suffix = Path(base_name).suffix
    counter = 2
    while True:
        candidate = folder / f"{stem}.{counter:02d}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _resolve_distill_destination(folder: Path, filename: str, relative_path: str) -> Path:
    """Resolve a non-destructive destination path for a distilled file."""
    direct = folder / filename
    if not direct.exists():
        return direct

    rel_parent = Path(relative_path).parent
    if str(rel_parent) not in {"", "."}:
        sub_tag = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", rel_parent.name).strip(". ")
        if sub_tag:
            stem = Path(filename).stem or "asset"
            suffix = Path(filename).suffix
            tagged_name = f"{stem} [{sub_tag}]{suffix}"
            tagged_candidate = folder / tagged_name
            if not tagged_candidate.exists():
                return tagged_candidate
            return _next_version_destination(folder, tagged_name)

    return _next_version_destination(folder, filename)


def _extract_item_source_path(item: models.Item) -> str | None:
    direct = getattr(item, "source_path", None)
    if direct:
        return str(direct)
    attrs = getattr(item, "attributes", None) or {}
    imp = attrs.get("import") if isinstance(attrs, dict) else None
    if isinstance(imp, dict) and imp.get("source_path"):
        return str(imp["source_path"])
    if getattr(item, "storage_mode", "managed") == "external_reference":
        return str(item.absolute_path)
    return None


def _extract_source_mtime_ns(item: models.Item) -> int | None:
    attrs = getattr(item, "attributes", None) or {}
    imp = attrs.get("import") if isinstance(attrs, dict) else None
    if isinstance(imp, dict) and imp.get("source_mtime_ns") is not None:
        try:
            return int(imp["source_mtime_ns"])
        except (TypeError, ValueError):
            return None
    return None


def _ensure_mirror_folder_chain(
    db: Session,
    vault: models.Vault,
    mirror: models.VaultMirror,
) -> models.FolderItem:
    """Ensure the folder chain for ``mirror.target_folder_path`` exists in DB (and on disk for distill_copy)."""
    store = vaults.vault_store(vault).resolve()
    source_root = Path(mirror.source_path).resolve()
    rel_parts = [p for p in mirror.target_folder_path.replace("\\", "/").strip("/").split("/") if p]
    if not rel_parts:
        rel_parts = [source_root.name or "Mirror"]

    parent_id: int | None = None
    current_folder: models.FolderItem | None = None
    storage_mode = "external_reference" if mirror.mode == "reference_1to1" else "managed"

    for idx, part in enumerate(rel_parts):
        is_last = idx == len(rel_parts) - 1
        if mirror.mode == "reference_1to1" and is_last:
            folder_abs = str(source_root)
            folder_src = str(source_root)
        else:
            sub_rel = Path(*rel_parts[: idx + 1])
            phys_dir = (store / sub_rel).resolve()
            if mirror.mode == "distill_copy" or not is_last:
                phys_dir.mkdir(parents=True, exist_ok=True)
            folder_abs = str(phys_dir)
            folder_src = str(source_root) if is_last else str(phys_dir)

        existing = None
        if is_last and mirror.root_item_id:
            existing = (
                db.query(models.FolderItem)
                .filter(
                    models.FolderItem.id == mirror.root_item_id,
                    models.FolderItem.vault_id == vault.id,
                )
                .first()
            )
        if not existing:
            candidates = (
                db.query(models.FolderItem)
                .filter(
                    models.FolderItem.vault_id == vault.id,
                    models.FolderItem.parent_id == parent_id,
                )
                .all()
            )
            for cand in candidates:
                cand_title = getattr(cand, "title", None) or Path(cand.absolute_path).name
                if (
                    _norm_path(cand.absolute_path) == _norm_path(folder_abs)
                    or cand_title.casefold() == part.casefold()
                ):
                    existing = cand
                    break

        if existing:
            attrs = dict(existing.attributes or {})
            if is_last:
                attrs["mirror_id"] = mirror.id
                attrs["mirror_mode"] = mirror.mode
                attrs["is_folder"] = True
                existing.attributes = attrs
                if not existing.source_path:
                    existing.source_path = folder_src
            current_folder = existing
            parent_id = existing.id
        else:
            attrs: dict[str, Any] = {
                "is_folder": True,
                "profile_id": "folder",
                "profile_label": "Folder",
            }
            if is_last:
                attrs["mirror_id"] = mirror.id
                attrs["mirror_mode"] = mirror.mode
            current_folder = models.FolderItem(
                absolute_path=folder_abs,
                vault_id=vault.id,
                parent_id=parent_id,
                title=part,
                source_kind="folder" if storage_mode == "external_reference" else "managed",
                source_path=folder_src,
                content_count=0,
                type="folder",
                storage_mode=storage_mode if is_last else "managed",
                availability="ready",
                metadata_json=json.dumps(attrs),
            )
            db.add(current_folder)
            db.flush()
            parent_id = current_folder.id

    assert current_folder is not None
    mirror.root_item_id = current_folder.id
    db.flush()
    return current_folder


def _ensure_1to1_subfolder(
    db: Session,
    vault_id: int,
    root_folder: models.FolderItem,
    source_root: Path,
    rel_dir: str,
    folder_cache: dict[str, models.FolderItem],
) -> models.FolderItem:
    clean_rel = rel_dir.replace("\\", "/").strip("/")
    if not clean_rel or clean_rel == ".":
        return root_folder
    cache_key = clean_rel.casefold()
    if cache_key in folder_cache:
        return folder_cache[cache_key]

    parts = [p for p in clean_rel.split("/") if p and p != "."]
    current_parent = root_folder
    accumulated: list[str] = []
    for part in parts:
        accumulated.append(part)
        sub_rel = "/".join(accumulated)
        sub_key = sub_rel.casefold()
        if sub_key in folder_cache:
            current_parent = folder_cache[sub_key]
            continue

        ext_dir_path = (source_root / Path(*accumulated)).resolve()
        existing = (
            db.query(models.FolderItem)
            .filter(
                models.FolderItem.vault_id == vault_id,
                models.FolderItem.parent_id == current_parent.id,
            )
            .all()
        )
        matched = None
        for cand in existing:
            cand_name = getattr(cand, "title", None) or Path(cand.absolute_path).name
            if (
                _norm_path(cand.absolute_path) == _norm_path(ext_dir_path)
                or cand_name.casefold() == part.casefold()
            ):
                matched = cand
                break

        if not matched:
            matched = models.FolderItem(
                absolute_path=str(ext_dir_path),
                vault_id=vault_id,
                parent_id=current_parent.id,
                title=part,
                source_kind="folder",
                source_path=str(ext_dir_path),
                content_count=0,
                type="folder",
                storage_mode="external_reference",
                availability="ready",
                metadata_json=json.dumps({
                    "is_folder": True,
                    "profile_id": "folder",
                    "profile_label": "Folder",
                }),
            )
            db.add(matched)
            db.flush()

        folder_cache[sub_key] = matched
        current_parent = matched

    return current_parent


def _build_leaf_item(
    db: Session,
    *,
    file_path: Path,
    source_path: Path,
    vault_id: int,
    parent_id: int | None,
    storage_mode: str,
    mirror_id: int,
    stat_res: os.stat_result,
    file_hash: str | None = None,
    extra_import_attrs: dict[str, Any] | None = None,
) -> models.Item:
    ext = file_path.suffix.lower()
    mime_type = mimetypes.guess_type(str(file_path))[0]
    analysis = text_analyzer.analyze_path(str(file_path), duration_seconds=None)

    import_meta: dict[str, Any] = {
        "source_path": str(source_path.resolve()),
        "source_mtime_ns": stat_res.st_mtime_ns,
        "mirror_id": mirror_id,
    }
    if extra_import_attrs:
        import_meta.update(extra_import_attrs)

    attrs: dict[str, Any] = {
        "import": import_meta,
        "analysis": {
            "is_loop": bool(analysis.get("is_loop")),
            "bpm": analysis.get("bpm"),
            "key": analysis.get("key"),
        },
    }

    common = {
        "absolute_path": str(file_path.resolve()),
        "vault_id": vault_id,
        "parent_id": parent_id,
        "storage_mode": storage_mode,
        "availability": "ready",
        "file_hash": file_hash,
        "size_bytes": stat_res.st_size,
        "mime_type": mime_type,
        "attributes": attrs,
    }

    if ext in collection_importer.MIDI_EXTENSIONS:
        try:
            midi_vals = midi_parser.parse_midi_file(str(file_path))
        except Exception:
            midi_vals = {}
        schema: schemas.ItemCreate = schemas.MidiItemCreate(
            **common,
            bpm=midi_vals.get("bpm") or analysis.get("bpm"),
            key=midi_vals.get("key") or analysis.get("key"),
        )
    elif ext == ".seq":
        schema = schemas.ItemCreate(**common, type="sequence")
    elif ext in collection_importer.AUDIO_EXTENSIONS:
        schema = schemas.SampleItemCreate(
            **common,
            bpm=analysis.get("bpm"),
            key=analysis.get("key"),
            is_loop=bool(analysis.get("is_loop")),
        )
    else:
        schema = schemas.ItemCreate(**common, type="item")

    item = crud.create_item(db, schema, commit=False, flush=True)
    tags = analysis.get("tags") or []
    if tags:
        crud.set_item_tags(db, item.id, tags, commit=False)
    return item


def _refresh_folder_counts(db: Session, vault_id: int) -> None:
    folders = (
        db.query(models.FolderItem)
        .filter(models.FolderItem.vault_id == vault_id)
        .all()
    )
    if not folders:
        return
    children_by_parent: dict[int, list[models.Item]] = {}
    all_items = (
        db.query(models.Item)
        .filter(models.Item.vault_id == vault_id, models.Item.parent_id.isnot(None))
        .all()
    )
    for item in all_items:
        if item.parent_id is not None:
            children_by_parent.setdefault(item.parent_id, []).append(item)

    folder_by_id = {f.id: f for f in folders}

    def count_leaves(fid: int, visited: set[int]) -> int:
        if fid in visited:
            return 0
        visited.add(fid)
        total = 0
        for child in children_by_parent.get(fid, []):
            if child.id in folder_by_id:
                total += count_leaves(child.id, visited)
            else:
                total += 1
        return total

    for folder in folders:
        if isinstance(folder, models.ProjectItem):
            continue
        folder.content_count = count_leaves(folder.id, set())


def list_vault_mirrors(db: Session, vault_id: int) -> list[models.VaultMirror]:
    return (
        db.query(models.VaultMirror)
        .filter(models.VaultMirror.vault_id == vault_id)
        .order_by(models.VaultMirror.id.asc())
        .all()
    )


def create_mirror(
    db: Session,
    vault_id: int,
    payload: schemas.VaultMirrorCreate,
    *,
    commit: bool = True,
    sync_immediately: bool = True,
) -> models.VaultMirror:
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")

    raw_source = (payload.source_path or "").strip()
    if not raw_source:
        raise ValueError("Mirror source path cannot be empty")
    source_path = Path(raw_source).expanduser().resolve()
    if source_path.exists() and not source_path.is_dir():
        raise ValueError("Mirrored path must be a folder")

    store = vaults.vault_store(vault).resolve()
    if (
        _norm_path(source_path) == _norm_path(store)
        or reconciler._is_relative_to(source_path, store)
        or reconciler._is_relative_to(store, source_path)
    ):
        raise ValueError("Cannot mirror a folder inside the vault's own storage directory")

    for existing in list_vault_mirrors(db, vault_id):
        if _norm_path(existing.source_path) == _norm_path(source_path):
            raise ValueError("This folder is already mirrored in this vault")

    target_folder_path = _clean_rel_folder_path(payload.target_folder_path, source_path.name)
    mirror = models.VaultMirror(
        vault_id=vault_id,
        source_path=str(source_path),
        target_folder_path=target_folder_path,
        mode=payload.mode,
        enabled=bool(payload.enabled),
    )
    db.add(mirror)
    db.flush()

    _ensure_mirror_folder_chain(db, vault, mirror)

    if sync_immediately and mirror.enabled and source_path.is_dir():
        sync_mirror(db, mirror, commit=False)

    if commit:
        db.commit()
        db.refresh(mirror)
    return mirror


def update_mirror(
    db: Session,
    vault_id: int,
    mirror_id: int,
    payload: schemas.VaultMirrorUpdate,
) -> models.VaultMirror:
    mirror = (
        db.query(models.VaultMirror)
        .filter(
            models.VaultMirror.id == mirror_id,
            models.VaultMirror.vault_id == vault_id,
        )
        .first()
    )
    if not mirror:
        raise ValueError("Mirror not found")

    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise ValueError("Vault not found")

    if payload.target_folder_path is not None:
        mirror.target_folder_path = _clean_rel_folder_path(
            payload.target_folder_path,
            Path(mirror.source_path).name,
        )
    if payload.mode is not None:
        mirror.mode = payload.mode
    if payload.enabled is not None:
        mirror.enabled = bool(payload.enabled)

    _ensure_mirror_folder_chain(db, vault, mirror)
    db.commit()
    db.refresh(mirror)
    return mirror


def delete_mirror(
    db: Session,
    vault_id: int,
    mirror_id: int,
    *,
    untrack_uncollected: bool = True,
) -> dict[str, Any]:
    mirror = (
        db.query(models.VaultMirror)
        .filter(
            models.VaultMirror.id == mirror_id,
            models.VaultMirror.vault_id == vault_id,
        )
        .first()
    )
    if not mirror:
        raise ValueError("Mirror not found")

    root_item_id = mirror.root_item_id
    db.delete(mirror)
    db.flush()

    removed_items = 0
    if untrack_uncollected and root_item_id:
        root_folder = db.query(models.Item).filter(models.Item.id == root_item_id).first()
        if root_folder:
            subtree_ids = {root_folder.id}
            frontier = [root_folder.id]
            while frontier:
                children = [
                    r[0]
                    for r in db.query(models.Item.id)
                    .filter(models.Item.parent_id.in_(frontier))
                    .all()
                    if r[0] not in subtree_ids
                ]
                subtree_ids.update(children)
                frontier = children

            managed_in_subtree = (
                db.query(models.Item.id)
                .filter(
                    models.Item.id.in_(subtree_ids),
                    ~models.Item.type.in_(["folder", "collection"]),
                    models.Item.storage_mode == "managed",
                )
                .count()
            )
            if managed_in_subtree == 0:
                deleted = crud.delete_item(db, root_folder.id, commit=False)
                removed_items = len(deleted)
            else:
                ext_leaves = (
                    db.query(models.Item)
                    .filter(
                        models.Item.id.in_(subtree_ids - {root_folder.id}),
                        ~models.Item.type.in_(["folder", "collection"]),
                        models.Item.storage_mode == "external_reference",
                    )
                    .all()
                )
                for leaf in ext_leaves:
                    try:
                        crud.delete_item(db, leaf.id, commit=False)
                        removed_items += 1
                    except ValueError:
                        pass

    _refresh_folder_counts(db, vault_id)
    db.commit()
    return {"deleted_mirror_id": mirror_id, "removed_items": removed_items}


def _extract_row_source_and_mtime(
    abs_path: str,
    storage_mode: str | None,
    metadata_json: str | None,
) -> tuple[str | None, int | None]:
    """Fast scalar extractor for (source_path, source_mtime_ns) without full ORM hydration."""
    src_path: str | None = None
    mtime_ns: int | None = None
    if metadata_json and ("source_path" in metadata_json or "source_mtime_ns" in metadata_json):
        try:
            meta = json.loads(metadata_json)
            if isinstance(meta, dict):
                direct = meta.get("source_path")
                if direct:
                    src_path = str(direct)
                imp = meta.get("import")
                if not isinstance(imp, dict) and isinstance(meta.get("attributes"), dict):
                    imp = meta["attributes"].get("import")
                if isinstance(imp, dict):
                    if not src_path and imp.get("source_path"):
                        src_path = str(imp["source_path"])
                    if imp.get("source_mtime_ns") is not None:
                        try:
                            mtime_ns = int(imp["source_mtime_ns"])
                        except (TypeError, ValueError):
                            mtime_ns = None
        except Exception:
            pass
    if not src_path and (storage_mode or "managed") == "external_reference":
        src_path = abs_path
    return src_path, mtime_ns


def scan_mirror_discrepancies(
    db: Session,
    mirror: models.VaultMirror,
    *,
    preloaded_rows: list[tuple[Any, ...]] | None = None,
    vault_name: str | None = None,
) -> dict[str, Any]:
    """Scan a single mirrored folder for new, modified, missing, or duplicate files."""
    source_root = Path(mirror.source_path)
    if not mirror.enabled:
        return {
            "mirror_id": mirror.id,
            "vault_id": mirror.vault_id,
            "vault_name": vault_name,
            "source_path": mirror.source_path,
            "target_folder_path": mirror.target_folder_path,
            "mode": mirror.mode,
            "enabled": False,
            "offline": not source_root.is_dir(),
            "in_sync": True,
            "new_files": [],
            "modified_files": [],
            "missing_files": [],
            "exact_duplicates": [],
            "total_discrepancies": 0,
        }

    if not source_root.exists() or not source_root.is_dir():
        return {
            "mirror_id": mirror.id,
            "vault_id": mirror.vault_id,
            "vault_name": vault_name,
            "source_path": mirror.source_path,
            "target_folder_path": mirror.target_folder_path,
            "mode": mirror.mode,
            "enabled": True,
            "offline": True,
            "in_sync": True,
            "new_files": [],
            "modified_files": [],
            "missing_files": [],
            "exact_duplicates": [],
            "total_discrepancies": 0,
        }

    source_root_resolved = source_root.resolve()
    source_root_str = os.path.normpath(str(source_root_resolved))
    source_root_norm = os.path.normcase(source_root_str)
    source_root_prefix = source_root_norm + os.sep

    if preloaded_rows is None:
        preloaded_rows = (
            db.query(
                models.Item.id,
                models.Item.absolute_path,
                models.Item.type,
                models.Item.storage_mode,
                models.Item.availability,
                models.Item.size_bytes,
                models.Item.file_hash,
                models.Item.metadata_json,
            )
            .filter(models.Item.vault_id == mirror.vault_id)
            .all()
        )

    items_by_source: dict[str, list[dict[str, Any]]] = {}
    hashes_by_size: dict[int, set[str]] = {}
    for row in preloaded_rows:
        item_id, abs_path, item_type, storage_mode, availability, size_bytes, file_hash, metadata_json = row
        if item_type in {"folder", "collection", "project", "multitrack", "zoom_h4"}:
            continue
        src, mtime_ns = _extract_row_source_and_mtime(abs_path, storage_mode, metadata_json)
        if src:
            norm_src = os.path.normcase(os.path.normpath(src))
            items_by_source.setdefault(norm_src, []).append({
                "id": item_id,
                "absolute_path": abs_path,
                "source_path": src,
                "storage_mode": storage_mode or "managed",
                "availability": availability or "ready",
                "size_bytes": size_bytes,
                "mtime_ns": mtime_ns,
            })
        if file_hash and size_bytes is not None:
            hashes_by_size.setdefault(int(size_bytes), set()).add(file_hash)

    disk_seen_sources: set[str] = set()
    new_files: list[dict[str, Any]] = []
    modified_files: list[dict[str, Any]] = []
    exact_duplicates: list[dict[str, Any]] = []

    stack = [source_root_str]
    disk_entries: list[tuple[str, str, int, int]] = []
    while stack:
        curr_dir = stack.pop()
        try:
            with os.scandir(curr_dir) as it:
                subdirs: list[str] = []
                for entry in it:
                    name = entry.name
                    if entry.is_dir(follow_symlinks=False):
                        if name not in reconciler.IGNORE_DIRNAMES and not name.startswith((".", ".deleting-")):
                            subdirs.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if name.lower() in reconciler.IGNORE_FILENAMES or name.startswith((".", "._", "~$")):
                            continue
                        ext = os.path.splitext(name)[1].lower()
                        if ext in reconciler.IGNORE_EXTENSIONS:
                            continue
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        disk_entries.append((os.path.normpath(entry.path), name, st.st_size, st.st_mtime_ns))
                for subdir in sorted(subdirs, reverse=True):
                    stack.append(subdir)
        except OSError:
            continue

    disk_entries.sort(key=lambda x: x[0])
    prefix_len = len(source_root_str) + 1

    for norm_file_path, filename, st_size, st_mtime_ns in disk_entries:
        norm_src = os.path.normcase(norm_file_path)
        disk_seen_sources.add(norm_src)
        rel_path = norm_file_path[prefix_len:].replace("\\", "/") if len(norm_file_path) > prefix_len else filename

        tracked_list = items_by_source.get(norm_src)
        if not tracked_list:
            if mirror.mode == "distill_copy" and st_size in hashes_by_size:
                try:
                    candidate_hash = integrity.calculate_file_hash(norm_file_path)
                except Exception:
                    candidate_hash = ""
                if candidate_hash and candidate_hash in hashes_by_size[st_size]:
                    exact_duplicates.append({
                        "source_path": norm_file_path,
                        "relative_path": rel_path,
                        "filename": filename,
                        "size_bytes": st_size,
                        "status": "exact_duplicate",
                        "item_id": None,
                    })
                    continue
            new_files.append({
                "source_path": norm_file_path,
                "relative_path": rel_path,
                "filename": filename,
                "size_bytes": st_size,
                "status": "new",
                "item_id": None,
            })
        else:
            up_to_date = False
            for tracked in tracked_list:
                rec_mtime = tracked["mtime_ns"]
                size_matches = tracked["size_bytes"] == st_size
                if rec_mtime is not None:
                    if size_matches and rec_mtime == st_mtime_ns:
                        up_to_date = True
                        break
                elif size_matches:
                    up_to_date = True
                    break
            if not up_to_date:
                latest = tracked_list[-1]
                modified_files.append({
                    "source_path": norm_file_path,
                    "relative_path": rel_path,
                    "filename": filename,
                    "size_bytes": st_size,
                    "status": "modified",
                    "item_id": latest["id"],
                })

    missing_files: list[dict[str, Any]] = []
    for norm_src, tracked_list in items_by_source.items():
        if norm_src in disk_seen_sources:
            continue
        if not norm_src.startswith(source_root_prefix):
            continue
        for tracked in tracked_list:
            if tracked["storage_mode"] != "external_reference":
                continue
            if tracked["availability"] == "missing":
                continue
            src_norm_path = os.path.normpath(tracked["source_path"] or tracked["absolute_path"])
            rel_p = src_norm_path[prefix_len:].replace("\\", "/") if len(src_norm_path) > prefix_len else os.path.basename(src_norm_path)
            missing_files.append({
                "source_path": src_norm_path,
                "relative_path": rel_p,
                "filename": os.path.basename(src_norm_path),
                "size_bytes": tracked["size_bytes"] or 0,
                "status": "missing",
                "item_id": tracked["id"],
            })

    total = len(new_files) + len(modified_files) + len(missing_files)
    return {
        "mirror_id": mirror.id,
        "vault_id": mirror.vault_id,
        "vault_name": vault_name,
        "source_path": mirror.source_path,
        "target_folder_path": mirror.target_folder_path,
        "mode": mirror.mode,
        "enabled": mirror.enabled,
        "offline": False,
        "in_sync": total == 0,
        "new_files": new_files,
        "modified_files": modified_files,
        "missing_files": missing_files,
        "exact_duplicates": exact_duplicates,
        "total_discrepancies": total,
    }


def sync_mirror(
    db: Session,
    mirror: models.VaultMirror,
    *,
    commit: bool = True,
) -> dict[str, Any]:
    """Synchronize a VaultMirror into its owning vault."""
    vault = vaults.get_vault(db, mirror.vault_id)
    if not vault:
        raise ValueError("Vault not found")

    root_folder = _ensure_mirror_folder_chain(db, vault, mirror)
    scan = scan_mirror_discrepancies(db, mirror)
    if scan["offline"] or not mirror.enabled:
        return {
            "mirror_id": mirror.id,
            "added_count": 0,
            "updated_count": 0,
            "missing_count": 0,
            "skipped_duplicates": 0,
            "offline": scan["offline"],
        }

    source_root = Path(mirror.source_path).resolve()
    added_count = 0
    updated_count = 0
    missing_count = 0
    skipped_duplicates = 0

    if mirror.mode == "reference_1to1":
        folder_cache: dict[str, models.FolderItem] = {}
        for entry in scan["new_files"]:
            src_path = Path(entry["source_path"]).resolve()
            if not src_path.is_file():
                continue
            try:
                stat_res = src_path.stat()
            except OSError:
                continue
            rel_dir = str(Path(entry["relative_path"]).parent).replace("\\", "/")
            parent_folder = _ensure_1to1_subfolder(
                db,
                vault.id,
                root_folder,
                source_root,
                rel_dir,
                folder_cache,
            )
            _build_leaf_item(
                db,
                file_path=src_path,
                source_path=src_path,
                vault_id=vault.id,
                parent_id=parent_folder.id,
                storage_mode="external_reference",
                mirror_id=mirror.id,
                stat_res=stat_res,
            )
            added_count += 1

        for entry in scan["modified_files"]:
            item_id = entry.get("item_id")
            if not item_id:
                continue
            item = db.query(models.Item).filter(models.Item.id == item_id).first()
            src_path = Path(entry["source_path"]).resolve()
            if not item or not src_path.is_file():
                continue
            try:
                stat_res = src_path.stat()
            except OSError:
                continue
            item.size_bytes = stat_res.st_size
            item.availability = "ready"
            item.updated_at = datetime.datetime.utcnow()
            attrs = dict(item.attributes or {})
            imp = dict(attrs.get("import") or {})
            imp["source_mtime_ns"] = stat_res.st_mtime_ns
            imp["mirror_id"] = mirror.id
            attrs["import"] = imp
            item.attributes = attrs
            updated_count += 1

        for entry in scan["missing_files"]:
            item_id = entry.get("item_id")
            if not item_id:
                continue
            item = db.query(models.Item).filter(models.Item.id == item_id).first()
            if item and item.storage_mode == "external_reference":
                item.availability = "missing"
                missing_count += 1

        # Clean up external_reference subfolders under this mirror whose directories no longer exist on disk
        if mirror.root_item_id:
            source_prefix = os.path.normcase(os.path.normpath(str(source_root))) + os.sep
            ext_folders = (
                db.query(models.FolderItem)
                .filter(
                    models.FolderItem.vault_id == vault.id,
                    models.FolderItem.id != mirror.root_item_id,
                    models.FolderItem.storage_mode == "external_reference",
                )
                .all()
            )
            missing_ext_folders = [
                f for f in ext_folders
                if os.path.normcase(os.path.normpath(f.absolute_path)).startswith(source_prefix)
                and not os.path.isdir(f.absolute_path)
            ]
            # Sort deepest first
            missing_ext_folders.sort(key=lambda f: len(f.absolute_path), reverse=True)
            for folder in missing_ext_folders:
                ready_children = (
                    db.query(models.Item.id)
                    .filter(
                        models.Item.parent_id == folder.id,
                        models.Item.availability == "ready",
                    )
                    .count()
                )
                if ready_children == 0:
                    for missing_child in db.query(models.Item).filter(models.Item.parent_id == folder.id).all():
                        missing_child.parent_id = folder.parent_id
                    db.delete(folder)
                    db.flush()

    elif mirror.mode == "distill_copy":
        target_dir = Path(root_folder.absolute_path).resolve()
        target_dir.mkdir(parents=True, exist_ok=True)

        existing_hashes: set[tuple[str, int]] = set()
        for f_hash, f_size in (
            db.query(models.Item.file_hash, models.Item.size_bytes)
            .filter(
                models.Item.vault_id == vault.id,
                models.Item.file_hash.isnot(None),
                models.Item.size_bytes.isnot(None),
            )
            .all()
        ):
            if f_hash and f_size is not None:
                existing_hashes.add((f_hash, int(f_size)))

        for entry in scan["new_files"]:
            src_path = Path(entry["source_path"]).resolve()
            if not src_path.is_file():
                continue
            try:
                stat_res = src_path.stat()
            except OSError:
                continue
            file_hash = integrity.calculate_file_hash(str(src_path))
            if file_hash and (file_hash, stat_res.st_size) in existing_hashes:
                skipped_duplicates += 1
                continue

            destination = _resolve_distill_destination(
                target_dir,
                src_path.name,
                entry["relative_path"],
            )
            shutil.copy2(src_path, destination)
            dest_stat = destination.stat()
            _build_leaf_item(
                db,
                file_path=destination,
                source_path=src_path,
                vault_id=vault.id,
                parent_id=root_folder.id,
                storage_mode="managed",
                mirror_id=mirror.id,
                stat_res=stat_res,
                file_hash=file_hash,
                extra_import_attrs={
                    "distilled_from": entry["relative_path"],
                    "copied_size_bytes": dest_stat.st_size,
                },
            )
            if file_hash:
                existing_hashes.add((file_hash, stat_res.st_size))
            added_count += 1

        for entry in scan["modified_files"]:
            item_id = entry.get("item_id")
            src_path = Path(entry["source_path"]).resolve()
            if not item_id or not src_path.is_file():
                continue
            existing_item = db.query(models.Item).filter(models.Item.id == item_id).first()
            if not existing_item:
                continue
            try:
                stat_res = src_path.stat()
            except OSError:
                continue
            file_hash = integrity.calculate_file_hash(str(src_path))
            if file_hash and existing_item.file_hash == file_hash and existing_item.size_bytes == stat_res.st_size:
                attrs = dict(existing_item.attributes or {})
                imp = dict(attrs.get("import") or {})
                imp["source_mtime_ns"] = stat_res.st_mtime_ns
                attrs["import"] = imp
                existing_item.attributes = attrs
                continue

            # Create a non-destructive .NN version in the same folder as existing_item
            dest_parent_dir = Path(existing_item.absolute_path).resolve().parent
            if not dest_parent_dir.exists():
                dest_parent_dir = target_dir
            version_dest = _next_version_destination(dest_parent_dir, Path(existing_item.absolute_path).name)
            shutil.copy2(src_path, version_dest)
            _build_leaf_item(
                db,
                file_path=version_dest,
                source_path=src_path,
                vault_id=vault.id,
                parent_id=existing_item.parent_id or root_folder.id,
                storage_mode="managed",
                mirror_id=mirror.id,
                stat_res=stat_res,
                file_hash=file_hash,
                extra_import_attrs={
                    "distilled_from": entry["relative_path"],
                    "previous_item_id": existing_item.id,
                },
            )
            updated_count += 1

    mirror.last_synced_at = datetime.datetime.utcnow()
    _refresh_folder_counts(db, vault.id)

    if commit:
        db.commit()
    else:
        db.flush()

    return {
        "mirror_id": mirror.id,
        "added_count": added_count,
        "updated_count": updated_count,
        "missing_count": missing_count,
        "skipped_duplicates": skipped_duplicates,
        "offline": False,
    }

