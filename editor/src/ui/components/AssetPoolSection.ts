import { type BaseNode } from '../../nodes/BaseNode.ts';
import { getAssetDisplayName } from '../libraryFilters.ts';
import { WidgetFactory } from '../WidgetFactory.ts';
import {
    attachLibraryDragData,
    clearActiveLibraryDragData,
    DRAG_MIME_POOL_REORDER,
    getDroppedPoolItemsByType,
    hasAudioDragPayload,
    hasSequenceDragPayload,
} from '../dragPayload.ts';

function isSequencePoolMode(poolNode: any, ownerNode: any): boolean {
    const ownerType = ownerNode?.getNodeType?.() || ownerNode?.properties?.node_type;
    const acceptedType = poolNode?.properties?.accepted_asset_type || ownerNode?.acceptedPoolAssetType;
    return acceptedType === 'sequence_source' || ownerType === 'sequence';
}

function poolItemKey(item: any): string {
    return String(item?.id ?? item?.filepath ?? item?.absolute_path ?? '');
}

export class AssetPoolSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ): Promise<void> {
        const isOwnerNode = node.getNodeType?.() !== 'asset_filter' && node.type !== 'Audio/AssetFilter';
        const poolNode: any = isOwnerNode ? (node.getAttachedPoolNode?.() || node) : node;
        const ownerNode: any = isOwnerNode
            ? node
            : (() => {
                const graph = (node as any).graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
                const parentId = poolNode?.properties?.parentId;
                return parentId != null && graph ? graph.getNodeById?.(parentId) : null;
            })();

        if (!poolNode.properties) poolNode.properties = {};
        if (!Array.isArray(poolNode.properties.selected_items)) {
            poolNode.properties.selected_items = [];
        }

        const isSequencePool = isSequencePoolMode(poolNode, ownerNode);

