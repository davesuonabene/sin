import { LiteGraph, type LGraph, type LGraphNode } from 'litegraph.js';

const META_FIELDS = new Set([
    'ghost_source_id',
    'ghost_source_name',
    'ghost_unlinked_fields',
    'ghost_detached_source_id'
]);

const rawProperties = new WeakMap<object, Record<string, any>>();

function cloneValue<T>(value: T, seen = new WeakMap<object, any>()): T {
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return seen.get(value as object);
    const copy: any = Array.isArray(value) ? [] : {};
    seen.set(value as object, copy);
    for (const key of Reflect.ownKeys(value as object)) {
        copy[key as any] = cloneValue((value as any)[key], seen);
    }
    return copy;
}

/** Return a plain, detached property bag suitable for persistence or cloning. */
export function snapshotNodeProperties(node: any): Record<string, any> {
    // Reading through the proxy captures a ghost's currently effective values.
    const snapshot = cloneValue(node?.properties || {});
    const raw = node ? getRaw(node) : {};
    // Relationship metadata must come from the raw bag so callers can remap it.
    for (const field of META_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(raw, field)) {
            snapshot[field] = cloneValue(raw[field]);
        }
    }
    return snapshot;
}

function getRaw(node: any): Record<string, any> {
    return rawProperties.get(node) || node.properties || {};
}

function getUnlinked(raw: Record<string, any>): Set<string> {
    return new Set(Array.isArray(raw.ghost_unlinked_fields) ? raw.ghost_unlinked_fields : []);
}

function setUnlinked(raw: Record<string, any>, fields: Set<string>) {
    raw.ghost_unlinked_fields = [...fields].sort();
}

export function isGhostNode(node: any): boolean {
    const raw = node ? getRaw(node) : {};
    return raw.ghost_source_id != null || raw.ghost_detached_source_id != null;
}

export function getGhostSource(node: any, graph?: LGraph): any | null {
    const raw = getRaw(node);
    const targetGraph = graph || node?.graph;
    return raw.ghost_source_id != null ? targetGraph?.getNodeById?.(raw.ghost_source_id) || null : null;
}

export function getGhostFieldNames(node: any): string[] {
    const raw = getRaw(node);
    const source = getGhostSource(node);
    return [...new Set([...Object.keys(raw), ...Object.keys(source?.properties || {})])]
        .filter(field => !META_FIELDS.has(field))
        .sort((a, b) => a.localeCompare(b));
}

export function isGhostFieldLinked(node: any, field: string): boolean {
    if (!getGhostSource(node) || META_FIELDS.has(field)) return false;
    return !getUnlinked(getRaw(node)).has(field);
}

export function unlinkGhostField(node: any, field: string) {
    if (!node || META_FIELDS.has(field)) return;
    const raw = getRaw(node);
    const source = getGhostSource(node);
    if (!source || getUnlinked(raw).has(field)) return;
    raw[field] = cloneValue(source.properties?.[field]);
    const fields = getUnlinked(raw);
    fields.add(field);
    setUnlinked(raw, fields);
    node.setDirtyCanvas?.(true, true);
}

export function relinkGhostField(node: any, field: string) {
    const raw = getRaw(node);
    const fields = getUnlinked(raw);
    if (!fields.delete(field)) return;
    setUnlinked(raw, fields);
    node.setDirtyCanvas?.(true, true);
}

function resolveAtPath(root: any, path: PropertyKey[]): any {
    let value = root;
    for (const key of path) value = value?.[key as any];
    return value;
}

function getEffectiveField(node: any, field: string): any {
    const raw = getRaw(node);
    const source = getGhostSource(node);
    return source && !getUnlinked(raw).has(field) ? source.properties?.[field] : raw[field];
}

function makeNestedProxy(node: any, field: string, path: PropertyKey[], sample: any): any {
    const proxyTarget: any = Array.isArray(sample) ? [] : {};
    const currentRoot = () => getEffectiveField(node, field);
    const current = () => resolveAtPath(currentRoot(), path);
    return new Proxy(proxyTarget, {
        get(_target, prop) {
            const value = Reflect.get(current(), prop);
            return value != null && typeof value === 'object'
                ? makeNestedProxy(node, field, [...path, prop], value)
                : value;
        },
        set(_target, prop, value) {
            const source = getGhostSource(node);
            const raw = getRaw(node);
            const root = source && !getUnlinked(raw).has(field) ? source.properties?.[field] : raw[field];
            const target = resolveAtPath(root, path);
            return target != null && Reflect.set(target, prop, cloneValue(value));
        },
        deleteProperty(_target, prop) {
            const source = getGhostSource(node);
            const raw = getRaw(node);
            const root = source && !getUnlinked(raw).has(field) ? source.properties?.[field] : raw[field];
            const target = resolveAtPath(root, path);
            return target != null && Reflect.deleteProperty(target, prop);
        },
        ownKeys() { return Reflect.ownKeys(current()); },
        has(_target, prop) { return prop in current(); },
        getOwnPropertyDescriptor(_target, prop) {
            const descriptor = Object.getOwnPropertyDescriptor(current(), prop);
            return descriptor ? { ...descriptor, configurable: true } : undefined;
        }
    });
}

