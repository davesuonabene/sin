/**
 * ERMES Dynamic Random Modifier Engine
 * Manages parameter random range evaluations, relative % offsets,
 * schema limit truncation, seed management, and graph traversal.
 */

import { type FieldSchema } from '../../editor/src/fields/FieldSchema.ts';
import {
    hashSeed,
    isFieldOperatorExpression,
    mulberry32,
    resolveModifierSlotSeeds,
    rollSeedExpression
} from './slotLanguage.ts';
import {
    advanceAssetPoolSeed,
    populateOwnerSlotsFromPool
} from './assetResolver.ts';

export type RandomRefreshMode = 'local' | 'parent' | 'ancestor' | 'global' | 'off';

export interface RandomResolutionRequest {
    kind: 'preview' | 'render';
    globalPreview?: boolean;
    globalFreeze?: boolean;
}

export interface RandomDestination {
    id: string;
    paramKey: string;
    paramLabel: string;
    minPercent: number; // e.g. -10 for -10%
    maxPercent: number; // e.g. 10 for +10%
    step?: number;
    baseValue: number;  // Anchor working value
    baseValueArray?: number[];
    currentValue?: number;
    enabled: boolean;
}

export function getRangeColor(min: number, max: number): { text: string; bg: string; border: string } {
    const spread = Math.max(Math.abs(min), Math.abs(max));
    if (spread <= 15) {
        return { text: '#34d399', bg: 'rgba(16, 185, 129, 0.18)', border: '#10b981' }; // Subtle (<=15%): Emerald
    }
    if (spread <= 35) {
        return { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)', border: '#0284c7' }; // Moderate (<=35%): Cyan
    }
    if (spread <= 60) {
        return { text: '#fbbf24', bg: 'rgba(245, 158, 11, 0.18)', border: '#f59e0b' }; // Active (<=60%): Amber
    }
    return { text: '#f472b6', bg: 'rgba(236, 72, 153, 0.22)', border: '#ec4899' }; // Heavy (>60%): Magenta
}

export function normalizeRandomRefreshMode(value: unknown): RandomRefreshMode {
    switch (String(value || '').toLowerCase()) {
        case 'local':
        case 'local_refresh':
        case 'manual':
            return 'local';
        case 'parent':
        case 'parent_refresh':
        case 'parent_render':
            return 'parent';
        case 'ancestor':
        case 'ancestor_refresh':
            return 'ancestor';
        case 'global':
        case 'global_refresh':
            return 'global';
        case 'off':
        case 'fixed':
            return 'off';
        default:
            return 'global';
    }
}

function topAncestorId(ownerNodeId: number, trackNodes?: Map<number, any>): number {
    let currentId = ownerNodeId;
    const visited = new Set<number>();
    while (!visited.has(currentId)) {
        visited.add(currentId);
        const parentId = trackNodes?.get(currentId)?.parentId;
        if (parentId == null) break;
        currentId = parentId;
    }
    return currentId;
}

export function shouldRefreshRandom(
    modeValue: unknown,
    ownerNodeId: number,
    requestedNodeId: number,
    trackNodes: Map<number, any> | undefined,
    request: RandomResolutionRequest
): boolean {
    const mode = normalizeRandomRefreshMode(modeValue);
    if (mode === 'off') return false;
    if (mode === 'local') return true;
    // Render is an explicit user action — always re-roll (unless 'off')
    if (request.kind === 'render') return true;
    // Preview hierarchy: global only on global preview, parent/ancestor check lineage
    if (mode === 'global') return Boolean(request.globalPreview);
    if (request.globalPreview) return false;
    if (mode === 'parent') return trackNodes?.get(ownerNodeId)?.parentId === requestedNodeId;
    return topAncestorId(ownerNodeId, trackNodes) === requestedNodeId;
}

