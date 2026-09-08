# GAIA Import Pipeline Design

## Goals

GAIA imports files in three durable stages:

1. Register database entries.
2. Manage file residency according to `move`, `copy`, or `keep`.
3. Analyze ready files incrementally.

Registration is the commit point for the import plan, not the end of the import. A restart or cancellation must leave enough durable state to resume without rescanning the source or guessing which files completed. Basic library rows appear immediately, but pending rows are visibly unavailable until their bytes are ready.

The default mode is `copy`. Preview remains read-only and performs path/stat inspection only. It must not hash, decode, copy, extract, analyze, or write database rows.

## Non-negotiable ownership and mutation rules

- Every item has exactly one owning vault.
- `managed` items have an `absolute_path` inside their owning vault.
- `external_reference` items created by `keep` retain their original external `absolute_path`; their immutable `source_path` is the same canonical path at registration.
- External references are read-only. GAIA may stat, stream, preview, hash, and analyze them, but must never rename, move, overwrite, delete, tag in place, create sidecars beside them, or create derivatives in their external folder.
- Deleting an external reference deletes only GAIA rows and relationships.
- All new projects, derivatives, materialized copies, partial files, and generated metadata files belong inside the owning vault.
- The sole external-mutation exception is a specific `move` operation that the user explicitly selects and separately confirms after a clear destructive warning. It may remove only the selected source files after a verified managed copy or atomic same-volume rename. The permission is scoped to that operation and those paths; it does not make the containing folder or other external references mutable.
- All filesystem-mutating services use one central guard: mutation is allowed only for a `managed` item whose resolved target is inside `vaults.vault_store(owning_vault)`.
- Projects are always `managed` and remain typed folders directly inside their owning vault.

## Import-panel contract

The preview panel adds one required `File handling` selector above the table:

| Value | Label | Meaning |
| --- | --- | --- |
| `move` | Move files into vault | Register destinations, transfer bytes into the vault, verify, then remove the original files. Requires a separate destructive confirmation. |
| `copy` | Copy files into vault | Register destinations, copy and verify inside the vault, and leave the source untouched. Default and safest choice. |
| `keep` | Keep files in original position (reference) | Register ready external references in the selected vault without transferring bytes. The external paths remain read-only. |

The selector is per import job, not per file. Changing it does not trigger another preview. Choosing `move` reveals a mandatory confirmation immediately before queueing: `Move these files into the vault? The original files will be removed from their current locations after GAIA verifies the vault copies. This cannot be undone by cancelling later.` The primary action reads `Move files and import`; a generic `Start import` button is not sufficient. `Copy` and `keep` require no destructive confirmation. The panel also explains that `keep` can become unavailable if an external path disappears.

The rest of the preview contract remains:

- One source-path input accepts a file, folder, or ZIP; GAIA detects the source kind.
- Show every discovered folder and file in one nested, independently collapsible table.
- Allow family-constrained type choices and individual exclusions.
- Provide bulk actions for flagged artifacts and non-audio files.
- Auto-apply only strong folder/profile detections; weak detections require confirmation.
- Classified parents own their retained subtree; nested assignments may not overlap.
- Queueing closes the modal and leaves the main library usable.

`keep` is not available for ZIP files because archive members do not have stable standalone external paths. ZIP imports offer `copy` and `move`; both extract only into vault-owned staging.

## Persistent data model

Do not keep authoritative import state only in process memory. Add persistent job and entry records.

### Item residency

Add queryable item fields:

- `storage_mode`: `managed` or `external_reference`.
- `availability`: `pending`, `transferring`, `ready`, `missing`, or `failed`.

Keep provenance and operational detail in `attributes.import`:

```json
{
  "job_id": "...",
  "mode": "copy",
  "source_path": "D:\\RECS NAMA\\show.wav",
  "intended_path": "D:\\GAIA ARCHIVE\\live-recs\\files\\show.wav",
  "source_size": 123,
  "source_modified_ns": 456,
  "state": "registered",
  "registered_at": "...",
  "ready_at": null,
  "analyzed_at": null
}
```

For `copy` and `move`, `absolute_path` is the collision-free intended managed path from the first database commit, even while `availability=pending`. `source_path` always remains the immutable provenance path. For `keep`, both `absolute_path` and `source_path` are the canonical external path and `storage_mode=external_reference`.

