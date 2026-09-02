# SIN Architecture & Technical Documentation

This document maintains high-level structural notes on how data, classes, execution pipelines, and components operate within the SIN platform. It outlines the 3-component architecture (**IRIDE**, **ERMES**, and **GAIA**) and serves as the authoritative blueprint for development, refactoring, and component integration.

---

## 1. High-Level Architecture Overview

The SIN platform is divided into three distinct, specialized subsystem layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        IRIDE (Node Frontend)                           │
│   Canvas UI, BaseNode Polymorphism, Inspector Panels & UI Widgets      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Visual Graph State
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     ERMES (Serialization Engine)                       │
│   Subtree Traversal, Seed Evaluation, Dynamic Asset Resolver, Schemas  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Canonical JSON Payload (AudioNodeModel)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      GAIA (Backend & DSP Engine)                       │
│   ┌──────────────────────────────┐  ┌──────────────────────────────┐   │
│   │   GAIA Asset Library Vaults  │  │     GAIA Audio DSP Engine    │   │
│   │   (Indexing, DB, Vaults)     │  │   (DSP, FX, AudioObjects)    │   │
│   └──────────────────────────────┘  └──────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Subsystem Boundaries & Responsibilities

| Subsystem | Folder / Location | Responsibilities | Key Modules |
| :--- | :--- | :--- | :--- |
| **IRIDE** | `iride/` | Visual graph editing, drag-and-drop links, LiteGraph canvas rendering, polymorphic `BaseNode` classes, parameter field schemas, inspector UI controls. | `nodes/*`, `fields/*`, `ui/*`, `main.ts` |
| **ERMES** | `ermes/` | Interop & serialization engine. Pre-serialization node subtree traversal (`visit`), random seed generation, dynamic asset pool resolution, Pydantic schemas, payload compilation. | `ermes/ts/*` (TS engine), `ermes/py/*` (Python models) |
| **GAIA** | `gaia/` & `core/` | Python backend platform housing **GAIA Asset Library Vaults** (asset indexing, SQLite database, metadata extraction) and **GAIA Audio DSP Engine** (synthesis renderers, FX chains, pitch shifting, `AudioObject` trees, WAV rendering). | `gaia/*` (Vaults/DB), `core/*` (DSP Engine), `api.py` |

---

## 2. Component Layout & Directory Structure

```
sin/
├── gaia/                     # [GAIA Backend, Library Manager & DSP Engine]
│   ├── dsp/ (or core/)       # Audio DSP operations, FX modules, AudioObjects, renderers
│   │   ├── dsp.py            # Resampling, pitch shifting, gain, stretching
│   │   ├── fx.py             # Equalizer, Compressor, Reverb, Saturation
│   │   ├── engines.py        # Sample, Sequence, Track & Arrangement renderers
│   │   └── audio_object.py   # Audio tree structure & graph execution
│   ├── vaults/               # Asset management & DB controllers
│   ├── main.py               # GAIA service entry point (Port 8001)
│   └── routers/              # GAIA & DSP API endpoints
│
├── ermes/                    # [ERMES Serialization Engine]
│   ├── ts/                   # TypeScript serialization & traversal engine
│   │   ├── traversal.ts      # Subtree recursive traversal & link validation
│   │   ├── assetResolver.ts  # Dynamic asset pool seed & filter resolver
│   │   └── serializer.ts     # Main ErmesSerializer class
│   └── py/                   # Python serialization models & validation
│       ├── schemas.py        # Ermes AudioNodeModel & FxModuleModel Pydantic schemas
│       └── validator.py      # Backend payload validator & graph constructor
│
└── iride/                    # [IRIDE Node Frontend]
    ├── src/
    │   ├── nodes/            # BaseNode hierarchy & polymorphic custom nodes
    │   ├── fields/           # FieldSchema & NodePanelSchema declarations
    │   ├── ui/               # Inspector components (WidgetFactory, PropertiesWindow)
    │   └── main.ts           # LiteGraph canvas setup & main UI event loop
    ├── package.json
    └── vite.config.ts
```

