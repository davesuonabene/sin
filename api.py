import os
import json
import logging
import re
from pathlib import Path
from fastapi import FastAPI, APIRouter, Request
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import List, Optional, Literal, Dict, Any, Union
import soundfile as sf
import numpy as np

from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, ItemPoolObject
from core.dsp import load_sample

logger = logging.getLogger("beat_generator.api")
SAVES_DIR = Path(__file__).resolve().parent / "saves"


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
    logger.info("Initializing Beat Generator server lifespan...")

    # Ensure static directory exists so StaticFiles doesn't crash
    os.makedirs("static", exist_ok=True)
    SAVES_DIR.mkdir(exist_ok=True)
    logger.debug("Static directory confirmed.")
    yield
    logger.info("Shutting down Beat Generator server lifespan...")


app = FastAPI(
    title="Beat Generator API",
    description="Foundational REST API for Automated Beat Generator",
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
        "service": "beat-generator-api",
        "version": "0.1.0"
    }


from ermes import FxModuleModel, AudioNodeModel, PoolResolveRequest


def build_audio_object(node_data: AudioNodeModel) -> AudioObject:
    audio_data = None
    actual_path = node_data.filepath
    if actual_path:
        if not os.path.exists(actual_path):
            actual_path = os.path.join("assets", actual_path)

        if os.path.exists(actual_path):
            try:
                logger.debug(f"[DSP] Loading audio sample from '{actual_path}'...")
                audio_data, _ = load_sample(actual_path)
                logger.debug(f"[DSP] Successfully loaded '{actual_path}' ({audio_data.shape[-1]} samples).")
            except Exception as e:
                logger.error(f"[DSP Error] Failed to load sample from '{actual_path}': {e}", exc_info=True)
        else:
            logger.warning(f"[DSP Warning] File not found: '{actual_path}'")

    if node_data.node_type == "sequence":
        seq_list = node_data.sequence if node_data.sequence is not None else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        step_len = node_data.step_length if node_data.step_length is not None else 0.25
        play_mode = node_data.play_mode or "gate"
        obj = SequenceObject(
            name=node_data.node_name,
            sequence=seq_list,
            step_parameters=node_data.step_parameters,
            step_length=step_len,
            play_mode=play_mode,
            fade_ms=node_data.fade_ms,
            seed=node_data.seed,
            seed_mode=node_data.seed_mode or "moving",
            original_bpm=node_data.original_bpm,
            filepath=actual_path,
            sample_type=node_data.sample_type or "loop"
        )

    elif node_data.node_type == "arrangement":
        from core.audio_object import ArrangementObject
        t_bars = node_data.total_bars if node_data.total_bars is not None else 4.0
        prob = node_data.probability if node_data.probability is not None else 1.0
        obj = ArrangementObject(
            name=node_data.node_name,
            total_bars=t_bars,
            probability=prob,
            seed=node_data.seed,
            section_points=node_data.section_points,
            section_enabled=node_data.section_enabled,
            section_probability=node_data.section_probability,
            section_sample_start=node_data.section_sample_start,
            section_quant=node_data.section_quant,
            section_quant_anchor=node_data.section_quant_anchor,
            quant=node_data.quant,
            quant_anchor=node_data.quant_anchor
        )
    elif node_data.node_type == "sample" or (audio_data is not None and node_data.node_type != "track"):
        refresh_mode = str(node_data.refresh_mode or "off").strip().casefold()
        if node_data.node_type == "sample" and node_data.selected_items and refresh_mode in {
            "local", "local_refresh", "self_render",
            "parent", "parent_refresh", "parent_render"
        }:
            obj = ItemPoolObject(
                name=node_data.node_name,
                filters=node_data.filters or {},
                selected_items=node_data.selected_items,
                playback_mode=node_data.playbackMode or "Random",
                seed=node_data.seed,
                refresh_mode=refresh_mode,
                original_bpm=node_data.original_bpm,
                crop_start=node_data.crop_start,
                crop_end=node_data.crop_end,
                sample_type=node_data.sample_type or "loop",
                transpose=node_data.transpose,
                cents=node_data.cents,
                stretch_mode=node_data.stretch_mode or "time_stretch",
                stretch_factor=node_data.stretch_factor
            )
        else:
            obj = SampleObject(
                name=node_data.node_name,
                filepath=actual_path,
                original_bpm=node_data.original_bpm,
                crop_start=node_data.crop_start,
                crop_end=node_data.crop_end,
                sample_type=node_data.sample_type or "loop",
                transpose=node_data.transpose,
                cents=node_data.cents,
                stretch_mode=node_data.stretch_mode or "time_stretch",
                stretch_factor=node_data.stretch_factor
            )
    else:
        obj = AudioObject(
            name=node_data.node_name,
            audio_data=audio_data,
            original_bpm=node_data.original_bpm,
            filepath=actual_path,
            crop_start=node_data.crop_start,
            crop_end=node_data.crop_end,
            sample_type=node_data.sample_type or "loop",
            total_bars=node_data.total_bars
        )

    for child_data in node_data.children:
        logger.debug(f"[Graph] Adding child '{child_data.node_name}' to parent '{node_data.node_name}' at start_beat={child_data.start_beat}")
        child_obj = build_audio_object(child_data)
        obj.add_child(child_obj, child_data.start_beat)

    return obj



