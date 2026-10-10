---
name: sin-editor
description: Instructions and operational workflows for building, validating, modifying, and rendering audio graphs in the SIN node editor.
---

# SIN Node Editor Skill

Use this skill when you need to construct, edit, inspect, validate, or render audio compositions in SIN.

## Workflow: Composing a Graph

1. **Identify Global Parameters**:
   - Determine target BPM, musical key, and total bars (e.g. 120 BPM, 4 bars, key C).
2. **Select GAIA Assets**:
   - Query GAIA assets via `GET http://127.0.0.1:8001/items/?vault_id=1` or SQLite read on `gaia.db`.
   - Collect exact integer IDs (`id: 352`).
3. **Assemble Canonical Graph (`sin-graph`)**:
   - Construct JSON adhering to `sin-graph` version 1 schema.
   - Include nodes: `sample`, `sequence`, `track`, `arrangement`, `asset_filter`.
   - Include connections: audio routing (`from` -> `to`) and asset pool modifiers (`owner` -> `modifier`).
   - Assign exactly one master track (`role: "master"`).
4. **Validate**:
   - Verify that there are no audio feedback cycles.
   - Verify that all referenced node IDs in connections exist.
   - Verify that `sample` nodes have `sample_type` specified (`loop` or `one_shot`).
5. **Convert or Save**:
   - Convert to workspace format or write to `saves/<name>.json`.
   - Update `saves/.current-stage.json` if live auditioning is required.
6. **Preview & Render**:
   - Use `POST /api/render` or `POST /api/preview/ram` to execute DSP rendering.
   - Check audio playback via `/api/preview/ram/{id}`.

## Canonical Schema Quick Reference

```json
{
  "format": "sin-graph",
  "version": 1,
  "settings": { "bpm": 120, "total_bars": 4, "key": "C" },
  "nodes": [
    { "id": "kick", "type": "sample", "properties": { "sample_type": "one_shot" } },
    { "id": "kick-seq", "type": "sequence", "properties": { "step_count": 16, "step_length": 0.25, "steps": [...] } },
    { "id": "master", "type": "track", "role": "master", "properties": { "role": "master" } }
  ],
  "connections": [
    { "from": "kick", "to": "kick-seq", "type": "audio" },
    { "from": "kick-seq", "to": "master", "type": "audio" }
  ],
  "output": "master"
}
```

## Key Rules
- All frontend node implementations extend `BaseNode` in `editor/src/nodes/`.
- No `if (node.type === ...)` conditionals in UI code.
- SIN is strictly read-only towards GAIA assets.