---

## 3. Node Editor & Subtree Traversal (IRIDE ➔ ERMES)

Before graph data is transmitted to the backend for preview or DSP rendering, **IRIDE** delegates state processing to **ERMES**.

### 3.1 Core Classes & Roles

#### **Frontend Canvas & Nodes (`iride/src/nodes/`)**
* **[`BaseNode`](file:///c:/web-projects/sin/iride/src/nodes/BaseNode.ts)**: Abstract base class extending `LiteGraph.LGraphNode`.
  * Declares static metadata defaults (`defaultColor`, `defaultIcon`, `badgeLabel`, `nodeType`, `defaultTab`, `tabs`) and dynamic fallback getters (`nodeColor`, `nodeIcon`, `badgeLabel`, `nodeType`, `propertiesTabs`, `defaultPropertiesTab`).
  * Encapsulates square canvas node rendering (`drawCanvas()`) with sub-methods (`drawSelectionRing()`, `drawBody()`, `drawIcon()`, `drawSlots()`, `drawBadges()`, `drawNameBadge()`).
  * Integrates canvas action buttons ([`CanvasButton`](file:///c:/web-projects/sin/iride/src/ui/CanvasButton.ts)).
* **Concrete Node Implementations**:
  * **[`SampleNode`](file:///c:/web-projects/sin/iride/src/nodes/SampleNode.ts)** (`Audio/Sample`): Audio sample playback unit.
  * **[`SequenceNode`](file:///c:/web-projects/sin/iride/src/nodes/SequenceNode.ts)** (`Audio/Sequence`): Step sequencer pattern generator.
  * **[`TrackNode`](file:///c:/web-projects/sin/iride/src/nodes/TrackNode.ts)** (`Audio/Track`): Track mixing & output routing node.
  * **[`ArrangementNode`](file:///c:/web-projects/sin/iride/src/nodes/ArrangementNode.ts)** (`Audio/Arrangement`): Timeline arrangement & section quantizer.
  * **[`AssetFilterNode`](file:///c:/web-projects/sin/iride/src/nodes/AssetFilterNode.ts)** (`Audio/AssetFilter`): Asset Pool filter modifier.
  * **[`DisabledNode`](file:///c:/web-projects/sin/iride/src/nodes/DisabledNode.ts)** (`Audio/Disabled`): Bypass state indicator node.

#### **UI Controls, Panel Schemas & Component Renderers (`iride/src/fields/` & `iride/src/ui/`)**
* **[`FieldSchema`](file:///c:/web-projects/sin/iride/src/fields/FieldSchema.ts)**: Declarative parameter schema interface (`key`, `label`, `type`, `default`, `min`, `max`, `step`, `unit`, `options`).
* **[`NodePanelSchema`](file:///c:/web-projects/sin/iride/src/fields/NodePanelSchema.ts)**: Declarative inspector layout blueprint interface.
* **[`SectionRendererFactory`](file:///c:/web-projects/sin/iride/src/ui/SectionRendererFactory.ts)**: Reusable UI component builder.
* **[`WidgetFactory`](file:///c:/web-projects/sin/iride/src/ui/WidgetFactory.ts)**: Centralized field widget builder service (`.td-param-row`).
* **[`PropertiesWindow`](file:///c:/web-projects/sin/iride/src/ui/PropertiesWindow.ts)**: Inspector host resolving `node.getPanelSchema()`.

---

### 3.2 ERMES Serialization Pipeline

When a render/preview is requested, ERMES executes the following pipeline:

```
[ User Action / Property Edit ]
              │
              ▼
[ Properties Sync & Connection Validation ]
  - LiteGraph Node properties synced (node.properties)
  - Pin links normalized (normalizeInputs)
              │
              ▼
[ ERMES Subtree Traversal (visit(rootNodeId)) ]
  - Recursive traversal of connected upstream input pins
  - Exclude disabled/Audio/Disabled nodes
              │
              ▼
[ ERMES Asset & Seed Resolution ]
  - Query GAIA database for assigned asset pool filters (AssetFilterNode)
  - Advance dynamic random seeds (moving vs self_render)
  - Inject resolved audio file paths & original_bpm into payload
              │
              ▼
[ ERMES Canonical JSON Serialization ]
  - Output AudioNodeModel payload dictionary to GAIA API (/api/render, /api/preview)
```

---

## 4. Backend Processing & DSP Engine (ERMES ➔ GAIA)

Upon receiving an `AudioNodeModel` payload from ERMES, GAIA converts graph dictionaries into execution objects for DSP rendering:

### 4.1 GAIA Object Hierarchy (`core/`)

* **[`BaseObject`](file:///c:/web-projects/sin/core/base_object.py)**: Root class for all backend graph execution objects.
* **[`AudioObject`](file:///c:/web-projects/sin/core/audio_object.py)**: Base class for audio rendering units. Subclasses include:
  * `SampleObject`
  * `TrackObject`
  * `SequenceObject`
  * `ArrangementObject`
  * `ItemPoolObject`

### 4.2 GAIA DSP Modules

* **[`core/engines.py`](file:///c:/web-projects/sin/core/engines.py)**: Node synthesis renderers (`SampleRenderer`, `SequenceRenderer`, `TrackRenderer`, `ArrangementRenderer`).
* **[`core/dsp.py`](file:///c:/web-projects/sin/core/dsp.py)**: DSP operations (resampling, pitch shifting, time stretching, gain scaling).
* **[`core/fx.py`](file:///c:/web-projects/sin/core/fx.py)**: Audio FX chain modules (equalizer, compressor, gain, reverb).

---

## 5. GAIA Asset Hierarchy and Managed Imports

GAIA stores each library entry in one polymorphic Asset hierarchy. `audio` is the concrete raw-audio type; `track` and `sample` inherit from it. `sample.is_loop` is metadata, so loop and one-shot are not library types. MIDI, sequences, and generic files stay separate. Folder items keep their imported child rows and manifest projection; `ProjectItem` is the folder subtype used for project-owned files and the project state manifest.

Folder types are generic collections, sample packs, multitracks, and managed Projects. `multitrack` is a folder interpretation: its children remain generic audio files. A device profile, such as Zoom H4, is a shareable JSON bundle in `.gaia/profiles/`; it supplies labels and a default preview without creating a database subtype.

`POST /items/import` accepts a file, folder, or ZIP. Folder analysis selects collections, sample packs, or multitracks; a directly selected audio file is registered as raw `audio`. Projects are explicit creation workflows and are never auto-detected. Explicit multitrack imports retain validation warnings when lengths or filename roles look inconsistent.

Projects are the sole owners of logical relationship contexts. `item_references` is a generic directed graph table: any item can be an endpoint, while `context_id` must be a Project. Creating a project from a file, folder, multitrack, sample pack, or another project leaves the source untouched and creates a read-only `source` reference. Stages, revisions, derived results, master selection, and profile interpretations are references in that project context. Derived outputs are copied into `projects/<name>/files/<stage>/`; sources are never moved there.

Each project keeps one `files/edit/current.json` document. It carries the editor state and a compact snapshot of project reference rows and paths. The SQLite graph remains canonical; `current.json` is an atomic, human-readable filesystem view, not a second relationship authority. GAIA creates no Markdown reference placeholders or stage/version documents.

---

## 6. Architectural Compliance Rules

As outlined in `AGENTS.md`:
1. **GAIA Library Ownership**: GAIA is the sole library-management application. IRIDE is a read-only consumer of GAIA assets (browsing, previewing, and using assets in nodes).
2. **Polymorphic Node Architecture**: All node rendering, styling, badges, default properties, and panel schemas are encapsulated within `BaseNode` subclasses in `nodes/`. External `if (node.type === ...)` conditionals are strictly prohibited.
3. **Declarative Fields & Widget Factory**: Node parameters must be declared via `FieldSchema[]` arrays and rendered via `WidgetFactory.createRow()`.
