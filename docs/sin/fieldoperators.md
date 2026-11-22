# Field Operators & Pseudo-Language (`docs/sin/fieldoperators.md`)

**Field Operators** are lightweight pseudo-language expressions you can type into supported parameter fields, `Sample Slot` (`sample_slot`), `Asset Selector` (`pool_query`), and `Seed` fields across `Sample`, `Sequence`, and `Arrangement` nodes.

---

## 1. Fixed vs. Calculated Fields & Visual Feedback

When a field contains an active Field Operator expression:

- **Unfocused Display (Calculated)**: The field displays its **current evaluated value** tinted in **blue** (`.is-pool-computed`) so you immediately see that it is calculated rather than static.
- **Focused Display (Click to Edit)**: Clicking into the field switches to standard text and reveals your **raw Field Operator expression** so you can inspect or edit it directly.
- **Fixed Values**: An empty field, a single number (`-3`), a single filename (`Kick 01.wav`), or an exact matching asset name/stem from the attached Pool stays **fixed** (standard text color, never overwritten on Refresh `↻`).

### Active Expression Detection

SIN treats a value as an active Field Operator if it matches any of these:
1. Contains bracket operators `[ ... ]` or `< ... >` (with at least one inner token).
2. Contains a random keyword (`rand` or `random`).
3. Contains a range operator (`min..max` or `rand(min, max)` / `random(min, max)`).
4. Contains multiple space- or comma-separated tokens (e.g., `0 1`, `0, 5, -3`).

### Inspector Stability During Playback

During playback, the **IRIDE** canvas visuals react live across every triggered slot, while the **Inspector** keeps your currently selected slot pill (`[0]`, `[1]`, …) stationary and only updates displayed field values for an active slot driven by a Field Operator.

---

## 2. Global Seed (`0, 1, 2…`), Global Seed Lock & Global Freeze

Procedural variation across the graph is controlled from the top toolbar next to **Refresh (`↻`)** using a deterministic, cross-language bit-identical PRNG (**SplitMix32 + Mulberry32** in `ermes/ts/slotLanguage.ts` and `ermes/py/slot_language.py`):

- **`global_seed = 0` (Identity Order)**: Every `Asset Pool` keeps your exact user-defined item order (`[0, 1, ..., K-1]`).
- **`global_seed > 0` (Permuted Pools & Random Maps)**:
  - **Asset Pools**: Deterministically reorders pool items via seeded Fisher-Yates (`getPoolPermutationOrder(K, global_seed, poolNodeId)`), immediately reflected in the Pool list (`0, 1, 2...`).
  - **`Random` Modifiers**: Computes deterministic parameter offsets for all enabled destinations.
  - **Field Operators**: Uses `field_seed = global_seed + field_refresh_epoch * 10007` to evaluate `random`, `rand`, and `min..max` tokens deterministically across every trigger.

### Refresh, Lock, Freeze & Play Behavior

| Action / Toolbar State | `global_seed` | `field_refresh_epoch` | Asset Pools & `Random` Modifiers | Field Operators (`random`, `min..max`) |
| :--- | :--- | :--- | :--- | :--- |
| **Refresh (`↻`)** · Seed Unlocked · Freeze OFF | Increments (`+1`) | Unchanged | Re-permuted / re-rolled | Re-rolled |
| **Refresh (`↻`)** · **Seed Lock ON** · Freeze OFF | Unchanged | Increments (`+1`) | **Unchanged** | Re-rolled |
| **Refresh (`↻`)** · **Global Freeze ON** · Node `❄` ON | Snapshotted (`locked_*_seed`) | Snapshotted | **Frozen** (unfrozen `❄ OFF` nodes still roll) | **Frozen** |
| **Play (`Space`)** or **Node Preview (`▶`)** | Unchanged | Unchanged | Never mutates | Never mutates |

---

## 3. Runtime Trigger Hierarchy (Cycle & Event)

Field Operator timing is driven by **2 runtime trigger axes**—**Cycle** (*Wrapper* and *Local*) and **Event**—allowing nested tracks and arrangements to subdivide time cleanly:

- **Wrapper Cycle Length $W(X)$** (`wrapper_bars`): The resolved `total_bars` of the **first downstream enclosing `Track`** (Sub-Master or Master) connected to node $X$, or the project's global `total_bars` at the root.
  - When a longer parent `Track` wraps a shorter child `Track` or `Arrangement` (for example, a `16`-bar Master wrapping a `4`-bar Sub-Master), the parent executes $N_{\text{wrapper}} = \lceil 16 / 4 \rceil = 4$ sequential **Wrapper Cycles** (`wrapper_idx = 0, 1, 2, 3`) and concatenates the segments. This works across arbitrary levels of nested `Track` nodes.
