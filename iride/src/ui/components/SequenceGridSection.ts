import { type FieldSchema } from '../../fields/FieldSchema';
import { type BaseNode } from '../../nodes/BaseNode';
import { StepValueControl } from './StepValueControl';
import { type SequenceDocument } from '../../nodes/SequenceNode';

type StepParameters = Record<string, number | boolean> & {
    subdivision_enabled: boolean;
};

const STEP_COUNT = 16;

interface DroppedSequenceItem {
    id?: number | string;
    itemType?: string;
    filepath: string;
    name?: string;
    bpm?: number | null;
    key?: string | null;
}

function getDroppedSequenceItem(dataTransfer: DataTransfer): DroppedSequenceItem | null {
    const raw = dataTransfer.getData('application/x-gaia-library-item')
        || dataTransfer.getData('text/plain');
    if (!raw) return null;
    try {
        const payload = JSON.parse(raw);
        const items = payload?.type === 'library-items' && Array.isArray(payload.items)
            ? payload.items
            : payload?.type === 'library-item' ? [payload] : [];
        return items.find((item: any) => {
            const path = String(item?.filepath || '').toLowerCase();
            return item?.itemType === 'midi'
                || item?.itemType === 'sequence'
                || path.endsWith('.mid')
                || path.endsWith('.midi')
                || path.endsWith('.seq');
        }) || null;
    } catch {
        return null;
    }
}

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

        const header = document.createElement('div');
        header.className = 'td-seq-asset-row';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'td-seq-name-input';
        nameInput.value = String(node.properties.node_name || node.title || 'Sequence');
        nameInput.placeholder = 'Sequence name';
        nameInput.setAttribute('aria-label', 'Sequence name');
        nameInput.maxLength = 64;
        const commitName = () => {
            const name = nameInput.value.trim() || 'Sequence';
            nameInput.value = name;
            node.updateProperty('node_name', name);
        };
        nameInput.addEventListener('change', commitName);
        nameInput.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitName();
            nameInput.blur();
        });

        const poolButton = document.createElement('button');
        poolButton.type = 'button';
        poolButton.className = 'waveform-asset-button td-seq-header-button';
        poolButton.textContent = '+';
        poolButton.title = node.properties?.asset_modifier_id != null ? 'Open MIDI / Sequence Pool' : 'Add MIDI / Sequence Pool';
        poolButton.setAttribute('aria-label', poolButton.title);
        poolButton.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', {
                detail: { nodeId: node.id }
            }));
        });

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'waveform-asset-button td-seq-header-button td-seq-save-button';
        saveButton.textContent = '↓';
        saveButton.title = 'Save sequence to the default GAIA vault';
        saveButton.setAttribute('aria-label', saveButton.title);

        const saveStatus = document.createElement('span');
        saveStatus.className = 'td-seq-save-status';
        saveStatus.setAttribute('role', 'status');

        saveButton.addEventListener('click', async () => {
            commitName();
            const sequenceNode = node as BaseNode & { toSequenceDocument?: () => SequenceDocument };
            if (typeof sequenceNode.toSequenceDocument !== 'function') return;
            saveButton.disabled = true;
            saveStatus.textContent = 'Saving…';
            saveStatus.classList.remove('is-error');
            try {
                const response = await fetch('/api/sequence/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(sequenceNode.toSequenceDocument())
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.detail || `Save failed (${response.status})`);
                if (result.absolute_path) node.updateProperty('filepath', result.absolute_path);
                if (result.id != null) node.updateProperty('library_item_id', result.id);
                saveStatus.textContent = 'Saved';
                window.dispatchEvent(new CustomEvent('library-content-changed'));
                window.setTimeout(() => { if (saveStatus.isConnected) saveStatus.textContent = ''; }, 1600);
            } catch (error) {
                saveStatus.textContent = error instanceof Error ? error.message : 'Save failed';
                saveStatus.classList.add('is-error');
            } finally {
                saveButton.disabled = false;
            }
        });

        header.append(nameInput, saveStatus, poolButton, saveButton);
        wrapper.appendChild(header);

        const viewport = document.createElement('div');
        viewport.className = 'td-seq-grid-viewport';

        const grid = document.createElement('div');
        grid.className = 'td-seq-parameter-grid';
        viewport.appendChild(grid);
        wrapper.appendChild(viewport);
        container.appendChild(wrapper);

        viewport.addEventListener('dragover', event => {
            if (!event.dataTransfer || !getDroppedSequenceItem(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            viewport.classList.add('is-dragover');
        });
        viewport.addEventListener('dragleave', event => {
            if (!viewport.contains(event.relatedTarget as Node | null)) viewport.classList.remove('is-dragover');
        });
        viewport.addEventListener('drop', async event => {
            event.preventDefault();
            event.stopPropagation();
            viewport.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            const item = getDroppedSequenceItem(event.dataTransfer);
            const applyItem = (window as any).applyLibraryItemToSequence;
            if (!item || typeof applyItem !== 'function') return;
            try {
                if (node.properties?.asset_modifier_id != null) {
                    node.updateProperty('asset_modifier_id', null);
                    window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: node.id } }));
                }
                await applyItem(node, item);
                windowContext.refreshAudioPreview();
                await windowContext.renderTabContent();
            } catch (error) {
                saveStatus.textContent = error instanceof Error ? error.message : 'Could not load sequence';
                saveStatus.classList.add('is-error');
            }
        });

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
            const button = StepValueControl.createBinary({
                value: Boolean(value),
                ariaLabel: `Step ${index + 1}`,
                onChange: nextValue => {
                    sequence[index] = nextValue ? 1 : 0;
                    grid.querySelectorAll<HTMLElement>(`.td-step-value-control[data-step-index="${index}"]`)
                        .forEach(control => control.classList.toggle('is-step-off', !nextValue));
                    node.updateProperty('sequence', [...sequence]);
                    windowContext.refreshAudioPreview();
                }
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
        const valueControls = new Map<HTMLInputElement, StepValueControl>();

        const setSelected = (input: HTMLInputElement, selected: boolean) => {
            input.closest('.td-step-value-control')?.classList.toggle('is-selected', selected);
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
                    grid.querySelectorAll<HTMLInputElement>(`.td-step-value-input[data-field-key="${rowKey}"]`)
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
                        valueControls.get(target)?.setValue(value);
                        targetParameters[field.key] = value;
                        if (field.key === 'subdivisions') {
                            targetParameters.subdivision_enabled = value > 1;
                        }
                    });
                    node.updateProperty('step_parameters', [...stepParameters]);
                    windowContext.refreshAudioPreview();
                };
                const control = new StepValueControl({
                    field: field as FieldSchema<number>,
                    value: Number(parameters[field.key]),
                    onChange: applyValue
                });
                const input = control.input;
                valueControls.set(input, control);
                control.element.dataset.stepIndex = String(stepIndex);
                control.element.classList.toggle('is-step-off', !sequence[stepIndex]);
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
                grid.appendChild(control.element);
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

}
