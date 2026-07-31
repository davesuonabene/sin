import os
import logging
from fastapi import FastAPI, APIRouter
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import List, Optional, Literal, Dict, Any
import soundfile as sf
import numpy as np

from database.db import init_db
from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject, SamplePoolObject
from core.dsp import load_sample

logger = logging.getLogger("beat_generator.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Beat Generator server lifespan...")
    # Initialize DB schema on startup
    init_db()
    logger.debug("Database initialized successfully.")

    # Ensure static directory exists so StaticFiles doesn't crash
    os.makedirs("static", exist_ok=True)
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


class FxModuleModel(BaseModel):
    id: str
    type: str
    name: str
    enabled: bool = True
    fixed: bool = False
    params: Dict[str, Any] = {}

class AudioNodeModel(BaseModel):
    node_name: str
    node_type: str = "track"
    filepath: Optional[str] = None
    original_bpm: Optional[float] = None
    target_bpm: Optional[float] = None
    key: Optional[str] = None
    start_beat: float = 0.0
    bpm: float = 120.0
    filename: Optional[str] = None
    sequence: Optional[List[int]] = None
    step_length: Optional[float] = None
    filters: Optional[dict] = None
    playbackMode: Optional[str] = None
    seed: Optional[float] = None
    refresh_mode: Literal["parent_render", "self_render", "manual"] = "manual"
    total_bars: Optional[float] = None
    probability: Optional[float] = None
    chain: List[FxModuleModel] = []
    modulators: Optional[List[Dict[str, Any]]] = None
    children: List['AudioNodeModel'] = []

class PoolResolveRequest(BaseModel):
    filters: dict = {}
    seed: float = 0.0
    playbackMode: str = "Random"


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
                logger.debug(f"[DSP] Successfully loaded '{actual_path}' ({len(audio_data)} samples).")
            except Exception as e:
                logger.error(f"[DSP Error] Failed to load sample from '{actual_path}': {e}", exc_info=True)
        else:
            logger.warning(f"[DSP Warning] File not found: '{actual_path}'")

    if node_data.node_type == "sequence":
        seq_list = node_data.sequence if node_data.sequence is not None else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        step_len = node_data.step_length if node_data.step_length is not None else 0.25
        obj = SequenceObject(
            name=node_data.node_name,
            sequence=seq_list,
            step_length=step_len,
            original_bpm=node_data.original_bpm,
            filepath=actual_path
        )
    elif node_data.node_type == "sample_pool":
        obj = SamplePoolObject(
            name=node_data.node_name,
            filters=node_data.filters,
            playback_mode=node_data.playbackMode,
            seed=node_data.seed,
            refresh_mode=node_data.refresh_mode,
            original_bpm=node_data.original_bpm
        )
    elif node_data.node_type == "arrangement":
        from core.audio_object import ArrangementObject
        t_bars = node_data.total_bars if node_data.total_bars is not None else 4.0
        prob = node_data.probability if node_data.probability is not None else 1.0
        obj = ArrangementObject(
            name=node_data.node_name,
            total_bars=t_bars,
            probability=prob,
            seed=node_data.seed
        )
    elif node_data.node_type == "sample" or (audio_data is not None and node_data.node_type != "track"):
        obj = SampleObject(
            name=node_data.node_name,
            filepath=actual_path,
            original_bpm=node_data.original_bpm
        )
    else:
        obj = AudioObject(
            name=node_data.node_name,
            audio_data=audio_data,
            original_bpm=node_data.original_bpm,
            filepath=actual_path
        )

    for child_data in node_data.children:
        logger.debug(f"[Graph] Adding child '{child_data.node_name}' to parent '{node_data.node_name}' at start_beat={child_data.start_beat}")
        child_obj = build_audio_object(child_data)
        obj.add_child(child_obj, child_data.start_beat)

    return obj



from core.engines import get_renderer_for_node, build_node_object

