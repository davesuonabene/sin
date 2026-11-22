/**
 * Local-First GAIA Catalog Store (Option B + A Hybrid)
 *
 * Shared by GAIA Manager (:8001) and SIN Editor (:8000).
 * - Hydrates instantly from IndexedDB (~15 ms on warm reload)
 * - Syncs compact columnar snapshots (~400 KB gzipped) & incremental deltas (< 1 ms)
 * - Subscribes to live SSE revision ticks (/catalog/events)
 * - Executes all folder expands, vault switches, faceting, and full-text search in < 2 ms in RAM
 */

const IDB_NAME = 'gaia_catalog_cache_v1';
const IDB_STORE = 'snapshots';
const SCHEMA_VERSION = 'gaia-catalog-v1';
const CONTAINER_TYPES = new Set(['folder', 'collection', 'project']);

function openCacheDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function idbGet(key) {
    const db = await openCacheDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function idbPut(key, value) {
    const db = await openCacheDb();
    if (!db) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}

function basenameOf(absPath) {
    if (!absPath) return '';
    const cleaned = String(absPath).replace(/[\\/]+$/, '');
    const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
    return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function normalizePathForCompare(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function computeRelativePath(parentPath, childPath, fallbackFolder, fallbackFilename) {
    if (parentPath && childPath) {
        const normParent = normalizePathForCompare(parentPath);
        const rawChild = String(childPath).replace(/\\/g, '/');
        const normChild = rawChild.toLowerCase();
        if (normParent && normChild.startsWith(normParent + '/')) {
            return rawChild.slice(normParent.length + 1);
        }
    }
    if (fallbackFolder) {
        return `${String(fallbackFolder).replace(/^\/+|\/+$/g, '')}/${fallbackFilename}`;
    }
    return fallbackFilename;
}

const NATURAL_COLLATOR = typeof Intl !== 'undefined' && Intl.Collator
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    : null;

function naturalCompare(a, b) {
    const sa = String(a || '');
    const sb = String(b || '');
    return NATURAL_COLLATOR ? NATURAL_COLLATOR.compare(sa, sb) : sa.localeCompare(sb);
}

function unpackRow(row, tagsMap) {
    // Positional slots match gaia/catalog.py SNAPSHOT_COLUMNS
    const id = Number(row[0]);
    const vaultId = Number(row[1]);
    const parentId = row[2] === null || row[2] === undefined ? null : Number(row[2]);
    const type = row[3] || 'item';
    const absPath = row[5] || '';
    const fname = basenameOf(absPath);
    const title = row[4] || fname;
    const sizeBytes = row[6] ?? null;
    const mimeType = row[7] ?? null;
    const storageMode = row[8] || 'managed';
    const availability = row[9] || 'ready';
    const updatedAt = row[10] ?? null;
    const bpm = row[11] ?? null;
    const key = row[12] ?? null;
    const isLoop = row[13] ?? null;
    const favourite = Boolean(row[14]);
    const durationSeconds = row[15] ?? null;
    const sourceKind = row[16] ?? null;
    const sourcePath = row[17] ?? null;
    const projectKind = row[18] ?? null;
    const editorEngine = row[19] ?? null;
    const contentCount = row[20] ?? null;
    const tagIds = Array.isArray(row[21]) ? row[21] : [];
    const audioMeta = row[22] && typeof row[22] === 'object' ? row[22] : null;
    const extra = row[23] && typeof row[23] === 'object' ? row[23] : null;

    const tags = tagIds.length
        ? tagIds.map((tid) => tagsMap[String(tid)]).filter(Boolean)
        : [];

    const attributes = {};
    if (favourite) attributes.favourite = true;
    if (extra?.is_folder) attributes.is_folder = true;
    if (extra?.folder) attributes.folder = extra.folder;
    if (extra?.profile_id) attributes.profile_id = extra.profile_id;
    if (audioMeta) attributes.audio_metadata = audioMeta;
    if (bpm !== null || key !== null || isLoop !== null || durationSeconds !== null) {
        attributes.analysis = {
            ...(bpm !== null ? { bpm } : {}),
            ...(key !== null ? { key } : {}),
            ...(isLoop !== null ? { is_loop: isLoop } : {}),
            ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
        };
    }

    const item = {
        id,
        vault_id: vaultId,
        parent_id: parentId,
        type,
        title,
        name: title,
        filename: fname,
        absolute_path: absPath,
        size_bytes: sizeBytes,
        mime_type: mimeType,
        storage_mode: storageMode,
        availability,
        updated_at: updatedAt,
        bpm,
        key,
        is_loop: isLoop,
        favourite,
        duration_seconds: durationSeconds,
        source_kind: sourceKind,
        source_path: sourcePath,
        project_kind: projectKind,
        editor_engine: editorEngine,
        content_count: contentCount,
        tags,
        author: audioMeta?.author ?? null,
        album: audioMeta?.album ?? null,
        album_artist: audioMeta?.album_artist ?? null,
        release_year: audioMeta?.release_year ?? null,
        genre: audioMeta?.genre ?? null,
        track_number: audioMeta?.track_number ?? null,
        disc_number: audioMeta?.disc_number ?? null,
        comment: audioMeta?.comment ?? null,
        audio_metadata: audioMeta || {},
        attributes,
        content_types: [],
        content_tags: [],
        stems: extra?.stems || undefined,
        is_valid_length: extra?.is_valid_length,
        length_variance: extra?.length_variance,
        streamable: type === 'audio' || type === 'track' || type === 'sample' || type === 'video',
        _search: '',
    };
    item._search = buildSearchBlob(item);
    return item;
}

function buildSearchBlob(item) {
    const parts = [
        item.title,
        item.filename,
        item.absolute_path,
        item.type,
        item.key,
        item.bpm != null ? String(item.bpm) : '',
        item.author,
        item.album,
        item.album_artist,
        item.genre,
        item.source_path,
        item.attributes?.folder,
        ...(item.tags || []),
    ];
    return parts.filter(Boolean).join(' ').toLowerCase();
}

export class GaiaCatalogStore {
    constructor({ apiBase = '', cacheKey = 'default' } = {}) {
        this.apiBase = String(apiBase || '').replace(/\/+$/, '');
        this.cacheKey = `${this.apiBase || 'same-origin'}:${cacheKey}`;

        this.rev = 0;
        this.ready = false;
        this.columns = [];
        this.tagsMap = {};
        this.vaults = [];
        this.vaultsById = new Map();
        this.playlists = [];
        this.playlistsById = new Map();
        this.types = [];

        // Raw packed rows kept for fast IndexedDB serialization
        this._rawRowsById = new Map();
        // Hydrated in-memory indexes
        this.itemsById = new Map();
        this.childrenByParent = new Map();
        this.rootsByVault = new Map();
        this.allRoots = [];

        this._syncPromise = null;
        this._eventSource = null;
        this._sseReconnectTimer = null;
        this._listeners = new Set();
        this._persistTimer = null;
    }

    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit(detail) {
        for (const cb of this._listeners) {
            try { cb(detail); } catch (err) { console.error('[GaiaCatalogStore] listener error', err); }
        }
    }

    async boot({ connectEvents = true } = {}) {
        // 1. Instant warm hydrate from IndexedDB (< 20ms)
        const cached = await idbGet(this.cacheKey);
        if (cached && cached.schema === SCHEMA_VERSION && Array.isArray(cached.rows)) {
            this._loadSnapshotData(cached, { persist: false });
            this._emit({ source: 'idb', rev: this.rev, changedProjectIds: [] });
        }

        // 2. Network delta or full snapshot sync
        try {
            await this.sync({ forceSnapshot: !this.ready });
        } catch (err) {
            if (!this.ready) throw err;
            console.warn('[GaiaCatalogStore] background sync failed, using cached snapshot:', err);
        }

        // 3. Live SSE revision notifications
        if (connectEvents) {
            this.connectEvents();
        }
        return this;
    }

    connectEvents() {
        if (typeof EventSource === 'undefined' || this._eventSource) return;
        const url = `${this.apiBase}/catalog/events`;
        try {
            const es = new EventSource(url);
            this._eventSource = es;
            es.addEventListener('rev', (event) => {
                try {
                    const data = JSON.parse(event.data || '{}');
                    const serverRev = Number(data.rev || 0);
                    if (serverRev > this.rev) {
                        void this.sync({ forceSnapshot: false });
                    }
                } catch {
                    // Ignore malformed event
                }
            });
            es.onerror = () => {
                // EventSource auto-reconnects; if closed, schedule a gentle fallback reconnect
                if (es.readyState === EventSource.CLOSED) {
                    this._eventSource = null;
                    if (!this._sseReconnectTimer) {
                        this._sseReconnectTimer = setTimeout(() => {
                            this._sseReconnectTimer = null;
                            this.connectEvents();
                        }, 3000);
                    }
                }
            };
        } catch {
            // EventSource unavailable in environment
        }
    }

    disconnectEvents() {
        if (this._sseReconnectTimer) {
            clearTimeout(this._sseReconnectTimer);
            this._sseReconnectTimer = null;
        }
        if (this._eventSource) {
            this._eventSource.close();
            this._eventSource = null;
        }
    }

    async sync({ forceSnapshot = false } = {}) {
        if (this._syncPromise) {
            if (!forceSnapshot) return this._syncPromise;
            try { await this._syncPromise; } catch { /* proceed */ }
        }

        const task = (async () => {
            if (!forceSnapshot && this.ready && this.rev > 0) {
                const resp = await fetch(`${this.apiBase}/catalog/delta?since_rev=${encodeURIComponent(this.rev)}`);
                if (!resp.ok) throw new Error(`Catalog delta failed (${resp.status})`);
                const delta = await resp.json();
                if (!delta.full_reload) {
                    const changed = this._applyDelta(delta);
                    if (changed) {
                        this._schedulePersist();
                        this._emit({
                            source: 'delta',
                            rev: this.rev,
                            changedProjectIds: delta.changed_project_ids || [],
                            vaultsChanged: Boolean(delta.vaults),
                            playlistsChanged: Boolean(delta.playlists),
                        });
                    }
                    return { rev: this.rev, source: 'delta', changed };
                }
            }

            const headers = {};
            if (!forceSnapshot && this.rev > 0) {
                headers['If-None-Match'] = `"rev-${this.rev}"`;
            }
            const resp = await fetch(`${this.apiBase}/catalog/snapshot`, { headers });
            if (resp.status === 304) {
                return { rev: this.rev, source: 'not-modified', changed: false };
            }
            if (!resp.ok) throw new Error(`Catalog snapshot failed (${resp.status})`);
            const snapshot = await resp.json();
            this._loadSnapshotData(snapshot, { persist: true });
            this._emit({
                source: 'snapshot',
                rev: this.rev,
                changedProjectIds: [],
                vaultsChanged: true,
                playlistsChanged: true,
            });
            return { rev: this.rev, source: 'snapshot', changed: true };
        })();

        this._syncPromise = task;
        try {
            return await task;
        } finally {
            if (this._syncPromise === task) this._syncPromise = null;
        }
    }

    _loadSnapshotData(snapshot, { persist = true } = {}) {
        this.rev = Number(snapshot.rev || 1);
        this.columns = snapshot.columns || [];
        this.tagsMap = snapshot.tags || {};
        this._setVaults(snapshot.vaults || []);
        this._setPlaylists(snapshot.playlists || []);
        this.types = Array.isArray(snapshot.types) ? snapshot.types : [];

        this._rawRowsById.clear();
        this.itemsById.clear();
        const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
        for (let i = 0; i < rows.length; i++) {
            const raw = rows[i];
            const item = unpackRow(raw, this.tagsMap);
            this._rawRowsById.set(item.id, raw);
            this.itemsById.set(item.id, item);
        }

        this._rebuildIndexes();
        this.ready = true;
        if (persist) this._schedulePersist();
    }

    _applyDelta(delta) {
        const nextRev = Number(delta.rev || this.rev);
        const upserted = Array.isArray(delta.upserted) ? delta.upserted : [];
        const deletedIds = Array.isArray(delta.deleted_ids) ? delta.deleted_ids : [];
        const changedProjects = Array.isArray(delta.changed_project_ids) ? delta.changed_project_ids : [];

        if (
            nextRev === this.rev
            && !upserted.length
            && !deletedIds.length
            && !delta.vaults
            && !delta.playlists
            && !changedProjects.length
        ) {
            return false;
        }

        this.rev = nextRev;
        if (delta.tags && typeof delta.tags === 'object') {
            this.tagsMap = delta.tags;
        }
        if (Array.isArray(delta.vaults)) {
            this._setVaults(delta.vaults);
        }
        if (Array.isArray(delta.playlists)) {
            this._setPlaylists(delta.playlists);
        }

        // Cascade delete descendants of any deleted container
        if (deletedIds.length) {
            const toDelete = new Set(deletedIds.map(Number));
            const queue = [...toDelete];
            while (queue.length) {
                const pid = queue.pop();
                const kids = this.childrenByParent.get(pid);
                if (kids) {
                    for (let i = 0; i < kids.length; i++) {
                        const cid = kids[i].id;
                        if (!toDelete.has(cid)) {
                            toDelete.add(cid);
                            queue.push(cid);
                        }
                    }
                }
            }
            for (const id of toDelete) {
                this._rawRowsById.delete(id);
                this.itemsById.delete(id);
            }
        }

        for (let i = 0; i < upserted.length; i++) {
            const raw = upserted[i];
            const item = unpackRow(raw, this.tagsMap);
            this._rawRowsById.set(item.id, raw);
            this.itemsById.set(item.id, item);
        }

        if (upserted.length || deletedIds.length || delta.tags) {
            this._rebuildIndexes();
        }
        return true;
    }

    /** Instant optimistic local patch before the server SSE delta arrives. */
    patchItemLocal(itemId, updates) {
        const id = Number(itemId);
        const item = this.itemsById.get(id);
        if (!item || !updates) return;
        Object.assign(item, updates);
        if (updates.title) item.name = updates.title;
        if (updates.favourite !== undefined) {
            item.favourite = Boolean(updates.favourite);
            if (!item.attributes) item.attributes = {};
            item.attributes.favourite = item.favourite;
        }
        if (Array.isArray(updates.tags)) {
            item.tags = updates.tags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
        }
        item._search = buildSearchBlob(item);
        // Refresh ancestor facets cheaply if tags/type changed
        if (updates.tags !== undefined || updates.type !== undefined) {
            this._computeDescendantFacets();
        }
    }

    _setVaults(list) {
        this.vaults = list;
        this.vaultsById.clear();
        for (let i = 0; i < list.length; i++) {
            this.vaultsById.set(Number(list[i].id), list[i]);
        }
    }

    _setPlaylists(list) {
        this.playlists = list;
        this.playlistsById.clear();
        for (let i = 0; i < list.length; i++) {
            this.playlistsById.set(Number(list[i].id), list[i]);
        }
    }

    _rebuildIndexes() {
        this.childrenByParent.clear();
        this.rootsByVault.clear();
        this.allRoots = [];

        for (const item of this.itemsById.values()) {
            const pid = item.parent_id;
            if (pid === null) {
                this.allRoots.push(item);
                let vList = this.rootsByVault.get(item.vault_id);
                if (!vList) {
                    vList = [];
                    this.rootsByVault.set(item.vault_id, vList);
                }
                vList.push(item);
            } else {
                let kids = this.childrenByParent.get(pid);
                if (!kids) {
                    kids = [];
                    this.childrenByParent.set(pid, kids);
                }
                kids.push(item);
            }
        }

        const sortFolderFirst = (a, b) => {
            const aFolder = CONTAINER_TYPES.has(a.type) || Boolean(a.attributes?.is_folder);
            const bFolder = CONTAINER_TYPES.has(b.type) || Boolean(b.attributes?.is_folder);
            if (aFolder !== bFolder) return aFolder ? -1 : 1;
            return naturalCompare(a.title, b.title);
        };
        const sortByTitle = (a, b) => naturalCompare(a.title, b.title);

        this.allRoots.sort(sortByTitle);
        for (const list of this.rootsByVault.values()) list.sort(sortByTitle);
        for (const kids of this.childrenByParent.values()) kids.sort(sortFolderFirst);

        this._computeDescendantFacets();
    }

    _computeDescendantFacets() {
        // Memoized single DFS pass over containers (~3 ms for 13k items)
        const computed = new Map();
        const visit = (folderId) => {
            if (computed.has(folderId)) return computed.get(folderId);
            const types = new Set();
            const tags = new Map();
            let leafCount = 0;
            const kids = this.childrenByParent.get(folderId) || [];
            for (let i = 0; i < kids.length; i++) {
                const child = kids[i];
                const isSubFolder = child.type === 'folder' || child.type === 'collection' || Boolean(child.attributes?.is_folder);
                if (isSubFolder) {
                    const sub = visit(child.id);
                    for (const t of sub.types) types.add(t);
                    for (const [k, v] of sub.tags) if (!tags.has(k)) tags.set(k, v);
                    leafCount += sub.leafCount;
                } else {
                    leafCount += 1;
                    if (child.type) types.add(child.type);
                }
                if (child.tags?.length) {
                    for (let j = 0; j < child.tags.length; j++) {
                        const tg = child.tags[j];
                        const key = tg.toLowerCase();
                        if (!tags.has(key)) tags.set(key, tg);
                    }
                }
            }
            const res = { types, tags, leafCount };
            computed.set(folderId, res);
            const folderItem = this.itemsById.get(folderId);
            if (folderItem) {
                folderItem.content_types = Array.from(types).sort();
                folderItem.content_tags = Array.from(tags.values()).sort(naturalCompare);
                if (leafCount > 0 || folderItem.content_count == null) {
                    folderItem.content_count = leafCount;
                }
            }
            return res;
        };

        for (const item of this.itemsById.values()) {
            if (CONTAINER_TYPES.has(item.type) || item.attributes?.is_folder) {
                visit(item.id);
            }
        }
    }

    _schedulePersist() {
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            const snapshot = {
                schema: SCHEMA_VERSION,
                rev: this.rev,
                columns: this.columns,
                tags: this.tagsMap,
                vaults: this.vaults,
                playlists: this.playlists,
                types: this.types,
                rows: Array.from(this._rawRowsById.values()),
            };
            void idbPut(this.cacheKey, snapshot);
        }, 120);
    }

    getItem(itemId) {
        return this.itemsById.get(Number(itemId)) || null;
    }

    getDirectChildren(parentId) {
        return this.childrenByParent.get(Number(parentId)) || [];
    }

    /** Return root items for active vault, 'Show all' (preview === 'quick'), or playlist. */
    getScopedRoots({ vaultId = null, playlistId = null, previewMode = 'quick' } = {}) {
        if (playlistId !== null && playlistId !== undefined) {
            const pl = this.playlistsById.get(Number(playlistId));
            if (!pl || !Array.isArray(pl.item_ids)) return [];
            const out = [];
            for (let i = 0; i < pl.item_ids.length; i++) {
                const it = this.itemsById.get(Number(pl.item_ids[i]));
                if (it) out.push(it);
            }
            return out;
        }
        if (vaultId !== null && vaultId !== undefined) {
            return this.rootsByVault.get(Number(vaultId)) || [];
        }
        if (!previewMode) return this.allRoots;
        const quickVaultIds = new Set();
        for (let i = 0; i < this.vaults.length; i++) {
            if (this.vaults[i].preview === previewMode) {
                quickVaultIds.add(Number(this.vaults[i].id));
            }
        }
        const out = [];
        for (let i = 0; i < this.allRoots.length; i++) {
            if (quickVaultIds.has(this.allRoots[i].vault_id)) {
                out.push(this.allRoots[i]);
            }
        }
        return out;
    }

    /** Collect all descendants of a container with relative paths computed in pure JS (< 1ms). */
    getSubtreeContents(containerId) {
        const container = this.itemsById.get(Number(containerId));
        if (!container) return [];
        const rootPath = container.absolute_path || '';
        const out = [];
        const stack = [...(this.childrenByParent.get(container.id) || [])].reverse();
        let idx = 0;
        while (stack.length) {
            const child = stack.pop();
            const isSub = child.type === 'folder' || child.type === 'collection' || Boolean(child.attributes?.is_folder);
            if (isSub) {
                const grandKids = this.childrenByParent.get(child.id) || [];
                // Push folder itself so empty folders & real FolderItem rows stay addressable
                out.push({
                    ...child,
                    child_id: child.id,
                    index: idx++,
                    relative_path: computeRelativePath(rootPath, child.absolute_path, child.attributes?.folder, child.filename),
                });
                for (let i = grandKids.length - 1; i >= 0; i--) {
                    stack.push(grandKids[i]);
                }
            } else {
                out.push({
                    ...child,
                    child_id: child.id,
                    index: idx++,
                    relative_path: computeRelativePath(rootPath, child.absolute_path, child.attributes?.folder, child.filename),
                });
            }
        }
        return out;
    }

    /** Check if a query (possibly multi-word) matches an item's pre-lowercased search blob. */
    itemMatchesQuery(item, tokens) {
        if (!tokens || !tokens.length) return true;
        const blob = item._search || '';
        for (let i = 0; i < tokens.length; i++) {
            if (!blob.includes(tokens[i])) return false;
        }
        return true;
    }

    /**
     * Evaluate query + facet filters across the active scope in < 2ms.
     * Returns `{ matchingItemIds: Set<number>, matchingBranchIds: Set<number> }`
     * where `matchingBranchIds` includes every ancestor container leading to a match.
     */
    computeFilterMatches({ roots, query = '', selectedTypes = null, selectedTags = null, onlyFavourites = false }) {
        const cleanQuery = String(query || '').trim().toLowerCase();
        const tokens = cleanQuery ? cleanQuery.split(/\s+/).filter(Boolean) : [];
        const hasTypes = Boolean(selectedTypes && selectedTypes.size > 0);
        const hasTags = Boolean(selectedTags && selectedTags.size > 0);
        const normTags = hasTags ? Array.from(selectedTags).map((t) => String(t).toLowerCase()) : null;

        const matchingItemIds = new Set();
        const matchingBranchIds = new Set();

        const matchesSelf = (item) => {
            if (onlyFavourites && !item.favourite) return false;
            if (hasTypes && !selectedTypes.has(item.type)) return false;
            if (normTags) {
                const itemTags = item.tags || [];
                if (!itemTags.length) return false;
                for (let i = 0; i < normTags.length; i++) {
                    const wanted = normTags[i];
                    let found = false;
                    for (let j = 0; j < itemTags.length; j++) {
                        if (itemTags[j].toLowerCase() === wanted) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) return false;
                }
            }
            if (tokens.length && !this.itemMatchesQuery(item, tokens)) return false;
            return true;
        };

        const visit = (item) => {
            const selfHit = matchesSelf(item);
            let childHit = false;
            const kids = this.childrenByParent.get(item.id);
            if (kids && kids.length) {
                for (let i = 0; i < kids.length; i++) {
                    if (visit(kids[i])) childHit = true;
                }
            }
            if (selfHit) matchingItemIds.add(item.id);
            if (selfHit || childHit) {
                matchingBranchIds.add(item.id);
                return true;
            }
            return false;
        };

        for (let i = 0; i < roots.length; i++) {
            visit(roots[i]);
        }

        return { matchingItemIds, matchingBranchIds, hasQuery: tokens.length > 0 };
    }
}

if (typeof window !== 'undefined') {
    window.GaiaCatalogStore = GaiaCatalogStore;
}
