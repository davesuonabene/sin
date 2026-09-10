from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from typing import List

from .. import database, reconciler, schemas, vaults

router = APIRouter(prefix="/vaults", tags=["vaults"])

@router.get("/", response_model=List[schemas.Vault])
def read_vaults(preview: str | None = None, db: Session = Depends(database.get_db)):
    records = vaults.get_vaults(db)
    if preview is None:
        return records
    if preview not in {"quick", "lazy", "hidden"}:
        raise HTTPException(status_code=400, detail="Vault preview must be quick, lazy, or hidden")
    return [vault for vault in records if vault.preview == preview]

@router.post("/", response_model=schemas.Vault)
def create_vault(request: schemas.VaultCreate, db: Session = Depends(database.get_db)):
    try:
        return vaults.create_vault(
            db,
            request.name.strip(),
            request.description,
            request.path,
            request.preview,
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.patch("/{vault_id}", response_model=schemas.Vault)
def update_vault(vault_id: int, request: schemas.VaultUpdate, db: Session = Depends(database.get_db)):
    try:
        return vaults.update_vault(
            db,
            vault_id,
            request.name.strip(),
            request.description,
            request.preview,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{vault_id}/migrate", response_model=schemas.Vault)
def migrate_vault(vault_id: int, request: schemas.VaultMigrate, db: Session = Depends(database.get_db)):
    try:
        return vaults.migrate_vault(db, vault_id, request.path)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{vault_id}/place-items")
def place_items_in_vault(
    vault_id: int,
    req: schemas.FolderPlacementRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return vaults.place_items_in_vault(db, vault_id, req.item_ids, req.mode)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.delete("/{vault_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vault(
    vault_id: int,
    background_tasks: BackgroundTasks,
    delete_contents: bool = False,
    db: Session = Depends(database.get_db),
):
    try:
        vaults.delete_vault(
            db,
            vault_id,
            delete_contents=delete_contents,
            background_tasks=background_tasks,
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)

@router.get("/{vault_id}/imports", response_model=List[schemas.VaultImportLog])
def read_import_log(vault_id: int, limit: int = 100, db: Session = Depends(database.get_db)):
    if not vaults.get_vault(db, vault_id):
        raise HTTPException(status_code=404, detail="Vault not found")
    return vaults.get_logs(db, vault_id, limit)


@router.get("/{vault_id}/sync-status", response_model=schemas.VaultSyncStatus)
def read_vault_sync_status(vault_id: int, db: Session = Depends(database.get_db)):
    try:
        return reconciler.scan_vault_discrepancies(db, vault_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{vault_id}/reconcile", response_model=schemas.VaultReconcileResponse)
def reconcile_vault_endpoint(
    vault_id: int,
    request: schemas.VaultReconcileRequest,
    db: Session = Depends(database.get_db),
):
    try:
        return reconciler.reconcile_vault(db, vault_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

