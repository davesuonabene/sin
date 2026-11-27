"""Decoupled editor session, checkpoint, engine registry, and non-destructive export API."""

from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.realtime_host import RealtimeAudioHost
from .. import catalog, crud, database, graph_builder, models, project_service, schemas, vaults
from ..editor import checkpoints, registry, session_service
from ..editor.engines import simple_media, sin_engine


def _resolve_gaia_project_root(project_id: int | None) -> Path | None:
    if project_id is None:
        return None
    with database.SessionLocal() as db:
        target = catalog.resolve_stream_target(db, int(project_id))
        if target and target.get("absolute_path"):
            return Path(target["absolute_path"])
    return None


def _resolve_gaia_item_path(item_id: int) -> str | None:
    with database.SessionLocal() as db:
        target = catalog.resolve_stream_target(db, int(item_id))
        if target and target.get("availability") == "ready" and target.get("absolute_path"):
            return str(target["absolute_path"])
    return None


gaia_realtime_host = RealtimeAudioHost(
    name="gaia",
    project_root_resolver=_resolve_gaia_project_root,
    item_path_resolver=_resolve_gaia_item_path,
    include_scope=False,
)


class GraphAddItemRequest(BaseModel):
    item_id: int
    crop_start: float = 0.0
    crop_end: float = 1.0
    pre_gain_db: float = 0.0
    volume: float = 1.0
    muted: bool = False
    cuts: list[dict] | None = None
    layers: list[dict] | None = None


router = APIRouter(tags=["editor"])


def _bad_request(exc: Exception):
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/editor/engines")
def list_editor_engines():
    return registry.registry_payload()


@router.get("/editor/realtime/status")
def realtime_status():
    return gaia_realtime_host.status()


@router.websocket("/editor/realtime/ws")
async def realtime_ws(websocket: WebSocket):
    await gaia_realtime_host.handle_websocket(websocket)


@router.get("/editor/sessions/{item_id}")
def open_editor_session(
    item_id: int,
    target_id: str | None = None,
    ephemeral: bool = False,
    db: Session = Depends(database.get_db),
):
    try:
        return session_service.open_session(db, item_id, target_id=target_id, force_ephemeral=ephemeral)
    except ValueError as exc:
        _bad_request(exc)


@router.put("/projects/{project_id}/editor-session")
def save_project_editor_session(
    project_id: int,
    req: schemas.ProjectSessionSaveRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return session_service.save_project_session(db, project_id, req.engine, req.data)
    except ValueError as exc:
        _bad_request(exc)


@router.get("/projects/{project_id}/checkpoints")
def list_project_checkpoints(project_id: int, db: Session = Depends(database.get_db)):
    try:
        return {"project_id": project_id, "checkpoints": checkpoints.list_checkpoints(db, project_id)}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/projects/{project_id}/checkpoints")
def create_project_checkpoint(
    project_id: int,
    req: schemas.ProjectCheckpointCreateRequest = schemas.ProjectCheckpointCreateRequest(),
    db: Session = Depends(database.get_db),
):
    try:
        entry = checkpoints.create_checkpoint(db, project_id, req.label)
        return {"status": "created", "checkpoint": entry}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/projects/{project_id}/checkpoints/{checkpoint_id}/restore")
def restore_project_checkpoint(
    project_id: int,
    checkpoint_id: str,
    db: Session = Depends(database.get_db),
):
    try:
        result = checkpoints.restore_checkpoint(db, project_id, checkpoint_id)
        return {"status": "restored", **result}
    except ValueError as exc:
        _bad_request(exc)


@router.delete("/projects/{project_id}/checkpoints/{checkpoint_id}")
def delete_project_checkpoint(
    project_id: int,
    checkpoint_id: str,
    db: Session = Depends(database.get_db),
):
    try:
        remaining = checkpoints.delete_checkpoint(db, project_id, checkpoint_id)
        return {"status": "deleted", "checkpoints": remaining}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/projects/{project_id}/graph/add-item")
def add_item_to_project_graph(
    project_id: int,
    req: GraphAddItemRequest,
    db: Session = Depends(database.get_db),
):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "editor_engine", "sin") != "sin":
        raise HTTPException(status_code=400, detail="Only SIN projects can load samples into a node graph")
    sample_item = crud.get_item(db, req.item_id)
    if not sample_item:
        raise HTTPException(status_code=404, detail="Item not found")
    try:
        graph_builder.add_sample_to_project_graph(
            db,
            project,
            sample_item,
            crop_start=req.crop_start,
            crop_end=req.crop_end,
            pre_gain_db=req.pre_gain_db,
            volume=req.volume,
            muted=req.muted,
            cuts=req.cuts,
            layers=req.layers,
        )
        return session_service.open_session(db, project_id)
    except ValueError as exc:
        _bad_request(exc)


