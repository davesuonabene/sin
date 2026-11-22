# Nodes Reference

Complete tab-by-tab parameter reference for every active, callable node in SIN (`:8000`): **Sample**, **Sequence**, **Arrangement**, and **Master / Track**, plus attached modifiers (**Asset Pool**, **Random**) and the **Disabled** bypass state.

---

## 1. Shared Inspector Header & Common Tabs

Every audio node (`Sample`, `Sequence`, `Arrangement`, `Track`) opens in the Inspector (`P`) with a shared header bar and four tabs in order: **`<Primary>` | `CHAIN` | `EXPORT` | `COMMON`**.

### Header Bar Controls (Audio Nodes)

| Control | Action |
| :--- | :--- |
| **Node Title** (inline text) | Click to rename `node_name`. Press `Enter` to commit or `Esc` to revert. |
| **`👁` Viewer Cook** | Toggles live IRIDE canvas visualization for this node (`ON` by default). |
| **`R` Render Flag** | Includes or excludes this node from **Render → Render Flagged Nodes** (`ON` by default). |
| **`❄` Freeze Protection** | Protects this node's Asset Pool, Random modifier, and Field Operator seeds when **Global Freeze** is active (`ON` by default). |
| **`🎲` Random Modifier** | Attaches a `Random` modifier (if none exists) or opens click-to-map range mode on numeric fields. |
| **`↗` / `📌` Dock / Float** | Floats the Inspector window or docks it back to the right side. |
| **`✕` Close** | Closes the Inspector panel. |

*(Modifier nodes—`Asset Pool` and `Random`—show **`← Node`** to jump back to their parent node and **`🗑`** to remove the modifier.)*

### Shared `CHAIN` Tab (Gain Staging)

Currently, the `CHAIN` tab provides two fixed **Gain Staging** controls—**`Pre Gain`** (before node DSP processing) and **`Post Gain`** (after node DSP processing). Additional DSP FX modules are not active yet.

| Stage | Range | Step | Default (`Sample`) | Default (`Sequence`, `Arrangement`, `Track`) | Interaction |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Pre Gain** | `-36.0 dB` to `+12.0 dB` (`<= -35.9 dB` = `-inf dB`) | `0.1 dB` | **`-6.0 dB`** | **`0.0 dB`** | Drag horizontally, scroll mouse wheel, or double-click to type |
| **Post Gain** | `-36.0 dB` to `+12.0 dB` (`<= -35.9 dB` = `-inf dB`) | `0.1 dB` | **`0.0 dB`** | **`0.0 dB`** | Drag horizontally, scroll mouse wheel, or double-click to type |

### Shared `EXPORT` Tab (Export)

Automatically added to every renderable audio node (`Sample`, `Sequence`, `Arrangement`, `Track`):

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **Root Folder** (`export_root`) | Directory picker | `exports` | Base output directory for rendered WAV files. |
| **Subfolder** (`export_subfolder`) | String (autocomplete) | `""` | Optional subfolder inside Root Folder (auto-created if it does not exist). |
| **Pattern** (`export_pattern`) | String | `{project}_{name}_{idx}` | Output filename template (`.wav` extension is appended automatically). |
| **Variables** (collapsible chips) | Token helper | — | Click chips to insert `{project}`, `{name}`, `{idx}`, `{bpm}`, `{bars}`, `{key}`, `{date}`, `{time}`, `{type}` into `Pattern` (aliases `{project_name}`, `{node_name}`, `{id}`, `{datetime}`, `{incremental}` also evaluate). |
| **Conflict** (`export_overwrite_mode`) | Radio | `Incremental` | `Incremental` writes sequential non-overwriting files (`_001`, `_002`, …); `Overwrite` replaces an existing file at the same path. |
| **Preview & `Render` button** | Read-only + Action | `<root>/<pattern>.wav` | Displays the resolved target path and renders this node directly to disk as a `.wav` file. |

### Shared `COMMON` Tab

| Section | Contents |
| :--- | :--- |
| **Appearance → Color** | Accent color preset selector applied to the node body and IRIDE canvas renderers. |
| **Info Table** | Read-only summary showing node `ID` (`#id`), `Type`, canvas `Position` (`X, Y`), `Inputs` count, and `Outputs` count. |

