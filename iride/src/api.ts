export interface LibraryFile {
    id?: number | string;
    absolute_path: string;
    name: string;
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
}

export interface LibraryBpmUpdateResult {
    status: string;
    bpm: number;
    updated: boolean;
}

let cachedLibrary: LibraryFile[] | null = null;
let cachedVaultId: number | null = null;
let pendingLibrary: Promise<LibraryFile[]> | null = null;
let pendingVaultId: number | null = null;

export async function fetchLibrary(forceRefresh = false, allVaults = false): Promise<LibraryFile[]> {
    const storedVault = Number(localStorage.getItem('sin.selectedVaultId'));
    const vaultId = !allVaults && Number.isFinite(storedVault) && storedVault > 0 ? storedVault : null;
    if (!forceRefresh && cachedLibrary !== null && cachedVaultId === vaultId) {
        return cachedLibrary;
    }
    if (pendingLibrary !== null && pendingVaultId === vaultId) {
        return pendingLibrary;
    }

    pendingVaultId = vaultId;
    pendingLibrary = (async () => {
      try {
        const suffix = vaultId === null ? '' : `?vault_id=${vaultId}`;
        const response = await fetch(`/api/library${suffix}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch library: ${response.statusText}`);
        }
        
        const data = await response.json();
        cachedLibrary = data.files || [];
        cachedVaultId = vaultId;
        return cachedLibrary as LibraryFile[];
      } catch (err) {
        console.error("Error fetching library:", err);
        return [];
      } finally {
        if (pendingVaultId === vaultId) {
            pendingLibrary = null;
            pendingVaultId = null;
        }
      }
    })();
    return pendingLibrary;
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

function assetBasename(value: string): string {
    return value.replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() || '';
}

/** Resolve a path-free pool locator against GAIA's current library state. */
export function findLibraryFileForPoolLocator(files: LibraryFile[], asset: any): LibraryFile | undefined {
    if (!asset) return undefined;
    const filepath = String(asset.absolute_path || asset.filepath || '');
    if (filepath) {
        const bySnapshot = findLibraryFileForSnapshot(files, filepath, asset.id);
        if (bySnapshot) return bySnapshot;
    }

    const idText = String(asset.id ?? '');
    const directIdMatch = !idText.startsWith('collection:')
        ? findLibraryFileById(files, asset.id)
        : undefined;
    if (directIdMatch && !['collection', 'sample_pack', 'project'].includes(String(directIdMatch.type))) {
        return directIdMatch;
    }
    const collectionId = asset.collection_id ?? (directIdMatch ? asset.id : undefined) ?? (
        idText.startsWith('collection:') ? idText.split(':')[1] : undefined
    );
    const wantedName = assetBasename(String(asset.name || filepath));
    if (!wantedName) return undefined;

    if (collectionId != null) {
        const collection = findLibraryFileById(files, collectionId);
        const scoped = collection?.contents?.find(content =>
            assetBasename(String(content.name || (content as any).filename || content.absolute_path || '')) === wantedName
        );
        if (scoped) return scoped;
    }

    // Name-only locators are supported for legacy presets. Prefer a unique
    // exact basename; ambiguity is safer than silently selecting a wrong file.
    const matches: LibraryFile[] = [];
    const collect = (entries: LibraryFile[]) => {
        for (const entry of entries) {
            if (assetBasename(String(entry.name || (entry as any).filename || entry.absolute_path || '')) === wantedName) {
                matches.push(entry);
            }
            if (entry.contents) collect(entry.contents);
        }
    };
    collect(files);
    return matches.length === 1 ? matches[0] : undefined;
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
    asset.name = current.name || asset.name;
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
): Promise<LibraryBpmUpdateResult> {
    const files = await fetchLibrary(true, true);
    const libraryFile = findLibraryFileForSnapshot(files, filepath, fileId);
    const response = await fetch('/api/library/bpm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filepath,
            file_id: libraryFile?.id ?? fileId,
            bpm
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.detail || `Could not update the GAIA BPM (${response.status})`);
    }
    if (!result.updated) {
        throw new Error('The selected sample was not found in the GAIA library.');
    }

    if (libraryFile) libraryFile.bpm = result.bpm;
    window.dispatchEvent(new CustomEvent('library-metadata-changed', {
        detail: { filepath, bpm: result.bpm }
    }));
    return result as LibraryBpmUpdateResult;
}
