import os
import logging
from fastapi import FastAPI, APIRouter
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import List, Optional
import soundfile as sf
import numpy as np

from database.db import init_db
from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject
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


class AudioNodeModel(BaseModel):
    node_name: str
    node_type: str = "track"
    filepath: Optional[str] = None
    original_bpm: Optional[float] = None
    start_beat: float = 0.0
    bpm: float = 120.0
    filename: Optional[str] = None
    sequence: Optional[List[int]] = None
    step_length: Optional[float] = None
    children: List['AudioNodeModel'] = []


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

    base_name = payload.filename or "output"
    out_filename = f"{base_name}_{payload.node_name}.wav"
    out_path = os.path.join(".", out_filename)

    sf.write(out_path, audio_out, sys.sample_rate)
    logger.info(f"[API /render] Rendered audio saved to '{out_path}'")

    return {"status": "success", "file_url": f"/{out_filename}"}


@api_router.get("/library", tags=["System"])
def get_library():
    """
    Scan the assets directory and return a list of available audio files.
    """
    os.makedirs("assets", exist_ok=True)
    valid_extensions = {".wav", ".mp3", ".aif", ".aiff", ".ogg", ".flac"}
    files = []

    for filename in os.listdir("assets"):
        ext = os.path.splitext(filename)[1].lower()
        if ext in valid_extensions:
            files.append(filename)

    logger.debug(f"[API /library] Found {len(files)} sound files in assets directory.")
    return {"files": files}


app.include_router(api_router)

# Mount assets directory for audio previews
if os.path.exists("assets"):
    app.mount("/assets", StaticFiles(directory="assets"), name="assets")

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

