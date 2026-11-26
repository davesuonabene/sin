import { type BaseNode, getDefaultFxChain } from '../../nodes/BaseNode.ts';
import {
    type ChainModuleInstance,
    type DspProcessorDef,
    type ProcessorParamDef,
    dbToLinear,
    formatDb,
    getUserFxStages,
    isFixedPostGain,
    isFixedPreGain,
    isRegisteredProcessor,
    linearToDb,
    listAddableProcessors,
    paramDefToFieldSchema,
} from '../../dsp/processorRegistry.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from '../ParameterWheelMenu.ts';
import { WidgetFactory } from '../WidgetFactory.ts';
import { createFxVisualWidget, type FxVisualHandle } from './fx/FxVisualWidgets.ts';
import { renderIcon } from '../../../../packages/ui/src/icons.js';

const containerCleanups = new WeakMap<HTMLElement, () => void>();

function readEndpointDb(module: any): number {
    const p = module?.params || {};
    if (p.gain_db !== undefined) return Number(p.gain_db);
    if (p.gain !== undefined) return linearToDb(Number(p.gain));
    return 0;
}

function makeGainTrimBar(
    module: any,
    label: string,
    node: BaseNode,
    chain: any[],
    onTrimChanged?: () => void
): HTMLElement {
    const param: ProcessorParamDef = {
        key: 'gain_db',
        label,
        unit: 'dB',
        min: -36,
        max: 12,
        step: 0.1,
        defaultValue: 0,
        paramIndex: 0,
        kind: 'db',
        scale: 'linear',
    };

    const bar = document.createElement('div');
    bar.className = 'fx-trim-bar';

    const box = document.createElement('div');
    box.className = 'td-interactive-float-box fx-trim-box';
    box.title = `${label} (drag to adjust, double-click to type)`;
    box.innerHTML = `<span class="td-float-fill" aria-hidden="true"></span><span class="float-label">${label}</span><span class="float-val-text"></span>`;

    module.params = module.params || {};
    let currentVal = readEndpointDb(module);
    if (module.params.gain_db === undefined) {
        module.params.gain_db = currentVal;
        module.params.gain = dbToLinear(currentVal);
    }

    const renderValue = () => {
        const valueEl = box.querySelector('.float-val-text') as HTMLElement | null;
        if (valueEl) valueEl.textContent = formatDb(currentVal);
        const fillEl = box.querySelector('.td-float-fill') as HTMLElement | null;
        if (fillEl) {
            const span = (param.max - param.min) || 1;
            const valPct = Math.max(0, Math.min(100, ((currentVal - param.min) / span) * 100));
            const zeroPct = Math.max(0, Math.min(100, ((0 - param.min) / span) * 100));
            fillEl.style.left = `${Math.min(zeroPct, valPct)}%`;
            fillEl.style.width = `${Math.abs(valPct - zeroPct)}%`;
            fillEl.dataset.polarity = currentVal >= 0 ? 'pos' : 'neg';
        }
    };

    const commit = (nextRaw: number) => {
        const clamped = Math.max(param.min, Math.min(param.max, Math.round(nextRaw * 10) / 10));
        if (clamped === currentVal && module.params?.gain_db !== undefined) return;
        currentVal = clamped;
        renderValue();
        module.params = {
            ...(module.params || {}),
            gain_db: currentVal,
            gain: dbToLinear(currentVal),
        };
        node.updateProperty(
            'chain',
            chain.map((m: any) => (m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m))
        );
        onTrimChanged?.();
    };
    renderValue();

    let dragging = false;
    let startX = 0;
    let startVal = currentVal;
    let pendingRaf = 0;
    box.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        startVal = currentVal;
        box.setPointerCapture?.(event.pointerId);
        box.classList.add('dragging');
        event.preventDefault();
    });
    box.addEventListener('pointermove', event => {
        if (!dragging) return;
        const targetVal = startVal + (event.clientX - startX) * 0.15;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0;
            if (dragging) commit(targetVal);
        });
    });
    const stopDragging = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        if (pendingRaf) {
            cancelAnimationFrame(pendingRaf);
            pendingRaf = 0;
        }
        const delta = (event.clientX - startX) * 0.15;
        if (Math.abs(delta) >= 0.05) commit(startVal + delta);
        box.classList.remove('dragging');
        box.releasePointerCapture?.(event.pointerId);
    };
    box.addEventListener('pointerup', stopDragging);
    box.addEventListener('pointercancel', stopDragging);

    registerParameterWheelControl(box, {
        isInteger: false,
        getValue: () => currentVal,
        setValue: v => commit(v),
        formatValue: v => formatDb(Math.max(param.min, Math.min(param.max, v))),
    });
    box.addEventListener('wheel', event => {
        event.preventDefault();
        if (event.altKey) return;
        const direction = event.deltaY < 0 ? 1 : -1;
        const step = getParameterWheelStep(false);
        commit(roundStepValue(currentVal + direction * step, step));
    }, { passive: false });

    box.addEventListener('dblclick', event => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-float-direct-input';
        input.min = String(param.min);
        input.max = String(param.max);
        input.step = String(param.step);
        input.value = currentVal.toFixed(1);
        box.replaceChildren(input);
        input.focus();
        input.select();
        const finish = () => {
            const parsed = Number(input.value);
            box.innerHTML = `<span class="td-float-fill" aria-hidden="true"></span><span class="float-label">${label}</span><span class="float-val-text"></span>`;
            const next = Number.isFinite(parsed) ? parsed : currentVal;
            if (next === currentVal) renderValue();
            else commit(next);
        };
        input.addEventListener('keydown', evt => {
            if (evt.key === 'Enter') finish();
            if (evt.key === 'Escape') {
                box.innerHTML = `<span class="td-float-fill" aria-hidden="true"></span><span class="float-label">${label}</span><span class="float-val-text"></span>`;
                renderValue();
            }
        });
        input.addEventListener('blur', finish, { once: true });
    });

    bar.appendChild(box);
    return bar;
}

