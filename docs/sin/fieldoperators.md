# Field Operators (`docs/sin/fieldoperators.md`)

**Field Operators** are lightweight pseudo-code expressions that can be entered into any parameter field or Pool asset selector field in SIN (`Sample`, `Sequence`, `Arrangement`, `Track`, and modifiers).

When a field is controlled by a Field Operator:
- **Unfocused Display**: The field displays its **calculated value** tinted in **blue** (`.is-pool-computed`) so you immediately know the parameter is dynamically calculated rather than fixed.
- **Focused / Click-to-Edit**: Clicking into the field reveals the **raw Field Operator expression** (in standard text color) so you can inspect or edit the equation/pseudo-code directly.
- **Fixed Values**: Setting a field by dragging a single asset or typing a single fixed name, index, or number keeps the value **fixed** (standard text color, not overwritten on Refresh `↻`).

---

## List of Field Operators

| Operator | Syntax | Supported Fields | Driving Source | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Random** | `rand` / `random` | Pool Selector, Numeric (`int`, `float`, `db`, `slider`, `global_float`), `sample_slot`, `seed` | **Seed** (`seed` + `seed_salt`) | Picks a deterministic pseudo-random item from the Pool, a value within the field's `[min, max]` schema bounds, or an upstream slot index (`0..S-1`). Rolls a new value on Refresh (`↻`). |
| **Range Random** | `min..max` or `rand(min, max)` | Pool Selector, Numeric (`int`, `float`, `db`, `slider`, `global_float`), `sample_slot`, `seed` | **Seed** (`seed` + `seed_salt`) | Picks a deterministic pseudo-random value bounded between `min` and `max` (quantized to the field's `step` or integer index). Examples: `-5..5`, `0.2..0.8`, `0..3`, `rand(-12, 0)`. |
| **Index Cycle List** | `0 0 0 1` | Pool Selector, `sample_slot`, Numeric fields | **Trigger Count** (`trigger_count`) | Cycles through whitespace- or comma-separated indices (`tokens[trigger_count % N]`). Independent of `seed`; resets to index `0` on Refresh (`↻`). |
| **Asset Name Cycle List** | `kick_a.wav kick_b.wav` | Pool Selector (`Sample` / `Sequence`) | **Trigger Count** (`trigger_count`) | Cycles through Pool assets by name/stem/basename in order (`tokens[trigger_count % N]`). Automatically written when dragging multiple items onto a slot pill, waveform, or title field. Independent of `seed`; resets to index `0` on Refresh (`↻`). |
| **Value Cycle List** | `0 5 -2 7` or `0.25 0.5` | Numeric (`int`, `float`, `db`, `slider`, `global_float`), `seed` | **Trigger Count** (`trigger_count`) | Cycles through explicit parameter values (`tokens[trigger_count % N]`). Independent of `seed`; resets to index `0` on Refresh (`↻`). |
| **Mixed Operator List** | `0 0 1 rand` or `0 -5..5` | Pool Selector, Numeric fields, `sample_slot` | **Trigger Count** + **Seed** | Steps through the list via `trigger_count % N`; when the active token is `rand` or `min..max`, evaluates that token using the node's deterministic seed. |
| **Active Slot Wildcard** | `*` | `Sequence.sample_slot`, `Arrangement.section_slots` | Upstream `active_slot` | Follows the currently selected slot (`[0]`, `[1]`, …) of the connected upstream node in real time. |

---

## Evaluation Rules: Seed vs. Internal Trigger Counter

1. **Random Operators (`rand`, `min..max`, `rand(min, max)`)**:
   - Driven by the node's or attached Pool/Random modifier's deterministic `seed` (`mulberry32` + FNV-1a hash).
   - Pressing **Refresh (`↻`)** advances armed seeds (`seed_refresh !== false`) and re-calculates all random Field Operators.
   - Pressing **Play (`Space`)** or **Node Preview (`▶`)** never advances seeds.

2. **List Operators (`0 0 0 1`, `kick_a.wav kick_b.wav`, `0 5 -2`)**:
   - **Not susceptible to `seed`**: List order and selection are never scrambled by seed changes.
   - Driven strictly by each node's **`iteration`** trigger counter (`tokens[iteration % tokens.length]`):
     - **On a `Sample` node** (in its Pool selector `pool_query` or sample parameters like `transpose`, `cents`, `crop_start`, `crop_end`, `stretch_factor`): triggered **each time a downstream `Sequence` asks for a new sample** (i.e. each active step trigger `iteration = 0, 1, 2, ...`, or each section trigger under `Arrangement`).
     - **On a `Sequence` node** (in its Pool selector `pool_query` or pattern fields like `sample_slot`, `step_length`, `release`, `fade_ms`): triggered **each sequence cycle** (`iteration = 0, 1, 2, ...` across pattern repetitions).
   - During playback, the Inspector and canvas visualizations track the live `iteration` from render manifest telemetry and update the blue calculated values, waveforms, and sequence grids in real time.
   - Pressing **Refresh (`↻`)** resets the internal trigger counter back to `0` across all nodes.

---

## Multi-Selection Drag & Drop Workflows

When dragging multiple items from a Pool or Library onto a `Sample` or `Sequence` node:

- **Drop onto `+` (Add Slot button)**:
  - Creates **multiple individual slots** (one slot per dragged item), each loaded with a **fixed** asset (`pool_query = ""`).
- **Drop onto a Slot Pill (`[0]`, `[1]`, …), Waveform / Sequence Grid, or Title Field**:
  - Ensures the dragged items are present in the node's Pool and writes a **cycling text list Field Operator** (e.g. `kick_a.wav kick_b.wav`) into the target slot's `pool_query`.
- **Drop a Single Item**:
  - Replaces the target slot with that **fixed** asset (`pool_query = ""`, normal text color).