---

## 2. Sample Node (`Audio/Sample` · `SMPL`)

Multi-slot audio source (`#10b981`) for playing tempo-synced **Loops** or un-stretched **One Shots** from GAIA or local disk.

**Tabs:** `SAMPLE` | `CHAIN` | `EXPORT` | `COMMON`

### `SAMPLE` Tab

#### Slot Strip, Asset Selector & Waveform Cropper

- **Slot Strip (`[0]`, `[1]`, …, `+`)**: Holds independent sample variations (`slots[]`). Click `+` to add a slot, `Shift`/`Ctrl+Click` to multi-select, `Ctrl/Cmd+C` & `Ctrl/Cmd+V` to copy/paste slots, or `Delete`/`Backspace` to remove the focused slot (when more than one exists). Dropping multiple assets onto `+` creates one fixed slot per file; dropping onto a slot pill or waveform populates a Pool list expression.
- **Asset Selector (`pool_query`) & `POOL` Button**: Displays the loaded filename (or calculated value in blue when controlled by a [Field Operator](./fieldoperators.md); click to inspect/edit the raw expression). Click **`POOL`** to toggle the inline Asset Pool editor inside the `SAMPLE` tab.
- **Waveform Visualizer**: Drag-and-drop audio target with interactive left/right crop handles and start/end timestamp readouts in seconds.

#### Sample Parameters

| Parameter | Key | Type / Range | Default | Notes & Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Asset File** | `filepath` | Filepath | `""` | Resolved path to the active slot's audio file (read-only/local or GAIA asset). |
| **Start Point** | `crop_start` | Float (`0.0` – `1.0`, step `0.1`) | `0.0` | Normalized playback start inside the audio file. Supports [Field Operators](./fieldoperators.md). |
| **End Point** | `crop_end` | Float (`0.0` – `1.0`, step `0.1`) | `1.0` | Normalized playback end inside the audio file. Supports [Field Operators](./fieldoperators.md). |
| **Type** | `sample_type` | Radio (`Loop` / `One Shot`) | `Loop` | `Loop` tempo-stretches and tiles audio to fit parent bars; `One Shot` triggers without BPM stretching and **disables `Source BPM` and `Target BPM`**. |
| **Start Beat** | `start_beat` | Float (`>= 0`) | `0` | Beat offset before this sample enters when rendered inside a parent container. |
| **Source BPM** | `original_bpm` | Float (`20` – `300 BPM`) | `120` | Native tempo of the source loop (disabled in `One Shot`). Editing applies locally and stages a metadata proposal for GAIA. |
| **Target BPM** | `target_bpm` | Global Float (`20` – `300 BPM` or `global`) | `global` | Playback tempo target (disabled in `One Shot`). `global` inherits the parent `Track` / project BPM. |
| **Key** | `key` | String (e.g. `C`, `Am`, `F#m`) | `""` | Source musical key. Editing applies locally and stages a metadata proposal for GAIA. |
| **Key Matching** | `key_match_mode` | Radio (`Off` / `Follow` / `Lead`) | `Off` | `Off` disables `Matching Algorithm`; `Follow` transposes to match the global key; `Lead` sets the global key from this sample. |
| **Matching Algorithm** | `key_match_algorithm` | Radio (`Shift Nearest` / `Shift Higher` / `Shift Lower`) | `Shift Nearest` | Active when `Key Matching` is `Follow` or `Lead`. Chooses pitch-shift direction when matching keys. |
| **Transpose** | `transpose` | Int (`-24` – `+24 st`, step `1`) | `0` | Semitone pitch shift. Supports [Field Operators](./fieldoperators.md). |
| **Fine Tune** | `cents` | Int (`-100` – `+100 ct`, step `1`) | `0` | Fine pitch adjustment in cents (`100 ct = 1 st`). Supports [Field Operators](./fieldoperators.md). |
| **Stretch Mode** | `stretch_mode` | Radio (`Time Stretch (Independent Pitch)` / `Repitch (Speed + Pitch)`) | `Time Stretch` | `Time Stretch` decouples pitch from tempo; `Repitch` links pitch and speed together like tape/vinyl resampling. |
| **Stretch Algorithm** | `stretch_algorithm` | Radio (`General / Tonal — R3 Finer` / `Vocals / Speech — R3 Formant` / `Drums / Percussion — R2 Crisp`) | `General / Tonal` | Rubber Band engine mode when `Time Stretch` is selected (`Repitch` always uses resampling). |

