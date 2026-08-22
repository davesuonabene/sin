from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, database, models, profiles, project_service, reference_service, schemas


router = APIRouter(prefix="/projects", tags=["projects"])


def _bad_request(exc: Exception):
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/profiles")
def list_profiles():
    try:
        return [
            {
                "id": profile.id,
                "bundle_id": profile.bundle_id,
                "label": profile.label,
                "description": profile.description,
                "container_type": profile.container_type,
            }
            for profile in profiles.discover_profiles()
        ]
    except profiles.ProfileValidationError as exc:
        _bad_request(exc)


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


@router.post("/{project_id}/sources", response_model=schemas.Item)
def add_sources_to_project(
    project_id: int,
    req: schemas.ProjectAddItemsRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.add_items(db, project_id, req.item_ids)
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/adopt-orphans")
def adopt_project_orphans(project_id: int, db: Session = Depends(database.get_db)):
    try:
        return project_service.adopt_orphans(db, project_id)
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/files", response_model=schemas.Item)
def add_files_to_project(
    project_id: int,
    req: schemas.ProjectAddPathsRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return project_service.add_paths(db, project_id, req.source_paths)
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)


@router.get("/{project_id}/referenced-items", response_model=list[schemas.Item])
def get_project_referenced_items(project_id: int, db: Session = Depends(database.get_db)):
    try:
        references = reference_service.list_references(db, project_id)
        items = []
        seen_ids = set()
        for reference in references:
            if reference.to_item_id in seen_ids:
                continue
            item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
            if not item:
                continue
            seen_ids.add(item.id)
            items.append(crud.get_item(db, item.id))
        return items
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.get("/{project_id}/references", response_model=list[schemas.ItemReference])
def get_project_references(project_id: int, db: Session = Depends(database.get_db)):
    try:
        return reference_service.list_references(db, project_id)
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.post("/{project_id}/references", response_model=schemas.ItemReference)
def create_project_reference(
    project_id: int,
    req: schemas.ProjectReferenceCreate,
    db: Session = Depends(database.get_db),
):
    try:
        reference = reference_service.create_reference(db, req, context_id=project_id)
        project_service.regenerate_markdown(db, project_id)
        return reference
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.patch("/{project_id}/references/{reference_id}", response_model=schemas.ItemReference)
def update_project_reference(
    project_id: int,
    reference_id: int,
    req: schemas.ProjectReferenceUpdate,
    db: Session = Depends(database.get_db),
):
    try:
        reference = reference_service.update_reference(db, project_id, reference_id, req)
        project_service.regenerate_markdown(db, project_id)
        return reference
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)


@router.delete("/{project_id}/references/{reference_id}")
def remove_project_reference(
    project_id: int,
    reference_id: int,
    db: Session = Depends(database.get_db),
):
    try:
        reference_service.delete_reference(db, project_id, reference_id)
        project_service.regenerate_markdown(db, project_id)
        return {"status": "deleted", "id": reference_id}
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.post("/{project_id}/references/{reference_id}/master", response_model=schemas.ItemReference)
def set_project_master(
    project_id: int,
    reference_id: int,
    db: Session = Depends(database.get_db),
):
    try:
        reference = reference_service.set_master(db, project_id, reference_id)
        project_service.regenerate_markdown(db, project_id)
        return reference
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.get("/{project_id}/master")
def get_project_master(project_id: int, db: Session = Depends(database.get_db)):
    try:
        return reference_service.resolve_master(db, project_id)
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.get("/{project_id}/graph/{item_id}")
def get_project_graph(
    project_id: int,
    item_id: int,
    db: Session = Depends(database.get_db),
):
    try:
        return reference_service.graph_for_item(db, item_id, project_id)
    except reference_service.ReferenceError as exc:
        _bad_request(exc)


@router.post("/{project_id}/profiles", response_model=list[schemas.ItemReference])
def apply_project_profile(
    project_id: int,
    req: schemas.ProjectProfileApplyRequest,
    db: Session = Depends(database.get_db),
):
    try:
        references = reference_service.apply_profile(
            db,
            project_id,
            req.source_item_id,
            req.profile_id,
            mark_suggested_master=req.mark_suggested_master,
        )
        project_service.regenerate_markdown(db, project_id)
        return references
    except (reference_service.ReferenceError, profiles.ProfileValidationError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/derived", response_model=schemas.ProjectDerivedPathResult)
def register_project_derived_file(
    project_id: int,
    req: schemas.ProjectDerivedPathRequest,
    db: Session = Depends(database.get_db),
):
    try:
        artifact, reference = project_service.register_derived_path(db, project_id, req)
        return {
            "item": schemas.Item.model_validate(artifact),
            "reference": schemas.ItemReference.model_validate(reference),
        }
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)


@router.post("/{project_id}/markdown")
def regenerate_project_markdown(project_id: int, db: Session = Depends(database.get_db)):
    try:
        paths = project_service.regenerate_markdown(db, project_id)
        return {name: str(path) for name, path in paths.items()}
    except (ValueError, OSError, reference_service.ReferenceError) as exc:
        _bad_request(exc)
