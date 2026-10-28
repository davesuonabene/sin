import { type FieldSchema } from '../../fields/FieldSchema.ts';
import { getParameterWheelStep, registerParameterWheelControl } from '../ParameterWheelMenu.ts';

interface NumericStepValueOptions {
    field: FieldSchema<number>;
    value: number;
    onChange: (value: number) => void;
}

interface BinaryStepValueOptions {
    value: boolean;
    ariaLabel: string;
    onChange: (value: boolean) => void;
}

/**
 * Compact, schema-driven control shared by every value in a sequencer row.
 * The native input remains on top for keyboard and wheel editing while the
 * visual below it communicates the value when the numeric label is hidden.
 */
export class StepValueControl {
    readonly element: HTMLDivElement;
    readonly input: HTMLInputElement;

    private readonly field: FieldSchema<number>;
    private readonly fill: HTMLDivElement;
    private readonly fragments: HTMLDivElement;
    private value: number;

    constructor({ field, value, onChange }: NumericStepValueOptions) {
        this.field = field;
        this.value = this.normalizeValue(value);

        this.element = document.createElement('div');
        this.element.className = 'td-step-value-control';
        this.element.dataset.visualMode = field.stepVisual?.mode || 'fill';
        this.element.dataset.polarity = field.stepVisual?.polarity || 'unipolar';
        this.element.dataset.direction = field.stepVisual?.direction || 'vertical';

        const visual = document.createElement('div');
        visual.className = 'td-step-value-visual';
        visual.setAttribute('aria-hidden', 'true');

        this.fill = document.createElement('div');
        this.fill.className = 'td-step-value-fill';
        visual.appendChild(this.fill);

        const centerLine = document.createElement('div');
        centerLine.className = 'td-step-value-center';
        visual.appendChild(centerLine);

        this.fragments = document.createElement('div');
        this.fragments.className = 'td-step-value-fragments';
        visual.appendChild(this.fragments);

        this.input = document.createElement('input');
        this.input.type = 'number';
        this.input.className = 'td-step-value-input';
        if (field.min !== undefined) this.input.min = String(field.min);
        if (field.max !== undefined) this.input.max = String(field.max);
        this.input.step = String(field.step ?? (field.type === 'int' ? 1 : 'any'));

        let inputDebounceTimer: any = null;
        this.input.addEventListener('input', () => {
            const parsed = this.parseValue(this.input.value);
            if (Number.isFinite(parsed)) {
                this.renderValue(parsed);
                clearTimeout(inputDebounceTimer);
                inputDebounceTimer = setTimeout(() => {
                    const nextVal = this.normalizeValue(this.input.value);
                    this.value = nextVal;
                    onChange(nextVal);
                }, 100);
            }
        });

        this.input.addEventListener('change', () => {
            clearTimeout(inputDebounceTimer);
            const nextValue = this.normalizeValue(this.input.value);
            this.setValue(nextValue);
            onChange(nextValue);
        });

        const resolveWheelStep = (): number => {
            if (field.type === 'int') {
                return getParameterWheelStep(true);
            }
            if (typeof field.step === 'number' && field.step > 0 && field.step < 1.0) {
                return field.step;
            }
            const min = field.min ?? 0;
            const max = field.max ?? 1;
            if (max - min <= 1.0) {
                return 0.01;
            }
            return getParameterWheelStep(false);
        };

        registerParameterWheelControl(this.input);
        this.input.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            const increment = resolveWheelStep();
            const nextValue = this.normalizeValue(this.value + increment * direction);
            this.setValue(nextValue);
            onChange(nextValue);
        }, { passive: false });

        let isDragging = false;
        let startY = 0;
        let startVal = 0;
        let hasMoved = false;

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;
            isDragging = true;
            startY = e.clientY;
            startVal = this.value;
            hasMoved = false;
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!isDragging) return;
            const dy = startY - e.clientY;
            if (Math.abs(dy) > 3) {
                if (!hasMoved) {
                    hasMoved = true;
                    try {
                        this.element.setPointerCapture(e.pointerId);
                    } catch {}
                }
            }
            if (!hasMoved) return;

            e.preventDefault();
            const min = field.min ?? 0;
            const max = field.max ?? (field.type === 'int' ? 100 : 1.0);
            const span = max - min;
            const sensitivity = e.shiftKey ? 0.2 : 1.0;
            const delta = (dy / 140) * span * sensitivity;
            const nextVal = this.normalizeValue(startVal + delta);
            if (nextVal !== this.value) {
                this.setValue(nextVal);
                onChange(nextVal);
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (isDragging) {
                isDragging = false;
                if (hasMoved) {
                    try {
                        this.element.releasePointerCapture(e.pointerId);
                    } catch {}
                    e.preventDefault();
                    e.stopPropagation();
                }
                hasMoved = false;
            }
        };

        this.element.addEventListener('pointerdown', onPointerDown);
        this.element.addEventListener('pointermove', onPointerMove);
        this.element.addEventListener('pointerup', onPointerUp);
        this.element.addEventListener('pointercancel', onPointerUp);

        this.element.append(visual, this.input);
        this.setValue(this.value);
    }

    static createBinary({ value, ariaLabel, onChange }: BinaryStepValueOptions): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `td-seq-btn ${value ? 'active' : ''}`;
        button.setAttribute('aria-label', ariaLabel);
        button.setAttribute('aria-pressed', String(value));
        button.addEventListener('click', () => {
            const nextValue = button.getAttribute('aria-pressed') !== 'true';
            button.classList.toggle('active', nextValue);
            button.setAttribute('aria-pressed', String(nextValue));
            onChange(nextValue);
        });
        return button;
    }

    setValue(rawValue: string | number): void {
        this.value = this.normalizeValue(rawValue);
        this.input.value = String(this.value);
        this.renderValue(this.value);
    }

    private renderValue(rawValue: number): void {
        const value = this.normalizeValue(rawValue);
        const min = Number(this.field.min ?? 0);
        const max = Number(this.field.max ?? 1);
        const span = Math.max(Number.EPSILON, max - min);
        const position = Math.max(0, Math.min(1, (value - min) / span));
        const polarity = this.field.stepVisual?.polarity || 'unipolar';
        const direction = this.field.stepVisual?.direction || 'vertical';

        this.element.dataset.value = String(value);
        this.element.title = `${this.field.label}: ${this.formatValue(value)}`;
        this.input.setAttribute('aria-valuetext', this.formatValue(value));

        if (this.field.stepVisual?.mode === 'fragments') {
            const fragmentCount = Math.max(1, Math.round(value));
            this.fragments.replaceChildren(...Array.from({ length: fragmentCount }, () => {
                const fragment = document.createElement('span');
                fragment.className = 'td-step-value-fragment';
                return fragment;
            }));
            this.fragments.style.gridTemplateColumns = `repeat(${fragmentCount}, minmax(0, 1fr))`;
            return;
        }

        if (polarity === 'bipolar') {
            const zeroPosition = Math.max(0, Math.min(1, (0 - min) / span));
            this.fill.style.left = `${Math.min(position, zeroPosition) * 100}%`;
            this.fill.style.width = `${Math.abs(position - zeroPosition) * 100}%`;
            this.fill.style.top = '0';
            this.fill.style.height = '100%';
            this.element.style.setProperty('--step-zero-position', `${zeroPosition * 100}%`);
        } else if (direction === 'horizontal') {
            this.fill.style.left = '0';
            this.fill.style.width = `${position * 100}%`;
            this.fill.style.top = '0';
            this.fill.style.height = '100%';
        } else {
            this.fill.style.left = '0';
            this.fill.style.width = '100%';
            this.fill.style.top = `${(1 - position) * 100}%`;
            this.fill.style.height = `${position * 100}%`;
        }
    }

    private parseValue(rawValue: string | number): number {
        return this.field.type === 'int'
            ? parseInt(String(rawValue), 10)
            : parseFloat(String(rawValue));
    }

    private normalizeValue(rawValue: string | number): number {
        let value = this.parseValue(rawValue);
        if (!Number.isFinite(value)) value = Number(this.field.default);
        if (this.field.min !== undefined) value = Math.max(this.field.min, value);
        if (this.field.max !== undefined) value = Math.min(this.field.max, value);
        if (this.field.type === 'int') return Math.round(value);
        return Number(value.toPrecision(6));
    }

    private formatValue(value: number): string {
        const formatted = this.field.type === 'int'
            ? String(Math.round(value))
            : String(Number(value.toFixed(this.decimalPlaces())));
        return `${formatted}${this.field.unit || ''}`;
    }

    private decimalPlaces(): number {
        const step = Number(this.field.step ?? 0.01);
        const decimal = String(step).split('.')[1];
        return Math.min(6, decimal?.length ?? 0);
    }
}
