import os
import json
import hashlib
import logging
import re
from time import perf_counter
from pathlib import Path
from fastapi import FastAPI, APIRouter, Request
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import List, Optional, Literal, Dict, Any, Union
import soundfile as sf
import numpy as np

from core.system import System
from core.audio_object import ItemPoolObject
from core.runtime_trace import collect_runtime_trace, trace_runtime

PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_DIR = PROJECT_ROOT / "static"
SAVES_DIR = PROJECT_ROOT / "saves"
# The editor has one continuously saved working stage.  It deliberately lives
# alongside named workspace presets, but is hidden from the preset list.
STAGE_SAVE_PATH = SAVES_DIR / ".current-stage.json"

logger = logging.getLogger("iride.api")


def workspace_save_path(name: str) -> Path:
    """Return a safe, project-local JSON path for a named workspace preset."""
    clean_name = name.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", clean_name):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail="Workspace names must be 1-64 letters, numbers, spaces, underscores, or hyphens."
        )
    return SAVES_DIR / f"{clean_name}.json"


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing IRIDE server lifespan...")

    SAVES_DIR.mkdir(exist_ok=True)
    if not (STATIC_DIR / "index.html").is_file():
        logger.warning("IRIDE frontend is not built. Run: npm --prefix iride run build")
    yield
    logger.info("Shutting down IRIDE server lifespan...")


app = FastAPI(
    title="IRIDE API",
    description="Node editor, workspace, and audio-rendering API for IRIDE",
    version="0.1.0",
    lifespan=lifespan
)

api_router = APIRouter(prefix="/api")


@api_router.get("/health", tags=["System"])
def health_check():
    """
    Health check endpoint to verify API server is operational.
    """
    logger.debug("Health check requested.")
    return {
        "status": "ok",
        "service": "iride-api",
        "version": "0.1.0"
    }


from ermes import FxModuleModel, AudioNodeModel, PoolResolveRequest



from core.engines import get_renderer_for_node, build_node_object

RAM_PREVIEW_STORE: Dict[str, Dict[str, Any]] = {}

@api_router.post("/render", tags=["System"])
def render_graph(payload: AudioNodeModel):
    from fastapi import HTTPException
    logger.info(f"[API /render] Rendering node '{payload.node_name}' (type: {payload.node_type}) at {payload.bpm} BPM")
    try:
        with collect_runtime_trace() as runtime_entries:
            trace_runtime(f"Render request accepted: {payload.node_name} ({payload.node_type})", "common")
            sys = System(bpm=payload.bpm)
            renderer = get_renderer_for_node(payload.node_type)
            trace_runtime(f"Renderer selected: {renderer.__class__.__name__}")

            render_started_at = perf_counter()
            audio_out = renderer.render(payload, sys)
            trace_runtime(
                f"Graph rendered: {audio_out.shape[-1]} samples "
                f"({(perf_counter() - render_started_at) * 1000.0:.1f} ms)"
            )
            logger.debug(f"[DSP] Render complete. Output length: {audio_out.shape[-1]} samples.")

            from datetime import datetime
            temp_dir = "temp_renders"
            os.makedirs(temp_dir, exist_ok=True)

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            base_name = payload.filename or "output"
            out_filename = f"{timestamp}_{base_name}_{payload.node_name}.wav"
            out_path = os.path.join(temp_dir, out_filename)

            write_started_at = perf_counter()
            sf.write(
                out_path,
                np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
                sys.sample_rate,
            )
            trace_runtime(
                f"Render file written: {out_filename} "
                f"({(perf_counter() - write_started_at) * 1000.0:.1f} ms)",
                "common",
            )
            logger.info(f"[API /render] Rendered audio saved to '{out_path}'")

            return {
                "status": "success",
                "file_url": f"/temp_renders/{out_filename}",
                "filename": out_filename,
                "runtime_log": runtime_entries,
            }
    except Exception as e:
        logger.error(f"[API /render Error] {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/preview", tags=["Preview"])
def preview_graph_ram(payload: AudioNodeModel):
    import io
    from fastapi import HTTPException
    logger.info(f"[API /preview] Rendering RAM preview for node '{payload.node_name}' (type: {payload.node_type}) at {payload.bpm} BPM")
    try:
        with collect_runtime_trace() as runtime_entries:
            trace_runtime(f"Preview request accepted: {payload.node_name} ({payload.node_type})", "common")
            payload_snapshot = (
                payload.model_dump(mode="json")
                if hasattr(payload, "model_dump")
                else payload.dict()
            )
            payload_fingerprint = hashlib.sha1(
                json.dumps(payload_snapshot, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
            ).hexdigest()[:16]
            base_name = payload.filename or "preview"
            node_key = payload.filename or payload.node_name
            out_filename = f"{base_name}_{payload.node_name}.wav"
            cached_preview = RAM_PREVIEW_STORE.get(node_key)
            if cached_preview and cached_preview.get("payload_fingerprint") == payload_fingerprint:
                trace_runtime(
                    f"Preview cache hit: {node_key} ({len(cached_preview['wav_bytes'])} bytes)",
                    "common",
                )
                return {
                    "status": "success",
                    "preview_id": node_key,
                    "audio_url": f"/api/preview/stream/{node_key}?v={payload_fingerprint}",
                    "filename": cached_preview["filename"],
                    "runtime_log": runtime_entries,
                    "cached": True,
                }

            sys = System(bpm=payload.bpm, render_mode="preview")
            renderer = get_renderer_for_node(payload.node_type)
            trace_runtime(f"Renderer selected: {renderer.__class__.__name__}")
            render_started_at = perf_counter()
            audio_out = renderer.render(payload, sys)
            trace_runtime(
                f"Graph rendered: {audio_out.shape[-1]} samples "
                f"({(perf_counter() - render_started_at) * 1000.0:.1f} ms)"
            )
            # Keep an intentionally silent/disconnected graph preview decodable by browsers.
            if audio_out.shape[-1] == 0:
                audio_out = np.zeros(max(1, sys.sample_rate // 10), dtype=np.float32)
                trace_runtime("Empty graph output replaced with a 100 ms silent preview", "warning")

            encode_started_at = perf_counter()
            buf = io.BytesIO()
            sf.write(
                buf,
                np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
                sys.sample_rate,
                format='WAV',
            )
            bytes_data = buf.getvalue()
            trace_runtime(
                f"Preview WAV encoded: {len(bytes_data)} bytes "
                f"({(perf_counter() - encode_started_at) * 1000.0:.1f} ms)"
            )

            RAM_PREVIEW_STORE[node_key] = {
                "wav_bytes": bytes_data,
                "filename": out_filename,
                "node_name": payload.node_name,
                "sample_rate": sys.sample_rate,
                "payload": payload_snapshot,
                "payload_fingerprint": payload_fingerprint,
            }
            trace_runtime(f"RAM preview stored: {node_key}", "common")

            logger.info(f"[API /preview] Stored RAM preview for key '{node_key}' ({len(bytes_data)} bytes)")
            return {
                "status": "success",
                "preview_id": node_key,
                "audio_url": f"/api/preview/stream/{node_key}?v={payload_fingerprint}",
                "filename": out_filename,
                "runtime_log": runtime_entries,
                "cached": False,
            }
    except Exception as e:
        logger.error(f"[API /preview Error] {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/preview/stream/{node_id:path}", tags=["Preview"])
def stream_ram_preview(node_id: str, request: Request):
    from fastapi import Response, HTTPException
    data = RAM_PREVIEW_STORE.get(node_id)
    if not data:
        raise HTTPException(status_code=404, detail="RAM preview not found for specified node")

    wav_bytes = data["wav_bytes"]
    total_size = len(wav_bytes)
    range_header = request.headers.get("range")
    etag = f'"{data.get("payload_fingerprint", node_id)}"'
    common_headers = {
        "Accept-Ranges": "bytes",
        # Each payload version has its own query-string URL. Let the audio
        # element and waveform decoder share the browser cache instead of
        # transferring the same in-memory WAV twice.
        "Cache-Control": "private, max-age=300, immutable",
        "ETag": etag,
    }

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=common_headers)

    if not range_header:
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={**common_headers, "Content-Length": str(total_size)},
        )

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{total_size}"},
        )

    start_text, end_text = match.groups()
    if start_text:
        start = int(start_text)
        end = min(int(end_text), total_size - 1) if end_text else total_size - 1
    else:
        suffix_length = int(end_text)
        if suffix_length <= 0:
            return Response(
                status_code=416,
                headers={**common_headers, "Content-Range": f"bytes */{total_size}"},
            )
        start = max(0, total_size - suffix_length)
        end = total_size - 1

    if start >= total_size or start > end:
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{total_size}"},
        )

    partial = wav_bytes[start:end + 1]
    return Response(
        content=partial,
        status_code=206,
        media_type="audio/wav",
        headers={
            **common_headers,
            "Content-Length": str(len(partial)),
            "Content-Range": f"bytes {start}-{end}/{total_size}",
        },
    )

