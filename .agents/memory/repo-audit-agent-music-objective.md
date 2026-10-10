# SIN & GAIA Architecture Audit — Foundation & Path to Release

> **Status:** Post-Preset Validation Phase (2026-10-10)  
> **Test Baseline:** 136/136 Python tests passing (`tests/run.py`), 29/29 TS tests passing (`editor/tests/`).  
> **Core Principle:** Zero feature creep. Harden, consolidate, and automate existing capabilities through a unified headless CLI, strict boundary enforcement, and synchronized agent skills.

---

## 1. Executive Summary: Current Gaps

While GAIA is a mature library manager and SIN's DSP engine/canvas editor is functional (validated by 3 distinct drum lab systems), the system has key friction points preventing a standalone, reliable release:
1. **No Headless Execution Pipeline:** Graph compilation to `AudioNodeModel` is coupled to browser TypeScript (`serializer.ts`). Headless render/test requires browser automation or ad-hoc scripts.
2. **Scattered CLI & Entry Points:** `cli.py` and `run.py` only launch Uvicorn. There is no CLI for graph validation, headless rendering, library querying, or preset auditing.
3. **Boundary Rule Violations:** `api.py` contains endpoints that mutate GAIA directly (`PATCH /api/library/{id}/type`, dead `favourite`/`bpm` routes), violating the strict rule: **SIN is read-only toward GAIA**.
4. **Desynchronized Agent Knowledge:** Agent skills (`sin-editor/SKILL.md`, `gaia-manager/SKILL.md`) and memory guides have schema bugs (e.g., placing pool attachments inside `connections` instead of `attachments`, stale proposal payloads).

---

## 2. Library Snapshot & Data Gaps (`gaia.db`)

| Dimension | Count / Metric | Release Impact & Hardening Rule |
| :--- | :--- | :--- |
| **Media Items** | 4,071 samples, 1,501 audio, 132 tracks | 90 non-media rows (`.jpg`, `.txt`, `.md`) should be filtered out by search APIs. |
| **BPM Metadata** | Only 15% (598/4071) samples have explicit BPM | Never fabricate 120 BPM for loops. For one-shots BPM is irrelevant. If unanalyzed, do not stretch. |
| **Key Metadata** | ~640 genuine keys; 1,565 are `'none'` | Standardize null handling (treat `'none'` as NULL). Normalize formats (`C`, `Am`). |
| **Roles & Tags** | Top tags: One shot (3024), Drums (1060), Snare (741), Hat (566), Kick (464) | Role is currently tag-derived. Queries must search normalized tags (`Kick`, `Snare`, `Hi-hat`, `808`). |
| **Sequences** | 34 `.seq` files in default-vault | Full pattern library (7354–7367) ready for sequence pools. |
| **Dead Files** | 31 missing files out of 5,773 rows | Search and pool resolvers must verify file existence to prevent 422 errors. |

---

## 3. Boundary Enforcement & Tech Debt Pruning

To make the architecture rock-solid for release:

1. **Enforce Read-Only GAIA Contract:**
   - **Delete** `PATCH /api/library/{file_id}/type` in `api.py` (direct GAIA mutation).
   - **Delete** `PATCH /api/library/bpm` and `PATCH /api/library/favourite` dead code (~260 lines of unreachable legacy code in `api.py`).
   - Route `POST /api/sequence/save` strictly through GAIA proposals or vault-owned sequence exports.
2. **Consolidate GAIA Access in SIN:**
   - Currently, SIN queries GAIA 3 different ways: HTTP `127.0.0.1:8001`, raw SQLite (`_get_gaia_metadata`, `_resolve_library_references`), and ORM imports.
   - Collapse into a single `GaiaClient` module: handles connection pooling, path resolution, and cached metadata reads.
3. **Repository Cleanliness:**
   - Remove tracked runtime files (`saves/.current-stage.json`, Ableton sidecars `temp_renders/*.wav.asd`).
   - Remove legacy logs (`.runtime/iride*.log`, `gaia/log/imports/**`).
   - Normalize `package.json` build aliases (`build:editor` as canonical, remove obsolete `iride` references).

---

## 4. Full Headless CLI Blueprint (`cli.py`)

Replace the rudimentary 40-line `cli.py` with a unified Typer CLI providing full headless operation for humans and agents:

```text
sin
├── serve [--host] [--port] [--reload]           # Launch SIN + GAIA server stack
├── graph
│   ├── validate <graph.json>                     # Validate canonical sin-graph schema
│   ├── compile <graph.json> [--out <preset.json>] # Compile canonical graph to LiteGraph workspace
│   ├── render <graph.json> [--out <out.wav>]     # Headless compile + DSP render (no browser)
│   └── test <graph.json>                         # Render dry-run: asserts non-silence, LUFS, peak
├── library
│   ├── search [--type] [--tag] [--key] [--bpm]   # Fast tabular query of GAIA assets
│   └── pools verify <graph.json>                 # Check that all referenced asset IDs exist
├── presets
│   ├── list                                      # List available workspace presets
│   └── verify-all                                # Headless validation pass across all presets
└── skills
    └── check                                     # Linter: verifies SKILL.md contracts against schemas
```

### Headless Compiler Architecture:
- Run the schema validator and compiler (`graphSchema.ts` / `serializer.ts`) headlessly via `node --experimental-strip-types` or a direct Python mirror.
- Feed compiled `AudioNodeModel` directly into `core/engines.py` and `core/system.py` to write the output WAV.
- Output deterministic run metrics: duration, peak dB, LUFS, silence check, and asset resolution trace.

---

## 5. Agent Readability & Skill Alignment

Agents must have accurate, machine-readable contracts without misleading legacy docs:

1. **Fix `sin-editor/SKILL.md` & `sin-composition-guide.md`:**
   - Correct the schema contract: asset pools attach via the top-level **`attachments`** array (`{ "owner": "kick-src", "modifier": "kick-pool", "type": "asset_pool" }`), **never** inside `connections`.
   - Update `RandomNode` docs to match current `AudioNodeModel` property contracts (`destinations`, `paramKey`, `minPercent`, `maxPercent`).
2. **Fix `gaia-manager/SKILL.md` & `gaia-manager-guide.md`:**
   - Align proposal schema with `gaia/schemas.py::SinMetadataProposalCreate`:
     `{ asset_ref, absolute_path, field, proposed_value, previous_value, source_node_id }`.
   - Clarify that proposals are accepted via `/sin-proposals/{id}/accept`.

---

## 6. Release Hardening Roadmap

### Phase 1: Boundary & Cleanup (Immediate)
- Remove dead routes and boundary-violating endpoints from `api.py`.
- Fix schema bugs in `.agents/skills/` and `.agents/memory/`.
- Clean runtime artifacts from git tracking (`.gitignore` update for `saves/.current-stage.json`, `temp_renders/`).

### Phase 2: Headless CLI & Direct Render Path
- Implement `sin graph validate`, `sin graph compile`, and `sin graph render` in `cli.py`.
- Expose `POST /api/graph/validate` and `POST /api/graph/render` in `api.py` accepting canonical `sin-graph` directly.
- Add an automated E2E CLI test: `sin graph render presets/drums/drum_lab_trap_bounce.json` verifying output WAV.

### Phase 3: Headless Asset Discovery & Verification
- Implement `sin library search` and `sin presets verify-all`.
- Validate that all 3 drum presets and demo systems pass automated headless verification in CI.
- Final release packaging check.