### `CHAIN`, `EXPORT` & `COMMON` Tabs

- **`CHAIN`**: Gain Staging (`Pre Gain` defaults to **`-6.0 dB`**, `Post Gain` defaults to **`0.0 dB`**).
- **`EXPORT`**: Per-node WAV export settings (see [Shared `EXPORT` Tab](#shared-export-tab-export)).
- **`COMMON`**: `Appearance → Color` and `Info Table`.

---

## 3. Sequence Node (`Audio/Sequence` · `SEQ`)

Multi-slot 16-step pattern sequencer (`#ec4899`) that triggers an upstream `Sample` node across steps and addresses its slots dynamically.

**Tabs:** `SEQUENCE` | `CHAIN` | `EXPORT` | `COMMON`

### `SEQUENCE` Tab

#### Slot Strip, Sequence Header & 16-Step Grid

- **Slot Strip (`[0]`, `[1]`, …, `+`)**: Stores independent pattern slots (`slots[]`), each with its own step toggles, step parameter lanes, `Sample Slot`, `Total Bars`, `Step Length`, `Voice Mode`, `Release`, and `Step Fade`.
- **Sequence Header Row**:
  - **Sequence Name / Pool Selector (`pool_query`)**: Rename the sequence, drop `.seq`/`.mid` files to load, or type a [Field Operator](./fieldoperators.md) when a sequence pool is attached.
  - **`POOL` Button**: Toggles the inline sequence/MIDI Pool editor.
  - **Save (`💾`) Button**: Saves the active pattern as a `sin-sequence` document into the default GAIA vault.
- **Step Toggles (`1` – `16`)**: Click steps to arm/disarm triggers (`sequence[0..15]`).
- **Per-Step Parameter Lanes** (6 lanes under steps `1`–`16`; each step value can also be modulated by an attached `Random` modifier):

| Step Lane | Key | Type / Range | Default | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Sample Start** | `sample_start` | Float (`0.0` – `1.0`, step `0.1`) | `0.0` | Normalized start offset inside the triggered sample for that step (`0.0` = beginning). |
| **Gate Length** | `gate_length` | Float (`0.0` – `1.0`, step `0.1`) | `1.0` | Fraction of full sample duration played (`1.0` = full length; `< 1.0` engages optional `Release` fade-out). |
| **Velocity** | `velocity` | Float (`0.0` – `1.0`, step `0.1`) | `1.0` | Step amplitude multiplier (`0.0` = silent, `1.0` = full). |
| **Offset** | `offset` | Float (`-0.5` – `+0.5`, step `0.1`) | `0.0` | Bipolar micro-timing shift in step fractions (negative = early, positive = late). |
| **Probability** | `probability` | Float (`0.0` – `1.0`, step `0.1`) | `1.0` | Chance (`0.0`–`1.0`) that an active step fires on a given cycle. |
| **Subdivisions** | `subdivisions` | Int (`1` – `16`, step `1`) | `1` | Divides a single step into rapid equal repeats (ratchets/rolls). |

#### Pattern Parameters

| Parameter | Key | Type / Range | Default | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Sample Slot** | `sample_slot` | String / Field Operator | `*` | Selects which upstream `Sample` slot triggers per step (`idx % S`). `*` follows the upstream node's currently active slot; accepts integers (`0`, `1`), patterns (`0 1`, `[0 1]`, `<0 1 2>`), or `rand` / `0..2`. |
| **Total Bars** | `total_bars` | Global Float (`0.25` – `128 bars`, step `0.25`) | `global` | Sequence duration before wrapping/padding. `global` inherits the parent `Track` / project length. |
| **Step Length** | `step_length` | Float (`0.0625` – `4.0 beats`, step `0.0625`) | `0.25` | Duration of each step in beats (`0.25` = 16th note; 16 × `0.25` = 1 bar in 4/4). Supports [Field Operators](./fieldoperators.md). |
| **Voice Mode** | `play_mode` | Radio (`Mono` / `Multivoice`) | `Mono` | `Mono` (`gate`) cuts off the previous voice when a new step triggers; `Multivoice` (`trigger`) allows overlapping tails to ring out. |
| **Release** | `release` | Float (`0.0` – `1.0`, step `0.1`) | `0.0` | Fade-out tail mapped as a fraction of sample length when `Gate Length < 1.0`. Supports [Field Operators](./fieldoperators.md). |
| **Step Fade** | `fade_ms` | Float (`0` – `5 ms`, step `0.1`) | `0` | Short gain fade-in/out applied to every triggered hit to prevent clicks. Supports [Field Operators](./fieldoperators.md). |

*(Deterministic variation for `Probability`, `Sample Slot` `"rand"`, and parameter Field Operators is driven by the toolbar **Global Seed** and **Refresh `↻`**.)*

### `CHAIN`, `EXPORT` & `COMMON` Tabs

- **`CHAIN`**: Gain Staging (`Pre Gain` and `Post Gain` default to **`0.0 dB`**).
- **`EXPORT`**: Per-node WAV export settings (see [Shared `EXPORT` Tab](#shared-export-tab-export)).
- **`COMMON`**: `Appearance → Color` and `Info Table`.

---

## 4. Arrangement Node (`Audio/Arrangement` · `ARR`)

Section-based timeline router (`#f59e0b`) that slices a bar span into sections and triggers connected `Sequence` or `Sample` slots per section with independent probability, quantization, and anchor alignment.

**Tabs:** `ARRANGEMENT` | `CHAIN` | `EXPORT` | `COMMON`

### `ARRANGEMENT` Tab

#### Sections Header & Interactive Timeline

- **Total Bars Readout**: Displays the arrangement's `total_bars` length (default **`4 bars`**). Updating `total_bars` proportionally scales existing section boundaries.
- **`Edit` / `Done` Mode Toggle**:
  - **Select Mode (`Edit` button inactive)**: Click any section block to inspect and edit its parameters below.
  - **Edit Mode (`Done` shown)**: Click inside the timeline to split at bar boundaries, drag cut lines to resize sections, or remove a cut to merge the right section into the left.
- *(Note: If multiple upstream audio nodes are connected to one `Arrangement`, one input is selected deterministically per cell.)*

#### Per-Section Parameters (`Section N`)

| Parameter | Key | Type / Options | Default | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Slot** | `section_slots[i]` | String (`*`, integer, or `rand`) | `*` | Selects which upstream `Sequence` or `Sample` slot plays during this section (modulo-wrapped `idx % S`). `*` follows the upstream node's active slot; `rand` picks deterministically from section seed. |
| **Probability** | `section_probability[i]` | Float (`0.0` – `1.0`, step `0.1`) | `1.0` | Chance (`0.0`–`1.0`) that each quantized cell inside this section plays (`0` = muted). |
| **Quantize** | `section_quant[i]` | Select (`Continuous`, `1 Bar`, `½ Bar`, `Beat`, `Once`) | `Continuous` | Retrigger interval inside the section:<br>• `Continuous` (`auto`): loops/tiles upstream audio seamlessly at its natural loop length<br>• `1 Bar` (`bar`): retriggers every bar<br>• `½ Bar` (`0.5`): retriggers every 2 beats<br>• `Beat` (`beat`): retriggers every beat<br>• `Once` (`none`): plays once at section start without looping |
| **Anchor** | `section_quant_anchor[i]` | Select (`Start` / `End`) | `Start` | Aligns upstream audio to the `Start` or `End` of each quantized cell (`End` right-aligns pickups, fills, and reverse transitions against the bar line). |

### `CHAIN`, `EXPORT` & `COMMON` Tabs

- **`CHAIN`**: Gain Staging (`Pre Gain` and `Post Gain` default to **`0.0 dB`**).
- **`EXPORT`**: Per-node WAV export settings (see [Shared `EXPORT` Tab](#shared-export-tab-export)).
- **`COMMON`**: `Appearance → Color` and `Info Table`.

---

## 5. Master / Track Node (`Audio/Track` · `TRACK`)

Mixing bus and timeline authority (`#4f46e5`). A `Track` node acts either as an intermediate **Submix Bus** or as the graph's **Master Track** (`role: "master"`, e.g. `Master Output`). Nesting a shorter `Track` or `Arrangement` inside a longer parent `Track` creates **Wrapper Cycles** for [Field Operators](./fieldoperators.md).

**Tabs:** `TRACK` | `CHAIN` | `EXPORT` | `COMMON`

### `TRACK` Tab

| Parameter | Key | Type / Range | Default | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Mix Mode** | `mix_mode` | Select (`Sum` / `First` / `Last`) | `Sum` | Controls input combination (`Sum` layers and adds all connected upstream channels simultaneously). |
| **Engine BPM** | `bpm` | Global Float (`20` – `300 BPM` or `global`) | `global` | Tempo applied to this track and its upstream subtree. `global` inherits the project's Global Track tempo. |
| **Total Bars** | `total_bars` | Global Float (`0` – `128 bars` or `global`, step `0.25`) | `global` | Timeline duration enforced by this track: pads shorter children, trims longer children, and defines the **Wrapper Cycle** length $W$ for upstream nodes. |

### `CHAIN`, `EXPORT` & `COMMON` Tabs

- **`CHAIN`**: Gain Staging (`Pre Gain` and `Post Gain` default to **`0.0 dB`**).
- **`EXPORT`**: Per-node WAV export settings (see [Shared `EXPORT` Tab](#shared-export-tab-export)).
- **`COMMON`**: `Appearance → Color` and `Info Table`.

### Global Track Parameters Panel (Project Settings)

Any node parameter left at **`global`** inherits from the project-level **Track Parameters** panel:

| Section | Controls | Defaults & Range |
| :--- | :--- | :--- |
| **Tempo & Length** | `Tempo (BPM)` (`-`/`+` steppers, wheel), `Length (Bars)` (`-`/`+` steppers, wheel), `Bar Presets` (`1, 2, 4, 8, 16, 32`), live duration badge (`seconds (MM:SS.s) · beats @ 4/4`) | `120 BPM` (`20`–`300`), `4 Bars` (`0.25`–`128`) |
| **Musical Key & Scale** | `Current Key` text input, Root chips (`C`–`B`), Mode chips (`Major` / `Minor`) | `C` |
| **Graph Overview & Quick Actions** | Live counts (`Total Nodes`, `Samples`, `Sequences`, `Tracks`), **`↻ Recalculate All Pools`**, **`Reset to Defaults (120 BPM, 4 Bars, C)`** | — |

---

## 6. Attached Modifiers & Utility States

Modifiers attach directly to an owning `Sample` or `Sequence` node rather than wiring audio cables.

| Node | Badge | Tabs | Key Controls & Behavior |
| :--- | :--- | :--- | :--- |
| **Asset Pool** (`Audio/AssetFilter`) | `PATH` (`#7e22ce`) | `FILTER` \| `COMMON` | Holds an ordered list of GAIA/local assets (`selected_items`) and `Playback` mode (`Random` / `Sequential`). When **Global Seed > 0**, the list order permutes deterministically (`0` preserves your exact order). Can also be edited inline via the `POOL` button on `Sample` or `Sequence`. |
| **Random** (`Audio/Random`) | `RND` (`#7e22ce`) | `RANDOM` \| `COMMON` | Click **`Map Parameters`** to enter click-to-map mode on the parent node's numeric controls (`Ctrl+Click` to adjust range directly). Drag each destination's horizontal **`±%`** pill to set its bipolar spread (color-coded emerald `<=15%`, cyan `<=35%`, amber `<=60%`, magenta `>60%`). |
| **Disabled** (`Audio/Disabled`) | — (`#64748b`) | — | Bypass marker that excludes a disabled node subtree from ERMES serialization and DSP rendering. |

---

**Index:** [SIN Reference](./README.md) · **Next:** [Field Operators & Pseudo-Language](./fieldoperators.md) · **Tutorials:** [Beginner First Start Guide](../start/README.md)
