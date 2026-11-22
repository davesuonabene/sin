# 02 — First Sound

<!-- Outline scaffold — Phase 2 fills full prose -->

Load a single loop, get familiar with playback and the Inspector (`P`), and stretch or transpose it to fit your project tempo and key.

---

## What You'll Learn

- Opening a starter patch and using the global transport (`Space`).
- Selecting a `Sample` node (`Loop` mode) wired into a Master `Track`.
- Cropping audio and adjusting `Target BPM`, `Key Matching`, and `Transpose`.

## Open & Play

- Target patch *(Phase 2)*: `01_first_sound.json` — see [Patches Directory](./patches/README.md) (`File → Open… → Browse local file…`).
- Load a loop from the GAIA Library (`L`) or a local audio file onto the `Sample` node, then press `Space` to start playback.

## Read the Graph

```text
[ Sample (Loop) ] ──▶ [ Master Track ]
```

## Hands-On Tweaks

1. Open the Inspector (`P`) on the `Sample` node and drag `Crop Start` / `Crop End` handles on the waveform.
2. Change `Target BPM` (from `global` or adjust the project BPM) to hear Rubber Band time-stretching keep the loop locked.
3. Adjust `Transpose` (semitones) or `Key Matching` (`Off` / `Follow` / `Lead`).

## Try It Yourself

- Swap the audio file for a different loop from your Library (`L`) or disk and trim a 1-bar slice using `Crop Start` and `Crop End`.

---

**Prev:** [01 — First Vault in GAIA](./01-first-vault-in-gaia.md) · **Next:** [03 — First Beat](./03-first-beat.md) · **Reference:** [Nodes Reference](../sin/nodes-reference.md)
