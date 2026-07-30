from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import List
import os

from .. import crud, schemas, database, integrity, text_analyzer

router = APIRouter(
    prefix="/items",
    tags=["items"],
)

@router.post("/", response_model=schemas.Item)
def create_item(item: schemas.ItemCreate, db: Session = Depends(database.get_db)):
    db_item = crud.get_item_by_path(db, absolute_path=item.absolute_path)
    if db_item:
        raise HTTPException(status_code=400, detail="Item already registered")
    
    if not item.file_hash:
        item.file_hash = integrity.calculate_file_hash(item.absolute_path)
    
    if not item.size_bytes:
        meta = integrity.get_file_metadata(item.absolute_path)
        if meta:
            item.size_bytes = meta.get("size_bytes")
            
    return crud.create_item(db=db, item=item)

@router.get("/", response_model=List[schemas.Item])
def read_items(skip: int = 0, limit: int = 100, db: Session = Depends(database.get_db)):
    items = crud.get_items(db, skip=skip, limit=limit)
    return items

@router.get("/browse")
def browse_folder():
    import subprocess
    
    ps_code = """
Add-Type -AssemblyName System.Windows.Forms
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.Description = "Select Import Directory"
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
if ($fbd.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $fbd.SelectedPath
}
"""
    try:
        result = subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-Command", ps_code], capture_output=True, text=True, check=True)
        folder_path = result.stdout.strip()
        return {"path": folder_path}
    except Exception as e:
        return {"error": str(e) + (result.stderr if 'result' in locals() else '')}

@router.get("/{item_id}", response_model=schemas.Item)
def read_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return db_item

@router.get("/{item_id}/verify")
def verify_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if db_item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    
    is_intact = integrity.verify_file_integrity(db_item.absolute_path, db_item.file_hash)
    return {"id": item_id, "intact": is_intact}

@router.post("/scan")
def scan_directory(req: schemas.DirectoryScanRequest, db: Session = Depends(database.get_db)):
    dir_path = req.directory_path.strip().strip("\"'")
    if not os.path.isdir(dir_path):
        raise HTTPException(status_code=400, detail="Invalid directory path")
    
    supported_extensions = {".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff"}
    imported_items = []
    
    for root, _, files in os.walk(dir_path):
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in supported_extensions:
                abs_path = os.path.join(root, file)
                
                existing = crud.get_item_by_path(db, absolute_path=abs_path)
                if not existing:
                    file_hash = integrity.calculate_file_hash(abs_path)
                    meta = integrity.get_file_metadata(abs_path)
                    size = meta.get("size_bytes") if meta else None
                    
                    analysis = text_analyzer.analyze_path(abs_path)
                    
                    if analysis["type"] == "loop":
                        new_item = schemas.LoopSampleItemCreate(
                            absolute_path=abs_path,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type=f"audio/{ext[1:]}",
                            type="loop",
                            bpm=int(analysis["bpm"]) if analysis["bpm"] else None,
                            key=analysis["key"]
                        )
                    elif analysis["type"] == "one_shot":
                        new_item = schemas.OneShotSampleItemCreate(
                            absolute_path=abs_path,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type=f"audio/{ext[1:]}",
                            type="one_shot",
                            key=analysis["key"]
                        )
                    else:
                        new_item = schemas.SampleItemCreate(
                            absolute_path=abs_path,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type=f"audio/{ext[1:]}",
                            type="sample",
                            key=analysis["key"]
                        )
                        
                    db_item = crud.create_item(db, new_item)
                    
                    if analysis["category"] != "Other":
                        tag = crud.get_or_create_tag(db, analysis["category"])
                        crud.add_tag_to_item(db, item_id=db_item.id, tag_id=tag.id)
                        
                    imported_items.append(db_item)
                    
    return {"imported": len(imported_items)}

@router.post("/{item_id}/tags", response_model=schemas.Item)
def add_tag_to_item(item_id: int, req: schemas.ItemTagRequest, db: Session = Depends(database.get_db)):
    db_item = crud.add_tag_to_item(db, item_id=item_id, tag_id=req.tag_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item or Tag not found")
    return db_item

@router.delete("/{item_id}")
def delete_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.delete_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"status": "success", "id": item_id}

@router.patch("/{item_id}", response_model=schemas.Item)
def update_item(item_id: int, req: schemas.ItemUpdate, db: Session = Depends(database.get_db)):
    db_item = crud.update_item_type(db, item_id=item_id, new_type=req.type)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    return db_item

@router.get("/{item_id}/stream")
def stream_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    if not os.path.exists(db_item.absolute_path):
        raise HTTPException(status_code=404, detail="File physically missing on disk")
    
    return FileResponse(path=db_item.absolute_path, media_type=db_item.mime_type or "audio/wav")
