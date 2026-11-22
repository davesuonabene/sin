# 04 — Slots, Pools & Variation

<!-- Outline scaffold — Phase 2 fills full prose -->

Turn static patterns into controlled generative variations using multi-slots, attached modifiers (`Asset Pool` and `Random`), Global Seed, and Field Operators.

---

## What You'll Learn

- Adding and switching multi-slots (`[0]`, `[1]`, …) on `Sample` and `Sequence` nodes.
- Attaching `Asset Pool` and `Random` modifiers to drive variation without re-wiring audio cables.
- Using **Global Seed**, **Refresh (`↻`)**, **Global Seed Lock**, and **Global Freeze** safely during playback.
- Writing your first **Field Operator** expression in `Sample Slot` (`sample_slot`) or parameter fields.

## Open & Play

- Target patch *(Phase 2)*: `03_slots_and_variation.json` — see [Patches Directory](./patches/README.md).
- Press `Space` to play, then click **Refresh (`↻`)** in the top toolbar to hear deterministic seed variations.

## Read the Graph

```text
[ Asset Pool ] ─ ─(pool)─ ─▶ [ Multi-Slot Sample [0][1] ] ──▶ [ Sequence (sample_slot) ] ──▶ [ Master Track ]
                                                                          ▲
                                                        [ Random ] ─ ─(mod)┘
```

## Hands-On Tweaks

1. Click slot pills `[0]` and `[1]` on the `Sample` node (or `+` to add a slot), and see how `Sequence`'s `Sample Slot` expression (`0`, `0 1`, `<0 1>`, or `rand`) picks which slot fires.
2. Increment **Global Seed** (or click **Refresh `↻`**), then toggle **Global Seed Lock** and **Global Freeze** to keep chosen sounds locked while re-rolling random expressions.
3. Inspect the `Random` modifier's destination ranges and try a simple Field Operator like `[0 1]` or `<0 random>` (blue-tinted calculated display vs click-to-edit raw expression).

## Try It Yourself

- Drag multiple hits from the Library (`L`) onto a slot pill `[0]` vs onto `+`: dropping onto `+` creates separate fixed slots, while dropping onto a slot pill writes a space-separated Wrapper Cycle list (`hit_a.wav hit_b.wav`, which you can wrap in `<...>` for per-event round-robin).

---

**Prev:** [03 — First Beat](./03-first-beat.md) · **Next:** [05 — Arranging & Exporting](./05-arranging-and-exporting.md) · **Deep Dive:** [Field Operators & Pseudo-Language](../sin/fieldoperators.md)
