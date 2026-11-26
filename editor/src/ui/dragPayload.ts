export interface DroppedLibraryItem {
    id?: number | string;
    itemType?: string;
    filepath: string;
    name?: string;
    key?: string | null;
    bpm?: number | null;
    duration_seconds?: number | null;
    fromPool?: boolean;
    poolIndex?: number;
    is_external?: boolean;
    is_inline?: boolean;
    source?: 'gaia' | 'external' | 'inline';
    sequence?: number[];
    step_parameters?: Array<Record<string, any>>;
}

export const DRAG_MIME_LIBRARY_ITEM = 'application/x-gaia-library-item';
export const DRAG_MIME_AUDIO = 'application/x-sin-drag-audio';
export const DRAG_MIME_SEQUENCE = 'application/x-sin-drag-sequence';
export const DRAG_MIME_POOL_REORDER = 'application/x-sin-pool-item-index';

export const AUDIO_FILE_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.aif', '.aiff', '.m4a']);
export const SEQUENCE_FILE_EXTENSIONS = new Set(['.mid', '.midi', '.seq']);

let activeDraggedItems: DroppedLibraryItem[] = [];

function getFileExtension(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export function isSequenceLibraryDragItem(item: Partial<DroppedLibraryItem> | null | undefined): boolean {
    if (!item) return false;
    if (item.is_inline || item.source === 'inline') return true;
    if (!item.filepath) return false;
    const fp = String(item.filepath).toLowerCase();
    const t = String(item.itemType || (item as any).type || '').toLowerCase();
    return t === 'midi' || t === 'sequence' || fp.endsWith('.mid') || fp.endsWith('.midi') || fp.endsWith('.seq');
}

export function isAudioLibraryDragItem(item: Partial<DroppedLibraryItem> | null | undefined): boolean {
    if (!item || item.is_inline || item.source === 'inline' || !item.filepath) return false;
    return !isSequenceLibraryDragItem(item);
}

export function attachLibraryDragData(
    dataTransfer: DataTransfer,
    items: DroppedLibraryItem[],
    options?: { effectAllowed?: DataTransfer['effectAllowed']; poolReorderIndices?: number[] }
): void {
    activeDraggedItems = items.map(item => ({ ...item }));
    const payload = items.length === 1
        ? { type: 'library-item', ...items[0] }
        : { type: 'library-items', items };
    const json = JSON.stringify(payload);
    dataTransfer.setData('text/plain', json);
    dataTransfer.setData(DRAG_MIME_LIBRARY_ITEM, json);
    if (items.some(isAudioLibraryDragItem)) {
        dataTransfer.setData(DRAG_MIME_AUDIO, '1');
    }
    if (items.some(isSequenceLibraryDragItem)) {
        dataTransfer.setData(DRAG_MIME_SEQUENCE, '1');
    }
    if (options?.poolReorderIndices && options.poolReorderIndices.length > 0) {
        dataTransfer.setData(DRAG_MIME_POOL_REORDER, options.poolReorderIndices.join(','));
    }
    dataTransfer.effectAllowed = options?.effectAllowed ?? 'copy';
}

export function clearActiveLibraryDragData(): void {
    activeDraggedItems = [];
}

function parseDataTransferItems(dataTransfer: DataTransfer | null | undefined): DroppedLibraryItem[] {
    if (!dataTransfer) return activeDraggedItems;
    const raw = (typeof dataTransfer.getData === 'function'
        ? (dataTransfer.getData(DRAG_MIME_LIBRARY_ITEM) || dataTransfer.getData('text/plain'))
        : '') || '';
    if (raw) {
        try {
            const payload = JSON.parse(raw);
            const rawItems = payload?.type === 'library-items' && Array.isArray(payload.items)
                ? payload.items
                : payload?.type === 'library-item' ? [payload] : [];
            const valid = rawItems.filter((item: any) =>
                item && (
                    (typeof item.filepath === 'string' && item.filepath.length > 0)
                    || Boolean(item.is_inline)
                    || item.source === 'inline'
                )
            );
            if (valid.length > 0) return valid;
        } catch {
            // Fall back to in-memory activeDraggedItems
        }
    }
    return activeDraggedItems;
}

export function hasOsFileDragPayload(dataTransfer: DataTransfer | null | undefined): boolean {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    return types.includes('Files') || Boolean(dataTransfer.files && dataTransfer.files.length > 0);
}

function hasOsFileKindHint(dataTransfer: DataTransfer, mode: 'audio' | 'sequence'): boolean {
    if (!hasOsFileDragPayload(dataTransfer)) return false;
    const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    if (files.length > 0) {
        const extSet = mode === 'sequence' ? SEQUENCE_FILE_EXTENSIONS : AUDIO_FILE_EXTENSIONS;
        return files.some(f => extSet.has(getFileExtension(f.name || '')));
    }
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const fileItems = items.filter(it => it.kind === 'file');
    if (fileItems.length === 0) return true;
    return fileItems.some(it => {
        const mime = String(it.type || '').toLowerCase();
        if (!mime || mime === 'application/octet-stream') return true;
        if (mode === 'sequence') {
            return mime.includes('midi') || mime === 'application/json' || mime === 'text/plain';
        }
        return mime.startsWith('audio/') && !mime.includes('midi');
    });
}

export function hasAudioDragPayload(dataTransfer: DataTransfer | null | undefined): boolean {
    if (activeDraggedItems.length > 0) {
        return activeDraggedItems.some(isAudioLibraryDragItem);
    }
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.includes(DRAG_MIME_AUDIO)) return true;
    if (types.includes(DRAG_MIME_SEQUENCE) && !types.includes(DRAG_MIME_AUDIO)) return false;
    const parsed = parseDataTransferItems(dataTransfer);
    if (parsed.length > 0) return parsed.some(isAudioLibraryDragItem);
    if (types.includes(DRAG_MIME_LIBRARY_ITEM)) return true;
    if (types.includes(DRAG_MIME_POOL_REORDER)) return false;
    return hasOsFileKindHint(dataTransfer, 'audio');
}

