import { type BaseNode } from '../../nodes/BaseNode.ts';
import { WaveformVisualizer } from '../WaveformVisualizer.ts';
import { getCachedAudioBufferSync } from '../../audioBufferCache.ts';
import { hasAudioDragPayload, resolveDroppedAudioItems } from '../dragPayload.ts';
import { isFieldOperatorExpression } from '../../../../ermes/ts/slotLanguage.ts';
import { resolveEffectivePoolSeed } from '../../../../ermes/ts/assetResolver.ts';
import { defaultTransportClock } from '../../../../packages/iride/src/index.ts';
import { resolveNodeUnitContext } from '../../fields/UnitConverter.ts';
import { SlotStrip } from './SlotStrip.ts';

function formatSmartLength(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    if (sec < 1) {
        return `${Math.round(sec * 1000)}ms`;
    }
    if (sec < 60) {
        return `${sec.toFixed(2)}s`;
    }
    if (sec < 3600) {
        const mins = Math.floor(sec / 60);
        const rem = sec - mins * 60;
        const whole = Math.floor(rem);
        const cs = Math.round((rem - whole) * 100);
        if (cs >= 100) {
            return `${mins}:${String(whole + 1).padStart(2, '0')}.00`;
        }
        return `${mins}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }
    const totalSec = Math.round(sec);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const remSec = totalSec % 60;
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

export class WaveformCropSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        container.innerHTML = `
            <div class="waveform-crop-wrapper" style="display: flex; flex-direction: column; gap: 4px;">
                <div class="waveform-info-panel"></div>
                <div class="waveform-drop-target">
                    <div class="waveform-visualizer"></div>
                    <div class="waveform-drop-message">Drop sample to load</div>
                </div>
            </div>
        `;

        const visContainer = container.querySelector('.waveform-visualizer') as HTMLElement;
        const dropTarget = container.querySelector('.waveform-drop-target') as HTMLElement;
        const infoPanel = container.querySelector('.waveform-info-panel') as HTMLElement;

        if (!visContainer) return;

        const getPoolContext = () => {
            const assignedModifier = typeof node.getAttachedPoolNode === 'function'
                ? node.getAttachedPoolNode()
                : null;
            const poolItems = typeof (node as any).getPoolItems === 'function'
                ? (node as any).getPoolItems()
                : (Array.isArray(assignedModifier?.properties?.selected_items) ? assignedModifier.properties.selected_items : []);
            const effPoolSeed = resolveEffectivePoolSeed(assignedModifier, node);
            return { assignedModifier, poolItems, effPoolSeed };
        };

        const sampleNode = node as BaseNode & {
            activeSlotIndex?: number;
            selectedSlotIndices?: number[];
            getSlots?: () => any[];
            getSelectedSlotIndices?: () => number[];
            selectSlot?: (index: number, options?: { toggle?: boolean; range?: boolean }) => void;
            addSlot?: () => number;
            removeSlot?: (index?: number) => void;
            loadDroppedItemsIntoSlots?: (items: any[], target?: number | 'plus') => Promise<void>;
            getPlayheadNorm?: (telemetry?: any) => { progress: number | null; isTriggered: boolean };
        };

        // --- Minimal greyed-out retrieved asset info panel (no toggle, always visible) ---
        const idxItem = document.createElement('span');
        idxItem.className = 'waveform-info-item waveform-info-item--readonly';
        idxItem.title = 'Current pool run index & pool count';

        const lenItem = document.createElement('span');
        lenItem.className = 'waveform-info-item waveform-info-item--readonly';
        lenItem.title = 'Active cropped length (updates automatically with Crop Start & End)';

        const makeBorderlessEditableItem = (opts: {
            propKey: 'original_bpm' | 'key';
            label: string;
            placeholder: string;
            formatDisplay: (val: any) => string;
            parseInput: (raw: string) => any;
        }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'waveform-info-item waveform-info-item--editable';
            btn.dataset.metaKey = opts.propKey;

            const renderText = () => {
                const val = node.properties?.[opts.propKey];
                const isOverride = Boolean(node.properties?.[`${opts.propKey}_is_local_override`]);
                const hasProposal = Boolean(node.properties?.[`${opts.propKey}_proposal`]);
                btn.classList.toggle('is-overridden', isOverride || hasProposal);
                btn.innerHTML = `<span class="waveform-info-k">${opts.label}</span><span class="waveform-info-v">${opts.formatDisplay(val)}</span>`;
                btn.title = isOverride || hasProposal
                    ? `${opts.label} (local override · GAIA proposal staged) — click to edit`
                    : `${opts.label} — click to edit locally & propose to GAIA`;
            };
            renderText();

            btn.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'waveform-info-inline-input';
                input.placeholder = opts.placeholder;
                const cur = node.properties?.[opts.propKey];
                input.value = (cur != null && String(cur).trim() !== '') ? String(cur) : '';
                btn.replaceWith(input);
                input.focus();
                input.select();

                let finished = false;
                const finish = async (cancel: boolean) => {
                    if (finished) return;
                    finished = true;
                    const raw = input.value.trim();
                    input.replaceWith(btn);
                    if (!cancel) {
                        const prev = node.properties?.[opts.propKey];
                        const nextVal = opts.parseInput(raw);
                        if (!Object.is(prev, nextVal) && node.preparePropertyEdit(opts.propKey, nextVal, prev) !== false) {
                            node.updateProperty(opts.propKey, nextVal);
                            await node.onPropertyEdited(opts.propKey, nextVal, prev);
                            windowContext?.refreshAudioPreview?.();
                        }
                    }
                    renderText();
                };

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        void finish(false);
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        void finish(true);
                    }
                });
                input.addEventListener('blur', () => void finish(false));
            });

            return { el: btn, sync: renderText };
        };

        const bpmMeta = makeBorderlessEditableItem({
            propKey: 'original_bpm',
            label: 'BPM',
            placeholder: '120',
            formatDisplay: (v) => {
                const n = Number(v);
                return (v != null && v !== '' && Number.isFinite(n) && n > 0) ? `${Number(n.toFixed(1))}` : '—';
            },
            parseInput: (raw) => {
                if (!raw) return null;
                const n = Number(raw);
                return Number.isFinite(n) && n >= 20 && n <= 400 ? n : node.properties?.original_bpm ?? null;
            },
        });

        const keyMeta = makeBorderlessEditableItem({
            propKey: 'key',
            label: 'Key',
            placeholder: 'Am',
            formatDisplay: (v) => {
                const s = String(v || '').trim();
                return s || '—';
            },
            parseInput: (raw) => raw.trim(),
        });

        const extMarker = document.createElement('span');
        extMarker.className = 'waveform-info-ext';
        extMarker.textContent = 'EXT';
        extMarker.style.display = 'none';

        infoPanel.append(idxItem, lenItem, bpmMeta.el, keyMeta.el, extMarker);

        let visualizer: WaveformVisualizer | null = null;

        const syncInfoRow = () => {
            const { poolItems, effPoolSeed } = getPoolContext();
            const dynActive = Boolean(node.isFieldDynamicActive?.('pool_query'));

            const fp = String((isFieldOperatorExpression(node.properties?.pool_query, poolItems) ? node._liveTriggeredFilepath : '') || node.properties?.filepath || '');
            const runIdx = typeof (node as any).findPoolItemRunIndex === 'function'
                ? (node as any).findPoolItemRunIndex({ filepath: fp, id: node.properties?.library_item_id })
                : -1;
            const poolTotal = poolItems.length;
            if (poolTotal > 0 && runIdx >= 0) {
                idxItem.innerHTML = `<span class="waveform-info-k">Idx</span><span class="waveform-info-v ${dynActive ? 'is-pool-computed' : ''}">#${runIdx}/${poolTotal}</span>`;
                idxItem.title = `Pool run index #${runIdx} of ${poolTotal} (seed ${effPoolSeed})`;
            } else if (poolTotal > 0) {
                idxItem.innerHTML = `<span class="waveform-info-k">Pool</span><span class="waveform-info-v">${poolTotal}</span>`;
                idxItem.title = `${poolTotal} asset(s) in Pool`;
            } else {
                idxItem.innerHTML = `<span class="waveform-info-k">Idx</span><span class="waveform-info-v">—</span>`;
                idxItem.title = 'Not in an Asset Pool';
            }

            const ctx = resolveNodeUnitContext(node);
            const dur = visualizer?.getDuration() || ctx.durationSec || 0;
            const cs = Math.max(0, Math.min(1, Number(node.properties?.crop_start ?? 0)));
            const ce = Math.max(cs, Math.min(1, node.properties?.crop_end != null ? Number(node.properties.crop_end) : 1));
            const activeDur = dur * Math.max(0, ce - cs);
            lenItem.innerHTML = `<span class="waveform-info-k">Len</span><span class="waveform-info-v">${formatSmartLength(activeDur)}</span>`;

            bpmMeta.sync();
            keyMeta.sync();

            const isExt = Boolean((node as any).isActiveAssetExternal?.());
            extMarker.style.display = isExt ? '' : 'none';
            if (isExt) {
                extMarker.title = `External local file: ${fp}`;
            }
        };

        const handleDroppedAudioItems = async (dataTransfer: DataTransfer, target?: number | 'plus') => {
            const items = await resolveDroppedAudioItems(dataTransfer);
            if (items.length === 0) return;
            if (typeof sampleNode.loadDroppedItemsIntoSlots === 'function') {
                await sampleNode.loadDroppedItemsIntoSlots(items, target);
            }
            windowContext?.refreshAudioPreview?.();
            await windowContext?.renderTabContent?.();
        };

        const syncVisualizerForActiveSlot = (isLiveTelemetry = false) => {
            if (!visualizer) return;
            const activeSlot = sampleNode.activeSlotIndex ?? 0;
            const slotFp = Array.isArray(node.properties?.slots) ? String(node.properties.slots[activeSlot]?.filepath || '') : '';
            const { poolItems } = getPoolContext();
            const hasDynPool = isFieldOperatorExpression(node.properties?.pool_query, poolItems);
            const liveFp = hasDynPool ? String(node._liveTriggeredFilepath || '') : '';
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
                syncInfoRow();
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
                syncInfoRow();
            } else {
                void visualizer.loadAudio(fp).then(() => {
                    if (windowContext?.currentWaveformVisualizer !== visualizer || windowContext?.disposed) return;
                    const audioDur = visualizer?.getDuration() || 0;
                    const curDur = Number(node.properties.duration_seconds);
                    if (!isLiveTelemetry && audioDur > 0 && (!Number.isFinite(curDur) || curDur <= 0 || Math.abs(curDur - audioDur) > 0.05)) {
                        node.updateProperty('duration_seconds', audioDur);
                    }
                    syncInfoRow();
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
                    syncInfoRow();
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
            infoPanel.before(stripEl);
        }

        // Preserve drag-and-drop audio onto both info panel and waveform dropTarget
        for (const targetEl of [dropTarget, infoPanel]) {
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
                const preciseS = Math.round(s * 1e6) / 1e6;
                const preciseE = Math.round(e * 1e6) / 1e6;
                node.clearFieldOperator?.('crop_start');
                node.clearFieldOperator?.('crop_end');
                node.setStaticFieldValue?.('crop_start', preciseS);
                node.setStaticFieldValue?.('crop_end', preciseE);
                node.updateProperty('crop_start', preciseS);
                node.updateProperty('crop_end', preciseE);
                syncInfoRow();
                windowContext.refreshAudioPreview();
            },
            onScrub: (normPos: number) => {
                window.dispatchEvent(new CustomEvent('sin-sample-scrub', {
                    detail: { nodeId: node.id, normPos },
                }));
            },
        });

        // Live global/native transport playhead synchronization
        let playheadRafId: number | null = null;
        const updatePlayheadVisual = () => {
            if (!visualizer || !visContainer.isConnected) {
                if (playheadRafId !== null) {
                    cancelAnimationFrame(playheadRafId);
                    playheadRafId = null;
                }
                return;
            }
            const telemetry = defaultTransportClock.getTelemetry();
            if (telemetry.isPlaying && typeof sampleNode.getPlayheadNorm === 'function') {
                const { progress, isTriggered } = sampleNode.getPlayheadNorm(telemetry);
                visualizer.setExternalPlayhead(isTriggered ? progress : null);
            } else {
                visualizer.setExternalPlayhead(null);
            }
            playheadRafId = requestAnimationFrame(updatePlayheadVisual);
        };
        playheadRafId = requestAnimationFrame(updatePlayheadVisual);

        const onPropChanged = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id) {
                if (detail?.key === 'color' || detail?.property === 'color') {
                    visualizer?.setWaveformColor(detail.value || getNodeColor());
                }
                if (detail?.key === 'filepath' || detail?.key === 'pool_query') {
                    syncVisualizerForActiveSlot();
                    syncInfoRow();
                } else if (
                    detail?.key === 'original_bpm'
                    || detail?.key === 'key'
                    || detail?.key === 'duration_seconds'
                    || detail?.key === 'crop_start'
                    || detail?.key === 'crop_end'
                ) {
                    syncInfoRow();
                }
            }
        };
        const onNodeRefreshed = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id) {
                const isLive = Boolean(detail?.liveTelemetry);
                if (isLive) {
                    const { poolItems } = getPoolContext();
                    const hasDynPool = isFieldOperatorExpression(node.properties?.pool_query, poolItems);
                    const hasCalcCrop = Boolean(node.hasFieldOperator?.('crop_start') || node.hasFieldOperator?.('crop_end'));
                    if (!hasDynPool && !hasCalcCrop) {
                        return;
                    }
                }
                visualizer?.setWaveformColor(getNodeColor());
                syncVisualizerForActiveSlot(isLive);
                syncInfoRow();
            }
        };
        window.addEventListener('node-property-changed', onPropChanged);
        window.addEventListener('node-properties-refreshed', onNodeRefreshed);

        const origDestroy = visualizer.destroy.bind(visualizer);
        visualizer.destroy = () => {
            if (playheadRafId !== null) {
                cancelAnimationFrame(playheadRafId);
                playheadRafId = null;
            }
            window.removeEventListener('node-property-changed', onPropChanged);
            window.removeEventListener('node-properties-refreshed', onNodeRefreshed);
            origDestroy();
        };

        windowContext.currentWaveformVisualizer = visualizer;
        windowContext.updateCropFromFields = (s: number, e: number) => {
            visualizer?.setCrop(s, e, true);
            syncInfoRow();
        };
        windowContext.syncWaveformAsset = () => {
            syncVisualizerForActiveSlot();
            syncInfoRow();
        };

        syncVisualizerForActiveSlot();
        syncInfoRow();
    }
}
