# GAIA Library Manager Optimization Plan

## Purpose

Make GAIA feel immediate during startup, navigation, filtering, selection, metadata editing, collection expansion, imports, analysis, moves, and project actions.

This plan covers the complete optimization space. Work is divided into:

- **Now** — highest impact, relatively contained changes to execute first.
- **Next** — useful improvements after the first optimization pass is measured.
- **Future** — complex, invasive, or lower-value improvements that should not delay the primary work.

GAIA remains the sole library manager. SIN/IRIDE remains a read-only consumer of GAIA assets.

## Baseline diagnosis

The current implementation combines three expensive behaviors:

1. The initial load requests the full library with `limit=10000`.
2. Collection responses hydrate all children, manifests, and child tags even when collections are collapsed.
3. Many mutations call `loadLibrary()`, causing the same complete fetch and DOM rebuild again.

The current local database contains approximately:

- 4,390 item rows.
- 4,307 child rows.
- 83 root rows.
- Six large collections containing roughly 761–1,269 entries each.
- Collection manifests totaling approximately 1.58 MB before response and serialization overhead.

The main code paths are:

- Frontend library loading: `gaia/static/app.js`, `loadLibrary()`.
- Frontend full rendering: `gaia/static/app.js`, `renderAssets()` and `renderFilterUI()`.
- Backend list loading: `gaia/crud.py`, `get_items()`.
- Backend collection hydration: `gaia/crud.py`, `_populate_item_fields()`.
- Collection content mutation: `gaia/routers/items.py`, `update_collection_content()`.
- Managed path rewriting during moves: `gaia/vaults.py`, `rewrite_managed_paths()`.

## Performance goals

These targets are for the current library size and should be measured on representative cold and warm runs:

- Show the existing library view immediately on refresh; never blank the list while revalidating.
- Initial root-library response: under 500 ms server time and under 1 MB compressed where practical.
- No collection contents in the root-list response unless explicitly requested.
- Selection, deselection, and ordinary filtering: under 50 ms of main-thread work for the normal view.
- Metadata edits: update the affected row without a full-library request.
- Collection expansion: first visible page under 300 ms after the request completes.
- No duplicate concurrent library loads.
- Batch analysis progress should not repeatedly process the same update.
- Preserve existing GAIA ownership, vault paths, project relationships, and asset types.

Targets are directional until instrumentation establishes real baselines. Do not optimize against guessed numbers alone.

## Work status

### Now: highest-impact execution scope

The following items are the initial implementation scope.

#### 1. Add measurement before changing behavior

- Add server timing for library and mutation endpoints.
- Record database query count and total SQL time per request in development mode.
- Record response size and serialized payload size.
- Add frontend `performance.mark()` measurements for:
  - vault/type/item request time;
  - JSON parsing time;
  - normalization/facet computation;
  - DOM render time;
  - collection expansion time.
- Add a small repeatable benchmark using the existing database and a representative large collection.
- Capture cold-load, warm-load, refresh, metadata edit, collection expansion, move, import completion, and batch-analysis completion.

Deliverable: a before/after performance table committed with the implementation changes.

#### 2. Split root summaries from collection contents

Introduce a compact list contract for the main library view. The root response should contain only fields needed for collapsed rows and filtering:

- id, title, type, absolute path or display path;
- vault id;
- size and timestamps;
- root-level tags;
- profile/display metadata;
- content count and a boolean indicating contents are available;
- lightweight project/reference indicators where needed.

Do not include full `contents` arrays or child tag data in the root-list response.

Add a dedicated contents endpoint with:

- collection id;
- offset/cursor and limit;
- stable ordering;
- optional search/type/tag filters;
- compact `CollectionContent` fields;
- a total or `has_more` indicator.

Keep the existing endpoint temporarily for compatibility if required, but move the GAIA UI to the new compact contract first.

#### 3. Lazy-load and cache expanded collections

- Fetch collection contents only on first expansion.
- Cache contents by collection id and query/filter key.
- Show a collection-local loading state without replacing the whole library.
- Invalidate only the affected collection after a content mutation, placement, or project-link change.
- Preserve expansion state across refreshes and mutations.
- Load only the first page initially; fetch more on scroll or an explicit “load more” action.

The first page should be sufficient to make expansion feel immediate. Do not render thousands of nested rows at once.

#### 4. Replace full post-action reloads with targeted state updates

Audit every `await loadLibrary()` after a mutation. Replace it with one of:

- patch one item in local state;
- patch one content row in a cached collection;
- update a collection count and invalidate only that collection;
- merge newly imported root items from the completed job;
- remove deleted items from local state;
- refresh only the source and destination roots after a move.

Affected flows include:

- move to vault;
- place/reference items in a collection or project;
- create project;
- add project files;
- import completion;
- batch-analysis completion;
- adopt orphan assets.

The backend should return a compact mutation result containing changed ids, changed root ids, and changed collection ids. Full `schemas.Item` responses should not be required for every mutation.

#### 5. Make loading resilient and non-blocking

