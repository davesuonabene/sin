"""Shared GAIA media-editor sessions, waveform extraction, and rendering."""

from __future__ import annotations

import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import numpy as np
import soundfile as sf
from sqlalchemy.orm import Session

from . import (
    collection_importer,
    crud,
    integrity,
    models,
    project_manifest,
    project_service,
    reference_service,
    schemas,
)


AUDIO_TYPES = frozenset({"audio", "track", "sample"})
PLAYABLE_TYPES = AUDIO_TYPES | {"multitrack"}
_MAX_WAVEFORM_RESOLUTION = 10_000
_RENDER_BLOCK_FRAMES = 65_536
_MIN_GAIN_DB = -60.0
_MAX_PRE_GAIN_DB = 48.0
_MAX_FADER_GAIN_DB = 10.0
_MIN_VOLUME = 0.0
_MAX_VOLUME = 1.0
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_EDITOR_STATE_SCHEMA = "gaia-media-edit"


def _layer_volume(layer: schemas.MediaEditLayer) -> float:
    """Return the post-fader multiplier, including legacy dB documents."""
    if layer.volume is not None:
        return float(layer.volume)
    legacy_db = 0.0 if layer.gain_db is None else float(layer.gain_db)
    return 10.0 ** (legacy_db / 20.0)


def _validate_layer_settings(layer: schemas.MediaEditLayer) -> float:
    if not _MIN_GAIN_DB <= float(layer.pre_gain_db) <= _MAX_PRE_GAIN_DB:
        raise ValueError("Layer pre-gain must be between -60 and +48 dB")
    if layer.volume is not None:
        volume = float(layer.volume)
        if not _MIN_VOLUME <= volume <= _MAX_VOLUME:
            raise ValueError("Layer volume must be between 0 and 1")
        return volume
    if layer.gain_db is not None and not _MIN_GAIN_DB <= float(layer.gain_db) <= _MAX_FADER_GAIN_DB:
        raise ValueError("Legacy layer fader gain must be between -60 and +10 dB")
    return _layer_volume(layer)


def _title(item: models.Item) -> str:
    return getattr(item, "title", None) or Path(item.absolute_path).name


def _clean_name(value: str, fallback: str = "render") -> str:
    cleaned = _SAFE_NAME.sub("_", (value or "").strip()).strip("._")
    return cleaned[:80] or fallback


def _playable(item: models.Item | None) -> bool:
    return bool(item and item.type in PLAYABLE_TYPES)


def _audio_path(item: models.Item) -> Path:
    path = Path(item.absolute_path).resolve()
    if item.type not in AUDIO_TYPES or not path.is_file():
        raise ValueError(f"'{_title(item)}' is not an available audio file")
    return path


def _child_playables(item: models.FolderItem) -> list[models.Item]:
    return [
        child
        for child in sorted(item.children or [], key=lambda value: value.absolute_path.casefold())
        if child.type in PLAYABLE_TYPES
    ]


def _project_playables(db: Session, project: models.ProjectItem) -> list[models.Item]:
    items: list[models.Item] = []
    seen: set[int] = set()
    for child in sorted(project.children or [], key=lambda value: value.absolute_path.casefold()):
        if _playable(child) and child.id not in seen:
            items.append(child)
            seen.add(child.id)
    for reference in reference_service.list_references(db, project.id):
        item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
        if _playable(item) and item.id not in seen:
            items.append(item)
            seen.add(item.id)
    return items


def _multitrack_layers(item: models.MultitrackItem) -> list[models.Item]:
    return [child for child in _child_playables(item) if child.type in AUDIO_TYPES]


def _owning_multitrack(item: models.Item) -> models.MultitrackItem | None:
    parent = getattr(item, "parent", None)
    return parent if isinstance(parent, models.MultitrackItem) else None


def _layer_descriptor(item: models.Item, active: bool) -> dict[str, Any]:
    # A child Item is the canonical identity for an editable layer.  The
    # multitrack ``stems_json`` snapshot is retained for library metadata and
    # legacy endpoints, but its ordering can be stale after an import repair.
    # Using it as a positional transport lookup can therefore make a valid
    # child such as Zoom's TrMic load the wrong file (or no file at all).
    stream_url = f"/items/{item.id}/stream"
    waveform_url = f"/items/{item.id}/waveform"
    try:
        info = sf.info(str(_audio_path(item)))
        duration = float(info.duration)
        sample_rate = int(info.samplerate)
        channels = int(info.channels)
        frames = int(info.frames)
    except (OSError, RuntimeError, ValueError):
        duration = None
        sample_rate = None
        channels = None
        frames = None
    return {
        "item_id": item.id,
        "label": _title(item),
        "filename": Path(item.absolute_path).name,
        "type": item.type,
        "active": active,
        "stream_url": stream_url,
        "waveform_url": waveform_url,
        "duration_seconds": duration,
        "sample_rate": sample_rate,
        "channels": channels,
        "frames": frames,
    }


