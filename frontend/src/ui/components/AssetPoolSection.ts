import { type BaseNode } from '../../nodes/BaseNode';
import { getAssetDisplayName } from '../libraryFilters';

export class AssetPoolSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ): Promise<void> {
        const items: any[] = Array.isArray(node.properties.selected_items)
            ? node.properties.selected_items
            : (node.properties.selected_items = []);

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group asset-pool-group';
        wrapper.innerHTML = `
            <div style="margin-bottom: 8px; font-weight: 600; font-size: 11px; color: #475569;">
                Asset Pool (${items.length} Items)
            </div>
            <div class="asset-pool-list" id="prop-asset-pool-list" style="min-height: 60px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 8px; font-size: 11px; color: #64748b;"></div>
        `;

        container.appendChild(wrapper);

        const listEl = wrapper.querySelector('#prop-asset-pool-list') as HTMLElement;
        if (!listEl) return;

        if (items.length === 0) {
            listEl.textContent = 'Drop audio or MIDI assets here';
            listEl.classList.add('is-empty');
        } else {
            listEl.classList.remove('is-empty');
            items.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'asset-pool-item-row';
                row.style.cssText = 'display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9;';
                row.innerHTML = `
                    <span style="font-size: 11px; color: #334155;">${idx + 1}. ${getAssetDisplayName(item)}</span>
                `;
                listEl.appendChild(row);
            });
        }
    }
}
