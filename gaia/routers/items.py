from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import List
import os

from .. import (
    collection_importer,
    crud,
    schemas,
    models,
    database,
    integrity,
    text_analyzer,
    midi_parser,
    multitrack_analyzer,
    vaults,
)

router = APIRouter(
    prefix="/items",
    tags=["items"],
)

TYPE_DEFINITIONS = [
    {"id": "asset", "label": "Asset", "parent": None, "abstract": True, "container": False},
    {"id": "audio", "label": "Audio", "parent": "asset", "abstract": True, "container": False},
    {"id": "track", "label": "Track", "parent": "audio", "abstract": False, "container": False},
    {"id": "sample", "label": "Sample", "parent": "audio", "abstract": True, "container": False},
    {"id": "one_shot", "label": "One shot", "parent": "sample", "abstract": False, "container": False},
    {"id": "loop", "label": "Loop", "parent": "sample", "abstract": False, "container": False},
    {"id": "midi", "label": "MIDI", "parent": "asset", "abstract": False, "container": False},
    {"id": "collection", "label": "Collection", "parent": "asset", "abstract": False, "container": True},
    {"id": "multitrack", "label": "Multitrack", "parent": "collection", "abstract": False, "container": True},
    {"id": "sample_pack", "label": "Sample pack", "parent": "collection", "abstract": False, "container": True},
]


def _vault_for_request(db: Session, vault_id: int | None):
    if vault_id is None:
        return vaults.ensure_default_vault(db)
    vault = vaults.get_vault(db, vault_id)
    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")
    return vault


def _create_snapshot_item(source_path: str, db: Session, vault_id: int | None = None):
    source = collection_importer.canonical_source_path(source_path)
    vault = _vault_for_request(db, vault_id)
    existing = crud.get_collection_by_source(db, source, vault.id)
    if existing:
        vaults.log_import(db, vault.id, source, "duplicate", "skipped_duplicate", existing.id, "This source is already imported in this vault")
        return existing

    try:
        snapshot = collection_importer.snapshot_collection_source(
            source,
            asset_store=vaults.vault_store(vault),
        )
    except Exception as exc:
        vaults.log_import(db, vault.id, source, "failed", "none", detail=str(exc))
        raise
    if snapshot["type"] == "multitrack":
        item = schemas.MultitrackItemCreate(
            absolute_path=snapshot["absolute_path"],
            vault_id=vault.id,
            size_bytes=snapshot["size_bytes"],
            mime_type=snapshot["mime_type"],
            type="multitrack",
            title=snapshot["title"],
            source_kind=snapshot["source_kind"],
            source_path=snapshot["source_path"],
            contents=snapshot["contents"],
            stems=snapshot["stems"],
            key=snapshot["key"],
            bpm=snapshot["bpm"],
            is_valid_length=snapshot["is_valid_length"],
            length_variance=snapshot["length_variance"],
        )
    else:
        item = schemas.CollectionItemCreate(
            absolute_path=snapshot["absolute_path"],
            vault_id=vault.id,
            size_bytes=snapshot["size_bytes"],
            mime_type=snapshot["mime_type"],
            type="collection",
            title=snapshot["title"],
            source_kind=snapshot["source_kind"],
            source_path=snapshot["source_path"],
            contents=snapshot["contents"],
        )
    result = crud.create_item(db, item)
    vaults.log_import(db, vault.id, source, "imported", "snapshot_imported", result.id)
    return result


def _get_collection_content(db_item, content_index: int):
    if not isinstance(db_item, models.CollectionItem):
        raise HTTPException(status_code=400, detail="Item is not a collection")
    contents = getattr(db_item, "contents", []) or []
    content = next((entry for entry in contents if entry.get("index") == content_index), None)
    if not content:
        raise HTTPException(status_code=404, detail="Collection content not found")

    relative_path = content.get("relative_path", "")
    candidate = os.path.abspath(os.path.join(db_item.absolute_path, relative_path))
    collection_root = os.path.abspath(db_item.absolute_path)
    if os.path.commonpath([collection_root, candidate]) != collection_root or not os.path.isfile(candidate):
        raise HTTPException(status_code=404, detail="Collection content is missing on disk")
    return content, candidate