def _default_active_layer_ids(layer_items: list[models.Item]) -> list[int]:
    """Activate source stems without layering a recorder-created mixdown.

    Zoom ``TrLR`` files contain a stereo mix of every recorded source track.
    Playing that file alongside ``Tr1``/``Tr2``/``TrMic`` duplicates the same
    signals and makes muting an individual source appear ineffective.  Keep the
    mixdown available as an independently controllable layer, but start it
    muted whenever the import profile identified source channels.  Generic
    multitracks without role metadata retain the all-layers-active fallback.
    """
    source_ids = [
        item.id
        for item in layer_items
        if item.attributes.get("profile_role") == "source_channel"
    ]
    return source_ids or [item.id for item in layer_items]


def _default_project_item(db: Session, project: models.ProjectItem, candidates: list[models.Item]) -> models.Item | None:
    master = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project.id,
            models.ItemReference.is_master.is_(True),
        )
        .first()
    )
    if master:
        item = db.query(models.Item).filter(models.Item.id == master.to_item_id).first()
        if item and item.type in PLAYABLE_TYPES:
            return item
        if isinstance(item, models.FolderItem):
            nested = _child_playables(item)
            if nested:
                return nested[0]
    return candidates[0] if candidates else None


def _target_id_for_item(item: models.Item, is_root_multitrack: bool = False) -> str:
    return f"root:{item.id}" if is_root_multitrack else f"item:{item.id}"


def _target_duration(item: models.Item) -> float | None:
    layer_items = _multitrack_layers(item) if isinstance(item, models.MultitrackItem) else [item]
    durations = []
    for layer in layer_items:
        try:
            durations.append(float(sf.info(str(_audio_path(layer))).duration))
        except (OSError, RuntimeError, ValueError):
            continue
    return min(durations) if durations else None


def build_editor_session(
    db: Session,
    root_id: int,
    target_id: str | None = None,
    *,
    include_saved_state: bool = True,
) -> dict[str, Any]:
    root = crud.get_item(db, root_id)
    if not root:
        raise ValueError("Item not found")

    if root.type in AUDIO_TYPES:
        candidates = [root]
    elif root.type == "multitrack":
        candidates = [root, *_multitrack_layers(root)]
    elif isinstance(root, models.ProjectItem):
        candidates = _project_playables(db, root)
    elif isinstance(root, models.FolderItem):
        candidates = _child_playables(root)
    else:
        raise ValueError("This item has no media editor")

    candidate_by_id = {item.id: item for item in candidates}
    if not candidate_by_id:
        raise ValueError("This folder has no playable media")

    saved_state: dict[str, Any] | None = None
    saved_state_warning: str | None = None
    if isinstance(root, models.ProjectItem) and include_saved_state:
        try:
            saved_state = read_project_editor_state(db, root.id, target_id=target_id)
        except ValueError as exc:
            saved_state_warning = str(exc)
        if not target_id and saved_state:
            saved_target_id = saved_state.get("target_id")
            match = re.fullmatch(r"(?:root|item|stem):(?P<item_id>\d+)", str(saved_target_id or ""))
            if match and int(match.group("item_id")) in candidate_by_id:
                target_id = str(saved_target_id)

    requested_item_id: int | None = None
    if target_id:
        match = re.fullmatch(r"(?:root|item|stem):(?P<item_id>\d+)", target_id)
        if not match:
            raise ValueError("Unknown editor target")
        requested_item_id = int(match.group("item_id"))
        if requested_item_id not in candidate_by_id:
            raise ValueError("Editor target is not part of this session")

    if requested_item_id is not None:
        current = candidate_by_id[requested_item_id]
    elif root.type == "multitrack":
        current = root
    elif isinstance(root, models.ProjectItem):
        current = _default_project_item(db, root, candidates)
    else:
        current = candidates[0]
    if current is None:
        raise ValueError("This folder has no playable media")

    layer_root: models.MultitrackItem | None = None
    if isinstance(current, models.MultitrackItem):
        layer_root = current
        layer_items = _multitrack_layers(current)
        active_ids = _default_active_layer_ids(layer_items)
    elif current.type in AUDIO_TYPES:
        layer_root = _owning_multitrack(current)
        layer_items = [current]
        active_ids = [current.id]
    else:
        layer_items = []
        active_ids = []

    target_key = _target_id_for_item(current, isinstance(current, models.MultitrackItem))
    if isinstance(root, models.ProjectItem) and include_saved_state and (not saved_state or saved_state.get("target_id") != target_key):
        try:
            saved_state = read_project_editor_state(db, root.id, target_id=target_key)
        except ValueError as exc:
            saved_state_warning = str(exc)
    targets: list[dict[str, Any]] = []
    for item in candidates:
        is_multitrack = isinstance(item, models.MultitrackItem)
        if is_multitrack:
            item_layers = _multitrack_layers(item)
            item_active_ids = _default_active_layer_ids(item_layers)
        else:
            item_active_ids = [item.id] if item.type in AUDIO_TYPES else []
        targets.append({
            "id": _target_id_for_item(item, is_multitrack),
            "item_id": item.id,
            "label": _title(item),
            "type": item.type,
            "active_layer_ids": item_active_ids,
            "duration_seconds": _target_duration(item),
        })

    layers = [
        _layer_descriptor(item, item.id in active_ids)
        for item in layer_items
    ]
    durations = [layer["duration_seconds"] for layer in layers if layer.get("duration_seconds") is not None]
    sample_rates = [layer["sample_rate"] for layer in layers if layer.get("sample_rate")]
    result = {
        "session": {
            "root_item_id": root.id,
            "root_type": root.type,
            "title": _title(root),
            "targets": targets,
        },
        "current_target": {
            "id": target_key,
            "item_id": current.id,
            "label": _title(current),
            "active_layer_ids": active_ids,
        },
        "editor": {
            "active_layer_ids": active_ids,
            "capabilities": {
                "cut": bool(layers),
                "volume": bool(layers),
                "normalize": bool(layers),
                "convert_mp3": bool(layers),
                "stem_separation": len(layers) == 1,
            },
            "duration_seconds": min(durations) if durations else None,
            "sample_rate": sample_rates[0] if sample_rates else None,
            "layers": layers,
        },
    }
    if saved_state and saved_state.get("target_id") == target_key:
        result["editor_state"] = saved_state
    else:
        result["editor_state"] = None
    if saved_state_warning:
        result["editor_state_warning"] = saved_state_warning
    return result


