# 00 — Launch & Mental Model

<!-- Outline scaffold — Phase 2 fills full prose -->

Get SIN and GAIA running, learn what each app owns, and understand how audio flows across the node canvas in two minutes.

---

## 1. Launch the Stack

- Windows: `.\start_win.ps1`
- macOS / Linux: `./start_mac.sh`
- Services opened in the browser:
  - **SIN Node Editor**: `:8000`
  - **GAIA Library Manager**: `:8001`

## 2. Two Apps, Clear Boundary

- **GAIA** owns library management: importing, vaults, folders, metadata analysis, playlists, and projects.
- **SIN** is a read-only consumer of GAIA assets: browse vaults, audition sounds, and wire them into generative audio graphs.
- **Standalone local assets**: You can also load local audio samples directly onto SIN nodes when working without an active GAIA connection.

## 3. Left-to-Right Signal Flow & Active Nodes

Audio flows left-to-right from sound sources into sequencers/arrangers and out to a Master `Track`, while purple modifiers attach directly to an owning node:

- **Audio Nodes**: `Sample` → `Sequence` → `Arrangement` → `Track`
- **Attached Modifiers**: `Asset Pool` (feeds sample choices) and `Random` (modulates parameters)

*(See [Nodes Reference](../sin/nodes-reference.md) for full details on each node.)*

## 4. Essential First-Start Shortcuts

- `Space` — Play / Pause transport
- `L` — Toggle Library panel
- `P` — Toggle Properties / Inspector panel
- `Ctrl/Cmd + O` — Open workspace
- `Ctrl/Cmd + S` — Save workspace
- `Delete` / `Backspace` — Delete selected link, modifier badge, or focused slot
- `Esc` — Deselect nodes and cables

---

**Index:** [First Start Guide](./README.md) · **Next:** [01 — First Vault in GAIA](./01-first-vault-in-gaia.md)
