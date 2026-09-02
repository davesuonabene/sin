# Canonical graph schema

IRIDE stores workspaces in LiteGraph's runtime format under `saves/`. The
canonical graph schema is a smaller authoring format for generating or
modifying those workspaces safely.

```json
{
  "format": "sin-graph",
  "version": 1,
  "nodes": [
    { "id": "sample-loop", "type": "sample", "properties": { "sample_type": "loop" } },
    { "id": "arrangement", "type": "arrangement" },
    { "id": "master", "type": "track", "role": "master" }
  ],
  "connections": [
    { "from": "sample-loop", "to": "arrangement", "type": "audio" },
    { "from": "arrangement", "to": "master", "type": "audio" }
  ],
  "settings": { "bpm": 120, "total_bars": 4, "key": "C" },
  "output": "master"
}
```

The initial rules are intentionally small:

- Node IDs are unique strings.
- Supported node types are `sample`, `sequence`, `arrangement`, `track`,
  `asset_filter`, `modulator`, and `disabled`.
- Sample nodes must declare `sample_type` as `loop` or `one_shot`.
- Connections are directed `audio` edges between known nodes and may not cycle.
- A complete graph has one master track, referenced by `output`.
- BPM, length, and key are required graph settings.

## Asset pools

An Asset Pool is an `asset_filter` node attached to a `sample` or `sequence`
through an ownership attachment. It is not an audio edge:

```json
{
  "id": "kick-pool",
  "type": "asset_filter",
  "properties": {
    "selected_items": [
      { "id": 352 }
    ],
    "playbackMode": "Random",
    "refresh_mode": "local",
    "seed": 42
  }
}
```

`selected_items` is the complete ordered pool. Each entry is an exact GAIA
asset key, normally `{ "id": 352 }`. The Library panel may use filters to help
the user find assets before adding them, but those filters are UI state and are
never a pool-resolution instruction or persisted pool field.

```json
{ "owner": "kick-sample", "modifier": "kick-pool", "type": "asset_pool" }
```

Pool items are deliberately minimal locators. A GAIA ID is resolved against
the current GAIA library at load/preview time, then its current path and
metadata are supplied to the owning Sample or Sequence node. If the ID is no
longer available, resolution fails; it must not substitute a name, collection
member, path snapshot, or filter match. Resolved output fields, paths copied
onto owners, and sequential cursor state are runtime state and are stripped
from workspace saves.

The TypeScript module at `ermes/ts/graphSchema.ts` exposes two local functions:

- `validateGraphDocument(value)` checks a document and returns readable errors.
- `graphDocumentToWorkspacePreset(document)` converts it into the existing
  LiteGraph workspace format used by the editor.

The canonical format accepts both the structured `assetPool` field and the
current flat LiteGraph properties when converting or validating a graph. The
flat fields remain open-ended so existing node functionality is not discarded
while the typed pool fields document the behavior the agent needs to reason
about.

When a workspace is saved, the editor reduces each pool to its persistent
recipe: exact `selected_items` locators, `playbackMode`, `refresh_mode`, and
`seed`. It does not keep filters, the resolved output path, copied owner
metadata, or selection cursor. `off` mode may keep one exact `fixed_item`
locator. This is the intended minimal representation.

The current save format can be authored safely. Reading and modifying arbitrary
existing LiteGraph saves still needs a canonical importer; until that exists,
the agent should preserve unknown properties and use the existing workspace
format carefully.

This is a local programming API, not a network API. A server endpoint is not
necessary yet: the editor already knows how to load and save workspace JSON.
An HTTP or CLI API becomes useful later if an external agent or tool needs to
edit graphs without going through the browser, or if we want atomic patching,
dry-runs, and validation on the server.