@api_router.post("/render", tags=["System"])
def render_graph(payload: AudioNodeModel):
    logger.info(f"[API /render] Rendering node '{payload.node_name}' (type: {payload.node_type}) at {payload.bpm} BPM")
    sys = System(bpm=payload.bpm)
    renderer = get_renderer_for_node(payload.node_type)
    
    logger.debug(f"[DSP] Using rendering engine '{renderer.__class__.__name__}' for node '{payload.node_name}'...")
    audio_out = renderer.render(payload, sys)
    logger.debug(f"[DSP] Render complete. Output length: {len(audio_out)} samples.")

    from datetime import datetime
    temp_dir = "temp_renders"
    os.makedirs(temp_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base_name = payload.filename or "output"
    out_filename = f"{timestamp}_{base_name}_{payload.node_name}.wav"
    out_path = os.path.join(temp_dir, out_filename)

    sf.write(out_path, audio_out, sys.sample_rate)
    logger.info(f"[API /render] Rendered audio saved to '{out_path}'")

    return {"status": "success", "file_url": f"/temp_renders/{out_filename}", "filename": out_filename}

class ExportRequest(BaseModel):
    filename: str

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

@api_router.post("/pool/resolve", tags=["System"])
def resolve_pool(payload: PoolResolveRequest):
    pool_obj = SamplePoolObject(
        filters=payload.filters,
        seed=payload.seed,
        playback_mode=payload.playbackMode
    )
    sample = pool_obj.getNextSample()
    return {"sample": sample}


@api_router.get("/library", tags=["System"])
def get_library():
    """
    Fetch library from Gaia API, or fallback to Gaia SQLite db if offline.
    Includes extracted key and bpm metadata.
    """
    import urllib.request
    import json
    import sqlite3
    from gaia import text_analyzer

    files = []

    # Try fetching from Gaia API first
    try:
        req = urllib.request.Request("http://127.0.0.1:8001/items/", headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=1.0) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                for f in data:
                    abs_path = f.get("absolute_path") or ""
                    key = f.get("key")
                    bpm = f.get("bpm")
                    if abs_path and (key is None or bpm is None):
                        analysis = text_analyzer.analyze_path(abs_path)
                        if key is None:
                            key = analysis.get("key")
                        if bpm is None and analysis.get("bpm"):
                            try:
                                bpm = float(analysis.get("bpm"))
                            except (ValueError, TypeError):
                                pass
                    files.append({
                        "id": f.get("id"),
                        "absolute_path": abs_path,
                        "name": os.path.basename(abs_path),
                        "tags": f.get("tags", []),
                        "type": f.get("type", "audio"),
                        "key": key,
                        "bpm": bpm
                    })
                logger.debug(f"[API /library] Fetched {len(files)} files from Gaia API.")
                return {"files": files}
    except Exception as e:
        logger.warning(f"[API /library] Gaia API unreachable ({e}). Falling back to SQLite.")

    # Fallback to direct SQLite read
    db_path = "gaia.db"
    if not os.path.exists(db_path):
        db_path = os.path.join("gaia", "gaia.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("""
                SELECT i.id, i.absolute_path, i.type,
                       COALESCE(s.key, m.key) as key,
                       COALESCE(l.bpm, m.bpm) as bpm
                FROM items i
                LEFT JOIN sample_items s ON i.id = s.id
                LEFT JOIN loop_sample_items l ON i.id = l.id
                LEFT JOIN midi_items m ON i.id = m.id
            """)
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
                if abs_path and (key is None or bpm is None):
                    analysis = text_analyzer.analyze_path(abs_path)
                    if key is None:
                        key = analysis.get("key")
                    if bpm is None and analysis.get("bpm"):
                        try:
                            bpm = float(analysis.get("bpm"))
                        except (ValueError, TypeError):
                            pass
                files.append({
                    "id": item_id,
                    "absolute_path": abs_path,
                    "name": os.path.basename(abs_path),
                    "tags": tags,
                    "type": row["type"],
                    "key": key,
                    "bpm": bpm
                })
            conn.close()
            logger.debug(f"[API /library] Fetched {len(files)} files from Gaia SQLite DB.")
        except Exception as e:
            logger.error(f"[API /library] Failed to read Gaia DB: {e}")
    else:
        logger.warning(f"[API /library] Gaia DB not found at {db_path}.")

    return {"files": files}

class MidiParseRequest(BaseModel):
    filepath: Optional[str] = None
    file_id: Optional[int] = None

@api_router.post("/midi/parse", tags=["System"])
def parse_midi_endpoint(payload: MidiParseRequest):
    from gaia import midi_parser
    actual_path = payload.filepath

    if not actual_path and payload.file_id:
        import sqlite3
        db_path = "gaia.db" if os.path.exists("gaia.db") else os.path.join("gaia", "gaia.db")
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT absolute_path FROM items WHERE id = ?", (payload.file_id,))
            row = cursor.fetchone()
            conn.close()
            if row:
                actual_path = row["absolute_path"]

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

@api_router.get("/library/stream/{file_id}")
def stream_library_file(file_id: int):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    import sqlite3
    
    db_path = "gaia.db"
    if not os.path.exists(db_path):
        db_path = os.path.join("gaia", "gaia.db")
        
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail="Gaia DB not found")
        
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT absolute_path FROM items WHERE id = ?", (file_id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="File not found in DB")
        
    abs_path = row["absolute_path"]
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="File missing on disk")
        
    return FileResponse(path=abs_path)

app.include_router(api_router)

# Mount assets directory for audio previews
if os.path.exists("assets"):
    app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# Mount export directory for rendered audio
os.makedirs("export", exist_ok=True)
app.mount("/export", StaticFiles(directory="export"), name="export")

# Mount temp_renders directory for temporary rendered audio
os.makedirs("temp_renders", exist_ok=True)
app.mount("/temp_renders", StaticFiles(directory="temp_renders"), name="temp_renders")

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

