import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type BaseNode } from '../nodes/BaseNode.ts';
import { fetchLibrary } from '../api.ts';
import { groupFileVersions } from '../libraryVersioning.ts';
import { RadioGroup } from './components/RadioGroup.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from './ParameterWheelMenu.ts';
import { isFieldOperatorExpression } from '../../../ermes/ts/slotLanguage.ts';

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
            if (isNaN(num)) {
                num = typeof field.default === 'number' ? field.default : (field.key === 'target_bpm' || field.key === 'bpm' ? 120 : 0);
            }
            if (field.min !== undefined) num = Math.max(field.min, num);
            if (field.max !== undefined) num = Math.min(field.max, num);
            validatedVal = num as unknown as T;
        }

        node.updateProperty(field.key, validatedVal);
        return validatedVal;
    }

    private static mayEditField<T = any>(node: BaseNode, field: FieldSchema<T>, value: T): boolean {
        const previousValue = this.getFieldValue(node, field);
        return node.preparePropertyEdit(field.key, value, previousValue) !== false;
    }

    static isFieldCalculated(node: BaseNode, key: string): boolean {
        if (node.hasFieldOperator?.(key)) return true;
        if (key === 'sample_slot' || key === 'seed') {
            if (isFieldOperatorExpression(node.properties?.[key])) return true;
        }
        const graph = (node as any).graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
        const allNodes = (graph?._nodes || graph?.nodes || []) as any[];
        for (const candidate of allNodes) {
            const isRandom = candidate?.type === 'Audio/Random'
                || candidate?.properties?.node_type === 'random'
                || (candidate?.isModifier && candidate?.modifierKind === 'random');
            if (isRandom && candidate?.properties?.parentId === node.id) {
                const dests = Array.isArray(candidate.properties?.destinations) ? candidate.properties.destinations : [];
                if (dests.some((d: any) => d?.enabled && d?.paramKey === key)) {
                    return true;
                }
            }
        }
        return false;
    }

    static createRow(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'td-param-row';
        row.setAttribute('data-field-key', field.key);
        row.setAttribute('data-param-label', field.label);

        const labelEl = document.createElement('div');
        labelEl.className = 'td-param-label';
        labelEl.textContent = field.label + (field.unit ? ` (${field.unit})` : '');
        row.appendChild(labelEl);
        if (field.description) row.title = field.description;

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
            case 'directory':
                return this.createDirectoryWidget(field, node, onChange);
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
        select.className = 'td-param-select sin-select';
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

            fetchLibrary().then(files => {
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

                const grouped = groupFileVersions(filtered, {
                    pathFor: file => file.absolute_path,
                    idFor: file => file.id ?? file.absolute_path,
                    scope: `property:${field.key}`,
                });
                for (const group of grouped) {
                    if (group.fileVersions && group.fileVersionDisplayName) {
                        const optionGroup = document.createElement('optgroup');
                        optionGroup.label = group.fileVersionDisplayName;
                        for (const version of group.fileVersions) {
                            const file = version.record;
                            const option = document.createElement('option');
                            option.value = file.absolute_path;
                            option.textContent = `${version.label}${file.bpm ? ` (${file.bpm} BPM)` : ''}`;
                            if (file.absolute_path === currentPath) option.selected = true;
                            optionGroup.appendChild(option);
                        }
                        select.appendChild(optionGroup);
                        continue;
                    }

                    const file = group.record;
                    const option = document.createElement('option');
                    option.value = file.absolute_path;
                    option.textContent = `${file.name}${file.bpm ? ` (${file.bpm} BPM)` : ''}`;
                    if (file.absolute_path === currentPath) option.selected = true;
                    select.appendChild(option);
                }
            }).catch(err => {
                console.error("Failed to populate filepath dropdown", err);
            });

            select.addEventListener('change', () => {
                const previousValue = this.getFieldValue(node, field);
                if (Object.is(previousValue, select.value)) return;
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
        range.step = String(field.step ?? (field.type === 'int' ? 1 : 0.1));

        const valDisplay = document.createElement('span');
        valDisplay.className = 'td-slider-val';
        valDisplay.style.fontSize = '10px';
        valDisplay.style.fontWeight = '600';
        valDisplay.style.minWidth = '36px';
        valDisplay.style.textAlign = 'right';
        valDisplay.style.cursor = 'text';
        valDisplay.title = 'Click to type value or Field Operator (rand, min..max, list)';

        const syncSliderDisplay = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const latest = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            range.value = String(latest);
            valDisplay.textContent = isMixed ? '' : `${latest}${field.unit || ''}`;
            valDisplay.classList.toggle('is-pool-computed', !isMixed && this.isFieldCalculated(node, field.key));
        };
        syncSliderDisplay();

        const update = (newVal: number) => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (!isMixed && Object.is(previousValue, newVal)) {
                syncSliderDisplay();
                return;
            }
            if (!this.mayEditField(node, field, newVal)) {
                range.value = String(previousValue ?? field.default ?? 0);
                return;
            }
            const updated = this.setFieldValue(node, field, newVal);
            syncSliderDisplay();
            onChange(field.key, updated, previousValue);
        };

        valDisplay.addEventListener('click', (e) => {
            e.stopPropagation();
            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'td-param-input';
            editInput.style.width = '54px';
            editInput.value = node.hasFieldOperator?.(field.key)
                ? node.getFieldOperator(field.key)
                : String(this.getFieldValue(node, field) ?? field.default ?? 0);
            valDisplay.replaceWith(editInput);
            editInput.focus();
            editInput.select();

            let done = false;
            const finishEdit = (cancel = false) => {
                if (done) return;
                done = true;
                if (!cancel) {
                    const rawStr = editInput.value.trim();
                    const previousValue = this.getFieldValue(node, field);
                    if (isFieldOperatorExpression(rawStr)) {
                        node.resetTriggerCount?.();
                        const evaluated = node.applyFieldOperator(field.key, rawStr, field);
                        const updated = this.setFieldValue(node, field, evaluated);
                        node.setFieldOperator(field.key, rawStr);
                        onChange(field.key, updated, previousValue);
                    } else if (rawStr !== '') {
                        const parsed = parseFloat(rawStr);
                        if (Number.isFinite(parsed)) {
                            update(parsed);
                        }
                    }
                }
                editInput.replaceWith(valDisplay);
                syncSliderDisplay();
            };
            editInput.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    finishEdit(false);
                } else if (evt.key === 'Escape') {
                    evt.preventDefault();
                    finishEdit(true);
                }
            });
            editInput.addEventListener('blur', () => finishEdit(false));
        });

        const resolveWheelStep = (): number => {
            return getParameterWheelStep(field.type === 'int');
        };

        range.addEventListener('input', () => {
            update(parseFloat(range.value));
        });
        registerParameterWheelControl(range, {
            isInteger: field.type === 'int',
            getValue: () => Number(this.getFieldValue(node, field) ?? field.default ?? 0),
            setValue: (nextVal) => update(nextVal),
            formatValue: (val) => `${val}${field.unit || ''}`,
        });
        range.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey || range.disabled) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = resolveWheelStep();
            const currentValue = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            update(roundStepValue(currentValue + direction * step, step));
        }, { passive: false });

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
        if (field.placeholder) input.placeholder = field.placeholder;

        const syncDisplay = () => {
            if (typeof document !== 'undefined' && document.activeElement === input) return;
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            if (isMixed) {
                input.value = '';
                input.classList.remove('is-pool-computed');
                return;
            }
            const currentVal = String(this.getFieldValue(node, field) ?? '');
            const opExpr = node.getFieldOperator?.(field.key) || (field.key === 'sample_slot' ? currentVal : '');
            if (field.key === 'sample_slot' && isFieldOperatorExpression(opExpr)) {
                const resolvedSlot = node.evaluateFieldOperatorForKey('sample_slot', opExpr, field);
                input.value = String(resolvedSlot);
                input.classList.add('is-pool-computed');
                return;
            }
            input.value = currentVal;
            input.classList.toggle('is-pool-computed', this.isFieldCalculated(node, field.key));
        };
        syncDisplay();

        let committedOnEnter = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (isMixed && rawStr === '') {
                syncDisplay();
                return;
            }
            const previousValue = this.getFieldValue(node, field);

            if (field.key === 'sample_slot') {
                const nextExpr = rawStr || '*';
                if (!this.mayEditField(node, field, nextExpr)) {
                    syncDisplay();
                    return;
                }
                const updated = this.setFieldValue(node, field, nextExpr);
                if (isFieldOperatorExpression(nextExpr)) {
                    node.setFieldOperator('sample_slot', nextExpr);
                    node.resetTriggerCount?.();
                } else {
                    node.clearFieldOperator?.('sample_slot');
                }
                syncDisplay();
                if (isMixed || !Object.is(previousValue, nextExpr)) {
                    onChange(field.key, updated, previousValue);
                }
                return;
            }

            if (isFieldOperatorExpression(rawStr)) {
                node.resetTriggerCount?.();
                const evaluated = node.applyFieldOperator(field.key, rawStr, field);
                const updated = this.setFieldValue(node, field, evaluated);
                node.setFieldOperator(field.key, rawStr);
                syncDisplay();
                onChange(field.key, updated, previousValue);
                return;
            }

            node.clearFieldOperator?.(field.key);
            if (!isMixed && Object.is(previousValue, input.value)) {
                syncDisplay();
                return;
            }
            if (!this.mayEditField(node, field, input.value)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, input.value);
            syncDisplay();
            onChange(field.key, updated, previousValue);
        };

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            if (field.key === 'sample_slot') {
                const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
                const opExpr = node.getFieldOperator?.('sample_slot');
                input.value = isMixed ? '' : String((opExpr || this.getFieldValue(node, field)) ?? '*');
            } else if (node.hasFieldOperator?.(field.key)) {
                input.value = node.getFieldOperator(field.key);
            }
            input.classList.remove('is-pool-computed');
            input.select();
        });

        input.addEventListener('blur', () => {
            if (!committedOnEnter) {
                commit();
            } else {
                syncDisplay();
            }
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                committedOnEnter = true;
                commit();
                input.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                committedOnEnter = true;
                input.blur();
                syncDisplay();
            }
        });

        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefreshed);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncDisplay();
                }
            };
            window.addEventListener('node-properties-refreshed', onRefreshed);
        }

        return input;
    }

    private static createDirectoryWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-directory-control';
        wrapper.style.display = 'flex';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';
        wrapper.style.width = '100%';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'td-param-input';
        input.style.flex = '1';
        input.value = String(this.getFieldValue(node, field) ?? field.default ?? 'exports');
        if (field.placeholder) input.placeholder = field.placeholder;

        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'td-param-action-btn';
        browseBtn.textContent = 'Browse…';
        browseBtn.title = 'Browse folders';

        const commit = () => {
            const previousValue = this.getFieldValue(node, field);
            const val = input.value.trim() || String(field.default || 'exports');
            if (Object.is(previousValue, val)) return;
            if (!this.mayEditField(node, field, val)) {
                input.value = String(previousValue ?? '');
                return;
            }
            const updated = this.setFieldValue(node, field, val);
            input.value = String(updated);
            if (!Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
                input.blur();
            }
        });

        browseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('open-folder-picker', {
                detail: {
                    initialPath: input.value,
                    onSelect: (selectedPath: string) => {
                        input.value = selectedPath;
                        commit();
                    }
                }
            }));
        });

        wrapper.appendChild(input);
        wrapper.appendChild(browseBtn);
        return wrapper;
    }

    private static createNumberWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'td-param-input';
        input.title = field.description
            ? `${field.description} · Supports Field Operators (rand, min..max, or space-separated list)`
            : 'Supports Field Operators (rand, min..max, or space-separated list)';

        const syncDisplay = () => {
            if (typeof document !== 'undefined' && document.activeElement === input) return;
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            if (isMixed) {
                input.value = '';
                input.classList.remove('is-pool-computed');
                return;
            }
            const opExpr = node.getFieldOperator?.(field.key);
            const displayVal = opExpr
                ? node.evaluateFieldOperatorForKey(field.key, opExpr, field)
                : (this.getFieldValue(node, field) ?? 0);
            input.value = String(displayVal);
            input.classList.toggle('is-pool-computed', this.isFieldCalculated(node, field.key));
        };
        syncDisplay();

        let committedOnEnter = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (rawStr === '') {
                if (isMixed) return;
                syncDisplay();
                return;
            }
            const previousValue = this.getFieldValue(node, field);
            if (isFieldOperatorExpression(rawStr)) {
                node.resetTriggerCount?.();
                const evaluated = node.applyFieldOperator(field.key, rawStr, field);
                const updated = this.setFieldValue(node, field, evaluated);
                node.setFieldOperator(field.key, rawStr);
                syncDisplay();
                onChange(field.key, updated, previousValue);
                return;
            }
            node.clearFieldOperator?.(field.key);
            const raw = field.type === 'int' ? parseInt(rawStr, 10) : parseFloat(rawStr);
            if (!Number.isFinite(raw)) {
                syncDisplay();
                return;
            }
            if (!isMixed && Object.is(previousValue, raw)) {
                syncDisplay();
                return;
            }
            if (!this.mayEditField(node, field, raw)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, raw);
            syncDisplay();
            if (isMixed || !Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        let numDebounceTimer: any = null;
        input.addEventListener('input', () => {
            clearTimeout(numDebounceTimer);
            numDebounceTimer = setTimeout(() => {
                const rawStr = input.value.trim();
                if (rawStr === '' || isFieldOperatorExpression(rawStr) || !/^-?\d*\.?\d+$/.test(rawStr)) return;
                const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
                const raw = field.type === 'int' ? parseInt(rawStr, 10) : parseFloat(rawStr);
                const previousValue = this.getFieldValue(node, field);
                if (!isMixed && Object.is(previousValue, raw)) return;
                if (Number.isFinite(raw) && this.mayEditField(node, field, raw)) {
                    node.clearFieldOperator?.(field.key);
                    const updated = this.setFieldValue(node, field, raw);
                    if (isMixed || !Object.is(updated, previousValue)) {
                        onChange(field.key, updated, previousValue);
                    }
                }
            }, 100);
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            if (node.hasFieldOperator?.(field.key)) {
                input.value = node.getFieldOperator(field.key);
            }
            input.classList.remove('is-pool-computed');
            input.select();
        });

        input.addEventListener('blur', () => {
            clearTimeout(numDebounceTimer);
            if (!committedOnEnter) {
                commit();
            } else {
                syncDisplay();
            }
        });

        input.addEventListener('change', () => {
            clearTimeout(numDebounceTimer);
            if (!committedOnEnter) {
                commit();
            }
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                committedOnEnter = true;
                clearTimeout(numDebounceTimer);
                commit();
                input.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                committedOnEnter = true;
                clearTimeout(numDebounceTimer);
                input.blur();
                syncDisplay();
            }
        });

        const resolveWheelStep = (): number => {
            return getParameterWheelStep(field.type === 'int');
        };

        const applyDirectValue = (nextValue: number) => {
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (!this.mayEditField(node, field, nextValue)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, nextValue);
            input.value = String(updated);
            syncDisplay();
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        };

        registerParameterWheelControl(input, {
            isInteger: field.type === 'int',
            getValue: () => Number(this.getFieldValue(node, field) ?? field.default ?? 0),
            setValue: (nextVal) => applyDirectValue(nextVal),
        });
        input.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey || input.disabled) return;
            const currentValue = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = resolveWheelStep();
            const nextValue = roundStepValue(currentValue + direction * step, step);
            applyDirectValue(nextValue);
        }, { passive: false });

        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefreshed);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncDisplay();
                }
            };
            window.addEventListener('node-properties-refreshed', onRefreshed);
        }

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
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'td-param-input';

        const getGlobalValue = () => {
            const graph = (window as any).editorGraph;
            const paramKey = (field.key === 'target_bpm' || field.key === 'bpm') ? 'bpm' : field.key;

            if (graph && node.id != null) {
                const trackNodesMap = (window as any).trackNodes as Map<number, any> | undefined;
                const nodeData = trackNodesMap?.get(node.id);
                if (nodeData?.parentId != null) {
                    const parentData = trackNodesMap?.get(nodeData.parentId);
                    const parentNode = graph.getNodeById(nodeData.parentId);
                    if (paramKey === 'bpm') {
                        const parentBpm = parentData?.target_bpm ?? parentData?.bpm ?? parentNode?.properties?.target_bpm ?? parentNode?.properties?.bpm;
                        if (Number.isFinite(Number(parentBpm))) {
                            return Number(parentBpm);
                        }
                    } else if (paramKey === 'total_bars') {
                        const parentBars = parentData?.total_bars ?? parentNode?.properties?.total_bars;
                        if (Number.isFinite(Number(parentBars))) {
                            return Number(parentBars);
                        }
                    }
                }
            }

            const getter = (window as any).getGlobalParameter;
            const value = typeof getter === 'function' ? Number(getter(paramKey)) : Number.NaN;
            return Number.isFinite(value) ? value : (typeof field.default === 'number' ? field.default : (paramKey === 'bpm' ? 120 : (paramKey === 'total_bars' ? 4 : 0)));
        };
        let lastLocalValue: number | null = null;
        const refresh = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            if (isMixed) {
                scope.classList.remove('active');
                scope.setAttribute('aria-pressed', 'false');
                input.disabled = false;
                if (typeof document === 'undefined' || document.activeElement !== input) {
                    input.value = '';
                }
                input.classList.remove('is-pool-computed');
                input.title = 'Multiple values selected';
                return;
            }
            const current = this.getFieldValue(node, field);
            const isGlobal = String(current).toLowerCase() === 'global';
            if (!isGlobal && Number.isFinite(Number(current))) lastLocalValue = Number(current);
            scope.classList.toggle('active', isGlobal);
            scope.setAttribute('aria-pressed', String(isGlobal));
            input.disabled = isGlobal;
            if (typeof document === 'undefined' || document.activeElement !== input) {
                input.value = String(isGlobal ? getGlobalValue() : current);
                input.classList.toggle('is-pool-computed', !isGlobal && this.isFieldCalculated(node, field.key));
            }
            input.title = isGlobal ? `Inherited from global ${field.label.toLowerCase()}` : 'Custom local value · Supports Field Operators';
        };

        const onGlobalParamChange = () => {
            if (!wrapper.isConnected) {
                window.removeEventListener('global-parameters-changed', onGlobalParamChange);
                return;
            }
            if (node.hasMixedSlotValues?.(field.key)) return;
            const current = this.getFieldValue(node, field);
            if (String(current).toLowerCase() === 'global') {
                input.value = String(getGlobalValue());
            }
        };
        window.addEventListener('global-parameters-changed', onGlobalParamChange);
        let committedOnEnter = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (rawStr === '' && isMixed) return;
            const previousValue = this.getFieldValue(node, field);
            if (isFieldOperatorExpression(rawStr)) {
                node.resetTriggerCount?.();
                const evaluated = node.applyFieldOperator(field.key, rawStr, field);
                const updated = this.setFieldValue(node, field, evaluated);
                node.setFieldOperator(field.key, rawStr);
                refresh();
                onChange(field.key, updated, previousValue);
                return;
            }
            node.clearFieldOperator?.(field.key);
            const raw = parseFloat(rawStr);
            if (!Number.isFinite(raw)) {
                refresh();
                return;
            }
            if (!isMixed && Object.is(previousValue, raw)) {
                refresh();
                return;
            }
            const updated = this.setFieldValue(node, field, raw);
            refresh();
            if (isMixed || !Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        };

        scope.addEventListener('click', () => {
            const previousValue = this.getFieldValue(node, field);
            const isGlobal = String(previousValue).toLowerCase() === 'global';
            const nextValue = isGlobal
                ? (lastLocalValue ?? getGlobalValue())
                : 'global';
            if (Object.is(previousValue, nextValue)) return;
            node.clearFieldOperator?.(field.key);
            const updated = this.setFieldValue(node, field, nextValue);
            refresh();
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        });
        input.addEventListener('focus', () => {
            committedOnEnter = false;
            if (node.hasFieldOperator?.(field.key)) {
                input.value = node.getFieldOperator(field.key);
            }
            input.classList.remove('is-pool-computed');
            input.select();
        });
        input.addEventListener('blur', () => {
            if (!committedOnEnter) {
                commit();
            } else {
                refresh();
            }
        });
        input.addEventListener('change', () => {
            if (!committedOnEnter) {
                commit();
            }
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                committedOnEnter = true;
                commit();
                input.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                committedOnEnter = true;
                input.blur();
                refresh();
            }
        });
        const applyGlobalNumberValue = (nextVal: number) => {
            if (input.disabled) return;
            node.clearFieldOperator?.(field.key);
            const previousValue = this.getFieldValue(node, field);
            if (Object.is(previousValue, nextVal)) return;
            const updated = this.setFieldValue(node, field, nextVal);
            refresh();
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        };
        registerParameterWheelControl(input, {
            isInteger: false,
            getValue: () => Number(this.getFieldValue(node, field) ?? field.default ?? 0),
            setValue: (nextVal) => applyGlobalNumberValue(nextVal),
        });
        input.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey || input.disabled) return;
            const currentValue = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = getParameterWheelStep();
            const nextVal = roundStepValue(currentValue + direction * step, step);
            applyGlobalNumberValue(nextVal);
        }, { passive: false });
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
        select.className = 'td-param-select sin-select';

        const isMixedInit = node.hasMixedSlotValues?.(field.key) ?? false;
        const currentValue = this.getFieldValue(node, field);

        if (isMixedInit) {
            const blankOpt = document.createElement('option');
            blankOpt.value = '';
            blankOpt.textContent = '';
            blankOpt.selected = true;
            blankOpt.disabled = true;
            select.appendChild(blankOpt);
        }

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
            if (!isMixedInit && String(optionEl.value) === String(currentValue)) {
                optionEl.selected = true;
            }
            select.appendChild(optionEl);
        }

        select.addEventListener('change', () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const previousValue = this.getFieldValue(node, field);
            if (!isMixed && Object.is(previousValue, select.value)) return;
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
        const isMixedInit = node.hasMixedSlotValues?.(field.key) ?? false;
        return RadioGroup.create({
            name: `${field.key}-${node.id}`,
            value: isMixedInit ? '' : String(this.getFieldValue(node, field)),
            options: (field.options || []).map(option => typeof option === 'object'
                ? { value: String(option.value), label: option.label }
                : { value: String(option), label: String(option) }),
            ariaLabel: field.label,
            onChange: value => {
                const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
                const previousValue = this.getFieldValue(node, field);
                if (!isMixed && Object.is(previousValue, value)) return;
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
            if (Object.is(previousValue, input.checked)) return;
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
            const isCalc = this.isFieldCalculated(node, field.key);
            container.classList.toggle('is-pool-computed', isCalc);
            labelText.classList.toggle('is-pool-computed', isCalc);
        };
        updateUI(currentDb);

        let isDragging = false;
        let hasDragged = false;
        let startX = 0;
        let startDb = 0;

        const openDirectInput = () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = node.hasFieldOperator?.(field.key)
                ? node.getFieldOperator(field.key)
                : activeDb.toFixed(1);
            input.className = 'td-float-direct-input';

            container.innerHTML = '';
            container.appendChild(input);
            input.focus();
            input.select();

            let committed = false;
            const commitInput = () => {
                if (committed) return;
                committed = true;
                const rawStr = input.value.trim();
                const previousValue = this.getFieldValue(node, field);
                if (isFieldOperatorExpression(rawStr)) {
                    node.resetTriggerCount?.();
                    const evaluated = node.applyFieldOperator(field.key, rawStr, field);
                    const updated = Number(this.setFieldValue(node, field, evaluated));
                    node.setFieldOperator(field.key, rawStr);
                    updateUI(updated);
                    onChange(field.key, updated, previousValue);
                } else {
                    const parsed = parseFloat(rawStr);
                    if (!isNaN(parsed)) {
                        node.clearFieldOperator?.(field.key);
                        if (!Object.is(previousValue, parsed)) {
                            updateUI(parsed);
                            const updated = this.setFieldValue(node, field, activeDb);
                            onChange(field.key, updated, previousValue);
                        } else {
                            updateUI(activeDb);
                        }
                    }
                }
                container.innerHTML = '';
                container.appendChild(labelText);
                updateUI(activeDb);
            };

            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    commitInput();
                } else if (evt.key === 'Escape') {
                    committed = true;
                    container.innerHTML = '';
                    container.appendChild(labelText);
                    updateUI(activeDb);
                }
            });

            input.addEventListener('blur', commitInput);
        };

        container.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 || e.target !== container && e.target !== labelText) return;
            isDragging = true;
            hasDragged = false;
            startX = e.clientX;
            startDb = activeDb;
            try { container.setPointerCapture(e.pointerId); } catch (_) {}
            container.classList.add('dragging');
            e.preventDefault();
        });

        container.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            if (!hasDragged && Math.abs(dx) < 3) return;
            hasDragged = true;
            node.clearFieldOperator?.(field.key);
            const deltaDb = dx * 0.15;
            const newDb = Math.round((startDb + deltaDb) * 10) / 10;
            if (newDb === activeDb) return;
            const previousValue = this.getFieldValue(node, field);
            updateUI(newDb);
            const updated = this.setFieldValue(node, field, activeDb);
            if (!Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        });

        const stopDrag = (e: PointerEvent) => {
            if (isDragging) {
                isDragging = false;
                container.classList.remove('dragging');
                try { container.releasePointerCapture(e.pointerId); } catch (_) {}
                if (!hasDragged && node.hasFieldOperator?.(field.key)) {
                    openDirectInput();
                }
            }
        };

        container.addEventListener('pointerup', stopDrag);
        container.addEventListener('pointercancel', stopDrag);

        const applyDbValue = (nextDb: number) => {
            node.clearFieldOperator?.(field.key);
            const previousValue = this.getFieldValue(node, field);
            updateUI(nextDb);
            const updated = this.setFieldValue(node, field, activeDb);
            if (!Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
        };

        registerParameterWheelControl(container, {
            isInteger: false,
            getValue: () => activeDb,
            setValue: (nextDb) => applyDbValue(nextDb),
            formatValue: (val) => formatDb(Math.max(-36.0, Math.min(12.0, val))),
        });
        container.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = getParameterWheelStep();
            applyDbValue(roundStepValue(activeDb + direction * step, step));
        }, { passive: false });

        container.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openDirectInput();
        });

        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!container.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefreshed);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    updateUI(Number(this.getFieldValue(node, field) ?? 0.0));
                }
            };
            window.addEventListener('node-properties-refreshed', onRefreshed);
        }

        return container;
    }

    private static createSeedWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'td-seed-controller';
        wrapper.style.display = 'flex';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';
        wrapper.style.width = '100%';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'td-param-input td-seed-input';
        input.style.flex = '1';
        input.placeholder = '42, 42 108, or rand';
        input.title = 'Seed expression: single integer ("42"), sequence ("42 108"), or "rand"';
        const syncSeedDisplay = () => {
            if (typeof document !== 'undefined' && document.activeElement === input) return;
            const currentVal = String(this.getFieldValue(node, field) ?? '42');
            if (isFieldOperatorExpression(currentVal)) {
                const resolvedSeed = node.evaluateFieldOperatorForKey(field.key, currentVal, field);
                input.value = String(resolvedSeed);
                input.classList.add('is-pool-computed');
                return;
            }
            input.value = currentVal;
            input.classList.toggle('is-pool-computed', this.isFieldCalculated(node, field.key));
        };
        syncSeedDisplay();

        const refreshKey = `${field.key}_refresh`;
        const isArmed = (): boolean => node.properties?.[refreshKey] !== false;

        const refreshToggle = document.createElement('button');
        refreshToggle.type = 'button';
        refreshToggle.className = 'td-seed-refresh-toggle td-param-action-btn';
        refreshToggle.style.padding = '2px 7px';
        refreshToggle.style.height = '26px';
        refreshToggle.style.fontSize = '12px';
        refreshToggle.style.fontWeight = '700';
        refreshToggle.style.lineHeight = '1';
        refreshToggle.textContent = '↻';

        const syncToggleUI = () => {
            const armed = isArmed();
            refreshToggle.classList.toggle('is-active', armed);
            refreshToggle.classList.toggle('active', armed);
            refreshToggle.setAttribute('aria-pressed', String(armed));
            refreshToggle.title = armed
                ? 'Armed for Refresh: global Refresh will roll this seed (click to lock)'
                : 'Locked from Refresh: global Refresh will keep this seed (click to arm)';
            refreshToggle.style.borderColor = armed ? '#0284c7' : '#cbd5e1';
            refreshToggle.style.background = armed ? '#e0f2fe' : '#f8fafc';
            refreshToggle.style.color = armed ? '#0369a1' : '#94a3b8';
        };
        syncToggleUI();

        let committedOnEnter = false;
        const commitValue = (rawVal: string | number) => {
            const trimmed = String(rawVal ?? '').trim() || '42';
            const previousValue = this.getFieldValue(node, field);
            if (isFieldOperatorExpression(trimmed)) {
                node.resetTriggerCount?.();
                node.setFieldOperator(field.key, trimmed);
                const updated = this.setFieldValue(node, field, trimmed as any);
                syncSeedDisplay();
                onChange(field.key, updated, previousValue);
                return;
            }
            node.clearFieldOperator?.(field.key);
            const asNum = Number(trimmed);
            const normalized: string | number = (!trimmed.includes(' ') && Number.isFinite(asNum))
                ? Math.round(asNum)
                : trimmed;
            if (Object.is(previousValue, normalized)) {
                syncSeedDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, normalized);
            syncSeedDisplay();
            onChange(field.key, updated, previousValue);
        };

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            const currentVal = String(this.getFieldValue(node, field) ?? '42');
            input.value = node.hasFieldOperator?.(field.key) ? node.getFieldOperator(field.key) : currentVal;
            input.classList.remove('is-pool-computed');
            input.select();
        });
        input.addEventListener('blur', () => {
            if (!committedOnEnter) {
                commitValue(input.value);
            } else {
                syncSeedDisplay();
            }
        });
        input.addEventListener('change', () => {
            if (!committedOnEnter) {
                commitValue(input.value);
            }
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                committedOnEnter = true;
                commitValue(input.value);
                input.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                committedOnEnter = true;
                input.blur();
                syncSeedDisplay();
            }
        });
        input.addEventListener('wheel', event => {
            const currentNumeric = Number(input.value);
            if (!Number.isFinite(currentNumeric) || input.value.includes(' ')) return;
            event.preventDefault();
            if (event.altKey || input.disabled) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            commitValue(Math.max(0, Math.round(currentNumeric + direction * getParameterWheelStep(true))));
        }, { passive: false });

        refreshToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const prevArmed = isArmed();
            const nextArmed = !prevArmed;
            node.updateProperty(refreshKey, nextArmed);
            syncToggleUI();
        });

        const onPropertiesRefreshed = (evt: Event) => {
            if (!wrapper.isConnected) {
                window.removeEventListener('node-properties-refreshed', onPropertiesRefreshed);
                return;
            }
            const detail = (evt as CustomEvent)?.detail;
            if (!detail || detail.nodeId === node.id) {
                syncSeedDisplay();
                syncToggleUI();
            }
        };
        window.addEventListener('node-properties-refreshed', onPropertiesRefreshed);

        wrapper.appendChild(input);
        wrapper.appendChild(refreshToggle);
        return wrapper;
    }
}