def read_project_editor_state(db: Session, project_id: int, target_id: str | None = None) -> dict[str, Any] | None:
    """Read the project's mutable edit document without changing the graph."""
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    document = project_manifest.editor_state_document(project, target_id=target_id)
    if document is None:
        return None
    if document.get("schema") != _EDITOR_STATE_SCHEMA:
        raise ValueError("The saved editor state uses an unknown format")
    try:
        state = schemas.MediaEditorState.model_validate(document)
    except Exception as exc:
        raise ValueError(f"The saved editor state is invalid: {exc}") from exc
    result = state.model_dump()
    result["schema"] = _EDITOR_STATE_SCHEMA
    result["project_id"] = project.id
    result["updated_at"] = document.get("updated_at")
    return result


def _validate_project_editor_state(
    db: Session,
    project: models.ProjectItem,
    state: schemas.MediaEditorState,
) -> tuple[dict[str, Any], models.Item]:
    session = build_editor_session(
        db,
        project.id,
        state.target_id,
        include_saved_state=False,
    )
    current = session["current_target"]
    if int(current["item_id"]) != int(state.source_item_id):
        raise ValueError("The saved source does not match the selected project target")
    source = crud.get_item(db, state.source_item_id)
    if not source:
        raise ValueError("Source item not found")

    available_layers = {
        int(layer["item_id"]): layer
        for layer in session["editor"]["layers"]
    }
    active_ids = list(dict.fromkeys(int(item_id) for item_id in state.active_layer_ids))
    if any(item_id not in available_layers for item_id in active_ids):
        raise ValueError("One or more active layers are not part of the selected target")
    layer_ids = [int(layer.item_id) for layer in state.layers]
    if len(layer_ids) != len(set(layer_ids)) or any(item_id not in available_layers for item_id in layer_ids):
        raise ValueError("Every saved layer must belong to the selected target")
    for layer in state.layers:
        _validate_layer_settings(layer)
    if not _MIN_GAIN_DB <= state.gain_db <= _MAX_PRE_GAIN_DB:
        raise ValueError("Gain must be between -60 and +48 dB")
    if not -60.0 <= state.target_peak_db <= 0.0:
        raise ValueError("Normalization target must be between -60 and 0 dB")

    frame_counts = [int(layer.get("frames") or 0) for layer in available_layers.values()]
    total_frames = min((value for value in frame_counts if value > 0), default=0)
    if total_frames <= 0:
        raise ValueError("The selected target has no readable audio frames")
    start_frame = 0 if state.main_start_frame is None else int(state.main_start_frame)
    end_frame = total_frames if state.main_end_frame is None else int(state.main_end_frame)
    if start_frame < 0 or end_frame <= start_frame or end_frame > total_frames:
        raise ValueError("The saved main range is outside the available audio")
    _normalize_segments(state.segments, total_frames)
    if state.view.waveform_zoom < 1 or state.view.waveform_zoom > 512:
        raise ValueError("Waveform zoom must be between 1 and 512")
    if state.view.view_start_frame < 0 or state.view.view_start_frame >= total_frames:
        raise ValueError("Waveform view start is outside the available audio")
    return session, source


