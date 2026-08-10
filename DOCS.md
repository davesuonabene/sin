# SIN Architecture & Technical Documentation

This document maintains high-level structural notes on how data, classes, and execution pipelines operate within the SIN platform. It serves as a guide for architecture refactoring, component reuse, and future development.

---

## 1. Overview & Refactoring Scope

The main goal of the ongoing refactoring is to transition from monolithic script patterns into modular, reusable, and cleanly separated components across both frontend and backend.

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend Canvas                      │
│   User Interaction ──► Node Properties & UI Sync         │
└──────────────────────────┬──────────────────────────────┘
                           │ Pre-Serialization Traversal
                           ▼
┌─────────────────────────────────────────────────────────┐
│               Serialization / Payload                   │
│   Subtree JSON Construction ──► API Request Payload      │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP POST / API
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Backend Graph                       │
│   JSON Parsing ──► Python AudioObjects ──► DSP Render   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Node Editor Processing (Before Serialization)

Before graph data is serialized into JSON payload structures for saving or backend execution, the node editor performs in-memory state management, link validation, dynamic parameter resolution, and node subtree traversal.

### 2.1 Core Classes & Roles

#### **Frontend Canvas & Nodes (`frontend/src/nodes/`)**
* **[`BaseNode`](file:///c:/web-projects/sin/frontend/src/nodes/BaseNode.ts)**: Abstract base class extending `LiteGraph.LGraphNode`. 
  * Declares static metadata defaults (`defaultColor`, `defaultIcon`, `badgeLabel`, `nodeType`, `defaultTab`, `tabs`) and dynamic fallback getters (`nodeColor`, `nodeIcon`, `badgeLabel`, `nodeType`, `propertiesTabs`, `defaultPropertiesTab`).
  * Encapsulates square canvas node rendering (`drawCanvas()`) with modular sub-methods (`drawSelectionRing()`, `drawBody()`, `drawIcon()`, `drawSlots()`, `drawBadges()`, `drawNameBadge()`), allowing `LGraphCanvas.prototype.drawNode` in `main.ts` to delegate directly to node instances.
  * Provides action buttons ([`CanvasButton`](file:///c:/web-projects/sin/frontend/src/ui/CanvasButton.ts)) for canvas preview, modulator connection, and deletion.
  * Injects default FX gain chains (`getDefaultFxChain()`).
  * Manages connection change listeners (`onConnectionsChange`).
* **Concrete Node Implementations**:
  * **[`SampleNode`](file:///c:/web-projects/sin/frontend/src/nodes/SampleNode.ts)** (`Audio/Sample`): Audio sample playback unit. Declares `static defaultColor = "#10b981"`, `static defaultIcon = "🎵"`, `static badgeLabel = "SMPL"`, `static nodeType = "sample"`, and `static fields: FieldSchema[]`.
  * **[`SequenceNode`](file:///c:/web-projects/sin/frontend/src/nodes/SequenceNode.ts)** (`Audio/Sequence`): Step sequencer pattern generator. Declares `static defaultColor = "#ec4899"`, `static defaultIcon = "🎹"`, `static badgeLabel = "SEQ"`, `static nodeType = "sequence"`, and `static fields: FieldSchema[]`.
  * **[`TrackNode`](file:///c:/web-projects/sin/frontend/src/nodes/TrackNode.ts)** (`Audio/Track`): Track mixing & output routing node. Declares `static defaultColor = "#4f46e5"`, `static defaultIcon = "🎛️"`, `static badgeLabel = "TRACK"`, `static nodeType = "track"`, and `static fields: FieldSchema[]`.
  * **[`ArrangementNode`](file:///c:/web-projects/sin/frontend/src/nodes/ArrangementNode.ts)** (`Audio/Arrangement`): Timeline arrangement & section quantizer. Declares `static defaultColor = "#f59e0b"`, `static defaultIcon = "🎼"`, `static badgeLabel = "ARR"`, `static nodeType = "arrangement"`, and `static fields: FieldSchema[]`.
  * **[`ModulatorNode`](file:///c:/web-projects/sin/frontend/src/nodes/ModulatorNode.ts)**: Base modulator/modifier node parent-owned by standard graph nodes. Declares `static defaultColor = "#9333ea"`, `static defaultIcon = "⚡"`, `static badgeLabel = "MOD"`, `static nodeType = "modulator"`, and `static fields: FieldSchema[]`.
  * **[`AssetFilterNode`](file:///c:/web-projects/sin/frontend/src/nodes/AssetFilterNode.ts)** (`Audio/AssetFilter`): **The active Asset Pool implementation**. It extends `ModulatorNode` as a parent-owned modifier. Declares `static defaultColor = "#7c3aed"`, `static defaultIcon = "⌕"`, `static badgeLabel = "PATH"`, `static nodeType = "asset_filter"`, and `static fields: FieldSchema[]`.
  * **[`DisabledNode`](file:///c:/web-projects/sin/frontend/src/nodes/DisabledNode.ts)** (`Audio/Disabled`): Bypass state indicator node. Extends `BaseNode` directly and declares `static defaultColor = "#64748b"`, `static defaultIcon = "⚠"`, `static badgeLabel = "DIS"`, `static nodeType = "disabled"`.

#### **UI Controls, Panel Schemas & Component Renderers (`frontend/src/fields/` & `frontend/src/ui/`)**
* **[`FieldSchema`](file:///c:/web-projects/sin/frontend/src/fields/FieldSchema.ts)**: Declarative parameter schema interface (`key`, `label`, `type`, `default`, `min`, `max`, `step`, `unit`, `options`). Declared statically on node classes and accessed via `node.getFields(tab)`.
* **[`NodePanelSchema`](file:///c:/web-projects/sin/frontend/src/fields/NodePanelSchema.ts)**: Declarative inspector layout blueprint interface. Declared statically on node classes (`SampleNode.panelSchema`, `SequenceNode.panelSchema`, etc.) to organize inspector controls and visualizers into tabs and section configurations.
* **[`SectionRendererFactory`](file:///c:/web-projects/sin/frontend/src/ui/SectionRendererFactory.ts)**: Reusable UI component builder. Reads section configurations (`fields`, `info_table`, `waveform_crop`, `sequence_grid`, `arrangement_timeline`, `fx_chain`, `pool_editor`) and instantiates modular inspector UI widgets.
* **[`WidgetFactory`](file:///c:/web-projects/sin/frontend/src/ui/WidgetFactory.ts)**: Centralized field widget builder service. Automates creation of `.td-param-row` parameter controls (string, number, dropdown, toggle, interactive drag dB float box, seed randomize button) with bounds clamping and validation.
* **[`PropertiesWindow`](file:///c:/web-projects/sin/frontend/src/ui/PropertiesWindow.ts)**: Lightweight, generic inspector host. Resolves `node.getPanelSchema()`, iterates over tab sections, and delegates section rendering to `SectionRendererFactory`.
* **Single Source of Truth Node State**: Node state lives strictly in `node.properties`. `node.updateProperty(key, val)` directly mutates `node.properties`, syncs ghost node link bindings, and guarantees zero state drift prior to serialization.

---

### 2.2 Data Flow & Pre-Serialization Pipeline

When a node operation (e.g., render preview, parameter change, connection update) is triggered, data flows through the following stages **prior to serialization**:

```
[ User Action / Property Edit ]
              │
              ▼
[ Properties Sync & Connection Validation ]
  - LiteGraph Node properties updated (`nodeObj.properties`)
  - UI State synced (`syncGhostTrackData`)
  - Pin links normalized (`normalizeInputs`)
              │
              ▼
[ Subtree Traversal (`visit(rootNodeId)`) ]
  - Recursive traversal of connected upstream input nodes
              │
              ▼
[ Dynamic Pre-computation (`serializeNodeSubtree`) ]
  - Resolution of BPM, step lengths, arrangement sections
  - Random seed evaluation based on `refresh_mode` ("self_render" vs "parent_render")
  - Exclude/bypass check (`disabled` nodes skipped)
              │
              ▼
[ Ready for JSON Serialization & API Payload ]
```

#### **Key Processing Steps**:

1. **State Synchronization (`syncGhostTrackData`)**:
   * Synchronizes LiteGraph canvas `LGraphNode.properties` with UI cache structures (`trackNodes`).
   * Ensures editable fields (e.g. sequence steps, FX chains, filters) reflect the latest user input.

2. **Connection Normalization (`normalizeInputs`)**:
   * Evaluates input/output connection changes.
   * Adjusts slot connections dynamically to ensure correct signal routing between upstream source nodes and downstream targets.

3. **Upstream Subtree Traversal (`visit`)**:
   * Traverses input pins recursively using link origins (`link.origin_id`) to assemble only the required subtree of nodes connected to the targeted output or preview node.

4. **Asset Pool Modulator Resolution (`resolveAssignedAssetFilters`)**:
   * Prior to graph serialization for preview or rendering, `resolveAssignedAssetFilters(graph, rootNodeId)` is invoked.
   * It inspects assigned asset modulators (`asset_modifier_id`), resolves matching audio files using [`AssetFilterNode`](file:///c:/web-projects/sin/frontend/src/nodes/AssetFilterNode.ts) filter rules (`resolveAssetFilterNode`), updates pool seeds (`advanceAssetPoolSeed`), and dynamically injects the chosen asset's `filepath` and `original_bpm` into the host node (e.g. [`SampleNode`](file:///c:/web-projects/sin/frontend/src/nodes/SampleNode.ts)).

5. **Dynamic Parameter & Seed Evaluation**:
   * **FX Chain Verification**: Ensures pre-gain and post-gain FX chains (`getDefaultFxChain`) are initialized and attached.
   * **Filtering & Bypassing**: Skips nodes marked as `disabled` or `Audio/Disabled`.

---

## 3. Backend Processing (Before Serialization & Rendering)

On the backend ([`api.py`](file:///c:/web-projects/sin/api.py) and [`core/`](file:///c:/web-projects/sin/core/)), graph dictionaries received from the frontend are converted into Python object instances prior to DSP pipeline execution.

### 3.1 Backend Core Hierarchy (`core/`)

* **[`BaseObject`](file:///c:/web-projects/sin/core/base_object.py)**: Root class for all backend graph nodes.
* **[`AudioObject`](file:///c:/web-projects/sin/core/audio_object.py)**: Base for audio-producing nodes. Subclasses include:
  * `SampleObject`
  * `TrackObject`
  * `SequenceObject`
  * `ArrangementObject`
  * `ItemPoolObject`
* **DSP & Engine Modules**:
  * **[`core/engines.py`](file:///c:/web-projects/sin/core/engines.py)**: Audio synthesis and engine execution.
  * **[`core/dsp.py`](file:///c:/web-projects/sin/core/dsp.py)**: Digital signal processing utilities (resampling, pitch shifting, gain scaling).
  * **[`core/fx.py`](file:///c:/web-projects/sin/core/fx.py)**: FX chain processing (equalizer, compressor, gain, reverb).

---

## 4. Next Steps & Reorganization Targets

1. **Frontend Modularization**:
   * Extract graph serialization and state sync functions out of [`main.ts`](file:///c:/web-projects/sin/frontend/src/main.ts) into a dedicated `NodeGraphManager` or `GraphSerializer` service.
   * Standardize node creation and property synchronization interfaces across custom node classes.

2. **Component Reuse**:
   * Consolidate duplicate UI inspector controls in [`PropertiesWindow.ts`](file:///c:/web-projects/sin/frontend/src/ui/PropertiesWindow.ts) into reusable UI widgets.