- Do not clear `assetList` at the beginning of every load.
- Keep stale content visible while a refresh runs.
- Add a subtle updating state to the toolbar/status area.
- Disable or coalesce duplicate refresh actions.
- Add an `AbortController` and latest-request-wins behavior.
- Ignore stale responses that finish after a newer request.
- Load vaults, type definitions, and the first library snapshot in parallel where dependencies do not require ordering.
- Cache type definitions for the session.
- Cache vaults and update the cache from create/rename/delete responses.

#### 6. Remove backend N+1 collection hydration

Refactor `_populate_item_fields()` so list endpoints do not cause one lazy query per child/tag.

Preferred approach:

- use explicit eager loading for the small set of root records;
- bulk-load children for all requested roots;
- bulk-load item tags for all returned child ids;
- build response DTOs without mutating ORM objects;
- avoid parsing the same manifest more than once per request;
- do not hydrate children at all for the compact root-list endpoint.

For single-item and contents endpoints, make the loading behavior explicit rather than relying on default relationship loading.

#### 7. Add and verify database indexes

Create a migration, not only a model declaration, for the indexes needed by actual queries:

- `items(parent_id)`;
- `items(vault_id, parent_id)`;
- `items(vault_id, type)`;
- `items(updated_at)` if used for synchronization;
- `item_tags(item_id)`;
- `item_tags(tag_id)`;
- `vault_import_logs(vault_id, created_at)`;
- any compound index used by server-side filtering.

Run `EXPLAIN QUERY PLAN` for the root list, vault-filtered list, collection contents, and tag-filter queries. Confirm the indexes exist in the current database, not only in fresh installations.

#### 8. Render only what changed in the frontend

- Preserve keyed row elements by item/content id.
- Update selection classes and ARIA state in place.
- Update only the edited cell after a successful metadata patch.
- Use `DocumentFragment` for genuinely new rows.
- Avoid calling `allEntries()`, `collectionContentEntries()`, and facet computation multiple times per render.
- Build a normalized, memoized view model and invalidate it only when source state or filters change.
- Combine filter UI and asset-list rendering into one scheduled render pass.
- Use `requestAnimationFrame` to coalesce multiple synchronous state changes.

#### 9. Debounce and optimize local filtering

- Debounce search input by approximately 150–250 ms.
- Normalize titles, paths, types, and tags once when data enters state.
- Cache tokenized search text per entry.
- Compute facets from the normalized cache instead of rebuilding temporary entry objects.
- Keep filtering local for the currently loaded data, but request server-side results when the library exceeds the practical client threshold.

#### 10. Fix batch-analysis update delivery

The current polling response exposes the full accumulated update list. Replace this with one of:

- a monotonically increasing update sequence and `after=` cursor;
- a bounded queue acknowledged by the client;
- Server-Sent Events;
- WebSocket updates if a broader real-time channel is later required.

For the initial implementation, use an update cursor and poll less aggressively, for example every 500–1,000 ms. Apply only new updates and coalesce rendering.

Do not perform a full `loadLibrary()` when analysis completes if all changed rows are already available locally.

#### 11. Optimize single content updates

`update_collection_content()` currently reloads and repopulates the parent collection after updating one child. Change it to:

- load the target content and child only;
- update the canonical child row and/or one manifest entry;
- return the changed content row;
- update derived collection metadata only when necessary;
- avoid rebuilding every sibling content entry.

Preserve transaction safety and keep the manifest/child-row synchronization rules explicit.

#### 12. Add bulk mutation endpoints

Replace sequential frontend requests with transactional batch APIs for:

- deleting multiple assets;
- applying the same metadata change to multiple samples;
- moving multiple assets;
- adding multiple items to a project or collection.

Return per-item success/failure details and a compact state delta. Filesystem cleanup may remain a background task, but the database transaction and visible UI state should complete promptly.

## Next: useful follow-up work

These should follow the initial optimization pass and its measurements.

### Server-side filtering and pagination

- Add query parameters for vault, type, tags, search text, sort, cursor, and page size.
- Push filtering to SQL for large libraries.
- Return facet counts from the server.
- Use stable cursor pagination rather than large offsets for very large libraries.
- Add a lightweight endpoint for “recently changed” items used after mutations.

### Incremental synchronization

- Add a library revision or change token.
- Return `ETag`/`Last-Modified` headers for stable summaries.
- Support conditional requests and `304 Not Modified`.
- Add a changes-since endpoint for affected ids and collection ids.
- Use the change token after import, move, analysis, or project mutations.

### Collection rendering improvements

- Render collection rows in pages or windows.
- Preserve scroll position when adding a page.
- Add a row-count-aware empty/loading/error state.
- Add incremental search inside an expanded collection.
- Preload the first content page on pointer hover only if measurement shows a benefit.

### Project/reference query optimization

`project_table()` currently resolves referenced items and versions individually. Refactor it to:

- fetch references in one query;
- fetch all referenced items in one query;
- eager-load tags for those items;
- build version groups in memory;
- return the compact project-table DTO.

Also invalidate only the affected project cache after a reference mutation.

### Move-path optimization

`rewrite_managed_paths()` currently scans all items, manifests, multitrack stems, and import logs. Improve it by:

