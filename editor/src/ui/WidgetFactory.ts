import { type FieldSchema } from '../fields/FieldSchema.ts';
import {
    AUDIO_POSITION_UNITS,
    canonicalToUnit,
    formatUnitValue,
    getUnitDefinition,
    parseUnitInput,
    resolveFieldUnit,
    resolveNodeUnitContext,
    setFieldUnit,
    unitToCanonical,
    type MeasurementUnitId,
    type UnitFieldConfig,
} from '../fields/UnitConverter.ts';
import { type BaseNode } from '../nodes/BaseNode.ts';
import { fetchLibrary } from '../api.ts';
import { groupFileVersions } from '../libraryVersioning.ts';
import { RadioGroup } from './components/RadioGroup.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from './ParameterWheelMenu.ts';
import {
    getPoolItemCallName,
    isCalculatedPoolQuery,
    isFieldOperatorExpression,
} from '../../../ermes/ts/slotLanguage.ts';
import { resolveEffectivePoolSeed, resolvePoolItemByQuery } from '../../../ermes/ts/assetResolver.ts';
import { hasAudioDragPayload, resolveDroppedAudioItems } from './dragPayload.ts';
import { findChainModuleParam, parseChainParamFieldKey } from '../dsp/processorRegistry.ts';
import { renderIcon } from '../../../packages/ui/src/icons.js';
import { enhanceSelect } from '../../../packages/ui/src/dropdown.js';
import { enhanceRangeSlider } from '../../../packages/ui/src/slider.js';

function formatDb(db: number): string {
    if (db <= -35.9) return "-inf dB";
    if (Math.abs(db) < 0.05) return "0.0 dB";
    if (db > 0) return `+${db.toFixed(1)} dB`;
    return `${db.toFixed(1)} dB`;
}

export class WidgetFactory {
    static getFieldValue<T = any>(node: BaseNode, field: FieldSchema<T>): T {
        if (typeof field.getValue === 'function') {
            return field.getValue(node);
        }
        const chainKey = parseChainParamFieldKey(field.key);
        if (chainKey) {
            const found = findChainModuleParam(node, field.key);
            if (found) {
                const raw = found.module.params?.[chainKey.paramKey];
                if (raw === undefined || raw === null) return field.default;
                if (field.type === 'boolean') return (typeof raw === 'boolean' ? raw : Number(raw) >= 0.5) as unknown as T;
                return raw as unknown as T;
            }
        }
        const p = node.properties || {};
        const val = p[field.key];
        return val !== undefined ? val : field.default;
    }

    static setFieldValue<T = any>(node: BaseNode, field: FieldSchema<T>, val: T): T {
        if (!node.properties) node.properties = {};
        let validatedVal = val;

        if (field.type === 'boolean') {
            validatedVal = Boolean(val) as unknown as T;
        } else if (field.type === 'int') {
            let num = typeof val === 'number' ? val : parseInt(String(val), 10);
            if (isNaN(num)) num = typeof field.default === 'number' ? field.default : 0;
            if (field.min !== undefined) num = Math.max(field.min, num);
            if (field.max !== undefined) num = Math.min(field.max, num);
            validatedVal = Math.round(num) as unknown as T;
        } else if (field.type === 'global_float' && String(val).toLowerCase() === 'global') {
            validatedVal = 'global' as unknown as T;
        } else if (field.type === 'float' || field.type === 'unit_float' || field.type === 'global_float' || field.type === 'db' || field.type === 'slider') {
            let num = typeof val === 'number' ? val : parseFloat(String(val));
            if (isNaN(num)) {
                num = typeof field.default === 'number' ? field.default : (field.key === 'target_bpm' || field.key === 'bpm' ? 120 : 0);
            }
            if (field.min !== undefined) num = Math.max(field.min, num);
            if (field.max !== undefined) num = Math.min(field.max, num);
            validatedVal = num as unknown as T;
        } else if (field.type === 'select' && typeof field.default === 'number') {
            const num = Number(val);
            if (Number.isFinite(num)) validatedVal = num as unknown as T;
        } else if ((field.type === 'radio' || field.type === 'select') && typeof field.default === 'boolean') {
            validatedVal = (val === true || String(val).toLowerCase() === 'true') as unknown as T;
        }

        if (typeof field.setValue === 'function') {
            return field.setValue(node, validatedVal);
        }

        const chainKey = parseChainParamFieldKey(field.key);
        if (chainKey && Array.isArray(node.properties.chain)) {
            const nextChain = node.properties.chain.map((m: any) =>
                m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m
            );
            const mod = nextChain.find((m: any) => m && String(m.id) === chainKey.moduleId);
            if (mod) {
                mod.params[chainKey.paramKey] = field.type === 'boolean' ? (validatedVal ? 1 : 0) : Number(validatedVal);
                node.updateProperty('chain', nextChain);
                return validatedVal;
            }
        }

        node.updateProperty(field.key, validatedVal);
        return validatedVal;
    }

    private static mayEditField<T = any>(node: BaseNode, field: FieldSchema<T>, value: T): boolean {
        const previousValue = this.getFieldValue(node, field);
        return node.preparePropertyEdit(field.key, value, previousValue) !== false;
    }

    static isFieldDynamicAllowed(field: FieldSchema): boolean {
        if (field.dynamic !== undefined) return field.dynamic;
        const nonDynamicKeys = new Set([
            'node_name',
            'key',
            'original_bpm',
            'scope_mode',
            'scope_window',
            'scope_gain',
        ]);
        if (nonDynamicKeys.has(field.key) || field.key.startsWith('export_')) {
            return false;
        }
        switch (field.type) {
            case 'int':
            case 'float':
            case 'unit_float':
            case 'global_float':
            case 'slider':
            case 'db':
            case 'select':
            case 'radio':
            case 'boolean':
            case 'seed':
            case 'asset_call':
            case 'tuple':
                return true;
            case 'string':
                return field.key === 'sample_slot' || field.key === 'section_slots' || field.key === 'pool_query';
            default:
                return false;
        }
    }

    private static resolveNodeAssetBasename(node: BaseNode): string {
        const assignedModifier = typeof node.getAttachedPoolNode === 'function' ? node.getAttachedPoolNode() : null;
        const poolItems = typeof (node as any).getPoolItems === 'function'
            ? (node as any).getPoolItems()
            : (Array.isArray(assignedModifier?.properties?.selected_items) ? assignedModifier.properties.selected_items : []);
        const effPoolSeed = resolveEffectivePoolSeed(assignedModifier, node);
        const poolSalt = typeof (node as any).getPoolSalt === 'function'
            ? (node as any).getPoolSalt()
            : Number(assignedModifier?.id || node.id || 0);
        const activeIdx = Math.max(0, Number((node as any).activeSlotIndex ?? node.properties?.active_slot ?? 0));
        const q = String(node.properties?.pool_query ?? '').trim();
        if (node.isFieldDynamicActive?.('pool_query') && isCalculatedPoolQuery(q, poolItems)) {
            if (isFieldOperatorExpression(q, poolItems)) {
                const liveFp = String(node._liveTriggeredFilepath || '');
                if (liveFp) {
                    const matchedLive = Array.isArray(poolItems)
                        ? poolItems.find((it: any) => String(it?.filepath || it?.absolute_path || '') === liveFp)
                        : null;
                    return matchedLive ? getPoolItemCallName(matchedLive, false) : (liveFp.split(/[\\/]/).pop() || liveFp);
                }
            }
            if (Array.isArray(poolItems) && poolItems.length > 0) {
                const chosen = resolvePoolItemByQuery(
                    poolItems,
                    q,
                    activeIdx,
                    node.properties?.seed ?? 42,
                    false,
                    node.getTriggerCount(),
                    { poolSeed: effPoolSeed, nodeId: poolSalt }
                );
                if (chosen) return getPoolItemCallName(chosen, false);
            }
        }
        const slotFp = Array.isArray(node.properties?.slots) ? String(node.properties.slots[activeIdx]?.filepath || '') : '';
        const filepath = String(node.properties?.filepath || slotFp || '');
        if (filepath && Array.isArray(poolItems) && poolItems.length > 0) {
            const matched = poolItems.find((it: any) => String(it?.filepath || it?.absolute_path || '') === filepath);
            if (matched) return getPoolItemCallName(matched, false);
        }
        if (filepath) return filepath.split(/[\\/]/).pop() || filepath;
        return '';
    }

