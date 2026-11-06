import { type BaseNode } from '../../nodes/BaseNode.ts';
import { WaveformVisualizer } from '../WaveformVisualizer.ts';
import { getCachedAudioBufferSync } from '../../audioBufferCache.ts';
import { getDroppedAudioItems, hasAudioDragPayload } from '../dragPayload.ts';
import { isFieldOperatorExpression } from '../../../../ermes/ts/slotLanguage.ts';
import { resolvePoolItemByQuery } from '../../../../ermes/ts/assetResolver.ts';
import { SlotStrip } from './SlotStrip.ts';

function getLoadedAssetBasename(node: BaseNode, poolItems?: any[], poolSeed?: any): string {
    const activeIdx = Math.max(0, Number((node as any).activeSlotIndex ?? node.properties?.active_slot ?? 0));
    const q = String(node.properties?.pool_query ?? '').trim();
    if (isFieldOperatorExpression(q)) {
        const liveFp = String(node._liveTriggeredFilepath || '');
        if (liveFp) return liveFp.split(/[\\/]/).pop() || liveFp;
        if (Array.isArray(poolItems) && poolItems.length > 0) {
            const chosen = resolvePoolItemByQuery(
                poolItems,
                q,
                activeIdx,
                node.properties?.seed ?? poolSeed ?? 42,
                false,
                node.getTriggerCount()
            );
            const chosenFp = String(chosen?.name || chosen?.absolute_path || chosen?.filepath || '');
            if (chosenFp) return chosenFp.split(/[\\/]/).pop() || chosenFp;
        }
    }
    const slotFp = Array.isArray(node.properties?.slots) ? String(node.properties.slots[activeIdx]?.filepath || '') : '';
    const filepath = String(node.properties?.filepath || slotFp || '');
    if (filepath) return filepath.split(/[\\/]/).pop() || filepath;
    return '';
}