- identifying affected roots and descendants first;
- updating only rows whose paths are inside the moved roots;
- rewriting only affected manifests and stems;
- using SQL prefix updates where safe;
- keeping a recoverable operation journal for rollback.

Do not weaken path ownership or vault-boundary validation.

### Caching and response compression

- Enable Brotli or gzip for JSON responses.
- Cache immutable type definitions.
- Cache compact root summaries for the session.
- Use short-lived server caching for facets if the library changes infrequently.
- Avoid caching mutation-sensitive content without a revision key.

## Future: complex or lower-priority upgrades

These are intentionally deferred until the previous phases are measured and stable.

### Full virtualized list/grid renderer

Render only visible rows using a virtual scrolling system. This is valuable for extremely large collections but introduces complexity around variable row heights, nested collections, drag-and-drop, keyboard navigation, selection ranges, and accessibility.

### Web Worker search and facet index

Move client-side normalization, tokenization, search, and facet calculation into a Web Worker backed by an in-memory index. This is useful only after server-side filtering and memoization have been measured insufficient.

### IndexedDB/offline library cache

Persist summaries, collection pages, and revision tokens locally to make GAIA usable across reloads or intermittent connections. Requires cache invalidation, schema versioning, storage limits, and careful handling of stale mutations.

### SSE/WebSocket real-time updates

Provide push updates for imports, analysis, filesystem changes, and possible multi-window synchronization. This is more complex than the initial update-cursor approach and should be justified by actual usage.

### Filesystem watcher and automatic change reconciliation

Watch managed vaults for external changes and reconcile them into GAIA jobs. This has substantial correctness and safety implications, particularly around partial writes, renames, deleted files, and vault ownership. It must not silently change library ownership.

### Materialized read models

Create a dedicated read projection for root summaries, facets, collection counts, and synchronization tokens. Update it transactionally or through a reliable background projection worker. This can provide very fast reads at larger scale but adds consistency and migration complexity.

### Dedicated search index

Use SQLite FTS or another search index for titles, paths, tags, profiles, and project metadata. Consider only when SQL filtering and normalized in-memory filtering no longer meet targets.

### Background read-model rebuilds

Add a rebuild command/job for repairing summary projections, facet caches, or denormalized search indexes after migrations or interrupted jobs.

### Advanced optimistic UI and undo

- Apply local mutation immediately.
- Show a pending state.
- Reconcile success or rollback failure.
- Add an undo queue for deletes, moves, and metadata changes.

This improves perceived responsiveness but requires robust operation journaling and conflict handling.

### Multi-user or multi-window conflict handling

Add revision numbers, conditional updates, conflict responses, and UI reconciliation. This is not required for the current single-user local application and should remain future work.

## Recommended execution sequence

1. Instrument existing load, render, and mutation paths.
2. Add verified database indexes and remove obvious N+1 hydration.
3. Introduce compact root summaries and lazy collection contents.
4. Add loading deduplication, stale-while-revalidate behavior, and cached type/vault state.
5. Replace post-action full reloads with targeted deltas.
6. Optimize normalized frontend state, render scheduling, and search debounce.
7. Fix collection content updates and batch mutations.
8. Replace batch-analysis repeated polling with cursor-based updates.
9. Measure again against the baseline and fix regressions.
10. Only then evaluate server-side filtering, virtualization, synchronization tokens, and advanced caching.

## Verification checklist

### Correctness

- Root summaries preserve all current visible library fields.
- Expanding a collection returns the same content ordering and metadata as today.
- Tags, types, profiles, projects, references, revisions, and masters remain correct.
- Vault ownership and managed paths remain unchanged.
- Move, delete, import, analysis, and project operations remain transactional.
- Stale or out-of-order responses cannot overwrite newer UI state.
- Existing API consumers remain compatible or are migrated deliberately.

### Performance

- Cold start and warm start timings are recorded.
- Root-list payload and compressed payload sizes are recorded.
- SQL query count and SQL time are recorded.
- Collection expansion timing is recorded for small and large collections.
- Selection and search main-thread timings are recorded.
- Mutation latency is measured independently from background filesystem cleanup.
- Batch analysis no longer causes repeated full renders or duplicate update application.

### Regression coverage

Add or update tests for:

- compact root list responses;
- lazy/paginated collection contents;
- root and child tag filtering;
- targeted state deltas after mutations;
- concurrent load cancellation and stale-response rejection;
- content update without sibling hydration;
- bulk delete/move semantics;
- analysis update cursors;
- project/reference table batching;
- index creation on an existing database;
- import completion without a full-library reload.

## Definition of done for the first execution pass

The first pass is complete when:

- GAIA opens with root summaries and no unnecessary child hydration.
- Expanding a collection loads only that collection and only the first page.
- Selection, search, and metadata edits do not issue full-library requests.
- Move, project, import, and analysis actions update only affected state.
- Refresh keeps the existing view visible while data is revalidated.
- No duplicate concurrent `loadLibrary()`-equivalent requests occur.
- Measurements show a material improvement over the baseline without functional regressions.