@api_router.post("/preview/export/{node_id:path}", tags=["Preview"])
def export_ram_preview(node_id: str, payload: Optional[AudioNodeModel] = None):
    from fastapi import HTTPException
    export_dir = "export"
    os.makedirs(export_dir, exist_ok=True)

    ram_data = RAM_PREVIEW_STORE.get(node_id)
    if ram_data:
        filename = ram_data["filename"]
        export_path = os.path.join(export_dir, filename)
        with open(export_path, "wb") as f:
            f.write(ram_data["wav_bytes"])
        logger.info(f"[API /preview/export] Directly exported RAM preview '{filename}' to disk ({export_path})")
        return {"status": "success", "file_url": f"/export/{filename}", "filename": filename}

    if payload:
        sys = System(bpm=payload.bpm)
        renderer = get_renderer_for_node(payload.node_type)
        audio_out = renderer.render(payload, sys)
        filename = f"{payload.node_name}.wav"
        export_path = os.path.join(export_dir, filename)
        sf.write(
            export_path,
            np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
            sys.sample_rate,
        )
        return {"status": "success", "file_url": f"/export/{filename}", "filename": filename}

    raise HTTPException(status_code=404, detail="No RAM preview found to export")

class ExportRequest(BaseModel):
    filename: str


class WorkspacePresetRequest(BaseModel):
    name: str
    preset: Dict[str, Any]


class StageSaveRequest(BaseModel):
    stage: Dict[str, Any]


@api_router.get("/stage", tags=["Stage"])
def load_current_stage():
    """Load the sole auto-saved editor stage, if one has been created."""
    if not STAGE_SAVE_PATH.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="No current stage has been saved")
    try:
        with STAGE_SAVE_PATH.open("r", encoding="utf-8") as handle:
            stage = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("Could not read the current editor stage")
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="The current stage could not be read") from exc
    return {"stage": stage}


@api_router.put("/stage", tags=["Stage"])
@api_router.post("/stage", tags=["Stage"])
def save_current_stage(payload: StageSaveRequest):
    """Atomically replace the sole auto-saved editor stage."""
    SAVES_DIR.mkdir(exist_ok=True)
    temporary_path = STAGE_SAVE_PATH.with_suffix(".tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as handle:
            json.dump(payload.stage, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary_path, STAGE_SAVE_PATH)
    except (OSError, TypeError) as exc:
        logger.exception("Could not save the current editor stage")
        temporary_path.unlink(missing_ok=True)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="The current stage could not be saved") from exc
    return {"status": "saved"}


@api_router.get("/workspaces", tags=["Workspaces"])
def list_workspace_presets():
    SAVES_DIR.mkdir(exist_ok=True)
    files = sorted(
        (path for path in SAVES_DIR.glob("*.json") if path != STAGE_SAVE_PATH),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return {
        "workspaces": [
            {"name": path.stem, "updated_at": path.stat().st_mtime}
            for path in files
        ]
    }


@api_router.get("/workspaces/{name}", tags=["Workspaces"])
def load_workspace_preset(name: str):
    save_path = workspace_save_path(name)
    if not save_path.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Workspace preset not found")
    try:
        with save_path.open("r", encoding="utf-8") as handle:
            preset = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("Could not read workspace preset '%s'", name)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="Workspace preset could not be read") from exc
    return {"name": save_path.stem, "preset": preset}


@api_router.post("/workspaces", tags=["Workspaces"])
def save_workspace_preset(payload: WorkspacePresetRequest):
    save_path = workspace_save_path(payload.name)
    SAVES_DIR.mkdir(exist_ok=True)
    temporary_path = save_path.with_suffix(".tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as handle:
            json.dump(payload.preset, handle, ensure_ascii=False, indent=2)
        os.replace(temporary_path, save_path)
    except (OSError, TypeError) as exc:
        logger.exception("Could not save workspace preset '%s'", payload.name)
        temporary_path.unlink(missing_ok=True)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="Workspace preset could not be saved") from exc
    return {"name": save_path.stem, "status": "saved"}


@api_router.delete("/workspaces/{name}", tags=["Workspaces"])
def delete_workspace_preset(name: str):
    save_path = workspace_save_path(name)
    if not save_path.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Workspace preset not found")
    save_path.unlink()
    return {"name": save_path.stem, "status": "deleted"}

@api_router.get("/renders/temp", tags=["System"])
def get_temp_renders():
    temp_dir = "temp_renders"
    if not os.path.exists(temp_dir):
        return {"files": []}
    files = [f for f in os.listdir(temp_dir) if f.endswith(".wav")]
    # Sort files by creation time descending (newest first)
    files.sort(key=lambda x: os.path.getctime(os.path.join(temp_dir, x)), reverse=True)
    return {"files": [{"filename": f, "url": f"/temp_renders/{f}"} for f in files]}

