import { type BaseNode } from '../../nodes/BaseNode';
import { getAssetDisplayName } from '../libraryFilters';

interface DroppedPoolItem {
    id?: number | string;
    itemType?: string;
    filepath: string;
    name?: string;
    key?: string | null;
    bpm?: number | null;
    duration_seconds?: number | null;
}

function getDroppedPoolItems(dataTransfer: DataTransfer): DroppedPoolItem[] {
    const raw = dataTransfer.getData('application/x-gaia-library-item')
        || dataTransfer.getData('text/plain');
    if (!raw) return [];
    try {
        const payload = JSON.parse(raw);
        const items = payload?.type === 'library-items' && Array.isArray(payload.items)
            ? payload.items
            : payload?.type === 'library-item' ? [payload] : [];
        return items.filter((item: any) =>
            item && typeof item.filepath === 'string' && item.filepath.length > 0
        );
    } catch {
        return [];
    }
}

function poolAcceptsItem(node: BaseNode, item: DroppedPoolItem): boolean {
    const acceptedType = String(node.properties?.accepted_asset_type || '');
    if (!acceptedType) return true;
    const path = String(item.filepath || item.name || '').toLowerCase();
    const isMidi = item.itemType === 'midi' || path.endsWith('.mid') || path.endsWith('.midi');
    const isSequence = item.itemType === 'sequence' || path.endsWith('.seq');
    if (acceptedType === 'midi') return isMidi;
    if (acceptedType === 'sequence_source') return isMidi || isSequence;
    return !isMidi && !isSequence;
}

function poolItemKey(item: any): string {
    const filepath = String(item?.absolute_path || item?.filepath || '');
    const locator = filepath || `${item?.collection_id ?? item?.id ?? ''}:${item?.name ?? ''}`;
    return locator
        .replace(/\\/g, '/')
        .toLocaleLowerCase();
}

const POOL_REORDER_MIME = 'application/x-sin-asset-pool-index';

export class AssetPoolSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ): Promise<void> {
        const items: any[] = Array.isArray(node.properties.selected_items)
            ? node.properties.selected_items
            : (node.properties.selected_items = []);
        const isSequencePool = node.properties?.accepted_asset_type === 'sequence_source';

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group asset-pool-group';
        wrapper.innerHTML = `
            <div style="margin-bottom: 8px; font-weight: 600; font-size: 11px; color: #475569;">
                ${isSequencePool ? 'MIDI / Sequence Pool' : 'Asset Pool'} (${items.length} Items)
            </div>
            <div class="asset-pool-list" id="prop-asset-pool-list" style="min-height: 60px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 8px; font-size: 11px; color: #64748b;"></div>
        `;

        container.appendChild(wrapper);

        const listEl = wrapper.querySelector('#prop-asset-pool-list') as HTMLElement;
        if (!listEl) return;