export class WaveformCropSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        container.innerHTML = `
            <div class="waveform-crop-wrapper" style="display: flex; flex-direction: column; gap: 6px;">
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
        const assignedModifier = typeof node.getAttachedPoolNode === 'function'
            ? node.getAttachedPoolNode()
            : null;
        const poolItems = Array.isArray(assignedModifier?.properties?.selected_items)
            ? assignedModifier.properties.selected_items
            : [];
        const isPoolOpen = Boolean(node.isPoolViewOpen);

        const assetRow = document.createElement('div');
        assetRow.className = 'waveform-asset-row';
        titleEl.replaceWith(assetRow);

        const selectorInput = document.createElement('input');
        selectorInput.type = 'text';
        selectorInput.className = 'waveform-asset-title td-pool-selector-input';
        selectorInput.placeholder = (assignedModifier || isPoolOpen)
            ? 'Pool: name, index (0..), or rand'
            : 'Drop sample or select from Pool';
        selectorInput.title = 'Click to view/edit pool expression (name, index 0.., or "rand") · Drop sample to load';
        selectorInput.setAttribute('aria-label', 'Sample name or pool query');

        const isPoolCalculated = (): boolean => {
            return isFieldOperatorExpression(node.properties?.pool_query);
        };

        const getEditableExpression = (): string => {
            const mixedPath = node.hasMixedSlotValues?.('filepath') ?? false;
            const mixedQuery = node.hasMixedSlotValues?.('pool_query') ?? false;
            if (mixedPath && mixedQuery) return '';
            const q = String(node.properties?.pool_query ?? '').trim();
            if (isFieldOperatorExpression(q)) return q;
            return getLoadedAssetBasename(node, poolItems, assignedModifier?.properties?.seed);
        };

        const syncSelectorDisplay = () => {
            if (document.activeElement === selectorInput) return;
            const mixedPath = node.hasMixedSlotValues?.('filepath') ?? false;
            if (mixedPath) {
                selectorInput.value = '';
                selectorInput.classList.remove('is-pool-computed');
                return;
            }
            const loadedBasename = getLoadedAssetBasename(node, poolItems, assignedModifier?.properties?.seed);
            const q = String(node.properties?.pool_query ?? '').trim();
            selectorInput.value = loadedBasename || (isFieldOperatorExpression(q) ? q : '');
            selectorInput.classList.toggle('is-pool-computed', isPoolCalculated());
        };
        syncSelectorDisplay();

        let expressionBeforeFocus = '';
        let committedOnEnter = false;

        const commitSelectorQuery = async () => {
            const raw = selectorInput.value.trim();
            if (raw === expressionBeforeFocus && !node.hasMixedSlotValues?.('pool_query')) {
                syncSelectorDisplay();
                return;
            }
            const sampleWithPool = node as BaseNode & { applyPoolQuery?: (q: string) => boolean };
            if (typeof sampleWithPool.applyPoolQuery === 'function' && (assignedModifier || raw)) {
                if (isFieldOperatorExpression(raw)) {
                    node.resetTriggerCount?.();
                }
                const matched = sampleWithPool.applyPoolQuery(raw);
                if (matched) {
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                    return;
                }
            }
            if (raw && !assignedModifier) {
                node.updateProperty('node_name', raw);
            }
            syncSelectorDisplay();
        };

        selectorInput.addEventListener('focus', () => {
            committedOnEnter = false;
            expressionBeforeFocus = getEditableExpression();
            selectorInput.value = expressionBeforeFocus;
            selectorInput.classList.remove('is-pool-computed');
            selectorInput.select();
        });

        selectorInput.addEventListener('blur', () => {
            if (!committedOnEnter) {
                void commitSelectorQuery();
            } else {
                syncSelectorDisplay();
            }
        });

        selectorInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                committedOnEnter = true;
                void commitSelectorQuery().then(() => {
                    selectorInput.blur();
                });
            } else if (event.key === 'Escape') {
                event.preventDefault();
                committedOnEnter = true;
                selectorInput.blur();
                syncSelectorDisplay();
            }
        });

        const assetActions = document.createElement('span');
        assetActions.className = 'waveform-asset-actions';

        const poolButton = document.createElement('button');
        poolButton.type = 'button';
        poolButton.className = `waveform-asset-button waveform-pool-button ${assignedModifier ? 'is-assigned' : ''} ${isPoolOpen ? 'is-active' : ''}`;
        poolButton.textContent = poolItems.length > 0 ? `POOL · ${poolItems.length}` : 'POOL';
        poolButton.title = isPoolOpen ? 'Show Sample Parameters' : 'Toggle Sample Pool';
        poolButton.setAttribute('aria-label', poolButton.title);
        poolButton.setAttribute('aria-pressed', String(isPoolOpen));
        poolButton.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', {
                detail: { nodeId: node.id, toggleInline: true }
            }));
        });

        assetActions.append(poolButton);
        assetRow.append(selectorInput, assetActions);

        const sampleNode = node as BaseNode & {
            activeSlotIndex?: number;
            selectedSlotIndices?: number[];
            getSlots?: () => any[];
            getSelectedSlotIndices?: () => number[];
            selectSlot?: (index: number, options?: { toggle?: boolean; range?: boolean }) => void;
            addSlot?: () => number;
            removeSlot?: (index?: number) => void;
            loadDroppedItemsIntoSlots?: (items: any[], target?: number | 'plus') => Promise<void>;
        };

        const handleDroppedAudioItems = async (dataTransfer: DataTransfer, target?: number | 'plus') => {
            const items = getDroppedAudioItems(dataTransfer);
            if (items.length === 0) return;
            if (typeof sampleNode.loadDroppedItemsIntoSlots === 'function') {
                await sampleNode.loadDroppedItemsIntoSlots(items, target);
            }
            windowContext?.refreshAudioPreview?.();
            await windowContext?.renderTabContent?.();
        };

        let visualizer: WaveformVisualizer | null = null;

        const updateCropInputs = (s: number, e: number) => {
            const root: ParentNode = windowContext?.container || container.closest('.td-properties-window') || document;
            const startInput = root.querySelector('[data-field-key="crop_start"] input') as HTMLInputElement | null;
            const endInput = root.querySelector('[data-field-key="crop_end"] input') as HTMLInputElement | null;
            const mixedStart = node.hasMixedSlotValues?.('crop_start') ?? false;
            const mixedEnd = node.hasMixedSlotValues?.('crop_end') ?? false;
            const sVal = mixedStart ? '' : (Math.round(s * 100) / 100).toFixed(2);
            const eVal = mixedEnd ? '' : (Math.round(e * 100) / 100).toFixed(2);
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

        const syncVisualizerForActiveSlot = (isLiveTelemetry = false) => {
            if (!visualizer) return;
            const activeSlot = sampleNode.activeSlotIndex ?? 0;
            const slotFp = Array.isArray(node.properties?.slots) ? String(node.properties.slots[activeSlot]?.filepath || '') : '';
            const hasCalcPool = isFieldOperatorExpression(node.properties?.pool_query);
            const liveFp = hasCalcPool ? String(node._liveTriggeredFilepath || '') : '';
            const fp = String(liveFp || node.properties?.filepath || slotFp || '');
            const s = node.hasFieldOperator?.('crop_start')
                ? Number(node.evaluateFieldOperatorForKey('crop_start', node.getFieldOperator('crop_start')))
                : Number(node.properties?.crop_start ?? 0);
            const e = node.hasFieldOperator?.('crop_end')
                ? Number(node.evaluateFieldOperatorForKey('crop_end', node.getFieldOperator('crop_end')))
                : Number(node.properties?.crop_end ?? 1);
            visualizer.setCrop(s, e, true);
            if (!fp) {
                visualizer.setAudioBufferSync(null);
                updateTimeLabels(s, e);
                return;
            }
            const slotBuf = (node as any).slotBuffers?.get?.(activeSlot);
            const cachedBuf = (slotBuf && (node as any).slotLoadedPaths?.get?.(activeSlot) === fp)
                ? slotBuf
                : ((node as any).audioBuffer && (node as any).loadedFilepath === fp)
                    ? (node as any).audioBuffer
                    : getCachedAudioBufferSync(fp);
            if (cachedBuf) {
                visualizer.setAudioBufferSync(cachedBuf);
                const audioDur = visualizer.getDuration();
                const curDur = Number(node.properties.duration_seconds);
                if (!isLiveTelemetry && audioDur > 0 && (!Number.isFinite(curDur) || curDur <= 0 || Math.abs(curDur - audioDur) > 0.05)) {
                    node.updateProperty('duration_seconds', audioDur);
                }
                updateTimeLabels(s, e);
            } else {
                void visualizer.loadAudio(fp).then(() => {
                    if (windowContext?.currentWaveformVisualizer !== visualizer || windowContext?.disposed) return;
                    const audioDur = visualizer?.getDuration() || 0;
                    const curDur = Number(node.properties.duration_seconds);
                    if (!isLiveTelemetry && audioDur > 0 && (!Number.isFinite(curDur) || curDur <= 0 || Math.abs(curDur - audioDur) > 0.05)) {
                        node.updateProperty('duration_seconds', audioDur);
                    }
                    const crop = visualizer!.getCrop();
                    updateTimeLabels(crop.start, crop.end);
                    updateCropInputs(crop.start, crop.end);
                });
            }
        };

        if (typeof sampleNode.getSlots === 'function') {
            const slots = sampleNode.getSlots();
            const stripEl = SlotStrip.render({
                node,
                slots,
                slotCount: slots.length,
                activeSlot: sampleNode.activeSlotIndex ?? 0,
                selectedSlots: sampleNode.getSelectedSlotIndices?.() ?? [sampleNode.activeSlotIndex ?? 0],
                accentColor: (node as any).nodeColor || (node as any).color || '#10b981',
                canAcceptDrop: hasAudioDragPayload,
                onSelect: async (idx, modifiers) => {
                    sampleNode.selectSlot?.(idx, modifiers);
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onDragHoverSlot: (idx) => {
                    sampleNode.selectSlot?.(idx);
                    syncSelectorDisplay();
                    syncVisualizerForActiveSlot();
                },
                onDropOnSlot: (idx, dt) => {
                    void handleDroppedAudioItems(dt, idx);
                },
                onDropOnAdd: (dt) => {
                    void handleDroppedAudioItems(dt, 'plus');
                },
                onAdd: async () => {
                    sampleNode.addSlot?.();
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onRemove: async (idx) => {
                    sampleNode.removeSlot?.(idx);
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onPaste: async () => {
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                }
            });
            assetRow.before(stripEl);
        }

        // Allow dropping audio onto both the title input and the waveform dropTarget
        for (const targetEl of [dropTarget, selectorInput]) {
            targetEl.addEventListener('dragover', event => {
                if (!hasAudioDragPayload(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                targetEl.classList.add('is-dragover');
            });
            targetEl.addEventListener('dragleave', event => {
                if (!targetEl.contains(event.relatedTarget as Node | null)) {
                    targetEl.classList.remove('is-dragover');
                }
            });
            targetEl.addEventListener('drop', event => {
                if (!hasAudioDragPayload(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                targetEl.classList.remove('is-dragover');
                if (!event.dataTransfer) return;
                void handleDroppedAudioItems(event.dataTransfer);
            });
        }

        const initialS = node.properties.crop_start !== undefined ? Number(node.properties.crop_start) : 0.0;
        const initialE = node.properties.crop_end !== undefined ? Number(node.properties.crop_end) : 1.0;
        const getNodeColor = () => (node as any).nodeColor || (node as any).color || node.properties?.color || '#059669';

        visualizer = new WaveformVisualizer({
            container: visContainer,
            cropStart: initialS,
            cropEnd: initialE,
            waveformColor: getNodeColor(),
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

        const onPropChanged = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id && (detail?.key === 'color' || detail?.property === 'color')) {
                visualizer?.setWaveformColor(detail.value || getNodeColor());
            }
        };
        const onNodeRefreshed = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id) {
                const isLive = Boolean(detail?.liveTelemetry);
                if (isLive) {
                    const hasCalcPool = isFieldOperatorExpression(node.properties?.pool_query);
                    const hasCalcCrop = Boolean(node.hasFieldOperator?.('crop_start') || node.hasFieldOperator?.('crop_end'));
                    if (!hasCalcPool && !hasCalcCrop) {
                        return;
                    }
                }
                visualizer?.setWaveformColor(getNodeColor());
                syncSelectorDisplay();
                syncVisualizerForActiveSlot(isLive);
            }
        };
        window.addEventListener('node-property-changed', onPropChanged);
        window.addEventListener('node-properties-refreshed', onNodeRefreshed);

        const origDestroy = visualizer.destroy.bind(visualizer);
        visualizer.destroy = () => {
            window.removeEventListener('node-property-changed', onPropChanged);
            window.removeEventListener('node-properties-refreshed', onNodeRefreshed);
            origDestroy();
        };

        windowContext.currentWaveformVisualizer = visualizer;
        windowContext.updateCropFromFields = (s: number, e: number) => {
            visualizer?.setCrop(s, e, true);
            updateTimeLabels(s, e);
        };

        syncVisualizerForActiveSlot();
        updateCropInputs(initialS, initialE);
    }
}
