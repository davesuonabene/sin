import { type FieldSchema } from '../fields/FieldSchema';
import { type BaseNode } from '../nodes/BaseNode';
import { fetchLibrary } from '../api';
import { RadioGroup } from './components/RadioGroup';

function formatDb(db: number): string {
    if (db <= -35.9) return "-inf dB";
    if (Math.abs(db) < 0.05) return "0.0 dB";
    if (db > 0) return `+${db.toFixed(1)} dB`;
    return `${db.toFixed(1)} dB`;
}

export class WidgetFactory {
    static getFieldValue<T = any>(node: BaseNode, field: FieldSchema<T>): T {
        const p = node.properties || {};
        const val = p[field.key];
        return val !== undefined ? val : field.default;
    }

    static setFieldValue<T = any>(node: BaseNode, field: FieldSchema<T>, val: T): T {
        if (!node.properties) node.properties = {};
        let validatedVal = val;

        if (field.type === 'int') {
            let num = typeof val === 'number' ? val : parseInt(String(val), 10);
            if (isNaN(num)) num = typeof field.default === 'number' ? field.default : 0;
            if (field.min !== undefined) num = Math.max(field.min, num);
            if (field.max !== undefined) num = Math.min(field.max, num);
            validatedVal = Math.round(num) as unknown as T;
        } else if (field.type === 'global_float' && String(val).toLowerCase() === 'global') {
            validatedVal = 'global' as unknown as T;
        } else if (field.type === 'float' || field.type === 'global_float' || field.type === 'db' || field.type === 'slider') {
            let num = typeof val === 'number' ? val : parseFloat(String(val));
            if (isNaN(num)) num = typeof field.default === 'number' ? field.default : 0;
            if (field.min !== undefined) num = Math.max(field.min, num);
            if (field.max !== undefined) num = Math.min(field.max, num);
            validatedVal = num as unknown as T;
        }

        node.updateProperty(field.key, validatedVal);
        return validatedVal;
    }

    static createRow(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'td-param-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'td-param-label';
        labelEl.textContent = field.label + (field.unit ? ` (${field.unit})` : '');
        row.appendChild(labelEl);

        const controlEl = document.createElement('div');
        controlEl.className = 'td-param-control';
        row.appendChild(controlEl);

        const widget = this.createWidget(field, node, onChange);
        controlEl.appendChild(widget);

        if (field.nestedFields?.length) {
            const nestedFields = field.nestedFields
                .map(key => node.getFields().find(candidate => candidate.key === key))
                .filter((candidate): candidate is FieldSchema => Boolean(candidate));
            if (nestedFields.length) {
                row.classList.add('td-param-row-with-nested');
                const nestedContainer = document.createElement('div');
                nestedContainer.className = 'td-param-nested-fields';
                nestedContainer.hidden = true;
                for (const nestedField of nestedFields) {
                    const nestedRow = this.createRow(nestedField, node, onChange);
                    if (nestedField.description) nestedRow.title = nestedField.description;
                    nestedContainer.appendChild(nestedRow);
                }
                row.appendChild(nestedContainer);
                row.addEventListener('toggle-nested-fields', (event: Event) => {
                    event.stopPropagation();
                    nestedContainer.hidden = !nestedContainer.hidden;
                    row.classList.toggle('is-nested-open', !nestedContainer.hidden);
                });
            }
        }

        return row;
    }