@router.get("/types")
def read_type_definitions():
    """The fixed, read-only taxonomy used by the manager and its clients."""
    return TYPE_DEFINITIONS


@router.post("/import-collection", response_model=schemas.Item)
def import_collection(req: schemas.CollectionImportRequest, db: Session = Depends(database.get_db)):
    try:
        return _create_snapshot_item(req.source_path, db, req.vault_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@router.post("/multitrack", response_model=schemas.Item)
def register_multitrack(req: schemas.MultitrackRegisterRequest, db: Session = Depends(database.get_db)):
    try:
        item = _create_snapshot_item(req.folder_path, db, req.vault_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if item.type != "multitrack":
        raise HTTPException(status_code=400, detail="Folder was imported as a collection, not a multitrack")
    return item

@router.post("/", response_model=schemas.Item)
def create_item(item: schemas.ItemCreate, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, item.vault_id)
    item.vault_id = vault.id
    db_item = crud.get_item_by_path(db, absolute_path=item.absolute_path, vault_id=vault.id)
    if db_item:
        raise HTTPException(status_code=400, detail="Item already registered")
    
    if not item.file_hash:
        item.file_hash = integrity.calculate_file_hash(item.absolute_path)
    
    if not item.size_bytes:
        meta = integrity.get_file_metadata(item.absolute_path)
        if meta:
            item.size_bytes = meta.get("size_bytes")
            
    result = crud.create_item(db=db, item=item)
    vaults.log_import(db, vault.id, item.absolute_path, "imported", "registered_asset", result.id)
    return result

@router.get("/", response_model=List[schemas.Item])
def read_items(skip: int = 0, limit: int = 100, vault_id: int | None = None, db: Session = Depends(database.get_db)):
    vault = _vault_for_request(db, vault_id)
    items = crud.get_items(db, skip=skip, limit=limit, vault_id=vault.id)
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
    vault = _vault_for_request(db, req.vault_id)
    dir_path = req.directory_path.strip().strip("\"'")
    if not os.path.isdir(dir_path):
        raise HTTPException(status_code=400, detail="Invalid directory path")
    
    supported_extensions = {".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff", ".mid", ".midi"}
    imported_items = []
    
    # Walk top-down so every folder gets a chance to claim its direct audio
    # files as a multitrack before they are imported as individual samples.
    # Clearing `dirs` then prevents the multitrack's stems (and any nested
    # support folders) from being scanned again.
    for root, dirs, files in os.walk(dir_path, topdown=True):
        dirs.sort()
        files.sort()
        if req.look_for_multitracks and multitrack_analyzer.is_multitrack_folder(root):
            snapshot_item = _create_snapshot_item(root, db, vault.id)
            if snapshot_item.type == "multitrack":
                imported_items.append(snapshot_item)
                dirs.clear()
                continue

        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in supported_extensions:
                abs_path = os.path.join(root, file)
                
                existing = crud.get_item_by_path(db, absolute_path=abs_path, vault_id=vault.id)
                if not existing:
                    file_hash = integrity.calculate_file_hash(abs_path)
                    meta = integrity.get_file_metadata(abs_path)
                    size = meta.get("size_bytes") if meta else None
                    
                    analysis = text_analyzer.analyze_path(abs_path)
                    
                    if ext in {".mid", ".midi"}:
                        midi_meta = midi_parser.parse_midi_file(abs_path)
                        bpm_val = midi_meta.get("bpm")
                        if bpm_val is None and analysis.get("bpm"):
                            try:
                                bpm_val = int(analysis.get("bpm"))
                            except (ValueError, TypeError):
                                bpm_val = None
                        key_val = midi_meta.get("key") or analysis.get("key")
                        
                        new_item = schemas.MidiItemCreate(
                            absolute_path=abs_path,
                            vault_id=vault.id,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type="audio/midi",
                            type="midi",
                            bpm=bpm_val,
                            key=key_val
                        )
                    elif analysis["type"] == "loop":
                        new_item = schemas.LoopSampleItemCreate(
                            absolute_path=abs_path,
                            vault_id=vault.id,
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
                            vault_id=vault.id,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type=f"audio/{ext[1:]}",
                            type="one_shot",
                            key=analysis["key"]
                        )
                    else:
                        new_item = schemas.SampleItemCreate(
                            absolute_path=abs_path,
                            vault_id=vault.id,
                            file_hash=file_hash,
                            size_bytes=size,
                            mime_type=f"audio/{ext[1:]}",
                            type="sample",
                            key=analysis["key"]
                        )
                        
                    db_item = crud.create_item(db, new_item)
                    vaults.log_import(db, vault.id, abs_path, "imported", "scanned_asset", db_item.id)
                    
                    category = "MIDI" if ext in {".mid", ".midi"} else analysis["category"]
                    if category != "Other":
                        tag = crud.get_or_create_tag(db, category)
                        crud.add_tag_to_item(db, item_id=db_item.id, tag_id=tag.id)
                        
                    imported_items.append(db_item)
                else:
                    vaults.log_import(db, vault.id, abs_path, "duplicate", "skipped_duplicate", existing.id, "This file is already registered in this vault")
                    
    return {"imported": len(imported_items)}

@router.post("/{item_id}/tags", response_model=schemas.Item)
def add_tag_to_item(item_id: int, req: schemas.ItemTagRequest, db: Session = Depends(database.get_db)):
    db_item = crud.add_tag_to_item(db, item_id=item_id, tag_id=req.tag_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item or Tag not found")
    return db_item

@router.delete("/{item_id}")
def delete_item(item_id: int, db: Session = Depends(database.get_db)):
    existing = crud.get_item(db, item_id)
    if isinstance(existing, models.CollectionItem):
        raise HTTPException(status_code=405, detail="GAIA collection snapshots are read-only")
    db_item = crud.delete_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"status": "success", "id": item_id}

@router.patch("/{item_id}", response_model=schemas.Item)
def update_item(item_id: int, req: schemas.ItemUpdate, db: Session = Depends(database.get_db)):
    raise HTTPException(status_code=405, detail="GAIA assets are read-only. Types are chosen during import.")

@router.get("/{item_id}/contents", response_model=List[schemas.CollectionContent])
def get_collection_contents(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    if not isinstance(db_item, models.CollectionItem):
        raise HTTPException(status_code=400, detail="Item is not a collection")
    return getattr(db_item, "contents", []) or []

@router.get("/{item_id}/contents/{content_index}/stream")
def stream_collection_content(item_id: int, content_index: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    content, content_path = _get_collection_content(db_item, content_index)
    return FileResponse(path=content_path, media_type=content.get("mime_type") or "application/octet-stream")

@router.get("/{item_id}/stems")
def get_item_stems(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    if db_item.type != "multitrack":
        raise HTTPException(status_code=400, detail="Item is not a multitrack item")
    return {
        "id": item_id,
        "is_valid_length": getattr(db_item, "is_valid_length", True),
        "length_variance": getattr(db_item, "length_variance", 0.0),
        "stems": getattr(db_item, "stems", [])
    }

@router.get("/{item_id}/stems/{stem_index}/stream")
def stream_stem_item(item_id: int, stem_index: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    stems = getattr(db_item, "stems", []) or []
    if stem_index < 0 or stem_index >= len(stems):
        raise HTTPException(status_code=404, detail="Stem index out of range")
    
    stem_path = stems[stem_index].get("absolute_path")
    if not stem_path or not os.path.exists(stem_path):
        raise HTTPException(status_code=404, detail="Stem file missing on disk")
        
    return FileResponse(path=stem_path, media_type="audio/wav")

@router.get("/{item_id}/stream")
def stream_item(item_id: int, db: Session = Depends(database.get_db)):
    db_item = crud.get_item(db, item_id=item_id)
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    
    if db_item.type == "multitrack":
        stems = getattr(db_item, "stems", []) or []
        if stems and stems[0].get("absolute_path") and os.path.exists(stems[0]["absolute_path"]):
            return FileResponse(path=stems[0]["absolute_path"], media_type="audio/wav")
    
    if not os.path.exists(db_item.absolute_path):
        raise HTTPException(status_code=404, detail="File physically missing on disk")
    
    mime = db_item.mime_type or ("audio/midi" if db_item.type == "midi" else "audio/wav")
    return FileResponse(path=db_item.absolute_path, media_type=mime)
