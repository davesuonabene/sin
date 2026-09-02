"""Review queue for metadata changes proposed by the SIN node editor."""

from __future__ import annotations

import datetime
import json
import math
import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, database, models, schemas
from . import items


router = APIRouter(prefix="/sin-proposals", tags=["SIN proposals"])


def _load_value(raw: str | None):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _serialize(proposal: models.SinMetadataProposal) -> dict:
    return {
        "id": proposal.id,
        "asset_ref": proposal.asset_ref,
        "absolute_path": proposal.absolute_path,
        "field": proposal.field,
        "proposed_value": _load_value(proposal.proposed_value_json),
        "previous_value": _load_value(proposal.previous_value_json),
        "source_node_id": proposal.source_node_id,
        "status": proposal.status,
        "created_at": proposal.created_at,
        "updated_at": proposal.updated_at,
        "resolved_at": proposal.resolved_at,
    }


def _normalize_value(field: str, value):
    if field == "key":
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail="Key must be text")
        return value.strip()
    if field == "bpm":
        try:
            bpm = float(value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="BPM must be numeric") from exc
        if not math.isfinite(bpm) or not 20 <= bpm <= 400:
            raise HTTPException(status_code=422, detail="BPM must be between 20 and 400")
        # GAIA metadata stores tempo as an integer, matching its regular editor.
        return int(round(bpm))
    if field == "favourite":
        if not isinstance(value, bool):
            raise HTTPException(status_code=422, detail="Favourite must be true or false")
        return value
    raise HTTPException(status_code=422, detail="Unsupported proposal field")


def _collection_locator(value: str) -> tuple[int, int] | None:
    parts = value.split(":")
    if len(parts) != 3 or parts[0] != "collection":
        return None
    try:
        return int(parts[1]), int(parts[2])
    except ValueError:
        return None


def _resolve_target(db: Session, asset_ref: str | None, absolute_path: str) -> tuple[str, str]:
    locator = str(asset_ref or "").strip()
    if locator:
        collection_target = _collection_locator(locator)
        if collection_target:
            collection_id, content_index = collection_target
            collection = crud.get_item(db, collection_id)
            if not collection:
                raise HTTPException(status_code=404, detail="Proposal collection was not found")
            content, content_path = items._get_collection_content(collection, content_index)
            return locator, os.path.abspath(content_path or absolute_path or content.get("relative_path") or "")
        if locator.isdigit():
            item = crud.get_item(db, int(locator))
            if not item:
                raise HTTPException(status_code=404, detail="Proposal asset was not found")
            return str(item.id), os.path.abspath(item.absolute_path)
        raise HTTPException(status_code=422, detail="Invalid GAIA asset reference")

    if not absolute_path:
        raise HTTPException(status_code=422, detail="A GAIA asset reference or path is required")
    target_path = os.path.abspath(absolute_path)
    item = crud.get_item_by_path(db, target_path)
    if item and not isinstance(item, models.FolderItem):
        return str(item.id), os.path.abspath(item.absolute_path)

    for collection in db.query(models.FolderItem).all():
        collection = crud._populate_item_fields(collection)
        for content in collection.contents or []:
            candidate = os.path.abspath(os.path.join(collection.absolute_path, content.get("relative_path") or ""))
            if candidate == target_path:
                return f"collection:{collection.id}:{content['index']}", candidate
    raise HTTPException(status_code=404, detail="Proposal asset was not found in GAIA")


def create_metadata_proposal(payload: schemas.SinMetadataProposalCreate, db: Session) -> dict:
    value = _normalize_value(payload.field, payload.proposed_value)
    asset_ref, absolute_path = _resolve_target(db, payload.asset_ref, payload.absolute_path)
    proposal = (
        db.query(models.SinMetadataProposal)
        .filter(
            models.SinMetadataProposal.asset_ref == asset_ref,
            models.SinMetadataProposal.field == payload.field,
            models.SinMetadataProposal.status == "pending",
        )
        .order_by(models.SinMetadataProposal.updated_at.desc())
        .first()
    )
    if proposal is None:
        proposal = models.SinMetadataProposal(
            asset_ref=asset_ref,
            absolute_path=absolute_path,
            field=payload.field,
            proposed_value_json=json.dumps(value),
            previous_value_json=json.dumps(payload.previous_value),
            source_node_id=payload.source_node_id,
        )
        db.add(proposal)
    else:
        proposal.absolute_path = absolute_path
        proposal.proposed_value_json = json.dumps(value)
        proposal.previous_value_json = json.dumps(payload.previous_value)
        proposal.source_node_id = payload.source_node_id
        proposal.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(proposal)
    return _serialize(proposal)


def _apply_proposal(proposal: models.SinMetadataProposal, db: Session) -> None:
    value = _normalize_value(proposal.field, _load_value(proposal.proposed_value_json))
    collection_target = _collection_locator(proposal.asset_ref)
    if collection_target:
        collection_id, content_index = collection_target
        items.update_collection_content(
            collection_id,
            content_index,
            schemas.CollectionContentUpdate(**{proposal.field: value}),
            db,
        )
        return
    if not proposal.asset_ref.isdigit():
        raise HTTPException(status_code=422, detail="This proposal has an invalid GAIA asset reference")
    item = crud.get_item(db, int(proposal.asset_ref))
    if not item:
        raise HTTPException(status_code=404, detail="The asset for this proposal no longer exists")
    items._apply_item_update(item, schemas.ItemUpdate(**{proposal.field: value}), db)


@router.get("/", response_model=list[schemas.SinMetadataProposal])
def list_metadata_proposals(
    status: str = "pending",
    db: Session = Depends(database.get_db),
):
    allowed_statuses = {"pending", "accepted", "rejected", "all"}
    if status not in allowed_statuses:
        raise HTTPException(status_code=422, detail="Invalid proposal status")
    query = db.query(models.SinMetadataProposal)
    if status != "all":
        query = query.filter(models.SinMetadataProposal.status == status)
    return [_serialize(proposal) for proposal in query.order_by(models.SinMetadataProposal.updated_at.desc()).all()]


@router.post("/", response_model=schemas.SinMetadataProposal, status_code=201)
def submit_metadata_proposal(
    payload: schemas.SinMetadataProposalCreate,
    db: Session = Depends(database.get_db),
):
    return create_metadata_proposal(payload, db)


@router.post("/{proposal_id}/accept", response_model=schemas.SinMetadataProposal)
def accept_metadata_proposal(proposal_id: int, db: Session = Depends(database.get_db)):
    proposal = db.query(models.SinMetadataProposal).filter(models.SinMetadataProposal.id == proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending proposals can be accepted")
    _apply_proposal(proposal, db)
    proposal.status = "accepted"
    proposal.resolved_at = datetime.datetime.utcnow()
    proposal.updated_at = proposal.resolved_at
    db.commit()
    db.refresh(proposal)
    return _serialize(proposal)


@router.post("/{proposal_id}/reject", response_model=schemas.SinMetadataProposal)
def reject_metadata_proposal(proposal_id: int, db: Session = Depends(database.get_db)):
    proposal = db.query(models.SinMetadataProposal).filter(models.SinMetadataProposal.id == proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending proposals can be rejected")
    proposal.status = "rejected"
    proposal.resolved_at = datetime.datetime.utcnow()
    proposal.updated_at = proposal.resolved_at
    db.commit()
    db.refresh(proposal)
    return _serialize(proposal)