def save_project_editor_state(
    db: Session,
    project_id: int,
    state: schemas.MediaEditorState,
) -> dict[str, Any]:
    """Atomically update one cheap working document for a project.

    This is the project's sole editor document and is stored within the
    project manifest across autosaves and renders.
    """
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise ValueError("Project not found")
    _, source = _validate_project_editor_state(db, project, state)
    document = state.model_dump()
    document.update({
        "schema": _EDITOR_STATE_SCHEMA,
        "project_id": project.id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    manifest_write: dict[str, Any] | None = None
    try:
        _ensure_project_source_link(db, project, source)
        db.flush()
        manifest_write = project_manifest.sync_project_manifest(
            db,
            project.id,
            editor_state=document,
            commit=False,
        )
        db.commit()
    except Exception:
        db.rollback()
        if manifest_write is not None:
            project_manifest.restore_manifest(project, manifest_write["previous"])
        raise
    project_manifest.remove_legacy_markdown(project)
    return document


def _bounded_resolution(value: int | None) -> int:
    return max(64, min(int(value or 1200), _MAX_WAVEFORM_RESOLUTION))


def waveform_for_path(
    path: str | Path,
    resolution: int | None = None,
    start_frame: int | None = None,
    end_frame: int | None = None,
) -> dict[str, Any]:
    audio_path = Path(path).resolve()
    if not audio_path.is_file():
        raise ValueError("Audio file is missing")
    resolution = _bounded_resolution(resolution)
    try:
        with sf.SoundFile(str(audio_path), "r") as source:
            frames = int(len(source))
            sample_rate = int(source.samplerate)
            channels = int(source.channels)
            range_start = max(0, min(frames, int(start_frame or 0)))
            range_end = max(0, min(frames, int(end_frame if end_frame is not None else frames)))
            if range_end <= range_start and frames:
                raise ValueError("Waveform range end must be greater than its start")

            range_frames = range_end - range_start
            bucket_size = max(1, math.ceil(max(1, range_frames) / resolution))
            peaks: list[list[float]] = []
            source.seek(range_start)
            remaining = range_frames
            while remaining > 0:
                chunk = source.read(min(bucket_size, remaining), dtype="float32", always_2d=True)
                if len(chunk) == 0:
                    break
                # Preserve the outer envelope across every channel. Averaging
                # stereo first can cancel opposite-polarity transients and make
                # the editor waveform look deceptively flat.
                peaks.append([float(np.min(chunk)), float(np.max(chunk))])
                remaining -= len(chunk)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"Could not read audio waveform: {exc}") from exc
    return {
        "frames": frames,
        "start_frame": range_start,
        "end_frame": range_end,
        "bucket_size": bucket_size,
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_seconds": frames / sample_rate if sample_rate else 0.0,
        "peaks": peaks,
    }


def multitrack_stem_path(db: Session, item_id: int, stem_index: int) -> Path:
    item = crud.get_item(db, item_id)
    if not isinstance(item, models.MultitrackItem):
        raise ValueError("Item is not a multitrack")
    stems = getattr(item, "stems", []) or []
    if stem_index < 0 or stem_index >= len(stems):
        raise ValueError("Stem index out of range")
    path = Path(stems[stem_index].get("absolute_path", "")).resolve()
    if not path.is_file():
        raise ValueError("Stem file is missing")
    return path


def _audio_info(item: models.Item) -> tuple[Path, int, int, int]:
    path = _audio_path(item)
    try:
        info = sf.info(str(path))
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"Could not inspect '{_title(item)}': {exc}") from exc
    return path, int(info.samplerate), int(info.channels), int(info.frames)


def _normalize_segments(segments: list[schemas.MediaEditSegment], frames: int) -> list[dict[str, Any]]:
    if not segments:
        return [{"id": "full", "start_frame": 0, "end_frame": frames, "label": "full"}]
    result = []
    seen: set[str] = set()
    for index, segment in enumerate(segments, start=1):
        if segment.id in seen:
            raise ValueError("Cut segment IDs must be unique")
        seen.add(segment.id)
        if segment.start_frame < 0 or segment.end_frame <= segment.start_frame:
            raise ValueError(f"Cut segment {segment.id!r} must have a positive range")
        if segment.end_frame > frames:
            raise ValueError(f"Cut segment {segment.id!r} exceeds the available audio")
        result.append({
            "id": segment.id,
            "start_frame": segment.start_frame,
            "end_frame": segment.end_frame,
            "label": segment.label or f"part-{index:02d}",
        })
    return result


def _main_segment(request: schemas.MediaEditRequest, frames: int) -> dict[str, Any]:
    start_frame = 0 if request.main_start_frame is None else int(request.main_start_frame)
    end_frame = frames if request.main_end_frame is None else int(request.main_end_frame)
    if start_frame < 0 or end_frame <= start_frame:
        raise ValueError("Main media range must have a positive range")
    if end_frame > frames:
        raise ValueError("Main media range exceeds the available audio")
    return {
        "id": "main",
        "start_frame": start_frame,
        "end_frame": end_frame,
        "label": "main",
    }


