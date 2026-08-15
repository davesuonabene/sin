import { LiteGraph, type LGraph, type LGraphNode } from 'litegraph.js';
import { attachGhostProperties, ghostMetadataFields, snapshotNodeProperties } from './ghosts';

const CLIPBOARD_KEY = 'litegrapheditor_clipboard';
const CLIPBOARD_FORMAT = 'sin-node-clipboard-v1';

interface ClipboardLink {
    origin: number;
    originSlot: number;
    target: number;
    targetSlot: number;
}

interface ClipboardNode {
    originalId: number;
    data: Record<string, any>;
}

interface NodeClipboardSnapshot {
    format: typeof CLIPBOARD_FORMAT;
    nodes: ClipboardNode[];
    links: ClipboardLink[];
}

function clonePlain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function clearSerializedLinks(data: Record<string, any>) {
    if (Array.isArray(data.inputs)) {
        for (const input of data.inputs) input.link = null;
    }
    if (Array.isArray(data.outputs)) {
        for (const output of data.outputs) output.links = null;
    }
}

export function createNodeClipboardSnapshot(canvas: any): NodeClipboardSnapshot | null {
    const graph = canvas?.graph as LGraph | undefined;
    if (!graph) return null;

    const selected: LGraphNode[] = Object.values(canvas.selected_nodes || {})
        .filter((node: any): node is LGraphNode => Boolean(node) && (node as any).clonable !== false);
    if (selected.length === 0) return null;

    const indexes = new Map<any, number>();
    selected.forEach((node, index) => indexes.set((node as any).id, index));

    const nodes: ClipboardNode[] = selected.map((node: any) => {
        const data = clonePlain(node.serialize());
        data.properties = snapshotNodeProperties(node);
        clearSerializedLinks(data);
        return { originalId: node.id, data };
    });

    const links: ClipboardLink[] = [];
    for (const link of Object.values((graph as any).links || {}) as any[]) {
        if (!link) continue;
        const origin = indexes.get(link.origin_id);
        const target = indexes.get(link.target_id);
        // A copied object is a closed subgraph: only links whose two endpoints
        // are selected belong to the copy.
        if (origin == null || target == null) continue;
        links.push({ origin, originSlot: link.origin_slot, target, targetSlot: link.target_slot });
    }

    return { format: CLIPBOARD_FORMAT, nodes, links };
}

function remapRelationship(properties: Record<string, any>, key: string, idMap: Map<number, number>) {
    const oldId = properties[key];
    if (oldId == null) return;
    const newId = idMap.get(Number(oldId));
    if (newId != null) properties[key] = newId;
    else delete properties[key];
}

function remapPastedProperties(properties: Record<string, any>, idMap: Map<number, number>) {
    const oldGhostSource = properties.ghost_source_id;
    if (oldGhostSource != null && idMap.has(Number(oldGhostSource))) {
        properties.ghost_source_id = idMap.get(Number(oldGhostSource));
        delete properties.ghost_detached_source_id;
    } else {
        // A ghost pasted without its source becomes a standalone copy. Its
        // effective field values were captured when the selection was copied.
        for (const field of ghostMetadataFields) delete properties[field];
    }

    remapRelationship(properties, 'parentId', idMap);
    remapRelationship(properties, 'asset_modifier_id', idMap);
    remapRelationship(properties, 'length_source_id', idMap);
    if (properties.length_source_id == null) delete properties.length_inherited;
}

export function pasteNodeClipboardSnapshot(canvas: any, snapshot: NodeClipboardSnapshot): LGraphNode[] {
    const graph = canvas?.graph as LGraph | undefined;
    if (!graph || snapshot?.format !== CLIPBOARD_FORMAT || !Array.isArray(snapshot.nodes)) return [];

    const positions = snapshot.nodes.map(entry => entry.data?.pos).filter(Array.isArray);
    const minX = positions.length ? Math.min(...positions.map(pos => Number(pos[0]) || 0)) : 0;
    const minY = positions.length ? Math.min(...positions.map(pos => Number(pos[1]) || 0)) : 0;
    const mouseX = Number(canvas.graph_mouse?.[0]);
    const mouseY = Number(canvas.graph_mouse?.[1]);
    const offsetX = Number.isFinite(mouseX) ? mouseX - minX : 32;
    const offsetY = Number.isFinite(mouseY) ? mouseY - minY : 32;

    graph.beforeChange?.();
    const pasted: LGraphNode[] = [];
    const idMap = new Map<number, number>();
    try {
        for (const entry of snapshot.nodes) {
            const data = clonePlain(entry.data);
            delete data.id;
            clearSerializedLinks(data);
            const node: any = LiteGraph.createNode(data.type);
            if (!node) continue;
            node.configure(data);
            node.pos = [Number(data.pos?.[0] || 0) + offsetX, Number(data.pos?.[1] || 0) + offsetY];
            graph.add(node, { doProcessChange: false } as any);
            pasted.push(node);
            idMap.set(Number(entry.originalId), node.id);
        }

        for (const node of pasted as any[]) {
            remapPastedProperties(node.properties || (node.properties = {}), idMap);
            attachGhostProperties(node, graph);
        }

        for (const link of snapshot.links || []) {
            const origin: any = pasted[link.origin];
            const target: any = pasted[link.target];
            if (origin && target) origin.connect(link.originSlot, target, link.targetSlot);
        }

        canvas.selectNodes?.(pasted);
        canvas.setDirty?.(true, true);
        return pasted;
    } finally {
        graph.afterChange?.();
    }
}

export function installSeparatedNodeClipboard(onPaste: (nodes: LGraphNode[]) => void) {
    const prototype = (LiteGraph as any).LGraphCanvas.prototype;

    prototype.copyToClipboard = function () {
        const snapshot = createNodeClipboardSnapshot(this);
        if (snapshot) localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(snapshot));
    };

    prototype.pasteFromClipboard = function (isConnectUnselected = false) {
        if (isConnectUnselected) return;
        const raw = localStorage.getItem(CLIPBOARD_KEY);
        if (!raw) return;
        try {
            const pasted = pasteNodeClipboardSnapshot(this, JSON.parse(raw));
            if (pasted.length) onPaste(pasted);
        } catch (error) {
            console.error('Could not paste copied nodes', error);
        }
    };
}