export function hasSequenceDragPayload(dataTransfer: DataTransfer | null | undefined): boolean {
    if (activeDraggedItems.length > 0) {
        return activeDraggedItems.some(isSequenceLibraryDragItem);
    }
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.includes(DRAG_MIME_SEQUENCE)) return true;
    if (types.includes(DRAG_MIME_AUDIO) && !types.includes(DRAG_MIME_SEQUENCE)) return false;
    const parsed = parseDataTransferItems(dataTransfer);
    if (parsed.length > 0) return parsed.some(isSequenceLibraryDragItem);
    if (types.includes(DRAG_MIME_LIBRARY_ITEM)) return true;
    if (types.includes(DRAG_MIME_POOL_REORDER)) return false;
    return hasOsFileKindHint(dataTransfer, 'sequence');
}

export function getDroppedAudioItems(dataTransfer: DataTransfer | null | undefined): DroppedLibraryItem[] {
    return parseDataTransferItems(dataTransfer).filter(isAudioLibraryDragItem);
}

export function getDroppedSequenceItems(dataTransfer: DataTransfer | null | undefined): DroppedLibraryItem[] {
    return parseDataTransferItems(dataTransfer).filter(isSequenceLibraryDragItem);
}

export function getDroppedPoolItemsByType(
    dataTransfer: DataTransfer | null | undefined,
    acceptSequence: boolean
): DroppedLibraryItem[] {
    return acceptSequence ? getDroppedSequenceItems(dataTransfer) : getDroppedAudioItems(dataTransfer);
}

