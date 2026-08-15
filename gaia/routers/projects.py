from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import database, project_service, schemas


router = APIRouter(prefix="/projects", tags=["projects"])


def _bad_request(exc: Exception):
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/", response_model=schemas.Item)
def create_project(req: schemas.ProjectCreateRequest, db: Session = Depends(database.get_db)):
    try:
        return project_service.create_project(
            db,
            req.name,
            req.project_type,
            req.vault_id,
        )
    except (ValueError, OSError) as exc:
        _bad_request(exc)


@router.post("/from-items", response_model=list[schemas.Item])
def create_projects_from_items(
    req: schemas.ProjectFromItemsRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.create_from_items(
            db,
            req.item_ids,
            req.mode,
            req.name,
            req.project_type,
            req.vault_id,
        )
    except (ValueError, OSError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/items", response_model=schemas.Item)
def add_items_to_project(
    project_id: int,
    req: schemas.ProjectAddItemsRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.add_items(db, project_id, req.item_ids)
    except (ValueError, OSError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/files", response_model=schemas.Item)
def add_files_to_project(
    project_id: int,
    req: schemas.ProjectAddPathsRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.add_paths(db, project_id, req.source_paths)
    except (ValueError, OSError) as exc:
        _bad_request(exc)
