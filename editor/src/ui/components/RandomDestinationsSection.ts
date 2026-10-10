import { type BaseNode } from '../../nodes/BaseNode.ts';
import {
    type RandomDestination,
    type RandomRefreshMode,
    normalizeRandomRefreshMode,
    applyRandomModulation,
    advanceRandomSeed,
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
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

        // 1. Minimal Refresh Mode Bar
        const currentMode: RandomRefreshMode = normalizeRandomRefreshMode(node.properties.refresh_mode || 'parent');
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;';

        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 4px;">
                <span style="font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-right: 2px;">Refresh</span>
                <div class="random-refresh-modes" style="display: flex; gap: 2px;">
                    ${['local', 'parent', 'global', 'off'].map(mode => `
                        <button type="button" data-mode="${mode}" class="random-mode-btn" style="padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: capitalize; border-radius: 3px; border: 1px solid ${mode === currentMode ? '#ec4899' : '#334155'}; background: ${mode === currentMode ? 'rgba(236, 72, 153, 0.2)' : 'transparent'}; color: ${mode === currentMode ? '#f472b6' : '#64748b'}; cursor: pointer;">
                            ${mode}
                        </button>
                    `).join('')}
                </div>
            </div>
            <button type="button" class="random-roll-btn" style="padding: 2px 8px; font-size: 10px; font-weight: 600; color: #fff; background: #db2777; border: none; border-radius: 3px; cursor: pointer;">
                Roll
            </button>
        `;

        const modeButtons = header.querySelectorAll<HTMLButtonElement>('.random-mode-btn');
        modeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const selectedMode = btn.getAttribute('data-mode') as RandomRefreshMode;
                node.updateProperty('refresh_mode', selectedMode);
                modeButtons.forEach(b => {
                    const isCurrent = b.getAttribute('data-mode') === selectedMode;
                    b.style.borderColor = isCurrent ? '#ec4899' : '#334155';
                    b.style.background = isCurrent ? 'rgba(236, 72, 153, 0.2)' : 'transparent';
                    b.style.color = isCurrent ? '#f472b6' : '#64748b';
                });
            });
        });

        const rollBtn = header.querySelector('.random-roll-btn') as HTMLButtonElement;
        rollBtn.addEventListener('click', (e) => {
            e.preventDefault();
            advanceRandomSeed(node);
            if (ownerNode) {
                applyRandomModulation(node, ownerNode);
                windowContext?.refreshAudioPreview?.();
            }
            renderDestinationsList();
        });

        wrapper.appendChild(header);

        // 2. Map Parameters Action Button
        const mapActionBtn = document.createElement('button');
        mapActionBtn.type = 'button';
        mapActionBtn.className = 'random-map-action-btn';
        mapActionBtn.style.cssText = 'padding: 7px 10px; font-size: 11px; font-weight: 600; color: #ffffff; background: #db2777; border: 1px solid #ec4899; border-radius: 5px; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 5px; transition: all 0.15s ease;';
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

        // 3. Destinations List (Each link occupies a single line)
        const listWrapper = document.createElement('div');
        listWrapper.className = 'random-destinations-container';
        listWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
        wrapper.appendChild(listWrapper);

        const renderDestinationsList = () => {
            listWrapper.innerHTML = '';
            const destinations: RandomDestination[] = Array.isArray(node.properties.destinations)
                ? node.properties.destinations
                : [];

            if (destinations.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding: 12px; text-align: center; color: #64748b; font-size: 11px; border: 1px dashed #334155; border-radius: 5px; background: rgba(15, 23, 42, 0.4);';
                empty.textContent = 'No parameters mapped. Click "Map Parameters" above.';
                listWrapper.appendChild(empty);
                return;
            }

            destinations.forEach((dest) => {
                const row = document.createElement('div');
                row.className = 'random-dest-row';
                row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 4px; font-size: 11px;';

                const colors = getRangeColor(dest.minPercent, dest.maxPercent);

                const spread = Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent));
                const spreadStr = spread > 0 ? `±${spread}%` : '0%';

                row.innerHTML = `
                    <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden;">
                        <span style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${dest.paramLabel || dest.paramKey}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <span class="dest-range-pill" style="font-size: 10px; font-weight: 700; color: ${colors.text}; background: ${colors.bg}; border: 1px solid ${colors.border}; padding: 1px 6px; border-radius: 3px; cursor: ew-resize; user-select: none;" title="Drag horizontally to adjust ± range">
                            ${spreadStr}
                        </span>
                        <button type="button" class="dest-delete-btn" style="background: transparent; border: none; color: #64748b; font-size: 14px; line-height: 1; cursor: pointer; padding: 0 3px; border-radius: 3px; transition: color 0.15s ease;" title="Remove mapping">×</button>
                    </div>
                `;

                const rangePill = row.querySelector('.dest-range-pill') as HTMLElement;
                rangePill.onmouseenter = () => { rangePill.style.borderColor = '#ffffff'; };
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
                        },
                        () => {
                            node.updateProperty('destinations', [...(node.properties.destinations || [])]);
                        }
                    );
                };

                const deleteBtn = row.querySelector('.dest-delete-btn') as HTMLButtonElement;
                deleteBtn.onmouseenter = () => { deleteBtn.style.color = '#ef4444'; };
                deleteBtn.onmouseleave = () => { deleteBtn.style.color = '#64748b'; };
                deleteBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const current = Array.isArray(node.properties.destinations) ? node.properties.destinations : [];
                    const updated = current.filter((d: RandomDestination) => d.paramKey !== dest.paramKey);
                    node.updateProperty('destinations', updated);
                    renderDestinationsList();
                };

                listWrapper.appendChild(row);
            });
        };

        renderDestinationsList();
        container.appendChild(wrapper);
    }
}
