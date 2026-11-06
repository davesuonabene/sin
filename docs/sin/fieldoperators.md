# Field Operators (`docs/sin/fieldoperators.md`)

**Field Operators** are lightweight pseudo-code expressions that can be entered into any parameter field, `sample_slot` selector, or Pool asset selector field in SIN (`Sample`, `Sequence`, `Arrangement`, `Track`, and modifiers).

When a field is controlled by a Field Operator:
- **Unfocused Display**: The field displays its **calculated value** tinted in **blue** (`.is-pool-computed`) so you immediately know the parameter is dynamically calculated rather than fixed.
- **Focused / Click-to-Edit**: Clicking into the field reveals the **raw Field Operator expression** (in standard text color) so you can inspect or edit the equation/pseudo-code directly.
- **Fixed Values**: Setting a field by dragging a single asset or typing a single fixed name, index, or number keeps the value **fixed** (standard text color, not overwritten on Refresh `↻`).

---

## 1. Global Seed (`0, 1, 2...`) & Global Seed Lock

All procedural variation across the project is driven by a single integer **Global Seed** (`0, 1, 2...`) displayed in the top toolbar next to the **Refresh (`↻`)** button, paired with a **Global Seed Lock** toggle:

1. **Global Seed (`0, 1, 2...`)**:
   - **`global_seed = 0` (Identity Order)**: Asset Pools maintain their exact user-defined item order (`[0, 1, ..., K-1]`).
   - **`global_seed > 0` (Seeded Pool Permutation & Random Map)**:
     - **Asset Pools**: Deterministically permutes the pool items via seeded Fisher-Yates (`getPoolPermutationOrder(K, global_seed, poolNodeId)`), so index `0` (or slot `[0]`) resolves to the item now at index `0` of the reordered pool (displayed directly in the Pool list).
     - **`RandomNode` Modifiers**: Generates a deterministic random value map for all enabled parameter destinations from `global_seed`.
     - **Field Operators**: Uses `field_seed` (derived from `global_seed` and `field_refresh_epoch`) to deterministically evaluate `random` / `rand` / `min..max` tokens at any point in the timeline.
2. **Global Seed Lock Toggle**:
   - **Unlocked (default)**: Clicking **Refresh (`↻`)** increments `global_seed` (`0 → 1 → 2...`), permuting Asset Pools, updating `RandomNode` modulations, and re-rolling all `random` Field Operators.
   - **Locked**: Clicking **Refresh (`↻`)** keeps `global_seed` fixed (so Asset Pool item ordering and `RandomNode` modulations remain unchanged) and increments `field_refresh_epoch` so **only** `random` Field Operators re-roll.
3. **Freeze Compatibility**:
   - When **Global Freeze** is ON and a node's Freeze toggle is active (`freeze_refresh !== false`), its effective pool seed, random seed, and field seed are snapshotted and remain frozen across refreshes.

---

## 2. Universal Timeline & Multi-Master Trigger Hierarchy

Every time-bearing node $X$ (`Sequence`, `Track`, `Arrangement`) operates within two bar lengths:
- **Cycle Length $C(X)$**: The node's own resolved `total_bars` (e.g., a `Sequence` of `1` bar, or a sub-Master `Track` of `4` bars).
- **Ancestor Global Length $G(X)$**: The resolved `total_bars` of the **first downstream parent `Track` (Master)** connected to $X$ (or the Workspace Global `total_bars` if $X$ is at the root of the graph).

### Hierarchical Trigger Compilation
- **Multi-Master Global Triggers (`global_idx`)**: When a parent Master `Track` (e.g. `16` bars) renders a shorter child Master `Track` (e.g. `4` bars), the parent compiles $N_{\text{global}} = \lceil 16 / 4 \rceil = 4$ sequential **Global Triggers** (`global_idx = 0, 1, 2, 3`) and concatenates the resulting 4-bar segments.
- **Cycle Triggers (`cycle_idx`)**: Within each Global Trigger (`global_idx`), a child `Sequence` of length $C = 1$ bar under a `4`-bar Master compiles $N_{\text{cycles}} = \lceil G / C \rceil = 4$ **Cycle Triggers** (`cycle_idx = 0, 1, 2, 3`), advancing `global_progress` across $[0, 1)$.
- **Event Requests (`event_idx`)**: Within each Cycle Trigger, each active step (`step == 1`) of a `Sequence` advances `cycle_progress = step_idx / num_steps` across $[0, 1)$ and emits a sequential **Event Request** (`event_idx = 0, 1, 2...`) to the connected `Sample` node.

