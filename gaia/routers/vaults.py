from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from typing import List

from .. import database, schemas, vaults

router = APIRouter(prefix="/vaults", tags=["vaults"])

@router.get("/", response_model=List[schemas.Vault])
def read_vaults(db: Session = Depends(database.get_db)):
    return vaults.get_vaults(db)

@router.post("/", response_model=schemas.Vault)
def create_vault(request: schemas.VaultCreate, db: Session = Depends(database.get_db)):
    try:
        return vaults.create_vault(db, request.name.strip(), request.description)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.patch("/{vault_id}", response_model=schemas.Vault)
def update_vault(vault_id: int, request: schemas.VaultUpdate, db: Session = Depends(database.get_db)):
    try:
        return vaults.update_vault(db, vault_id, request.name.strip(), request.description)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.delete("/{vault_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vault(vault_id: int, db: Session = Depends(database.get_db)):
    try:
        vaults.delete_vault(db, vault_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)

@router.get("/{vault_id}/imports", response_model=List[schemas.VaultImportLog])
def read_import_log(vault_id: int, limit: int = 100, db: Session = Depends(database.get_db)):
    if not vaults.get_vault(db, vault_id):
        raise HTTPException(status_code=404, detail="Vault not found")
    return vaults.get_logs(db, vault_id, limit)
