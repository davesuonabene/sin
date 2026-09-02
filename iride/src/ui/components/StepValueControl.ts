import { type FieldSchema } from '../../fields/FieldSchema';
import { getParameterWheelStep, registerParameterWheelControl } from '../ParameterWheelMenu';

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

        this.input.addEventListener('input', () => {
            const parsed = this.parseValue(this.input.value);
            if (Number.isFinite(parsed)) this.renderValue(parsed);
        });

        this.input.addEventListener('change', () => {
            const nextValue = this.normalizeValue(this.input.value);
            this.setValue(nextValue);
            onChange(nextValue);
        });

        registerParameterWheelControl(this.input);
        this.input.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            const increment = getParameterWheelStep(field.type === 'int');
            const nextValue = this.normalizeValue(this.value + increment * direction);
            this.setValue(nextValue);
            onChange(nextValue);
        }, { passive: false });

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
