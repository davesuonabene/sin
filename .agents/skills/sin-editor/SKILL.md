---
name: sin-editor
description: Instructions and operational workflows for building, validating, modifying, and rendering audio graphs in the SIN node editor.
---

# SIN Node Editor Skill

Use this skill when you need to construct, edit, inspect, validate, or render audio compositions in SIN.

## Workflow: Composing & Auditioning via CLI & Editor

1. **Discover GAIA Assets**:
   - Query GAIA assets via CLI: `sin library search --tag <Tag> --limit 10 --json`.
   - Collect exact integer IDs (e.g. `id: 352`).
2. **Assemble Canonical Graph (`sin-graph`)**:
   - Construct JSON adhering to `sin-graph` version 1 schema.
   - Nodes: `sample`, `sequence`, `track`, `arrangement`, `asset_filter`, `random`.
   - Connections: audio signal flow (`from` -> `to`, `type: "audio"`).
   - Attachments: modifier parameter bindings (`owner` -> `modifier`, `type: "asset_pool"` | `"random"` | `"modulator"`).
   - Route drum & bass channels through dual submix buses (`Punch Drum Bus` and `Sub Bass Bus`) before `Master Output` (`role: "master"`).
3. **Validate & Verify**:
   - Validate topology: `sin compose validate presets/drums/<name>.json --json`.
   - Verify assets on disk: `sin library verify presets/drums/<name>.json --json`.
4. **Convert for Browser (Auto-Layout)**:
   - Convert to workspace format: `sin compose convert presets/drums/<name>.json --to workspace --out saves/<name>.json`.
   - ERMES auto-layout automatically assigns clean, non-overlapping 2D coordinates for the canvas.
5. **Render & QA**:
   - Headless render with metrics: `sin render presets/drums/<name>.json --qa --out temp_renders/<name>.wav`.
   - Ensure peak level stays below 0 dBFS.

## Canonical Schema Quick Reference

```json
{
  "format": "sin-graph",
  "version": 1,
  "settings": { "bpm": 120, "total_bars": 4, "key": "C" },
  "output": "master",
  "nodes": [
    { "id": "kick-pool", "type": "asset_filter", "properties": { "selected_items": [{ "id": 352 }], "playbackMode": "Random", "refresh_mode": "global" } },
    { "id": "kick", "type": "sample", "properties": { "sample_type": "one_shot" } },
    { "id": "kick-seq", "type": "sequence", "properties": { "step_count": 16, "step_length": 0.25, "sequence": [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0] } },
    { "id": "master", "type": "track", "role": "master", "properties": { "node_name": "Master Output", "gain": -3.0 } }
  ],
  "connections": [
    { "from": "kick", "to": "kick-seq", "type": "audio" },
    { "from": "kick-seq", "to": "master", "type": "audio" }
  ],
  "attachments": [
    { "owner": "kick", "modifier": "kick-pool", "type": "asset_pool" }
  ]
}
```

## Key Rules
- Presets are coordinate-agnostic: agents write pure topology; ERMES computes 2D coordinates on conversion.
- SIN is strictly read-only towards GAIA assets.
- For in-depth architectural details, see [`.agents/memory/sin-agent-workflow-guide.md`](file:///c:/web-projects/sin/.agents/memory/sin-agent-workflow-guide.md).
