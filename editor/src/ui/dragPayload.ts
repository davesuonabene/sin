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
}

export const DRAG_MIME_LIBRARY_ITEM = 'application/x-gaia-library-item';
export const DRAG_MIME_AUDIO = 'application/x-sin-drag-audio';
export const DRAG_MIME_SEQUENCE = 'application/x-sin-drag-sequence';
export const DRAG_MIME_POOL_REORDER = 'application/x-sin-pool-item-index';

let activeDraggedItems: DroppedLibraryItem[] = [];

export function isSequenceLibraryDragItem(item: Partial<DroppedLibraryItem> | null | undefined): boolean {
    if (!item || !item.filepath) return false;
    const fp = String(item.filepath).toLowerCase();
    const t = String(item.itemType || (item as any).type || '').toLowerCase();
    return t === 'midi' || t === 'sequence' || fp.endsWith('.mid') || fp.endsWith('.midi') || fp.endsWith('.seq');
}

export function isAudioLibraryDragItem(item: Partial<DroppedLibraryItem> | null | undefined): boolean {
    if (!item || !item.filepath) return false;
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
            const valid = rawItems.filter((item: any) => item && typeof item.filepath === 'string' && item.filepath.length > 0);
            if (valid.length > 0) return valid;
        } catch {
            // Fall back to in-memory activeDraggedItems
        }
    }
    return activeDraggedItems;
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
    return types.includes(DRAG_MIME_LIBRARY_ITEM);
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
    return types.includes(DRAG_MIME_LIBRARY_ITEM);
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

