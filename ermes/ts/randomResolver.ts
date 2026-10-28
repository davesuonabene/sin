/**
 * ERMES Dynamic Random Modifier Engine
 * Manages parameter random range evaluations, relative % offsets,
 * schema limit truncation, seed management, and graph traversal.
 */

import { type FieldSchema } from '../../editor/src/fields/FieldSchema.ts';

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

export function advanceRandomSeed(modifierNode: any, trackNodesMap?: Map<number, any>): number {
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    const nextSeed = Math.floor(Math.random() * 1000000);
    if (modifierNode?.properties) {
        modifierNode.properties.seed = nextSeed;
    }
    const modifierData = trackNodes?.get(modifierNode?.id);
    if (modifierData) modifierData.seed = nextSeed;
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
        if (['section_points', 'section_probability', 'section_sample_start'].includes(paramKey)) {
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

export function applyRandomModulation(
    modifierNode: any,
    ownerNode: any,
    options: { forceRefresh?: boolean; randomFactorGenerator?: () => number } = {}
): void {
    if (!modifierNode?.properties || !ownerNode) return;
    const destinations: RandomDestination[] = Array.isArray(modifierNode.properties.destinations)
        ? modifierNode.properties.destinations
        : [];

    let updatedAny = false;

    for (const dest of destinations) {
        if (!dest.enabled) continue;

        const field = findFieldSchema(ownerNode, dest.paramKey);

        // Check if destination targets a specific step in step_parameters (e.g. step_parameters.2.probability)
        const stepMatch = dest.paramKey.match(/^step_parameters\.(\d+)\.(.+)$/);
        if (stepMatch && Array.isArray(ownerNode.properties?.step_parameters)) {
            const stepIdx = parseInt(stepMatch[1], 10);
            const fieldKey = stepMatch[2];
            const stepObj = ownerNode.properties.step_parameters[stepIdx];
            if (stepObj && stepObj[fieldKey] !== undefined) {
                if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
                    dest.baseValue = Number(stepObj[fieldKey]);
                }
                const factor = options.randomFactorGenerator ? options.randomFactorGenerator() : Math.random();
                const newVal = evaluateRelativeRandomValue(
                    dest.baseValue,
                    dest.minPercent,
                    dest.maxPercent,
                    {
                        schemaMin: field?.min !== undefined ? Number(field.min) : undefined,
                        schemaMax: field?.max !== undefined ? Number(field.max) : undefined,
                        step: dest.step !== undefined ? dest.step : (field?.step !== undefined ? Number(field.step) : undefined),
                        randomFactor: factor
                    }
                );
                dest.currentValue = newVal;
                stepObj[fieldKey] = newVal;
                if (fieldKey === 'subdivisions') {
                    stepObj.subdivision_enabled = newVal > 1;
                }
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', [...ownerNode.properties.step_parameters]);
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) {
                    cachedNode.step_parameters = ownerNode.properties.step_parameters.map((s: any) => ({ ...s }));
                }
                updatedAny = true;
            }
            continue;
        }

        // Check if destination targets all steps in step_parameters (e.g. paramKey is 'velocity', 'offset', 'probability', 'subdivisions')
        if (Array.isArray(ownerNode.properties?.step_parameters) && ['velocity', 'offset', 'probability', 'subdivisions'].includes(dest.paramKey)) {
            const fieldKey = dest.paramKey;
            const factorGen = options.randomFactorGenerator || Math.random;
            if (!dest.baseValueArray || !Array.isArray(dest.baseValueArray) || dest.baseValueArray.length !== ownerNode.properties.step_parameters.length) {
                dest.baseValueArray = ownerNode.properties.step_parameters.map((s: any) => Number(s?.[fieldKey] ?? 0));
            }
            const baseValues: number[] = dest.baseValueArray || [];
            for (let i = 0; i < ownerNode.properties.step_parameters.length; i++) {
                const stepObj = ownerNode.properties.step_parameters[i];
                if (stepObj && stepObj[fieldKey] !== undefined) {
                    const stepBase = baseValues[i] ?? Number(stepObj[fieldKey]);
                    const factor = factorGen();
                    const newVal = evaluateRelativeRandomValue(
                        stepBase,
                        dest.minPercent,
                        dest.maxPercent,
                        {
                            schemaMin: field?.min !== undefined ? Number(field.min) : undefined,
                            schemaMax: field?.max !== undefined ? Number(field.max) : undefined,
                            step: dest.step !== undefined ? dest.step : (field?.step !== undefined ? Number(field.step) : undefined),
                            randomFactor: factor
                        }
                    );
                    stepObj[fieldKey] = newVal;
                    if (fieldKey === 'subdivisions') {
                        stepObj.subdivision_enabled = newVal > 1;
                    }
                }
            }
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty('step_parameters', [...ownerNode.properties.step_parameters]);
            }
            const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
            if (cachedNode) {
                cachedNode.step_parameters = ownerNode.properties.step_parameters.map((s: any) => ({ ...s }));
            }
            updatedAny = true;
            continue;
        }

        const currentProp = ownerNode.properties?.[dest.paramKey];

        const isArrayProp = Array.isArray(currentProp);

        // Anchor base value if missing or invalid
        if (dest.baseValue === undefined || !Number.isFinite(dest.baseValue)) {
            const parsed = isArrayProp ? Number(currentProp[0]) : Number(currentProp);
            dest.baseValue = Number.isFinite(parsed) ? parsed : (field?.default ? Number(field.default) : 0);
        }

        const factor = options.randomFactorGenerator ? options.randomFactorGenerator() : Math.random();
        const newVal = evaluateRelativeRandomValue(
            dest.baseValue,
            dest.minPercent,
            dest.maxPercent,
            {
                schemaMin: field?.min !== undefined ? Number(field.min) : undefined,
                schemaMax: field?.max !== undefined ? Number(field.max) : undefined,
                step: dest.step !== undefined ? dest.step : (field?.step !== undefined ? Number(field.step) : undefined),
                randomFactor: factor
            }
        );

        dest.currentValue = newVal;

        if (isArrayProp) {
            if (!dest.baseValueArray || !Array.isArray(dest.baseValueArray) || dest.baseValueArray.length !== currentProp.length) {
                dest.baseValueArray = currentProp.map(Number);
            }
            const modulatedArray = dest.baseValueArray.map(itemBase => {
                const base = Number.isFinite(itemBase) ? itemBase : dest.baseValue;
                return evaluateRelativeRandomValue(
                    base,
                    dest.minPercent,
                    dest.maxPercent,
                    {
                        schemaMin: field?.min !== undefined ? Number(field.min) : undefined,
                        schemaMax: field?.max !== undefined ? Number(field.max) : undefined,
                        step: dest.step !== undefined ? dest.step : (field?.step !== undefined ? Number(field.step) : undefined),
                        randomFactor: options.randomFactorGenerator ? options.randomFactorGenerator() : Math.random()
                    }
                );
            });
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, modulatedArray);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = modulatedArray;
            }
            const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
            if (cachedNode) {
                cachedNode[dest.paramKey] = [...modulatedArray];
            }
        } else {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty(dest.paramKey, newVal);
            } else if (ownerNode.properties) {
                ownerNode.properties[dest.paramKey] = newVal;
            }
        }
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
            const stepObj = ownerNode.properties.step_parameters[stepIdx];
            if (stepObj && dest.baseValue !== undefined && Number.isFinite(dest.baseValue)) {
                stepObj[fieldKey] = dest.baseValue;
                if (fieldKey === 'subdivisions') {
                    stepObj.subdivision_enabled = dest.baseValue > 1;
                }
                dest.currentValue = dest.baseValue;
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', [...ownerNode.properties.step_parameters]);
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) {
                    cachedNode.step_parameters = ownerNode.properties.step_parameters.map((s: any) => ({ ...s }));
                }
            }
            continue;
        }

        // Handle all steps restoration when targeting 'velocity', 'offset', 'probability', 'subdivisions'
        if (Array.isArray(ownerNode.properties?.step_parameters) && ['velocity', 'offset', 'probability', 'subdivisions'].includes(dest.paramKey)) {
            const fieldKey = dest.paramKey;
            if (dest.baseValueArray && Array.isArray(dest.baseValueArray)) {
                for (let i = 0; i < ownerNode.properties.step_parameters.length; i++) {
                    const stepObj = ownerNode.properties.step_parameters[i];
                    if (stepObj && dest.baseValueArray[i] !== undefined) {
                        stepObj[fieldKey] = dest.baseValueArray[i];
                        if (fieldKey === 'subdivisions') {
                            stepObj.subdivision_enabled = dest.baseValueArray[i] > 1;
                        }
                    }
                }
                if (typeof ownerNode.updateProperty === 'function') {
                    ownerNode.updateProperty('step_parameters', [...ownerNode.properties.step_parameters]);
                }
                const cachedNode = (typeof window !== 'undefined' ? (window as any).trackNodes : undefined)?.get(ownerNode.id);
                if (cachedNode) {
                    cachedNode.step_parameters = ownerNode.properties.step_parameters.map((s: any) => ({ ...s }));
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

            const shouldRefresh = !isFrozen && shouldRefreshRandom(
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
