# SIN + GAIA

SIN is the audio-node workspace. GAIA is its standalone library manager: it owns importing, indexing, organizing, previewing, and relating library assets. SIN only reads GAIA assets for use in nodes.

## Run

Start the main SIN API:

```bash
python run.py
```

For the complete development environment (SIN API, GAIA on port 8001, and the IRIDE Vite client), use:

```bash
bash start-all.sh
```

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
- Audio is the base audio asset type. `track` and `sample` are its children; sample looping is the `sample.is_loop` metadata field. Folder types such as multitrack and sample pack only describe how people interpret a folder's contents.

The `assets/`, `.gaia/`, and `gaia.db` paths are local library data and are intentionally not source-controlled.

## Repository structure

- `api.py`, `core/`, `run.py` — SIN API and DSP engine.
- `gaia/` — GAIA API, library model, asset importers, profiles, projects, and references.
- `iride/` — TypeScript/Vite source for the node editor.
- `gaia/static/`, `static/` — served frontend assets.
- `tests/` and `iride/tests/` — backend and frontend tests.