export function attachGhostProperties(node: any, graph?: LGraph) {
    if (!node?.properties || rawProperties.has(node) || !isGhostNode(node)) return;
    const raw = node.properties as Record<string, any>;
    if (!Array.isArray(raw.ghost_unlinked_fields)) raw.ghost_unlinked_fields = [];
    rawProperties.set(node, raw);
    const targetGraph = graph || node.graph;
    node.properties = new Proxy(raw, {
        get(target, prop, receiver) {
            if (typeof prop !== 'string' || META_FIELDS.has(prop)) return Reflect.get(target, prop, receiver);
            const source = raw.ghost_source_id != null ? targetGraph?.getNodeById?.(raw.ghost_source_id) : null;
            const value = source && !getUnlinked(raw).has(prop) ? source.properties?.[prop] : target[prop];
            return value != null && typeof value === 'object' ? makeNestedProxy(node, prop, [], value) : value;
        },
        set(target, prop, value, receiver) {
            if (typeof prop !== 'string' || META_FIELDS.has(prop)) {
                return Reflect.set(target, prop, cloneValue(value), receiver);
            }
            const source = raw.ghost_source_id != null ? targetGraph?.getNodeById?.(raw.ghost_source_id) : null;
            if (source?.properties && !getUnlinked(raw).has(prop)) {
                source.properties[prop] = cloneValue(value);
                return true;
            }
            return Reflect.set(target, prop, cloneValue(value), receiver);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && !META_FIELDS.has(prop)) {
                const source = raw.ghost_source_id != null ? targetGraph?.getNodeById?.(raw.ghost_source_id) : null;
                if (source?.properties && !getUnlinked(raw).has(prop)) return Reflect.deleteProperty(source.properties, prop);
            }
            return Reflect.deleteProperty(target, prop);
        },
        ownKeys(target) {
            const source = raw.ghost_source_id != null ? targetGraph?.getNodeById?.(raw.ghost_source_id) : null;
            return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(source?.properties || {})])];
        },
        getOwnPropertyDescriptor(target, prop) {
            return Object.getOwnPropertyDescriptor(target, prop)
                || Object.getOwnPropertyDescriptor(getGhostSource(node, targetGraph)?.properties || {}, prop)
                || { configurable: true, enumerable: true, writable: true, value: undefined };
        }
    });
}

export function createGhostNode(source: any, graph: LGraph): LGraphNode | null {
    if (!source || !graph || source.properties?.disabled) return null;
    const ghost: any = LiteGraph.createNode(source.type);
    if (!ghost) return null;

    ghost.properties = cloneValue(source.properties || {});
    ghost.properties.ghost_source_id = source.id;
    ghost.properties.ghost_source_name = source.properties?.node_name || source.title || `Node #${source.id}`;
    ghost.properties.ghost_unlinked_fields = [];
    ghost.pos = [source.pos[0] + 96, source.pos[1] + 96];
    ghost.title = source.title;
    ghost.color = source.color;
    ghost.bgcolor = source.bgcolor;
    ghost.boxcolor = source.boxcolor;
    graph.add(ghost);
    attachGhostProperties(ghost, graph);
    return ghost;
}

export function detachGhostDependents(graph: LGraph | undefined, sourceId: number, sourceProperties?: Record<string, any>) {
    if (!graph) return;
    for (const node of ((graph as any)._nodes || [])) {
        const raw = getRaw(node);
        if (raw.ghost_source_id !== sourceId) continue;
        const sourceSnapshot = sourceProperties || {};
        const fields = new Set([...Object.keys(raw), ...Object.keys(sourceSnapshot)]);
        for (const field of fields) {
            if (META_FIELDS.has(field) || getUnlinked(raw).has(field)) continue;
            raw[field] = cloneValue(sourceSnapshot[field] ?? node.properties?.[field]);
        }
        setUnlinked(raw, new Set([...getUnlinked(raw), ...[...fields].filter(field => !META_FIELDS.has(field))]));
        raw.ghost_detached_source_id = sourceId;
        raw.ghost_source_id = null;
        node.setDirtyCanvas?.(true, true);
    }
}

export function syncGhostTrackData(node: any, data: any) {
    if (!node || !data || !isGhostNode(node)) return;
    const p = node.properties || {};
    for (const key of Object.keys(p)) {
        if (!META_FIELDS.has(key)) data[key === 'node_name' ? 'name' : key] = p[key];
    }
}

export const ghostMetadataFields = META_FIELDS;
