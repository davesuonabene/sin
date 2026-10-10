# System Notifications & Issue Log

This file tracks runtime bugs, unexpected engine behaviors, and DSP/UI anomalies identified during workflow execution.

---

## [2026-10-08] Sample BPM Half-Time Shift-Down Error

### Severity
Medium (Audio Quality & Musical Correctness)

### Affected Components
- [`core/dsp.py`](file:///c:/web-projects/sin/core/dsp.py) (`process_sample_transform`)
- [`editor/src/ui/arrangementSourceVisual.ts`](file:///c:/web-projects/sin/editor/src/ui/arrangementSourceVisual.ts) (`computeArrangementSourceVisualData`)

### Description
When authoring beats in half-time tempos (e.g., 72–82 BPM cloud rap and lo-fi hip-hop) using loops whose inherent or detected tempo is in the 140–160 BPM range (e.g., Roy Ayers, Sven Libaek, Hiroshi Sato):
The time-stretching engine previously calculated the tempo rate strictly as `bpm_rate = target_bpm / original_bpm`.
For a 153.6 BPM loop in a 76 BPM project, this produced `bpm_rate = 76 / 153.6 = 0.495`, which halved playback speed and doubled sample duration, dragging the musical material into an unnatural, heavily artifacted slow crawl.

### Resolution
Implemented **octave-aware tempo matching** across `core/dsp.py` and `arrangementSourceVisual.ts`.
The algorithm evaluates candidate multipliers $k \in \{1.0, 2.0, 0.5\}$ and selects the rate that minimizes octave divergence $|\log_2(\text{rate})|$:
$$\text{rate} = \arg\min_{r \in \left\{\frac{\text{tgt}}{\text{orig}}, \frac{2\text{tgt}}{\text{orig}}, \frac{0.5\text{tgt}}{\text{orig}}\right\}} |\log_2(r)|$$

- For 153.6 BPM at 76 BPM: Candidate $k=2.0$ yields $\text{rate} = 152 / 153.6 = 0.9896$ (a ~1% imperceptible natural shift to double the intended tempo) instead of $0.495$.
- For 140 BPM at 76 BPM: Candidate $k=2.0$ yields $\text{rate} = 152 / 140 = 1.0857$ (+8.5% shift) instead of $0.54$.
- The loops now lock perfectly into the half-time grid while preserving their natural groove, tone, and performance speed.

---

## [2026-10-08] Sample Shift Direction Dropdown Ineffective & Constant Upward Shift

### Severity
High (User Control & Workflow Disconnect)

### Affected Components
- [`editor/src/nodes/SampleNode.ts`](file:///c:/web-projects/sin/editor/src/nodes/SampleNode.ts) (`prepareSerializedModel`)
- [`ermes/ts/serializer.ts`](file:///c:/web-projects/sin/ermes/ts/serializer.ts) (`serializeNode`)
- [`ermes/py/schemas.py`](file:///c:/web-projects/sin/ermes/py/schemas.py) (`AudioNodeModel`)
- [`core/engines.py`](file:///c:/web-projects/sin/core/engines.py) (`build_node_object`)
- [`core/audio_object.py`](file:///c:/web-projects/sin/core/audio_object.py) (`SampleObject`, `ItemPoolObject`)
- [`core/dsp.py`](file:///c:/web-projects/sin/core/dsp.py) (`process_sample_transform`)

### Description
The editor inspector exposes a **Matching Algorithm** selection (`key_match_algorithm`) with options:
- `Shift Nearest` (`nearest` / auto)
- `Shift Higher` (`higher` / up)
- `Shift Lower` (`lower` / down)

Despite changing this setting, samples consistently shifted upwards (doubling/speeding up). Investigation revealed three root causes:
1. **Frontend-to-Backend Disconnection**: `SampleNode.ts` previously only referenced `key_match_algorithm` locally for pitch transposition when `key_match_mode === 'follow'`. It was never serialized by `ermes/ts/serializer.ts` into the runtime payload.
2. **Missing Schema & Engine Parameters**: Neither `AudioNodeModel` in `ermes/py/schemas.py` nor `build_node_object` in `core/engines.py` accepted `key_match_algorithm` or `key_match_mode`. `ItemPoolObject` and `SampleObject` did not pass it into `process_sample_transform`.
3. **Hardcoded Upward Bias in DSP**: In `core/dsp.py`, the octave search minimized $|\log_2(r)|$ without checking the user's algorithm preference. For half-time loops (e.g., 74–86 BPM placed into 138–152 BPM projects), the multiplier $k=2.0$ was unconditionally chosen.

### Resolution
- Fully wired `key_match_algorithm` and `key_match_mode` from `SampleNode.ts` $\rightarrow$ `serializer.ts` $\rightarrow$ `AudioNodeModel` $\rightarrow$ `engines.py` $\rightarrow$ `SampleObject` / `ItemPoolObject` $\rightarrow$ `core/dsp.py`.
- In `core/dsp.py`, implemented explicit direction-aware candidate filtering:
  - `'higher'` / `'up'`: restricts candidates to $r \ge 1.0$ (speed up / double tempo).
  - `'lower'` / `'down'`: restricts candidates to $r \le 1.0$ (slow down / halve tempo).
  - `'nearest'` / `'auto'`: picks minimal $|\log_2(r)|$.
  - Added safe-zone logic: if direct stretch is already within musically acceptable tolerance ($|\log_2(r)| < 0.35$, ~27%), tempo is preserved 1:1 without octave jumps.
- Updated `ItemPoolObject`'s `transform_cache_key` to include `key_match_algorithm` to prevent stale cache hits across algorithm changes.

---

## [2026-10-08] Random Map Modifiers Added to Hi-Hat & Percussion Patterns

### Severity
Feature Enhancement / Expressive Humanization

### Affected Components
- [`ermes/ts/graphSchema.ts`](file:///c:/web-projects/sin/ermes/ts/graphSchema.ts) (Registered `'random'` as valid node & attachment type)
- [`ermes/ts/randomResolver.ts`](file:///c:/web-projects/sin/ermes/ts/randomResolver.ts) (Extended `applyRandomModulation` & `restoreBaseValues` for full step array modulation and robust link/node lookup)
- [`saves/ronald_*.json`](file:///c:/web-projects/sin/saves/) (All 3 presets updated with `Audio/Random` map modifiers)

### Description & Implementation
- Added `Audio/Random` map modifier nodes attached to:
  - **Hi-Hat sequence** (`parentId: 16`): velocity modulation $\pm 18\%$, micro-timing offset $\pm 12\%$, `refresh_mode: "global"`.
  - **Snare/Perc sequence** (`parentId: 12`): velocity modulation $\pm 10\%$, micro-timing offset $\pm 8\%$, `refresh_mode: "global"`.
- Extended `ermes/ts/randomResolver.ts` so when `dest.paramKey` is `'velocity'`, `'offset'`, `'probability'`, or `'subdivisions'`, all step items in `ownerNode.properties.step_parameters` are humanized and smoothly restored across preview/render cycles.
- Validated via `scratch/test_ram_preview_all_three.py`: all 3 presets generate previews with zero errors.

---

## [2026-10-08] Frontend TypeScript Compilation Error Crashing Launcher at Launch

### Severity
Critical (Launcher Startup Blocker)

### Affected Components
- [`start-all-dev.ps1`](file:///c:/web-projects/sin/start-all-dev.ps1) (Launcher script)
- [`ermes/ts/randomResolver.ts`](file:///c:/web-projects/sin/ermes/ts/randomResolver.ts) (`applyRandomModulation`)

### Description
Running `start-all.cmd` or `start-all-dev.ps1` failed immediately on launch with:
```
Launcher error: SIN frontend build failed.
```
The root cause was strict TypeScript checking during `tsc && vite build`:
In `ermes/ts/randomResolver.ts`, line 262: `dest.baseValueArray[i]` caused `TS18048: 'dest.baseValueArray' is possibly 'undefined'`.

### Resolution
- Safely extracted `const baseValues: number[] = dest.baseValueArray || [];` in `randomResolver.ts` to satisfy compiler strict null assertions.
- Also in `core/dsp.py`, ensured `key_match_mode` is passed and octave candidate shifting only activates when key matching is in `'follow'` or `'lead'` mode (avoiding unwanted doubling/halving during standard 1:1 playback tests).
- Verified `npm --prefix editor run build` succeeds (code 0 in 715ms).
- Verified `start-all-dev.ps1` successfully builds SIN, launches SIN API on port 8000, launches GAIA on port 8001, and passes all readiness checks.


