from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn
import os

from . import import_jobs, models, database, profiles, vaults
from .routers import items, media_edits, tags, projects, sin_proposals, vaults as vault_router

# Migrate the removed SamplePack subtype before ORM mappings query legacy rows.
database.migrate_sample_pack_profiles()
database.migrate_project_links()
models.Base.metadata.create_all(bind=database.engine)
database.migrate_performance_indexes()
with database.SessionLocal() as db:
    vaults.ensure_default_vault(db)
    profiles.ensure_builtin_profile_bundles()
import_jobs.cleanup_stale_staging()

app = FastAPI(
    title="Gaia Archive Manager",
    description="Isolated backend for managing file archives, integrity, and organization without duplicating assets.",
    version="1.0.0"
)

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(items.router)
app.include_router(media_edits.router)
app.include_router(tags.router)
app.include_router(projects.router)
app.include_router(sin_proposals.router)
app.include_router(vault_router.router)

# Mount static files
static_path = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_path, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_path), name="static")

@app.get("/")
def read_root():
    return FileResponse(os.path.join(static_path, "index.html"))

if __name__ == "__main__":
    # Run the server on port 8001 to keep it isolated from the main app
    uvicorn.run("gaia.main:app", host="127.0.0.1", port=8001, reload=True)