export function evaluateRelativeRandomValue(
    baseValue: number,
    minPercent: number,
    maxPercent: number,
    options: {
        schemaMin?: number;
        schemaMax?: number;
        step?: number;
        randomFactor?: number;
    } = {}
): number {
    const { schemaMin, schemaMax, step } = options;
    const randomFactor = options.randomFactor ?? Math.random();

    let span: number;
    if (schemaMin !== undefined && schemaMax !== undefined && Number.isFinite(schemaMin) && Number.isFinite(schemaMax)) {
        span = Math.abs(schemaMax - schemaMin);
    } else if (Math.abs(baseValue) > 0.0001) {
        span = Math.abs(baseValue);
    } else {
        span = 1.0;
    }

    const minOffset = (minPercent / 100) * span;
    const maxOffset = (maxPercent / 100) * span;
    const lower = Math.min(minOffset, maxOffset);
    const upper = Math.max(minOffset, maxOffset);

    let modulated = baseValue + (lower + randomFactor * (upper - lower));

    if (step !== undefined && step > 0) {
        const precision = step.toString().includes('.') ? step.toString().split('.')[1].length : 0;
        modulated = Number((Math.round(modulated / step) * step).toFixed(precision));
    }

    // Overflow check / truncation to schema limits
    if (schemaMin !== undefined && Number.isFinite(schemaMin)) {
        modulated = Math.max(schemaMin, modulated);
    }
    if (schemaMax !== undefined && Number.isFinite(schemaMax)) {
        modulated = Math.min(schemaMax, modulated);
    }

    return modulated;
}

export function advanceRandomSeed(modifierNode: any, trackNodesMap?: Map<number, any>): string | number {
    if (modifierNode?.properties?.seed_refresh === false) {
        return modifierNode.properties.seed ?? 42;
    }
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    const rolled = rollSeedExpression(modifierNode?.properties?.seed ?? 42);
    const numericCandidate = Number(rolled);
    const nextSeed: string | number = (!rolled.includes(' ') && Number.isFinite(numericCandidate))
        ? numericCandidate
        : rolled;
    if (modifierNode?.properties) {
        modifierNode.properties.seed = nextSeed;
        modifierNode.properties.seed_salt = (Number(modifierNode.properties.seed_salt) || 0) + 1;
    }
    const modifierData = trackNodes?.get(modifierNode?.id);
    if (modifierData) {
        modifierData.seed = nextSeed;
        modifierData.seed_salt = modifierNode?.properties?.seed_salt;
    }
    return nextSeed;
}

export function findFieldSchema(node: any, paramKey: string): FieldSchema | undefined {
    const stepMatch = paramKey.match(/^step_parameters\.(\d+)\.(.+)$/);
    const resolvedKey = stepMatch ? stepMatch[2] : paramKey;

    if (typeof node?.getFields === 'function') {
        const fields: FieldSchema[] = node.getFields();
        const direct = fields.find(f => f.key === resolvedKey);
        if (direct) return direct;
    }
    const ctor = node?.constructor as any;
    if (Array.isArray(ctor?.fields)) {
        return ctor.fields.find((f: FieldSchema) => f.key === resolvedKey);
    }
    return undefined;
}

export function isFieldMappableToRandom(node: any, paramKey: string): boolean {
    const stepMatch = paramKey.match(/^step_parameters\.(\d+)\.(.+)$/);
    if (stepMatch) {
        const subKey = stepMatch[2];
        return ['probability', 'offset', 'velocity', 'subdivisions', 'sample_start', 'gate_length'].includes(subKey);
    }
    const field = findFieldSchema(node, paramKey);
    if (!field) {
        if (['section_points', 'section_probability'].includes(paramKey)) {
            return true;
        }
        return false;
    }
    if (['string', 'select', 'radio', 'boolean', 'seed', 'filepath'].includes(field.type)) {
        return false;
    }
    if (['int', 'float', 'global_float', 'db', 'slider'].includes(field.type)) {
        return true;
    }
    if (typeof field.min === 'number' && typeof field.max === 'number') {
        return true;
    }
    return false;
}

const STEP_PARAM_KEYS = ['velocity', 'offset', 'probability', 'subdivisions', 'sample_start', 'gate_length'];

function createDefaultStepParameters(stepCount: number) {
    return Array.from({ length: stepCount }, () => ({
        probability: 1.0,
        offset: 0,
        velocity: 1,
        subdivisions: 1,
        subdivision_enabled: false,
        sample_start: 0,
        gate_length: 1,
    }));
}