function normalizeChainWithEndpoints(node: BaseNode): any[] {
    let rawChain: any[] = Array.isArray(node.properties.chain) ? node.properties.chain : [];
    if (rawChain.length === 0) {
        rawChain = getDefaultFxChain();
        node.updateProperty('chain', rawChain);
    }
    const filtered = rawChain.filter((m: any) => m && isRegisteredProcessor(m.type));
    const pre = filtered.find(isFixedPreGain) || getDefaultFxChain()[0];
    const post = filtered.find(isFixedPostGain) || getDefaultFxChain()[1];
    const middle = filtered.filter((m: any) => !isFixedPreGain(m) && !isFixedPostGain(m));
    const normalized = [pre, ...middle, post];
    if (normalized.length !== rawChain.length || !filtered.some(isFixedPreGain) || !filtered.some(isFixedPostGain)) {
        node.properties.chain = normalized;
    }
    return normalized;
}

export class FxChainSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        // Tear down any previous render attached to this container before creating new handles
        const prevCleanup = containerCleanups.get(container);
        if (prevCleanup) {
            prevCleanup();
            containerCleanups.delete(container);
        }

        const chain = normalizeChainWithEndpoints(node);
        const preModule = chain[0];
        const postModule = chain[chain.length - 1];
        const userStages = getUserFxStages(chain);

        const activeVisualHandles = new Map<number, FxVisualHandle>();
        let cleaned = false;

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group fx-chain-group';

        const refreshActiveScopes = () => {
            activeVisualHandles.forEach(h => h.refreshWaveform?.());
        };

        // 1. Compact Pre Gain trim bar
        wrapper.appendChild(makeGainTrimBar(preModule, 'Pre Gain', node, chain, refreshActiveScopes));

        // 2. Chain Header + Add FX button
        const header = document.createElement('div');
        header.className = 'fx-chain-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'fx-chain-title-wrap';
        titleWrap.innerHTML = `<span class="fx-chain-title">FX Chain</span><span class="fx-chain-count">${userStages.length}</span>`;

        const addWrap = document.createElement('div');
        addWrap.className = 'fx-add-wrap';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'fx-add-btn';
        addBtn.innerHTML = `${renderIcon('plus')} <span>Add FX</span>`;
        const addMenu = document.createElement('div');
        addMenu.className = 'fx-add-menu sin-menu-surface';
        addMenu.hidden = true;

        const commitChainUpdate = (nextChain: any[], reRender = true) => {
            const cloned = nextChain.map((m: any) =>
                m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m
            );
            node.updateProperty('chain', cloned);
            windowContext?.refreshAudioPreview?.();
            if (reRender) {
                void FxChainSection.rerender(container, node, windowContext);
            }
        };

        for (const procDef of listAddableProcessors()) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'fx-add-menu-item sin-menu-item';
            item.textContent = procDef.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                addMenu.hidden = true;
                const modId = `${procDef.type}_${Math.random().toString(36).substring(2, 7)}`;
                const newMod = procDef.createModule(modId, procDef.label, { expanded: false, viewMode: 'visual' });
                const middle = chain.slice(1, -1);
                const nextChain = [preModule, ...middle, newMod, postModule];
                commitChainUpdate(nextChain, true);
            });
            addMenu.appendChild(item);
        }

        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addMenu.hidden = !addMenu.hidden;
        });
        const closeMenu = (e: Event) => {
            if (cleaned || !wrapper.isConnected) {
                document.removeEventListener('pointerdown', closeMenu);
                return;
            }
            if (!addWrap.contains(e.target as Node)) {
                addMenu.hidden = true;
            }
        };
        document.addEventListener('pointerdown', closeMenu);

        addWrap.append(addBtn, addMenu);
        header.append(titleWrap, addWrap);
        wrapper.appendChild(header);

        // 3. Serial FX Modules List
        const listContainer = document.createElement('div');
        listContainer.className = 'fx-chain-list';
        listContainer.id = 'fx-chain-list';
        wrapper.appendChild(listContainer);

        if (userStages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'fx-chain-empty';
            empty.textContent = 'No FX modules — click + Add FX to insert';
            listContainer.appendChild(empty);
        } else {
            let dragSourceChainIdx: number | null = null;

            userStages.forEach(({ module: mod, def, stageIndex, chainIndex }) => {
                const row = document.createElement('div');
                row.className = `fx-module-row ${mod.enabled === false ? 'is-bypassed' : ''} ${mod.expanded ? 'is-expanded' : ''}`;
                row.draggable = true;
                row.dataset.stageIndex = String(stageIndex);
                row.dataset.moduleId = String(mod.id);

                row.addEventListener('dragstart', (e) => {
                    dragSourceChainIdx = chainIndex;
                    row.classList.add('is-dragging');
                    e.dataTransfer?.setData('text/plain', String(chainIndex));
                });
                row.addEventListener('dragend', () => {
                    dragSourceChainIdx = null;
                    row.classList.remove('is-dragging');
                    listContainer.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
                });
                row.addEventListener('dragover', (e) => {
                    if (dragSourceChainIdx === null || dragSourceChainIdx === chainIndex) return;
                    e.preventDefault();
                    row.classList.add('is-drag-over');
                });
                row.addEventListener('dragleave', () => {
                    row.classList.remove('is-drag-over');
                });
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    row.classList.remove('is-drag-over');
                    if (dragSourceChainIdx === null || dragSourceChainIdx === chainIndex) return;
                    const nextChain = [...chain];
                    const [moved] = nextChain.splice(dragSourceChainIdx, 1);
                    const insertAt = Math.max(1, Math.min(nextChain.length - 1, chainIndex));
                    nextChain.splice(insertAt, 0, moved);
                    commitChainUpdate(nextChain, true);
                });

                const rowHeader = document.createElement('div');
                rowHeader.className = 'fx-module-header';

                const dragHandle = document.createElement('span');
                dragHandle.className = 'fx-drag-handle';
                dragHandle.title = 'Drag to reorder';
                dragHandle.textContent = '⋮⋮';

                const bypassBtn = document.createElement('button');
                bypassBtn.type = 'button';
                bypassBtn.className = `fx-bypass-btn ${mod.enabled === false ? '' : 'is-active'}`;
                bypassBtn.title = mod.enabled === false ? 'Enable FX' : 'Bypass FX';
                bypassBtn.innerHTML = '<span class="fx-bypass-dot"></span>';
                bypassBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    mod.enabled = mod.enabled === false;
                    row.classList.toggle('is-bypassed', mod.enabled === false);
                    bypassBtn.classList.toggle('is-active', mod.enabled !== false);
                    commitChainUpdate(chain, false);
                });

                const nameEl = document.createElement('span');
                nameEl.className = 'fx-module-name';
                nameEl.textContent = mod.name || def.label;

                const actions = document.createElement('div');
                actions.className = 'fx-module-actions';

                const modeBtn = document.createElement('button');
                modeBtn.type = 'button';
                const currentMode = mod.viewMode === 'numeric' ? 'numeric' : 'visual';
                modeBtn.className = `fx-icon-btn fx-mode-toggle-btn ${currentMode === 'numeric' ? 'is-numeric' : 'is-visual'}`;
                modeBtn.title = currentMode === 'visual' ? 'Switch to Numeric Fields' : 'Switch to Visual GUI';
                modeBtn.innerHTML = renderIcon(currentMode === 'visual' ? 'sliders' : 'activity');

                const expandBtn = document.createElement('button');
                expandBtn.type = 'button';
                expandBtn.className = 'fx-icon-btn fx-expand-btn';
                expandBtn.title = mod.expanded ? 'Collapse' : 'Expand';
                expandBtn.innerHTML = renderIcon(mod.expanded ? 'chevronDown' : 'chevronRight');

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'fx-icon-btn fx-remove-btn';
                removeBtn.title = 'Remove FX';
                removeBtn.innerHTML = renderIcon('close');
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nextChain = chain.filter((_, idx) => idx !== chainIndex);
                    commitChainUpdate(nextChain, true);
                });

                actions.append(modeBtn, expandBtn, removeBtn);
                rowHeader.append(dragHandle, bypassBtn, nameEl, actions);
                row.appendChild(rowHeader);

                const body = document.createElement('div');
                body.className = 'fx-module-body';
                body.hidden = !mod.expanded;
                row.appendChild(body);

                const mountBody = () => {
                    const prev = activeVisualHandles.get(stageIndex);
                    if (prev) {
                        prev.destroy();
                        activeVisualHandles.delete(stageIndex);
                    }
                    body.replaceChildren();
                    if (!mod.expanded) {
                        body.hidden = true;
                        return;
                    }
                    body.hidden = false;

                    if (mod.viewMode === 'numeric') {
                        const fieldsWrap = document.createElement('div');
                        fieldsWrap.className = 'fx-numeric-fields';
                        for (const pDef of def.params) {
                            const schema = paramDefToFieldSchema(mod.id, pDef);
                            const fieldRow = WidgetFactory.createRow(schema, node, () => {
                                windowContext?.refreshAudioPreview?.();
                            });
                            fieldsWrap.appendChild(fieldRow);
                        }
                        body.appendChild(fieldsWrap);
                        windowContext?.applyOverlays?.();
                    } else {
                        const handle = createFxVisualWidget({
                            node,
                            module: mod as ChainModuleInstance,
                            def: def as DspProcessorDef,
                            onParamChange: (paramKey, value) => {
                                mod.params = { ...(mod.params || {}), [paramKey]: value };
                                node.updateProperty(
                                    'chain',
                                    chain.map((m: any) =>
                                        m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m
                                    )
                                );
                            },
                        });
                        if (handle) {
                            activeVisualHandles.set(stageIndex, handle);
                            body.appendChild(handle.element);
                        }
                    }
                };

                const toggleExpand = () => {
                    mod.expanded = !mod.expanded;
                    row.classList.toggle('is-expanded', Boolean(mod.expanded));
                    expandBtn.innerHTML = renderIcon(mod.expanded ? 'chevronDown' : 'chevronRight');
                    expandBtn.title = mod.expanded ? 'Collapse' : 'Expand';
                    mountBody();
                };

                rowHeader.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement)?.closest('button')) return;
                    toggleExpand();
                });
                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleExpand();
                });

                modeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    mod.viewMode = mod.viewMode === 'numeric' ? 'visual' : 'numeric';
                    if (!mod.expanded) {
                        mod.expanded = true;
                        row.classList.add('is-expanded');
                        expandBtn.innerHTML = renderIcon('chevronDown');
                    }
                    const nextMode = mod.viewMode;
                    modeBtn.className = `fx-icon-btn fx-mode-toggle-btn ${nextMode === 'numeric' ? 'is-numeric' : 'is-visual'}`;
                    modeBtn.title = nextMode === 'visual' ? 'Switch to Numeric Fields' : 'Switch to Visual GUI';
                    modeBtn.innerHTML = renderIcon(nextMode === 'visual' ? 'sliders' : 'activity');
                    mountBody();
                });

                if (mod.expanded) {
                    mountBody();
                }

                listContainer.appendChild(row);
            });
        }

        // 4. Compact Post Gain trim bar
        wrapper.appendChild(makeGainTrimBar(postModule, 'Post Gain', node, chain));

        container.appendChild(wrapper);

        // 5. Telemetry & IRIDE peaks subscriptions (strictly torn down on collapse, tab switch, or panel close)
        let onStageMeters: ((evt: Event) => void) | null = null;
        let onPeaksUpdated: (() => void) | null = null;

        const cleanupSection = () => {
            if (cleaned) return;
            cleaned = true;
            document.removeEventListener('pointerdown', closeMenu);
            if (typeof window !== 'undefined') {
                if (onStageMeters) window.removeEventListener('sin-stage-meters', onStageMeters);
                if (onPeaksUpdated) window.removeEventListener('sin-peaks-updated', onPeaksUpdated);
            }
            activeVisualHandles.forEach(h => h.destroy());
            activeVisualHandles.clear();
        };

        if (typeof window !== 'undefined') {
            onStageMeters = (evt: Event) => {
                if (cleaned || !wrapper.isConnected) {
                    cleanupSection();
                    return;
                }
                if (activeVisualHandles.size === 0) return;
                const detail = (evt as CustomEvent)?.detail as Record<string, Record<number, number>> | undefined;
                const nodeMeters = detail ? detail[String(node.id)] : undefined;
                activeVisualHandles.forEach((handle, sIdx) => {
                    const val = nodeMeters && nodeMeters[sIdx] !== undefined ? Number(nodeMeters[sIdx]) : 0;
                    handle.updateMeter(val);
                });
            };
            onPeaksUpdated = () => {
                if (cleaned || !wrapper.isConnected) {
                    cleanupSection();
                    return;
                }
                if (activeVisualHandles.size === 0) return;
                refreshActiveScopes();
            };
            window.addEventListener('sin-stage-meters', onStageMeters);
            window.addEventListener('sin-peaks-updated', onPeaksUpdated);
        }

        containerCleanups.set(container, cleanupSection);
        windowContext?.registerCleanup?.(cleanupSection);
    }

    private static async rerender(container: HTMLElement, node: BaseNode, windowContext: any): Promise<void> {
        const prevCleanup = containerCleanups.get(container);
        if (prevCleanup) {
            prevCleanup();
            containerCleanups.delete(container);
        }
        container.replaceChildren();
        await FxChainSection.render(container, node, windowContext);
        windowContext?.applyOverlays?.();
    }
}
