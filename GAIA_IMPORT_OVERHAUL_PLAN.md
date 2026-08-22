# GAIA Import Flow

## Contract

- One source-path input accepts a file, folder, or ZIP; GAIA determines the source kind.
- Preview is read-only and path/stat-only. Do not hash, decode, copy, extract, analyze audio, or write database rows during preview.
- Show every discovered folder/file in one nested table.
- Folder rows start collapsed, remain independently expandable, and aggregate descendant warning counts.
- Folder rows expose concrete folder types and profiles. `Unclassified folder` is preview structure only and is never persisted as an asset.
- File rows expose only types in their detected family: audio → audio/track/sample; MIDI → MIDI; sequence → sequence; other → file.
- Files may be excluded individually. Likely application/OS sidecars are flagged, with one bulk action to exclude all flagged artifacts.
- Auto-apply strong detections such as timestamp-prefixed Zoom H4 and stem-name multitracks. Show weak matches such as Sample pack as suggestions requiring user confirmation.
- Sample pack is a `collection` with the `sample_pack` profile, not an asset type. Preserve every file and relative path and mark the managed snapshot immutable.
- Import always runs as a background job after confirmation. Queueing closes the modal; the main library remains usable and owns the persistent progress/result strip.

## Flow

1. Initialize destination to the currently selected vault. The vault dropdown ends with `Create new vault…`, which creates and selects a destination without leaving the import flow.
2. Submit one source path to `POST /items/import/preview`.
3. Enumerate paths and stats, build the nested tree, classify filename patterns, and report conflicts.
4. Let the user correct folder assignments and family-constrained file types in the table.
5. Submit `preview_id`, `folder_assignments`, `item_types`, `excluded_indexes`, and conflict action to `POST /items/import/jobs`.
6. Re-enumerate and compare the stat fingerprint. Stop as stale if the source changed or disappeared.
7. Copy to per-job staging, then perform hashing/content analysis in the background.
8. Move completed staging into the vault and commit all item rows and import-ledger rows atomically.
9. On cancellation/failure, roll back and remove every staging/final path created by the job.
10. Report progress in the main-screen strip; show completion details only when the user requests Results.

## Classification

- Zoom H4: recognize direct audio children containing at least two `Tr*` roles and `TrMic` or `TrLR`; permit arbitrary timestamp/name prefixes before the role token.
- Zoom mixdown: use `TrLR` when present; otherwise infer the sole renamed direct audio file as the mixdown and persist that role for later Project master selection.
- Multitrack: recognize at least two distinct direct stem-role names such as drums, bass, vocals, guitar, keys, synth, or percussion.
- Sample pack: separate profile file; suggest for media-heavy trees, never auto-assign.
- A classified parent owns its complete subtree. Nested folder assignments beneath it do not create overlapping assets.
- Excluding files does not remove the classified parent or the relative paths of retained files.
- Files outside classified folders import as individual managed assets; their source folders are not persisted.

## Safety and conflicts

- Source changed/deleted before execution → stale job; require reinspection. GAIA cannot recover bytes it never imported.
- Previously imported source → require `skip` or `new_snapshot`; never overwrite an existing managed asset.
- Source changed/deleted after a successful import → retain the managed vault copy.
- ZIP preview validates entry paths and configured archive limits without extracting.
- No synchronous or legacy import endpoint and no file/folder chooser branch.

## Logs

- One structured log per import at `gaia/log/imports/YYYY-MM-DD/<UTC timestamp>_<job_id>.log`.
- Record queued, started, stale, completed, cancellation, and failure events with job, preview, source, vault, assignments, counts, warnings, and errors.
- Retain logs; remove transient staging data.

## Verification

- Preview tests fail if hashing, audio analysis, or multitrack analysis is invoked.
- Cover timestamp-prefixed H4, nested H4 folders, filename-based multitracks, weak Sample pack suggestions, ZIPs, single files, family-constrained type validation, stale previews, conflicts, cancellation cleanup, atomic failure cleanup, profile persistence, and per-import logs.
- Verify the modal at port 8001: one source button, inline vault creation, initially collapsed nested table, visible H4 detection, profile/type optgroups, compact square-edged rows, no metadata submodal, responsive large-tree scrolling, and a non-blocking main-screen job strip.