    static createDynamicExpressionDrawer(options: {
        placeholder?: string;
        ariaLabel: string;
        isDynamicActive: () => boolean;
        getExpression: () => string;
        onToggle: (nextActive: boolean) => void | Promise<void>;
        onCommitExpression: (expr: string) => void | Promise<void>;
    }): {
        element: HTMLDivElement;
        toggleBtn: HTMLButtonElement;
        input: HTMLInputElement;
        sync: () => void;
        focusInput: () => void;
    } {
        const drawer = document.createElement('div');
        drawer.className = 'td-dynamic-drawer';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'td-dynamic-toggle';
        toggleBtn.setAttribute('aria-label', `Toggle dynamic expression for ${options.ariaLabel}`);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'td-dynamic-input';
        input.placeholder = options.placeholder || 'rand, min..max, or list';
        input.setAttribute('aria-label', `${options.ariaLabel} dynamic expression`);

        drawer.append(toggleBtn, input);

        const sync = () => {
            const active = Boolean(options.isDynamicActive());
            const expr = String(options.getExpression() ?? '');
            drawer.classList.toggle('is-active', active);
            drawer.classList.toggle('is-inactive', !active);
            toggleBtn.classList.toggle('is-active', active);
            toggleBtn.setAttribute('aria-pressed', String(active));
            toggleBtn.title = active
                ? 'Dynamic expression ON — click to fall back to static value'
                : 'Dynamic expression OFF — click to enable pseudolang expression';
            input.disabled = !active;
            input.dataset.dynamicActive = active ? 'true' : 'false';
            input.classList.toggle('is-disabled', !active);
            input.classList.toggle('is-pool-computed', active && Boolean(expr));
            if (typeof document === 'undefined' || document.activeElement !== input) {
                input.value = expr;
            }
        };

        const focusInput = () => {
            if (!input.disabled) {
                input.focus();
                input.select();
            }
        };

        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const nextActive = !options.isDynamicActive();
            void Promise.resolve(options.onToggle(nextActive)).then(() => {
                sync();
                if (nextActive && !options.getExpression()) {
                    focusInput();
                }
            });
        });

        let committedOnEnter = false;
        const commit = () => {
            if (input.disabled) return;
            const raw = input.value.trim();
            void Promise.resolve(options.onCommitExpression(raw)).then(() => {
                sync();
            });
        };

        input.addEventListener('focus', () => {
            committedOnEnter = false;
        });
        input.addEventListener('blur', () => {
            if (!committedOnEnter) {
                commit();
            } else {
                sync();
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
                sync();
            }
        });

        sync();
        return { element: drawer, toggleBtn, input, sync, focusInput };
    }

    private static buildFieldDynamicDrawer(
        field: FieldSchema,
        node: BaseNode,
        syncTargetWidget: () => void,
        onChange: (key: string, val: any, previousValue: any) => void,
        onAfterSync?: () => void
    ) {
        const isAssetCall = field.type === 'asset_call' || field.key === 'pool_query';
        const dynamicPlaceholder = isAssetCall
            ? 'rand, 0 1, [a b], <0 1>'
            : field.type === 'radio' || field.type === 'select'
                ? 'rand, or space-separated options'
                : field.type === 'boolean'
                    ? 'rand, 0 1, or <off on>'
                    : field.type === 'unit_float'
                        ? 'rand, 0..0.5, or 0 0.25'
                        : 'rand, min..max, or list';

        return this.createDynamicExpressionDrawer({
            placeholder: dynamicPlaceholder,
            ariaLabel: field.label,
            isDynamicActive: () => Boolean(node.isFieldDynamicActive?.(field.key)),
            getExpression: () => String(node.getSavedDynamicExpression?.(field.key) ?? ''),
            onToggle: (nextActive) => {
                if (isAssetCall) {
                    const prevVal = String(node.properties?.pool_query ?? '');
                    const poolItems = typeof (node as any).getPoolItems === 'function' ? (node as any).getPoolItems() : [];
                    const resolvedBasename = this.resolveNodeAssetBasename(node);
                    const rawQuery = prevVal.trim();
                    const staticFallback = (node.isFieldDynamicActive?.('pool_query') && isCalculatedPoolQuery(rawQuery, poolItems))
                        ? resolvedBasename
                        : (rawQuery || resolvedBasename);
                    const result = node.toggleFieldDynamic('pool_query', nextActive, field, {
                        currentStaticFallback: staticFallback,
                        currentResolvedValue: resolvedBasename,
                    });
                    syncTargetWidget();
                    onAfterSync?.();
                    if (result.changed || !Object.is(result.value, prevVal)) {
                        onChange('pool_query', result.value, prevVal);
                    }
                    return;
                }

                const prevVal = this.getFieldValue(node, field);
                const result = node.toggleFieldDynamic(field.key, nextActive, field, {
                    currentStaticFallback: prevVal,
                    currentResolvedValue: prevVal,
                });
                syncTargetWidget();
                onAfterSync?.();
                if (result.changed || !Object.is(result.value, prevVal)) {
                    onChange(field.key, result.value, prevVal);
                }
            },
            onCommitExpression: (rawExpr) => {
                const trimmed = rawExpr.trim();
                if (isAssetCall) {
                    const prevVal = String(node.properties?.pool_query ?? '');
                    const poolItems = typeof (node as any).getPoolItems === 'function' ? (node as any).getPoolItems() : [];
                    const assignedModifier = typeof node.getAttachedPoolNode === 'function' ? node.getAttachedPoolNode() : null;
                    const resolvedBasename = this.resolveNodeAssetBasename(node);

                    if (!trimmed) {
                        node.setSavedDynamicExpression?.('pool_query', '');
                        const result = node.toggleFieldDynamic('pool_query', false, field, {
                            currentResolvedValue: resolvedBasename,
                        });
                        syncTargetWidget();
                        onAfterSync?.();
                        onChange('pool_query', result.value, prevVal);
                        return;
                    }

                    if (!node.hasStaticFieldValue?.('pool_query')) {
                        const rawQ = prevVal.trim();
                        const initialStatic = (node.isFieldDynamicActive?.('pool_query') && isCalculatedPoolQuery(rawQ, poolItems))
                            ? resolvedBasename
                            : (rawQ || resolvedBasename);
                        node.setStaticFieldValue?.('pool_query', initialStatic);
                    }

                    node.setSavedDynamicExpression?.('pool_query', trimmed);
                    node.setFieldDynamicActive?.('pool_query', true);
                    const sampleWithPool = node as BaseNode & { applyPoolQuery?: (q: string, advanceSaltOnRand?: boolean, opts?: { forceStatic?: boolean; forceDynamic?: boolean }) => boolean };
                    if (typeof sampleWithPool.applyPoolQuery === 'function' && (poolItems.length > 0 || assignedModifier)) {
                        if (isFieldOperatorExpression(trimmed, poolItems)) {
                            node.resetTriggerCount?.();
                        }
                        sampleWithPool.applyPoolQuery(trimmed, false, { forceDynamic: true });
                        node.setSavedDynamicExpression?.('pool_query', trimmed);
                        node.setFieldDynamicActive?.('pool_query', true);
                    } else {
                        node.updateProperty('pool_query', trimmed);
                    }
                    syncTargetWidget();
                    onAfterSync?.();
                    onChange('pool_query', trimmed, prevVal);
                    return;
                }

                const prevVal = this.getFieldValue(node, field);
                if (!trimmed) {
                    node.setSavedDynamicExpression?.(field.key, '');
                    const result = node.toggleFieldDynamic(field.key, false, field, {
                        currentResolvedValue: prevVal,
                    });
                    syncTargetWidget();
                    onAfterSync?.();
                    if (result.changed || !Object.is(result.value, prevVal)) {
                        onChange(field.key, result.value, prevVal);
                    }
                    return;
                }
                if (!node.hasStaticFieldValue?.(field.key)) {
                    node.setStaticFieldValue?.(field.key, prevVal);
                }
                node.setSavedDynamicExpression?.(field.key, trimmed);
                if (isFieldOperatorExpression(trimmed)) {
                    node.resetTriggerCount?.();
                    const evaluated = node.applyFieldOperator(field.key, trimmed, field);
                    const updated = (field.key === 'sample_slot' || field.key === 'seed')
                        ? this.setFieldValue(node, field, trimmed as any)
                        : this.setFieldValue(node, field, evaluated);
                    node.setFieldOperator(field.key, trimmed);
                    syncTargetWidget();
                    onAfterSync?.();
                    onChange(field.key, updated, prevVal);
                    return;
                }
                node.clearFieldOperator?.(field.key);
                node.setSavedDynamicExpression?.(field.key, trimmed);
                node.setFieldDynamicActive?.(field.key, true);
                let evaluated: any;
                if (field.type === 'unit_float') {
                    const unitConfig = field.unitConfig || {
                        family: 'audio_position' as const,
                        canonical: 'fraction' as const,
                        units: AUDIO_POSITION_UNITS,
                    };
                    const ctx = resolveNodeUnitContext(node);
                    const activeUnit = resolveFieldUnit(node, field.key, unitConfig, ctx);
                    const parsed = parseUnitInput(trimmed, activeUnit);
                    evaluated = parsed
                        ? unitToCanonical(parsed.value, parsed.unit, unitConfig.canonical, ctx)
                        : node.evaluateFieldOperatorForKey(field.key, trimmed, field);
                } else if (field.key === 'sample_slot' || field.key === 'seed') {
                    evaluated = trimmed;
                } else {
                    evaluated = node.evaluateFieldOperatorForKey(field.key, trimmed, field);
                }
                const updated = this.setFieldValue(node, field, evaluated);
                node.setFieldDynamicActive?.(field.key, true);
                syncTargetWidget();
                onAfterSync?.();
                onChange(field.key, updated, prevVal);
            },
        });
    }

    static isFieldCalculated(node: BaseNode, key: string): boolean {
        if (node.properties?.field_dynamic_enabled?.[key] === false) return false;
        if (node.hasFieldOperator?.(key)) return true;
        if (node.isFieldDynamicActive?.(key) && Boolean(node.getSavedDynamicExpression?.(key))) return true;
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
        if (field.type === 'tuple') {
            return this.createTupleRow(field, node, onChange);
        }

        const row = document.createElement('div');
        row.className = 'td-param-row';
        row.setAttribute('data-field-key', field.key);
        row.setAttribute('data-param-label', field.label);

        const labelEl = document.createElement('div');
        labelEl.className = 'td-param-label';
        labelEl.textContent = field.label + (field.unit && field.type !== 'unit_float' ? ` (${field.unit})` : '');
        row.appendChild(labelEl);
        if (field.description) row.title = field.description;

        const controlEl = document.createElement('div');
        controlEl.className = 'td-param-control';
        row.appendChild(controlEl);

        let syncDynamicUI: (() => void) | null = null;
        const wrappedOnChange = (key: string, val: any, previousValue: any) => {
            if (!node.isFieldDynamicActive?.(field.key) && !node.hasFieldOperator?.(field.key)) {
                node.setStaticFieldValue?.(field.key, val);
            }
            syncDynamicUI?.();
            onChange(key, val, previousValue);
        };

        const widget = this.createWidget(field, node, wrappedOnChange);
        controlEl.appendChild(widget);
        if (field.type === 'select' && widget instanceof HTMLSelectElement) {
            enhanceSelect(widget);
        }

        if (this.isFieldDynamicAllowed(field)) {
            row.classList.add('td-param-row-dynamic');
            labelEl.classList.add('is-dynamic-capable');
            labelEl.title = field.description
                ? `${field.description} · Click field name to toggle dynamic expression`
                : 'Click field name to toggle dynamic expression';

            if (!((node as any).__openDynamicFieldDrawers instanceof Set)) {
                (node as any).__openDynamicFieldDrawers = new Set<string>();
            }
            const openDrawers: Set<string> = (node as any).__openDynamicFieldDrawers;

            const drawerCtrl = this.buildFieldDynamicDrawer(
                field,
                node,
                () => (widget as any).__syncDisplay?.(),
                onChange,
                () => syncDynamicUI?.()
            );

            const isOpenInitially = openDrawers.has(field.key);
            drawerCtrl.element.hidden = !isOpenInitially;
            row.classList.toggle('is-dynamic-open', isOpenInitially);

            syncDynamicUI = () => {
                drawerCtrl.sync();
                const isActive = Boolean(node.isFieldDynamicActive?.(field.key));
                row.classList.toggle('is-dynamic-active', isActive);
            };
            syncDynamicUI();

            labelEl.addEventListener('click', (event) => {
                const target = event.target as HTMLElement | null;
                if (target?.closest('.ghost-binding-toggle')) return;
                event.preventDefault();
                event.stopPropagation();
                const nextOpen = Boolean(drawerCtrl.element.hidden);
                drawerCtrl.element.hidden = !nextOpen;
                row.classList.toggle('is-dynamic-open', nextOpen);
                if (nextOpen) {
                    openDrawers.add(field.key);
                    drawerCtrl.sync();
                } else {
                    openDrawers.delete(field.key);
                }
            });

            if (typeof window !== 'undefined') {
                const onRowRefreshed = (evt: Event) => {
                    if (!row.isConnected) {
                        window.removeEventListener('node-properties-refreshed', onRowRefreshed);
                        return;
                    }
                    const detail = (evt as CustomEvent)?.detail;
                    if (!detail || detail.nodeId === node.id) {
                        syncDynamicUI?.();
                    }
                };
                window.addEventListener('node-properties-refreshed', onRowRefreshed);
            }

            row.appendChild(drawerCtrl.element);
        }

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

    private static createTupleRow(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'td-param-row td-param-row-tuple';
        row.setAttribute('data-field-key', field.key);
        row.setAttribute('data-param-label', field.label);

        const labelEl = document.createElement('div');
        labelEl.className = 'td-param-label';
        labelEl.textContent = field.label;
        row.appendChild(labelEl);
        if (field.description) row.title = field.description;

        const controlEl = document.createElement('div');
        controlEl.className = 'td-param-control';
        row.appendChild(controlEl);

        const allNodeFields = node.getFields();
        const subFields = (field.subFields || [])
            .map(key => allNodeFields.find(candidate => candidate.key === key))
            .filter((candidate): candidate is FieldSchema => Boolean(candidate));

        const tupleWrap = document.createElement('div');
        tupleWrap.className = 'td-tuple-control';
        controlEl.appendChild(tupleWrap);

        const sharedUnitConfig = field.unitConfig;
        const subSyncHandlers: Array<() => void> = [];
        const drawerSyncHandlers: Array<() => void> = [];

        const syncAllSubDrawers = () => {
            for (const fn of drawerSyncHandlers) fn();
            const anyActive = subFields.some(sf => Boolean(node.isFieldDynamicActive?.(sf.key)));
            row.classList.toggle('is-dynamic-active', anyActive);
        };

        const subWidgets: HTMLElement[] = [];

        if (sharedUnitConfig) {
            tupleWrap.classList.add('td-tuple-control--with-unit');

            const unitSelect = document.createElement('select');
            unitSelect.className = 'td-unit-select td-tuple-unit-select';
            unitSelect.setAttribute('aria-label', `${field.label} unit`);
            for (const u of sharedUnitConfig.units) {
                const def = getUnitDefinition(u);
                const opt = document.createElement('option');
                opt.value = u;
                opt.textContent = def.shortLabel;
                opt.title = def.label;
                unitSelect.appendChild(opt);
            }

            const syncSharedUnitSelect = () => {
                const ctx = resolveNodeUnitContext(node);
                const anchorKey = subFields[0]?.key || field.key;
                const unit = resolveFieldUnit(node, anchorKey, sharedUnitConfig, ctx);
                if (unitSelect.value !== unit) unitSelect.value = unit;
                unitSelect.title = `Unit: ${getUnitDefinition(unit).label}`;
            };

            for (const subField of subFields) {
                const subUnitConfig = subField.unitConfig || sharedUnitConfig;
                const wrappedSubOnChange = (key: string, val: any, prev: any) => {
                    if (!node.isFieldDynamicActive?.(subField.key) && !node.hasFieldOperator?.(subField.key)) {
                        node.setStaticFieldValue?.(subField.key, val);
                    }
                    syncAllSubDrawers();
                    onChange(key, val, prev);
                };
                const inputEl = this.createUnitFloatInputPart(subField, node, subUnitConfig, wrappedSubOnChange);
                inputEl.classList.add('td-tuple-input');
                inputEl.placeholder = subField.label;
                inputEl.setAttribute('aria-label', `${field.label} ${subField.label}`);
                tupleWrap.appendChild(inputEl);
                subWidgets.push(inputEl);
                subSyncHandlers.push(() => (inputEl as any).__syncDisplay?.());
            }

            unitSelect.addEventListener('change', () => {
                const nextUnit = unitSelect.value as MeasurementUnitId;
                if (!sharedUnitConfig.units.includes(nextUnit)) return;
                const anchorKey = subFields[0]?.key || field.key;
                setFieldUnit(node, anchorKey, sharedUnitConfig, nextUnit);
                syncSharedUnitSelect();
                for (const fn of subSyncHandlers) fn();
            });

            syncSharedUnitSelect();
            tupleWrap.appendChild(unitSelect);

            if (typeof window !== 'undefined') {
                const onUnitOrProp = (evt: Event) => {
                    if (!tupleWrap.isConnected) {
                        window.removeEventListener('node-field-unit-changed', onUnitOrProp);
                        window.removeEventListener('node-property-changed', onUnitOrProp);
                        window.removeEventListener('node-properties-refreshed', onUnitOrProp);
                        return;
                    }
                    const detail = (evt as CustomEvent)?.detail;
                    if (!detail || detail.nodeId === node.id) {
                        syncSharedUnitSelect();
                        syncAllSubDrawers();
                    }
                };
                window.addEventListener('node-field-unit-changed', onUnitOrProp);
                window.addEventListener('node-property-changed', onUnitOrProp);
                window.addEventListener('node-properties-refreshed', onUnitOrProp);
            }
        } else {
            for (const subField of subFields) {
                const wrappedSubOnChange = (key: string, val: any, prev: any) => {
                    if (!node.isFieldDynamicActive?.(subField.key) && !node.hasFieldOperator?.(subField.key)) {
                        node.setStaticFieldValue?.(subField.key, val);
                    }
                    syncAllSubDrawers();
                    onChange(key, val, prev);
                };
                const subWidget = this.createWidget(subField, node, wrappedSubOnChange);
                subWidget.classList.add('td-tuple-input');
                tupleWrap.appendChild(subWidget);
                subWidgets.push(subWidget);
                subSyncHandlers.push(() => (subWidget as any).__syncDisplay?.());
            }
        }

        const dynamicSubFields = subFields.filter(sf => this.isFieldDynamicAllowed(sf));
        if (dynamicSubFields.length > 0 && this.isFieldDynamicAllowed(field)) {
            row.classList.add('td-param-row-dynamic');
            labelEl.classList.add('is-dynamic-capable');
            labelEl.title = field.description
                ? `${field.description} · Click field name to toggle dynamic expressions`
                : 'Click field name to toggle dynamic expressions';

            if (!((node as any).__openDynamicFieldDrawers instanceof Set)) {
                (node as any).__openDynamicFieldDrawers = new Set<string>();
            }
            const openDrawers: Set<string> = (node as any).__openDynamicFieldDrawers;

            const drawerStack = document.createElement('div');
            drawerStack.className = 'td-tuple-dynamic-drawer';

            subFields.forEach((subField, idx) => {
                if (!this.isFieldDynamicAllowed(subField)) return;
                const subWidget = subWidgets[idx];
                const subRowEl = document.createElement('div');
                subRowEl.className = 'td-tuple-dynamic-item';

                const subLabel = document.createElement('span');
                subLabel.className = 'td-tuple-sublabel';
                subLabel.textContent = subField.label;

                const drawerCtrl = this.buildFieldDynamicDrawer(
                    subField,
                    node,
                    () => (subWidget as any).__syncDisplay?.(),
                    onChange,
                    syncAllSubDrawers
                );
                drawerCtrl.element.classList.add('td-tuple-dynamic-subdrawer');
                drawerSyncHandlers.push(drawerCtrl.sync);

                subRowEl.append(subLabel, drawerCtrl.element);
                drawerStack.appendChild(subRowEl);
            });

            const isOpenInitially = openDrawers.has(field.key);
            drawerStack.hidden = !isOpenInitially;
            row.classList.toggle('is-dynamic-open', isOpenInitially);
            syncAllSubDrawers();

            labelEl.addEventListener('click', (event) => {
                const target = event.target as HTMLElement | null;
                if (target?.closest('.ghost-binding-toggle')) return;
                event.preventDefault();
                event.stopPropagation();
                const nextOpen = Boolean(drawerStack.hidden);
                drawerStack.hidden = !nextOpen;
                row.classList.toggle('is-dynamic-open', nextOpen);
                if (nextOpen) {
                    openDrawers.add(field.key);
                    syncAllSubDrawers();
                } else {
                    openDrawers.delete(field.key);
                }
            });

            row.appendChild(drawerStack);
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
            case 'asset_call':
                return this.createAssetCallWidget(field, node, onChange);
            case 'directory':
                return this.createDirectoryWidget(field, node, onChange);
            case 'slider':
                return this.createSliderWidget(field, node, onChange);
            case 'string':
                return this.createStringWidget(field, node, onChange);
            case 'int':
            case 'float':
                return this.createNumberWidget(field, node, onChange);
            case 'unit_float':
                return this.createUnitFloatWidget(field, node, onChange);
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

    private static createAssetCallWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'td-param-input td-asset-call-input';
        input.placeholder = field.placeholder || 'Drop sample or select from Pool';
        input.title = field.description || 'Asset call (name, pool index, or dynamic expression) · Drop audio file here to load';
        input.setAttribute('aria-label', field.label);

        const getPoolItems = () => typeof (node as any).getPoolItems === 'function' ? (node as any).getPoolItems() : [];

        const syncDisplay = () => {
            if (typeof document !== 'undefined' && document.activeElement === input) return;
            const mixedPath = node.hasMixedSlotValues?.('filepath') ?? false;
            if (mixedPath) {
                input.value = '';
                input.classList.remove('is-pool-computed');
                return;
            }
            const loadedBasename = this.resolveNodeAssetBasename(node);
            const q = String(node.properties?.pool_query ?? '').trim();
            const dynActive = Boolean(node.isFieldDynamicActive?.('pool_query'));
            input.value = loadedBasename || (dynActive ? q : '');
            input.classList.toggle('is-pool-computed', dynActive && Boolean(q || node.getSavedDynamicExpression?.('pool_query')));
        };
        syncDisplay();

        let beforeFocus = '';
        let hasUserTyped = false;
        let committedOnEnter = false;

        const commit = () => {
            const raw = input.value.trim();
            if (!hasUserTyped && raw === beforeFocus && !node.hasMixedSlotValues?.('pool_query')) {
                syncDisplay();
                return;
            }
            const prevVal = String(node.properties?.pool_query ?? '');
            const poolItems = getPoolItems();
            const assignedModifier = typeof node.getAttachedPoolNode === 'function' ? node.getAttachedPoolNode() : null;
            const sampleWithPool = node as BaseNode & {
                applyPoolQuery?: (q: string, advanceSaltOnRand?: boolean, opts?: { forceStatic?: boolean; forceDynamic?: boolean }) => boolean;
            };
            if (typeof sampleWithPool.applyPoolQuery === 'function' && (poolItems.length > 0 || assignedModifier || raw)) {
                const matched = sampleWithPool.applyPoolQuery(raw, false, { forceStatic: true });
                syncDisplay();
                if (matched || !Object.is(prevVal, raw) || hasUserTyped) {
                    onChange('pool_query', raw, prevVal);
                }
                return;
            }
            node.setFieldDynamicActive?.('pool_query', false);
            node.setStaticFieldValue?.('pool_query', raw);
            node.updateProperty('pool_query', raw);
            syncDisplay();
            onChange('pool_query', raw, prevVal);
        };

        input.addEventListener('input', () => {
            hasUserTyped = true;
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            const mixedPath = node.hasMixedSlotValues?.('filepath') ?? false;
            beforeFocus = mixedPath ? '' : (this.resolveNodeAssetBasename(node) || input.value.trim());
            input.value = beforeFocus;
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

        // Preserve audio drag-and-drop directly onto the Asset field input
        input.addEventListener('dragover', (event) => {
            if (!hasAudioDragPayload(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            input.classList.add('is-dragover');
        });
        input.addEventListener('dragleave', () => {
            input.classList.remove('is-dragover');
        });
        input.addEventListener('drop', (event) => {
            if (!hasAudioDragPayload(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            input.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            const prevVal = String(node.properties?.pool_query ?? '');
            void resolveDroppedAudioItems(event.dataTransfer).then(async (items) => {
                if (items.length === 0) return;
                const sampleAny = node as any;
                if (typeof sampleAny.loadDroppedItemsIntoSlots === 'function') {
                    await sampleAny.loadDroppedItemsIntoSlots(items);
                    syncDisplay();
                    onChange('pool_query', node.properties?.pool_query ?? '', prevVal);
                }
            });
        });

        if (typeof window !== 'undefined') {
            const onUpdated = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onUpdated);
                    window.removeEventListener('node-property-changed', onUpdated);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncDisplay();
                }
            };
            window.addEventListener('node-properties-refreshed', onUpdated);
            window.addEventListener('node-property-changed', onUpdated);
        }

        (input as any).__syncDisplay = syncDisplay;
        return input;
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
        enhanceSelect(select);
        return wrapper;
    }

    private static createSliderWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'td-slider-widget';

        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'td-param-input';
        const currentVal = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
        range.value = String(currentVal);
        if (field.min !== undefined) range.min = String(field.min);
        if (field.max !== undefined) range.max = String(field.max);
        range.step = String(field.step ?? (field.type === 'int' ? 1 : 0.1));

        const valDisplay = document.createElement('span');
        valDisplay.className = 'td-slider-val';
        valDisplay.title = 'Click to type value or Field Operator (rand, min..max, list)';

        wrapper.appendChild(range);
        wrapper.appendChild(valDisplay);

        const isBipolar = field.min !== undefined && field.max !== undefined && field.min < 0 && field.max > 0;
        const sliderController = enhanceRangeSlider(range, {
            defaultValue: typeof field.default === 'number' ? field.default : undefined,
            bipolar: isBipolar,
            compact: true,
            showValue: false
        });
        (range as any).__sinSliderController = sliderController;

        const syncSliderDisplay = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const latest = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            range.value = String(latest);
            sliderController?.sync();
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
                sliderController?.sync();
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
            const resolvedStr = String(this.getFieldValue(node, field) ?? field.default ?? 0);
            editInput.value = resolvedStr;
            valDisplay.replaceWith(editInput);
            editInput.focus();
            editInput.select();

            let hasUserTyped = false;
            editInput.addEventListener('input', () => {
                hasUserTyped = true;
            });

            let done = false;
            const finishEdit = (cancel = false) => {
                if (done) return;
                done = true;
                if (!cancel) {
                    const rawStr = editInput.value.trim();
                    if (hasUserTyped || rawStr !== resolvedStr) {
                        const parsed = parseFloat(rawStr);
                        if (Number.isFinite(parsed)) {
                            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
                            const previousValue = this.getFieldValue(node, field);
                            node.clearFieldOperator?.(field.key);
                            if (this.mayEditField(node, field, parsed)) {
                                const updated = this.setFieldValue(node, field, parsed);
                                if (wasDynamic || !Object.is(updated, previousValue)) {
                                    onChange(field.key, updated, previousValue);
                                }
                            }
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
        const wheelTarget = sliderController?.element || range;
        registerParameterWheelControl(wheelTarget, {
            isInteger: field.type === 'int',
            getValue: () => Number(this.getFieldValue(node, field) ?? field.default ?? 0),
            setValue: (nextVal) => update(nextVal),
            formatValue: (val) => `${val}${field.unit || ''}`,
        });
        wheelTarget.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.altKey || range.disabled) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = resolveWheelStep();
            const currentValue = Number(this.getFieldValue(node, field) ?? field.default ?? 0);
            update(roundStepValue(currentValue + direction * step, step));
        }, { passive: false });

        (wrapper as any).__syncDisplay = syncSliderDisplay;
        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!wrapper.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefreshed);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncSliderDisplay();
                }
            };
            window.addEventListener('node-properties-refreshed', onRefreshed);
        }

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
        let valueBeforeFocus = '';
        let hasUserTyped = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (!hasUserTyped && rawStr === valueBeforeFocus && !isMixed) {
                syncDisplay();
                return;
            }
            if (isMixed && rawStr === '') {
                syncDisplay();
                return;
            }
            const previousValue = this.getFieldValue(node, field);
            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));

            if (field.key === 'sample_slot') {
                const nextExpr = rawStr || '*';
                if (!this.mayEditField(node, field, nextExpr)) {
                    syncDisplay();
                    return;
                }
                node.clearFieldOperator?.('sample_slot');
                const updated = this.setFieldValue(node, field, nextExpr);
                syncDisplay();
                if (isMixed || wasDynamic || !Object.is(previousValue, nextExpr)) {
                    onChange(field.key, updated, previousValue);
                }
                return;
            }

            node.clearFieldOperator?.(field.key);
            if (!isMixed && !wasDynamic && Object.is(previousValue, input.value)) {
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

        input.addEventListener('input', () => {
            hasUserTyped = true;
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            valueBeforeFocus = input.value.trim();
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

        (input as any).__syncDisplay = syncDisplay;
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
        const dynamicAllowed = this.isFieldDynamicAllowed(field);
        input.title = dynamicAllowed
            ? (field.description
                ? `${field.description} · Supports Field Operators (rand, min..max, or space-separated list)`
                : 'Supports Field Operators (rand, min..max, or space-separated list)')
            : (field.description || field.label);

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
        let valueBeforeFocus = '';
        let hasUserTyped = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (!hasUserTyped && rawStr === valueBeforeFocus && !isMixed) {
                syncDisplay();
                return;
            }
            if (rawStr === '') {
                if (isMixed) return;
                syncDisplay();
                return;
            }
            const previousValue = this.getFieldValue(node, field);
            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
            const raw = field.type === 'int' ? parseInt(rawStr, 10) : parseFloat(rawStr);
            if (!Number.isFinite(raw)) {
                syncDisplay();
                return;
            }
            if (!isMixed && !wasDynamic && Object.is(previousValue, raw)) {
                syncDisplay();
                return;
            }
            if (!this.mayEditField(node, field, raw)) {
                syncDisplay();
                return;
            }
            node.clearFieldOperator?.(field.key);
            const updated = this.setFieldValue(node, field, raw);
            syncDisplay();
            if (isMixed || wasDynamic || !Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        let numDebounceTimer: any = null;
        input.addEventListener('input', () => {
            hasUserTyped = true;
            if (field.commitOnChange) return;
            clearTimeout(numDebounceTimer);
            numDebounceTimer = setTimeout(() => {
                const rawStr = input.value.trim();
                if (rawStr === '' || !/^-?\d*\.?\d+$/.test(rawStr)) return;
                const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
                const raw = field.type === 'int' ? parseInt(rawStr, 10) : parseFloat(rawStr);
                const previousValue = this.getFieldValue(node, field);
                const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
                if (!isMixed && !wasDynamic && Object.is(previousValue, raw)) return;
                if (Number.isFinite(raw) && this.mayEditField(node, field, raw)) {
                    node.clearFieldOperator?.(field.key);
                    const updated = this.setFieldValue(node, field, raw);
                    if (isMixed || wasDynamic || !Object.is(updated, previousValue)) {
                        onChange(field.key, updated, previousValue);
                    }
                }
            }, 100);
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            valueBeforeFocus = input.value.trim();
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

        (input as any).__syncDisplay = syncDisplay;
        return input;
    }

    private static createUnitFloatInputPart(
        field: FieldSchema,
        node: BaseNode,
        unitConfig: UnitFieldConfig,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'td-param-input td-unit-float-input';

        const getContext = () => resolveNodeUnitContext(node);
        const getActiveUnit = (): MeasurementUnitId => resolveFieldUnit(node, field.key, unitConfig, getContext());

        const getCanonicalValue = (): number => {
            const opExpr = node.getFieldOperator?.(field.key);
            if (opExpr) {
                const evaluated = Number(node.evaluateFieldOperatorForKey(field.key, opExpr, field));
                if (Number.isFinite(evaluated)) return evaluated;
            }
            const raw = Number(this.getFieldValue(node, field));
            return Number.isFinite(raw) ? raw : Number(field.default ?? 0);
        };

        const syncDisplay = () => {
            const ctx = getContext();
            const unit = resolveFieldUnit(node, field.key, unitConfig, ctx);
            const unitDef = getUnitDefinition(unit);
            input.title = field.description
                ? `${field.label}: ${field.description} · Unit: ${unitDef.label}`
                : `${field.label} · Unit: ${unitDef.label}`;

            if (typeof document !== 'undefined' && document.activeElement === input) return;
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            if (isMixed) {
                input.value = '';
                input.classList.remove('is-pool-computed');
                return;
            }
            const canonical = getCanonicalValue();
            const displayVal = canonicalToUnit(canonical, unitConfig.canonical, unit, ctx);
            input.value = formatUnitValue(displayVal, unit);
            input.classList.toggle('is-pool-computed', this.isFieldCalculated(node, field.key));
        };
        syncDisplay();

        const applyCanonicalValue = (nextCanonical: number) => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (!Number.isFinite(nextCanonical)) {
                syncDisplay();
                return;
            }
            const clamped = Math.round(nextCanonical * 1e6) / 1e6;
            if (!isMixed && Math.abs(Number(previousValue) - clamped) < 1e-7) {
                syncDisplay();
                return;
            }
            if (!this.mayEditField(node, field, clamped)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, clamped);
            syncDisplay();
            if (isMixed || !Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        let committedOnEnter = false;
        let valueBeforeFocus = '';
        let hasUserTyped = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (!hasUserTyped && rawStr === valueBeforeFocus && !isMixed) {
                syncDisplay();
                return;
            }
            if (rawStr === '') {
                if (isMixed) return;
                syncDisplay();
                return;
            }
            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
            const ctx = getContext();
            const activeUnit = resolveFieldUnit(node, field.key, unitConfig, ctx);
            const parsed = parseUnitInput(rawStr, activeUnit);
            if (!parsed) {
                syncDisplay();
                return;
            }
            const canonical = unitToCanonical(parsed.value, parsed.unit, unitConfig.canonical, ctx);
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (!Number.isFinite(canonical)) {
                syncDisplay();
                return;
            }
            const clamped = Math.round(canonical * 1e6) / 1e6;
            if (!isMixed && !wasDynamic && Math.abs(Number(previousValue) - clamped) < 1e-7) {
                syncDisplay();
                return;
            }
            if (!this.mayEditField(node, field, clamped)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, clamped);
            syncDisplay();
            if (isMixed || wasDynamic || !Object.is(updated, previousValue)) {
                onChange(field.key, updated, previousValue);
            }
        };

        input.addEventListener('input', () => {
            hasUserTyped = true;
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            valueBeforeFocus = input.value.trim();
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

        input.addEventListener('change', () => {
            if (!committedOnEnter) {
                commit();
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

        registerParameterWheelControl(input, {
            isInteger: () => getUnitDefinition(getActiveUnit()).isInteger,
            getSteps: () => getUnitDefinition(getActiveUnit()).wheelSteps,
            getDefaultStep: () => getUnitDefinition(getActiveUnit()).defaultStep,
            getValue: () => {
                const ctx = getContext();
                const unit = resolveFieldUnit(node, field.key, unitConfig, ctx);
                return canonicalToUnit(getCanonicalValue(), unitConfig.canonical, unit, ctx);
            },
            setValue: (nextDisplayVal) => {
                const ctx = getContext();
                const unit = resolveFieldUnit(node, field.key, unitConfig, ctx);
                const canonical = unitToCanonical(nextDisplayVal, unit, unitConfig.canonical, ctx);
                applyCanonicalValue(canonical);
            },
            formatValue: (val) => {
                const unit = getActiveUnit();
                const def = getUnitDefinition(unit);
                const formatted = formatUnitValue(val, unit);
                return unit === 'time' ? formatted : `${formatted} ${def.shortLabel}`;
            },
        });

        input.addEventListener('wheel', (event) => {
            event.preventDefault();
            if (event.altKey || input.disabled) return;
            const ctx = getContext();
            const unit = resolveFieldUnit(node, field.key, unitConfig, ctx);
            const def = getUnitDefinition(unit);
            const curDisplay = canonicalToUnit(getCanonicalValue(), unitConfig.canonical, unit, ctx);
            const direction = event.deltaY < 0 ? 1 : -1;
            const step = def.defaultStep;
            const nextDisplay = def.isInteger
                ? Math.round(curDisplay + direction * step)
                : roundStepValue(curDisplay + direction * step, step);
            const canonical = unitToCanonical(nextDisplay, unit, unitConfig.canonical, ctx);
            applyCanonicalValue(canonical);
        }, { passive: false });

        if (typeof window !== 'undefined') {
            const onRefresh = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefresh);
                    window.removeEventListener('node-field-unit-changed', onUnitChange);
                    window.removeEventListener('node-property-changed', onPropChange);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncDisplay();
                }
            };
            const onUnitChange = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefresh);
                    window.removeEventListener('node-field-unit-changed', onUnitChange);
                    window.removeEventListener('node-property-changed', onPropChange);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (detail?.nodeId === node.id) {
                    if (detail.key === field.key || (unitConfig.unitGroup && detail.unitGroup === unitConfig.unitGroup)) {
                        syncDisplay();
                    }
                }
            };
            const onPropChange = (evt: Event) => {
                if (!input.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefresh);
                    window.removeEventListener('node-field-unit-changed', onUnitChange);
                    window.removeEventListener('node-property-changed', onPropChange);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (detail?.nodeId === node.id) {
                    const k = detail.key;
                    if (
                        k === field.key
                        || k === 'crop_start'
                        || k === 'crop_end'
                        || k === 'duration_seconds'
                        || k === 'original_bpm'
                        || k === 'target_bpm'
                        || k === 'warp'
                        || k === 'stretch_mode'
                        || k === 'sample_type'
                    ) {
                        syncDisplay();
                    }
                }
            };
            window.addEventListener('node-properties-refreshed', onRefresh);
            window.addEventListener('node-field-unit-changed', onUnitChange);
            window.addEventListener('node-property-changed', onPropChange);
        }

        (input as any).__syncDisplay = syncDisplay;
        return input;
    }

    private static createUnitFloatWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const unitConfig: UnitFieldConfig = field.unitConfig || {
            family: 'audio_position',
            canonical: 'fraction',
            units: AUDIO_POSITION_UNITS,
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'td-unit-float';

        const input = this.createUnitFloatInputPart(field, node, unitConfig, onChange);

        const unitSelect = document.createElement('select');
        unitSelect.className = 'td-unit-select';
        unitSelect.setAttribute('aria-label', `${field.label} unit`);
        for (const u of unitConfig.units) {
            const def = getUnitDefinition(u);
            const opt = document.createElement('option');
            opt.value = u;
            opt.textContent = def.shortLabel;
            opt.title = def.label;
            unitSelect.appendChild(opt);
        }

        wrapper.append(input, unitSelect);

        const syncAll = () => {
            const ctx = resolveNodeUnitContext(node);
            const unit = resolveFieldUnit(node, field.key, unitConfig, ctx);
            if (unitSelect.value !== unit) {
                unitSelect.value = unit;
            }
            unitSelect.title = `Unit: ${getUnitDefinition(unit).label}`;
            (input as any).__syncDisplay?.();
        };
        syncAll();

        unitSelect.addEventListener('change', () => {
            const nextUnit = unitSelect.value as MeasurementUnitId;
            if (!unitConfig.units.includes(nextUnit)) return;
            setFieldUnit(node, field.key, unitConfig, nextUnit);
            syncAll();
        });

        if (typeof window !== 'undefined') {
            const onUnitSync = (evt: Event) => {
                if (!wrapper.isConnected) {
                    window.removeEventListener('node-field-unit-changed', onUnitSync);
                    window.removeEventListener('node-properties-refreshed', onUnitSync);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    syncAll();
                }
            };
            window.addEventListener('node-field-unit-changed', onUnitSync);
            window.addEventListener('node-properties-refreshed', onUnitSync);
        }

        (wrapper as any).__syncDisplay = syncAll;
        return wrapper;
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
        scope.className = 'td-global-toggle ui-btn ui-btn--icon ui-btn--bordered';
        scope.innerHTML = renderIcon('globe');
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
        let valueBeforeFocus = '';
        let hasUserTyped = false;
        const commit = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const rawStr = input.value.trim();
            if (!hasUserTyped && rawStr === valueBeforeFocus && !isMixed) {
                refresh();
                return;
            }
            if (rawStr === '' && isMixed) return;
            const previousValue = this.getFieldValue(node, field);
            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
            const raw = parseFloat(rawStr);
            if (!Number.isFinite(raw)) {
                refresh();
                return;
            }
            if (!isMixed && !wasDynamic && Object.is(previousValue, raw)) {
                refresh();
                return;
            }
            node.clearFieldOperator?.(field.key);
            const updated = this.setFieldValue(node, field, raw);
            refresh();
            if (isMixed || wasDynamic || !Object.is(updated, previousValue)) onChange(field.key, updated, previousValue);
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
        input.addEventListener('input', () => {
            hasUserTyped = true;
        });
        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            valueBeforeFocus = input.value.trim();
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
        (wrapper as any).__syncDisplay = refresh;
        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!wrapper.isConnected) {
                    window.removeEventListener('node-properties-refreshed', onRefreshed);
                    return;
                }
                const detail = (evt as CustomEvent)?.detail;
                if (!detail || detail.nodeId === node.id) {
                    refresh();
                }
            };
            window.addEventListener('node-properties-refreshed', onRefreshed);
        }

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

        const syncDisplay = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const latest = this.getFieldValue(node, field);
            if (!isMixed) {
                const targetStr = String(latest ?? '');
                if (select.value !== targetStr) {
                    select.value = targetStr;
                }
            }
            const isCalc = !isMixed && this.isFieldCalculated(node, field.key);
            select.classList.toggle('is-pool-computed', isCalc);
            const trigger = select.closest?.('.ui-dropdown')?.querySelector('.ui-dropdown-trigger');
            trigger?.classList.toggle('is-pool-computed', isCalc);
            (select as any).__sinDropdownController?.sync?.();
        };
        syncDisplay();

        select.addEventListener('change', () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (!isMixed && Object.is(previousValue, select.value)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, select.value);
            syncDisplay();
            onChange(field.key, updated, previousValue);
        });

        (select as any).__syncDisplay = syncDisplay;
        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!select.isConnected) {
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

        return select;
    }

    private static createRadioWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const isMixedInit = node.hasMixedSlotValues?.(field.key) ?? false;
        const group = RadioGroup.create({
            name: `${field.key}-${node.id}`,
            value: isMixedInit ? '' : String(this.getFieldValue(node, field)),
            options: (field.options || []).map(option => typeof option === 'object'
                ? { value: String(option.value), label: option.label }
                : { value: String(option), label: String(option) }),
            ariaLabel: field.label,
            onChange: value => {
                const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
                const previousValue = this.getFieldValue(node, field);
                node.clearFieldOperator?.(field.key);
                if (!isMixed && Object.is(previousValue, value)) {
                    syncDisplay();
                    return;
                }
                const updated = this.setFieldValue(node, field, value);
                syncDisplay();
                onChange(field.key, updated, previousValue);
            }
        });

        const syncDisplay = () => {
            const isMixed = node.hasMixedSlotValues?.(field.key) ?? false;
            const targetVal = isMixed ? '' : String(this.getFieldValue(node, field) ?? '').toLowerCase();
            group.querySelectorAll<HTMLLabelElement>('.td-radio-option').forEach(optLabel => {
                const radio = optLabel.querySelector<HTMLInputElement>('input[type="radio"]');
                if (!radio) return;
                const checked = !isMixed && radio.value.toLowerCase() === targetVal;
                radio.checked = checked;
                optLabel.classList.toggle('is-checked', checked);
                optLabel.classList.toggle('is-active', checked);
            });
            group.classList.toggle('is-pool-computed', !isMixed && this.isFieldCalculated(node, field.key));
        };
        syncDisplay();
        (group as any).__syncDisplay = syncDisplay;

        if (typeof window !== 'undefined') {
            const onRefreshed = (evt: Event) => {
                if (!group.isConnected) {
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

        return group;
    }

    private static createBooleanWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'td-param-checkbox ui-checkbox';

        const syncDisplay = () => {
            input.checked = Boolean(this.getFieldValue(node, field));
            input.classList.toggle('is-pool-computed', this.isFieldCalculated(node, field.key));
        };
        syncDisplay();

        input.addEventListener('change', () => {
            const previousValue = this.getFieldValue(node, field);
            node.clearFieldOperator?.(field.key);
            if (Object.is(previousValue, input.checked)) {
                syncDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, input.checked);
            syncDisplay();
            onChange(field.key, updated, previousValue);
        });

        (input as any).__syncDisplay = syncDisplay;
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

    private static createDbWidget(
        field: FieldSchema,
        node: BaseNode,
        onChange: (key: string, val: any, previousValue: any) => void
    ): HTMLElement {
        const container = document.createElement('div');
        container.className = 'td-float-box';

        const minDb = field.min ?? -36.0;
        const maxDb = field.max ?? 12.0;
        const dbSpan = (maxDb - minDb) || 1.0;
        const currentDb = Number(this.getFieldValue(node, field) ?? field.default ?? 0.0);

        const fillBar = document.createElement('span');
        fillBar.className = 'td-float-fill';
        fillBar.setAttribute('aria-hidden', 'true');

        const labelText = document.createElement('span');
        labelText.className = 'float-val-text';
        labelText.innerText = minDb <= -35.9 ? formatDb(currentDb) : `${currentDb > 0 ? '+' : ''}${currentDb.toFixed(1)} dB`;
        container.append(fillBar, labelText);

        let activeDb = currentDb;

        const formatThisDb = (val: number) =>
            minDb <= -35.9 ? formatDb(val) : `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;

        const updateUI = (db: number) => {
            activeDb = Math.max(minDb, Math.min(maxDb, db));
            labelText.innerText = formatThisDb(activeDb);
            const valPct = ((activeDb - minDb) / dbSpan) * 100;
            const zeroPct = Math.max(0, Math.min(100, ((0 - minDb) / dbSpan) * 100));
            const leftPct = Math.min(zeroPct, valPct);
            const widthPct = Math.abs(valPct - zeroPct);
            fillBar.style.left = `${leftPct}%`;
            fillBar.style.width = `${widthPct}%`;
            fillBar.dataset.polarity = activeDb >= 0 ? 'pos' : 'neg';
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
            const resolvedDbStr = activeDb.toFixed(1);
            input.value = resolvedDbStr;
            input.className = 'td-float-direct-input';

            container.innerHTML = '';
            container.appendChild(input);
            input.focus();
            input.select();

            let hasUserTyped = false;
            input.addEventListener('input', () => {
                hasUserTyped = true;
            });

            let committed = false;
            const commitInput = () => {
                if (committed) return;
                committed = true;
                const rawStr = input.value.trim();
                if (hasUserTyped || rawStr !== resolvedDbStr) {
                    const previousValue = this.getFieldValue(node, field);
                    const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
                    const parsed = parseFloat(rawStr);
                    if (!isNaN(parsed)) {
                        node.clearFieldOperator?.(field.key);
                        updateUI(parsed);
                        const updated = this.setFieldValue(node, field, activeDb);
                        if (wasDynamic || !Object.is(updated, previousValue)) {
                            onChange(field.key, updated, previousValue);
                        }
                    }
                }
                container.innerHTML = '';
                container.append(fillBar, labelText);
                updateUI(activeDb);
            };

            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    commitInput();
                } else if (evt.key === 'Escape') {
                    committed = true;
                    container.innerHTML = '';
                    container.append(fillBar, labelText);
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
            try { container.setPointerCapture(e.pointerId); } catch (_) { }
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
                try { container.releasePointerCapture(e.pointerId); } catch (_) { }
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
            formatValue: (val) => formatThisDb(Math.max(minDb, Math.min(maxDb, val))),
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

        (container as any).__syncDisplay = () => updateUI(Number(this.getFieldValue(node, field) ?? field.default ?? 0.0));
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
        refreshToggle.className = 'td-seed-refresh-toggle ui-btn ui-btn--icon ui-btn--bordered';
        refreshToggle.innerHTML = renderIcon('refresh');

        const syncToggleUI = () => {
            const armed = isArmed();
            refreshToggle.classList.toggle('is-active', armed);
            refreshToggle.classList.toggle('active', armed);
            refreshToggle.setAttribute('aria-pressed', String(armed));
            refreshToggle.title = armed
                ? 'Armed for Refresh: global Refresh will roll this seed (click to lock)'
                : 'Locked from Refresh: global Refresh will keep this seed (click to arm)';
        };
        syncToggleUI();

        let committedOnEnter = false;
        let valueBeforeFocus = '';
        let hasUserTyped = false;
        const commitValue = (rawVal: string | number, forceCommit = false) => {
            const trimmed = String(rawVal ?? '').trim() || '42';
            if (!forceCommit && !hasUserTyped && trimmed === valueBeforeFocus) {
                syncSeedDisplay();
                return;
            }
            const previousValue = this.getFieldValue(node, field);
            const wasDynamic = Boolean(node.isFieldDynamicActive?.(field.key) || node.hasFieldOperator?.(field.key));
            node.clearFieldOperator?.(field.key);
            const asNum = Number(trimmed);
            const normalized: string | number = (!trimmed.includes(' ') && Number.isFinite(asNum))
                ? Math.round(asNum)
                : trimmed;
            if (!wasDynamic && Object.is(previousValue, normalized)) {
                syncSeedDisplay();
                return;
            }
            const updated = this.setFieldValue(node, field, normalized);
            syncSeedDisplay();
            onChange(field.key, updated, previousValue);
        };

        input.addEventListener('input', () => {
            hasUserTyped = true;
        });

        input.addEventListener('focus', () => {
            committedOnEnter = false;
            hasUserTyped = false;
            valueBeforeFocus = input.value.trim();
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
            commitValue(Math.max(0, Math.round(currentNumeric + direction * getParameterWheelStep(true))), true);
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
        (wrapper as any).__syncDisplay = () => {
            syncSeedDisplay();
            syncToggleUI();
        };
        return wrapper;
    }
}
