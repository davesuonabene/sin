# Project guidance

## GAIA library ownership

GAIA is the sole library-management application. The SIN node editor is a read-only consumer of GAIA assets: it may select a vault and browse, preview, or use its assets in nodes, but must not create, edit, import, scan, tag, organize, delete, or otherwise manage vaults or library assets. Implement all library-management UX and workflows in the GAIA library manager.

## Node Architecture & Polymorphism

All node-specific rendering, styling, badge identifiers, default property initialization, and property inspector tab configurations must be encapsulated directly within the node class implementations (`BaseNode` subclasses in `frontend/src/nodes/`). 

- **Subclass Responsibilities**: When creating or modifying a node type, extend `BaseNode` and declare static class metadata (`static defaultColor`, `static defaultIcon`, `static badgeLabel`, `static nodeType`, `static defaultTab`, `static tabs`, `static fields`). `BaseNode` handles dynamic fallback resolution via getters (`node.nodeColor`, `node.nodeIcon`, `node.badgeLabel`, `node.nodeType`, `node.propertiesTabs`).
- **Canvas & UI Delegation**: Do NOT write external `if (node.type === ...)` switch statements in `main.ts` or `PropertiesWindow.ts`. External handlers must delegate directly to node instance methods and getters (`node.drawCanvas(ctx, canvas)`, `node.badgeLabel`, `node.propertiesTabs`, `node.defaultPropertiesTab`).
- **Inheritance Hierarchy**: All frontend canvas node implementations must inherit from `BaseNode` to ensure consistent hit testing, action button overlay support, and canvas drawing contracts.

## Parameter Field Schemas & Inspector UI Widgets

All node parameter definitions (type, label, default value, min/max bounds, units, select options) must be declared as `FieldSchema[]` arrays on the node class (`static fields: FieldSchema[] = [...]` in `frontend/src/nodes/`).

- **Field Declarations**: Declare parameters using `FieldSchema` objects rather than manually appending raw HTML inputs in `PropertiesWindow.ts`.
- **Widget Factory**: Inspector panels must render parameter controls via `WidgetFactory.createRow(field, node, onChange)` to ensure consistent validation, bounds clamping, ghost parameter binding support, and event dispatching.
- **Inspector Panel Schemas & Single Source of Truth**: Declare node inspector layouts via `static panelSchema: NodePanelSchema` on node classes (`frontend/src/nodes/`). Mutate node state strictly via `node.updateProperty(key, val)` or `node.properties` to ensure zero state drift between UI controls and serialization payloads.
