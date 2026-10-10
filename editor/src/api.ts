import { runtimeLog } from './runtimeLog.ts';

export interface LibraryFile {
    id?: number | string;
    absolute_path: string;
    name: string;
    title?: string;
    filename?: string;
    type?: string;
    key?: string | null;
    bpm?: number | null;
    tags?: any[];
    vault_id?: number | string;
    stream_url?: string;
    duration_seconds?: number | null;
    collection_id?: number | string;
    content_index?: number;
    contents?: LibraryFile[];
    folder?: string | null;
    is_external?: boolean;
    reference_id?: number | string;
    favourite?: boolean;
    stems?: any[];
    is_valid_length?: boolean;
    length_variance?: number;
}

export interface LibraryBpmUpdateResult {
    status: string;
    bpm: number;
    updated: boolean;
}

export type LibraryMetadataProposalField = 'key' | 'bpm' | 'favourite';

export interface LibraryMetadataProposal {
    id: number;
    asset_ref: string;
    absolute_path: string;
    field: LibraryMetadataProposalField;
    proposed_value: string | number | boolean;
    previous_value?: string | number | boolean | null;
    source_node_id?: number | null;
    status: 'pending' | 'accepted' | 'rejected';
    created_at: string;
    updated_at: string;
    resolved_at?: string | null;
}

export async function submitLibraryMetadataProposal(input: {
    filepath: string;
    fileId?: number | string | null;
    field: LibraryMetadataProposalField;
    value: string | number | boolean;
    previousValue?: string | number | boolean | null;
    sourceNodeId?: number | null;
}): Promise<LibraryMetadataProposal> {
    const files = await resolveLibraryAssets([{
        id: input.fileId,
        absolute_path: input.filepath,
    }]);
    const libraryFile = findLibraryFileForSnapshot(files, input.filepath, input.fileId);
    const response = await fetch('/api/library/metadata-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filepath: libraryFile?.absolute_path || input.filepath,
            file_id: libraryFile?.id ?? input.fileId,
            field: input.field,
            value: input.value,
            previous_value: input.previousValue,
            source_node_id: input.sourceNodeId,
        }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.detail || `Could not stage the GAIA proposal (${response.status})`);
    }
    window.dispatchEvent(new CustomEvent('library-metadata-proposed', { detail: result }));
    return result as LibraryMetadataProposal;
}

const libraryCache = new Map<string, LibraryFile[]>();
const pendingLibraryRequests = new Map<string, Promise<LibraryFile[]>>();

function libraryCacheKey(vaultId: number | null): string {
    return vaultId === null ? 'all' : `vault:${vaultId}`;
}

export function clearLibraryCache(): void {
    libraryCache.clear();
}