function evalDestValue(dest: RandomDestination, base: number, field: FieldSchema | undefined, randomFactor: number): number {
    return evaluateRelativeRandomValue(base, dest.minPercent, dest.maxPercent, {
        schemaMin: field?.min !== undefined ? Number(field.min) : undefined,
        schemaMax: field?.max !== undefined ? Number(field.max) : undefined,
        step: dest.step !== undefined ? dest.step : (field?.step !== undefined ? Number(field.step) : undefined),
        randomFactor,
    });
}

/**
 * Deterministically populates `ownerNode.properties.slots[0..S-1]` with seed-modulated parameters
 * from an attached Random modifier node.
 */
export function populateOwnerSlotsFromRandom(modifierNode: any, ownerNode: any): void {
    if (!modifierNode?.properties || !ownerNode?.properties) return;
    if (!Array.isArray(ownerNode.properties.slots) || ownerNode.properties.slots.length === 0) return;

    const destinations: RandomDestination[] = Array.isArray(modifierNode.properties.destinations)
        ? modifierNode.properties.destinations
        : [];
    const slots = ownerNode.properties.slots;
    const seedSalt = Number(modifierNode.properties.seed_salt || ownerNode.properties.seed_salt || 0) * 9973;
    const slotSeeds = resolveModifierSlotSeeds(
        modifierNode.properties.seed ?? 42,
        slots.length,
        Number(ownerNode.id || modifierNode.id || 1) + seedSalt
    );

    const stepCount = Array.isArray(ownerNode.properties.sequence) && ownerNode.properties.sequence.length > 0
        ? ownerNode.properties.sequence.length
        : 16;

    for (let s = 0; s < slots.length; s++) {
        const slotObj = { ...(slots[s] || {}), slot: s, index: s };
        const baseStepSource = Array.isArray(slotObj.step_parameters) && slotObj.step_parameters.length > 0
            ? slotObj.step_parameters
            : (Array.isArray(ownerNode.properties.step_parameters) && ownerNode.properties.step_parameters.length > 0
                ? ownerNode.properties.step_parameters
                : createDefaultStepParameters(stepCount));
        const nextSteps = baseStepSource.map((st: any) => ({ ...(st || {}) }));

        for (let destIdx = 0; destIdx < destinations.length; destIdx++) {
            const dest = destinations[destIdx];
            if (!dest.enabled) continue;
            const field = findFieldSchema(ownerNode, dest.paramKey);
            const prng = mulberry32(hashSeed(slotSeeds[s], destIdx, 0x4A1D));

            const stepMatch = dest.paramKey.match(/^(?:step_parameters\.|step:)(\d+)[.:](.+)$/);
            if (stepMatch) {
                const stepIdx = parseInt(stepMatch[1], 10);
                const fieldKey = stepMatch[2];
                const stepObj = nextSteps[stepIdx];
                if (stepObj && stepObj[fieldKey] !== undefined) {
                    if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
                        dest.baseValue = Number(stepObj[fieldKey]);
                    }
                    const newVal = evalDestValue(dest, dest.baseValue, field, prng());
                    stepObj[fieldKey] = newVal;
                    if (fieldKey === 'subdivisions') stepObj.subdivision_enabled = newVal > 1;
                }
                continue;
            }

            if (STEP_PARAM_KEYS.includes(dest.paramKey)) {
                const fieldKey = dest.paramKey;
                const isUnitDefault = ['velocity', 'gate_length', 'subdivisions', 'probability'].includes(fieldKey);
                if (!dest.baseValueArray || !Array.isArray(dest.baseValueArray) || dest.baseValueArray.length !== nextSteps.length) {
                    dest.baseValueArray = nextSteps.map((st: any) => {
                        const v = Number(st?.[fieldKey]);
                        return (Number.isFinite(v) && (!isUnitDefault || v > 0)) ? v : (isUnitDefault ? 1 : 0);
                    });
                }
                const baseValues: number[] = dest.baseValueArray || [];
                for (let i = 0; i < nextSteps.length; i++) {
                    const stepObj = nextSteps[i];
                    if (stepObj && stepObj[fieldKey] !== undefined) {
                        const rawBase = baseValues[i];
                        const effectiveBase = (Number.isFinite(rawBase) && (!isUnitDefault || rawBase > 0))
                            ? rawBase
                            : (Number(stepObj[fieldKey]) > 0 ? Number(stepObj[fieldKey]) : (dest.baseValue > 0 ? dest.baseValue : (isUnitDefault ? 1.0 : 0.0)));
                        const newVal = evalDestValue(dest, effectiveBase, field, prng());
                        stepObj[fieldKey] = newVal;
                        if (fieldKey === 'subdivisions') stepObj.subdivision_enabled = newVal > 1;
                    }
                }
                continue;
            }

            const currentProp = slotObj[dest.paramKey] ?? ownerNode.properties?.[dest.paramKey];
            if (!Array.isArray(currentProp)) {
                if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
                    const parsed = Number(currentProp);
                    dest.baseValue = Number.isFinite(parsed) ? parsed : (field?.default ? Number(field.default) : 0);
                }
                slotObj[dest.paramKey] = evalDestValue(dest, dest.baseValue, field, prng());
            }
        }

        slotObj.step_parameters = nextSteps;
        slots[s] = slotObj;
    }

    const activeIdx = Math.min(
        Math.max(0, Number(ownerNode.activeSlotIndex ?? ownerNode.properties.active_slot ?? 0)),
        slots.length - 1
    );
    const activeSlot = slots[activeIdx] || slots[0];
    if (activeSlot && Array.isArray(activeSlot.step_parameters)) {
        const clonedActiveSteps = activeSlot.step_parameters.map((st: any) => ({ ...(st || {}) }));
        if (typeof ownerNode.updateProperty === 'function') {
            ownerNode.updateProperty('step_parameters', clonedActiveSteps);
        } else {
            ownerNode.properties.step_parameters = clonedActiveSteps;
        }
        const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
        if (cachedNode) {
            cachedNode.step_parameters = clonedActiveSteps.map((st: any) => ({ ...st }));
        }
    }
}

