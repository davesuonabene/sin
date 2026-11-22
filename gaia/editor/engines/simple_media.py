"""Simple Media Editor engine backend (1-channel audio & video trimming/cutting/export)."""

from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import shutil
import subprocess
import threading
from typing import Any
import uuid

import soundfile as sf
from sqlalchemy.orm import Session

from ... import (
    collection_importer,
    crud,
    integrity,
    media_editor,
    models,
    project_manifest,
    project_service,
    reference_service,
    schemas,
    vaults,
)
from ..base import EditorEngine

AUDIO_TYPES = frozenset({"audio", "track", "sample"})
VIDEO_TYPES = frozenset({"video"})
SINGLE_MEDIA_TYPES = AUDIO_TYPES | VIDEO_TYPES
AUDIO_OUTPUT_FORMATS = frozenset({"wav", "mp3"})
VIDEO_OUTPUT_FORMATS = frozenset({"mp4", "mov", "mkv", "webm"})

_MIN_GAIN_DB = -60.0
_MAX_PRE_GAIN_DB = 48.0


def _title(item: models.Item) -> str:
    return getattr(item, "title", None) or Path(item.absolute_path).name


def _target_id(item: models.Item) -> str:
    return f"item:{item.id}"


def _parse_target_item_id(target_id: str | None) -> int | None:
    if not target_id:
        return None
    match = re.fullmatch(r"(?:root|item|stem):(?P<item_id>\d+)", str(target_id).strip())
    return int(match.group("item_id")) if match else None


def _media_kind(item: models.Item) -> str:
    return "video" if item.type in VIDEO_TYPES else "audio"


def _is_derived_child(project: models.ProjectItem, child: models.Item) -> bool:
    try:
        rel = Path(child.absolute_path).resolve().relative_to(Path(project.absolute_path).resolve())
        parts = rel.parts
        return len(parts) >= 2 and parts[0] == "files" and parts[1] in {"cuts", "derived", "mixdown"}
    except ValueError:
        return False


def _expand_item_to_single_targets(
    item: models.Item,
    *,
    role: str,
    allowed_types: frozenset[str],
    seen: set[int],
) -> list[tuple[str, models.Item]]:
    out: list[tuple[str, models.Item]] = []
    if isinstance(item, models.MultitrackItem):
        for child in sorted(item.children or [], key=lambda value: value.absolute_path.casefold()):
            if child.type in allowed_types and child.id not in seen:
                seen.add(child.id)
                out.append((role, child))
        return out
    if item.type in allowed_types and item.id not in seen:
        seen.add(item.id)
        out.append((role, item))
    return out


def _collect_targets(
    db: Session,
    root: models.Item,
    *,
    project_kind: str | None = None,
) -> list[tuple[str, models.Item]]:
    """Collect single-channel playable targets (audio stems or video files)."""
    seen: set[int] = set()
    targets: list[tuple[str, models.Item]] = []

    if isinstance(root, models.ProjectItem):
        kind = project_kind or getattr(root, "project_kind", None) or "audio"
        allowed_types = VIDEO_TYPES if kind == "video" else AUDIO_TYPES
        for reference in reference_service.list_references(db, root.id):
            item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
            if not item:
                continue
            role = "derived" if reference.relation_kind == "derived" else "source"
            targets.extend(
                _expand_item_to_single_targets(item, role=role, allowed_types=allowed_types, seen=seen)
            )
        for child in sorted(root.children or [], key=lambda value: value.absolute_path.casefold()):
            role = "derived" if _is_derived_child(root, child) else "source"
            targets.extend(
                _expand_item_to_single_targets(child, role=role, allowed_types=allowed_types, seen=seen)
            )
        return targets

    if isinstance(root, models.MultitrackItem):
        return _expand_item_to_single_targets(root, role="source", allowed_types=AUDIO_TYPES, seen=seen)

    if root.type in SINGLE_MEDIA_TYPES:
        return [("source", root)]

    if isinstance(root, models.FolderItem):
        allowed_types = VIDEO_TYPES if project_kind == "video" else SINGLE_MEDIA_TYPES
        for child in sorted(root.children or [], key=lambda value: value.absolute_path.casefold()):
            targets.extend(
                _expand_item_to_single_targets(child, role="source", allowed_types=allowed_types, seen=seen)
            )
        return targets

    return []