from core.engines import get_renderer_for_node, build_node_object

RAM_PREVIEW_STORE: Dict[str, Dict[str, Any]] = {}

@api_router.post("/render", tags=["System"])
def render_graph(payload: AudioNodeModel):
    from fastapi import HTTPException
    logger.info(f"[API /render] Rendering node '{payload.node_name}' (type: {payload.node_type}) at {payload.bpm} BPM")
    try:
        sys = System(bpm=payload.bpm)
        renderer = get_renderer_for_node(payload.node_type)
        
        logger.debug(f"[DSP] Using rendering engine '{renderer.__class__.__name__}' for node '{payload.node_name}'...")
        audio_out = renderer.render(payload, sys)
        logger.debug(f"[DSP] Render complete. Output length: {audio_out.shape[-1]} samples.")

        from datetime import datetime
        temp_dir = "temp_renders"
        os.makedirs(temp_dir, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base_name = payload.filename or "output"
        out_filename = f"{timestamp}_{base_name}_{payload.node_name}.wav"
        out_path = os.path.join(temp_dir, out_filename)

        sf.write(
            out_path,
            np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
            sys.sample_rate,
        )
        logger.info(f"[API /render] Rendered audio saved to '{out_path}'")

        return {"status": "success", "file_url": f"/temp_renders/{out_filename}", "filename": out_filename}
    except Exception as e:
        logger.error(f"[API /render Error] {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/preview", tags=["Preview"])
def preview_graph_ram(payload: AudioNodeModel):
    import io
    from fastapi import HTTPException
    logger.info(f"[API /preview] Rendering RAM preview for node '{payload.node_name}' (type: {payload.node_type}) at {payload.bpm} BPM")
    try:
        sys = System(bpm=payload.bpm)
        renderer = get_renderer_for_node(payload.node_type)
        audio_out = renderer.render(payload, sys)
        # Keep an intentionally silent/disconnected graph preview decodable by browsers.
        if audio_out.shape[-1] == 0:
            audio_out = np.zeros(max(1, sys.sample_rate // 10), dtype=np.float32)

        buf = io.BytesIO()
        sf.write(
            buf,
            np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out,
            sys.sample_rate,
            format='WAV',
        )
        bytes_data = buf.getvalue()

        base_name = payload.filename or "preview"
        node_key = payload.filename or payload.node_name
        out_filename = f"{base_name}_{payload.node_name}.wav"

        RAM_PREVIEW_STORE[node_key] = {
            "wav_bytes": bytes_data,
            "filename": out_filename,
            "node_name": payload.node_name,
            "sample_rate": sys.sample_rate,
            "payload": payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        }

        logger.info(f"[API /preview] Stored RAM preview for key '{node_key}' ({len(bytes_data)} bytes)")
        return {
            "status": "success",
            "preview_id": node_key,
            "audio_url": f"/api/preview/stream/{node_key}",
            "filename": out_filename
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
    common_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }

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


@api_router.get("/workspaces", tags=["Workspaces"])
def list_workspace_presets():
    SAVES_DIR.mkdir(exist_ok=True)
    files = sorted(SAVES_DIR.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
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

@api_router.post("/pool/resolve", tags=["System"])
def resolve_pool(payload: PoolResolveRequest):
    pool_obj = ItemPoolObject(
        filters=payload.filters,
        selected_items=payload.selected_items,
        seed=payload.seed,
        playback_mode=payload.playbackMode
    )
    sample = pool_obj.getNextSample()
    chosen_item = None
    if pool_obj.last_played_index >= 0 and pool_obj.last_played_index < len(pool_obj.current_pool):
        chosen_item = pool_obj.current_pool[pool_obj.last_played_index]

    gaia_metadata = _get_gaia_metadata(sample) if sample else {"bpm": None, "key": None}
    bpm = gaia_metadata.get("bpm")
    key = gaia_metadata.get("key")
    if bpm is None and chosen_item:
        bpm = chosen_item.get("bpm") or chosen_item.get("original_bpm")
    if key is None and chosen_item:
        key = chosen_item.get("key")

    if bpm is None and sample:
        from core.analyzers import BPMAnalyzer
        bpm = BPMAnalyzer.from_filename(sample)
        if bpm is None and os.path.exists(sample):
            try:
                from core.dsp import load_sample
                audio, duration = load_sample(sample)
                if audio.shape[-1] > 0:
                    bpm = BPMAnalyzer.from_duration(duration)
            except Exception:
                pass

    return {
        "sample": sample,
        "bpm": bpm,
        "key": key,
        "item": chosen_item,
        "items": pool_obj.current_pool
    }



@api_router.get("/library", tags=["System"])
def get_library(vault_id: Optional[int] = None):
    """
    Fetch library from Gaia API, or fallback to Gaia SQLite db if offline.
    Includes extracted key and bpm metadata, as well as multitrack stem information.
    """
    import urllib.request
    import json
    import sqlite3
    from gaia import text_analyzer

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
                if not contents and root and os.path.isdir(root):
                    try:
                        contents = collection_importer.build_manifest(Path(root))
                    except Exception:
                        contents = []

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
            with urllib.request.urlopen(vault_req, timeout=1.0) as response:
                if response.status == 200:
                    requested_vault_ids = [vault.get("id") for vault in json.loads(response.read().decode('utf-8'))]

        for requested_vault_id in requested_vault_ids:
            query = f"?vault_id={requested_vault_id}&limit=10000"
            req = urllib.request.Request(f"http://127.0.0.1:8001/items/{query}", headers={'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=2.0) as response:
                if response.status != 200:
                    continue
                for f in json.loads(response.read().decode('utf-8')):
                    abs_path = f.get("absolute_path") or ""
                    key = f.get("key")
                    bpm = f.get("bpm")
                    if abs_path and (key is None or bpm is None) and f.get("type") != "multitrack":
                        analysis = text_analyzer.analyze_path(abs_path)
                        if key is None:
                            key = analysis.get("key")
                        if bpm is None and analysis.get("bpm"):
                            try:
                                bpm = float(analysis.get("bpm"))
                            except (ValueError, TypeError):
                                pass
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
                       i.vault_id,
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
            for row in rows:
                item_id = row["id"]
                cursor.execute("""
                    SELECT t.id, t.name
                    FROM tags t
                    JOIN item_tags it ON t.id = it.tag_id
                    WHERE it.item_id = ?
                """, (item_id,))
                tag_rows = cursor.fetchall()
                tags = [{"id": tr["id"], "name": tr["name"]} for tr in tag_rows]

                abs_path = row["absolute_path"] or ""
                key = row["key"]
                bpm = row["bpm"]
                if abs_path and (key is None or bpm is None) and row["type"] != "multitrack":
                    analysis = text_analyzer.analyze_path(abs_path)
                    if key is None:
                        key = analysis.get("key")
                    if bpm is None and analysis.get("bpm"):
                        try:
                            bpm = float(analysis.get("bpm"))
                        except (ValueError, TypeError):
                            pass

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
        with urllib.request.urlopen("http://127.0.0.1:8001/vaults/", timeout=1.0) as response:
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

class LibraryBpmUpdateRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[Union[str, int]] = None
    bpm: float

@api_router.patch("/library/bpm", tags=["System"])
def update_library_bpm(req: LibraryBpmUpdateRequest):
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

# Mount the static folder at the root to serve the Vite frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    logger.info("Starting uvicorn server directly from api.py with DEBUG logging...")
    uvicorn.run("api:app", host="127.0.0.1", port=8000, reload=True, log_level="debug")