export function applyRandomModulation(
    modifierNode: any,
    ownerNode: any,
    options: { forceRefresh?: boolean; randomFactorGenerator?: () => number } = {}
): void {
    if (!modifierNode?.properties || !ownerNode) return;
    if ((!Array.isArray(modifierNode.properties.destinations) || modifierNode.properties.destinations.length === 0) && Array.isArray(modifierNode.properties.targets)) {
        modifierNode.properties.destinations = modifierNode.properties.targets
            .filter((t: any) => t && typeof t === 'object')
            .map((t: any, idx: number) => {
                const rawField = String(t.paramKey || t.field || '').trim();
                const paramKey = rawField.startsWith('step_parameters.') && rawField.split('.').length === 2
                    ? rawField.split('.')[1]
                    : rawField;
                const defaultBase = ['velocity', 'probability', 'gate_length'].includes(paramKey) ? 1 : 0;
                return {
                    id: String(t.id || `dest_${idx}`),
                    paramKey,
                    paramLabel: String(t.paramLabel || (paramKey.charAt(0).toUpperCase() + paramKey.slice(1))),
                    minPercent: Number(t.minPercent ?? t.min ?? 0),
                    maxPercent: Number(t.maxPercent ?? t.max ?? 0),
                    baseValue: Number(t.baseValue ?? defaultBase),
                    enabled: t.enabled !== false,
                };
            });
    }
    const destinations: RandomDestination[] = Array.isArray(modifierNode.properties.destinations)
        ? modifierNode.properties.destinations
        : [];

    const seedSalt = Number(modifierNode.properties.seed_salt || ownerNode.properties?.seed_salt || 0) * 9973;
    const slot0Seed = resolveModifierSlotSeeds(
        modifierNode.properties.seed ?? 42,
        1,
        Number(ownerNode.id || modifierNode.id || 1) + seedSalt
    )[0];

    let updatedAny = false;

    const ensureOwnerStepParameters = () => {
        if (!ownerNode.properties) ownerNode.properties = {};
        if (!Array.isArray(ownerNode.properties.step_parameters) || ownerNode.properties.step_parameters.length === 0) {
            const stepCount = Array.isArray(ownerNode.properties.sequence) && ownerNode.properties.sequence.length > 0
                ? ownerNode.properties.sequence.length
                : 16;
            ownerNode.properties.step_parameters = createDefaultStepParameters(stepCount);
        }
    };

    for (let destIdx = 0; destIdx < destinations.length; destIdx++) {
        const dest = destinations[destIdx];
        if (!dest.enabled) continue;

        const destPrng = options.randomFactorGenerator || mulberry32(hashSeed(slot0Seed, destIdx, 0x4A1D));
        const field = findFieldSchema(ownerNode, dest.paramKey);

        const stepMatch = dest.paramKey.match(/^step_parameters\.(\d+)\.(.+)$/);
        if (stepMatch) {
            ensureOwnerStepParameters();
        }
        if (stepMatch && Array.isArray(ownerNode.properties?.step_parameters)) {
            const stepIdx = parseInt(stepMatch[1], 10);
            const fieldKey = stepMatch[2];
            const nextSteps = ownerNode.properties.step_parameters.map((s: any) => ({ ...(s || {}) }));
            const stepObj = nextSteps[stepIdx];
            if (stepObj && stepObj[fieldKey] !== undefined) {
                if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
                    dest.baseValue = Number(stepObj[fieldKey]);
                }
                const newVal = evalDestValue(dest, dest.baseValue, field, destPrng());
                dest.currentValue = newVal;
                stepObj[fieldKey] = newVal;
                if (fieldKey === 'subdivisions') stepObj.subdivision_enabled = newVal > 1;
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', nextSteps);
                } else {
                    ownerNode.properties.step_parameters = nextSteps;
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) cachedNode.step_parameters = nextSteps.map((s: any) => ({ ...s }));
                updatedAny = true;
            }
            continue;
        }

        if (STEP_PARAM_KEYS.includes(dest.paramKey) && (ownerNode.type === 'Audio/Sequence' || ownerNode.properties?.node_type === 'sequence' || Array.isArray(ownerNode.properties?.step_parameters))) {
            ensureOwnerStepParameters();
            const fieldKey = dest.paramKey;
            const isUnitDefault = ['velocity', 'gate_length', 'subdivisions', 'probability'].includes(fieldKey);
            if (!dest.baseValueArray || !Array.isArray(dest.baseValueArray) || dest.baseValueArray.length !== ownerNode.properties.step_parameters.length) {
                dest.baseValueArray = ownerNode.properties.step_parameters.map((s: any) => {
                    const v = Number(s?.[fieldKey]);
                    return (Number.isFinite(v) && (!isUnitDefault || v > 0)) ? v : (isUnitDefault ? 1 : 0);
                });
            }
            const baseValues: number[] = dest.baseValueArray || [];
            const nextSteps = ownerNode.properties.step_parameters.map((s: any) => ({ ...(s || {}) }));
            for (let i = 0; i < nextSteps.length; i++) {
                const stepObj = nextSteps[i];
                if (stepObj && stepObj[fieldKey] !== undefined) {
                    const rawBase = baseValues[i];
                    const effectiveBase = (Number.isFinite(rawBase) && (!isUnitDefault || rawBase > 0))
                        ? rawBase
                        : (Number(stepObj[fieldKey]) > 0 ? Number(stepObj[fieldKey]) : (dest.baseValue > 0 ? dest.baseValue : (isUnitDefault ? 1.0 : 0.0)));
                    const newVal = evalDestValue(dest, effectiveBase, field, destPrng());
                    stepObj[fieldKey] = newVal;
                    if (fieldKey === 'subdivisions') stepObj.subdivision_enabled = newVal > 1;
                }
            }
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty('step_parameters', nextSteps);
            } else {
                ownerNode.properties.step_parameters = nextSteps;
            }
            const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
            if (cachedNode) cachedNode.step_parameters = nextSteps.map((s: any) => ({ ...s }));
            updatedAny = true;
            continue;
        }

        const currentProp = ownerNode.properties?.[dest.paramKey];
        const isArrayProp = Array.isArray(currentProp);
        if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
            const parsed = isArrayProp ? Number(currentProp[0]) : Number(currentProp);
            dest.baseValue = Number.isFinite(parsed) ? parsed : (field?.default ? Number(field.default) : 0);
        }

        const newVal = evalDestValue(dest, dest.baseValue, field, destPrng());
        dest.currentValue = newVal;

        if (isArrayProp) {
            if (!dest.baseValueArray || !Array.isArray(dest.baseValueArray) || dest.baseValueArray.length !== currentProp.length) {
                dest.baseValueArray = currentProp.map(Number);
            }
            const modulatedArray = dest.baseValueArray.map(itemBase => {
                const base = Number.isFinite(itemBase) ? itemBase : dest.baseValue;
                return evalDestValue(dest, base, field, destPrng());
            });
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, modulatedArray);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = modulatedArray;
            }
            const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
            if (cachedNode) cachedNode[dest.paramKey] = [...modulatedArray];
        } else {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, newVal);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = newVal;
            }
        }
        updatedAny = true;
    }

    if (Array.isArray(ownerNode.properties?.slots) && ownerNode.properties.slots.length > 0) {
        populateOwnerSlotsFromRandom(modifierNode, ownerNode);
        updatedAny = true;
    }

    if (updatedAny && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
            detail: { nodeId: ownerNode.id }
        }));
    }
}

