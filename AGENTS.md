# Project guidance

## GAIA library ownership and storage

GAIA is the sole library-management application. The SIN node editor is a read-only consumer of GAIA assets: it may select a vault and browse, preview, or use its assets in nodes, but must not create, edit, import, scan, tag, organize, delete, or otherwise manage vaults or library assets. Implement all library-management UX and workflows in GAIA.

Each item has exactly one owning vault. A physically managed item's path must live under `assets/vaults/<storage_key>/`. A file imported with the explicit `keep` mode is instead an external reference owned logically by the selected vault: its `absolute_path` and immutable `source_path` may remain outside the vault, but GAIA must treat that external path as read-only. The sole exception is an explicit `move` operation that the user separately confirms after GAIA clearly warns that the files will disappear from their original locations; that operation moves the selected external files into the vault. Without that explicit move confirmation, never rename, move, overwrite, tag in place, delete, or create derivatives beside an external reference. Copy, keep/reference, project creation, project linking, orphan adoption, analysis, rendering, and cleanup must not alter external files or folders. Every materialized copy, project, and derivative must be created inside the owning vault; deleting an external reference deletes only GAIA's database record. A vault's `storage_key` is the unique normalized name established at creation; do not add numbered keys, virtual memberships, or path fallbacks. Profiles belong in `.gaia/profiles/`, outside the asset store.

Projects are typed folders directly inside their owning vault. They own relationship context and generated files under `files/<stage>/`; sources remain imported assets without GAIA-created files. Adopting an external reference into a project copies it into the project first, verifies and publishes the managed copy, and only then updates GAIA ownership; adoption never removes or alters the external source. Use generic `ItemReference` edges for every relationship, stage, revision, use, and master—do not create asset-specific relationship tables. The domain has no `live_recording` type: generic `audio` is the base; `track` and `sample` are children, and `sample.is_loop` is sample metadata.

Folders everywhere in GAIA (both within vaults and inside projects) are logical organizational bins. Placing, moving, grouping, or organizing items into folders never physically moves files on disk, changes an item's owning vault, or breaks external references. Deleting a folder deletes or dissolves only the organizational container or its project reference edges; it must never delete source files from disk or corrupt project references. Container deletion anywhere in GAIA must never fail due to child items having active project references; any referenced descendant items must be safely preserved (unparented to root) rather than blocking deletion.

## Node architecture and polymorphism

All node-specific rendering, styling, badge identifiers, default property initialization, and property inspector tab configurations must be encapsulated directly within `BaseNode` subclasses in `iride/src/nodes/`.

- When creating or modifying a node type, extend `BaseNode` and declare static class metadata (`defaultColor`, `defaultIcon`, `badgeLabel`, `nodeType`, `defaultTab`, `tabs`, and `fields`). `BaseNode` resolves dynamic fallbacks through its getters.
- Do not add external `if (node.type === ...)` switches in `iride/src/main.ts` or `iride/src/ui/PropertiesWindow.ts`. Delegate to node instance methods and getters such as `node.drawCanvas(ctx, canvas)`, `node.badgeLabel`, `node.propertiesTabs`, and `node.defaultPropertiesTab`.
- All frontend canvas node implementations inherit from `BaseNode` for consistent hit testing, action overlays, and drawing contracts.

## Parameter fields and inspector widgets

Declare node parameters as `FieldSchema[]` on their node class. Inspector panels render controls through `WidgetFactory.createRow(field, node, onChange)` and declare layouts through `static panelSchema: NodePanelSchema`. Change node state only via `node.updateProperty(key, value)` or `node.properties` so the UI and serialized payload remain aligned.