Pending items must not be playable or usable as render inputs. API responses and the UI expose `availability`; resolvers return a clear `asset transfer pending` result instead of falling through to a missing-file error.

### Import jobs

Persist an `import_jobs` row with:

- job id, preview fingerprint, source root, vault id, mode, status, and current phase;
- total files/bytes and registered, transferred, analyzed, skipped, and failed counters;
- timestamps, cancellation/pause request, error summary, and log path;
- folder assignments, exclusions, conflict policy, and schema version.

Persist one `import_entries` row per retained file with:

- job id, item id, source path, intended path, relative path, type, size, modified time, and optional source signature;
- transfer and analysis states, bytes copied, hash, attempt count, last error, and timestamps;
- parent/container identity needed to rebuild manifests deterministically.

Use uniqueness constraints for `(job_id, relative_path)` and indexes for `(job_id, transfer_state)`, `(job_id, analysis_state)`, and `item_id`. Import-entry rows are operational records, not asset relationship tables. Asset relationships continue to use generic `ItemReference` edges.

## Stage 0: inspect and confirm

1. Canonicalize the source and reject paths that overlap a destination managed vault for `copy` or `move`.
2. Enumerate files, folders, sizes, and modified timestamps without opening file content.
3. Build the nested table, classifications, warnings, and stat fingerprint.
4. Let the user select the owning vault, file-handling mode, classifications, exclusions, and conflict action.
5. Submit `preview_id`, `transfer_mode`, assignments, item types, exclusions, and conflict action.
6. Re-enumerate and compare the stat fingerprint before registration. A mismatch returns `stale` and creates no rows.

## Stage 1: register database entries

Registration must be fast, deterministic, and transactional.

1. Reserve every final managed destination without touching external bytes. Never overwrite; resolve collisions before inserting rows.
2. Insert the persistent import job and entries.
3. Insert basic polymorphic item rows and container rows using preview metadata only.
4. Store immutable provenance, residency, availability, assigned type/profile, source stat, and intended path.
5. Create parent/child rows and manifests with stable indexes. Do not hash or analyze.
6. Insert a `registered` import-ledger event and commit once.

After commit, the library reloads and shows all rows. Pending transfers have a visible state badge and disabled playback. A `keep` entry becomes `ready` in this transaction after confirming its source still matches the preview stat; there is no file-management work for it.

Registration is idempotent. Replaying the same job must return the existing rows instead of producing duplicates.

## Stage 2: manage files

Process entries independently and commit state after every successfully published file. Stop only at file boundaries unless a chunked copy observes cancellation.

### Copy

1. Revalidate source size and modified time immediately before reading.
2. Copy into a vault-owned sibling such as `.gaia-part-<job>-<entry>`.
3. Report total bytes, current-file bytes, throughput, and ETA. Do not round a hundreds-of-gigabytes job to whole percentages only.
4. Calculate SHA-256 while copying so the file is not read again solely for hashing.
5. Flush and close the partial file, preserve appropriate filesystem metadata, verify size and hash, then atomically replace the reserved final path.
6. Mark the item `managed/ready`, persist the hash and ready timestamp, and commit.
7. Never modify the source.

### Move

- On the same filesystem, prefer an atomic rename when the selected mapping permits it.
- Otherwise use the verified copy procedure above and remove the source only after the destination is durably published and the database transition commits.
- If source removal fails, keep the valid managed copy, report `copied_source_cleanup_failed`, and never claim the source was moved.
- A rollback may restore an atomic rename only when the original path is still free and the exact job owns the destination. Never overwrite while attempting restoration.
- Move authority is an immutable property of the confirmed job or materialization action. A worker must reject source deletion unless the persisted operation is `move`, the exact source belongs to that operation, and destructive confirmation is recorded.
- Never delete a source directory recursively. Remove only confirmed source files, then remove empty directories bottom-up only when the job created or exclusively selected the complete directory tree and every retained entry moved successfully. Otherwise leave source directories intact.

### Keep

- Perform no transfer and create no file, symlink, hardlink, sidecar, or metadata beside the source.
- Mark the entry `external_reference/ready` after stat revalidation.
- A missing or changed source becomes `missing`; preserve the library row and provenance so the user can relink or materialize it.

### Folder and container publication

Create managed destination directories before child publication, but never expose partial files under their final names. Container manifests may include pending children and must expose each child's availability. Container completion means every retained child is either ready, intentionally skipped, or has a surfaced failure.