export function restoreBaseValues(modifierNode: any, ownerNode: any): void {
    if (!modifierNode?.properties || !ownerNode) return;
    const destinations: RandomDestination[] = Array.isArray(modifierNode.properties.destinations)
        ? modifierNode.properties.destinations
        : [];

    for (const dest of destinations) {
        // Handle step_parameters.X.key restoration
        const stepMatch = dest.paramKey.match(/^step_parameters\.(\d+)\.(.+)$/);
        if (stepMatch && Array.isArray(ownerNode.properties?.step_parameters)) {
            const stepIdx = parseInt(stepMatch[1], 10);
            const fieldKey = stepMatch[2];
            const nextSteps = ownerNode.properties.step_parameters.map((s: any) => ({ ...(s || {}) }));
            const stepObj = nextSteps[stepIdx];
            if (stepObj && dest.baseValue !== undefined && Number.isFinite(dest.baseValue)) {
                stepObj[fieldKey] = dest.baseValue;
                if (fieldKey === 'subdivisions') {
                    stepObj.subdivision_enabled = dest.baseValue > 1;
                }
                dest.currentValue = dest.baseValue;
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', nextSteps);
                } else {
                    ownerNode.properties.step_parameters = nextSteps;
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) {
                    cachedNode.step_parameters = nextSteps.map((s: any) => ({ ...s }));
                }
            }
            continue;
        }

        // Handle all steps restoration when targeting 'velocity', 'offset', 'probability', 'subdivisions'
        if (Array.isArray(ownerNode.properties?.step_parameters) && ['velocity', 'offset', 'probability', 'subdivisions', 'sample_start', 'gate_length'].includes(dest.paramKey)) {
            const fieldKey = dest.paramKey;
            if (dest.baseValueArray && Array.isArray(dest.baseValueArray)) {
                const nextSteps = ownerNode.properties.step_parameters.map((s: any) => ({ ...(s || {}) }));
                for (let i = 0; i < nextSteps.length; i++) {
                    const stepObj = nextSteps[i];
                    if (stepObj && dest.baseValueArray[i] !== undefined) {
                        stepObj[fieldKey] = dest.baseValueArray[i];
                        if (fieldKey === 'subdivisions') {
                            stepObj.subdivision_enabled = dest.baseValueArray[i] > 1;
                        }
                    }
                }
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', nextSteps);
                } else {
                    ownerNode.properties.step_parameters = nextSteps;
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) {
                    cachedNode.step_parameters = nextSteps.map((s: any) => ({ ...s }));
                }
            }
            continue;
        }

        if (dest.baseValueArray && Array.isArray(dest.baseValueArray)) {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, [...dest.baseValueArray]);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = [...dest.baseValueArray];
            }
            const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
            if (cachedNode) {
                cachedNode[dest.paramKey] = [...dest.baseValueArray];
            }
            dest.currentValue = dest.baseValue;
        } else if (dest.baseValue !== undefined && Number.isFinite(dest.baseValue)) {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, dest.baseValue);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = dest.baseValue;
            }
            dest.currentValue = dest.baseValue;
        }
    }
}

