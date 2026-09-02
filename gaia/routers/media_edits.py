from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import crud, database, media_editor, schemas


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
