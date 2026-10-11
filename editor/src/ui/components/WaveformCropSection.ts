import { type BaseNode } from '../../nodes/BaseNode.ts';
import { WaveformVisualizer } from '../WaveformVisualizer.ts';

interface DroppedLibraryItem {
    id?: number | string;
    itemType?: string;
    filepath: string;
    name?: string;
    key?: string | null;
    bpm?: number | null;
    duration_seconds?: number | null;
}

function getDroppedAudioItem(dataTransfer: DataTransfer): DroppedLibraryItem | null {
    const raw = dataTransfer.getData('text/plain');
    if (!raw) return null;

    try {
        const payload = JSON.parse(raw);
        const items = payload?.type === 'library-items' && Array.isArray(payload.items)
            ? payload.items
            : payload?.type === 'library-item' ? [payload] : [];
        return items.find((item: any) => {
            const filepath = String(item?.filepath || '');
            return filepath
                && item?.itemType !== 'midi'
                && !filepath.toLowerCase().endsWith('.mid')
                && !filepath.toLowerCase().endsWith('.midi');
        }) || null;
    } catch {
        return null;
    }
}

function assetTitle(node: BaseNode): string {
    const filepath = String(node.properties?.filepath || '');
    if (filepath) return filepath.split(/[\\/]/).pop() || filepath;
    if (node.properties?.asset_modifier_id != null) return 'Pool resolves on preview';
    return 'Drop a sample here';
}

