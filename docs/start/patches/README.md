# Beginner Tutorial Patches

<!-- Outline scaffold — Phase 2 adds the 4 runnable workspace JSON patches -->

Small, self-contained companion patches (`2`–`7` nodes each) paired one-to-one with lessons `02`–`05` of the [Beginner First Start Guide](./README.md).

---

## Patch Index

| Patch File | Status | Lesson | Nodes | Focus |
| :--- | :--- | :--- | :--- | :--- |
| `01_first_sound.json` | Planned (Phase 2) | [02 — First Sound](../02-first-sound.md) | 2 | `Sample` (Loop) → `Master Track` |
| `02_first_beat.json` | Planned (Phase 2) | [03 — First Beat](../03-first-beat.md) | 5–7 | Kick/Snare/Hat `Sample` + `Sequence` + `CHAIN` Gain Staging → `Master Track` |
| `03_slots_and_variation.json` | Planned (Phase 2) | [04 — Slots, Pools & Variation](../04-slots-pools-and-variation.md) | ~6 | Multi-slot `[0][1]` + `Asset Pool` + `Random` + Field Operators |
| `04_mini_arrangement.json` | Planned (Phase 2) | [05 — Arranging & Exporting](../05-arranging-and-exporting.md) | ~7 | Multi-slot `Sequence` → 4-bar `Arrangement` → `Master Track` |

---

## How to Open a Tutorial Patch (Once Added in Phase 2)

1. In SIN (`:8000`), open **`File → Open…`** (`Ctrl/Cmd + O`).
2. Click **`Browse local file…`** and select the patch JSON inside `docs/start/patches/`.
3. Press **`Space`** to play, or **`File → New`** (`New` stage) to reset and start fresh.

### Hybrid Audio Assets (GAIA + Standalone Local Files)

- **With GAIA**: Import the starter kit (or your own pack) in [01 — First Vault in GAIA](../01-first-vault-in-gaia.md) and drag hits/loops from the Library panel (`L`).
- **Without GAIA**: Load or drop local `.wav`/audio samples directly onto each patch's `Sample` nodes—no GAIA connection is required to test the graph wiring, sequencers, gain staging, or arrangements.

---

## Phase 2 Authoring Guidelines

- Ship directly openable LiteGraph workspace JSON (`{ "graph": ... }`) so beginners need zero CLI commands.
- Use only currently callable node types (`Sample`, `Sequence`, `Track`, `Arrangement`, `Asset Pool`, `Random`).
- Keep coordinates cleanly spaced left-to-right with zero overlaps and verify rendered output peaks stay `< 0 dBFS`.
