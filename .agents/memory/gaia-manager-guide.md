# GAIA Manager Interaction Guide & Agent Memory

This document is the authoritative guide and memory for interacting with **GAIA**, the standalone library and asset management platform for the SIN ecosystem.

---

## 1. System Role & Responsibilities

- **Sole Manager Authority**: GAIA is the **sole library-management application**. It owns:
  - Asset indexing, file system scanning, and metadata extraction (BPM, key, duration, sample rate, channels, stems).
  - Physical vault storage under `assets/vaults/<storage_key>/`.
  - SQLite database management (`gaia.db`).
  - Import workflows (managed copies vs external references in `keep` mode).
  - Projects, project files, revisions, and graph relationships (`item_references`).
  - Profiles for devices and recorders (`.gaia/profiles/`).
- **SIN Editor Boundary**: The SIN node editor is a **read-only consumer** of GAIA assets. SIN never imports, scans, tags, reorganizes, moves, or deletes assets in GAIA.

---

## 2. Vault Architecture & Physical Storage

### 2.1 Storage Key Convention
- Every asset belongs to exactly one owning vault.
- Managed vault files live physically under:
  ```text
  assets/vaults/<storage_key>/
  ```
- The `<storage_key>` is an immutable normalized string assigned at vault creation (e.g., `default-vault`, `field-recordings`, `packs`).
- Numbered suffixes, virtual memberships, and path fallbacks are prohibited.

### 2.2 External References (`keep` Mode)
- Files imported with the explicit `keep` mode are registered as external references logically owned by the chosen vault.
- Their `absolute_path` and `source_path` remain in their original external location.
- **Strict Read-Only Rule**: GAIA and SIN must treat external paths as read-only. Never rename, move, overwrite, tag in place, delete, or create derivatives beside an external reference.
- Deleting an external reference removes only GAIA's database record; the external file is never touched.
- The only exception is an explicit `move` operation confirmed by the user after a warning that original files will disappear.

### 2.3 Folders as Logical Bins
- Folders in GAIA (within vaults or inside projects) are **purely logical organizational bins**.
- Creating, moving, grouping, or organizing items into folders **never**:
  - physically moves files on disk,
  - changes an item's owning vault, or
  - breaks external references.
- Deleting a folder deletes or dissolves only the container row or reference edges—never source files on disk.

---

## 3. Projects & Generic References

- **Project Location**: Projects are typed folder containers located directly inside their owning vault:
  ```text
  assets/vaults/<storage_key>/<project_name>/
  ```
- **Project Structure**:
  ```text
  <project_name>/
  ├── files/
  │   ├── edit/
  │   │   └── current.json       # Canonical editor snapshot & reference snapshot
  │   ├── stems/
  │   └── master/
  ```
- **Generic Graph Edges (`item_references`)**:
  - GAIA uses a generic directed graph table (`item_references`) for all relationships (sources, stages, revisions, uses, masters).
  - Any item can be a reference target, but `context_id` must be a Project.
  - Adopting an external file into a project copies it into the project's managed folder first, publishes the copy, and updates references; the original source is untouched.

---

## 4. How the SIN Editor Interacts with GAIA

The SIN editor (port 8000) interacts with GAIA (port 8001) via HTTP API calls:

### 4.1 Browsing & Reading Assets
- **List Quick-Preview Vaults**:
  ```http
  GET http://127.0.0.1:8001/vaults/?preview=quick
  ```
  Returns accessible vaults for node library browser.
- **Fetch Vault Items**:
  ```http
  GET http://127.0.0.1:8001/items/?vault_id={vault_id}&limit=10000
  ```
  Returns asset objects with metadata (`id`, `title`, `absolute_path`, `bpm`, `key`, `duration_seconds`, `type`, `tags`).
- **Fetch Folder / Collection Contents**:
  ```http
  GET http://127.0.0.1:8001/items/{id}/contents
  ```
- **Fetch Project Reference Table**:
  ```http
  GET http://127.0.0.1:8001/projects/{id}/table
  ```
- **Audio Streaming for Node Preview**:
  ```http
  GET http://127.0.0.1:8001/items/{id}/stream
  ```

### 4.2 SQLite Offline Fallback
If the GAIA server (`http://127.0.0.1:8001`) is offline, SIN falls back to direct SQLite queries on `gaia.db` in read-only mode to retrieve asset paths, BPM, key, and tags without failing node graphs.

### 4.3 Proposing Metadata Changes (`sin-proposals`)
When a user updates metadata (e.g. adjusts sample BPM, changes root key, adds tags) within the SIN node editor:
- SIN **does NOT** write to `gaia.db` or update GAIA items directly.
- Instead, SIN posts a review proposal to the GAIA review queue:
  ```http
  POST http://127.0.0.1:8001/sin-proposals/
  Content-Type: application/json

  {
    "item_id": 352,
    "field": "bpm",
    "proposed_value": 124.0,
    "original_value": 120.0,
    "confidence": 1.0,
    "source_context": "sin_node_inspector"
  }
  ```
- GAIA records a `SinMetadataProposal` record.
- In GAIA's UI, the user can review, accept, or reject the proposed change.
- When accepted, GAIA's `reconciler` applies the change to the database row.