def _describe_target(item: models.Item, role: str = "source") -> dict[str, Any]:
    kind = _media_kind(item)
    path = Path(item.absolute_path).resolve()
    base: dict[str, Any] = {
        "id": _target_id(item),
        "item_id": item.id,
        "label": _title(item),
        "filename": path.name,
        "type": item.type,
        "media_kind": kind,
        "role": role,
        "storage_mode": getattr(item, "storage_mode", "managed"),
        "stream_url": f"/items/{item.id}/stream",
    }
    if kind == "video":
        video_meta = dict((item.attributes or {}).get("video_metadata") or {})
        if not video_meta and path.is_file():
            video_meta = collection_importer._video_metadata(path)
        duration = video_meta.get("duration_seconds")
        if duration is None:
            duration = ((item.attributes or {}).get("analysis") or {}).get("duration_seconds")
        base.update({
            "waveform_url": None,
            "duration_seconds": float(duration) if duration is not None else None,
            "sample_rate": 1000,
            "channels": None,
            "frames": int(round(float(duration) * 1000)) if duration is not None else None,
            "width": video_meta.get("width"),
            "height": video_meta.get("height"),
            "fps": video_meta.get("fps"),
            "has_audio": bool(video_meta.get("has_audio", True)),
            "video_codec": video_meta.get("video_codec"),
            "audio_codec": video_meta.get("audio_codec"),
        })
        return base

    duration = None
    sample_rate = None
    channels = None
    frames = None
    if path.is_file():
        try:
            info = sf.info(str(path))
            duration = float(info.duration)
            sample_rate = int(info.samplerate)
            channels = int(info.channels)
            frames = int(info.frames)
        except Exception:
            pass
    base.update({
        "waveform_url": f"/items/{item.id}/waveform",
        "duration_seconds": duration,
        "sample_rate": sample_rate,
        "channels": channels,
        "frames": frames,
    })
    return base


def _default_output_format(media_kind: str) -> str:
    return "mp4" if media_kind == "video" else "wav"