    static createWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        switch (field.type) {
            case 'filepath':
                return this.createFilepathWidget(field, node, onChange);
            case 'slider':
                return this.createSliderWidget(field, node, onChange);
            case 'string':
                return this.createStringWidget(field, node, onChange);
            case 'int':
            case 'float':
                return this.createNumberWidget(field, node, onChange);
            case 'global_float':
                return this.createGlobalNumberWidget(field, node, onChange);
            case 'select':
                return this.createSelectWidget(field, node, onChange);
            case 'radio':
                return this.createRadioWidget(field, node, onChange);
            case 'boolean':
                return this.createBooleanWidget(field, node, onChange);
            case 'db':
                return this.createDbWidget(field, node, onChange);
            case 'seed':
                return this.createSeedWidget(field, node, onChange);
            default:
                return this.createStringWidget(field, node, onChange);
        }
    }

    private static createFilepathWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'asset-path-picker';
        wrapper.style.display = 'flex';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';
        wrapper.style.width = '100%';

        const select = document.createElement('select');
        select.className = 'td-param-select';
        select.style.flex = '1';

        const assignedModifierId = node.properties?.asset_modifier_id;
        const graph = (window as any).editorGraph;
        const assignedModifier = assignedModifierId != null ? graph?.getNodeById?.(assignedModifierId) : null;

        if (assignedModifier) {
            select.disabled = true;
            const opt = document.createElement('option');
            opt.textContent = `[Pool] ${node.properties.filepath ? node.properties.filepath.split(/[\\/]/).pop() : 'Dynamic Asset'}`;
            select.appendChild(opt);
        } else {
            const currentPath = String(this.getFieldValue(node, field) || '');
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = '-- Select Asset --';
            select.appendChild(emptyOpt);

            fetchLibrary(true, true).then(files => {
                const acceptedType = field.key === 'midi_filepath' ? 'midi' : 'audio';
                const filtered = files.filter(f => {
                    const isMidi = f.type === 'midi' || f.name.endsWith('.mid') || f.name.endsWith('.midi');
                    return acceptedType === 'midi' ? isMidi : !isMidi;
                });

                select.innerHTML = '';
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = '-- Select Asset --';
                select.appendChild(placeholder);

                for (const f of filtered) {
                    const opt = document.createElement('option');
                    opt.value = f.absolute_path;
                    opt.textContent = `${f.name}${f.bpm ? ` (${f.bpm} BPM)` : ''}`;
                    if (f.absolute_path === currentPath) opt.selected = true;
                    select.appendChild(opt);
                }
            }).catch(err => {
                console.error("Failed to populate filepath dropdown", err);
            });

            select.addEventListener('change', () => {
                const previousValue = this.getFieldValue(node, field);
                const updated = this.setFieldValue(node, field, select.value);
                onChange(field.key, updated, previousValue);
            });
        }

        const poolBtn = document.createElement('button');
        poolBtn.type = 'button';
        poolBtn.className = `asset-filter-add-button ${assignedModifier ? 'is-toggle' : ''}`;
        poolBtn.title = assignedModifier ? 'Show asset options' : 'Add and connect an Asset Pool';
        poolBtn.setAttribute('aria-label', poolBtn.title);
        poolBtn.setAttribute('aria-expanded', 'false');
        poolBtn.textContent = assignedModifier ? '▾' : '+';
        poolBtn.style.padding = '2px 6px';

        poolBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (assignedModifier) {
                const nextExpanded = poolBtn.getAttribute('aria-expanded') !== 'true';
                poolBtn.setAttribute('aria-expanded', String(nextExpanded));
                poolBtn.textContent = nextExpanded ? '▴' : '▾';
                wrapper.dispatchEvent(new CustomEvent('toggle-nested-fields', { bubbles: true }));
            } else {
                window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', { detail: { nodeId: node.id } }));
            }
        });

        wrapper.appendChild(select);
        wrapper.appendChild(poolBtn);
        return wrapper;
    }

    private static createSliderWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.gap = '6px';
        wrapper.style.alignItems = 'center';
        wrapper.style.width = '100%';

        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'td-param-input';
        range.style.flex = '1';
        const currentVal = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
        range.value = String(currentVal);
        if (field.min !== undefined) range.min = String(field.min);
        if (field.max !== undefined) range.max = String(field.max);
        if (field.step !== undefined) range.step = String(field.step);

        const valDisplay = document.createElement('span');
        valDisplay.style.fontSize = '10px';
        valDisplay.style.fontWeight = '600';
        valDisplay.style.minWidth = '36px';
        valDisplay.style.textAlign = 'right';
        valDisplay.textContent = `${currentVal}${field.unit || ''}`;

        const update = (newVal: number) => {
            const previousValue = this.getFieldValue(node, field);
            const updated = this.setFieldValue(node, field, newVal);
            valDisplay.textContent = `${updated}${field.unit || ''}`;
            onChange(field.key, updated, previousValue);
        };

        range.addEventListener('input', () => {
            update(parseFloat(range.value));
        });

        wrapper.appendChild(range);
        wrapper.appendChild(valDisplay);
        return wrapper;
    }

    private static createStringWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'td-param-input';
        input.value = String(this.getFieldValue(node, field) ?? '');
        if (field.placeholder) input.placeholder = field.placeholder;

        input.addEventListener('change', () => {
            const previousValue = this.getFieldValue(node, field);
            const updated = this.setFieldValue(node, field, input.value);
            onChange(field.key, updated, previousValue);
        });

        return input;
    }

    private static createNumberWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-param-input';
        input.value = String(this.getFieldValue(node, field) ?? 0);

        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        if (field.step !== undefined) input.step = String(field.step);
        else if (field.type === 'int') input.step = '1';

        const commit = () => {
            const previousValue = this.getFieldValue(node, field);
            const raw = field.type === 'int' ? parseInt(input.value, 10) : parseFloat(input.value);
            const updated = this.setFieldValue(node, field, raw);
            input.value = String(updated);
            if (!Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        input.addEventListener('change', commit);
        input.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit();
            input.blur();
        });
        return input;
    }

    private static createGlobalNumberWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'td-global-number';

        const scope = document.createElement('button');
        scope.type = 'button';
        scope.className = 'td-global-toggle';
        scope.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M3.5 12h17M12 3.5c2.2 2.35 3.3 5.18 3.3 8.5S14.2 18.15 12 20.5c-2.2-2.35-3.3-5.18-3.3-8.5S9.8 5.85 12 3.5z"></path></svg>';
        scope.title = `Use global ${field.label.toLowerCase()}`;
        scope.setAttribute('aria-label', `Use global ${field.label.toLowerCase()}`);
        scope.setAttribute('aria-pressed', 'false');

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-param-input';
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        input.step = String(field.step ?? 0.01);

        const getGlobalValue = () => {
            const getter = (window as any).getGlobalParameter;
            const value = typeof getter === 'function' ? Number(getter(field.key)) : Number.NaN;
            return Number.isFinite(value) ? value : (typeof field.default === 'number' ? field.default : 0);
        };
        let lastLocalValue: number | null = null;
        const refresh = () => {
            const current = this.getFieldValue(node, field);
            const isGlobal = String(current).toLowerCase() === 'global';
            if (!isGlobal && Number.isFinite(Number(current))) lastLocalValue = Number(current);
            scope.classList.toggle('active', isGlobal);
            scope.setAttribute('aria-pressed', String(isGlobal));
            input.disabled = isGlobal;
            input.value = String(isGlobal ? getGlobalValue() : current);
            input.title = isGlobal ? `Inherited from global ${field.label.toLowerCase()}` : 'Custom local value';
        };
        const commit = () => {
            const previousValue = this.getFieldValue(node, field);
            const raw = parseFloat(input.value);
            const updated = this.setFieldValue(node, field, raw);
            refresh();
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        };

        scope.addEventListener('click', () => {
            const previousValue = this.getFieldValue(node, field);
            const isGlobal = String(previousValue).toLowerCase() === 'global';
            const nextValue = isGlobal
                ? (lastLocalValue ?? getGlobalValue())
                : 'global';
            const updated = this.setFieldValue(node, field, nextValue);
            refresh();
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        });
        input.addEventListener('change', commit);
        input.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit();
            input.blur();
        });
        const handleGlobalChange = () => {
            if (!wrapper.isConnected) {
                window.removeEventListener('global-parameters-changed', handleGlobalChange);
                return;
            }
            refresh();
        };
        window.addEventListener('global-parameters-changed', handleGlobalChange);

        wrapper.append(scope, input);
        refresh();
        return wrapper;
    }

    private static createSelectWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLSelectElement {
        const select = document.createElement('select');
        select.className = 'td-param-select';

        const currentValue = this.getFieldValue(node, field);

        const options = field.options || [];
        for (const opt of options) {
            const optionEl = document.createElement('option');
            if (typeof opt === 'object' && opt !== null) {
                optionEl.value = String(opt.value);
                optionEl.textContent = opt.label;
            } else {
                optionEl.value = String(opt);
                optionEl.textContent = String(opt);
            }
            if (String(optionEl.value) === String(currentValue)) {
                optionEl.selected = true;
            }
            select.appendChild(optionEl);
        }

        select.addEventListener('change', () => {
            const previousValue = this.getFieldValue(node, field);
            const updated = this.setFieldValue(node, field, select.value);
            onChange(field.key, updated, previousValue);
        });

        return select;
    }

    private static createRadioWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        return RadioGroup.create({
            name: `${field.key}-${node.id}`,
            value: String(this.getFieldValue(node, field)),
            options: (field.options || []).map(option => typeof option === 'object'
                ? { value: String(option.value), label: option.label }
                : { value: String(option), label: String(option) }),
            ariaLabel: field.label,
            onChange: value => {
                const previousValue = this.getFieldValue(node, field);
                const updated = this.setFieldValue(node, field, value);
                onChange(field.key, updated, previousValue);
            }
        });
    }

    private static createBooleanWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'td-param-checkbox';
        input.checked = Boolean(this.getFieldValue(node, field));

        input.addEventListener('change', () => {
            const previousValue = this.getFieldValue(node, field);
            const updated = this.setFieldValue(node, field, input.checked);
            onChange(field.key, updated, previousValue);
        });

        return input;
    }

    private static createDbWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const container = document.createElement('div');
        container.className = 'td-float-box';

        const currentDb = Number(this.getFieldValue(node, field) ?? 0.0);

        const labelText = document.createElement('span');
        labelText.className = 'float-val-text';
        labelText.innerText = formatDb(currentDb);
        container.appendChild(labelText);

        let activeDb = currentDb;

        const updateUI = (db: number) => {
            activeDb = Math.max(-36.0, Math.min(12.0, db));
            labelText.innerText = formatDb(activeDb);
        };

        let isDragging = false;
        let startX = 0;
        let startDb = 0;

        container.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            isDragging = true;
            startX = e.clientX;
            startDb = activeDb;
            try { container.setPointerCapture(e.pointerId); } catch (_) {}
            container.classList.add('dragging');
            e.preventDefault();
        });

        container.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isDragging) return;
            const previousValue = this.getFieldValue(node, field);
            const dx = e.clientX - startX;
            const deltaDb = dx * 0.15;
            const newDb = Math.round((startDb + deltaDb) * 10) / 10;
            updateUI(newDb);
            const updated = this.setFieldValue(node, field, activeDb);
            onChange(field.key, updated, previousValue);
        });

        const stopDrag = (e: PointerEvent) => {
            if (isDragging) {
                isDragging = false;
                container.classList.remove('dragging');
                try { container.releasePointerCapture(e.pointerId); } catch (_) {}
            }
        };

        container.addEventListener('pointerup', stopDrag);
        container.addEventListener('pointercancel', stopDrag);

        container.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '0.1';
            input.min = '-36';
            input.max = '12';
            input.value = activeDb.toFixed(1);
            input.className = 'td-float-direct-input';

            container.innerHTML = '';
            container.appendChild(input);
            input.focus();
            input.select();

            let committed = false;
            const commitInput = () => {
                if (committed) return;
                committed = true;
                const parsed = parseFloat(input.value);
                if (!isNaN(parsed)) {
                    const previousValue = this.getFieldValue(node, field);
                    updateUI(parsed);
                    const updated = this.setFieldValue(node, field, activeDb);
                    onChange(field.key, updated, previousValue);
                }
                container.innerHTML = '';
                container.appendChild(labelText);
                labelText.innerText = formatDb(activeDb);
            };

            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    commitInput();
                } else if (evt.key === 'Escape') {
                    committed = true;
                    container.innerHTML = '';
                    container.appendChild(labelText);
                }
            });

            input.addEventListener('blur', commitInput);
        });

        return container;
    }

    private static createSeedWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'td-param-input';
        input.style.flex = '1';
        input.value = String(this.getFieldValue(node, field) ?? 42);

        const diceBtn = document.createElement('button');
        diceBtn.type = 'button';
        diceBtn.className = 'asset-filter-add-button';
        diceBtn.title = 'Randomize seed';
        diceBtn.textContent = '🎲';
        diceBtn.style.padding = '2px 6px';
        diceBtn.style.fontSize = '12px';
        diceBtn.style.height = '26px';

        const commitValue = (val: number) => {
            const previousValue = this.getFieldValue(node, field);
            const updated = this.setFieldValue(node, field, val);
            input.value = String(updated);
            onChange(field.key, updated, previousValue);
        };

        input.addEventListener('change', () => {
            commitValue(Number(input.value) || 0);
        });

        diceBtn.addEventListener('click', () => {
            const newSeed = Math.floor(Math.random() * 10000);
            commitValue(newSeed);
        });

        wrapper.appendChild(input);
        wrapper.appendChild(diceBtn);
        return wrapper;
    }
}