---

## 3. Bracketed Field Operator Grammar

Field Operators use three scopes that map directly to the trigger hierarchy:

| Scope | Syntax | Refresh & Subdivision Behavior | Examples |
| :--- | :--- | :--- | :--- |
| **Global Scope (Unbracketed)** | `a b ...` | Refreshes on each **Global Trigger** (`global_idx`) and subdivides the **Ancestor Global Length ($G$)** into $N$ equal slices (`global_progress`). | `random` (1 random value for all of $G$)<br>`0 1` or `[0][1]` (`0` for first half of $G$, `1` for second half of $G$)<br>`random random` (2 random values across $G$)<br>`0 [random]` (`0` for first half of $G$; new random each cycle in second half of $G$) |
| **Cycle Scope (`[ ... ]`)** | `[a b ...]` | Refreshes on each **Cycle Trigger** (`cycle_idx`) and subdivides the **Cycle Length ($C$)** into $M$ equal slices (`cycle_progress`). | `[random]` (1 new random value per cycle)<br>`[0 1]` (`0` for first half of each cycle, `1` for second half)<br>`[0 random]` (`0` for first half of cycle, new random in second half)<br>`[random][random]` (both halves of $G$ refresh per cycle) |
| **Sequential Event Scope (`< ... >`)** | `<a b ...>` | Steps sequentially (`idx % K`) on each active **Event Request** (`event_idx` / `window_event_idx`). Resets at each **Global Trigger** (`global_idx`), or on slice entry when windowed inside a slice (`[0 <1 2>]`). | `<0 1 2>` (round-robin `0, 1, 2, 0, 1, 2...` on each trigger)<br>`<random>` (new random value on every trigger)<br>`<0 random>` (alternates fixed `0` and a new random value on every trigger)<br>`[0 <random>]` (`0` for first half of cycle; new random on every trigger in second half) |

### Tokenization & Leaf Expressions
- **Delimiters**: Whitespace, commas (`,`), and bracket boundaries (`][`, `><`, `[0]1`, `[0<random>]`) act as token separators.
- **Quotes & Filenames**: Quoted strings (`"Kick 01.wav"`) and single unbracketed filenames with spaces (`Kick 01.wav`) are preserved as a single literal selector.
- **Supported Leaf Tokens**:
  - `rand` / `random`: Deterministic pseudo-random pool index, slot index (`0..S-1`), or numeric value within schema `[min, max]`.
  - `min..max` or `rand(min, max)`: Deterministic pseudo-random value in `[min, max]` (e.g. `-5..5`, `0.2..0.8`, `0..3`).
  - Integer index (`0`, `1`, `2`), numeric literal (`-3.5`), or asset name/stem (`kick_a.wav`).
  - `*`: Active slot wildcard (`Sequence.sample_slot`, `Arrangement.section_slots`) following the upstream node's currently selected slot.

---

## 4. Multi-Selection Drag & Drop Workflows

When dragging multiple items from a Pool or Library onto a `Sample` or `Sequence` node:

- **Drop onto `+` (Add Slot button)**:
  - Creates **multiple individual slots** (one slot per dragged item), each loaded with a **fixed** asset (`pool_query = ""`).
- **Drop onto a Slot Pill (`[0]`, `[1]`, …), Waveform / Sequence Grid, or Title Field**:
  - Ensures the dragged items are present in the node's Pool and writes a **sequential event list Field Operator** (`<item_a.wav item_b.wav>`) into the target slot's `pool_query`.
- **Drop a Single Item**:
  - Replaces the target slot with that **fixed** asset (`pool_query = ""`, normal text color).
