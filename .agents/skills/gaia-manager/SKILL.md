---
name: gaia-manager
description: Instructions and operational workflows for browsing vaults, querying assets, resolving pools, and submitting metadata proposals to GAIA manager.
---

# GAIA Manager Skill

Use this skill when you need to inspect GAIA vaults, query audio items, resolve asset pools, or propose metadata modifications from the SIN editor.

## Workflow: Interacting with GAIA

1. **Querying Vaults & Assets**:
   - Query available vaults:
     `GET http://127.0.0.1:8001/vaults/?preview=quick`
   - Retrieve assets within a vault:
     `GET http://127.0.0.1:8001/items/?vault_id={id}&limit=1000`
   - Retrieve collection contents:
     `GET http://127.0.0.1:8001/items/{id}/contents`
2. **Offline Fallback**:
   - If port 8001 is offline, read `gaia.db` using sqlite3 in read-only mode (`SELECT * FROM items WHERE vault_id = ?`).
3. **Submitting Metadata Proposals**:
   - Never mutate `gaia.db` rows directly from the editor.
   - Post proposed metadata changes (BPM, key, tags) to:
     `POST http://127.0.0.1:8001/sin-proposals/`
     Payload schema:
     ```json
     {
       "item_id": 352,
       "field": "bpm",
       "proposed_value": 128.0,
       "original_value": 120.0,
       "confidence": 1.0,
       "source_context": "sin_node_inspector"
     }
     ```
4. **Physical Vault Boundaries**:
   - Physically managed files are in `assets/vaults/<storage_key>/`.
   - External references (`keep` mode) are strictly read-only.
   - Folders are logical bins and do not move files on disk.
