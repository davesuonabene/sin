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
   - Post proposed metadata changes (BPM, key, favourite) to:
     `POST http://127.0.0.1:8001/sin-proposals/`
     Payload schema (`SinMetadataProposalCreate`):
     ```json
     {
       "asset_ref": "352",
       "absolute_path": "C:/web-projects/sin/assets/vaults/default-vault/samples/Kick.wav",
       "field": "bpm",
       "proposed_value": 128.0,
       "previous_value": 120.0,
       "source_node_id": 12
     }
     ```
   - Proposals are reviewed and accepted in GAIA via `POST /sin-proposals/{id}/accept`.
4. **Physical Vault Boundaries**:
   - Physically managed files are in `assets/vaults/<storage_key>/`.
   - External references (`keep` mode) are strictly read-only.
   - Folders are logical bins and do not move files on disk.
5. **Horizontal Playlists**:
   - Query available playlists:
     `GET http://127.0.0.1:8001/playlists/`
   - Retrieve playlist items across vaults:
     `GET http://127.0.0.1:8001/playlists/{id}`
   - Playlists are horizontal, decoupled item pointer collections that span vaults without altering file residency or database vault ownership.