export async function resolveAssignedRandomModifiers(
    graph: any,
    rootNodeId: number,
    request: RandomResolutionRequest = { kind: 'preview' },
    trackNodesMap?: Map<number, any>
): Promise<void> {
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    const visited = new Set<number>();

    const allGraphNodes = (graph?._nodes || graph?.nodes || []) as any[];

    const visit = async (nodeId: number) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);

        const node = graph?.getNodeById?.(nodeId) || allGraphNodes.find((n: any) => n?.id === nodeId);
        const data = trackNodes?.get(nodeId);

        // Find all attached RANDOM modifier nodes
        const candidateModifiers: any[] = [];

        // Check assigned parentId references across all graph nodes
        for (const candidate of allGraphNodes) {
            const isRandom = candidate?.type === 'Audio/Random'
                || candidate?.properties?.node_type === 'random'
                || (candidate?.isModifier && candidate?.modifierKind === 'random');

            const parentId = candidate?.properties?.parentId ?? trackNodes?.get(candidate?.id)?.parentId;
            if (isRandom && parentId === nodeId) {
                candidateModifiers.push(candidate);
            }
        }

        for (const modNode of candidateModifiers) {
            const refreshMode = normalizeRandomRefreshMode(modNode.properties?.refresh_mode);
            if (modNode.properties) modNode.properties.refresh_mode = refreshMode;

            const isFrozen = Boolean(request.globalFreeze) && (
                node?.properties
                    ? node.properties.freeze_refresh !== false
                    : modNode?.properties?.freeze_refresh !== false
            );

            const shouldRefresh = !isFrozen
                && (modNode.properties?.seed_refresh !== false)
                && shouldRefreshRandom(
                    refreshMode,
                    nodeId,
                    rootNodeId,
                    trackNodes,
                    request
                );

            if (shouldRefresh) {
                advanceRandomSeed(modNode, trackNodes);
                applyRandomModulation(modNode, node);
            }
        }

        const adjacentIds: number[] = [...(data?.children || [])];
        for (const input of node?.inputs || []) {
            if (input?.link == null) continue;
            let originId: number | null = null;
            const links = (graph as any)?.links;
            if (Array.isArray(links)) {
                const link = links.find((l: any) => (Array.isArray(l) ? l[0] : l?.id) === input.link) || links[input.link];
                originId = Array.isArray(link) ? link[1] : (link?.origin_id ?? null);
            } else if (links) {
                const link = links[input.link];
                originId = Array.isArray(link) ? link[1] : (link?.origin_id ?? null);
            }
            if (originId != null && !adjacentIds.includes(originId)) adjacentIds.push(originId);
        }
        await Promise.all(adjacentIds.map(childId => visit(childId)));
    };

    if (rootNodeId != null) {
        await visit(rootNodeId);
    } else {
        const allNodes = (((graph as any)._nodes || (graph as any).nodes || []) as any[]);
        for (const n of allNodes) {
            if (n && n.id != null) await visit(n.id);
        }
    }
}

