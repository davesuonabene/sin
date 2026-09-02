# IRIDE + GAIA

IRIDE is the audio-node workspace. GAIA is its standalone library manager: it owns importing, indexing, organizing, previewing, and relating library assets. IRIDE only reads GAIA assets for use in nodes. SIN remains the repository and audio-engine name, not a separate frontend.

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

IRIDE and its API share port `8000`. Build the frontend, then start the server:

```bash
npm run build:iride
python run.py
```

On Windows, double-click `start-all.cmd`. It performs one IRIDE build, starts
the two stable services, waits for both health checks, and opens IRIDE and GAIA
in the default browser. Keep its launcher window open; press Ctrl+C there to
stop both services. Service logs are written under `.runtime/`.

The launcher invokes `.venv/Scripts/python.exe` directly and verifies that its
Python prefix is exactly the project `.venv`. It never activates or falls back
to a system Python environment.

On Linux or macOS, use:

```bash
bash start-all.sh
```

Stable mode is the default. For explicit development hot reload on Windows, use:

```powershell
.\start-all-dev.ps1 -Reload
```

On Linux or macOS, pass `--reload` to `start-all.sh`. Reload mode adds the
IRIDE build watcher; stable mode has only the IRIDE and GAIA server processes.

The standalone Vite server is still available for isolated frontend debugging with `npm --prefix iride run dev:standalone`; it is not part of the normal stack.

Run the full test suite or build the IRIDE client with:

```bash
npm test
npm run build:iride
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

## Repository structure

- `api.py`, `core/`, `run.py` — IRIDE API and DSP engine.
- `gaia/` — GAIA API, library model, asset importers, profiles, projects, and references.
- `iride/` — TypeScript/Vite source for the node editor.
- `gaia/static/` — GAIA manager source; `static/` — generated IRIDE build served on port 8000.
- `tests/` and `iride/tests/` — backend and frontend tests.