def validate_edit(db: Session, request: schemas.MediaEditRequest) -> dict[str, Any]:
    session = build_editor_session(db, request.source_item_id, request.target_id)
    source = crud.get_item(db, request.source_item_id)
    if not source:
        raise ValueError("Source item not found")
    available_layers = {
        layer["item_id"]: layer
        for layer in session["editor"]["layers"]
    }
    active_ids = list(dict.fromkeys(request.active_layer_ids or session["editor"]["active_layer_ids"]))
    if not active_ids:
        raise ValueError("Activate at least one audio layer")
    if any(item_id not in available_layers for item_id in active_ids):
        raise ValueError("One or more active layers are not part of the selected target")

    layer_settings = {layer.item_id: layer for layer in request.layers}
    resolved_layers: list[dict[str, Any]] = []
    sample_rate: int | None = None
    available_frames: list[int] = []
    for item_id in active_ids:
        item = crud.get_item(db, item_id)
        if not item or item.type not in AUDIO_TYPES:
            raise ValueError("Every active layer must be an audio item")
        path, layer_rate, channels, frames = _audio_info(item)
        if sample_rate is None:
            sample_rate = layer_rate
        elif sample_rate != layer_rate:
            raise ValueError("All active layers must use the same sample rate")
        settings = layer_settings.get(item_id, schemas.MediaEditLayer(item_id=item_id))
        volume = _validate_layer_settings(settings)
        resolved_layers.append({
            "item": item,
            "path": path,
            "pre_gain_db": float(settings.pre_gain_db),
            "pre_gain_linear": 10.0 ** (float(settings.pre_gain_db) / 20.0),
            "volume": volume,
            # Retain the legacy value in the resolved descriptor for callers
            # that still inspect it; rendering uses ``volume`` exclusively.
            "gain_db": float(settings.gain_db or 0.0),
            "muted": bool(settings.muted),
            "channels": channels,
            "frames": frames,
        })
        available_frames.append(frames)

    if not _MIN_GAIN_DB <= request.gain_db <= _MAX_PRE_GAIN_DB:
        raise ValueError("Gain must be between -60 and +48 dB")
    if not -60.0 <= request.target_peak_db <= 0.0:
        raise ValueError("Normalization target must be between -60 and 0 dB")
    if request.destination.bitrate_kbps < 32 or request.destination.bitrate_kbps > 512:
        raise ValueError("MP3 bitrate must be between 32 and 512 kbps")
    if request.output_format == "mp3" and not shutil.which("ffmpeg"):
        raise ValueError("MP3 conversion requires FFmpeg")

    common_frames = min(available_frames)
    main_segment = _main_segment(request, common_frames)
    segments = _normalize_segments(request.segments, common_frames) if request.segments else [main_segment]
    override_target: models.Item | None = None
    if request.destination.mode == "project":
        if not request.destination.project_id:
            raise ValueError("Choose a project before rendering")
        project = db.query(models.ProjectItem).filter(models.ProjectItem.id == request.destination.project_id).first()
        if not project:
            raise ValueError("Project not found")
    else:
        if len(segments) != 1:
            raise ValueError("Multiple cut outputs require a project")
        override_id = request.destination.override_item_id or (
            source.id if source.type in AUDIO_TYPES else None
        )
        if not override_id:
            raise ValueError("Choose the original audio item to override")
        current_target_id = int(session["current_target"]["item_id"])
        if int(override_id) != current_target_id:
            raise ValueError("Only the selected editor target can be overridden")
        target = crud.get_item(db, override_id)
        if not target or target.type not in AUDIO_TYPES:
            raise ValueError("Only one audio file can be overridden")
        extension = Path(target.absolute_path).suffix.lower()
        expected = ".mp3" if request.output_format == "mp3" else ".wav"
        if extension != expected:
            raise ValueError(f"Override requires a {expected[1:].upper()} source file")
        override_target = target

    return {
        "source": source,
        "active_layer_ids": active_ids,
        "layers": resolved_layers,
        "segments": segments,
        "sample_rate": sample_rate or 44_100,
        "output_format": request.output_format,
        "override_target": override_target,
    }