        // Render Pool Seed control using the standard WidgetFactory row
        const seedField = (poolNode.getFields?.() || []).find((f: any) => f.key === 'seed') || {
            key: 'seed',
            label: 'Pool Seed',
            type: 'seed' as const,
            default: 42,
            description: 'Deterministic seed or seed sequence (e.g. "42", "42 108", "rand") for selecting pool items across node slots.'
        };
        const seedRow = WidgetFactory.createRow(seedField, poolNode, () => {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                    detail: { nodeId: poolNode.id }
                }));
            }
        });
        container.appendChild(seedRow);

        const group = document.createElement('div');
        group.className = 'asset-pool-group';

        const items = Array.isArray(poolNode.properties.selected_items)
            ? [...poolNode.properties.selected_items]
            : [];

        const listEl = document.createElement('div');
        listEl.className = `asset-pool-list ${items.length === 0 ? 'is-empty' : ''}`;
        listEl.id = 'prop-pool-items';
        listEl.tabIndex = 0;
        group.appendChild(listEl);
        container.appendChild(group);

        if (!(poolNode._selectedPoolIndices instanceof Set)) {
            poolNode._selectedPoolIndices = new Set<number>();
        }
        const selectedIndices: Set<number> = poolNode._selectedPoolIndices;
        for (const idx of [...selectedIndices]) {
            if (idx < 0 || idx >= items.length) selectedIndices.delete(idx);
        }
        let anchorIndex: number | null = selectedIndices.size > 0 ? [...selectedIndices][0] : null;

        const commitItems = async (nextItems: any[]) => {
            poolNode.updateProperty?.('selected_items', nextItems);
            poolNode.updateProperty?.('sequence_index', -1);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                    detail: { nodeId: poolNode.id }
                }));
            }
            await _windowContext?.renderTabContent?.();
        };

        const moveSelectedItems = async (sourceIndices: number[], targetIndex: number) => {
            const validSources = [...new Set(sourceIndices)]
                .filter(i => i >= 0 && i < items.length)
                .sort((a, b) => a - b);
            if (validSources.length === 0) return;

            const movingSet = new Set(validSources);
            const movingItems = validSources.map(i => items[i]);
            const remaining: Array<{ origIdx: number; item: any }> = [];
            items.forEach((item, idx) => {
                if (!movingSet.has(idx)) {
                    remaining.push({ origIdx: idx, item });
                }
            });

            // Find insertion point in remaining array
            let insertAt = remaining.findIndex(entry => entry.origIdx >= targetIndex);
            if (insertAt === -1) insertAt = remaining.length;
            else if (targetIndex > validSources[0]) {
                const afterTarget = remaining.findIndex(entry => entry.origIdx > targetIndex);
                insertAt = afterTarget === -1 ? remaining.length : afterTarget;
            }

            const nextItems = [
                ...remaining.slice(0, insertAt).map(e => e.item),
                ...movingItems,
                ...remaining.slice(insertAt).map(e => e.item),
            ];

            selectedIndices.clear();
            for (let i = 0; i < movingItems.length; i++) {
                selectedIndices.add(insertAt + i);
            }
            await commitItems(nextItems);
        };

        const deleteIndices = async (indicesToDelete: number[]) => {
            const delSet = new Set(indicesToDelete);
            if (delSet.size === 0) return;
            selectedIndices.clear();
            await commitItems(items.filter((_, idx) => !delSet.has(idx)));
        };

        const rowElements: HTMLElement[] = [];
        const syncRowSelectionUI = () => {
            rowElements.forEach((el, idx) => {
                el.classList.toggle('is-selected', selectedIndices.has(idx));
            });
        };

        if (items.length === 0) {
            listEl.textContent = isSequencePool
                ? 'Drop MIDI or sequences from library'
                : 'Drop samples from library';
        } else {
            const activeFilepath = String(ownerNode?.properties?.filepath || poolNode?.properties?.output_value || '');

            items.forEach((item, idx) => {
                const row = document.createElement('div');
                const itemPath = String(item?.filepath || item?.absolute_path || '');
                const isActive = Boolean(activeFilepath && itemPath && activeFilepath === itemPath);
                row.className = `asset-pool-item-row ${isActive ? 'is-active' : ''} ${selectedIndices.has(idx) ? 'is-selected' : ''}`;
                row.draggable = true;
                row.dataset.index = String(idx);

                const order = document.createElement('span');
                order.className = 'asset-pool-item-order';
                order.textContent = String(idx);

                const displayName = getAssetDisplayName(item);
                const label = document.createElement('span');
                label.className = 'asset-pool-item-label';
                label.textContent = displayName;
                label.title = displayName;

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.textContent = '×';
                deleteButton.title = 'Remove from pool';
                deleteButton.className = 'asset-pool-item-delete';
                deleteButton.setAttribute('aria-label', `Remove ${displayName} from pool`);
                deleteButton.addEventListener('click', event => {
                    event.stopPropagation();
                    const targets = (selectedIndices.has(idx) && selectedIndices.size > 1)
                        ? [...selectedIndices]
                        : [idx];
                    void deleteIndices(targets);
                });

                row.append(order, label, deleteButton);

                // Clicking selects item(s) in the pool without replacing the active slot
                row.addEventListener('click', event => {
                    event.stopPropagation();
                    listEl.focus({ preventScroll: true });
                    if (event.shiftKey && anchorIndex !== null) {
                        const start = Math.min(anchorIndex, idx);
                        const end = Math.max(anchorIndex, idx);
                        if (!event.ctrlKey && !event.metaKey) selectedIndices.clear();
                        for (let i = start; i <= end; i++) selectedIndices.add(i);
                    } else if (event.ctrlKey || event.metaKey) {
                        if (selectedIndices.has(idx)) selectedIndices.delete(idx);
                        else selectedIndices.add(idx);
                        anchorIndex = idx;
                    } else {
                        selectedIndices.clear();
                        selectedIndices.add(idx);
                        anchorIndex = idx;
                    }
                    syncRowSelectionUI();
                });

                row.addEventListener('dragstart', event => {
                    if (!event.dataTransfer) return;
                    if (!selectedIndices.has(idx)) {
                        selectedIndices.clear();
                        selectedIndices.add(idx);
                        anchorIndex = idx;
                        syncRowSelectionUI();
                    }
                    const draggedIdxList = [...selectedIndices].sort((a, b) => a - b);
                    const draggedItems = draggedIdxList.map(i => {
                        const it = items[i];
                        return {
                            id: it.id,
                            filepath: String(it.filepath || it.absolute_path || ''),
                            itemType: it.type || (isSequencePool ? 'sequence' : 'audio'),
                            name: it.name || getAssetDisplayName(it),
                            key: it.key ?? null,
                            bpm: it.bpm ?? null,
                            duration_seconds: it.duration_seconds ?? null,
                            fromPool: true,
                            poolIndex: i
                        };
                    });
                    attachLibraryDragData(event.dataTransfer, draggedItems, {
                        effectAllowed: 'copyMove',
                        poolReorderIndices: draggedIdxList
                    });
                    draggedIdxList.forEach(i => rowElements[i]?.classList.add('is-reordering'));
                });

                row.addEventListener('dragend', () => {
                    clearActiveLibraryDragData();
                    rowElements.forEach(element => {
                        element.classList.remove('is-reordering', 'is-reorder-target');
                    });
                });

                row.addEventListener('dragover', event => {
                    if (!event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    row.classList.add('is-reorder-target');
                });
                row.addEventListener('dragleave', () => row.classList.remove('is-reorder-target'));
                row.addEventListener('drop', event => {
                    if (!event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) return;
                    const rawIndices = event.dataTransfer.getData(DRAG_MIME_POOL_REORDER);
                    const sourceIndices = rawIndices
                        .split(',')
                        .map(s => Number(s.trim()))
                        .filter(n => Number.isInteger(n));
                    if (sourceIndices.length === 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.remove('is-reorder-target');
                    void moveSelectedItems(sourceIndices, idx);
                });

                rowElements.push(row);
                listEl.appendChild(row);
            });
        }

        listEl.addEventListener('keydown', (event: KeyboardEvent) => {
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIndices.size > 0) {
                event.preventDefault();
                event.stopPropagation();
                void deleteIndices([...selectedIndices]);
            }
        });

        const canAcceptPoolDrop = (dt: DataTransfer | null): boolean => {
            return isSequencePool ? hasSequenceDragPayload(dt) : hasAudioDragPayload(dt);
        };

        listEl.addEventListener('dragover', event => {
            if (event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                return;
            }
            if (!canAcceptPoolDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            listEl.classList.add('is-dragover');
        });
        listEl.addEventListener('dragleave', event => {
            if (!listEl.contains(event.relatedTarget as Node | null)) {
                listEl.classList.remove('is-dragover');
            }
        });
        listEl.addEventListener('drop', async event => {
            listEl.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            if (event.dataTransfer.types.includes(DRAG_MIME_POOL_REORDER)) {
                event.preventDefault();
                event.stopPropagation();
                const rawIndices = event.dataTransfer.getData(DRAG_MIME_POOL_REORDER);
                const sourceIndices = rawIndices
                    .split(',')
                    .map(s => Number(s.trim()))
                    .filter(n => Number.isInteger(n));
                if (sourceIndices.length > 0) {
                    await moveSelectedItems(sourceIndices, items.length - 1);
                }
                return;
            }
            if (!canAcceptPoolDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            const droppedItems = getDroppedPoolItemsByType(event.dataTransfer, isSequencePool);
            if (droppedItems.length === 0) return;

            const merged = new Map<string, any>();
            for (const item of items) {
                const key = poolItemKey(item);
                if (key) merged.set(key, item);
            }
            for (const item of droppedItems) {
                const poolItem = {
                    id: item.id,
                    absolute_path: item.filepath,
                    filepath: item.filepath,
                    name: item.name || item.filepath.split(/[\\/]/).pop(),
                    type: item.itemType || (item.filepath.toLowerCase().endsWith('.seq') ? 'sequence' : item.filepath.toLowerCase().match(/\.midi?$/) ? 'midi' : 'audio'),
                    key: item.key ?? null,
                    bpm: item.bpm ?? null,
                    duration_seconds: item.duration_seconds ?? null
                };
                const key = poolItemKey(poolItem);
                if (key) merged.set(key, poolItem);
            }

            poolNode.updateProperty?.('selected_items', [...merged.values()]);
            if (poolNode.properties.seed == null) {
                poolNode.updateProperty?.('seed', 42);
            }
            poolNode.updateProperty?.('sequence_index', -1);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                    detail: { nodeId: poolNode.id }
                }));
            }
            await _windowContext?.renderTabContent?.();
        });
    }
}