- **Local Cycle Length $C(X)$**: The node's own resolved `total_bars`.
  - Within each Wrapper Cycle (`wrapper_idx`), a shorter child (such as a `1`-bar `Sequence` inside a `4`-bar Wrapper) runs $N_{\text{cycles}} = \lceil W / C \rceil = 4$ **Local Cycles** (`cycle_idx = 0, 1, 2, 3`), advancing `wrapper_progress` across $[0, 1)$ while wrapping `cycle_idx % N_cycles` inside each Wrapper Cycle.
- **Sequential Event (`event_idx`)**: Within each Local Cycle, active steps (`step == 1` in a `Sequence`) advance `cycle_progress = step_idx / step_count` across $[0, 1)$ and increment a continuous **Event** counter (`event_idx = 0, 1, 2...`).
  - Whenever an expression is evaluated inside a subdivided time slice (e.g. `[0 <1 2>]`), a **window-local event counter** (`window_event_idx`) resets to `0` each time playback enters a new slice.

---

## 4. Bracketed Pseudo-Language Grammar

Three scopes map directly to the runtime trigger hierarchy:

| Scope | Syntax | Refresh & Subdivision Behavior | Examples |
| :--- | :--- | :--- | :--- |
| **Wrapper Cycle Scope (Unbracketed)** | `a b ...` | Refreshes on each **Wrapper Cycle** (`wrapper_idx`). Multiple items subdivide the **Wrapper Cycle Length ($W$)** into $N$ equal slices (`wrapper_progress`). | `random` (1 random value for all of $W$)<br>`0 1` (`0` for first half of $W$, `1` for second half)<br>`random random` (2 random values across $W$, each held across its half)<br>`0 [random]` (`0` in first half of $W$; new random each Local Cycle in second half) |
| **Local Cycle Scope (`[ ... ]`)** | `[a b ...]` | Refreshes on each **Local Cycle** (`cycle_idx`). Multiple items subdivide the **Local Cycle Length ($C$)** into $M$ equal slices (`cycle_progress`). | `[random]` (1 new random value per Local Cycle, held for all steps in that cycle)<br>`[0 1]` (`0` for first half of every Local Cycle, `1` for second half)<br>`[0 random]` (`0` for first half of cycle, new random in second half)<br>`[random][random]` (splits $W$ into 2 halves, each rolling fresh per Local Cycle) |
| **Sequential Event Scope (`< ... >`)** | `<a b ...>` | Advances sequentially (`idx % K`) on each active **Event** (`event_idx`), or resets on slice entry (`window_event_idx`) when nested inside a subdivided slice. | `<0 1 2>` (round-robin `0, 1, 2, 0, 1, 2...` across active triggers)<br>`<random>` (new random value on every active trigger)<br>`<0 random>` (alternates fixed `0` and fresh `random` per trigger)<br>`[0 <1 2>]` (`0` for first half of cycle; round-robins `1, 2` inside second half) |

### Key Distinctions

- **`random random` vs. `[random][random]`**: Both divide Wrapper Cycle $W$ into two halves. `random random` picks two values once per Wrapper Cycle and holds each across all Local Cycles in its half; `[random][random]` wraps each half in a Local Cycle group (`[...]`), so each half rolls a **fresh random value on every Local Cycle**. (For constants like `0 1` vs `[0][1]`, the output is identical.)
- **Direct Step Pattern vs. Multi-Cycle Hierarchy in `Sequence.sample_slot`**:
  - When `Sequence` runs a **single cycle** (`num_cycles == 1`) with **no brackets**, an unbracketed list like `0 1` or `0 0 1 2` steps directly across the step grid (`step_idx % tokens.length`), wrapping modulo the upstream `Sample` slot count `S`.
  - When `num_cycles > 1` (e.g. a 1-bar Sequence inside a 4-bar Track) or when brackets (`[...]`, `<...>`) are used, unbracketed tokens subdivide $W$, `[...]` subdivides $C$, and `<...>` advances strictly on **active** steps (`step == 1`), skipping rests!

---

## 5. Tokenization, Leaf Tokens & Resolution Rules

### Delimiters, Quotes & Filenames

- **Delimiters**: Whitespace, commas (`,`), and bracket boundaries (`][`, `><`, `[0]1`, `[0<random>]`) separate tokens.
- **Quoted Strings**: `"Kick 01.wav"` or `'Kick 01.wav'` preserves spaces and commas as one token.
- **Unbracketed Single Filename**: A single unbracketed filename with a supported audio/sequence extension (`.wav`, `.mp3`, `.ogg`, `.flac`, `.aif`, `.aiff`, `.m4a`, `.mid`, `.midi`, `.seq`) is preserved as one literal even if it contains spaces (e.g. `Kick 01.wav`).

### Supported Leaf Tokens

