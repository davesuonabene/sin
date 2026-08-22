# Project guidance

## GAIA library ownership and storage

GAIA is the sole library-management application. The SIN node editor is a read-only consumer of GAIA assets: it may select a vault and browse, preview, or use its assets in nodes, but must not create, edit, import, scan, tag, organize, delete, or otherwise manage vaults or library assets. Implement all library-management UX and workflows in GAIA.

Each item has exactly one owning vault and its managed path must live under `assets/vaults/<storage_key>/`. A vault's `storage_key` is the unique normalized name established at creation; do not add numbered keys, virtual memberships, or path fallbacks. Profiles belong in `.gaia/profiles/`, outside the asset store.

Projects are typed folders directly inside their owning vault. They own relationship context and generated files under `files/<stage>/`; sources remain imported assets without GAIA-created files. Use generic `ItemReference` edges for every relationship, stage, revision, use, and master—do not create asset-specific relationship tables. The domain has no `live_recording` type: generic `audio` is the base; `track` and `sample` are children, and `sample.is_loop` is sample metadata.

## Node architecture and polymorphism

All node-specific rendering, styling, badge identifiers, default property initialization, and property inspector tab configurations must be encapsulated directly within `BaseNode` subclasses in `iride/src/nodes/`.

- When creating or modifying a node type, extend `BaseNode` and declare static class metadata (`defaultColor`, `defaultIcon`, `badgeLabel`, `nodeType`, `defaultTab`, `tabs`, and `fields`). `BaseNode` resolves dynamic fallbacks through its getters.
- Do not add external `if (node.type === ...)` switches in `iride/src/main.ts` or `iride/src/ui/PropertiesWindow.ts`. Delegate to node instance methods and getters such as `node.drawCanvas(ctx, canvas)`, `node.badgeLabel`, `node.propertiesTabs`, and `node.defaultPropertiesTab`.
- All frontend canvas node implementations inherit from `BaseNode` for consistent hit testing, action overlays, and drawing contracts.

## Parameter fields and inspector widgets

Declare node parameters as `FieldSchema[]` on their node class. Inspector panels render controls through `WidgetFactory.createRow(field, node, onChange)` and declare layouts through `static panelSchema: NodePanelSchema`. Change node state only via `node.updateProperty(key, value)` or `node.properties` so the UI and serialized payload remain aligned.
