# Node editor agent contract

This document records the smallest useful contract for translating a natural-
language music request into an IRIDE graph. It is intentionally separate from
the runtime implementation so it can later become a skill or agent resource.

## What the agent can do today

- Build and validate audio graphs containing Samples, Sequences,
  Arrangements, Tracks, Modulators, Asset Filters, and Disabled placeholders.
- Connect audio nodes with directed edges and attach an Asset Filter to a
  Sample or Sequence as an ownership relationship.
- Use a concrete GAIA asset, a fixed pool item, or an explicit ordered range
  of GAIA asset keys selected from the Library panel.
- Set sample type, crop, transpose, cents, stretch mode, BPM, key, sequence
  steps, per-step parameters, play mode, fades, arrangement bars,
  quantization, probabilities, section points, seeds, and global parameters.
- Save the result in the existing LiteGraph workspace format and render or
  preview it through the existing local editor/backend flow.

## Asset-pool rule

The saved Asset Filter is a recipe, not a cache of resolved node state.

Persist:

- the pool node's own ID and display properties;
- selection policy (`playbackMode`, `refresh_mode`, and `seed`);
- lightweight exact-key locators in `selected_items` and, for fixed pools,
  `fixed_item`.

The Library panel owns search and filtering. The saved Asset Pool owns only
the resulting ordered list of exact GAIA asset IDs. Never add a filter query
to a pool or expand a pool from names, collection membership, or stale path
snapshots.

Do not persist as authored state:

- the currently selected output path or output metadata;
- the owner Sample/Sequence filepath and copied library metadata;
- the sequential cursor or other temporary selection state.

At load, preview, and render time, GAIA resolves the locators. The resolved
path and metadata are then supplied to the owning Sample or Sequence node.
This keeps pool nodes small while preserving their behavior.

## Recommended request translation

Before editing a graph, normalize the request into:

1. global timing: BPM, bars, key, and sample rate if relevant;
2. graph topology: source, processing/arrangement stages, and master output;
3. asset intent: concrete asset, fixed item, or item range;
4. musical behavior: sequence steps, timing unit, probability, quantization,
   seed, refresh scope, and variation;
5. save/preview intent: preset name, destination node, and whether to render.

The agent should report unresolved asset keys and assumptions about timing
before claiming the graph is complete.

## Missing software layer for reliable automation

These are the highest-value additions, in order:

1. **Canonical importer.** Convert an existing LiteGraph save into the
   canonical schema, including audio edges, pool attachments, groups, and
   unknown properties. This is needed for safe graph modifications rather than
   only new graph generation.
2. **Declarative patch API.** Add validated operations such as `addNode`,
   `removeNode`, `connect`, `disconnect`, `attachPool`, `setProperty`, and
   `replaceAssetReference`, with dry-run output and an atomic save.
3. **Asset-resolution report.** Return the resolved locator, candidate list,
   chosen item, missing/ambiguous references, and the effective seed/refresh
   scope before rendering. This makes pool behavior inspectable.
4. **Library selection report.** A range request should be resolved by the
   Library panel into exact GAIA IDs before graph authoring. The graph layer
   should receive and persist only that ID list, plus a clear missing-key
   error when an asset is removed.
5. **Timing-unit contract.** The editor and engine should expose whether a
   sequence step length is in beats, bars, or seconds. Current behavior uses
   beat-like values; this should be made explicit in the schema and UI.
6. **Audio verification.** Add loudness, clipping, duration, channel, and
   silence checks to preview/render results. Structural validation cannot prove
   that a graph sounds musically correct.

The local TypeScript schema is sufficient for the current in-app agent. A
network API is optional: it becomes worthwhile when an external process needs
to inspect or patch graphs, run dry-runs, or receive structured resolution and
render diagnostics.

## GAIA boundary

SIN may browse, preview, resolve, and use GAIA assets. Vault and asset creation,
import, tagging, organization, deletion, and other library management remain
GAIA responsibilities.
