from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from .. import database, models, schemas, crud

router = APIRouter(
    prefix="/playlists",
    tags=["playlists"],
)


@router.get("/", response_model=List[schemas.PlaylistSummary])
def list_playlists(db: Session = Depends(database.get_db)):
    """List all playlists with their item counts."""
    return crud.get_playlists(db)


@router.post("/", response_model=schemas.PlaylistSummary, status_code=status.HTTP_201_CREATED)
def create_playlist(req: schemas.PlaylistCreate, db: Session = Depends(database.get_db)):
    """Create a new horizontal playlist."""
    clean_name = req.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Playlist name cannot be empty")
    existing = crud.get_playlist_by_name(db, clean_name)
    if existing:
        raise HTTPException(status_code=400, detail="A playlist with this name already exists")
    playlist = crud.create_playlist(db, clean_name)
    return {
        "id": playlist.id,
        "name": playlist.name,
        "item_count": 0,
        "created_at": playlist.created_at,
        "updated_at": playlist.updated_at,
    }


@router.get("/{playlist_id}", response_model=schemas.PlaylistDetail)
def read_playlist(playlist_id: int, db: Session = Depends(database.get_db)):
    """Get playlist details and items across all vaults."""
    playlist = crud.get_playlist(db, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    items = crud.get_playlist_items(db, playlist_id)
    return {
        "id": playlist.id,
        "name": playlist.name,
        "item_count": len(items),
        "created_at": playlist.created_at,
        "updated_at": playlist.updated_at,
        "items": items,
    }


@router.patch("/{playlist_id}", response_model=schemas.PlaylistSummary)
def update_playlist(playlist_id: int, req: schemas.PlaylistUpdate, db: Session = Depends(database.get_db)):
    """Rename a playlist."""
    clean_name = req.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Playlist name cannot be empty")
    existing = crud.get_playlist_by_name(db, clean_name)
    if existing and existing.id != playlist_id:
        raise HTTPException(status_code=400, detail="A playlist with this name already exists")
    playlist = crud.update_playlist(db, playlist_id, clean_name)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    count = db.query(models.PlaylistItem).filter(models.PlaylistItem.playlist_id == playlist.id).count()
    return {
        "id": playlist.id,
        "name": playlist.name,
        "item_count": count,
        "created_at": playlist.created_at,
        "updated_at": playlist.updated_at,
    }


@router.delete("/{playlist_id}")
def delete_playlist(playlist_id: int, db: Session = Depends(database.get_db)):
    """Delete a playlist. Contained items in vaults remain completely untouched."""
    success = crud.delete_playlist(db, playlist_id)
    if not success:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return {"ok": True, "deleted_id": playlist_id}


@router.post("/{playlist_id}/items")
def add_items_to_playlist(
    playlist_id: int,
    req: schemas.PlaylistItemAddRequest,
    db: Session = Depends(database.get_db),
):
    """Add arbitrary items or folders into this playlist across vaults."""
    playlist = crud.get_playlist(db, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    added = crud.add_playlist_items(db, playlist_id, req.item_ids)
    return {
        "ok": True,
        "playlist_id": playlist_id,
        "added_count": len(added),
    }


@router.delete("/{playlist_id}/items/{item_id}")
def remove_item_from_playlist(
    playlist_id: int,
    item_id: int,
    db: Session = Depends(database.get_db),
):
    """Remove an item from this playlist."""
    success = crud.remove_playlist_item(db, playlist_id, item_id)
    if not success:
        raise HTTPException(status_code=404, detail="Item not found in playlist")
    return {"ok": True, "playlist_id": playlist_id, "removed_item_id": item_id}


@router.put("/{playlist_id}/reorder")
def reorder_playlist(
    playlist_id: int,
    req: schemas.PlaylistItemReorderRequest,
    db: Session = Depends(database.get_db),
):
    """Update order of items in playlist."""
    playlist = crud.get_playlist(db, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    crud.reorder_playlist_items(db, playlist_id, req.item_ids)
    return {"ok": True, "playlist_id": playlist_id}
