# SIN Architecture & System Boundaries

This rule set defines the architectural invariants, naming conventions, and subsystem boundaries for the SIN platform.

## 1. Subsystem Naming & Roles

- **SIN**: The node editor workspace and execution environment. SIN provides the visual node canvas, graph authoring, step sequencing, timeline arrangement, track mixing, and audio synthesis/preview/render engine. The frontend lives in `editor/` and is served alongside its API (`api.py`) on port 8000.
- **GAIA**: The sole library-management application. GAIA owns asset indexing, vault storage, database operations, file importing, project contexts, metadata analysis, and library organization. It runs as a standalone FastAPI service on port 8001.
- **ERMES**: The interop and serialization engine. ERMES bridges the SIN node editor and the GAIA/core DSP backend. It handles subtree graph traversal (`visit`), dynamic asset pool resolution, random seed advancement, parameter ranges, and JSON payload serialization (`AudioNodeModel`). The TypeScript traversal logic is in `ermes/ts/`, and the Python schemas are in `ermes/py/`.
- **IRIDE**: Reserved as the name for a future project. Do not use IRIDE to refer to the current SIN editor or GAIA asset manager.

---

## 2. GAIA Library Ownership & Storage Boundary

- **Sole Manager Contract**: GAIA is the sole library-management application. The SIN node editor is a **read-only consumer** of GAIA assets: it may select a vault and browse, preview, resolve, or use its assets in nodes, but **must never** create, edit, import, scan, tag, organize, delete, or otherwise mutate vaults or library assets directly.
- **Physical Storage**:
  - Each item belongs to exactly one owning vault. Managed items are stored physically under `assets/vaults/<storage_key>/`.
  - A file imported with the explicit `keep` mode is an external reference owned logically by the selected vault. Its `absolute_path` and `source_path` remain outside the vault and must be treated as strictly read-only.
  - Deleting an external reference deletes only GAIA's database row, never the external file.
  - Vault storage keys are unique normalized names assigned at creation (e.g. `default-vault`, `field-recordings`).
  - Configuration bundles and device profiles reside in `.gaia/profiles/`, outside the asset store.
- **Projects & References**:
  - Projects are typed folders inside their owning vault. They own relationship context and generated files under `project/files/<stage>/`. Sources remain untouched.
  - Relationships, stages, revisions, uses, and masters are tracked via generic `ItemReference` edges.
  - The domain has no `live_recording` type: generic `audio` is the base; `track` and `sample` are children, and `sample.is_loop` is sample metadata.
- **Folders as Logical Containers**:
  - Folders in GAIA are logical organizational bins. Placing, moving, grouping, or organizing items into folders never physically moves files on disk, changes an item's owning vault, or breaks external references.
  - Deleting a folder deletes or dissolves only the organizational container or its reference edges; it never deletes source files from disk or corrupts project references.
- **Metadata Proposals Queue**:
  - When the user edits metadata in the SIN editor (such as BPM, key, or tags), SIN **must not** modify the GAIA database directly.
  - Instead, SIN posts a review proposal to `POST /sin-proposals/` (`SinMetadataProposalCreate`). GAIA reviewers approve or reject these proposals asynchronously.

---

## 3. Node Architecture and Polymorphism

All node-specific rendering, styling, badge identifiers, default property initialization, and property inspector tab configurations must be encapsulated directly within `BaseNode` subclasses in `editor/src/nodes/`.

- When creating or modifying a node type, extend `BaseNode` and declare static class metadata:
  - `defaultColor`
  - `defaultIcon`
  - `badgeLabel`
  - `nodeType`
  - `defaultTab`
  - `tabs`
  - `fields`
- Dynamic fallbacks are resolved through `BaseNode` getters (`nodeColor`, `nodeIcon`, `badgeLabel`, `nodeType`, `propertiesTabs`, `defaultPropertiesTab`).
- **No External Switches**: Do not add external `if (node.type === ...)` conditionals in `editor/src/main.ts` or `editor/src/ui/PropertiesWindow.ts`. Delegate to node instance methods and getters such as `node.drawCanvas(ctx, canvas)`, `node.badgeLabel`, `node.propertiesTabs`, and `node.defaultPropertiesTab`.
- All frontend canvas node implementations inherit from `BaseNode` for consistent hit testing, action overlays, and drawing contracts.

---

## 4. Parameter Fields and Inspector Widgets

- Declare node parameters as `FieldSchema[]` on their node class.
- Inspector panels render controls through `WidgetFactory.createRow(field, node, onChange)` and declare layouts through `static panelSchema: NodePanelSchema`.
- Change node state only via `node.updateProperty(key, value)` or `node.properties` so the UI and serialized payload remain aligned.
