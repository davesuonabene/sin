const WHEEL_STEPS = [10, 1, 0.1, 0.01] as const;

let selectedStep = 1;
let pointerControl: HTMLElement | null = null;
let pointerPosition: { x: number; y: number } | null = null;
let menuOrigin: { x: number; y: number } | null = null;
let previewStep = selectedStep;
let menu: HTMLDivElement | null = null;
let menuIsOpen = false;
let listenersInstalled = false;

function getWheelControl(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
        ? target.closest<HTMLElement>('[data-parameter-wheel-control="true"]')
        : null;
}

function renderMenu(): void {
    if (!menu || !menuOrigin) return;
    menu.style.left = `${menuOrigin.x}px`;
    menu.style.top = `${menuOrigin.y}px`;
    menu.querySelectorAll<HTMLElement>('[data-parameter-wheel-step]').forEach(option => {
        option.classList.toggle('is-selected', Number(option.dataset.parameterWheelStep) === previewStep);
    });
}

let didMove = false;

function stepAtPointer(x: number, y: number): number | null {
    if (!menuOrigin) return null;
    const dx = x - menuOrigin.x;
    const dy = y - menuOrigin.y;
    if (Math.hypot(dx, dy) < 18) return null;

    // Top, right, bottom, and left map to coarse through fine adjustment.
    const quadrant = ((Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI / 2)) % 4) + 4) % 4;
    return WHEEL_STEPS[quadrant];
}

function openMenu(): void {
    if (!pointerControl || !pointerPosition || menuIsOpen) return;

    menuOrigin = { ...pointerPosition };
    previewStep = selectedStep;
    didMove = false;
    menu = document.createElement('div');
    menu.className = 'td-param-wheel-menu';
    menu.setAttribute('role', 'status');
    menu.setAttribute('aria-label', 'Mouse wheel adjustment step. Move toward a value, or click middle mouse to select.');
    menu.innerHTML = `
        <span class="td-param-wheel-ring" aria-hidden="true"></span>
        <span class="td-param-wheel-center">Step</span>
        <span class="td-param-wheel-option is-top" data-parameter-wheel-step="10">10</span>
        <span class="td-param-wheel-option is-right" data-parameter-wheel-step="1">1</span>
        <span class="td-param-wheel-option is-bottom" data-parameter-wheel-step="0.1">0.1</span>
        <span class="td-param-wheel-option is-left" data-parameter-wheel-step="0.01">0.01</span>
    `;
    document.body.appendChild(menu);
    menuIsOpen = true;
    renderMenu();
}

function closeMenu(commitSelection: boolean): void {
    if (!menuIsOpen) return;
    if (commitSelection) {
        if (!didMove) {
            // Quick click without drag: cycle through steps [10, 1, 0.1, 0.01]
            const currIdx = WHEEL_STEPS.indexOf(selectedStep as any);
            selectedStep = WHEEL_STEPS[(currIdx + 1) % WHEEL_STEPS.length];
        } else {
            selectedStep = previewStep;
        }
    }
    menu?.remove();
    menu = null;
    menuOrigin = null;
    menuIsOpen = false;
}

function installListeners(): void {
    if (listenersInstalled || typeof document === 'undefined') return;
    listenersInstalled = true;

    document.addEventListener('pointermove', event => {
        if (menuIsOpen) {
            const step = stepAtPointer(event.clientX, event.clientY);
            if (step != null) {
                didMove = true;
                if (step !== previewStep) {
                    previewStep = step;
                    renderMenu();
                }
            }
            return;
        }

        pointerControl = getWheelControl(event.target);
        pointerPosition = pointerControl ? { x: event.clientX, y: event.clientY } : null;
    }, true);

    // Middle mouse button (button 1): clicking/holding mouse wheel on a parameter opens the selector
    document.addEventListener('pointerdown', event => {
        if (event.button === 1) { // Middle click
            const ctrl = getWheelControl(event.target);
            if (ctrl?.isConnected) {
                event.preventDefault();
                event.stopPropagation();
                pointerControl = ctrl;
                pointerPosition = { x: event.clientX, y: event.clientY };
                openMenu();
            }
        }
    }, true);

    document.addEventListener('pointerup', event => {
        if (event.button === 1 && menuIsOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeMenu(true);
        }
    }, true);

    document.addEventListener('auxclick', event => {
        if (event.button === 1 && (menuIsOpen || getWheelControl(event.target))) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    // Alt key support
    window.addEventListener('keydown', event => {
        if (event.key !== 'Alt' || event.repeat || menuIsOpen) return;
        if (!pointerControl?.isConnected) return;
        event.preventDefault();
        openMenu();
    }, true);

    window.addEventListener('keyup', event => {
        if (event.key !== 'Alt') return;
        if (!menuIsOpen) return;
        event.preventDefault();
        closeMenu(true);
    }, true);

    window.addEventListener('blur', () => closeMenu(false));
}

/** Mark a numeric editor as eligible for the shared Alt radial step selector. */
export function registerParameterWheelControl(control: HTMLElement): void {
    control.dataset.parameterWheelControl = 'true';
    installListeners();
}

/** The absolute value applied by a parameter editor for each wheel tick. */
export function getParameterWheelStep(isInteger = false): number {
    return isInteger ? Math.max(1, Math.round(selectedStep)) : selectedStep;
}
