# 05 — Arranging & Exporting

<!-- Outline scaffold — Phase 2 fills full prose -->

Structure multi-bar sections with an `Arrangement` node, render nodes cleanly, save your workspace, and export a WAV master.

---

## What You'll Learn

- Splitting a timeline into sections inside `Arrangement` and addressing upstream `[0][1]` slots per section.
- Using `Quantize`, `Anchor`, and `Probability` per section for turnarounds and fills.
- Exporting via a node's `EXPORT` tab, the top `Render` menu, saving workspaces, and downloading audio.

## Open & Play

- Target patch *(Phase 2)*: `04_mini_arrangement.json` — see [Patches Directory](./patches/README.md).
- Press `Space` and watch the playhead move across sections `A`, `B`, and `Fill`.

## Read the Graph

```text
[ Multi-Slot Sequence [0][1] ] ──▶ [ Arrangement (Sections) ] ──▶ [ Master Track ]
```

## Hands-On Tweaks

1. Select the `Arrangement` node (`P`) and click sections to inspect `Slot` (`section_slots`), `Probability`, `Quantize` (`Continuous` / `1 Bar` / `½ Bar` / `Beat` / `Once`), and `Anchor` (`Start` / `End`).
2. Toggle `Edit` mode on the timeline to split a 1-bar turnaround at the end of the loop and point it to slot `1` or `rand`.
3. Explore the `EXPORT` tab (`Pattern`, `Variables`, `Render`), the top `Render` menu (`Render Flagged Nodes`, `Render Selected Nodes`, `Render Most Parent Nodes`, `Render All Nodes`), `File → Save As…` (`Ctrl/Cmd+S`), and `File → Download selected audio`.

## Try It Yourself & Workshop Recap

- **Challenge:** Combine a `Sample` loop, a 3-part beat balanced via `CHAIN` Gain Staging, and a 2-section `Arrangement`, then export a clean `< 0 dBFS` WAV file.
- **Next Steps:**
  - Explore full library features in the [GAIA Library Guide](../gaia/README.md).
  - Keep the [Nodes Reference](../sin/nodes-reference.md) and [Field Operators & Pseudo-Language](../sin/fieldoperators.md) handy as your cheat sheet.

---

**Prev:** [04 — Slots, Pools & Variation](./04-slots-pools-and-variation.md) · **Index:** [First Start Guide](./README.md) · **Home:** [Documentation Index](../README.md)
