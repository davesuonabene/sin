/**
 * Canonical graph authoring contract.
 *
 * LiteGraph remains the editor's storage/runtime format. This module gives
 * callers a smaller, readable format for creating and validating graphs
 * before converting them to LiteGraph workspace data.
 */

export const GRAPH_DOCUMENT_FORMAT = 'sin-graph' as const;
export const GRAPH_DOCUMENT_VERSION = 1 as const;

export type GraphNodeType =
    | 'sample'
    | 'sequence'
    | 'arrangement'
    | 'track'
    | 'asset_filter'
    | 'modulator'
    | 'disabled';
export type GraphNodeRole = 'master';
export type GraphConnectionType = 'audio';
export type GraphAttachmentType = 'asset_pool' | 'modulator';
export type GraphAssetId = string | number;

/**
 * Pool membership is an exact GAIA key list.
 */
export interface GraphAssetLocator {
    id?: GraphAssetId | null;
    [key: string]: unknown;
}

export type GraphAssetPoolRefreshMode =
    | 'local'
    | 'parent'
    | 'ancestor'
    | 'global'
    | 'off'
    | 'local_refresh'
    | 'parent_refresh'
    | 'global_refresh'
    | 'parent_render'
    | 'ancestor_refresh'
    | 'self_render'
    | 'manual'
    | 'fixed';

/** State persisted on an Audio/AssetFilter node. */
export interface GraphAssetPool {
    selected_items?: GraphAssetLocator[];
    playbackMode?: 'Random' | 'Sequential' | string;
    refresh_mode?: GraphAssetPoolRefreshMode | string;
    seed?: number;
    sequence_index?: number;
    fixed_item?: GraphAssetLocator | null;
    accepted_asset_type?: 'audio' | 'midi' | 'sequence_source' | string;
    output_type?: 'asset_path' | string;
    [key: string]: unknown;
}

export interface GraphNodeProperties extends Record<string, unknown> {
    /** Optional readable alias; conversion flattens it to current node fields. */
    asset_pool?: GraphAssetPool;
}

export interface GraphNode {
    id: string;
    type: GraphNodeType;
    name?: string;
    role?: GraphNodeRole;
    position?: [number, number];
    properties?: GraphNodeProperties;
    /** Readable top-level alias for an asset_filter's persisted pool state. */
    assetPool?: GraphAssetPool;
}

export interface GraphConnection {
    from: string;
    to: string;
    type: GraphConnectionType;
}

/** Non-audio ownership used by AssetFilter/Modulator nodes. */
export interface GraphAttachment {
    owner: string;
    modifier: string;
    type: GraphAttachmentType;
}

export interface GraphSettings {
    bpm: number;
    total_bars: number;
    key: string;
}

export interface GraphDocument {
    format: typeof GRAPH_DOCUMENT_FORMAT;
    version: typeof GRAPH_DOCUMENT_VERSION;
    nodes: GraphNode[];
    connections: GraphConnection[];
    attachments?: GraphAttachment[];
    settings: GraphSettings;
    output: string;
}

export interface GraphValidationResult {
    valid: boolean;
    errors: string[];
}

export interface GraphValidationOptions {
    /** Permit partial documents that do not yet have a master output. */
    requireOutput?: boolean;
}

export interface LiteGraphWorkspacePreset {
    version: 2;
    savedAt: string;
    graph: {
        last_node_id: number;
        last_link_id: number;
        nodes: Array<Record<string, unknown>>;
        links: Array<[number, number, number, number, number, GraphConnectionType]>;
        groups: [];
        config: { links_ontop: true };
        extra: {
            global_parameters: GraphSettings;
            main_preview: { node_id: number; mode: 'auto' };
        };
        version: 0.4;
    };
}