| Leaf Token | Behavior |
| :--- | :--- |
| `rand` / `random` | Deterministic pseudo-random value: float/int inside field `[min, max]`, slot index `0..S-1`, pool index `0..K-1`, or random option for select/radio fields. |
| `min..max` or `rand(min, max)` / `random(min, max)` | Deterministic pseudo-random value in `[min, max]` (supports `,`, `;`, or `:` inside `rand(...)`; reversed bounds are auto-sorted). Quantized to field `step` / integer rules; wraps modulo count when resolving slots or pools. |
| Integer / Float Literal (`0`, `-3.5`, `12`) | Numeric parameters clamp to `[min, max]` and snap to `step`. Slot and pool integers wrap safely modulo count (`((idx % N) + N) % N`), including negative indices (`-1` selects the last slot/item). |
| `*` (aliases: `default`, `active`) | Wildcard following the connected upstream node's currently active slot (`Sequence.sample_slot`, `Arrangement.section_slots`). |
| Asset Name / Stem (`kick_a.wav`, `snare`) | Matches an item inside the active (Global-Seed-permuted) Asset Pool. |

### Asset Pool & Select Resolution Order

- **Pool Query Resolution (`resolvePoolItemByQuery`)**:
  1. Unbracketed exact match against item `name`, name stem, filename, or filename stem.
  2. Evaluate Field Operator AST leaf (`[...]`, `<...>`, multi-token).
  3. Range `min..max` / `rand(min, max)` → deterministic integer index wrapped modulo pool size.
  4. `rand` / `random` → deterministic index from active Pool (`Sequential` mode increments sequentially).
  5. Integer index → modulo-wrapped index into the active permuted Pool (`0` = top item in current Pool list).
  6. Exact match → 7. Case-insensitive prefix match → 8. Case-insensitive substring match against name, filename, or path.
- **Select / Radio Fields (`evaluateSelectFieldOperator`)**: Matches `rand`/`random`, exact option value or label, modulo-wrapped integer index, or case-insensitive prefix match.

---

## 6. Supported Fields by Node

| Node | Field Operator Parameters | Notes |
| :--- | :--- | :--- |
| **Sample** | `pool_query` (Asset Selector), `crop_start`, `crop_end`, `transpose`, `cents`, `stretch_factor` | Evaluated deterministically per trigger/event in the DSP engine; also previewable in the Inspector. |
| **Sequence** | `pool_query` (Sequence/MIDI Pool Selector), `sample_slot`, `step_length`, `release`, `fade_ms` | `sample_slot` evaluates per step (`idx % S`); `pool_query`, `step_length`, `release`, and `fade_ms` evaluate per cycle. `seed` supports integer/space-separated/`rand` seed sequences. |
| **Arrangement** | `section_slots`, `seed` | UI `Slot` input accepts `*`, integer, or `rand`; canonical/JSON definitions also support full Field Operator expressions in `section_slots`. |

---

## 7. Multi-Selection Drag & Drop Workflows

When dragging items from an attached Pool or the GAIA Library (`L`) onto a `Sample` or `Sequence` node:

- **Drop multiple items onto `+` (Add Slot button)**: Creates **multiple individual slots** (one slot per dragged item), each loaded with a **fixed** asset (`pool_query = ""`).
- **Drop multiple items onto a Slot Pill (`[0]`, `[1]`, …), Waveform / Sequence Grid, or Asset/Title Field**: Ensures all dragged items are present in the node's Pool and writes a space-separated **Wrapper Cycle list Field Operator** (`item_a.wav item_b.wav`, quoting filenames with spaces like `"Kick 01.wav" "Kick 02.wav"`) into the target slot's `pool_query`. Wrap it in `<...>` for per-event round-robin or `[...]` for local-cycle subdivision.
- **Drop a single item**: Sets that **fixed** asset on the target slot(s) (`pool_query = ""`, standard text color).

---

## 8. Quick Musical Recipes

| Goal | Field | Expression | Result |
| :--- | :--- | :--- | :--- |
| Switch hit halfway through bar/wrapper | `Sequence.sample_slot` | `0 1` or `[0 1]` | Slot `0` in the first half, Slot `1` in the second half. |
| Round-robin percussion hits | `Sample.pool_query` | `<perc_a.wav perc_b.wav perc_c.wav>` | Cycles cleanly `a → b → c → a…` on every active trigger. |
| Roll a fresh fill only in the 2nd half of each cycle | `Sequence.sample_slot` | `[0 <1 2>]` | Plays Slot `0` in the first half, alternates `1` and `2` in the second half. |
| Subtle human pitch drift per hit | `Sample.transpose` or `cents` | `<-12..12>` (`cents`) | Shifts each trigger deterministically between `-12` and `+12` cents. |
| Bar-4 octave accent | `Sample.transpose` | `0 0 0 12` | Plays root pitch for the first 3 quarters of $W$, `+12 st` on the final quarter. |

---

**Index:** [SIN Reference](./README.md) · **Nodes:** [Nodes Reference](./nodes-reference.md) · **Tutorials:** [Beginner First Start Guide](../start/README.md)