export async function fetchLibrary(forceRefresh = false, allVaults = false): Promise<LibraryFile[]> {
    const storedVault = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('sin.selectedVaultId')) : NaN;
    const vaultId = !allVaults && Number.isFinite(storedVault) && storedVault > 0 ? storedVault : null;
    const cacheKey = libraryCacheKey(vaultId);
    const cached = libraryCache.get(cacheKey);
    if (!forceRefresh && cached) {
        runtimeLog(`GAIA library cache hit: ${cacheKey} (${cached.length} root records)`, 'debug');
        return cached;
    }

    const pending = pendingLibraryRequests.get(cacheKey);
    if (pending) {
        runtimeLog(`GAIA library request joined: ${cacheKey}`, 'debug');
        return pending;
    }

    const request = (async () => {
      try {
        const suffix = vaultId === null ? '' : `?vault_id=${vaultId}`;
        const response = await fetch(`/api/library${suffix}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch library: ${response.statusText}`);
        }
        
        const data = await response.json();
        const files = (data.files || []) as LibraryFile[];
        libraryCache.set(cacheKey, files);
        runtimeLog(`GAIA library loaded: ${cacheKey} (${files.length} root records)`, 'debug');
        return files;
      } catch (err) {
        console.error("Error fetching library:", err);
        runtimeLog(`GAIA library load failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return [];
      } finally {
        pendingLibraryRequests.delete(cacheKey);
      }
    })();
    pendingLibraryRequests.set(cacheKey, request);
    return request;
}

/** Resolve only the GAIA records referenced by the graph instead of loading every vault. */
export async function resolveLibraryAssets(references: any[]): Promise<LibraryFile[]> {
    const unique = new Map<string, { id?: number | string; absolute_path?: string }>();
    for (const reference of references || []) {
        if (!reference) continue;
        const id = reference.id ?? reference.library_item_id;
        const absolutePath = String(
            reference.absolute_path || reference.filepath || reference.path || ''
        ).trim();
        if (id == null && !absolutePath) continue;
        const key = id != null ? `id:${String(id)}` : `path:${normalizeAssetPath(absolutePath)}`;
        if (!unique.has(key)) {
            unique.set(key, {
                ...(id != null ? { id } : {}),
                ...(absolutePath ? { absolute_path: absolutePath } : {})
            });
        }
    }
    if (unique.size === 0) return [];

    const response = await fetch('/api/library/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ references: [...unique.values()] })
    });
    const data = await response.json().catch(() => ({}));
    // A stale API process can continue serving newly-built frontend files. Keep
    // existing sessions functional while making the version mismatch visible.
    if (response.status === 404 || response.status === 405) {
        runtimeLog(
            `Exact GAIA resolver unavailable (${response.status}); using compatibility library load. Restart the SIN server to restore the fast path.`,
            'warning'
        );
        return fetchLibrary(true, true);
    }
    if (!response.ok) {
        throw new Error(data.detail || `Could not resolve GAIA assets (${response.status})`);
    }
    const diagnostics = data.diagnostics || {};
    runtimeLog(
        `GAIA DB resolve: ${diagnostics.request_count ?? unique.size} references -> ${diagnostics.resolved_count ?? (data.files || []).length} records, ${diagnostics.query_count ?? 1} query (${diagnostics.duration_ms ?? '?'} ms)`,
        'debug'
    );
    if (Array.isArray(data.missing) && data.missing.length > 0) {
        const labels = data.missing.map((item: any) => item?.id ?? item?.absolute_path ?? 'invalid reference');
        runtimeLog(`GAIA references unavailable: ${labels.join(', ')}`, 'warning');
    }
    return (data.files || []) as LibraryFile[];
}

function normalizeAssetPath(filepath: string): string {
    return filepath.replace(/\\/g, '/').toLocaleLowerCase();
}

function visitLibraryFiles(files: LibraryFile[], visitor: (file: LibraryFile) => boolean): LibraryFile | undefined {
    for (const file of files) {
        if (visitor(file)) return file;
        if (Array.isArray(file.contents)) {
            const nested = visitLibraryFiles(file.contents, visitor);
            if (nested) return nested;
        }
    }
    return undefined;
}

export function findLibraryFile(files: LibraryFile[], filepath: string): LibraryFile | undefined {
    const target = normalizeAssetPath(filepath);
    return visitLibraryFiles(files, file => normalizeAssetPath(file.absolute_path || '') === target);
}

export function findLibraryFileById(files: LibraryFile[], id: number | string | null | undefined): LibraryFile | undefined {
    if (id == null) return undefined;
    return visitLibraryFiles(files, file => String(file.id) === String(id));
}

/**
 * Resolve a serialized asset reference without allowing a stale collection
 * manifest index to replace the file that was actually saved in the preset.
 */
export function findLibraryFileForSnapshot(
    files: LibraryFile[],
    filepath: string,
    id?: number | string | null
): LibraryFile | undefined {
    const byPath = filepath ? findLibraryFile(files, filepath) : undefined;
    if (byPath) return byPath;

    // IDs for collection contents encode their manifest index. That index is
    // not stable when GAIA rebuilds a manifest, so it is unsafe as a fallback.
    if (String(id ?? '').startsWith('collection:')) return undefined;
    return findLibraryFileById(files, id);
}

/** Resolve an exact pool key against GAIA's current library state. */
export function findLibraryFileForPoolLocator(files: LibraryFile[], asset: any): LibraryFile | undefined {
    if (!asset) return undefined;
    if (asset.id != null && String(asset.id).trim()) {
        return findLibraryFileById(files, asset.id);
    }
    return undefined;
}

/** Replace metadata persisted in a preset/pool with GAIA's current asset record. */
export function refreshLibraryAssetSnapshot(asset: any, files: LibraryFile[]): LibraryFile | undefined {
    if (!asset) return undefined;
    const current = findLibraryFileForPoolLocator(files, asset);
    if (!current) return undefined;

    if (current.id != null) asset.id = current.id;
    if (current.absolute_path) {
        asset.absolute_path = current.absolute_path;
        asset.filepath = current.absolute_path;
    }
    asset.name = current.name || (current as any).filename || asset.name;
    asset.type = current.type || asset.type;
    asset.key = current.key ?? null;
    asset.bpm = current.bpm ?? null;
    asset.original_bpm = current.bpm ?? null;
    asset.duration_seconds = current.duration_seconds ?? null;
    if (current.tags !== undefined) asset.tags = current.tags;
    if (current.vault_id !== undefined) asset.vault_id = current.vault_id;
    if (current.collection_id !== undefined) asset.collection_id = current.collection_id;
    return current;
}

export async function updateLibraryBpm(
    filepath: string,
    bpm: number,
    fileId?: number | string | null
): Promise<LibraryMetadataProposal> {
    // Compatibility helper for older call sites. Its name is retained, but it
    // no longer performs a GAIA library write from SIN.
    return submitLibraryMetadataProposal({
        filepath,
        fileId,
        field: 'bpm',
        value: bpm,
    });
}