## Stage 3: analyze

Analysis begins only for `ready` entries and never gates registration or file publication.

- Run sequentially per physical volume by default. Do not launch eight competing readers against one recording disk.
- Commit metadata after each file so progress survives a restart.
- `copy` and cross-volume `move` reuse the hash produced during transfer.
- Same-volume renames and external references may hash during this stage; a missing hash must not make a ready file unusable.
- Audio analysis reads headers/tags and updates duration, type inference, BPM/key hints, and tags without writing to media.
- Preserve an explicit user-selected type; automatic analysis may fill metadata but must not silently override a forced classification.
- Refresh derived collection tags and multitrack summaries after their children finish.
- Analysis failures leave the file `ready`, set analysis state `failed`, and expose a retry action.

The main screen shows three stages: `Register`, `Manage files`, and `Analyze`. File management reports bytes plus file count; analysis reports file count. For `keep`, `Manage files` immediately shows `Referenced` and 100%.

## Pause, cancellation, restart, and cleanup

`Cancel` means pause safely; it is not destructive rollback.

- Stop scheduling new entries and stop an active chunked copy at the next safe checkpoint.
- Delete only the current job-owned partial file.
- Keep registered rows, completed managed files, external references, and per-entry states.
- Offer `Resume`, `Retry failed`, and `Discard pending` in Results.
- `Discard pending` removes pending database rows and job-owned partial paths inside the vault. It never removes ready managed assets and never touches external sources.
- On process startup, reload queued/running jobs as `paused`, reconcile each entry from source/final/partial state, and make resume explicit.
- A final path with matching job ownership, size, and hash can be marked ready idempotently. Ambiguous files become a surfaced conflict; never overwrite or guess.

Structured logs record every state transition without repeating the complete type map on every line. Include timestamps, job/entry ids, paths, mode, byte counters, duration, throughput, warnings, and errors.

## External-reference actions

External references expose these table context-menu actions:

### Move file to vault

This is the one post-import action allowed to move external bytes. Require a separate confirmation: `Move this file into the vault? The original file will be removed from its current location after GAIA verifies the vault copy.` Copy and verify the source into the owning vault (or atomically rename it on the same filesystem), publish it, update the existing item's `absolute_path`, `storage_mode`, and availability while retaining immutable `source_path`, then remove the original file when a copy was required. This preserves item identity and all generic relationships while truthfully implementing move semantics.

The confirmation and persisted job grant authority only for the selected file or files. Cancelling before verified publication leaves the source in place. Cancelling after a completed move does not silently move it back or delete the managed copy.

### Copy file to vault

Materialize the selected external reference in place as a managed item, retaining its immutable original `source_path` provenance and all generic relationships. A future clone action may create a second item, but the minimal materialization action should not duplicate library identity or context.

Both actions use the same durable registration and transfer machinery as imports, including collision handling, partial files, inline hashing, pause/resume, and verification, but they do not share source-mutation semantics. Only `move` may remove the confirmed original paths; `copy` must never do so.

## Project references and orphan adoption

Placing an external reference in a project with `reference` mode creates only a generic `ItemReference`; it does not copy or mutate the source.

When the user runs `Adopt orphans`:

1. Use the project's existing generic reference graph as the allow-list.
2. For a managed orphan, retain the existing safe physical-move behavior within vault boundaries.
3. For an external-reference orphan, reserve a project-owned destination, copy from the external path to a project-owned source stage, hash during copy, verify, and atomically publish.
4. Only after publication succeeds, update the existing item identity to the managed project path, set `parent_id` to the project, set `storage_mode=managed`, and retain the immutable external `source_path` as provenance.
5. Sync the project manifest and relationships after the transaction commits.
6. Never remove or alter the external source, including when adoption is cancelled, retried, undone, or the project is deleted. Adoption is always copy-based and cannot inherit move authority from an earlier UI selection or job.

Project adoption should use `project/files/source/` for materialized input copies. Generated derivatives continue under `project/files/<stage>/`. A shared external item already referenced by multiple project contexts must show a confirmation before one project adopts its identity; the future clone action is the non-disruptive alternative.

## Delete, move, rename, and edit guards

Every mutating operation branches on residency before touching the filesystem:

