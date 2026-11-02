export const FLOAT_LADDER_STEPS = [10, 1, 0.1, 0.01, 0.001] as const;
export const INT_LADDER_STEPS = [100, 10, 1] as const;
export const DEFAULT_FLOAT_STEP = 0.1;
export const DEFAULT_INT_STEP = 1;

const RUNG_HEIGHT = 24;
const HORIZONTAL_LOCK_THRESHOLD = 6;
const PIXELS_PER_STEP = 10;

export interface ParameterWheelAdapter {
    isInteger?: boolean;
    getValue?: () => number;
    setValue?: (nextValue: number) => void;
    formatValue?: (value: number) => string;
}

const controlAdapters = new WeakMap<HTMLElement, ParameterWheelAdapter>();

let selectedFloatStep = DEFAULT_FLOAT_STEP;
let selectedIntStep = DEFAULT_INT_STEP;

let activeControl: HTMLElement | null = null;
let pointerControl: HTMLElement | null = null;
let pointerPosition: { x: number; y: number } | null = null;
let ladderOrigin: { x: number; y: number } | null = null;
let lastScrubX = 0;
let initialRungIndex = 2;
let activeRungIndex = 2;
let activeSteps: readonly number[] = FLOAT_LADDER_STEPS;
let isScrubbing = false;
let ladderEl: HTMLDivElement | null = null;
let ladderIsOpen = false;
let listenersInstalled = false;

export function roundStepValue(value: number, step = DEFAULT_FLOAT_STEP): number {
    if (!Number.isFinite(value)) return 0;
    const stepStr = String(step);
    const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    const precision = Math.min(6, Math.max(stepDecimals, 4));
    return Number(value.toFixed(precision));
}

function getWheelControl(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
        ? target.closest<HTMLElement>('[data-parameter-wheel-control="true"]')
        : null;
}

function isControlEditable(control: HTMLElement | null): control is HTMLElement {
    if (!control || !control.isConnected) return false;
    if ((control as HTMLInputElement).disabled || (control as HTMLInputElement).readOnly) return false;
    if (control.getAttribute('aria-disabled') === 'true') return false;
    if (control.closest('.ghost-bound-parameter')) return false;
    const nestedInput = control.querySelector<HTMLInputElement>('input');
    if (nestedInput && (nestedInput.disabled || nestedInput.readOnly)) return false;
    return true;
}

function isIntegerControl(control: HTMLElement): boolean {
    const adapter = controlAdapters.get(control);
    if (adapter?.isInteger !== undefined) return adapter.isInteger;
    return control.dataset.parameterWheelInt === 'true';
}

function readControlValue(control: HTMLElement): number {
    const adapter = controlAdapters.get(control);
    if (adapter?.getValue) {
        const val = Number(adapter.getValue());
        return Number.isFinite(val) ? val : 0;
    }
    if (control instanceof HTMLInputElement) {
        const val = parseFloat(control.value);
        return Number.isFinite(val) ? val : 0;
    }
    const input = control.querySelector<HTMLInputElement>('input');
    if (input) {
        const val = parseFloat(input.value);
        return Number.isFinite(val) ? val : 0;
    }
    return 0;
}

