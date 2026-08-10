export interface LibraryFile {
    id?: number | string;
    absolute_path: string;
    name: string;
    type?: string;
    key?: string;
    bpm?: number | null;
    tags?: any[];
    vault_id?: number | string;
    stream_url?: string;
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

export function findLibraryFile(files: LibraryFile[], filepath: string): LibraryFile | undefined {
    const target = normalizeAssetPath(filepath);
    return files.find(file => normalizeAssetPath(file.absolute_path) === target);
}

export function findLibraryFileById(files: LibraryFile[], id: number | string | null | undefined): LibraryFile | undefined {
    if (id == null) return undefined;
    return files.find(file => String(file.id) === String(id));
}

export async function updateLibraryBpm(
    filepath: string,
    bpm: number,
    fileId?: number | string | null
): Promise<LibraryBpmUpdateResult> {
    const files = await fetchLibrary(true, true);
    const libraryFile = findLibraryFileById(files, fileId) || findLibraryFile(files, filepath);
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
