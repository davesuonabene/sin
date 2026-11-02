import { type BaseNode, getDefaultFxChain } from '../../nodes/BaseNode.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from '../ParameterWheelMenu.ts';

function linearToDb(gain: number): number {
    if (gain <= 0.0001) return -36;
    return Math.max(-36, Math.min(12, 20 * Math.log10(gain)));
}

function dbToLinear(db: number): number {
    return db <= -35.9 ? 0 : Math.pow(10, db / 20);
}

function formatDb(db: number): string {
    if (db <= -35.9) return '-inf dB';
    if (Math.abs(db) < 0.05) return '0.0 dB';
    return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function makeGainControl(
    module: any,
    label: string,
    node: BaseNode,
    chain: any[]
): HTMLElement {
    const box = document.createElement('div');
    box.className = 'td-interactive-float-box';
    box.title = `${label} (drag to adjust, double-click to type)`;
    box.innerHTML = `<span class="float-label">${label}</span><span class="float-val-text"></span>`;

    let currentDb = module.params?.gain_db !== undefined
        ? Number(module.params.gain_db)
        : linearToDb(Number(module.params?.gain ?? 1));
    module.params = module.params || {};
    if (module.params.gain_db === undefined) {
        module.params.gain_db = currentDb;
        module.params.gain = dbToLinear(currentDb);
    }
    const renderValue = () => {
        const valueEl = box.querySelector('.float-val-text') as HTMLElement | null;
        if (valueEl) valueEl.textContent = formatDb(currentDb);
    };
    const commit = (db: number) => {
        const rounded = Math.max(-36, Math.min(12, Math.round(db * 10) / 10));
        if (rounded === currentDb && module.params?.gain_db !== undefined) return;
        currentDb = rounded;
        renderValue();
        module.params = {
            ...(module.params || {}),
            gain: dbToLinear(currentDb),
            gain_db: currentDb,
        };
        node.updateProperty('chain', chain.map((m: any) => (m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m)));
    };
    renderValue();

    let dragging = false;
    let startX = 0;
    let startDb = currentDb;
    let pendingRaf = 0;
    box.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        startDb = currentDb;
        box.setPointerCapture?.(event.pointerId);
        box.classList.add('dragging');
        event.preventDefault();
    });
    box.addEventListener('pointermove', event => {
        if (!dragging) return;
        const targetDb = startDb + (event.clientX - startX) * 0.15;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0;
            if (dragging) {
                commit(targetDb);
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
            commit(startDb + delta);
        }
        box.classList.remove('dragging');
        box.releasePointerCapture?.(event.pointerId);
    };
    box.addEventListener('pointerup', stopDragging);
    box.addEventListener('pointercancel', stopDragging);

    registerParameterWheelControl(box, {
        isInteger: false,
        getValue: () => currentDb,
        setValue: (db) => commit(db),
        formatValue: (db) => formatDb(Math.max(-36, Math.min(12, db))),
    });
    box.addEventListener('wheel', event => {
        event.preventDefault();
        if (event.altKey) return;
        const direction = event.deltaY < 0 ? 1 : -1;
        const step = getParameterWheelStep(false);
        commit(roundStepValue(currentDb + direction * step, step));
    }, { passive: false });

    box.addEventListener('dblclick', event => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-float-direct-input';
        input.min = '-36';
        input.max = '12';
        input.step = '0.1';
        input.value = currentDb.toFixed(1);
        box.replaceChildren(input);
        input.focus();
        input.select();
        const finish = () => {
            const parsed = Number(input.value);
            box.innerHTML = `<span class="float-label">${label}</span><span class="float-val-text"></span>`;
            commit(Number.isFinite(parsed) ? parsed : currentDb);
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') finish();
            if (event.key === 'Escape') {
                box.innerHTML = `<span class="float-label">${label}</span><span class="float-val-text">${formatDb(currentDb)}</span>`;
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
        const chain = rawChain.filter((m: any) => m && String(m.type || 'gain').toLowerCase() === 'gain');
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
            const card = document.createElement('div');
            const isPreGain = index === 0;
            const isPostGain = index === chain.length - 1 && index > 0;
            const label = isPreGain ? 'Pre Gain' : (isPostGain ? 'Post Gain' : (module.name || 'Gain'));
            card.className = `fx-module-card fixed ${isPreGain ? 'pre-gain' : ''} ${isPostGain ? 'post-gain' : ''}`;
            card.appendChild(makeGainControl(module, label, node, chain));
            listContainer.appendChild(card);
        });
    }
}
