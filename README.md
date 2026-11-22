# SIN + GAIA

SIN is the audio-node workspace and editor. GAIA is its standalone library manager: it owns importing, indexing, organizing, previewing, and relating library assets. The SIN editor only reads GAIA assets for use in nodes. IRIDE will be a future project.

## Run

Install the backend dependencies and the native Rubber Band tool once per
project virtual environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\tools\install-rubberband.ps1
```

Rubber Band is the default high-quality sample stretch engine. The installer
places the official GPL Rubber Band 4.0 executable inside `.venv`, so it stays
isolated to this checkout. To use a system-managed executable instead, set
`SIN_RUBBERBAND_EXECUTABLE` to its full path.

SIN and its API share port `8000`. Build the frontend, then start the server:

```bash
npm run build:editor
python run.py
```

On Windows, run the single entry point:

```powershell
.\start_win.ps1
```

It builds the native C++ audio engine (`engine/bin/sin_dsp.dll`) if missing/updated, builds SIN, starts both SIN (`:8000`) and GAIA (`:8001`) using `.venv`, waits for health checks, and opens both in the default browser. Pass `-Reload` for development hot reload. Press `Ctrl+C` to stop both services; logs are written under `.runtime/`.

On macOS (or Linux), run the single entry point:

```bash
./start_mac.sh
```

It compiles `engine/bin/libsin_dsp.dylib` automatically using Apple Clang + CoreAudio if missing (or falls back gracefully if no compiler is installed), builds SIN, and starts both services. Pass `--reload` for development hot reload.

The standalone Vite server is still available for isolated frontend debugging with `npm --prefix editor run dev:standalone`; it is not part of the normal stack.

Run the full test suite or build the SIN client with:

```bash
npm test
npm run build:editor
```

## GAIA library layout

GAIA has a physical, name-based vault layout:

```text
assets/
  vaults/
    default-vault/
    packs/
    field-recordings/
.gaia/
  profiles/
    zoom-recorders.json
gaia.db
```

- A vault owns its files under `assets/vaults/<storage-key>/`. Its storage key is the unique normalized vault name, set when the vault is created.
- Profiles are portable configuration bundles under `.gaia/profiles/`, never asset folders.
- Projects are typed folders located directly in their owning vault. Project-generated files belong in `project/files/<stage>/`; imported source folders remain clean.
- GAIA uses generic `ItemReference` graph edges for sources, stages, revisions, uses, and masters. A project is the context that owns those outgoing relationships.
- Each project keeps one `files/edit/current.json` manifest. It combines the media-editor state with a compact snapshot of its reference rows and paths; GAIA does not generate Markdown placeholders for linked assets.
- Audio is the base audio asset type. `track` and `sample` are its children; sample looping is the `sample.is_loop` metadata field. Folder types such as multitrack and sample pack only describe how people interpret a folder's contents.

The `assets/`, `.gaia/`, and `gaia.db` paths are local library data and are intentionally not source-controlled.

## Documentation

- [Documentation Home](docs/README.md) — User guides and reference index for SIN and GAIA.
- [Beginner First Start Guide](docs/start/README.md) — Step-by-step onboarding workshop and starter patches.

## Repository structure

- `api.py`, `core/`, `run.py` — SIN API and DSP engine.
- `gaia/` — GAIA API, library model, asset importers, profiles, projects, and references.
- `editor/` — TypeScript/Vite source for the SIN node editor.
- `gaia/static/` — GAIA manager source; `static/` — generated SIN editor build served on port 8000.
- `tests/` and `editor/tests/` — backend and frontend tests.