def _normalize_target_state(
    target_id: str,
    raw_state: dict[str, Any],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(raw_state, dict):
        raise ValueError(f"Invalid edit state for target '{target_id}'")

    media_kind = descriptor["media_kind"]
    pre_gain_db = float(raw_state.get("pre_gain_db", 0.0) or 0.0)
    if not _MIN_GAIN_DB <= pre_gain_db <= _MAX_PRE_GAIN_DB:
        raise ValueError("Pre-gain must be between -60 and +48 dB")

    volume = float(raw_state.get("volume", 1.0) if raw_state.get("volume") is not None else 1.0)
    if not 0.0 <= volume <= 1.0:
        raise ValueError("Volume must be between 0 and 1")

    target_peak_db = float(raw_state.get("target_peak_db", -1.0) if raw_state.get("target_peak_db") is not None else -1.0)
    if not -60.0 <= target_peak_db <= 0.0:
        raise ValueError("Normalization target must be between -60 and 0 dB")

    output_format = str(raw_state.get("output_format") or _default_output_format(media_kind)).lower()
    allowed_formats = VIDEO_OUTPUT_FORMATS if media_kind == "video" else AUDIO_OUTPUT_FORMATS
    if output_format not in allowed_formats:
        raise ValueError(f"Unsupported output format '{output_format}' for {media_kind}")

    total_frames = int(descriptor.get("frames") or 0)
    sample_rate = int(descriptor.get("sample_rate") or (1000 if media_kind == "video" else 44100))
    duration_sec = descriptor.get("duration_seconds")

    main_start_frame = raw_state.get("main_start_frame")
    main_end_frame = raw_state.get("main_end_frame")
    main_start_sec = raw_state.get("main_start_sec")
    main_end_sec = raw_state.get("main_end_sec")

    if media_kind == "audio":
        if total_frames <= 0:
            raise ValueError(f"Target '{descriptor['label']}' has no readable audio frames")
        start_f = 0 if main_start_frame is None else int(main_start_frame)
        end_f = total_frames if main_end_frame is None else int(main_end_frame)
        if start_f < 0 or end_f <= start_f or end_f > total_frames:
            raise ValueError("Main range is outside the available audio")
        main_start_frame = start_f
        main_end_frame = end_f
        main_start_sec = round(start_f / sample_rate, 6)
        main_end_sec = round(end_f / sample_rate, 6)
    else:
        start_s = 0.0 if main_start_sec is None else float(main_start_sec)
        end_s = (
            float(duration_sec) if (main_end_sec is None and duration_sec is not None)
            else (float(main_end_sec) if main_end_sec is not None else None)
        )
        if start_s < 0:
            raise ValueError("Video main start cannot be negative")
        if end_s is not None:
            if end_s <= start_s:
                raise ValueError("Video main end must be greater than start")
            if duration_sec is not None and end_s > float(duration_sec) + 0.1:
                raise ValueError("Video main range exceeds video duration")
            end_s = min(end_s, float(duration_sec)) if duration_sec is not None else end_s
        main_start_sec = round(start_s, 6)
        main_end_sec = round(end_s, 6) if end_s is not None else None
        main_start_frame = int(round(start_s * 1000))
        main_end_frame = int(round(end_s * 1000)) if end_s is not None else None

    raw_cuts = raw_state.get("cuts") if isinstance(raw_state.get("cuts"), list) else raw_state.get("segments", [])
    if not isinstance(raw_cuts, list):
        raise ValueError("Cuts must be a list")

    normalized_cuts: list[dict[str, Any]] = []
    seen_cut_ids: set[str] = set()
    for idx, cut in enumerate(raw_cuts, start=1):
        if not isinstance(cut, dict):
            raise ValueError("Each cut entry must be an object")
        cut_id = str(cut.get("id") or f"cut-{idx}")
        if cut_id in seen_cut_ids:
            raise ValueError("Cut IDs must be unique")
        seen_cut_ids.add(cut_id)
        label = str(cut.get("label") or f"Cut {idx}").strip() or f"Cut {idx}"

        if media_kind == "audio":
            c_start = int(cut["start_frame"]) if cut.get("start_frame") is not None else int(round(float(cut.get("start_sec") or 0.0) * sample_rate))
            c_end = int(cut["end_frame"]) if cut.get("end_frame") is not None else int(round(float(cut.get("end_sec") or 0.0) * sample_rate))
            if c_start < 0 or c_end <= c_start or c_end > total_frames:
                raise ValueError(f"Cut '{label}' is outside the available audio")
            normalized_cuts.append({
                "id": cut_id,
                "label": label,
                "start_frame": c_start,
                "end_frame": c_end,
                "start_sec": round(c_start / sample_rate, 6),
                "end_sec": round(c_end / sample_rate, 6),
            })
        else:
            c_start_s = float(cut["start_sec"]) if cut.get("start_sec") is not None else (float(cut.get("start_frame") or 0) / 1000.0)
            c_end_s = float(cut["end_sec"]) if cut.get("end_sec") is not None else (float(cut.get("end_frame") or 0) / 1000.0)
            if c_start_s < 0 or c_end_s <= c_start_s:
                raise ValueError(f"Cut '{label}' must have a positive range")
            if duration_sec is not None and c_end_s > float(duration_sec) + 0.1:
                raise ValueError(f"Cut '{label}' exceeds the available video")
            normalized_cuts.append({
                "id": cut_id,
                "label": label,
                "start_frame": int(round(c_start_s * 1000)),
                "end_frame": int(round(c_end_s * 1000)),
                "start_sec": round(c_start_s, 6),
                "end_sec": round(c_end_s, 6),
            })

    view_raw = raw_state.get("view") if isinstance(raw_state.get("view"), dict) else {}
    zoom = float(view_raw.get("waveform_zoom") or view_raw.get("zoom") or 1.0)
    if not 1.0 <= zoom <= 512.0:
        raise ValueError("Zoom must be between 1 and 512")
    view_start_frame = int(view_raw.get("view_start_frame") or 0)
    if view_start_frame < 0 or (total_frames > 0 and view_start_frame >= total_frames):
        view_start_frame = 0
    selected_cut_id = view_raw.get("selected_cut_id") or view_raw.get("selected_segment_id")
    if selected_cut_id is not None and selected_cut_id not in seen_cut_ids:
        selected_cut_id = None

    return {
        "item_id": descriptor["item_id"],
        "target_id": target_id,
        "main_start_frame": main_start_frame,
        "main_end_frame": main_end_frame,
        "main_start_sec": main_start_sec,
        "main_end_sec": main_end_sec,
        "cuts": normalized_cuts,
        "pre_gain_db": pre_gain_db,
        "volume": volume,
        "normalize": bool(raw_state.get("normalize", False)),
        "target_peak_db": target_peak_db,
        "output_format": output_format,
        "view": {
            "waveform_zoom": zoom,
            "view_start_frame": view_start_frame,
            "selected_cut_id": selected_cut_id,
        },
    }


class SimpleMediaEditorEngine(EditorEngine):
    engine_id = "simple_media"

    def default_session_data(self, db: Session, project: models.ProjectItem) -> dict[str, Any]:
        targets = _collect_targets(db, project, project_kind=getattr(project, "project_kind", None))
        source_targets = [item for role, item in targets if role == "source"]
        first_item = source_targets[0] if source_targets else (targets[0][1] if targets else None)
        return {
            "active_target_id": _target_id(first_item) if first_item else None,
            "targets": {},
        }

    def build_project_session(
        self,
        db: Session,
        project: models.ProjectItem,
        target_id: str | None = None,
    ) -> dict[str, Any]:
        target_pairs = _collect_targets(db, project, project_kind=getattr(project, "project_kind", None))
        descriptors = [_describe_target(item, role=role) for role, item in target_pairs]
        by_id = {d["id"]: d for d in descriptors}

        stored = project_manifest.read_project_session(project)
        if isinstance(stored, dict) and stored.get("engine") == self.engine_id:
            data = copy.deepcopy(stored.get("data") or {})
        else:
            data = self.default_session_data(db, project)

        data.setdefault("targets", {})
        if not by_id:
            return {
                "session_data": {"active_target_id": None, "targets": data["targets"]},
                "targets": [],
                "current_target": None,
                "is_empty": True,
                "capabilities": {
                    "cut": False,
                    "volume": False,
                    "normalize": False,
                    "export": False,
                    "checkpoints": True,
                },
            }

        requested_tid = None
        if target_id:
            parsed = _parse_target_item_id(target_id)
            candidate_tid = f"item:{parsed}" if parsed is not None else str(target_id)
            if candidate_tid not in by_id:
                raise ValueError("Editor target is not part of this project")
            requested_tid = candidate_tid
        elif data.get("active_target_id") in by_id:
            requested_tid = str(data["active_target_id"])
        else:
            source_first = next((d["id"] for d in descriptors if d["role"] == "source"), None)
            requested_tid = source_first or descriptors[0]["id"]

        current = by_id[requested_tid]
        data["active_target_id"] = requested_tid
        return {
            "session_data": data,
            "targets": descriptors,
            "current_target": current,
            "is_empty": False,
            "capabilities": {
                "cut": True,
                "volume": current["media_kind"] == "audio" or bool(current.get("has_audio")),
                "normalize": current["media_kind"] == "audio",
                "export": True,
                "render_project": True,
                "checkpoints": True,
            },
        }

    def build_ephemeral_session(
        self,
        db: Session,
        root: models.Item,
        target_id: str | None = None,
    ) -> dict[str, Any]:
        target_pairs = _collect_targets(db, root)
        descriptors = [_describe_target(item, role="source") for _, item in target_pairs]
        by_id = {d["id"]: d for d in descriptors}
        if not by_id:
            raise ValueError("This item has no playable media for the Simple Media Editor")

        requested_tid = None
        if target_id:
            parsed = _parse_target_item_id(target_id)
            candidate_tid = f"item:{parsed}" if parsed is not None else str(target_id)
            if candidate_tid not in by_id:
                raise ValueError("Editor target is not part of this item")
            requested_tid = candidate_tid
        else:
            requested_tid = descriptors[0]["id"]

        current = by_id[requested_tid]
        return {
            "session_data": {
                "active_target_id": requested_tid,
                "targets": {},
            },
            "targets": descriptors,
            "current_target": current,
            "is_empty": False,
            "capabilities": {
                "cut": True,
                "volume": current["media_kind"] == "audio" or bool(current.get("has_audio")),
                "normalize": current["media_kind"] == "audio",
                "export": True,
                "render_project": False,
                "checkpoints": False,
            },
        }

    def validate_and_merge_session(
        self,
        db: Session,
        project: models.ProjectItem,
        incoming_data: dict[str, Any],
        existing_data: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(incoming_data, dict):
            raise ValueError("Simple Media session data must be a JSON object")

        target_pairs = _collect_targets(db, project, project_kind=getattr(project, "project_kind", None))
        descriptors = {_target_id(item): _describe_target(item, role=role) for role, item in target_pairs}

        merged_targets = copy.deepcopy(existing_data.get("targets") or {})
        incoming_targets = incoming_data.get("targets")
        if isinstance(incoming_targets, dict):
            for tid, raw_state in incoming_targets.items():
                norm_tid = f"item:{_parse_target_item_id(str(tid))}" if _parse_target_item_id(str(tid)) is not None else str(tid)
                if norm_tid not in descriptors:
                    raise ValueError(f"Target '{tid}' is not part of this project")
                merged_targets[norm_tid] = _normalize_target_state(norm_tid, raw_state, descriptors[norm_tid])

        # Support direct single-target payload (used during initial promotion)
        if not isinstance(incoming_targets, dict) and (
            incoming_data.get("target_id") is not None or incoming_data.get("item_id") is not None
        ):
            raw_tid = incoming_data.get("target_id") or f"item:{incoming_data.get('item_id')}"
            parsed_id = _parse_target_item_id(str(raw_tid))
            norm_tid = f"item:{parsed_id}" if parsed_id is not None else str(raw_tid)
            if norm_tid not in descriptors:
                raise ValueError(f"Target '{raw_tid}' is not part of this project")
            merged_targets[norm_tid] = _normalize_target_state(norm_tid, incoming_data, descriptors[norm_tid])

        active_target_id = incoming_data.get("active_target_id", existing_data.get("active_target_id"))
        if active_target_id is not None:
            parsed_active = _parse_target_item_id(str(active_target_id))
            norm_active = f"item:{parsed_active}" if parsed_active is not None else str(active_target_id)
            if descriptors and norm_active not in descriptors:
                raise ValueError("Active target is not part of this project")
            active_target_id = norm_active

        return {
            "active_target_id": active_target_id,
            "targets": merged_targets,
        }


def _resolve_export_source(db: Session, request: schemas.MediaExportRequest) -> tuple[models.Item, dict[str, Any]]:
    source = crud.get_item(db, request.source_item_id)
    if not source:
        raise ValueError("Source item not found")
    if isinstance(source, models.MultitrackItem):
        parsed = _parse_target_item_id(request.target_id)
        if parsed is None:
            raise ValueError("Choose one audio stem to export")
        stem = crud.get_item(db, parsed)
        if not stem or stem.parent_id != source.id or stem.type not in AUDIO_TYPES:
            raise ValueError("Selected stem is not part of this multitrack")
        source = stem
    elif isinstance(source, models.FolderItem) and request.target_id:
        parsed = _parse_target_item_id(request.target_id)
        if parsed is not None:
            candidate = crud.get_item(db, parsed)
            if candidate and candidate.type in SINGLE_MEDIA_TYPES:
                source = candidate
    if source.type not in SINGLE_MEDIA_TYPES:
        raise ValueError("Choose one playable audio or video file to export")
    source_path = Path(source.absolute_path).resolve()
    if not source_path.is_file():
        raise ValueError(f"'{_title(source)}' is missing from disk")
    descriptor = _describe_target(source)
    return source, descriptor


def _export_segments_for_request(
    request: schemas.MediaExportRequest,
    descriptor: dict[str, Any],
) -> list[dict[str, Any]]:
    media_kind = descriptor["media_kind"]
    if media_kind == "audio":
        total_frames = int(descriptor.get("frames") or 0)
        sample_rate = int(descriptor.get("sample_rate") or 44100)
        if total_frames <= 0:
            raise ValueError("Source audio has no readable frames")
        if request.segments:
            segments = media_editor._normalize_segments(request.segments, total_frames)
            for seg in segments:
                seg["start_sec"] = seg["start_frame"] / sample_rate
                seg["end_sec"] = seg["end_frame"] / sample_rate
            return segments
        start_f = 0 if request.main_start_frame is None else int(request.main_start_frame)
        end_f = total_frames if request.main_end_frame is None else int(request.main_end_frame)
        if request.main_start_frame is None and request.main_start_sec is not None:
            start_f = int(round(float(request.main_start_sec) * sample_rate))
        if request.main_end_frame is None and request.main_end_sec is not None:
            end_f = int(round(float(request.main_end_sec) * sample_rate))
        if start_f < 0 or end_f <= start_f or end_f > total_frames:
            raise ValueError("Export range is outside the available audio")
        return [{
            "id": "main",
            "start_frame": start_f,
            "end_frame": end_f,
            "start_sec": start_f / sample_rate,
            "end_sec": end_f / sample_rate,
            "label": "main",
        }]

    duration_sec = descriptor.get("duration_seconds")
    if request.segments:
        out = []
        for idx, seg in enumerate(request.segments, start=1):
            s_sec = float(seg.start_frame) / 1000.0
            e_sec = float(seg.end_frame) / 1000.0
            if s_sec < 0 or e_sec <= s_sec:
                raise ValueError(f"Cut segment {seg.id!r} must have a positive range")
            if duration_sec is not None and e_sec > float(duration_sec) + 0.1:
                raise ValueError(f"Cut segment {seg.id!r} exceeds the available video")
            out.append({
                "id": seg.id,
                "start_sec": s_sec,
                "end_sec": e_sec,
                "label": seg.label or f"part-{idx:02d}",
            })
        return out

    start_s = 0.0 if request.main_start_sec is None else float(request.main_start_sec)
    end_s = float(request.main_end_sec) if request.main_end_sec is not None else (
        float(duration_sec) if duration_sec is not None else None
    )
    if start_s < 0 or (end_s is not None and end_s <= start_s):
        raise ValueError("Export range must be positive")
    if duration_sec is not None and end_s is not None and end_s > float(duration_sec) + 0.1:
        raise ValueError("Export range exceeds the available video")
    return [{
        "id": "main",
        "start_sec": start_s,
        "end_sec": end_s,
        "label": "main",
    }]


def _resolve_export_destination_dir(
    db: Session,
    source: models.Item,
    destination: schemas.MediaExportDestination,
) -> tuple[Path, models.Vault | None, int | None, models.ProjectItem | None]:
    mode = destination.mode
    if mode == "project":
        if not destination.project_id:
            raise ValueError("Choose a project before rendering")
        project = db.query(models.ProjectItem).filter(models.ProjectItem.id == destination.project_id).first()
        if not project:
            raise ValueError("Project not found")
        output_dir = project_service.project_stage_directory(project, "cuts")
        return output_dir, vaults.get_vault(db, project.vault_id), project.id, project

    if mode == "external_folder":
        raw_dir = (destination.directory_path or "").strip()
        if not raw_dir:
            raise ValueError("Choose a destination folder on disk")
        directory = Path(raw_dir).resolve()
        if not directory.exists() or not directory.is_dir():
            raise ValueError("Destination folder does not exist on disk")
        return directory, None, None, None

    # mode == "vault" (default): strictly inside vault_store, never beside an external_reference!
    vault = (
        vaults.get_vault(db, destination.vault_id)
        if destination.vault_id is not None
        else vaults.get_vault(db, source.vault_id) or vaults.ensure_default_vault(db)
    )
    if not vault:
        raise ValueError("Destination vault not found")
    store = vaults.vault_store(vault).resolve()
    store.mkdir(parents=True, exist_ok=True)

    if destination.folder_id is not None:
        folder = db.query(models.FolderItem).filter(models.FolderItem.id == destination.folder_id).first()
        if not folder or folder.vault_id != vault.id:
            raise ValueError("Destination folder was not found in the selected vault")
        if isinstance(folder, models.ProjectItem):
            raise ValueError("Use project render mode to save directly inside a project")
        if getattr(folder, "storage_mode", "managed") != "managed":
            raise ValueError("Cannot export into an uncollected external reference folder")
        folder_path = Path(folder.absolute_path).resolve()
        if not project_service._is_within(store, folder_path):
            raise ValueError("Destination folder is outside its owning vault")
        folder_path.mkdir(parents=True, exist_ok=True)
        return folder_path, vault, folder.id, None

    # Default vault folder when folder_id is omitted:
    # Keep managed loose files in their same vault subfolder if outside any project;
    # keep external references (and project-owned sources) strictly in the vault root!
    source_path = Path(source.absolute_path).resolve()
    owning_project = project_service._find_owning_project(db, source)
    if (
        getattr(source, "storage_mode", "managed") == "managed"
        and source.vault_id == vault.id
        and owning_project is None
        and project_service._is_within(store, source_path)
    ):
        return source_path.parent, vault, source.parent_id, None
    return store, vault, None, None


def _plan_export_outputs(
    db: Session,
    source: models.Item,
    descriptor: dict[str, Any],
    request: schemas.MediaExportRequest,
) -> dict[str, Any]:
    media_kind = descriptor["media_kind"]
    output_format = str(request.output_format or _default_output_format(media_kind)).lower()
    allowed = VIDEO_OUTPUT_FORMATS if media_kind == "video" else AUDIO_OUTPUT_FORMATS
    if output_format not in allowed:
        raise ValueError(f"Output format '{output_format}' is not supported for {media_kind}")
    if output_format == "mp3" and not shutil.which("ffmpeg"):
        raise ValueError("MP3 conversion requires FFmpeg")
    if media_kind == "video" and not shutil.which("ffmpeg"):
        raise ValueError("Video export requires FFmpeg")
    if not _MIN_GAIN_DB <= float(request.pre_gain_db) <= _MAX_PRE_GAIN_DB:
        raise ValueError("Pre-gain must be between -60 and +48 dB")
    if not 0.0 <= float(request.volume) <= 1.0:
        raise ValueError("Volume must be between 0 and 1")
    if not -60.0 <= float(request.target_peak_db) <= 0.0:
        raise ValueError("Normalization target must be between -60 and 0 dB")
    if request.destination.bitrate_kbps < 32 or request.destination.bitrate_kbps > 512:
        raise ValueError("MP3 bitrate must be between 32 and 512 kbps")

    segments = _export_segments_for_request(request, descriptor)
    output_dir, vault, parent_id, project = _resolve_export_destination_dir(db, source, request.destination)

    source_path = Path(source.absolute_path).resolve()
    default_base = Path(source.absolute_path).stem or _title(source)
    if request.destination.filename:
        raw_stem = Path(request.destination.filename).stem or request.destination.filename
        base_name = media_editor._clean_name(raw_stem, default_base)
    elif request.destination.mode == "project":
        base_name = media_editor._clean_name(default_base, "export")
    else:
        base_name = media_editor._clean_name(f"{default_base}_export", "export")

    extension = f".{output_format}"
    is_multi = len(segments) > 1 or bool(request.segments)
    plans: list[dict[str, Any]] = []
    for index, segment in enumerate(segments, start=1):
        if is_multi:
            label = media_editor._clean_name(segment.get("label") or f"part-{index:02d}", f"part-{index:02d}")
            filename = f"{base_name}-{label}{extension}"
        else:
            label = str(segment.get("label") or "main")
            filename = f"{base_name}{extension}"
        planned_path = (output_dir / filename).resolve()
        if planned_path == source_path:
            raise ValueError("Export destination cannot overwrite the source file; choose another name or folder")
        plans.append({
            "segment": segment,
            "label": label,
            "base_path": planned_path,
        })

    return {
        "source": source,
        "descriptor": descriptor,
        "media_kind": media_kind,
        "output_format": output_format,
        "segments": segments,
        "output_dir": output_dir,
        "vault": vault,
        "parent_id": parent_id,
        "project": project,
        "plans": plans,
    }


def _path_exists_for_mode(db: Session, path: Path, mode: str) -> bool:
    if mode == "external_folder":
        return path.exists()
    return media_editor._output_path_exists(db, path)


def export_conflicts(db: Session, request: schemas.MediaExportRequest) -> list[dict[str, str]]:
    source, descriptor = _resolve_export_source(db, request)
    planned = _plan_export_outputs(db, source, descriptor, request)
    mode = request.destination.mode
    reserved: set[str] = set()
    conflicts: list[dict[str, str]] = []
    for plan in planned["plans"]:
        path = plan["base_path"]
        key = media_editor._path_key(path)
        if key in reserved or _path_exists_for_mode(db, path, mode):
            conflicts.append({"filename": path.name, "cut_label": plan["label"]})
        reserved.add(key)
    return conflicts


def _next_export_version_path(db: Session, base_path: Path, reserved: set[str], mode: str) -> Path:
    stem = base_path.stem or "export"
    suffix = base_path.suffix
    counter = 2
    while True:
        candidate = base_path.with_name(f"{stem}.{counter}{suffix}")
        if media_editor._path_key(candidate) not in reserved and not _path_exists_for_mode(db, candidate, mode):
            return candidate
        counter += 1


def _render_video_segment(
    source_path: Path,
    segment: dict[str, Any],
    final_path: Path,
    *,
    output_format: str,
    pre_gain_db: float,
    volume: float,
    has_audio: bool,
) -> Path:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise ValueError("Video export requires FFmpeg")
    final_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = final_path.parent / f".{final_path.stem}.{uuid.uuid4().hex}.{output_format}"

    start_sec = max(0.0, float(segment.get("start_sec") or 0.0))
    end_sec = segment.get("end_sec")
    duration_arg: list[str] = []
    if end_sec is not None:
        dur = max(0.01, float(end_sec) - start_sec)
        duration_arg = ["-t", f"{dur:.6f}"]

    gain_db = float(pre_gain_db) + (20.0 * (0.0 if volume <= 0 else __import__("math").log10(volume)) if volume > 0 else -60.0)
    needs_audio_filter = has_audio and (abs(float(pre_gain_db)) > 1e-4 or abs(float(volume) - 1.0) > 1e-4)
    same_container = source_path.suffix.lower() == f".{output_format}"

    try:
        if same_container and not needs_audio_filter:
            copy_cmd = [
                executable, "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{start_sec:.6f}",
                "-i", str(source_path),
                *duration_arg,
                "-c", "copy",
                str(tmp_path),
            ]
            res = subprocess.run(copy_cmd, capture_output=True, text=True, check=False)
            if res.returncode == 0 and tmp_path.is_file():
                tmp_path.replace(final_path)
                return final_path
            tmp_path.unlink(missing_ok=True)

        vcodec = "libvpx-vp9" if output_format == "webm" else "libx264"
        acodec = "libopus" if output_format == "webm" else "aac"
        reencode_cmd = [
            executable, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start_sec:.6f}",
            "-i", str(source_path),
            *duration_arg,
            "-c:v", vcodec,
        ]
        if has_audio:
            if needs_audio_filter:
                reencode_cmd.extend(["-af", f"volume={gain_db:.3f}dB"])
            reencode_cmd.extend(["-c:a", acodec])
        else:
            reencode_cmd.append("-an")
        reencode_cmd.append(str(tmp_path))
        res = subprocess.run(reencode_cmd, capture_output=True, text=True, check=False)
        if res.returncode != 0 or not tmp_path.is_file():
            raise ValueError(res.stderr.strip() or "FFmpeg could not export the video")
        tmp_path.replace(final_path)
        return final_path
    finally:
        tmp_path.unlink(missing_ok=True)


def _render_single_channel_output(
    source: models.Item,
    descriptor: dict[str, Any],
    segment: dict[str, Any],
    final_path: Path,
    request: schemas.MediaExportRequest,
) -> Path:
    source_path = Path(source.absolute_path).resolve()
    if descriptor["media_kind"] == "video":
        return _render_video_segment(
            source_path,
            segment,
            final_path,
            output_format=str(request.output_format),
            pre_gain_db=float(request.pre_gain_db),
            volume=float(request.volume),
            has_audio=bool(descriptor.get("has_audio", True)),
        )

    sample_rate = int(descriptor.get("sample_rate") or 44100)
    layer = {
        "item": source,
        "path": source_path,
        "pre_gain_db": float(request.pre_gain_db),
        "pre_gain_linear": 10.0 ** (float(request.pre_gain_db) / 20.0),
        "volume": float(request.volume),
        "gain_db": 0.0,
        "muted": False,
        "channels": int(descriptor.get("channels") or 2),
        "frames": int(descriptor.get("frames") or 0),
    }
    output_format = str(request.output_format).lower()
    final_path.parent.mkdir(parents=True, exist_ok=True)
    wav_path = final_path.parent / f".{final_path.stem}.{uuid.uuid4().hex}.wav"
    converted_path = final_path.parent / f".{final_path.stem}.{uuid.uuid4().hex}.{output_format}"
    try:
        media_editor._render_mix_wav(
            [layer],
            segment,
            wav_path,
            sample_rate,
            0.0,
            bool(request.normalize),
            float(request.target_peak_db),
        )
        if output_format == "mp3":
            media_editor._convert_mp3(wav_path, converted_path, int(request.destination.bitrate_kbps))
            converted_path.replace(final_path)
        else:
            wav_path.replace(final_path)
        return final_path
    finally:
        wav_path.unlink(missing_ok=True)
        converted_path.unlink(missing_ok=True)


def export_media(db: Session, request: schemas.MediaExportRequest) -> dict[str, Any]:
    """Non-destructively export audio or video cuts to a Vault folder, external disk path, or Project."""
    source, descriptor = _resolve_export_source(db, request)
    planned = _plan_export_outputs(db, source, descriptor, request)
    mode = request.destination.mode
    policy = request.destination.existing_output
    vault = planned["vault"]
    project = planned["project"]
    parent_id = planned["parent_id"]
    media_kind = planned["media_kind"]

    reserved: set[str] = set()
    resolved_plans: list[tuple[dict[str, Any], Path]] = []
    for plan in planned["plans"]:
        base_path = plan["base_path"]
        key = media_editor._path_key(base_path)
        exists = key in reserved or _path_exists_for_mode(db, base_path, mode)
        if exists:
            if policy == "new_version":
                final_path = _next_export_version_path(db, base_path, reserved, mode)
            else:
                raise ValueError(f"{base_path.name} already exists. Choose a new name or New version.")
        else:
            final_path = base_path
        if final_path.resolve() == Path(source.absolute_path).resolve():
            raise ValueError("Export destination cannot overwrite the source file")
        reserved.add(media_editor._path_key(final_path))
        resolved_plans.append((plan["segment"], final_path))

    created_paths: list[Path] = []
    items_out: list[dict[str, Any]] = []
    exported_paths: list[str] = []

    try:
        if mode == "project" and project is not None:
            media_editor._ensure_project_source_link(db, project, source)

        for index, (segment, out_path) in enumerate(resolved_plans, start=1):
            rendered = _render_single_channel_output(source, descriptor, segment, out_path, request)
            created_paths.append(rendered)
            exported_paths.append(str(rendered.resolve()))

            if mode == "external_folder":
                # External disk exports are deliberately NOT registered in GAIA DB.
                continue

            if mode == "project" and project is not None:
                target_type = (
                    "video"
                    if media_kind == "video"
                    else ("sample" if len(resolved_plans) > 1 else (source.type if source.type in AUDIO_TYPES else "audio"))
                )
                artifact, _ = media_editor._register_project_artifact(
                    db,
                    project,
                    source,
                    rendered,
                    target_type,
                    "derived",
                    "cut",
                    "CUT",
                    bool(request.destination.set_master and index == 1),
                    replace_existing=False,
                )
                items_out.append(artifact)
            elif mode == "vault" and vault is not None:
                target_type = (
                    "video"
                    if media_kind == "video"
                    else ("sample" if len(resolved_plans) > 1 else (source.type if source.type in AUDIO_TYPES else "audio"))
                )
                schema, tags = media_editor._artifact_schema(rendered, vault.id, parent_id, target_type)
                artifact = crud.create_item(db, schema, commit=False)
                if tags:
                    crud.set_item_tags(db, artifact.id, tags, commit=False)
                items_out.append(artifact)

        if mode != "external_folder":
            db.commit()
    except Exception:
        db.rollback()
        for p in created_paths:
            p.unlink(missing_ok=True)
        raise

    warnings: list[str] = []
    if mode == "project" and project is not None:
        try:
            project_service.sync_project_manifest(db, project.id)
        except Exception as exc:
            db.rollback()
            warnings.append(f"Project manifest could not be refreshed: {exc}")

    return {
        "mode": mode,
        "project_id": project.id if project else None,
        "vault_id": vault.id if vault else None,
        "registered": mode != "external_folder",
        "exported_paths": exported_paths,
        "items": [crud.item_summary(item) for item in items_out],
        "warnings": warnings,
    }


class ExportJobManager:
    """In-process async queue for non-destructive simple media exports."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gaia-export")

    def create(self, request: schemas.MediaExportRequest) -> dict[str, Any]:
        job_id = uuid.uuid4().hex
        job = {"job_id": job_id, "status": "queued", "progress": 0, "result": None, "error": None}
        with self._lock:
            self._jobs[job_id] = job
        payload = request.model_dump() if hasattr(request, "model_dump") else request.dict()
        self._executor.submit(self._run, job_id, payload)
        return dict(job)

    def _update(self, job_id: str, **values: Any) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(values)

    def _run(self, job_id: str, payload: dict[str, Any]) -> None:
        db = None
        try:
            self._update(job_id, status="running", progress=10)
            req = schemas.MediaExportRequest(**payload)
            from ... import database

            db = database.SessionLocal()
            result = export_media(db, req)
            self._update(job_id, status="completed", progress=100, result=result)
        except Exception as exc:
            self._update(job_id, status="failed", progress=100, error=str(exc))
        finally:
            if db is not None:
                db.close()

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None


simple_media_engine = SimpleMediaEditorEngine()
export_job_manager = ExportJobManager()