function normalizeExternalStageResponse(data: any, fallbackName: string): DroppedLibraryItem | null {
    const filepath = String(data?.filepath || data?.absolute_path || '').trim();
    if (!filepath) return null;
    const name = String(data?.name || fallbackName || filepath.split(/[\\/]/).pop() || 'External').trim();
    const ext = getFileExtension(name || filepath);
    const inferredType = ext === '.seq'
        ? 'sequence'
        : (ext === '.mid' || ext === '.midi')
            ? 'midi'
            : 'audio';
    const itemType = String(data?.type || inferredType);
    return {
        id: data?.id || `ext:${filepath}`,
        filepath,
        name,
        itemType,
        key: data?.key ?? null,
        bpm: data?.bpm ?? null,
        duration_seconds: data?.duration_seconds ?? null,
        is_external: true,
        source: 'external',
    };
}

export async function stageOrInspectExternalFile(
    file: File,
    options?: { acceptAudio?: boolean; acceptSequence?: boolean }
): Promise<DroppedLibraryItem | null> {
    if (!file || !file.name) return null;
    const ext = getFileExtension(file.name);
    const isAudio = AUDIO_FILE_EXTENSIONS.has(ext);
    const isSeq = SEQUENCE_FILE_EXTENSIONS.has(ext);
    if (!isAudio && !isSeq) return null;
    if (options?.acceptAudio === false && isAudio) return null;
    if (options?.acceptSequence === false && isSeq) return null;

    const nativePath = typeof (file as any).path === 'string' ? String((file as any).path).trim() : '';
    if (nativePath) {
        const resp = await fetch('/api/external/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath: nativePath }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.detail || `Could not inspect external file (${resp.status})`);
        }
        return normalizeExternalStageResponse(data, file.name);
    }

    const resp = await fetch(`/api/external/stage?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.detail || `Could not stage external file (${resp.status})`);
    }
    return normalizeExternalStageResponse(data, file.name);
}

export async function resolveDroppedAnyItems(
    dataTransfer: DataTransfer | null | undefined
): Promise<DroppedLibraryItem[]> {
    const internal = parseDataTransferItems(dataTransfer);
    if (internal.length > 0) return internal;
    const files = dataTransfer?.files ? Array.from(dataTransfer.files) : [];
    if (files.length === 0) return [];
    const staged = await Promise.all(files.map(file => stageOrInspectExternalFile(file)));
    return staged.filter((item): item is DroppedLibraryItem => Boolean(item));
}

export async function resolveDroppedAudioItems(
    dataTransfer: DataTransfer | null | undefined
): Promise<DroppedLibraryItem[]> {
    const internal = getDroppedAudioItems(dataTransfer);
    if (internal.length > 0) return internal;
    const files = dataTransfer?.files ? Array.from(dataTransfer.files) : [];
    if (files.length === 0) return [];
    const staged = await Promise.all(
        files.map(file => stageOrInspectExternalFile(file, { acceptAudio: true, acceptSequence: false }))
    );
    return staged.filter((item): item is DroppedLibraryItem => Boolean(item));
}

export async function resolveDroppedSequenceItems(
    dataTransfer: DataTransfer | null | undefined
): Promise<DroppedLibraryItem[]> {
    const internal = getDroppedSequenceItems(dataTransfer);
    if (internal.length > 0) return internal;
    const files = dataTransfer?.files ? Array.from(dataTransfer.files) : [];
    if (files.length === 0) return [];
    const staged = await Promise.all(
        files.map(file => stageOrInspectExternalFile(file, { acceptAudio: false, acceptSequence: true }))
    );
    return staged.filter((item): item is DroppedLibraryItem => Boolean(item));
}

export async function resolveDroppedPoolItemsByType(
    dataTransfer: DataTransfer | null | undefined,
    acceptSequence: boolean
): Promise<DroppedLibraryItem[]> {
    return acceptSequence
        ? resolveDroppedSequenceItems(dataTransfer)
        : resolveDroppedAudioItems(dataTransfer);
}