@router.delete("/projects/{project_id}/graph/channels/{node_id}")
def remove_project_graph_channel(
    project_id: int,
    node_id: str,
    db: Session = Depends(database.get_db),
):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "editor_engine", "sin") != "sin":
        raise HTTPException(status_code=400, detail="Only SIN projects support graph channel removal")
    try:
        graph_builder.remove_channel_from_project_graph(db, project, node_id)
        return session_service.open_session(db, project_id)
    except ValueError as exc:
        _bad_request(exc)


@router.post("/projects/{project_id}/graph/reset")
def reset_project_sin_graph(
    project_id: int,
    db: Session = Depends(database.get_db),
):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "editor_engine", "sin") != "sin":
        raise HTTPException(status_code=400, detail="Only SIN projects support resetting the SIN graph")
    try:
        sin_engine.sin_engine.reset_project_graph(db, project)
        return session_service.open_session(db, project_id)
    except ValueError as exc:
        _bad_request(exc)


@router.post("/projects/{project_id}/snapshots")
def save_project_sin_snapshot(
    project_id: int,
    request: dict,
    db: Session = Depends(database.get_db),
):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "editor_engine", "sin") != "sin":
        raise HTTPException(status_code=400, detail="SIN snapshots are only supported on SIN projects")
    snapshot = request.get("snapshot") if isinstance(request, dict) else None
    make_active = bool(request.get("make_active", False)) if isinstance(request, dict) else False
    try:
        data = sin_engine.sin_engine.save_snapshot(db, project, snapshot, make_active=make_active)
        return {
            "status": "ok",
            "snapshots": data.get("snapshots", []),
            "active_snapshot_id": data.get("active_snapshot_id"),
        }
    except ValueError as exc:
        _bad_request(exc)


@router.delete("/projects/{project_id}/snapshots/{snapshot_id}")
def delete_project_sin_snapshot(
    project_id: int,
    snapshot_id: str,
    db: Session = Depends(database.get_db),
):
    project = db.query(models.ProjectItem).filter(models.ProjectItem.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "editor_engine", "sin") != "sin":
        raise HTTPException(status_code=400, detail="SIN snapshots are only supported on SIN projects")
    try:
        data = sin_engine.sin_engine.delete_snapshot(db, project, snapshot_id)
        return {
            "status": "ok",
            "snapshots": data.get("snapshots", []),
            "active_snapshot_id": data.get("active_snapshot_id"),
        }
    except ValueError as exc:
        _bad_request(exc)


@router.post("/editor/export/conflicts")
def check_export_conflicts(
    req: schemas.MediaExportRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return {"conflicts": simple_media.export_conflicts(db, req)}
    except ValueError as exc:
        _bad_request(exc)


@router.post("/editor/export")
def start_media_export(
    req: schemas.MediaExportRequest,
    db: Session = Depends(database.get_db),
):
    try:
        source, descriptor = simple_media._resolve_export_source(db, req)
        simple_media._plan_export_outputs(db, source, descriptor, req)
        return simple_media.export_job_manager.create(req)
    except ValueError as exc:
        _bad_request(exc)


@router.get("/vaults/{vault_id}/folders")
def list_vault_export_folders(vault_id: int, db: Session = Depends(database.get_db)):
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")
    store = vaults.vault_store(vault).resolve()
    folders = (
        db.query(models.FolderItem)
        .filter(
            models.FolderItem.vault_id == vault.id,
            models.FolderItem.type == "folder",
            models.FolderItem.storage_mode == "managed",
        )
        .order_by(models.FolderItem.absolute_path.asc())
        .all()
    )
    items = []
    for folder in folders:
        if project_service._find_owning_project(db, folder) is not None:
            continue
        if (getattr(folder, "attributes", None) or {}).get("profile_id") == "sample_pack":
            continue
        folder_path = Path(folder.absolute_path).resolve()
        try:
            rel = folder_path.relative_to(store).as_posix()
        except ValueError:
            continue
        items.append({
            "id": folder.id,
            "title": folder.title or folder_path.name,
            "relative_path": rel,
        })
    return {"vault_id": vault.id, "folders": items}
