import { type FieldSchema } from '../../fields/FieldSchema';
import { type BaseNode } from '../../nodes/BaseNode';

type StepParameters = Record<string, number | boolean> & {
    subdivision_enabled: boolean;
};

const STEP_COUNT = 16;

export class SequenceGridSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        const parameterFields = this.getParameterFields(node);
        const makeDefaultStep = (): StepParameters => {
            const defaults = Object.fromEntries(parameterFields.map(field => [field.key, field.default]));
            return {
                ...defaults,
                subdivision_enabled: Number(defaults.subdivisions) > 1
            } as StepParameters;
        };

        const sequence = Array.isArray(node.properties.sequence)
            ? node.properties.sequence.slice(0, STEP_COUNT)
            : [];
        while (sequence.length < STEP_COUNT) {
            sequence.push(sequence.length % 4 === 0 ? 1 : 0);
        }

        const existingParameters = Array.isArray(node.properties.step_parameters)
            ? node.properties.step_parameters.slice(0, STEP_COUNT)
            : [];
        const stepParameters: StepParameters[] = Array.from({ length: STEP_COUNT }, (_, index) => ({
            ...makeDefaultStep(),
            ...(existingParameters[index] || {})
        }));

        node.properties.sequence = sequence;
        node.properties.step_parameters = stepParameters;

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group td-seq-parameter-group';

        const viewport = document.createElement('div');
        viewport.className = 'td-seq-grid-viewport';

        const grid = document.createElement('div');
        grid.className = 'td-seq-parameter-grid';
        viewport.appendChild(grid);
        wrapper.appendChild(viewport);
        container.appendChild(wrapper);

        sequence.forEach((_value: number, index: number) => {
            const number = document.createElement('div');
            number.className = 'td-seq-step-number';
            number.textContent = String(index + 1);
            grid.appendChild(number);
            if ((index + 1) % 4 === 0 && index < STEP_COUNT - 1) {
                grid.appendChild(this.createBeatSpacer());
            }
        });

        const buttons: HTMLButtonElement[] = [];
        sequence.forEach((value: number, index: number) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `td-seq-btn ${value ? 'active' : ''}`;
            button.setAttribute('aria-label', `Step ${index + 1}`);
            button.setAttribute('aria-pressed', String(Boolean(value)));
            button.addEventListener('click', () => {
                const nextValue = sequence[index] ? 0 : 1;
                sequence[index] = nextValue;
                button.classList.toggle('active', Boolean(nextValue));
                button.setAttribute('aria-pressed', String(Boolean(nextValue)));
                node.updateProperty('sequence', [...sequence]);
                windowContext.refreshAudioPreview();
            });
            buttons.push(button);
        });

        const buttonRow = document.createElement('div');
        buttonRow.id = 'sequence-grid';
        buttonRow.className = 'td-seq-button-binding-row';
        buttons.forEach((button, index) => {
            buttonRow.appendChild(button);
            if ((index + 1) % 4 === 0 && index < STEP_COUNT - 1) {
                buttonRow.appendChild(this.createBeatSpacer());
            }
        });
        grid.appendChild(buttonRow);

        const selectedInputs = new Set<HTMLInputElement>();
        let selectionAnchor: HTMLInputElement | null = null;
        let typingInput: HTMLInputElement | null = null;

        const setSelected = (input: HTMLInputElement, selected: boolean) => {
            input.classList.toggle('is-selected', selected);
            input.setAttribute('aria-selected', String(selected));
            if (selected) selectedInputs.add(input);
            else selectedInputs.delete(input);
        };

        const clearSelection = () => {
            selectedInputs.forEach(input => setSelected(input, false));
            selectedInputs.clear();
            typingInput = null;
        };

        const selectInput = (input: HTMLInputElement, event: MouseEvent) => {
            const rowKey = input.dataset.fieldKey;
            if (event.shiftKey && selectionAnchor?.dataset.fieldKey === rowKey) {
                const anchor = selectionAnchor as HTMLInputElement;
                const rowInputs = Array.from(
                    grid.querySelectorAll<HTMLInputElement>(`.td-seq-number-input[data-field-key="${rowKey}"]`)
                );
                const anchorIndex = rowInputs.indexOf(anchor);
                const targetIndex = rowInputs.indexOf(input);
                if (!event.ctrlKey && !event.metaKey) clearSelection();
                const start = Math.min(anchorIndex, targetIndex);
                const end = Math.max(anchorIndex, targetIndex);
                rowInputs.slice(start, end + 1).forEach(item => setSelected(item, true));
            } else if (event.ctrlKey || event.metaKey) {
                if (Array.from(selectedInputs).some(item => item.dataset.fieldKey !== rowKey)) {
                    clearSelection();
                }
                setSelected(input, !selectedInputs.has(input));
                selectionAnchor = input;
                typingInput = null;
            } else if (selectedInputs.has(input)) {
                // Keep the complete multi-selection when the user clicks one of
                // its fields to begin typing a shared value.
                selectionAnchor = input;
                typingInput = null;
            } else {
                clearSelection();
                setSelected(input, true);
                selectionAnchor = input;
            }
        };

        for (const field of parameterFields) {
            const label = document.createElement('div');
            label.className = 'td-seq-row-label';
            label.textContent = field.label;
            grid.appendChild(label);

            stepParameters.forEach((parameters, stepIndex) => {
                const applyValue = (value: number) => {
                    const targets = selectedInputs.has(input)
                        ? Array.from(selectedInputs).filter(item => item.dataset.fieldKey === field.key)
                        : [input];
                    targets.forEach(target => {
                        const targetIndex = Number(target.dataset.stepIndex);
                        const targetParameters = stepParameters[targetIndex];
                        target.value = String(value);
                        targetParameters[field.key] = value;
                        if (field.key === 'subdivisions') {
                            targetParameters.subdivision_enabled = value > 1;
                        }
                    });
                    node.updateProperty('step_parameters', [...stepParameters]);
                    windowContext.refreshAudioPreview();
                };
                const input = this.createNumberInput(field, Number(parameters[field.key]), applyValue);
                input.dataset.fieldKey = field.key;
                input.dataset.stepIndex = String(stepIndex);
                input.setAttribute('aria-label', `Step ${stepIndex + 1} ${field.label}`);
                input.setAttribute('aria-selected', 'false');
                input.addEventListener('mousedown', event => selectInput(input, event));
                input.addEventListener('keydown', event => {
                    if (event.ctrlKey || event.metaKey || event.altKey) return;

                    if (/^[0-9.-]$/.test(event.key) && selectedInputs.has(input)) {
                        if (typingInput !== input) {
                            input.select();
                            typingInput = input;
                        }
                    } else if (event.key === 'Enter') {
                        event.preventDefault();
                        input.blur();
                    } else if (event.key === 'Escape') {
                        typingInput = null;
                        input.blur();
                    }
                });
                input.addEventListener('blur', () => {
                    if (typingInput === input) typingInput = null;
                });
                grid.appendChild(input);
                if ((stepIndex + 1) % 4 === 0 && stepIndex < STEP_COUNT - 1) {
                    grid.appendChild(this.createBeatSpacer());
                }
            });
        }
    }

    private static getParameterFields(node: BaseNode): FieldSchema[] {
        const fields = (node as BaseNode & { getStepParameterFields?: () => FieldSchema[] })
            .getStepParameterFields?.() || [];
        return fields.filter(field => field.type === 'int' || field.type === 'float');
    }

    private static createBeatSpacer(): HTMLDivElement {
        const spacer = document.createElement('div');
        spacer.className = 'td-seq-beat-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
    }

    private static createNumberInput(
        field: FieldSchema,
        currentValue: number,
        onChange: (value: number) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-param-input td-seq-number-input';
        input.value = String(this.normalizeValue(
            field,
            Number.isFinite(currentValue) ? currentValue : field.default
        ));
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        input.step = String(field.step ?? (field.type === 'int' ? 1 : 'any'));

        input.addEventListener('change', () => {
            const value = this.normalizeValue(field, input.value);
            input.value = String(value);
            onChange(value);
        });

        input.addEventListener('wheel', event => {
            event.preventDefault();
            const current = this.normalizeValue(field, input.value);
            const direction = event.deltaY < 0 ? 1 : -1;
            const multiplier = event.shiftKey ? 10 : 1;
            const next = this.normalizeValue(field, current + Number(field.step ?? 1) * direction * multiplier);
            input.value = String(next);
            onChange(next);
        }, { passive: false });

        return input;
    }

    private static normalizeValue(field: FieldSchema, rawValue: string | number): number {
        let value = field.type === 'int'
            ? parseInt(String(rawValue), 10)
            : parseFloat(String(rawValue));
        if (!Number.isFinite(value)) value = Number(field.default);
        if (field.min !== undefined) value = Math.max(field.min, value);
        if (field.max !== undefined) value = Math.min(field.max, value);
        if (field.type === 'int') return Math.round(value);
        return Number(value.toPrecision(3));
    }
}
