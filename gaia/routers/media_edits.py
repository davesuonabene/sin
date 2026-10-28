from __future__ import annotations

from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
import numpy as np
import uuid
from pathlib import Path
from sqlalchemy.orm import Session

from .. import crud, database, media_editor, models, project_service, schemas


router = APIRouter(tags=["media editor"])


def _bad_request(exc: Exception):
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/items/{item_id}/editor-session")
def read_editor_session(
    item_id: int,
    target_id: str | None = None,
    db: Session = Depends(database.get_db),
):
    try:
        return media_editor.build_editor_session(db, item_id, target_id)
    except ValueError as exc:
        _bad_request(exc)


@router.get("/items/{item_id}/waveform")
def read_item_waveform(
    item_id: int,
    resolution: int = Query(default=1200, ge=64, le=10_000),
    start_frame: int | None = Query(default=None, ge=0),
    end_frame: int | None = Query(default=None, ge=0),
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    try:
        return media_editor.waveform_for_path(
            media_editor._audio_path(item),
            resolution,
            start_frame,
            end_frame,
        )
    except ValueError as exc:
        _bad_request(exc)


@router.get("/items/{item_id}/stems/{stem_index}/waveform")
def read_stem_waveform(
    item_id: int,
    stem_index: int,
    resolution: int = Query(default=1200, ge=64, le=10_000),
    start_frame: int | None = Query(default=None, ge=0),
    end_frame: int | None = Query(default=None, ge=0),
    db: Session = Depends(database.get_db),
):
    try:
        path = media_editor.multitrack_stem_path(db, item_id, stem_index)
        return media_editor.waveform_for_path(path, resolution, start_frame, end_frame)
    except ValueError as exc:
        _bad_request(exc)


@router.post("/media-edits/validate")
def validate_media_edit(
    request: schemas.MediaEditRequest,
    db: Session = Depends(database.get_db),
):
    try:
        validated = media_editor.validate_edit(db, request)
        return {
            "source_item_id": validated["source"].id,
            "active_layer_ids": validated["active_layer_ids"],
            "segments": validated["segments"],
            "sample_rate": validated["sample_rate"],
            "output_format": validated["output_format"],
        }
    except ValueError as exc:
        _bad_request(exc)


@router.post("/media-edits/output-conflicts")
def media_edit_output_conflicts(
    request: schemas.MediaEditRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return {"conflicts": media_editor.project_output_conflicts(db, request)}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/media-edits/render")
def render_media_edit(
    request: schemas.MediaEditRequest,
    db: Session = Depends(database.get_db),
):
    try:
        media_editor.validate_edit(db, request)
        return media_editor.media_job_manager.create(request)
    except ValueError as exc:
        _bad_request(exc)


@router.get("/media-jobs/{job_id}")
def read_media_job(job_id: str):
    job = media_editor.media_job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Media job not found")
    return job


class GraphParamsUpdateRequest(schemas.BaseModel):
    updates: dict[str, Any]


class AddSampleRequest(schemas.BaseModel):
    sample_item_id: int


class SwitchSampleVersionRequest(schemas.BaseModel):
    channel_id: Optional[str] = ""
    node_id: Optional[str] = None
    target_item_id: Optional[int] = None
    sample_item_id: Optional[int] = None


class SnapshotSaveRequest(schemas.BaseModel):
    snapshot: dict[str, Any]
    make_active: bool = False


@router.get("/items/{item_id}/graph")
def read_item_graph(
    item_id: int,
    target_id: str | None = None,
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_item = owning_proj if (owning_proj and owning_proj.id != item.id) else item

    try:
        from .. import graph_builder, project_manifest
        from ermes.py.compiler import compute_auto_layout_positions

        graph = graph_builder.build_item_sin_graph(
            item.id,
            db,
            target_id=target_id,
            master_only=True,
        )
        control_map = graph_builder.get_control_map(graph)
        positions = compute_auto_layout_positions(graph)

        snapshots = []
        view = {}
        owning_proj = project_service._find_owning_project(db, item)
        proj_item = owning_proj or (item if isinstance(item, models.ProjectItem) else None)
        if proj_item:
            doc = project_manifest.read_project_manifest(proj_item)
            snapshots = doc.get("snapshots", [])
            view = doc.get("view", {})

        return {
            "item_id": item.id,
            "graph": graph,
            "snapshots": snapshots,
            "view": view,
            "control_map": control_map,
            "positions": positions,
        }
    except ValueError as exc:
        _bad_request(exc)


@router.put("/items/{item_id}/graph/params")
def update_item_graph_params(
    item_id: int,
    request: GraphParamsUpdateRequest,
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_item = owning_proj if (owning_proj and owning_proj.id != item.id) else item

    try:
        from .. import graph_builder, project_manifest

        graph = graph_builder.build_item_sin_graph(effective_item.id, db)
        updated_graph, applied = graph_builder.apply_control_updates(graph, request.updates)

        if isinstance(effective_item, models.ProjectItem):
            doc = project_manifest.read_project_manifest(effective_item)
            doc["graph"] = updated_graph
            project_manifest.write_project_manifest(effective_item, doc)

        return {
            "status": "ok",
            "applied": applied,
            "graph": updated_graph,
        }
    except ValueError as exc:
        _bad_request(exc)


@router.post("/items/{item_id}/graph/sample")
def add_sample_to_graph(
    item_id: int,
    request: AddSampleRequest,
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    sample_item = crud.get_item(db, request.sample_item_id)
    if not item or not sample_item:
        raise HTTPException(status_code=404, detail="Item or sample not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_project = owning_proj if owning_proj else (item if isinstance(item, models.ProjectItem) else None)
    if not effective_project:
        raise HTTPException(status_code=400, detail="Samples can only be added to a project")

    try:
        from .. import graph_builder

        updated_graph = graph_builder.add_sample_to_project_graph(db, effective_project, sample_item)
        return {"status": "ok", "graph": updated_graph}
    except ValueError as exc:
        _bad_request(exc)


@router.put("/items/{item_id}/graph/sample-version")
def switch_sample_version(
    item_id: int,
    request: SwitchSampleVersionRequest,
    db: Session = Depends(database.get_db),
):
    target_id = request.target_item_id or request.sample_item_id
    if not target_id:
        raise HTTPException(status_code=400, detail="target_item_id or sample_item_id must be provided")
    item = crud.get_item(db, item_id)
    new_sample_item = crud.get_item(db, target_id)
    if not item or not new_sample_item:
        raise HTTPException(status_code=404, detail="Item or target version not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_project = owning_proj if owning_proj else (item if isinstance(item, models.ProjectItem) else None)
    if not effective_project:
        raise HTTPException(status_code=400, detail="Sample versions can only be switched in a project")

    ch_id = request.channel_id or request.node_id or ""
    try:
        from .. import graph_builder

        updated_graph = graph_builder.switch_sample_version_in_graph(
            db, effective_project, ch_id, new_sample_item
        )
        return {"status": "ok", "graph": updated_graph}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/items/{item_id}/snapshots")
def save_item_snapshot(
    item_id: int,
    request: SnapshotSaveRequest,
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_project = owning_proj if owning_proj else (item if isinstance(item, models.ProjectItem) else None)
    if not effective_project:
        raise HTTPException(status_code=400, detail="Snapshots are only supported on projects")

    snap = request.snapshot
    if not isinstance(snap, dict) or not snap.get("id"):
        raise HTTPException(status_code=400, detail="Snapshot must have an 'id'")

    from .. import project_manifest

    doc = project_manifest.read_project_manifest(effective_project)
    snapshots = doc.setdefault("snapshots", [])
    view = doc.setdefault("view", {})

    existing_idx = next((i for i, s in enumerate(snapshots) if s.get("id") == snap["id"]), -1)
    if existing_idx >= 0:
        snapshots[existing_idx] = snap
    else:
        snapshots.append(snap)

    if request.make_active:
        view["selected_snapshot_id"] = snap["id"]

    project_manifest.write_project_manifest(effective_project, doc)
    return {"status": "ok", "snapshots": snapshots, "view": view}


@router.delete("/items/{item_id}/snapshots/{snapshot_id}")
def delete_item_snapshot(
    item_id: int,
    snapshot_id: str,
    db: Session = Depends(database.get_db),
):
    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_project = owning_proj if owning_proj else (item if isinstance(item, models.ProjectItem) else None)
    if not effective_project:
        raise HTTPException(status_code=400, detail="Snapshots are only supported on projects")

    from .. import project_manifest

    doc = project_manifest.read_project_manifest(effective_project)
    snapshots = doc.setdefault("snapshots", [])
    view = doc.setdefault("view", {})

    doc["snapshots"] = [s for s in snapshots if s.get("id") != snapshot_id]
    if view.get("selected_snapshot_id") == snapshot_id:
        view.pop("selected_snapshot_id", None)

    project_manifest.write_project_manifest(effective_project, doc)
    return {"status": "ok", "snapshots": doc["snapshots"], "view": view}


RAM_PREVIEW_STORE: dict[str, dict[str, Any]] = {}


class PreviewRenderRequest(schemas.BaseModel):
    snapshot_id: str | None = None
    transient_overrides: dict[str, Any] | None = None


@router.post("/items/{item_id}/preview/render")
def render_item_preview(
    item_id: int,
    request: PreviewRenderRequest = PreviewRenderRequest(),
    db: Session = Depends(database.get_db),
):
    import io
    import soundfile as sf
    from .. import graph_builder, project_manifest
    from core.shared_dsp import resolve_and_render_graph

    item = crud.get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    owning_proj = project_service._find_owning_project(db, item)
    effective_item = owning_proj if (owning_proj and owning_proj.id != item.id) else item
    project_root = Path(effective_item.absolute_path) if isinstance(effective_item, models.ProjectItem) else None

    graph = graph_builder.build_item_sin_graph(effective_item.id, db)

    snapshot = None
    if request.snapshot_id and isinstance(effective_item, models.ProjectItem):
        doc = project_manifest.read_project_manifest(effective_item)
        for s in doc.get("snapshots", []):
            if s.get("id") == request.snapshot_id:
                snapshot = s
                break

    try:
        audio_out, sr, qa = resolve_and_render_graph(
            base_graph=graph,
            snapshot=snapshot,
            transient_overrides=request.transient_overrides,
            project_root=project_root,
        )

        buf = io.BytesIO()
        sf.write(
            buf,
            np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
            sr,
            format="WAV",
        )
        wav_bytes = buf.getvalue()

        preview_key = f"prev_{effective_item.id}_{uuid.uuid4().hex[:8]}"
        RAM_PREVIEW_STORE[preview_key] = {
            "wav_bytes": wav_bytes,
            "qa": qa,
        }

        return {
            "status": "success",
            "preview_id": preview_key,
            "audio_url": f"/items/{item_id}/preview/stream/{preview_key}",
            "qa": qa,
        }
    except Exception as exc:
        _bad_request(exc)


@router.get("/items/{item_id}/preview/stream/{preview_id}")
def stream_item_preview(item_id: int, preview_id: str, request: Request):
    from fastapi import Response
    import re

    data = RAM_PREVIEW_STORE.get(preview_id)
    if not data:
        raise HTTPException(status_code=404, detail="Preview not found")

    wav_bytes = data["wav_bytes"]
    total_size = len(wav_bytes)
    range_header = request.headers.get("range")
    common_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=120",
    }

    if not range_header:
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={**common_headers, "Content-Length": str(total_size)},
        )

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not match:
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{total_size}"},
        )

    start = int(match.group(1)) if match.group(1) else 0
    end = int(match.group(2)) if match.group(2) else total_size - 1
    end = min(end, total_size - 1)
    chunk = wav_bytes[start : end + 1]

    return Response(
        content=chunk,
        status_code=206,
        media_type="audio/wav",
        headers={
            **common_headers,
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(len(chunk)),
        },
    )