- `managed`: require the resolved path to be inside the owning vault, then use recoverable staging/atomic operations.
- `external_reference`: database/relationship edits are allowed; external filesystem mutation is forbidden.

This applies to single and bulk deletion, vault deletion, move-to-vault, folder placement, project adoption, metadata edits, waveform/render outputs, relinking, and cleanup jobs. External metadata edits update GAIA's database only; never write tags into the referenced file.

The only service allowed to cross this guard is the dedicated, persisted `move` transfer operation after explicit destructive confirmation. Do not express move authority as a loose boolean accepted by internal helpers; pass an operation record whose mode, confirmed paths, confirmation timestamp, and state can be audited.

Vault deletion removes external-reference rows when the user confirms database deletion but never includes external paths in purge targets. Vault migration rewrites managed paths only; it must not rewrite immutable external `absolute_path` or `source_path` values.

## Conflicts and recovery

- Previously registered incomplete source: offer `Resume existing import` first.
- Previously completed source: offer `Skip` or `Create new snapshot/reference`; never overwrite.
- Source changed before registration: mark preview stale.
- Source changed before a pending copy/move: mark the entry stale and require reinspection.
- External reference changed after registration: keep the row, mark source status changed/missing, and offer reanalyze, relink, or materialize.
- Destination collision: allocate a deterministic unique path at registration; never decide a new path during transfer.
- Disk full or transient read error: keep completed entries ready, retain pending entries, remove only job-owned partials, and allow resume.
- Database failure after file publication: reconcile by job-owned intended path on restart; do not recopy blindly.

## API changes

- Add `transfer_mode: Literal["move", "copy", "keep"] = "copy"` to `ImportJobCreateRequest`.
- Return persistent phase, residency, availability, byte counters, speed, ETA, and per-stage totals from import-job endpoints.
- Add explicit pause/resume/retry/discard endpoints; cancellation aliases pause for compatibility.
- Add item materialization endpoints for `move file to vault` and `copy file to vault`; both enqueue durable jobs.
- Require a dedicated destructive-confirmation token or persisted confirmation record for every `move` import or materialization request. A transfer mode alone must not authorize source deletion.
- Make preview/use endpoints availability-aware and external-reference-aware.
- Paginate job entries and warnings; do not serialize the complete job manifest on every progress poll.

## Implementation order

1. Add residency/availability fields, persistent import job/entry tables, migrations, and central mutation guards.
2. Make readers and deletion safe for external references before enabling `keep` in the UI.
3. Implement database-first registration and idempotent resume.
4. Implement verified copy with inline hashing and accurate byte progress.
5. Implement move, including same-volume optimization and cross-volume copy-then-delete.
6. Implement keep/reference analysis and missing-source behavior.
7. Add context-menu materialization actions.
8. Update project orphan adoption for external references.
9. Replace the two-stage progress strip with three persistent stages and Results recovery actions.
10. Remove the legacy in-memory copy/analyze-before-commit path after migration and compatibility tests pass.

## Verification matrix

Automated tests must prove:

- preview invokes no hashing, decoding, analysis, filesystem mutation, or database write;
- registration commits rows before transfer starts and pending rows cannot be played;
- copy leaves source byte-for-byte intact, hashes inline, publishes atomically, and resumes without duplicating completed work;
- same-volume move uses atomic operations when safe; cross-volume move deletes source only after verified publication and commit;
- move cannot start without the dedicated warning/confirmation flow and cannot remove paths outside its persisted allow-list;
- keep creates no filesystem writes outside the vault and deleting it removes only database state;
- every mutation service rejects an external path, including bulk and failure paths;
- cancellation preserves completed entries and resume continues pending entries;
- restart reconciliation is deterministic for partial, final, missing, and ambiguous paths;
- analysis starts only after readiness, runs one file at a time per volume, persists incrementally, and does not block asset availability;
- context-menu materialization and project adoption copy external sources without modifying them;
- vault migration/deletion never rewrites or purges external sources;
- ZIP, H4, multitrack, sample-pack profiles, exclusions, conflicts, stale previews, and forced file types retain their existing semantics;
- a synthetic hundreds-of-gigabytes manifest reports fractional byte progress, throughput, and ETA without performing real huge-file I/O;
- the GAIA UI at port 8001 exposes the three-option selector, three progress stages, pending/missing badges, resume/retry/discard actions, and clear external-source safety copy.