def _to_stereo(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        data = data[:, None]
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    if data.shape[1] == 2:
        return data
    midpoint = data.shape[1] // 2
    left = np.mean(data[:, :midpoint], axis=1)
    right = np.mean(data[:, midpoint:], axis=1)
    return np.column_stack((left, right))


def _scale_wav(source_path: Path, target_path: Path, scale: float, sample_rate: int) -> None:
    with sf.SoundFile(str(source_path), "r") as source, sf.SoundFile(
        str(target_path), "w", samplerate=sample_rate, channels=2, subtype="FLOAT"
    ) as target:
        while True:
            chunk = source.read(_RENDER_BLOCK_FRAMES, dtype="float32", always_2d=True)
            if len(chunk) == 0:
                break
            target.write(np.clip(chunk * scale, -1.0, 1.0))


def _render_mix_wav(layers: list[dict[str, Any]], segment: dict[str, Any], output: Path, sample_rate: int, global_gain_db: float, normalize: bool, target_peak_db: float) -> None:
    readers = []
    peak = 0.0
    global_gain = 10.0 ** (global_gain_db / 20.0)
    try:
        for layer in layers:
            reader = sf.SoundFile(str(layer["path"]), "r")
            reader.seek(segment["start_frame"])
            readers.append((layer, reader))
        frame_count = segment["end_frame"] - segment["start_frame"]
        with sf.SoundFile(str(output), "w", samplerate=sample_rate, channels=2, subtype="FLOAT") as writer:
            remaining = frame_count
            while remaining:
                count = min(_RENDER_BLOCK_FRAMES, remaining)
                mix = np.zeros((count, 2), dtype=np.float32)
                for layer, reader in readers:
                    if layer["muted"]:
                        reader.seek(reader.tell() + count)
                        continue
                    data = reader.read(count, dtype="float32", always_2d=True)
                    if len(data) < count:
                        padded = np.zeros((count, data.shape[1] if data.ndim == 2 and data.shape[1] else 1), dtype=np.float32)
                        padded[:len(data)] = data
                        data = padded
                    # Apply the independent pre-gain in dB, then the post
                    # fader as a bounded linear multiplier.  The fallback
                    # keeps direct callers with legacy resolved dictionaries
                    # working during the state migration.
                    volume = layer.get("volume")
                    if volume is None:
                        volume = 10.0 ** (float(layer.get("gain_db", 0.0)) / 20.0)
                    pre_gain = layer.get("pre_gain_linear")
                    if pre_gain is None:
                        pre_gain = 10.0 ** (float(layer["pre_gain_db"]) / 20.0)
                    gain = pre_gain * volume
                    mix += _to_stereo(data) * gain
                mix *= global_gain
                peak = max(peak, float(np.max(np.abs(mix))) if mix.size else 0.0)
                writer.write(mix if normalize else np.clip(mix, -1.0, 1.0))
                remaining -= count
    finally:
        for _, reader in readers:
            reader.close()

    if normalize and peak > 0.0:
        target_peak = 10.0 ** (target_peak_db / 20.0)
        scale = target_peak / peak
        scaled = output.with_name(f".{output.stem}.{uuid.uuid4().hex}.wav")
        try:
            _scale_wav(output, scaled, scale, sample_rate)
            output.unlink(missing_ok=True)
            scaled.replace(output)
        finally:
            scaled.unlink(missing_ok=True)


def _convert_mp3(wav_path: Path, output_path: Path, bitrate_kbps: int) -> None:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise ValueError("MP3 conversion requires FFmpeg")
    result = subprocess.run(
        [executable, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-b:a", f"{bitrate_kbps}k", str(output_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "FFmpeg could not create the MP3")


def _render_output(
    layers: list[dict[str, Any]],
    segment: dict[str, Any],
    final_path: Path,
    sample_rate: int,
    request: schemas.MediaEditRequest,
) -> Path:
    final_path.parent.mkdir(parents=True, exist_ok=True)
    extension = ".mp3" if request.output_format == "mp3" else ".wav"
    if final_path.suffix.lower() != extension:
        raise ValueError(f"Render output must use the {extension[1:].upper()} extension")
    wav_path = final_path.parent / f".{final_path.stem}.{uuid.uuid4().hex}.wav"
    converted_path = final_path.parent / f".{final_path.stem}.{uuid.uuid4().hex}{extension}"
    try:
        _render_mix_wav(
            layers,
            segment,
            wav_path,
            sample_rate,
            request.gain_db,
            request.normalize,
            request.target_peak_db,
        )
        if request.output_format == "mp3":
            _convert_mp3(wav_path, converted_path, request.destination.bitrate_kbps)
            converted_path.replace(final_path)
        else:
            wav_path.replace(final_path)
        return final_path
    finally:
        wav_path.unlink(missing_ok=True)
        converted_path.unlink(missing_ok=True)


def _artifact_schema(path: Path, vault_id: int, parent_id: int, target_type: str):
    schema, tags = project_service.file_schema_for_path(path, vault_id, parent_id)
    common = schema.model_dump() if hasattr(schema, "model_dump") else schema.dict()
    common["type"] = target_type
    if target_type == "track":
        schema = schemas.TrackItemCreate(**common)
    elif target_type == "sample":
        analysis = common.get("attributes", {}).get("analysis", {})
        schema = schemas.SampleItemCreate(
            **common,
            bpm=analysis.get("bpm"),
            key=analysis.get("key"),
            is_loop=bool(analysis.get("is_loop")),
        )
    elif target_type == "audio":
        schema = schemas.AudioItemCreate(**common)
    else:
        schema = schemas.ItemCreate(**common)
    return schema, tags


def _register_project_artifact(
    db: Session,
    project: models.ProjectItem,
    source: models.Item,
    path: Path,
    target_type: str,
    relation_kind: str,
    stage: str,
    revision_label: str | None,
    is_master: bool,
    *,
    replace_existing: bool = False,
):
    schema, tags = _artifact_schema(path, project.vault_id, project.id, target_type)
    path_value = str(path.resolve())
    existing = db.query(models.Item).filter(models.Item.absolute_path == path_value).first()
    if existing and not replace_existing:
        raise ValueError(f"{path.name} already exists. Choose New version or Override.")
    if existing:
        if existing.parent_id != project.id or existing.vault_id != project.vault_id:
            raise ValueError(f"{path.name} is not a cut owned by this project. Choose New version.")
        if existing.type != target_type:
            raise ValueError(f"{path.name} has a different media type. Choose New version.")
        artifact = existing
        artifact.file_hash = schema.file_hash
        artifact.size_bytes = schema.size_bytes
        artifact.mime_type = schema.mime_type
        artifact.attributes = dict(getattr(schema, "attributes", {}) or {})
        for field in ("key", "bpm", "is_loop"):
            if hasattr(artifact, field) and hasattr(schema, field):
                setattr(artifact, field, getattr(schema, field))
        crud.set_item_tags(db, artifact.id, tags, commit=False)
        reference = (
            db.query(models.ItemReference)
            .filter(
                models.ItemReference.context_id == project.id,
                models.ItemReference.to_item_id == artifact.id,
            )
            .first()
        )
        if reference:
            if is_master:
                db.query(models.ItemReference).filter(
                    models.ItemReference.context_id == project.id,
                    models.ItemReference.is_master.is_(True),
                ).update({models.ItemReference.is_master: False}, synchronize_session=False)
            reference.from_item_id = source.id
            reference.relation_kind = relation_kind
            reference.revision_label = revision_label
            reference.is_master = is_master
            reference.attributes = {"stage": stage, "tags": []}
            db.flush()
        else:
            reference = reference_service.create_reference(
                db,
                schemas.ProjectReferenceCreate(
                    from_item_id=source.id,
                    to_item_id=artifact.id,
                    relation_kind=relation_kind,
                    revision_label=revision_label,
                    is_master=is_master,
                    attributes={"stage": stage},
                ),
                context_id=project.id,
                commit=False,
            )
    else:
        artifact = crud.create_item(db, schema, commit=False)
        if tags:
            crud.set_item_tags(db, artifact.id, tags, commit=False)
        reference = reference_service.create_reference(
            db,
            schemas.ProjectReferenceCreate(
                from_item_id=source.id,
                to_item_id=artifact.id,
                relation_kind=relation_kind,
                revision_label=revision_label,
                is_master=is_master,
                attributes={"stage": stage},
            ),
            context_id=project.id,
            commit=False,
        )
    return artifact, reference


def _path_key(path: Path) -> str:
    return str(path.resolve()).casefold()


def _output_path_exists(db: Session, path: Path) -> bool:
    return path.exists() or bool(
        db.query(models.Item.id)
        .filter(models.Item.absolute_path == str(path.resolve()))
        .first()
    )


def _project_cut_output_plans(
    project: models.ProjectItem,
    request: schemas.MediaEditRequest,
    validated: dict[str, Any],
) -> tuple[Path, str, str, list[dict[str, Any]]]:
    stage = "mixdown" if len(validated["layers"]) > 1 else "cut"
    output_dir = project_service.project_stage_directory(
        project,
        "mixdown" if len(validated["layers"]) > 1 else "cuts",
    )
    primary_item = validated["layers"][0]["item"]
    base_name = _clean_name(Path(primary_item.absolute_path).stem or _title(primary_item))
    extension = ".mp3" if request.output_format == "mp3" else ".wav"
    plans = []
    for index, segment in enumerate(validated["segments"], start=1):
        label = _clean_name(segment.get("label") or f"part-{index:02d}", f"part-{index:02d}")
        plans.append({
            "segment": segment,
            "label": label,
            "base_path": output_dir / f"{base_name}-{label}{extension}",
        })
    return output_dir, stage, base_name, plans


def _project_output_conflicts(
    db: Session,
    project: models.ProjectItem,
    request: schemas.MediaEditRequest,
    validated: dict[str, Any],
) -> list[dict[str, str]]:
    _, _, _, plans = _project_cut_output_plans(project, request, validated)
    reserved: set[str] = set()
    conflicts: list[dict[str, str]] = []
    for plan in plans:
        path = plan["base_path"]
        key = _path_key(path)
        if key in reserved or _output_path_exists(db, path):
            conflicts.append({"filename": path.name, "cut_label": plan["label"]})
        reserved.add(key)
    return conflicts


def project_output_conflicts(db: Session, request: schemas.MediaEditRequest) -> list[dict[str, str]]:
    """Return project cut outputs that would overwrite an existing filename."""
    validated = validate_edit(db, request)
    if request.destination.mode != "project":
        return []
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == request.destination.project_id).first()
    if not project:
        raise ValueError("Project not found")
    return _project_output_conflicts(db, project, request, validated)


def _next_cut_version_path(db: Session, base_path: Path, reserved: set[str]) -> Path:
    stem = base_path.stem or "cut"
    suffix = base_path.suffix
    counter = 2
    while True:
        candidate = base_path.with_name(f"{stem}.{counter}{suffix}")
        if _path_key(candidate) not in reserved and not _output_path_exists(db, candidate):
            return candidate
        counter += 1


def _resolve_cut_output_path(
    db: Session,
    base_path: Path,
    policy: str,
    reserved: set[str],
) -> tuple[Path, bool]:
    key = _path_key(base_path)
    exists = key in reserved or _output_path_exists(db, base_path)
    if not exists:
        return base_path, False
    if policy == "new_version":
        return _next_cut_version_path(db, base_path, reserved), False
    if policy == "override" and key not in reserved:
        return base_path, True
    if policy == "override":
        raise ValueError("Multiple cuts have the same name. Choose New version for this render.")
    raise ValueError(f"{base_path.name} already exists. Choose New version or Override.")


def _ensure_project_source_link(db: Session, project: models.ProjectItem, source: models.Item) -> None:
    exists = (
        db.query(models.ItemReference)
        .filter(
            models.ItemReference.context_id == project.id,
            models.ItemReference.to_item_id == source.id,
        )
        .first()
    )
    if not exists and source.id != project.id:
        reference_service.create_reference(
            db,
            schemas.ProjectReferenceCreate(
                from_item_id=project.id,
                to_item_id=source.id,
                relation_kind="use",
            ),
            context_id=project.id,
            commit=False,
        )


def _render_project(db: Session, request: schemas.MediaEditRequest, validated: dict[str, Any]) -> dict[str, Any]:
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == request.destination.project_id).first()
    if not project:
        raise ValueError("Project not found")
    source = validated["source"]
    _ensure_project_source_link(db, project, source)
    _, stage, _, plans = _project_cut_output_plans(project, request, validated)
    created_paths: list[Path] = []
    backups: dict[Path, Path] = {}
    artifacts = []
    try:
        output_type = (
            "sample" if len(validated["segments"]) > 1 and len(validated["layers"]) == 1
            else "track" if len(validated["layers"]) > 1
            else validated["layers"][0]["item"].type if validated["layers"][0]["item"].type in AUDIO_TYPES else "audio"
        )
        reserved: set[str] = set()
        for index, plan in enumerate(plans, start=1):
            path, replacing = _resolve_cut_output_path(
                db,
                plan["base_path"],
                request.destination.existing_output,
                reserved,
            )
            reserved.add(_path_key(path))
            had_file = path.exists()
            if replacing and had_file:
                backup = path.with_name(f".{path.stem}.gaia-backup-{uuid.uuid4().hex}{path.suffix}")
                try:
                    os.link(path, backup)
                except OSError:
                    shutil.copy2(path, backup)
                backups[path] = backup
            path = _render_output(
                validated["layers"],
                plan["segment"],
                path,
                validated["sample_rate"],
                request,
            )
            if not had_file:
                created_paths.append(path)
            artifact, _ = _register_project_artifact(
                db,
                project,
                source,
                path,
                output_type,
                "derived",
                stage,
                "CUT",
                bool(request.destination.set_master and index == 1),
                replace_existing=replacing,
            )
            artifacts.append(artifact)
        db.commit()
    except Exception:
        db.rollback()
        for path in created_paths:
            path.unlink(missing_ok=True)
        for path, backup in backups.items():
            if backup.exists():
                os.replace(backup, path)
        raise
    finally:
        for backup in backups.values():
            backup.unlink(missing_ok=True)

    warnings: list[str] = []
    try:
        project_service.sync_project_manifest(db, project.id)
    except Exception as exc:
        # The manifest is a disposable projection. A refresh failure
        # must not remove already committed artifacts or graph rows.
        db.rollback()
        warnings.append(f"Project manifest could not be refreshed: {exc}")
    return {
        "project_id": project.id,
        "items": [crud.item_summary(item) for item in artifacts],
        "edit_item_id": None,
        "warnings": warnings,
    }


def _render_override(db: Session, request: schemas.MediaEditRequest, validated: dict[str, Any]) -> dict[str, Any]:
    target = validated.get("override_target")
    if not target:
        raise ValueError("Choose one audio file to override")
    target_path = _audio_path(target)
    parent = target_path.parent
    temporary = parent / f".gaia-override-{target.id}-{uuid.uuid4().hex}{target_path.suffix.lower()}"
    backup = parent / f".gaia-override-backup-{target.id}-{uuid.uuid4().hex}{target_path.suffix.lower()}"
    replaced = False
    committed = False
    try:
        rendered = _render_output(
            validated["layers"],
            validated["segments"][0],
            parent / f".gaia-render-{uuid.uuid4().hex}{target_path.suffix.lower()}",
            validated["sample_rate"],
            request,
        )
        rendered.replace(temporary)
        new_size = temporary.stat().st_size
        new_hash = integrity.calculate_file_hash(str(temporary))
        new_duration = float(sf.info(str(temporary)).duration)
        new_mime_type = mimetypes.guess_type(str(temporary))[0] or target.mime_type
        try:
            os.link(target_path, backup)
        except OSError:
            shutil.copy2(target_path, backup)
        os.replace(temporary, target_path)
        replaced = True
        target.size_bytes = new_size
        target.file_hash = new_hash
        target.mime_type = new_mime_type
        attributes = dict(target.attributes or {})
        analysis = dict(attributes.get("analysis") or {})
        analysis["duration_seconds"] = new_duration
        attributes["analysis"] = analysis
        target.attributes = attributes
        db.commit()
        committed = True
        db.refresh(target)
        warnings: list[str] = []
        try:
            backup.unlink(missing_ok=True)
        except OSError as exc:
            warnings.append(f"The safety backup could not be removed: {exc}")
        return {
            "project_id": None,
            "items": [crud.item_summary(target)],
            "edit_item_id": None,
            "warnings": warnings,
        }
    except Exception:
        db.rollback()
        if replaced and not committed and backup.exists():
            try:
                os.replace(backup, target_path)
            except OSError as restore_error:
                raise RuntimeError(
                    f"Override failed and the original could not be restored; safety backup: {backup}"
                ) from restore_error
        elif not replaced:
            backup.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        raise


def render_edit(db: Session, request: schemas.MediaEditRequest) -> dict[str, Any]:
    validated = validate_edit(db, request)
    if request.destination.mode == "project":
        return _render_project(db, request, validated)
    return _render_override(db, request, validated)


class MediaJobManager:
    """Small in-process render queue matching GAIA's existing job pattern."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gaia-media")

    def create(self, request: schemas.MediaEditRequest) -> dict[str, Any]:
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
            request = schemas.MediaEditRequest(**payload)
            from . import database

            db = database.SessionLocal()
            result = render_edit(db, request)
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


media_job_manager = MediaJobManager()
