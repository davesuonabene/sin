/**
 * ERMES Generic sin-snapshot Engine (TypeScript).
 * Symmetrical with ermes/py/snapshot.py.
 */

export const SNAPSHOT_FORMAT = 'sin-snapshot';
export const SNAPSHOT_VERSION = 1;

export interface SinSnapshot {
    format: string;
    version: number;
    id: string;
    label?: string;
    root?: string;
    overrides: Record<string, Record<string, any>>;
    meta?: Record<string, any>;
}

function setNestedProp(properties: Record<string, any>, path: string, value: any): void {
    if (!path) return;

    if (!path.includes('.')) {
        properties[path] = value;
        return;
    }

    const parts = path.split('.');
    if (parts[0] === 'chain' && parts.length >= 3) {
        const moduleId = parts[1];
        if (!Array.isArray(properties.chain)) {
            properties.chain = [];
        }

        let targetModule = properties.chain.find((m: any) => m && m.id === moduleId);
        if (!targetModule) {
            targetModule = { id: moduleId, type: 'gain', enabled: true, params: {} };
            properties.chain.push(targetModule);
        }

        const subKey = parts[2];
        if (subKey === 'enabled') {
            targetModule.enabled = Boolean(value);
        } else if (subKey === 'params' && parts.length >= 4) {
            const paramKey = parts[3];
            if (!targetModule.params || typeof targetModule.params !== 'object') {
                targetModule.params = {};
            }
            targetModule.params[paramKey] = value;
        } else {
            targetModule[subKey] = value;
        }
        return;
    }

    let curr = properties;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!curr[part] || typeof curr[part] !== 'object') {
            curr[part] = {};
        }
        curr = curr[part];
    }
    curr[parts[parts.length - 1]] = value;
}

export function applySnapshot(
    graph: Record<string, any>,
    snapshot?: SinSnapshot | null,
    transientOverrides?: Record<string, Record<string, any>> | null
): Record<string, any> {
    const resolved = JSON.parse(JSON.stringify(graph));
    const nodes = resolved.nodes || [];
    const nodeMap = new Map<string, any>();
    for (const node of nodes) {
        if (node && node.id) {
            nodeMap.set(String(node.id), node);
        }
    }

    if (snapshot && typeof snapshot.overrides === 'object') {
        for (const [nodeId, propOverrides] of Object.entries(snapshot.overrides)) {
            const node = nodeMap.get(String(nodeId));
            if (node && propOverrides && typeof propOverrides === 'object') {
                if (!node.properties || typeof node.properties !== 'object') {
                    node.properties = {};
                }
                for (const [propPath, val] of Object.entries(propOverrides)) {
                    setNestedProp(node.properties, propPath, val);
                }
            }
        }
    }

    if (transientOverrides && typeof transientOverrides === 'object') {
        for (const [nodeId, propOverrides] of Object.entries(transientOverrides)) {
            const node = nodeMap.get(String(nodeId));
            if (node && propOverrides && typeof propOverrides === 'object') {
                if (!node.properties || typeof node.properties !== 'object') {
                    node.properties = {};
                }
                for (const [propPath, val] of Object.entries(propOverrides)) {
                    setNestedProp(node.properties, propPath, val);
                }
            }
        }
    }

    return resolved;
}

export function diffSnapshot(
    baseGraph: Record<string, any>,
    modifiedGraph: Record<string, any>,
    snapshotId: string,
    label: string = '',
    root?: string,
    meta?: Record<string, any>
): SinSnapshot {
    const baseNodes = new Map<string, any>();
    for (const node of baseGraph.nodes || []) {
        if (node && node.id) baseNodes.set(String(node.id), node);
    }

    const overrides: Record<string, Record<string, any>> = {};

    for (const modNode of modifiedGraph.nodes || []) {
        if (!modNode || !modNode.id) continue;
        const nodeId = String(modNode.id);
        const baseNode = baseNodes.get(nodeId);
        if (!baseNode) continue;

        const baseProps = baseNode.properties || {};
        const modProps = modNode.properties || {};
        const nodeOverrides: Record<string, any> = {};

        const allKeys = new Set([...Object.keys(baseProps), ...Object.keys(modProps)]);
        for (const key of allKeys) {
            if (key === 'chain') {
                const baseChain = new Map<string, any>();
                for (const m of baseProps.chain || []) {
                    if (m && m.id) baseChain.set(String(m.id), m);
                }
                for (const mMod of modProps.chain || []) {
                    if (!mMod || !mMod.id) continue;
                    const modId = String(mMod.id);
                    const bMod = baseChain.get(modId) || {};
                    if (mMod.enabled !== bMod.enabled) {
                        nodeOverrides[`chain.${modId}.enabled`] = mMod.enabled;
                    }
                    const mParams = mMod.params || {};
                    const bParams = bMod.params || {};
                    for (const [pKey, pVal] of Object.entries(mParams)) {
                        if (pVal !== bParams[pKey]) {
                            nodeOverrides[`chain.${modId}.params.${pKey}`] = pVal;
                        }
                    }
                }
            } else {
                const bVal = baseProps[key];
                const mVal = modProps[key];
                if (bVal !== mVal && mVal !== undefined) {
                    nodeOverrides[key] = mVal;
                }
            }
        }

        if (Object.keys(nodeOverrides).length > 0) {
            overrides[nodeId] = nodeOverrides;
        }
    }

    return {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        id: snapshotId,
        label: label || snapshotId,
        root: root || modifiedGraph.output || 'master',
        overrides,
        meta: meta || {},
    };
}

export function validateSnapshot(
    graph: Record<string, any>,
    snapshot: any
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!snapshot || typeof snapshot !== 'object') {
        return { valid: false, errors: ['Snapshot must be an object'] };
    }

    if (snapshot.format !== SNAPSHOT_FORMAT) {
        errors.push(`Invalid format: expected '${SNAPSHOT_FORMAT}', got '${snapshot.format}'`);
    }

    if (!snapshot.id) {
        errors.push("Snapshot must have a non-empty 'id'");
    }

    if (!snapshot.overrides || typeof snapshot.overrides !== 'object') {
        errors.push("Snapshot 'overrides' must be an object");
    } else {
        const nodeIds = new Set((graph?.nodes || []).map((n: any) => n?.id).filter(Boolean));
        for (const [nodeId, propDict] of Object.entries(snapshot.overrides)) {
            if (!nodeIds.has(nodeId)) {
                // Pass rather than hard failure
            }
            if (!propDict || typeof propDict !== 'object') {
                errors.push(`Overrides for node '${nodeId}' must be a dictionary of property paths`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}