        const commitItems = async (nextItems: any[], removedItem?: any) => {
            node.updateProperty('selected_items', nextItems);
            node.updateProperty('sequence_index', -1);

            const removedPath = poolItemKey(removedItem);
            const outputPath = poolItemKey({ filepath: node.properties.output_value });
            if (removedPath && removedPath === outputPath) {
                node.updateProperty('output_value', '');
                node.updateProperty('output_item_id', null);
                node.updateProperty('output_bpm', null);
                node.updateProperty('output_key', '');
            }

            window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                detail: { nodeId: node.id }
            }));
            await _windowContext.renderTabContent();
        };

        const moveItem = async (fromIndex: number, toIndex: number) => {
            if (fromIndex === toIndex
                || fromIndex < 0 || fromIndex >= items.length
                || toIndex < 0 || toIndex >= items.length) return;
            const reordered = [...items];
            const [moved] = reordered.splice(fromIndex, 1);
            reordered.splice(toIndex, 0, moved);
            await commitItems(reordered);
        };

        if (items.length === 0) {
            listEl.textContent = isSequencePool
                ? 'Drop MIDI or saved sequence assets here'
                : 'Drop audio assets here';
            listEl.classList.add('is-empty');
        } else {
            listEl.classList.remove('is-empty');
            items.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'asset-pool-item-row';
                row.draggable = true;
                row.dataset.poolIndex = String(idx);

                const order = document.createElement('span');
                order.className = 'asset-pool-item-order';
                order.textContent = `${idx + 1}`;
                order.title = 'Drag to reorder';

                const label = document.createElement('span');
                label.className = 'asset-pool-item-label';
                label.textContent = getAssetDisplayName(item);
                label.title = getAssetDisplayName(item);

                const actions = document.createElement('span');
                actions.className = 'asset-pool-item-actions';
                const upButton = document.createElement('button');
                upButton.type = 'button';
                upButton.textContent = '↑';
                upButton.title = 'Move up';
                upButton.setAttribute('aria-label', `Move ${getAssetDisplayName(item)} up`);
                upButton.disabled = idx === 0;
                upButton.addEventListener('click', event => {
                    event.stopPropagation();
                    void moveItem(idx, idx - 1);
                });

                const downButton = document.createElement('button');
                downButton.type = 'button';
                downButton.textContent = '↓';
                downButton.title = 'Move down';
                downButton.setAttribute('aria-label', `Move ${getAssetDisplayName(item)} down`);
                downButton.disabled = idx === items.length - 1;
                downButton.addEventListener('click', event => {
                    event.stopPropagation();
                    void moveItem(idx, idx + 1);
                });

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.textContent = '×';
                deleteButton.title = 'Remove from pool';
                deleteButton.className = 'asset-pool-item-delete';
                deleteButton.setAttribute('aria-label', `Remove ${getAssetDisplayName(item)} from pool`);
                deleteButton.addEventListener('click', event => {
                    event.stopPropagation();
                    void commitItems(items.filter((_, itemIndex) => itemIndex !== idx), item);
                });

                actions.append(upButton, downButton, deleteButton);
                row.append(order, label, actions);

                row.addEventListener('dragstart', event => {
                    if (!event.dataTransfer) return;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(POOL_REORDER_MIME, String(idx));
                    row.classList.add('is-reordering');
                });
                row.addEventListener('dragend', () => {
                    listEl.querySelectorAll('.asset-pool-item-row').forEach(element => {
                        element.classList.remove('is-reordering', 'is-reorder-target');
                    });
                });
                row.addEventListener('dragover', event => {
                    if (!event.dataTransfer?.types.includes(POOL_REORDER_MIME)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    row.classList.add('is-reorder-target');
                });
                row.addEventListener('dragleave', () => row.classList.remove('is-reorder-target'));
                row.addEventListener('drop', event => {
                    if (!event.dataTransfer?.types.includes(POOL_REORDER_MIME)) return;
                    const sourceIndex = Number(event.dataTransfer?.getData(POOL_REORDER_MIME));
                    if (!Number.isInteger(sourceIndex)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    void moveItem(sourceIndex, idx);
                });
                listEl.appendChild(row);
            });
        }

        listEl.addEventListener('dragover', event => {
            if (event.dataTransfer?.types.includes(POOL_REORDER_MIME)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                return;
            }
            if (!event.dataTransfer || getDroppedPoolItems(event.dataTransfer).filter(item => poolAcceptsItem(node, item)).length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            listEl.classList.add('is-dragover');
        });
        listEl.addEventListener('dragleave', event => {
            if (!listEl.contains(event.relatedTarget as Node | null)) {
                listEl.classList.remove('is-dragover');
            }
        });
        listEl.addEventListener('drop', async event => {
            event.preventDefault();
            event.stopPropagation();
            listEl.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            const isPoolReorder = event.dataTransfer.types.includes(POOL_REORDER_MIME);
            const sourceIndex = isPoolReorder
                ? Number(event.dataTransfer.getData(POOL_REORDER_MIME))
                : -1;
            if (isPoolReorder && Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < items.length) {
                await moveItem(sourceIndex, items.length - 1);
                return;
            }
            const droppedItems = getDroppedPoolItems(event.dataTransfer).filter(item => poolAcceptsItem(node, item));
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

            node.updateProperty('selected_items', [...merged.values()]);
            node.updateProperty('seed', Math.random());
            node.updateProperty('sequence_index', -1);
            window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                detail: { nodeId: node.id }
            }));
            await _windowContext.renderTabContent();
        });
    }
}
