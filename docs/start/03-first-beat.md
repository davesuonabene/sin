# 03 — First Beat

<!-- Outline scaffold — Phase 2 fills full prose -->

Trigger one-shot drum samples with 16-step `Sequence` nodes, balance levels with `CHAIN` Gain Staging, and sum them into a `Master Track`.

---

## What You'll Learn

- Switching `Sample` nodes to `One Shot` mode for drums and percussion.
- Programming triggers and per-step micro-timing in `Sequence`.
- Balancing drum levels via `CHAIN` (`Pre Gain` / `Post Gain`) and summing into `Master Track`.

## Open & Play

- Target patch *(Phase 2)*: `02_first_beat.json` — see [Patches Directory](./patches/README.md).
- Ensure Kick, Snare, and Hi-Hat slots have starter or local one-shot hits loaded, then press `Space`.

## Read the Graph

```text
[ Kick Sample (One Shot) ]   ──▶ [ Kick Sequence ]   ──┐
[ Snare Sample (One Shot) ]  ──▶ [ Snare Sequence ]  ──┼──▶ [ Master Track ]
[ Hi-Hat Sample (One Shot) ] ──▶ [ Hi-Hat Sequence ] ──┘
```

## Hands-On Tweaks

1. Open the `Sequence` Inspector (`P`) and toggle steps on the 16-step grid; check `Step Length` (`0.25` beats = 16th note).
2. Shape dynamics and groove per step using `Velocity`, `Offset` (push/pull timing), `Probability`, and `Subdivisions` (ratchets).
3. Test `Voice Mode` (`Mono` vs `Multivoice`), `Gate Length`, `Sample Start`, and `Release`, then open the `CHAIN` tab to balance `Pre Gain` / `Post Gain`.

## Try It Yourself

- Add a ghost snare hit with `Velocity` around `0.35` and `Probability` around `0.5`, then nudge its `Offset` slightly late (`+0.1`).

---

**Prev:** [02 — First Sound](./02-first-sound.md) · **Next:** [04 — Slots, Pools & Variation](./04-slots-pools-and-variation.md) · **Reference:** [Nodes Reference](../sin/nodes-reference.md)
