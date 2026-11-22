import { type BaseNode, getDefaultFxChain } from '../../nodes/BaseNode.ts';
import {
    type DspProcessorDef,
    type ProcessorParamDef,
    dbToLinear,
    formatDb,
    getProcessorDef,
    isRegisteredProcessor,
    linearToDb,
} from '../../dsp/processorRegistry.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from '../ParameterWheelMenu.ts';

function readParamValue(module: any, param: ProcessorParamDef): number {
    const p = module.params || {};
    if (param.kind === 'db') {
        if (p[param.key] !== undefined) return Number(p[param.key]);
        if (p.gain !== undefined) return linearToDb(Number(p.gain));
        return param.defaultValue;
    }
    return p[param.key] !== undefined ? Number(p[param.key]) : param.defaultValue;
}

function formatParamValue(param: ProcessorParamDef, val: number): string {
    if (param.kind === 'db') return formatDb(val);
    const unit = param.unit ? ` ${param.unit}` : '';
    return `${val.toFixed(1)}${unit}`;
}

function makeProcessorParamControl(
    module: any,
    label: string,
    param: ProcessorParamDef,
    node: BaseNode,
    chain: any[]
): HTMLElement {
    const box = document.createElement('div');
    box.className = 'td-interactive-float-box';
    box.title = `${label} (drag to adjust, double-click to type)`;
    box.innerHTML = `<span class="td-float-fill" aria-hidden="true"></span><span class="float-label">${label}</span><span class="float-val-text"></span>`;

    module.params = module.params || {};
    let currentVal = readParamValue(module, param);
    if (param.kind === 'db' && module.params[param.key] === undefined) {
        module.params[param.key] = currentVal;
        module.params.gain = dbToLinear(currentVal);
    }

    const renderValue = () => {
        const valueEl = box.querySelector('.float-val-text') as HTMLElement | null;
        if (valueEl) valueEl.textContent = formatParamValue(param, currentVal);
        const fillEl = box.querySelector('.td-float-fill') as HTMLElement | null;
        if (fillEl) {
            const span = (param.max - param.min) || 1;
            const valPct = Math.max(0, Math.min(100, ((currentVal - param.min) / span) * 100));
            if (param.min < 0 && param.max > 0) {
                const zeroPct = Math.max(0, Math.min(100, ((0 - param.min) / span) * 100));
                const leftPct = Math.min(zeroPct, valPct);
                const widthPct = Math.abs(valPct - zeroPct);
                fillEl.style.left = `${leftPct}%`;
                fillEl.style.width = `${widthPct}%`;
                fillEl.dataset.polarity = currentVal >= 0 ? 'pos' : 'neg';
            } else {
                fillEl.style.left = '0%';
                fillEl.style.width = `${valPct}%`;
                delete fillEl.dataset.polarity;
            }
        }
    };

    const commit = (nextRaw: number) => {
        const clamped = Math.max(param.min, Math.min(param.max, Math.round(nextRaw * 10) / 10));
        if (clamped === currentVal && module.params?.[param.key] !== undefined) return;
        currentVal = clamped;
        renderValue();
        const extra = param.kind === 'db' ? { gain: dbToLinear(currentVal) } : {};
        module.params = {
            ...(module.params || {}),
            [param.key]: currentVal,
            ...extra,
        };
        node.updateProperty(
            'chain',
            chain.map((m: any) => (m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m))
        );
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
            if (dragging) {
                commit(targetVal);
            }
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
        if (Math.abs(delta) >= 0.05) {
            commit(startVal + delta);
        }
        box.classList.remove('dragging');
        box.releasePointerCapture?.(event.pointerId);
    };
    box.addEventListener('pointerup', stopDragging);
    box.addEventListener('pointercancel', stopDragging);

    registerParameterWheelControl(box, {
        isInteger: false,
        getValue: () => currentVal,
        setValue: (v) => commit(v),
        formatValue: (v) => formatParamValue(param, Math.max(param.min, Math.min(param.max, v))),
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
            if (next === currentVal) {
                renderValue();
            } else {
                commit(next);
            }
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') finish();
            if (event.key === 'Escape') {
                box.innerHTML = `<span class="td-float-fill" aria-hidden="true"></span><span class="float-label">${label}</span><span class="float-val-text"></span>`;
                renderValue();
            }
        });
        input.addEventListener('blur', finish, { once: true });
    });
    return box;
}

export class FxChainSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ): Promise<void> {
        if (!node.properties.chain || !Array.isArray(node.properties.chain) || node.properties.chain.length === 0) {
            node.updateProperty('chain', getDefaultFxChain());
        }

        const rawChain: any[] = node.properties.chain;
        const chain = rawChain.filter((m: any) => m && isRegisteredProcessor(m.type));
        if (chain.length === 0) {
            chain.push(...getDefaultFxChain());
        }
        if (chain.length !== rawChain.length) {
            node.properties.chain = chain;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group fx-chain-group';
        wrapper.innerHTML = `
            <div class="fx-chain-header" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-weight: 600; font-size: 11px; color: #475569;">
                <span class="fx-chain-title">Gain Staging</span>
                <span class="fx-chain-count" style="font-size: 10px; color: #64748b;">${chain.length} Stages</span>
            </div>
            <div class="fx-chain-list" id="fx-chain-list"></div>
        `;

        container.appendChild(wrapper);

        const listContainer = wrapper.querySelector('#fx-chain-list') as HTMLElement;
        if (!listContainer) return;

        chain.forEach((module: any, index: number) => {
            const def: DspProcessorDef | undefined = getProcessorDef(module.type);
            if (!def) return;
            const isPreGain = index === 0 && def.type === 'gain';
            const isPostGain = index === chain.length - 1 && index > 0 && def.type === 'gain';
            const card = document.createElement('div');
            card.className = `fx-module-card fixed ${isPreGain ? 'pre-gain' : ''} ${isPostGain ? 'post-gain' : ''}`;
            const stageLabel = isPreGain ? 'Pre Gain' : (isPostGain ? 'Post Gain' : (module.name || def.label));
            def.params.forEach((paramDef, pIdx) => {
                const ctrlLabel = def.params.length === 1 ? stageLabel : `${stageLabel} · ${paramDef.label}`;
                if (pIdx >= 0) {
                    card.appendChild(makeProcessorParamControl(module, ctrlLabel, paramDef, node, chain));
                }
            });
            listContainer.appendChild(card);
        });
    }
}
