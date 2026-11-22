# Projects & Editors

<!-- Outline scaffold — Phase 2+ fills full prose -->

Create non-destructive Projects inside a vault, edit audio in GAIA's embedded editors, and review metadata proposals sent from SIN.

---

## Outline

- **Managed Projects**: Created via `File → New project` / `+` button; stores project-owned derivatives under `files/<stage>/` and state in `files/edit/current.json` while leaving imported sources untouched.
- **Embedded Editors (`Editor` drawer)**:
  - **Simple Media Editor**: Waveform trimming, cuts, gain, cue playback, and saving scratch edits as a project (`+ Project`).
  - **SIN Node Editor (`SinEngine`)**: Embedded `timeline` / `graph` / `split` views powered by the realtime DSP engine.
- **Checkpoints & Non-Destructive Export**: Saving/restoring snapshots (`+ CP`) and exporting cuts/renders to a GAIA vault, external folder, or `files/cuts/` (with optional sequential versioning and project master selection).
- **Reviewing SIN Metadata Proposals**: Inspecting and accepting/rejecting BPM, key, or favourite proposals staged by SIN (`Review SIN proposals` toolbar button).

---

**Prev:** [Organizing & Playlists](./organizing-and-playlists.md) · **Index:** [GAIA Guide](./README.md)