export class WaveformCropSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        container.innerHTML = `
            <div class="waveform-crop-wrapper" style="display: flex; flex-direction: column; gap: 8px;">
                <div class="waveform-asset-title"></div>
                <div class="waveform-drop-target">
                    <div class="waveform-visualizer"></div>
                    <div class="waveform-drop-message">Drop sample to load</div>
                </div>
                <div class="crop-time-display" style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; font-family: monospace;">
                    <span class="crop-time-start">0.00s</span>
                    <span class="crop-time-end">0.00s</span>
                </div>
            </div>
        `;

        const visContainer = container.querySelector('.waveform-visualizer') as HTMLElement;
        const dropTarget = container.querySelector('.waveform-drop-target') as HTMLElement;
        const titleEl = container.querySelector('.waveform-asset-title') as HTMLElement;
        const timeStartEl = container.querySelector('.crop-time-start') as HTMLElement;
        const timeEndEl = container.querySelector('.crop-time-end') as HTMLElement;

        if (!visContainer) return;
        const graph = (window as any).editorGraph;
        const assignedModifierId = node.properties?.asset_modifier_id;
        const assignedModifier = assignedModifierId != null
            ? graph?.getNodeById?.(assignedModifierId)
            : null;

        const assetRow = document.createElement('div');
        assetRow.className = 'waveform-asset-row';
        titleEl.replaceWith(assetRow);

        const assetLabel = document.createElement('span');
        assetLabel.className = 'waveform-asset-title';
        assetLabel.textContent = assetTitle(node);
        assetLabel.title = assetLabel.textContent;

        const assetActions = document.createElement('span');
        assetActions.className = 'waveform-asset-actions';

        const poolButton = document.createElement('button');
        poolButton.type = 'button';
        poolButton.className = `waveform-asset-button waveform-pool-button ${assignedModifier ? 'is-assigned' : ''}`;
        poolButton.textContent = assignedModifier ? '→' : '+';
        poolButton.title = assignedModifier ? 'Open Sample Pool' : 'Add Sample Pool';
        poolButton.setAttribute('aria-label', poolButton.title);
        poolButton.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', {
                detail: { nodeId: node.id }
            }));
        });

        assetActions.append(poolButton);
        assetRow.append(assetLabel, assetActions);

        dropTarget.addEventListener('dragover', event => {
            if (!event.dataTransfer || !getDroppedAudioItem(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            dropTarget.classList.add('is-dragover');
        });
        dropTarget.addEventListener('dragleave', event => {
            if (!dropTarget.contains(event.relatedTarget as Node | null)) {
                dropTarget.classList.remove('is-dragover');
            }
        });
        dropTarget.addEventListener('drop', async event => {
            event.preventDefault();
            event.stopPropagation();
            dropTarget.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            const item = getDroppedAudioItem(event.dataTransfer);
            if (!item) return;

            // A direct drop switches this Sample back to single-asset mode.
            // Keep the pool node available so the + button can reconnect it.
            if (node.properties?.asset_modifier_id != null) {
                node.updateProperty('asset_modifier_id', null);
                window.dispatchEvent(new CustomEvent('modifier-assignment-changed', {
                    detail: { nodeId: node.id }
                }));
            }
            const previousPath = node.properties?.filepath;
            node.updateProperty('filepath', item.filepath);
            await node.onPropertyEdited('filepath', item.filepath, previousPath);
            if (item.name) node.updateProperty('node_name', item.name);
            if (item.id != null) node.updateProperty('library_item_id', item.id);
            node.updateProperty('sample_type', item.itemType === 'one_shot' ? 'one_shot' : 'loop');
            if (Number.isFinite(Number(item.bpm))) node.updateProperty('original_bpm', Number(item.bpm));
            if (item.key) node.updateProperty('key', item.key);
            if (Number.isFinite(Number(item.duration_seconds))) {
                node.updateProperty('duration_seconds', Number(item.duration_seconds));
            }
            windowContext.refreshAudioPreview();
            await windowContext.renderTabContent();
        });

        const updateCropInputs = (s: number, e: number) => {
            const root: ParentNode = windowContext?.container || container.closest('.td-properties-window') || document;
            const startInput = root.querySelector('[data-field-key="crop_start"] input') as HTMLInputElement | null;
            const endInput = root.querySelector('[data-field-key="crop_end"] input') as HTMLInputElement | null;
            const sVal = (Math.round(s * 100) / 100).toFixed(2);
            const eVal = (Math.round(e * 100) / 100).toFixed(2);
            if (startInput && document.activeElement !== startInput) {
                startInput.value = sVal;
            }
            if (endInput && document.activeElement !== endInput) {
                endInput.value = eVal;
            }
        };

        const updateTimeLabels = (s: number, e: number) => {
            const dur = visualizer?.getDuration() || Number(node.properties.duration_seconds) || 0;
            if (timeStartEl && timeEndEl) {
                timeStartEl.textContent = `${(s * dur).toFixed(2)}s`;
                timeEndEl.textContent = `${(e * dur).toFixed(2)}s`;
            }
        };

        const initialS = node.properties.crop_start !== undefined ? Number(node.properties.crop_start) : 0.0;
        const initialE = node.properties.crop_end !== undefined ? Number(node.properties.crop_end) : 1.0;

        const visualizer = new WaveformVisualizer({
            container: visContainer,
            cropStart: initialS,
            cropEnd: initialE,
            onCropChange: (s: number, e: number) => {
                const roundedS = Math.round(s * 100) / 100;
                const roundedE = Math.round(e * 100) / 100;
                node.updateProperty('crop_start', roundedS);
                node.updateProperty('crop_end', roundedE);
                updateCropInputs(roundedS, roundedE);
                updateTimeLabels(s, e);
                windowContext.refreshAudioPreview();
            }
        });

        windowContext.currentWaveformVisualizer = visualizer;
        windowContext.updateCropFromFields = (s: number, e: number) => {
            visualizer.setCrop(s, e, true);
            updateTimeLabels(s, e);
        };

        const filepath = node.properties.filepath;
        if (filepath) {
            await visualizer.loadAudio(filepath);
            const audioDur = visualizer.getDuration();
            if (audioDur > 0) {
                node.updateProperty('duration_seconds', audioDur);
            }
            const crop = visualizer.getCrop();
            updateTimeLabels(crop.start, crop.end);
            updateCropInputs(crop.start, crop.end);
        } else {
            updateTimeLabels(initialS, initialE);
            updateCropInputs(initialS, initialE);
        }
    }
}
