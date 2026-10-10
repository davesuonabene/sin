# RONALD Demo & Minimal Beat Systems

This directory contains the foundational assets, branding, and composition architectures for **RONALD**, an abstract/cloud/vapor hip-hop producer created to showcase the capabilities of the **SIN node editor**.

---

## 1. Directory Structure

```text
demo/
└── ronald/
    ├── branding.md                     # Full producer persona, sonic DNA & rules
    ├── README.md                       # Walkthrough of systems & workflows
    ├── system_1_cloud_drift.json       # Canonical authoring graph for System 1 (Cloud Rap / Clams Casino)
    ├── system_2_tape_haze.json         # Canonical authoring graph for System 2 (Lo-Fi Soul / Dilla Pocket)
    └── system_3_celestial_drip.json     # Canonical authoring graph for System 3 (Ambient Abstract Trap)
```

In addition, all three systems are compiled into the editor's workspace format in [`saves/`](file:///c:/web-projects/sin/saves):
- [`saves/ronald_cloud_drift.json`](file:///c:/web-projects/sin/saves/ronald_cloud_drift.json) (also mirrored to [`saves/.current-stage.json`](file:///c:/web-projects/sin/saves/.current-stage.json))
- [`saves/ronald_tape_haze.json`](file:///c:/web-projects/sin/saves/ronald_tape_haze.json)
- [`saves/ronald_celestial_drip.json`](file:///c:/web-projects/sin/saves/ronald_celestial_drip.json)

These can be opened directly within the SIN editor UI from the workspace preset selector.

---

## 2. Refresh Policy: Global by Default

All asset pool modifiers across SIN now use `refresh_mode: "global"` by default:
- **Global Preview / Play (▶)**: Triggers an atomic re-roll of every asset pool in the system (melodic chops, 808 subs, kicks, snares, hi-hats, percussions).
- **Deterministic Playback**: While a preview is active or looping, the selected combination remains locked and stable across all 16 bars.
- **Expressive Variety**: Simply pressing the global play button rolls a new unique beat permutation while preserving Ronald's strict aesthetic constraints.

---

## 3. Drum Groove & Movement Engine

In response to research into classic Clams Casino cloud rap, J Dilla drunken swing, and lo-fi boom-bap, Ronald's drum sequences incorporate **humanized micro-timing**, **velocity dynamics**, and **subdivision rolls**:

### Movement Techniques
1. **Lazy Snare Pocket**:
   - Main snares and claps on beats 2 and 4 are shifted by `offset: +0.02` to `+0.035` beats (~15–25 ms behind the rigid grid), producing the signature laid-back, floating pocket.
   - Low-velocity ghost snares (`velocity: 0.32` - `0.40`) are programmed on turnaround 16th steps with `probability: 85-90%` to naturally breathe.
2. **Hi-Hat Velocity Wave & Skitter Rolls**:
   - Instead of static velocities, hats feature an undulating wave pattern: downbeat accents (`0.90 - 0.95`), softer offbeats (`0.38 - 0.45`), and ghost taps.
   - Micro-timing offsets alternate between on-grid (`offset: 0.0`) and delayed swung 16ths (`offset: +0.024` to `+0.032`).
   - Turnaround steps (step 14 or 15) trigger fast `subdivisions: 2` (32nd notes) or `subdivisions: 3` (triplet flutter rolls).
3. **Syncopated Kick Bounce**:
   - Halftime boom-bap kicks feature an anchor on beat 1 (`step 0`), pushed offbeats on `step 10` (`offset: -0.015`), and syncopated bounce hits on `step 6` or `step 13`.
4. **Registered GAIA Sequence Pattern Assets**:
   14 sequence patterns have been authored and saved into GAIA's default vault (`assets/vaults/default-vault/sequences/`):
   - Kicks: `Cloud Kick - Sparse Halftime` (ID 7354), `Cloud Kick - Syncopated Bounce` (ID 7355), `Lo-Fi Kick - Dilla Swing` (ID 7356), `Cloud Kick - Heavy Offbeat Drive` (ID 7364).
   - Snares: `Cloud Snare - Lazy Pocket and Ghost` (ID 7357), `Clams Reverb Clap - Halftime Push` (ID 7358), `Lo-Fi Snare - Swung Ghost Pocket` (ID 7359), `Cloud Snare - Double Tap Turnaround` (ID 7365).
   - Hats: `Cloud Hat - Dynamic Wave Groove` (ID 7360), `Cloud Hat - Skitter Rolls` (ID 7361), `Lo-Fi Hat - Lazy 8th Swing` (ID 7362), `Cloud Hat - Triplet Flutter Rolls` (ID 7366).
   - Percs: `Perc - Ambient Shaker Groove` (ID 7363), `Perc - Ghost Rim and Wood Tap` (ID 7367).

---

## 4. Systems Overview (Pattern Pools & Expanded Sample Pools)

All 3 systems employ the **compacted drum bus architecture** enhanced with both **Sample Pools** and **Pattern Pools**:
- **Atmospheric Sample Alone**: Melody channel runs through its dedicated atmospheric submix directly to the Master Output. Expanded to 14 curated loops from Crate vol.6 and the GAIA library.
- **Compacted Drums with Pattern Pools**:
  - Each drum part (Kick, Snare, Hi-Hat, 808 Sub) has its own **Sample Pool** (13–18 samples each from Mike Zara's Stash, Crate vol.6, etc.) and a dedicated **Pattern Pool** (`accepted_asset_type: "sequence_source"`) selecting among the registered sequence patterns in the default vault.
  - **Dynamic Humanization**: Hi-Hat and Snare sequences feature attached `Audio/Random` map modifiers humanizing velocity ($\pm 10–18\%$) and micro-timing ($\pm 8–12\%$).
  - All drum sequences merge into a single `Drum & 808 Submix` track with bus compression, which feeds the Master Output.

### System 1: "Cloud Drift" (Clams Casino Homage)
- **Tempo**: 76 BPM | **Key**: F minor | **Bars**: 16 (Full Loop)
- **Melodic Pool**: 14 ethereal loops (`Roy Ayers - Brooklyn Baby` & `The Memory`, `Piero Umiliani - Stream`, `Hiroshi Sato - Say Goodbye`, `Tele Music - Synthetiseurs In Love`, `Akira Inoue - Wind, Wave & Wineglass`, `Patrice Rushen`, `Deodato - Venus`, `Luiz Bonfa`, `Gary Bartz`, `Astrud Gilberto`, `The Softones`). Mode: `Random`, `refresh_mode: "global"`.
- **808 Sub Sample Pool**: 14 heavy subs (`Paradise`, `Plugg`, `Professor`, `Retail Bass`, `Rolex`, `Sanctuary`, `Southside`, `Spinz`, `Subby`, `808-dust-C`).
- **Pattern Pools**:
  - Kick Pattern Pool: Halftime sparse, syncopated bounce, Dilla swing, heavy offbeat drive (IDs 7354, 7355, 7356, 7364, 7267, 7272).
  - Snare Pattern Pool: Lazy pocket, reverb clap, swung ghost, double tap turnaround (IDs 7357, 7358, 7359, 7365, 7268, 7270, 7283).
  - Hi-Hat Pattern Pool: Dynamic wave groove, skitter rolls, 8th swing, triplet flutters (IDs 7360, 7361, 7362, 7366, 7269, 7281, 7282, 7285).
  - 808 Pattern Pool: Sustained halftime root notes & turnaround drops (IDs 7354, 7356, 7274, 7276, 7279).
- **Compacted Drums**: 13 kicks, 17 snares/claps, 18 hats merging into `Drum & 808 Submix`.

### System 2: "Tape Haze" (Lo-Fi Soul & Dilla Swing)
- **Tempo**: 82 BPM | **Key**: Ab minor | **Bars**: 16 (Full Loop)
- **Melodic Pool**: 14 dusty Japanese City-Pop, soul & funk samples (`Patrice Rushen`, `David Axelrod`, `Leroy Hutson`, `Masayoshi Takanaka`, `Alessandro Alessandroni`, `Giuliano Sorgini`, `Manfredo Fest`, `Dalton - Soul Brother`, `Waltel Branco`, `Sven Libaek`, `Roy Ayers`, `Piero Umiliani`). Mode: `Random`, `refresh_mode: "global"`.
- **808 Sub Sample Pool**: 12 warm analog subs (`Paradise`, `Playboi`, `Retail Bass`, `Rolex`, `Servida`, `Southside`, `Subby`, `808-dust-C`).
- **Pattern Pools**: Full rhythmic pattern pools across Kick, Snare, Hi-Hat, and 808 with Dilla swing.
- **Compacted Drums**: 13 dusty kicks, 17 vintage snares/claps, 18 organic hats merging into `Drum & 808 Submix`.

### System 3: "Celestial Drip" (Ambient Abstract Trap)
- **Tempo**: 72 BPM | **Key**: E minor | **Bars**: 16 (Full Loop)
- **Melodic Pool**: 14 ambient synth, flutes, and guitar loops (`Tele Music Synthetiseurs`, `Akira Inoue`, `Berto Pisano`, `Johnny Hawksworth`, `Akira Ishikawa`, `Plaisirs Erotique`, `Rodion G.A. - Citadela`, `Sven Libaek`, `Piero Umiliani`, `Roy Ayers`, `Hiroshi Sato`, `Deodato`). Mode: `Random`, `refresh_mode: "global"`.
- **808 Sub Sample Pool**: 14 sliding sub basses for deep low-end resonance.
- **Pattern Pools**: Halftime bounce, syncopated trap kicks, ghost snares, and triplet flutter hat rolls.
- **Compacted Drums**: 13 punchy kicks, 17 claps/snares, 18 hats merging into `Drum & 808 Submix`.