/**
 * Rolls all seed fields across the graph whose right-hand Refresh Toggle (`seed_refresh`) is ON,
 * provided Global Freeze (`isGlobalFrozen`) is OFF. Immediately re-evaluates attached Pools and Random modifiers.
 */
export function refreshArmedSeeds(
    graph: any,
    isGlobalFrozen: boolean = false,
    trackNodesMap?: Map<number, any>
): boolean {
    if (isGlobalFrozen || !graph) return false;
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    const allNodes = ((graph as any)._nodes || (graph as any).nodes || []) as any[];
    let rolledAny = false;

    // 1. Reset internal trigger counter on every node when refreshing
    for (const node of allNodes) {
        if (!node?.properties) continue;
        if (Number(node.properties.trigger_count) !== 0) {
            node.properties.trigger_count = 0;
            rolledAny = true;
        } else {
            node.properties.trigger_count = 0;
        }
        const nodeData = trackNodes?.get(node.id);
        if (nodeData) {
            nodeData.trigger_count = 0;
        }
    }

    // 2. Roll armed seed controllers and attached modifiers
    for (const node of allNodes) {
        if (!node?.properties) continue;
        if (node.properties.seed === undefined) continue;
        if (node.properties.seed_refresh === false) continue;

        const isAssetFilter = node.type === 'Audio/AssetFilter'
            || node.properties.node_type === 'asset_filter'
            || node.properties.output_type === 'asset_path';
        const isRandom = node.type === 'Audio/Random'
            || node.properties.node_type === 'random'
            || (node.isModifier && node.modifierKind === 'random');

        if (isAssetFilter) {
            advanceAssetPoolSeed(node, trackNodes);
            const parentId = node.properties.parentId ?? trackNodes?.get(node.id)?.parentId;
            const ownerNode = parentId != null ? (graph.getNodeById?.(parentId) || allNodes.find((n: any) => n?.id === parentId)) : null;
            if (ownerNode) {
                if (ownerNode.properties) {
                    ownerNode.properties.trigger_count = 0;
                }
                const isSeqOwner = ownerNode.type === 'Audio/Sequence' || ownerNode.properties?.node_type === 'sequence';
                if (isSeqOwner) {
                    node.properties.output_value = '';
                }
                populateOwnerSlotsFromPool(node, ownerNode);
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: ownerNode.id } }));
                }
            }
        } else if (isRandom) {
            advanceRandomSeed(node, trackNodes);
            const parentId = node.properties.parentId ?? trackNodes?.get(node.id)?.parentId;
            const ownerNode = parentId != null ? (graph.getNodeById?.(parentId) || allNodes.find((n: any) => n?.id === parentId)) : null;
            if (ownerNode) {
                applyRandomModulation(node, ownerNode);
            }
        } else {
            const rolled = rollSeedExpression(node.properties.seed ?? 42);
            const numericCandidate = Number(rolled);
            const nextSeed: string | number = (!rolled.includes(' ') && Number.isFinite(numericCandidate))
                ? numericCandidate
                : rolled;
            node.properties.seed_salt = (Number(node.properties.seed_salt) || 0) + 1;
            if (typeof node.updateProperty === 'function') {
                node.updateProperty('seed', nextSeed);
            } else {
                node.properties.seed = nextSeed;
            }
            if ('_cachedCompositedBuffer' in node) {
                node._cachedCompositedBuffer = null;
            }
            node.setDirtyCanvas?.(true, true);
            const nodeData = trackNodes?.get(node.id);
            if (nodeData) {
                nodeData.seed = nextSeed;
                nodeData.seed_salt = node.properties.seed_salt;
            }
        }

        if (typeof window !== 'undefined' && node.id != null) {
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
        }
        rolledAny = true;
    }

    // 3. Re-evaluate any node-level Field Operators (parameter operators or pool_query operators) at trigger_count = 0
    for (const node of allNodes) {
        if (!node?.properties) continue;
        const hasNodeOps = node.properties.field_operators && Object.keys(node.properties.field_operators).length > 0;
        const hasSlotOps = Array.isArray(node.properties.slots) && node.properties.slots.some((s: any) =>
            (s?.field_operators && Object.keys(s.field_operators).length > 0) || isFieldOperatorExpression(s?.pool_query)
        );
        const hasPoolOp = isFieldOperatorExpression(node.properties.pool_query);
        if (!hasNodeOps && !hasSlotOps && !hasPoolOp) continue;

        if (node.properties.seed === undefined && node.properties.seed_refresh !== false) {
            node.properties.seed_salt = (Number(node.properties.seed_salt) || 0) + 1;
        }
        if (typeof node.evaluateAllFieldOperators === 'function') {
            node.evaluateAllFieldOperators(0);
        }
        if (typeof window !== 'undefined' && node.id != null) {
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
        }
        rolledAny = true;
    }

    return rolledAny;
}