@api_router.post("/renders/export", tags=["System"])
def export_render(payload: ExportRequest):
    import shutil
    temp_dir = "temp_renders"
    export_dir = "export"
    os.makedirs(export_dir, exist_ok=True)
    
    temp_path = os.path.join(temp_dir, payload.filename)
    if not os.path.exists(temp_path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Temporary file not found")
        
    export_path = os.path.join(export_dir, payload.filename)
    shutil.move(temp_path, export_path)
    
    return {"status": "success", "file_url": f"/export/{payload.filename}"}

def _get_gaia_metadata(filepath: str) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {"bpm": None, "key": None}
    if not filepath:
        return metadata
    db_path = "gaia.db"
    if not os.path.exists(db_path):
        db_path = os.path.join("gaia", "gaia.db")
    if not os.path.exists(db_path):
        return metadata
    try:
        import sqlite3
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        target_abs = os.path.abspath(filepath)
        cursor.execute("""
            SELECT s.bpm, s.key
            FROM items i
            LEFT JOIN sample_items s ON i.id = s.id
            WHERE i.absolute_path = ? OR i.absolute_path = ?
        """, (filepath, target_abs))
        row = cursor.fetchone()
        if row:
            metadata["bpm"] = float(row["bpm"]) if row["bpm"] is not None else None
            metadata["key"] = row["key"]
            conn.close()
            return metadata

        # Check collection manifest entries
        cursor.execute("SELECT absolute_path, manifest_json FROM collection_items")
        colls = cursor.fetchall()
        for c in colls:
            root = c["absolute_path"] or ""
            if not c["manifest_json"]:
                continue
            try:
                manifest = json.loads(c["manifest_json"])
                for entry in manifest:
                    rel = entry.get("relative_path") or ""
                    cand = os.path.abspath(os.path.join(root, rel))
                    if cand == target_abs or entry.get("filename") == os.path.basename(filepath):
                        metadata["bpm"] = entry.get("bpm")
                        metadata["key"] = entry.get("key")
                        conn.close()
                        return metadata
            except Exception:
                pass
        conn.close()
    except Exception:
        pass
    return metadata


def _get_gaia_bpm(filepath: str) -> Optional[float]:
    bpm = _get_gaia_metadata(filepath).get("bpm")
    return float(bpm) if bpm is not None else None


class LibraryResolveRequest(BaseModel):
    references: List[Dict[str, Any]] = []


def _resolve_library_references(references: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Read the small set of GAIA rows referenced by an editor graph.

    Preview and render paths should never hydrate the complete multi-vault
    library. IDs remain authoritative; an exact path is accepted only for
    legacy direct-asset nodes that do not yet carry an ID.
    """
    import sqlite3

    started_at = perf_counter()
    requested = [ref for ref in (references or []) if isinstance(ref, dict)]

    def diagnostics(query_count: int, resolved_count: int) -> Dict[str, Any]:
        return {
            "request_count": len(requested),
            "resolved_count": resolved_count,
            "query_count": query_count,
            "duration_ms": round((perf_counter() - started_at) * 1000.0, 2),
        }
    numeric_ids: list[int] = []
    exact_paths: list[str] = []
    for ref in requested:
        raw_id = ref.get("id")
        try:
            if raw_id is not None and str(raw_id).strip().isdigit():
                numeric_ids.append(int(raw_id))
                continue
        except (TypeError, ValueError):
            pass
        raw_path = ref.get("absolute_path") or ref.get("filepath") or ref.get("path")
        if raw_path:
            exact_paths.extend([str(raw_path), os.path.abspath(str(raw_path))])

    db_path = "gaia.db" if os.path.exists("gaia.db") else os.path.join("gaia", "gaia.db")
    if not os.path.exists(db_path):
        return {"files": [], "missing": requested, "diagnostics": diagnostics(0, 0)}

    clauses: list[str] = []
    params: list[Any] = []
    unique_ids = list(dict.fromkeys(numeric_ids))
    unique_paths = list(dict.fromkeys(exact_paths))
    if unique_ids:
        clauses.append(f"i.id IN ({','.join('?' for _ in unique_ids)})")
        params.extend(unique_ids)
    if unique_paths:
        clauses.append(f"i.absolute_path IN ({','.join('?' for _ in unique_paths)})")
        params.extend(unique_paths)
    if not clauses:
        return {"files": [], "missing": requested, "diagnostics": diagnostics(0, 0)}

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(f"""
            SELECT i.id, i.absolute_path, i.type, i.vault_id, i.parent_id, i.metadata_json,
                   COALESCE(s.key, m.key, mt.key) AS key,
                   COALESCE(s.bpm, m.bpm, mt.bpm) AS bpm
            FROM items i
            LEFT JOIN sample_items s ON i.id = s.id
            LEFT JOIN midi_items m ON i.id = m.id
            LEFT JOIN multitrack_items mt ON i.id = mt.id
            WHERE {' OR '.join(clauses)}
        """, params).fetchall()
    finally:
        connection.close()

    by_id: dict[str, dict[str, Any]] = {}
    by_path: dict[str, dict[str, Any]] = {}
    for row in rows:
        try:
            attributes = json.loads(row["metadata_json"] or "{}")
        except (TypeError, ValueError):
            attributes = {}
        analysis = attributes.get("analysis") if isinstance(attributes, dict) else {}
        analysis = analysis if isinstance(analysis, dict) else {}
        filepath = row["absolute_path"] or ""
        record = {
            "id": row["id"],
            "vault_id": row["vault_id"],
            "collection_id": row["parent_id"],
            "absolute_path": filepath,
            "name": os.path.basename(filepath),
            "type": row["type"] or "asset",
            "key": row["key"] if row["key"] is not None else analysis.get("key"),
            "bpm": row["bpm"] if row["bpm"] is not None else analysis.get("bpm"),
            "duration_seconds": analysis.get("duration_seconds"),
        }
        by_id[str(record["id"])] = record
        by_path[os.path.normcase(os.path.abspath(filepath))] = record

    ordered: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    emitted: set[str] = set()
    for ref in requested:
        raw_id = ref.get("id")
        raw_path = ref.get("absolute_path") or ref.get("filepath") or ref.get("path")
        record = by_id.get(str(raw_id)) if raw_id is not None else None
        if record is None and raw_id is None and raw_path:
            record = by_path.get(os.path.normcase(os.path.abspath(str(raw_path))))
        if record is None:
            missing.append(ref)
            continue
        record_key = str(record["id"])
        if record_key not in emitted:
            emitted.add(record_key)
            ordered.append(record)
    return {"files": ordered, "missing": missing, "diagnostics": diagnostics(1, len(ordered))}


@api_router.post("/library/resolve", tags=["System"])
def resolve_library_references(payload: LibraryResolveRequest):
    return _resolve_library_references(payload.references)


def _resolve_pool_asset_keys(selected_items: Optional[List[Dict[str, Any]]]) -> list[dict[str, Any]]:
    """Resolve GAIA pool keys to the current exact asset records.

    Asset Pool membership is an ordered list, not a library query. A GAIA ID
    is authoritative: if it cannot be found, fail instead of falling back to
    a stale path, name, collection, or filter.
    """
    raw_items = selected_items or []
    keyed_items = [item for item in raw_items if isinstance(item, dict) and item.get("id") is not None]
    by_id: dict[str, dict[str, Any]] = {}

    if keyed_items:
        library = get_library().get("files", [])

        def visit(entries: list[dict[str, Any]]) -> None:
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if entry.get("id") is not None:
                    by_id[str(entry["id"])] = entry
                contents = entry.get("contents")
                if isinstance(contents, list):
                    visit(contents)

        visit(library if isinstance(library, list) else [])

    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            missing.append("invalid reference")
            continue

        item_id = raw_item.get("id")
        if item_id is not None:
            current = by_id.get(str(item_id))
            if current is None:
                missing.append(str(item_id))
                continue
            filepath = current.get("absolute_path") or current.get("filepath") or current.get("path")
            if not filepath:
                missing.append(str(item_id))
                continue
            resolved.append({
                **raw_item,
                "id": current.get("id", item_id),
                "absolute_path": filepath,
                "filepath": filepath,
                "name": current.get("name") or current.get("filename") or raw_item.get("name"),
                "type": current.get("type") or raw_item.get("type", "asset"),
                "key": current.get("key", raw_item.get("key")),
                "bpm": current.get("bpm", raw_item.get("bpm")),
                "original_bpm": current.get("bpm", raw_item.get("original_bpm")),
                "duration_seconds": current.get("duration_seconds", raw_item.get("duration_seconds")),
                "vault_id": current.get("vault_id", raw_item.get("vault_id")),
                "collection_id": current.get("collection_id", raw_item.get("collection_id")),
                "content_index": current.get("content_index", raw_item.get("content_index")),
            })
            continue

        missing.append("missing GAIA id")

    if missing:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=422,
            detail=f"Asset Pool reference unavailable: {', '.join(missing)}."
        )
    return resolved


def _validate_resolved_pool_items(selected_items: Optional[List[Dict[str, Any]]]) -> list[dict[str, Any]]:
    """Validate the current GAIA snapshot already resolved by this API."""
    from fastapi import HTTPException

    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    for index, raw_item in enumerate(selected_items or []):
        if not isinstance(raw_item, dict) or raw_item.get("id") is None:
            missing.append(f"item {index}")
            continue
        filepath = raw_item.get("absolute_path") or raw_item.get("filepath") or raw_item.get("path")
        if not filepath:
            missing.append(str(raw_item.get("id")))
            continue
        resolved.append({**raw_item, "absolute_path": filepath, "filepath": filepath})
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Asset Pool reference unavailable: {', '.join(missing)}."
        )
    return resolved


@api_router.post("/pool/resolve", tags=["System"])
def resolve_pool(payload: PoolResolveRequest):
    started_at = perf_counter()
    metadata_queries = 0
    resolved_items = (
        _validate_resolved_pool_items(payload.selected_items)
        if payload.items_resolved
        else _resolve_pool_asset_keys(payload.selected_items)
    )
    pool_obj = ItemPoolObject(
        selected_items=resolved_items,
        seed=payload.seed,
        playback_mode=payload.playbackMode
    )
    sample = pool_obj.getNextSample()
    if (
        payload.prefer_different
        and payload.previous_sample
        and sample == payload.previous_sample
        and len(pool_obj.current_pool) > 1
    ):
        # Resolve the no-immediate-repeat rule in the same request. The client
        # previously retried up to six complete HTTP requests with new seeds.
        pool_obj.last_played_index = (pool_obj.last_played_index + 1) % len(pool_obj.current_pool)
        sample = pool_obj.current_pool[pool_obj.last_played_index]["absolute_path"]
    chosen_item = None
    if pool_obj.last_played_index >= 0 and pool_obj.last_played_index < len(pool_obj.current_pool):
        chosen_item = pool_obj.current_pool[pool_obj.last_played_index]

    bpm = (chosen_item.get("bpm") or chosen_item.get("original_bpm")) if chosen_item else None
    key = chosen_item.get("key") if chosen_item else None
    # ``items_resolved`` snapshots came from the exact GAIA query immediately
    # before pool selection. A stored null is authoritative; querying the same
    # row again cannot add information and used to add one DB round-trip/pool.
    if sample and not payload.items_resolved and (bpm is None or key is None):
        metadata_queries += 1
        gaia_metadata = _get_gaia_metadata(sample)
        if bpm is None:
            bpm = gaia_metadata.get("bpm")
        if key is None:
            key = gaia_metadata.get("key")

    if bpm is None and sample:
        from core.analyzers import BPMAnalyzer
        bpm = BPMAnalyzer.from_filename(sample)

    return {
        "sample": sample,
        "bpm": bpm,
        "key": key,
        "item": chosen_item,
        "items": pool_obj.current_pool,
        "diagnostics": {
            "item_count": len(resolved_items),
            "metadata_queries": metadata_queries,
            "duration_ms": round((perf_counter() - started_at) * 1000.0, 2),
        },
    }



@api_router.get("/library", tags=["System"])
def get_library(vault_id: Optional[int] = None):
    """
    Fetch library from Gaia API, or fallback to Gaia SQLite db if offline.
    GAIA owns analysis; IRIDE only returns already-indexed metadata.
    """
    import urllib.request
    import json
    import sqlite3

    files = []
    files_by_key = {}

    raw_items = []

    def prepare_and_filter_library(items_list: list[dict]) -> list[dict]:
        folder_types = {"collection", "sample_pack", "multitrack", "project"}
        organizer_types = {"collection", "sample_pack", "project"}
        pack_roots = []
        for item in items_list:
            item_type = item.get("type", "audio")
            abs_path = item.get("absolute_path") or ""
            if item_type in folder_types and abs_path:
                norm_root = os.path.abspath(abs_path).replace("\\", "/").lower()
                pack_roots.append(norm_root)

        final_files = []
        files_by_key = {}

        for item in items_list:
            item_type = item.get("type", "audio")
            abs_path = item.get("absolute_path") or ""
            norm_path = os.path.abspath(abs_path).replace("\\", "/").lower() if abs_path else ""

            # Filter out loose child items inside pack roots
            if item_type not in folder_types:
                is_inside_pack = any(
                    norm_path != pack_root and norm_path.startswith(pack_root + "/")
                    for pack_root in pack_roots
                )
                if is_inside_pack:
                    continue

            # Ensure collection / sample_pack items have prepared contents
            if item_type in organizer_types:
                root = item.get("absolute_path") or ""
                contents = item.get("contents") or []

                prepared_contents = []
                for content in contents:
                    relative_path = content.get("relative_path") or ""
                    candidate = os.path.abspath(os.path.join(root, relative_path))
                    collection_id = item.get("id")
                    content_index = content.get("index", len(prepared_contents))
                    child_id = content.get("child_id")
                    content_id = child_id if child_id is not None else (
                        f"collection:{collection_id}:{content_index}" if collection_id is not None else None
                    )
                    prepared_contents.append({
                        "id": content_id,
                        "collection_id": collection_id,
                        "content_index": content_index,
                        "filename": content.get("filename") or os.path.basename(candidate),
                        "title": content.get("title") or content.get("filename") or os.path.basename(candidate),
                        "relative_path": relative_path,
                        "absolute_path": candidate,
                        "type": content.get("type", "sample"),
                        "tags": content.get("tags", []),
                        "key": content.get("key"),
                        "bpm": content.get("bpm"),
                        "duration_seconds": content.get("duration_seconds"),
                        "favourite": bool(content.get("favourite") or (content.get("attributes") or {}).get("favourite", False)),
                        "stream_url": f"/api/library/stream/{content_id}" if content_id is not None else None,
                    })
                item["contents"] = prepared_contents

            key = str(item.get("id") or item.get("absolute_path") or len(final_files))
            if key not in files_by_key:
                files_by_key[key] = item
                final_files.append(item)

        return final_files

    # Try fetching from Gaia API first. GAIA defaults an omitted vault_id to
    # the default vault, so explicitly enumerate vaults when SIN asks for all.
    try:
        requested_vault_ids = [vault_id] if vault_id is not None else []
        if not requested_vault_ids:
            vault_req = urllib.request.Request("http://127.0.0.1:8001/vaults/", headers={'Accept': 'application/json'})
            with urllib.request.urlopen(vault_req, timeout=5.0) as response:
                if response.status == 200:
                    requested_vault_ids = [vault.get("id") for vault in json.loads(response.read().decode('utf-8'))]

        for requested_vault_id in requested_vault_ids:
            query = f"?vault_id={requested_vault_id}&limit=10000"
            req = urllib.request.Request(f"http://127.0.0.1:8001/items/{query}", headers={'Accept': 'application/json'})
            # Large vaults can take more than a couple of seconds to serialize.
            # A premature timeout triggers the much slower SQLite/analyzer fallback.
            with urllib.request.urlopen(req, timeout=15.0) as response:
                if response.status != 200:
                    continue
                for f in json.loads(response.read().decode('utf-8')):
                    abs_path = f.get("absolute_path") or ""
                    key = f.get("key")
                    bpm = f.get("bpm")
                    favourite = bool(f.get("favourite") or (f.get("attributes") or {}).get("favourite", False))
                    raw_items.append({
                        "id": f.get("id"),
                        "vault_id": f.get("vault_id"),
                        "absolute_path": abs_path,
                        "name": os.path.basename(abs_path),
                        "tags": f.get("tags", []),
                        "type": f.get("type", "audio"),
                        "key": key,
                        "bpm": bpm,
                        "duration_seconds": f.get("duration_seconds"),
                        "stems": f.get("stems"),
                        "is_valid_length": f.get("is_valid_length"),
                        "length_variance": f.get("length_variance"),
                        "contents": f.get("contents", []),
                        "favourite": favourite,
                        "attributes": f.get("attributes", {}),
                    })
        files = prepare_and_filter_library(raw_items)
        logger.debug(f"[API /library] Fetched {len(files)} files from Gaia API.")
        return {"files": files}
    except Exception as e:
        logger.warning(f"[API /library] Gaia API unreachable ({e}). Falling back to SQLite.")
        raw_items.clear()

    # Fallback to direct SQLite read
    db_path = "gaia.db"
    if not os.path.exists(db_path):
        db_path = os.path.join("gaia", "gaia.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            query = """
                SELECT i.id, i.absolute_path, i.type,
                       i.vault_id, i.metadata_json,
                       COALESCE(s.key, m.key, mt.key) as key,
                       COALESCE(s.bpm, m.bpm, mt.bpm) as bpm,
                       mt.stems_json, mt.is_valid_length, mt.length_variance,
                       ci.manifest_json
                FROM items i
                LEFT JOIN sample_items s ON i.id = s.id
                LEFT JOIN midi_items m ON i.id = m.id
                LEFT JOIN multitrack_items mt ON i.id = mt.id
                LEFT JOIN collection_items ci ON i.id = ci.id
            """
            params = []
            if vault_id is not None:
                query += " WHERE i.vault_id = ?"
                params.append(vault_id)
            cursor.execute(query, params)
            rows = cursor.fetchall()
            cursor.execute("""
                SELECT it.item_id, t.id, t.name
                FROM item_tags it
                JOIN tags t ON t.id = it.tag_id
            """)
            tags_by_item: dict[int, list[dict[str, Any]]] = {}
            for tag_row in cursor.fetchall():
                tags_by_item.setdefault(tag_row["item_id"], []).append({
                    "id": tag_row["id"],
                    "name": tag_row["name"],
                })
            for row in rows:
                item_id = row["id"]
                tags = tags_by_item.get(item_id, [])

                abs_path = row["absolute_path"] or ""
                key = row["key"]
                bpm = row["bpm"]

                stems_list = None
                if row["stems_json"]:
                    try:
                        stems_list = json.loads(row["stems_json"])
                    except Exception:
                        stems_list = []

                contents = []
                if row["manifest_json"]:
                    try:
                        contents = json.loads(row["manifest_json"])
                    except Exception:
                        contents = []

                metadata_json = row["metadata_json"]
                attributes = {}
                if metadata_json:
                    try:
                        attributes = json.loads(metadata_json)
                    except Exception:
                        attributes = {}
                favourite = bool(attributes.get("favourite", False))

                raw_items.append({
                    "id": item_id,
                    "vault_id": row["vault_id"],
                    "absolute_path": abs_path,
                    "name": os.path.basename(abs_path),
                    "tags": tags,
                    "type": row["type"],
                    "key": key,
                    "bpm": bpm,
                    "stems": stems_list,
                    "is_valid_length": bool(row["is_valid_length"]) if row["is_valid_length"] is not None else None,
                    "length_variance": row["length_variance"],
                    "contents": contents,
                    "favourite": favourite,
                    "attributes": attributes,
                })
            conn.close()
            files = prepare_and_filter_library(raw_items)
            logger.debug(f"[API /library] Fetched {len(files)} files from Gaia SQLite DB.")
        except Exception as e:
            logger.error(f"[API /library] Failed to read Gaia DB: {e}")
    else:
        logger.warning(f"[API /library] Gaia DB not found at {db_path}.")

    return {"files": files}


def _get_gaia_vaults():
    """Use GAIA directly when its companion server is not running."""
    from gaia import database, vaults
    db = database.SessionLocal()
    try:
        return vaults.get_vaults(db)
    finally:
        db.close()


@api_router.get("/vaults", tags=["System"])
def get_vaults():
    import json
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:8001/vaults/", timeout=5.0) as response:
            if response.status == 200:
                return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        logger.info("[API /vaults] Gaia API unavailable (%s); using local vault store.", exc)

    return _get_gaia_vaults()


class MidiParseRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[int] = None


class SequenceSaveRequest(BaseModel):
    name: str
    format: str = "sin-sequence"
    version: int = 1
    channels: List[Dict[str, List[Union[int, float, bool]]]]


class SequenceParseRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[int] = None


def _library_path(filepath: Optional[str], file_id: Optional[int]) -> Optional[str]:
    if filepath:
        return filepath
    if not file_id:
        return None
    import sqlite3
    db_path = "gaia.db" if os.path.exists("gaia.db") else os.path.join("gaia", "gaia.db")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT absolute_path FROM items WHERE id = ?", (file_id,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


@api_router.post("/sequence/save", tags=["System"])
def save_sequence_endpoint(payload: SequenceSaveRequest):
    """Delegate sequence persistence to GAIA, the sole library manager."""
    import urllib.error
    import urllib.request
    from fastapi import HTTPException

    request = urllib.request.Request(
        "http://127.0.0.1:8001/items/save-sequence",
        data=json.dumps(payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5.0) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except json.JSONDecodeError:
            pass
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="GAIA library manager is unavailable") from exc


@api_router.post("/sequence/parse", tags=["System"])
def parse_sequence_endpoint(payload: SequenceParseRequest):
    from fastapi import HTTPException

    actual_path = _library_path(payload.filepath, payload.file_id)
    if not actual_path:
        raise HTTPException(status_code=400, detail="Must provide filepath or file_id")
    path = Path(actual_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {actual_path}")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Sequence file is not valid JSON") from exc
    if document.get("format") != "sin-sequence" or document.get("version") != 1:
        raise HTTPException(status_code=400, detail="Unsupported sequence format or version")
    channels = document.get("channels")
    required = ("on", "probability", "offset", "velocity", "subdivisions")
    if not isinstance(channels, list) or not channels:
        raise HTTPException(status_code=400, detail="Sequence file has no channels")
    for channel in channels:
        lengths = [len(channel.get(key, [])) for key in required if isinstance(channel.get(key), list)]
        if len(lengths) != len(required) or not lengths or len(set(lengths)) != 1 or lengths[0] == 0:
            raise HTTPException(status_code=400, detail="Sequence channel parameter arrays are incomplete")
        if lengths[0] > 256:
            raise HTTPException(status_code=400, detail="Sequences may contain at most 256 steps")
        if any(
            not isinstance(value, (int, float, bool))
            for key in required
            for value in channel[key]
        ):
            raise HTTPException(status_code=400, detail="Sequence parameter arrays must be numeric")
    return document

@api_router.post("/midi/parse", tags=["System"])
def parse_midi_endpoint(payload: MidiParseRequest):
    from gaia import midi_parser
    actual_path = _library_path(payload.filepath, payload.file_id)

    if not actual_path:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Must provide filepath or file_id")

    if not os.path.exists(actual_path):
        alt_path = os.path.join("assets", actual_path)
        if os.path.exists(alt_path):
            actual_path = alt_path
        else:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail=f"File not found: {actual_path}")

    res = midi_parser.parse_midi_file(actual_path)
    return res

class TypeUpdateRequest(BaseModel):
    type: str

@api_router.patch("/library/{file_id}/type", tags=["System"])
def update_library_file_type(file_id: int, req: TypeUpdateRequest):
    import urllib.request
    import json
    from fastapi import HTTPException
    
    try:
        data = json.dumps({"type": req.type}).encode('utf-8')
        request = urllib.request.Request(f"http://127.0.0.1:8001/items/{file_id}", data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
        with urllib.request.urlopen(request, timeout=2.0) as response:
            if response.status == 200:
                return {"status": "success", "type": req.type}
            raise HTTPException(status_code=response.status, detail="Failed to update type in Gaia")
    except Exception as e:
        logger.error(f"[API /library] Failed to update type in Gaia: {e}")
        raise HTTPException(status_code=500, detail="Gaia API unreachable")

class LibraryMetadataProposalRequest(BaseModel):
    """A SIN-side request to stage, never apply, GAIA metadata."""

    filepath: str
    file_id: Optional[Union[str, int]] = None
    field: Literal["key", "bpm", "favourite"]
    value: Any
    previous_value: Any = None
    source_node_id: Optional[int] = None


@api_router.post("/library/metadata-proposals", tags=["System"])
def submit_library_metadata_proposal(req: LibraryMetadataProposalRequest):
    """Delegate a staged SIN edit to GAIA without changing an asset in SIN."""
    import urllib.error
    import urllib.request
    from fastapi import HTTPException

    payload = {
        "asset_ref": str(req.file_id) if req.file_id is not None else None,
        "absolute_path": req.filepath,
        "field": req.field,
        "proposed_value": req.value,
        "previous_value": req.previous_value,
        "source_node_id": req.source_node_id,
    }
    request = urllib.request.Request(
        "http://127.0.0.1:8001/sin-proposals/",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5.0) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except json.JSONDecodeError:
            pass
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except OSError:
        # The companion server may be offline while its local GAIA database is
        # still available. Calling its proposal service keeps ownership in
        # GAIA; SIN itself never updates an asset row.
        from gaia import database, schemas as gaia_schemas
        from gaia.routers import sin_proposals

        db = database.SessionLocal()
        try:
            return sin_proposals.create_metadata_proposal(
                gaia_schemas.SinMetadataProposalCreate(**payload),
                db,
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("[API /library/metadata-proposals] GAIA proposal service unavailable: %s", exc)
            raise HTTPException(status_code=503, detail="GAIA proposal queue is unavailable") from exc
        finally:
            db.close()


class LibraryBpmUpdateRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[Union[str, int]] = None
    bpm: float

@api_router.patch("/library/bpm", tags=["System"])
def update_library_bpm(req: LibraryBpmUpdateRequest):
    # Kept as a compatibility route for already-open SIN windows. It now
    # stages the requested BPM instead of applying a GAIA library mutation.
    return submit_library_metadata_proposal(
        LibraryMetadataProposalRequest(
            filepath=req.filepath or "",
            file_id=req.file_id,
            field="bpm",
            value=req.bpm,
        )
    )

    import urllib.request
    import json
    from fastapi import HTTPException

    bpm_val = float(req.bpm)
    if bpm_val < 20 or bpm_val > 400:
        raise HTTPException(status_code=400, detail="BPM must be between 20 and 400")

    gaia_updated = False
    
    # 1. Try GAIA HTTP API first
    try:
        file_id_str = str(req.file_id) if req.file_id is not None else ""
        if file_id_str.startswith("collection:"):
            parts = file_id_str.split(":")
            if len(parts) == 3:
                coll_id, content_idx = parts[1], parts[2]
                url = f"http://127.0.0.1:8001/items/{coll_id}/contents/{content_idx}"
                data = json.dumps({"bpm": int(round(bpm_val))}).encode('utf-8')
                request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                with urllib.request.urlopen(request, timeout=2.0) as response:
                    if response.status in (200, 201):
                        gaia_updated = True
        elif file_id_str.isdigit():
            item_id = int(file_id_str)
            url = f"http://127.0.0.1:8001/items/{item_id}"
            data = json.dumps({"bpm": int(round(bpm_val))}).encode('utf-8')
            request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
            with urllib.request.urlopen(request, timeout=2.0) as response:
                if response.status in (200, 201):
                    gaia_updated = True
        elif req.filepath:
            search_url = "http://127.0.0.1:8001/items/?limit=10000"
            request = urllib.request.Request(search_url, headers={'Accept': 'application/json'})
            with urllib.request.urlopen(request, timeout=2.0) as response:
                if response.status == 200:
                    items = json.loads(response.read().decode('utf-8'))
                    target_abs_path = os.path.abspath(req.filepath)
                    for item in items:
                        item_abs = item.get("absolute_path")
                        if item_abs and os.path.abspath(item_abs) == target_abs_path:
                            item_id = item["id"]
                            url = f"http://127.0.0.1:8001/items/{item_id}"
                            data = json.dumps({"bpm": int(round(bpm_val))}).encode('utf-8')
                            patch_req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                            with urllib.request.urlopen(patch_req, timeout=2.0) as patch_resp:
                                if patch_resp.status in (200, 201):
                                    gaia_updated = True
                            break
                        elif item.get("contents"):
                            coll_id = item["id"]
                            root = item.get("absolute_path") or ""
                            for content in item.get("contents") or []:
                                rel = content.get("relative_path") or ""
                                candidate = os.path.abspath(os.path.join(root, rel))
                                if candidate == target_abs_path:
                                    c_idx = content.get("index")
                                    url = f"http://127.0.0.1:8001/items/{coll_id}/contents/{c_idx}"
                                    data = json.dumps({"bpm": int(round(bpm_val))}).encode('utf-8')
                                    patch_req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                                    with urllib.request.urlopen(patch_req, timeout=2.0) as patch_resp:
                                        if patch_resp.status in (200, 201):
                                            gaia_updated = True
                                    break
                            if gaia_updated:
                                break
    except Exception as e:
        logger.warning(f"[API /library/bpm] Gaia HTTP request failed/skipped: {e}")

    # 2. If the companion HTTP process is unavailable, invoke GAIA's own
    # service layer in-process. SIN never writes GAIA tables directly.
    if not gaia_updated:
        from gaia import crud, database, models, schemas
        from gaia.routers import items as gaia_items

        db = database.SessionLocal()
        try:
            file_id_str = str(req.file_id) if req.file_id is not None else ""
            rounded_bpm = int(round(bpm_val))
            if file_id_str.startswith("collection:"):
                parts = file_id_str.split(":")
                if len(parts) == 3:
                    gaia_items.update_collection_content(
                        int(parts[1]),
                        int(parts[2]),
                        schemas.CollectionContentUpdate(bpm=rounded_bpm),
                        db,
                    )
                    gaia_updated = True
            elif file_id_str.isdigit():
                gaia_items.update_item(
                    int(file_id_str),
                    schemas.ItemUpdate(bpm=rounded_bpm),
                    db,
                )
                gaia_updated = True
            elif req.filepath:
                target_abs = os.path.abspath(req.filepath)
                item = crud.get_item_by_path(db, target_abs)
                if item and not isinstance(item, models.FolderItem):
                    gaia_items.update_item(
                        item.id,
                        schemas.ItemUpdate(bpm=rounded_bpm),
                        db,
                    )
                    gaia_updated = True
                else:
                    for folder in db.query(models.FolderItem).all():
                        folder = crud._populate_item_fields(folder)
                        for content in folder.contents or []:
                            candidate = os.path.abspath(
                                os.path.join(folder.absolute_path, content.get("relative_path") or "")
                            )
                            if candidate == target_abs:
                                gaia_items.update_collection_content(
                                    folder.id,
                                    content["index"],
                                    schemas.CollectionContentUpdate(bpm=rounded_bpm),
                                    db,
                                )
                                gaia_updated = True
                                break
                        if gaia_updated:
                            break
        except Exception as e:
            logger.info(f"[API /library/bpm] Current GAIA ORM schema unavailable: {e}")
        finally:
            db.close()

    return {"status": "success", "bpm": bpm_val, "updated": gaia_updated}


class LibraryFavouriteUpdateRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[Union[str, int]] = None
    favourite: bool


@api_router.patch("/library/favourite", tags=["System"])
def update_library_favourite(req: LibraryFavouriteUpdateRequest):
    # See update_library_bpm: library changes made from SIN are proposals.
    return submit_library_metadata_proposal(
        LibraryMetadataProposalRequest(
            filepath=req.filepath or "",
            file_id=req.file_id,
            field="favourite",
            value=req.favourite,
        )
    )

    import urllib.request
    import json
    from fastapi import HTTPException

    gaia_updated = False

    # 1. Try GAIA HTTP API first
    try:
        file_id_str = str(req.file_id) if req.file_id is not None else ""
        if file_id_str.startswith("collection:"):
            parts = file_id_str.split(":")
            if len(parts) == 3:
                coll_id, content_idx = parts[1], parts[2]
                url = f"http://127.0.0.1:8001/items/{coll_id}/contents/{content_idx}"
                data = json.dumps({"favourite": req.favourite}).encode('utf-8')
                request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                with urllib.request.urlopen(request, timeout=2.0) as response:
                    if response.status in (200, 201):
                        gaia_updated = True
        elif file_id_str.isdigit():
            item_id = int(file_id_str)
            url = f"http://127.0.0.1:8001/items/{item_id}"
            data = json.dumps({"favourite": req.favourite}).encode('utf-8')
            request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
            with urllib.request.urlopen(request, timeout=2.0) as response:
                if response.status in (200, 201):
                    gaia_updated = True
        elif req.filepath:
            search_url = "http://127.0.0.1:8001/items/?limit=10000"
            request = urllib.request.Request(search_url, headers={'Accept': 'application/json'})
            with urllib.request.urlopen(request, timeout=2.0) as response:
                if response.status == 200:
                    items = json.loads(response.read().decode('utf-8'))
                    target_abs_path = os.path.abspath(req.filepath)
                    for item in items:
                        item_abs = item.get("absolute_path")
                        if item_abs and os.path.abspath(item_abs) == target_abs_path:
                            item_id = item["id"]
                            url = f"http://127.0.0.1:8001/items/{item_id}"
                            data = json.dumps({"favourite": req.favourite}).encode('utf-8')
                            patch_req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                            with urllib.request.urlopen(patch_req, timeout=2.0) as patch_resp:
                                if patch_resp.status in (200, 201):
                                    gaia_updated = True
                            break
                        elif item.get("contents"):
                            coll_id = item["id"]
                            root = item.get("absolute_path") or ""
                            for content in item.get("contents") or []:
                                rel = content.get("relative_path") or ""
                                candidate = os.path.abspath(os.path.join(root, rel))
                                if candidate == target_abs_path:
                                    c_idx = content.get("index")
                                    url = f"http://127.0.0.1:8001/items/{coll_id}/contents/{c_idx}"
                                    data = json.dumps({"favourite": req.favourite}).encode('utf-8')
                                    patch_req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='PATCH')
                                    with urllib.request.urlopen(patch_req, timeout=2.0) as patch_resp:
                                        if patch_resp.status in (200, 201):
                                            gaia_updated = True
                                    break
                            if gaia_updated:
                                break
    except Exception as e:
        logger.warning(f"[API /library/favourite] Gaia HTTP request failed/skipped: {e}")

    # 2. In-process fallback
    if not gaia_updated:
        from gaia import crud, database, models, schemas
        from gaia.routers import items as gaia_items

        db = database.SessionLocal()
        try:
            file_id_str = str(req.file_id) if req.file_id is not None else ""
            if file_id_str.startswith("collection:"):
                parts = file_id_str.split(":")
                if len(parts) == 3:
                    gaia_items.update_collection_content(
                        int(parts[1]),
                        int(parts[2]),
                        schemas.CollectionContentUpdate(favourite=req.favourite),
                        db,
                    )
                    gaia_updated = True
            elif file_id_str.isdigit():
                gaia_items.update_item(
                    int(file_id_str),
                    schemas.ItemUpdate(favourite=req.favourite),
                    db,
                )
                gaia_updated = True
            elif req.filepath:
                target_abs = os.path.abspath(req.filepath)
                item = crud.get_item_by_path(db, target_abs)
                if item and not isinstance(item, models.FolderItem):
                    gaia_items.update_item(
                        item.id,
                        schemas.ItemUpdate(favourite=req.favourite),
                        db,
                    )
                    gaia_updated = True
                else:
                    for folder in db.query(models.FolderItem).all():
                        folder = crud._populate_item_fields(folder)
                        for content in folder.contents or []:
                            candidate = os.path.abspath(
                                os.path.join(folder.absolute_path, content.get("relative_path") or "")
                            )
                            if candidate == target_abs:
                                gaia_items.update_collection_content(
                                    folder.id,
                                    int(content["index"]),
                                    schemas.CollectionContentUpdate(favourite=req.favourite),
                                    db,
                                )
                                gaia_updated = True
                                break
                        if gaia_updated:
                            break
        except Exception as e:
            logger.error(f"[API /library/favourite] In-process update failed: {e}")
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            db.close()

    if not gaia_updated:
        raise HTTPException(status_code=404, detail="Item not found to update favourite")

    return {"status": "success", "favourite": req.favourite, "updated": gaia_updated}

@api_router.get("/library/stream/{file_id}")
def stream_library_file(file_id: str):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    import sqlite3
    import json
    
    db_path = "gaia.db"
    if not os.path.exists(db_path):
        db_path = os.path.join("gaia", "gaia.db")
        
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail="Gaia DB not found")
        
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    if file_id.startswith("collection:"):
        try:
            _, collection_id, content_index = file_id.split(":", 2)
            collection_id, content_index = int(collection_id), int(content_index)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid collection content reference") from exc
        cursor.execute("""
            SELECT i.absolute_path, ci.manifest_json
            FROM items i JOIN collection_items ci ON i.id = ci.id
            WHERE i.id = ?
        """, (collection_id,))
        collection = cursor.fetchone()
        conn.close()
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")
        try:
            contents = json.loads(collection["manifest_json"] or "[]")
            content = next(entry for entry in contents if entry.get("index") == content_index)
        except (ValueError, StopIteration, TypeError) as exc:
            raise HTTPException(status_code=404, detail="Collection content not found") from exc
        root = os.path.abspath(collection["absolute_path"])
        rel_path = content.get("relative_path") or ""
        content_path = os.path.abspath(os.path.join(root, rel_path))
        if not os.path.isfile(content_path):
            stripped_rel = re.sub(r'^extracted/[^/]+/', '', rel_path)
            alt_path = os.path.abspath(os.path.join(root, stripped_rel))
            if os.path.isfile(alt_path):
                content_path = alt_path

        if os.path.commonpath([root, content_path]) != root or not os.path.isfile(content_path):
            raise HTTPException(status_code=404, detail="Collection content is missing on disk")
        return FileResponse(path=content_path, media_type=content.get("mime_type") or "application/octet-stream")

    try:
        item_id = int(file_id)
    except ValueError as exc:
        conn.close()
        raise HTTPException(status_code=400, detail="Invalid library item reference") from exc
    cursor.execute("""
        SELECT i.absolute_path, i.type, mt.stems_json 
        FROM items i 
        LEFT JOIN multitrack_items mt ON i.id = mt.id 
        WHERE i.id = ?
    """, (item_id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="File not found in DB")
        
    abs_path = row["absolute_path"]
    if row["type"] == "multitrack" or os.path.isdir(abs_path):
        if row["stems_json"]:
            try:
                stems = json.loads(row["stems_json"])
                if stems and stems[0].get("absolute_path") and os.path.exists(stems[0]["absolute_path"]):
                    return FileResponse(path=stems[0]["absolute_path"], media_type="audio/wav")
            except Exception:
                pass
        # Fallback to search inside directory
        if os.path.isdir(abs_path):
            for root, _, files in os.walk(abs_path):
                for f in files:
                    if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg')):
                        return FileResponse(path=os.path.join(root, f))
        raise HTTPException(status_code=404, detail="No audio stem found in multitrack directory")
        
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="File missing on disk")
        
    return FileResponse(path=abs_path)

@api_router.get("/audio/file", tags=["Audio"])
def get_audio_file(filepath: str):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    if not filepath:
        raise HTTPException(status_code=400, detail="Missing filepath parameter")
    actual_path = filepath
    if not os.path.exists(actual_path):
        alt_path = os.path.join("assets", filepath)
        if os.path.exists(alt_path):
            actual_path = alt_path
        else:
            raise HTTPException(status_code=404, detail=f"Audio file not found: {filepath}")
    return FileResponse(path=actual_path)

@api_router.get("/audio/metadata", tags=["Audio"])
def get_audio_metadata(filepath: str):
    """Return read-only timing metadata used by arrangement visualizations."""
    from fastapi import HTTPException
    if not filepath:
        raise HTTPException(status_code=400, detail="Missing filepath parameter")
    actual_path = filepath
    if not os.path.exists(actual_path):
        alt_path = os.path.join("assets", filepath)
        if os.path.exists(alt_path):
            actual_path = alt_path
        else:
            raise HTTPException(status_code=404, detail=f"Audio file not found: {filepath}")
    try:
        info = sf.info(actual_path)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read audio metadata: {exc}") from exc
    return {
        "duration_seconds": float(info.duration),
        "sample_rate": int(info.samplerate),
        "frames": int(info.frames),
    }

app.include_router(api_router)

# Mount assets directory for audio previews
if os.path.exists("assets"):
    app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# Render/export folders are created lazily by their endpoints. Avoid creating
# workspace artifacts merely by importing the API (including during tests).
app.mount("/export", StaticFiles(directory="export", check_dir=False), name="export")

# Mount temp_renders directory for temporary rendered audio
app.mount(
    "/temp_renders",
    StaticFiles(directory="temp_renders", check_dir=False),
    name="temp_renders",
)

# IRIDE is built into static/ and served with the API on the same port.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True, check_dir=False), name="iride")

if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    logger.info("Starting uvicorn server directly from api.py with DEBUG logging...")
    uvicorn.run("api:app", host="127.0.0.1", port=8000, reload=True, log_level="debug")