function writeControlValue(control: HTMLElement, nextValue: number, step: number): void {
    const isInt = isIntegerControl(control);
    const cleaned = isInt ? Math.round(nextValue) : roundStepValue(nextValue, step);
    const adapter = controlAdapters.get(control);
    if (adapter?.setValue) {
        adapter.setValue(cleaned);
        return;
    }
    const input = control instanceof HTMLInputElement ? control : control.querySelector<HTMLInputElement>('input');
    if (input) {
        let clamped = cleaned;
        if (input.min !== '' && Number.isFinite(Number(input.min))) {
            clamped = Math.max(Number(input.min), clamped);
        }
        if (input.max !== '' && Number.isFinite(Number(input.max))) {
            clamped = Math.min(Number(input.max), clamped);
        }
        const finalVal = isInt ? Math.round(clamped) : roundStepValue(clamped, step);
        if (input.value !== String(finalVal)) {
            input.value = String(finalVal);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

function formatControlReadout(control: HTMLElement): string {
    const adapter = controlAdapters.get(control);
    const val = readControlValue(control);
    if (adapter?.formatValue) {
        return adapter.formatValue(val);
    }
    if (isIntegerControl(control)) {
        return String(Math.round(val));
    }
    const step = activeSteps[activeRungIndex] ?? DEFAULT_FLOAT_STEP;
    const stepDecimals = String(step).includes('.') ? String(step).split('.')[1].length : 1;
    return Number(val.toFixed(Math.max(1, stepDecimals))).toString();
}

function renderLadder(): void {
    if (!ladderEl || !ladderOrigin || !activeControl) return;

    const currentStep = activeSteps[activeRungIndex];
    const centerOffset = (initialRungIndex + 0.5) * RUNG_HEIGHT + 22; // 22px header height
    ladderEl.style.left = `${ladderOrigin.x}px`;
    ladderEl.style.top = `${ladderOrigin.y - centerOffset}px`;
    ladderEl.classList.toggle('is-scrubbing', isScrubbing);

    const valueEl = ladderEl.querySelector<HTMLElement>('.td-value-ladder-val');
    if (valueEl) {
        valueEl.textContent = formatControlReadout(activeControl);
    }

    ladderEl.querySelectorAll<HTMLElement>('[data-parameter-wheel-step]').forEach((rung, idx) => {
        const isSelected = idx === activeRungIndex;
        rung.classList.toggle('is-selected', isSelected);
        rung.classList.toggle('is-dimmed', isScrubbing && !isSelected);
    });

    if (isIntegerControl(activeControl)) {
        selectedIntStep = currentStep;
    } else {
        selectedFloatStep = currentStep;
    }
}

function openLadder(control: HTMLElement, x: number, y: number): void {
    if (!isControlEditable(control) || ladderIsOpen) return;

    activeControl = control;
    const isInt = isIntegerControl(control);
    activeSteps = isInt ? INT_LADDER_STEPS : FLOAT_LADDER_STEPS;
    const defaultStep = isInt ? DEFAULT_INT_STEP : DEFAULT_FLOAT_STEP;
    initialRungIndex = Math.max(0, activeSteps.indexOf(defaultStep as never));
    activeRungIndex = initialRungIndex;
    isScrubbing = false;

    ladderOrigin = { x, y };
    lastScrubX = x;

    ladderEl = document.createElement('div');
    ladderEl.className = 'td-value-ladder';
    ladderEl.setAttribute('role', 'status');
    ladderEl.setAttribute('aria-label', 'TouchDesigner value ladder: move vertically to choose step, drag horizontally to adjust value.');

    const rungsHtml = activeSteps
        .map(step => `
            <div class="td-value-ladder-rung" data-parameter-wheel-step="${step}">
                <span class="td-value-ladder-arrow" aria-hidden="true">‹</span>
                <span class="td-value-ladder-step-label">${step}</span>
                <span class="td-value-ladder-arrow" aria-hidden="true">›</span>
            </div>
        `)
        .join('');

    ladderEl.innerHTML = `
        <div class="td-value-ladder-header">
            <span class="td-value-ladder-title">VAL</span>
            <span class="td-value-ladder-val">${formatControlReadout(control)}</span>
        </div>
        <div class="td-value-ladder-rungs">
            ${rungsHtml}
        </div>
    `;

    document.body.appendChild(ladderEl);
    ladderIsOpen = true;
    renderLadder();
}

function closeLadder(): void {
    if (!ladderIsOpen) return;
    ladderEl?.remove();
    ladderEl = null;
    ladderOrigin = null;
    activeControl = null;
    isScrubbing = false;
    ladderIsOpen = false;
}

export function computeLadderPointerUpdate(params: {
    originY: number;
    lastScrubX: number;
    clientX: number;
    clientY: number;
    initialRungIndex: number;
    activeRungIndex: number;
    steps: readonly number[];
    isScrubbing: boolean;
}): {
    activeRungIndex: number;
    isScrubbing: boolean;
    lastScrubX: number;
    valueDelta: number;
    step: number;
} {
    let {
        originY,
        lastScrubX: scrubX,
        clientX,
        clientY,
        initialRungIndex: initIdx,
        activeRungIndex: rungIdx,
        steps,
        isScrubbing: scrubbing
    } = params;

    if (!scrubbing) {
        const dy = clientY - originY;
        const rungOffset = Math.round(dy / RUNG_HEIGHT);
        const nextRungIndex = Math.max(0, Math.min(steps.length - 1, initIdx + rungOffset));
        if (nextRungIndex !== rungIdx) {
            rungIdx = nextRungIndex;
            scrubX = clientX;
        }
        if (Math.abs(clientX - scrubX) >= HORIZONTAL_LOCK_THRESHOLD) {
            scrubbing = true;
        }
    }

    const step = steps[rungIdx] ?? DEFAULT_FLOAT_STEP;
    let valueDelta = 0;

    if (scrubbing) {
        const dx = clientX - scrubX;
        const ticks = Math.trunc(dx / PIXELS_PER_STEP);
        if (ticks !== 0) {
            valueDelta = ticks * step;
            scrubX += ticks * PIXELS_PER_STEP;
        }
    }

    return {
        activeRungIndex: rungIdx,
        isScrubbing: scrubbing,
        lastScrubX: scrubX,
        valueDelta,
        step
    };
}

function handlePointerMove(clientX: number, clientY: number): void {
    if (!ladderIsOpen || !ladderOrigin || !activeControl) return;
    if (!isControlEditable(activeControl)) {
        closeLadder();
        return;
    }

    const result = computeLadderPointerUpdate({
        originY: ladderOrigin.y,
        lastScrubX,
        clientX,
        clientY,
        initialRungIndex,
        activeRungIndex,
        steps: activeSteps,
        isScrubbing
    });

    const rungChanged = result.activeRungIndex !== activeRungIndex;
    const scrubChanged = result.isScrubbing !== isScrubbing;
    activeRungIndex = result.activeRungIndex;
    isScrubbing = result.isScrubbing;
    lastScrubX = result.lastScrubX;

    if (result.valueDelta !== 0) {
        const currentVal = readControlValue(activeControl);
        writeControlValue(activeControl, currentVal + result.valueDelta, result.step);
        renderLadder();
    } else if (rungChanged || scrubChanged) {
        renderLadder();
    }
}

function installListeners(): void {
    if (listenersInstalled || typeof document === 'undefined') return;
    listenersInstalled = true;

    document.addEventListener('pointermove', event => {
        if (ladderIsOpen) {
            event.preventDefault();
            handlePointerMove(event.clientX, event.clientY);
            return;
        }

        const ctrl = getWheelControl(event.target);
        pointerControl = isControlEditable(ctrl) ? ctrl : null;
        pointerPosition = pointerControl ? { x: event.clientX, y: event.clientY } : null;
    }, true);

    // Middle mouse button (button 1): press & drag on an editable parameter opens the TouchDesigner value ladder.
    // When pressed anywhere else (or on a disabled control), do nothing.
    document.addEventListener('pointerdown', event => {
        if (event.button !== 1) return;
        const ctrl = getWheelControl(event.target);
        if (!isControlEditable(ctrl)) return;

        event.preventDefault();
        event.stopPropagation();
        pointerControl = ctrl;
        pointerPosition = { x: event.clientX, y: event.clientY };
        openLadder(ctrl, event.clientX, event.clientY);
    }, true);

    document.addEventListener('pointerup', event => {
        if (event.button === 1 && ladderIsOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeLadder();
        }
    }, true);

    document.addEventListener('pointercancel', () => {
        if (ladderIsOpen) closeLadder();
    }, true);

    document.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        const ctrl = getWheelControl(event.target);
        if (ladderIsOpen || isControlEditable(ctrl)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && ladderIsOpen) {
            event.preventDefault();
            closeLadder();
            return;
        }
        if (event.key !== 'Alt' || event.repeat || ladderIsOpen) return;
        if (!isControlEditable(pointerControl) || !pointerPosition) return;
        event.preventDefault();
        openLadder(pointerControl, pointerPosition.x, pointerPosition.y);
    }, true);

    window.addEventListener('keyup', event => {
        if (event.key !== 'Alt' || !ladderIsOpen) return;
        event.preventDefault();
        closeLadder();
    }, true);

    window.addEventListener('blur', () => closeLadder());
}

/** Mark a numeric editor as eligible for the TouchDesigner middle-mouse value ladder. */
export function registerParameterWheelControl(
    control: HTMLElement,
    adapter?: ParameterWheelAdapter
): void {
    control.dataset.parameterWheelControl = 'true';
    if (adapter) {
        if (adapter.isInteger) {
            control.dataset.parameterWheelInt = 'true';
        }
        controlAdapters.set(control, adapter);
    }
    installListeners();
}

/** The step value applied by a parameter editor for each wheel tick (defaults to 0.1 for float, 1 for int). */
export function getParameterWheelStep(isInteger = false): number {
    return isInteger ? Math.max(1, Math.round(selectedIntStep)) : selectedFloatStep;
}
