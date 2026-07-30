from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from .. import crud, schemas, database

router = APIRouter(
    prefix="/collections",
    tags=["collections"],
)

@router.post("/", response_model=schemas.Collection)
def create_collection(collection: schemas.CollectionCreate, db: Session = Depends(database.get_db)):
    return crud.create_collection(db=db, collection=collection)

@router.get("/", response_model=List[schemas.Collection])
def read_collections(skip: int = 0, limit: int = 100, db: Session = Depends(database.get_db)):
    collections = crud.get_collections(db, skip=skip, limit=limit)
    return collections

@router.get("/{collection_id}", response_model=schemas.Collection)
def read_collection(collection_id: int, db: Session = Depends(database.get_db)):
    db_collection = crud.get_collection(db, collection_id=collection_id)
    if db_collection is None:
        raise HTTPException(status_code=404, detail="Collection not found")
    return db_collection
