import { type BaseNode } from '../../nodes/BaseNode.ts';
import {
    type RandomDestination,
    applyRandomModulation,
    restoreBaseValues,
    getRangeColor
} from '../../../../ermes/ts/randomResolver.ts';
import { startBipolarDrag } from '../RandomParamOverlay.ts';

export { getRangeColor };

export class RandomDestinationsSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        const graph = (window as any).editorGraph;
        const parentId = node.properties?.parentId;
        const ownerNode = parentId != null && graph ? graph.getNodeById(parentId) : null;

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group random-panel-group';

        // 1. Map Parameters Action Button
        const mapActionBtn = document.createElement('button');
        mapActionBtn.type = 'button';
        mapActionBtn.className = 'random-map-action-btn td-param-action-btn td-param-action-primary';
        mapActionBtn.style.width = '100%';
        mapActionBtn.textContent = 'Map Parameters';
        mapActionBtn.title = 'Open parent parameters panel to click-map controls';

        mapActionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (ownerNode) {
                window.dispatchEvent(new CustomEvent('open-node-properties', {
                    detail: { nodeId: ownerNode.id, startRandomMapping: true }
                }));
            }
        });

        wrapper.appendChild(mapActionBtn);

        // 2. Destinations List (Each link occupies a single line)
        const listWrapper = document.createElement('div');
        listWrapper.className = 'random-destinations-container';
        wrapper.appendChild(listWrapper);

        const renderDestinationsList = () => {
            listWrapper.innerHTML = '';
            const destinations: RandomDestination[] = Array.isArray(node.properties.destinations)
                ? node.properties.destinations
                : [];

            if (destinations.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'random-empty-message';
                empty.textContent = 'No parameters mapped. Click "Map Parameters" above.';
                listWrapper.appendChild(empty);
                return;
            }

            destinations.forEach((dest) => {
                const row = document.createElement('div');
                row.className = 'random-dest-row';

                const colors = getRangeColor(dest.minPercent, dest.maxPercent);

                const spread = Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent));
                const spreadStr = spread > 0 ? `±${spread}%` : '0%';

                row.innerHTML = `
                    <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden;">
                        <span class="random-dest-name">${dest.paramLabel || dest.paramKey}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <span class="dest-range-pill" style="color: ${colors.text}; background: ${colors.bg}; border: 1px solid ${colors.border};" title="Drag horizontally to adjust ± range">
                            ${spreadStr}
                        </span>
                        <button type="button" class="dest-delete-btn" title="Remove mapping">×</button>
                    </div>
                `;

                const rangePill = row.querySelector('.dest-range-pill') as HTMLElement;
                rangePill.onmouseenter = () => { rangePill.style.borderColor = '#0284c7'; };
                rangePill.onmouseleave = () => { rangePill.style.borderColor = colors.border; };
                rangePill.onpointerdown = (e: PointerEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startBipolarDrag(
                        e,
                        dest,
                        (newSpread) => {
                            rangePill.textContent = newSpread > 0 ? `±${newSpread}%` : '0%';
                            const updatedColors = getRangeColor(-newSpread, newSpread);
                            rangePill.style.color = updatedColors.text;
                            rangePill.style.background = updatedColors.bg;
                            rangePill.style.borderColor = updatedColors.border;
                            if (ownerNode) {
                                applyRandomModulation(node, ownerNode);
                            }
                        },
                        () => {
                            node.updateProperty('destinations', [...(node.properties.destinations || [])]);
                            if (ownerNode) {
                                applyRandomModulation(node, ownerNode);
                                windowContext?.refreshAudioPreview?.();
                            }
                        }
                    );
                };

                const deleteBtn = row.querySelector('.dest-delete-btn') as HTMLButtonElement;
                deleteBtn.onmouseenter = () => { deleteBtn.style.color = '#ef4444'; };
                deleteBtn.onmouseleave = () => { deleteBtn.style.color = '#64748b'; };
                deleteBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (ownerNode) {
                        restoreBaseValues(node, ownerNode);
                    }
                    const current = Array.isArray(node.properties.destinations) ? node.properties.destinations : [];
                    const updated = current.filter((d: RandomDestination) => d.paramKey !== dest.paramKey);
                    node.updateProperty('destinations', updated);
                    if (ownerNode) {
                        applyRandomModulation(node, ownerNode);
                        windowContext?.refreshAudioPreview?.();
                    }
                    renderDestinationsList();
                };

                listWrapper.appendChild(row);
            });
        };

        renderDestinationsList();
        container.appendChild(wrapper);
    }
}