const LITE_GRAPH_NODE_TYPES: Record<GraphNodeType, string> = {
    sample: 'Audio/Sample',
    sequence: 'Audio/Sequence',
    arrangement: 'Audio/Arrangement',
    track: 'Audio/Track',
    asset_filter: 'Audio/AssetFilter',
    modulator: 'Audio/Modulator',
    disabled: 'Audio/Disabled'
};

const DEFAULT_NODE_NAMES: Record<GraphNodeType, string> = {
    sample: 'Sample',
    sequence: 'Sequence',
    arrangement: 'Arrangement',
    track: 'Track',
    asset_filter: 'Asset Pool',
    modulator: 'Modulator',
    disabled: 'Disabled Node'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGraphNodeType(value: unknown): value is GraphNodeType {
    return value === 'sample'
        || value === 'sequence'
        || value === 'arrangement'
        || value === 'track'
        || value === 'asset_filter'
        || value === 'modulator'
        || value === 'disabled';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function cloneProperties(properties: Record<string, unknown> | undefined): Record<string, unknown> {
    return properties ? { ...properties } : {};
}

function validationError(errors: string[], message: string): void {
    if (!errors.includes(message)) errors.push(message);
}

const GRAPH_POOL_REFRESH_MODES = new Set<string>([
    'local', 'parent', 'ancestor', 'global', 'off',
    'local_refresh', 'parent_refresh', 'global_refresh',
    'parent_render', 'ancestor_refresh', 'self_render', 'manual', 'fixed'
]);

function validateAssetPool(
    value: unknown,
    nodeId: string,
    errors: string[]
): void {
    if (!isRecord(value)) {
        errors.push(`Asset pool on node "${nodeId}" must be an object.`);
        return;
    }

    if (value.filters !== undefined) {
        errors.push(`Asset pool on node "${nodeId}" cannot contain filters; choose exact assets in the Library panel.`);
    }
    if (value.selected_items !== undefined) {
        if (!Array.isArray(value.selected_items)) {
            errors.push(`Asset pool selected_items on node "${nodeId}" must be an array.`);
        } else {
            value.selected_items.forEach((item, index) => {
                if (!isRecord(item)) {
                    errors.push(`Asset pool item ${index} on node "${nodeId}" must be an object.`);
                    return;
                }
                const hasId = (typeof item.id === 'string' && item.id.trim().length > 0)
                    || (typeof item.id === 'number' && Number.isFinite(item.id));
                if (!hasId) {
                    errors.push(`Asset pool item ${index} on node "${nodeId}" must contain an exact GAIA id.`);
                }
            });
        }
    }
    if (value.playbackMode !== undefined
        && typeof value.playbackMode !== 'string') {
        errors.push(`Asset pool playbackMode on node "${nodeId}" must be a string.`);
    }
    if (value.refresh_mode !== undefined
        && (typeof value.refresh_mode !== 'string' || !GRAPH_POOL_REFRESH_MODES.has(value.refresh_mode))) {
        errors.push(`Asset pool refresh_mode on node "${nodeId}" is unsupported.`);
    }
    if (value.seed !== undefined && !isFiniteNumber(value.seed)) {
        errors.push(`Asset pool seed on node "${nodeId}" must be numeric.`);
    }
    if (value.sequence_index !== undefined && !isFiniteNumber(value.sequence_index)) {
        errors.push(`Asset pool sequence_index on node "${nodeId}" must be numeric.`);
    }
    if (value.fixed_item !== undefined && value.fixed_item !== null && !isRecord(value.fixed_item)) {
        errors.push(`Asset pool fixed_item on node "${nodeId}" must be an object or null.`);
    } else if (isRecord(value.fixed_item)) {
        const hasId = (typeof value.fixed_item.id === 'string' && value.fixed_item.id.trim().length > 0)
            || (typeof value.fixed_item.id === 'number' && Number.isFinite(value.fixed_item.id));
        if (!hasId) {
            errors.push(`Asset pool fixed_item on node "${nodeId}" must contain an exact GAIA id.`);
        }
    }
}

function compactAssetLocator(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if ((typeof value.id === 'string' && value.id.trim().length > 0)
        || (typeof value.id === 'number' && Number.isFinite(value.id))) {
        return { id: value.id };
    }
    return null;
}

/** Validate a canonical graph document without touching the editor or DOM. */
export function validateGraphDocument(
    value: unknown,
    options: GraphValidationOptions = {}
): GraphValidationResult {
    const errors: string[] = [];
    if (!isRecord(value)) return { valid: false, errors: ['Graph document must be an object.'] };

    if (value.format !== GRAPH_DOCUMENT_FORMAT) {
        errors.push(`Graph format must be "${GRAPH_DOCUMENT_FORMAT}".`);
    }
    if (value.version !== GRAPH_DOCUMENT_VERSION) {
        errors.push(`Graph version must be ${GRAPH_DOCUMENT_VERSION}.`);
    }

    const rawNodes = value.nodes;
    const nodes = Array.isArray(rawNodes) ? rawNodes : [];
    if (!Array.isArray(rawNodes)) errors.push('Graph nodes must be an array.');
    if (nodes.length === 0) errors.push('Graph must contain at least one node.');

    const nodesById = new Map<string, GraphNode>();
    nodes.forEach((rawNode, index) => {
        if (!isRecord(rawNode)) {
            errors.push(`Node ${index} must be an object.`);
            return;
        }

        const id = rawNode.id;
        if (typeof id !== 'string' || !id.trim()) {
            errors.push(`Node ${index} must have a non-empty string id.`);
        } else if (nodesById.has(id)) {
            errors.push(`Node id "${id}" is duplicated.`);
        }

        const type = rawNode.type;
        if (!isGraphNodeType(type)) {
            errors.push(`Node "${String(id || index)}" has an unsupported type.`);
        }

        if (rawNode.name !== undefined && typeof rawNode.name !== 'string') {
            errors.push(`Node "${String(id || index)}" name must be a string.`);
        }
        if (rawNode.role !== undefined && rawNode.role !== 'master') {
            errors.push(`Node "${String(id || index)}" has an unsupported role.`);
        }
        if (rawNode.position !== undefined) {
            const position = rawNode.position;
            if (!Array.isArray(position)
                || position.length !== 2
                || !position.every(isFiniteNumber)) {
                errors.push(`Node "${String(id || index)}" position must be [x, y].`);
            }
        }
        if (rawNode.properties !== undefined && !isRecord(rawNode.properties)) {
            errors.push(`Node "${String(id || index)}" properties must be an object.`);
        }

        if (typeof id === 'string' && id.trim() && isGraphNodeType(type)) {
            const node = rawNode as unknown as GraphNode;
            nodesById.set(id, node);
            const properties = isRecord(rawNode.properties) ? rawNode.properties : {};
            if (type === 'sample' && properties.sample_type !== 'loop' && properties.sample_type !== 'one_shot') {
                errors.push(`Sample node "${id}" must set properties.sample_type to "loop" or "one_shot".`);
            }
            if (properties.asset_pool !== undefined) {
                validateAssetPool(properties.asset_pool, id, errors);
            }
            if (properties.filters !== undefined) {
                errors.push(`Pool filters on node "${id}" are not supported; choose exact assets in the Library panel.`);
            }
            if (properties.selected_items !== undefined) {
                validateAssetPool({
                    selected_items: properties.selected_items,
                    playbackMode: properties.playbackMode,
                    refresh_mode: properties.refresh_mode,
                    seed: properties.seed,
                    sequence_index: properties.sequence_index,
                    fixed_item: properties.fixed_item
                }, id, errors);
            }
            if (rawNode.role === 'master' && type !== 'track') {
                errors.push(`Only a track node may have role "master" (node "${id}").`);
            }
        }
    });

    const masterNodes = [...nodesById.values()].filter(node => node.role === 'master');
    if (masterNodes.length > 1) errors.push('Graph may contain only one master node.');

    const rawSettings = value.settings;
    if (!isRecord(rawSettings)) {
        errors.push('Graph settings must be an object.');
    } else {
        if (!isFiniteNumber(rawSettings.bpm) || rawSettings.bpm < 20 || rawSettings.bpm > 300) {
            errors.push('Graph settings.bpm must be between 20 and 300.');
        }
        if (!isFiniteNumber(rawSettings.total_bars) || rawSettings.total_bars <= 0 || rawSettings.total_bars > 128) {
            errors.push('Graph settings.total_bars must be greater than 0 and no more than 128.');
        }
        if (typeof rawSettings.key !== 'string' || !rawSettings.key.trim()) {
            errors.push('Graph settings.key must be a non-empty string.');
        }
    }

    const rawConnections = value.connections;
    const connections = Array.isArray(rawConnections) ? rawConnections : [];
    if (!Array.isArray(rawConnections)) errors.push('Graph connections must be an array.');

    const adjacency = new Map<string, string[]>();
    const seenConnections = new Set<string>();
    connections.forEach((rawConnection, index) => {
        if (!isRecord(rawConnection)) {
            errors.push(`Connection ${index} must be an object.`);
            return;
        }
        const from = rawConnection.from;
        const to = rawConnection.to;
        if (typeof from !== 'string' || !from.trim() || !nodesById.has(from)) {
            errors.push(`Connection ${index} refers to an unknown source node.`);
        }
        if (typeof to !== 'string' || !to.trim() || !nodesById.has(to)) {
            errors.push(`Connection ${index} refers to an unknown target node.`);
        }
        if (rawConnection.type !== 'audio') {
            errors.push(`Connection ${index} must have type "audio".`);
        }
        if (typeof from !== 'string' || typeof to !== 'string') return;
        if (from === to) errors.push(`Connection ${index} cannot connect a node to itself.`);

        const key = `${from}->${to}:${String(rawConnection.type)}`;
        if (seenConnections.has(key)) errors.push(`Connection "${key}" is duplicated.`);
        seenConnections.add(key);
        if (nodesById.has(from) && nodesById.has(to)) {
            const targets = adjacency.get(from) || [];
            targets.push(to);
            adjacency.set(from, targets);
        }
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
        if (visiting.has(id)) {
            validationError(errors, `Audio graph contains a cycle involving node "${id}".`);
            return;
        }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const target of adjacency.get(id) || []) visit(target);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of nodesById.keys()) visit(id);

    const rawAttachments = value.attachments;
    const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
        errors.push('Graph attachments must be an array.');
    }
    const seenAttachments = new Set<string>();
    const attachedOwners = new Set<string>();
    attachments.forEach((rawAttachment, index) => {
        if (!isRecord(rawAttachment)) {
            errors.push(`Attachment ${index} must be an object.`);
            return;
        }
        const owner = rawAttachment.owner;
        const modifier = rawAttachment.modifier;
        const type = rawAttachment.type;
        if (typeof owner !== 'string' || !nodesById.has(owner)) {
            errors.push(`Attachment ${index} refers to an unknown owner node.`);
        }
        if (typeof modifier !== 'string' || !nodesById.has(modifier)) {
            errors.push(`Attachment ${index} refers to an unknown modifier node.`);
        }
        if (type !== 'asset_pool' && type !== 'modulator') {
            errors.push(`Attachment ${index} must have type "asset_pool" or "modulator".`);
        }
        if (typeof owner !== 'string' || typeof modifier !== 'string') return;
        const key = `${owner}->${modifier}:${String(type)}`;
        if (seenAttachments.has(key)) errors.push(`Attachment "${key}" is duplicated.`);
        seenAttachments.add(key);
        if (attachedOwners.has(`${owner}:${type}`)) {
            errors.push(`Node "${owner}" has more than one ${String(type)} attachment.`);
        }
        attachedOwners.add(`${owner}:${type}`);

        const ownerNode = nodesById.get(owner);
        const modifierNode = nodesById.get(modifier);
        if (ownerNode && modifierNode) {
            const expectedModifierType = type === 'asset_pool' ? 'asset_filter' : 'modulator';
            if (modifierNode.type !== expectedModifierType) {
                errors.push(`Attachment "${key}" requires a ${expectedModifierType} modifier.`);
            }
            if (type === 'asset_pool' && ownerNode.type !== 'sample' && ownerNode.type !== 'sequence') {
                errors.push(`Asset pool "${modifier}" may only attach to a sample or sequence node.`);
            }
            if (ownerNode.type === 'asset_filter' || ownerNode.type === 'modulator' || ownerNode.type === 'disabled') {
                errors.push(`Node "${owner}" cannot own a ${String(type)} attachment.`);
            }
        }
    });

    const output = value.output;
    if (options.requireOutput !== false) {
        if (typeof output !== 'string' || !output.trim()) {
            errors.push('Graph output must identify a master node.');
        } else {
            const outputNode = nodesById.get(output);
            if (!outputNode) {
                errors.push(`Graph output refers to unknown node "${output}".`);
            } else {
                if (outputNode.type !== 'track' || outputNode.role !== 'master') {
                    errors.push(`Graph output node "${output}" must be a track with role "master".`);
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

function propertiesForLiteGraphNode(
    node: GraphNode,
    numericIds: Map<string, number>,
    attachments: GraphAttachment[]
): Record<string, unknown> {
    const properties = cloneProperties(node.properties);
    const name = node.name || (typeof properties.node_name === 'string' ? properties.node_name : DEFAULT_NODE_NAMES[node.type]);
    properties.node_name = name;
    properties.node_type = node.type;
    properties.is_main_preview = node.role === 'master';

    const structuredPool = node.assetPool || properties.asset_pool;
    if (structuredPool && isRecord(structuredPool)) {
        for (const key of [
            'selected_items', 'playbackMode', 'refresh_mode',
            'seed', 'sequence_index', 'fixed_item', 'accepted_asset_type', 'output_type'
        ]) {
            if (properties[key] === undefined && structuredPool[key] !== undefined) {
                properties[key] = structuredPool[key];
            }
        }
        delete properties.filters;
        delete properties.asset_pool;
    }
    delete properties.filters;

    if (Array.isArray(properties.selected_items)) {
        properties.selected_items = properties.selected_items
            .map(compactAssetLocator)
            .filter((item): item is Record<string, unknown> => item !== null);
    }
    if (properties.fixed_item !== undefined && properties.fixed_item !== null) {
        properties.fixed_item = compactAssetLocator(properties.fixed_item);
    }

    // Canonical documents may use a structured asset locator. The current
    // SampleNode still consumes filepath/library_item_id, so bridge it here.
    const asset = properties.asset;
    if (isRecord(asset)) {
        if (properties.filepath === undefined && typeof asset.path === 'string') properties.filepath = asset.path;
        if (properties.library_item_id === undefined && (typeof asset.id === 'number' || typeof asset.id === 'string')) {
            properties.library_item_id = asset.id;
        }
        delete properties.asset;
    }

    for (const attachment of attachments) {
        if (attachment.modifier === node.id && attachment.type === 'asset_pool') {
            const ownerId = numericIds.get(attachment.owner);
            if (ownerId !== undefined) properties.parentId = ownerId;
        }
        if (attachment.owner === node.id && attachment.type === 'asset_pool') {
            const modifierId = numericIds.get(attachment.modifier);
            if (modifierId !== undefined) properties.asset_modifier_id = modifierId;
        }
        if (attachment.modifier === node.id && attachment.type === 'modulator') {
            const ownerId = numericIds.get(attachment.owner);
            if (ownerId !== undefined) properties.parentId = ownerId;
        }
    }

    if (node.type === 'disabled') properties.disabled = true;
    if (node.type === 'asset_filter') {
        properties.modifier_kind = 'asset_filter';
        properties.output_type = properties.output_type || 'asset_path';
        if (properties.selected_items === undefined) properties.selected_items = [];
        if (properties.refresh_mode === undefined) properties.refresh_mode = 'parent';
        if (properties.playbackMode === undefined) properties.playbackMode = 'Random';
    }
    return properties;
}

/** Convert a validated canonical document into the editor's LiteGraph shape. */
export function graphDocumentToWorkspacePreset(
    document: GraphDocument,
    savedAt = new Date().toISOString()
): LiteGraphWorkspacePreset {
    const validation = validateGraphDocument(document);
    if (!validation.valid) throw new Error(`Invalid graph document: ${validation.errors.join(' ')}`);

    const numericIds = new Map<string, number>();
    document.nodes.forEach((node, index) => numericIds.set(node.id, index + 1));
    const attachments = document.attachments || [];

    const incomingCounts = new Map<string, number>();
    const targetSlots = new Map<number, number>();
    const outgoingLinks = new Map<number, number[]>();
    document.connections.forEach((connection, index) => {
        const targetId = numericIds.get(connection.to);
        const sourceId = numericIds.get(connection.from);
        if (targetId === undefined || sourceId === undefined) return;
        const targetSlot = incomingCounts.get(connection.to) || 0;
        incomingCounts.set(connection.to, targetSlot + 1);
        targetSlots.set(index, targetSlot);
        const links = outgoingLinks.get(sourceId) || [];
        links.push(index + 1);
        outgoingLinks.set(sourceId, links);
    });

    const nodes = document.nodes.map((node, index) => {
        const numericId = numericIds.get(node.id) as number;
        const incomingCount = incomingCounts.get(node.id) || 0;
        const inputs = !['track', 'sequence', 'arrangement'].includes(node.type)
            ? []
            : Array.from({ length: Math.max(1, incomingCount + 1) }, () => ({
                name: 'Input',
                type: 'audio',
                link: null as number | null
            })).map((input, slot) => {
                const connectionIndex = document.connections.findIndex((connection, connectionPosition) =>
                    connection.to === node.id && targetSlots.get(connectionPosition) === slot
                );
                return connectionIndex >= 0
                    ? { ...input, link: connectionIndex + 1 }
                    : input;
            });
        const links = outgoingLinks.get(numericId) || null;
        const position = node.position || [index * 260, 180];
        const outputs = ['track', 'sample', 'sequence', 'arrangement'].includes(node.type)
            ? [{ name: 'Audio', type: 'audio', links, slot_index: 0 }]
            : [];
        return {
            id: numericId,
            type: LITE_GRAPH_NODE_TYPES[node.type],
            pos: position,
            size: [44, 44],
            flags: { collapsed: false, hidden: false },
            order: index,
            mode: 0,
            inputs,
            outputs,
            title: node.name || DEFAULT_NODE_NAMES[node.type],
            properties: propertiesForLiteGraphNode(node, numericIds, attachments)
        } satisfies Record<string, unknown>;
    });

    const links = document.connections.map((connection, index) => [
        index + 1,
        numericIds.get(connection.from) as number,
        0,
        numericIds.get(connection.to) as number,
        targetSlots.get(index) as number,
        connection.type
    ] as [number, number, number, number, number, GraphConnectionType]);
    const outputId = numericIds.get(document.output) as number;

    return {
        version: 2,
        savedAt,
        graph: {
            last_node_id: document.nodes.length,
            last_link_id: document.connections.length,
            nodes,
            links,
            groups: [],
            config: { links_ontop: true },
            extra: {
                global_parameters: { ...document.settings },
                main_preview: { node_id: outputId, mode: 'auto' }
            },
            version: 0.4
        }
    };
}
