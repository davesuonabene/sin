"""Fast catalog snapshot, incremental delta, FTS5 search, and SSE push endpoints."""

from __future__ import annotations

import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import catalog, database

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/snapshot")
def read_catalog_snapshot(
    request: Request,
    vault_id: int | None = None,
    vault_preview: str | None = None,
    db: Session = Depends(database.get_db),
):
    """Serve the compact columnar catalog snapshot (pre-gzipped & ETag-validated in RAM)."""
    if vault_preview is not None and vault_preview not in {"quick", "lazy", "hidden"}:
        raise HTTPException(status_code=400, detail="Vault preview must be quick, lazy, or hidden")

    accept_encoding = (request.headers.get("accept-encoding") or "").lower()
    want_gzip = "gzip" in accept_encoding

    rev, body, is_gzipped = catalog.get_snapshot_payload(
        db,
        vault_id=vault_id,
        vault_preview=vault_preview,
        accept_gzip=want_gzip,
    )
    etag = f'"rev-{rev}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    headers = {
        "ETag": etag,
        "Cache-Control": "no-cache",
        "X-Gaia-Rev": str(rev),
    }
    if is_gzipped:
        headers["Content-Encoding"] = "gzip"
        headers["Vary"] = "Accept-Encoding"
    return Response(content=body, media_type="application/json", headers=headers)


@router.get("/delta")
def read_catalog_delta(
    since_rev: int = 0,
    vault_id: int | None = None,
    vault_preview: str | None = None,
    db: Session = Depends(database.get_db),
):
    """Return incremental changes since `since_rev` (or `full_reload: true`)."""
    if vault_preview is not None and vault_preview not in {"quick", "lazy", "hidden"}:
        raise HTTPException(status_code=400, detail="Vault preview must be quick, lazy, or hidden")
    return catalog.get_catalog_delta(
        db,
        since_rev=since_rev,
        vault_id=vault_id,
        vault_preview=vault_preview,
    )


@router.get("/search")
def search_catalog(
    q: str = "",
    vault_id: int | None = None,
    vault_preview: str | None = None,
    limit: int = 500,
    db: Session = Depends(database.get_db),
):
    """FTS5-backed sub-3ms server search returning matched item IDs and root ancestor IDs."""
    if vault_preview is not None and vault_preview not in {"quick", "lazy", "hidden"}:
        raise HTTPException(status_code=400, detail="Vault preview must be quick, lazy, or hidden")
    matched_ids, root_ids = catalog.search_fts_item_ids(
        db,
        q,
        vault_id=vault_id,
        vault_preview=vault_preview,
        limit=limit,
    )
    return {
        "query": q,
        "item_ids": matched_ids,
        "root_ids": root_ids,
        "count": len(matched_ids),
    }


@router.get("/events")
async def stream_catalog_events(request: Request):
    """Server-Sent Events stream pushing library revision ticks with zero client polling."""
    loop = asyncio.get_running_loop()
    queue = catalog.catalog_runtime.subscribe(loop)

    async def _event_generator():
        try:
            with database.SessionLocal() as db:
                raw_conn = catalog.unwrap_raw_connection(db)
                catalog.catalog_runtime.ensure_schema(raw_conn)
                current_rev = catalog.get_library_rev(raw_conn)
            yield f"event: rev\ndata: {json.dumps({'rev': current_rev})}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    rev = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"event: rev\ndata: {json.dumps({'rev': rev})}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            catalog.catalog_runtime.unsubscribe(loop, queue)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
