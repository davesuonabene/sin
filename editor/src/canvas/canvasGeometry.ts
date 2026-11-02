import { BaseNode, isModifierNode } from '../nodes/BaseNode.ts';

export const LEFT_PORT_BRANCH_INPUT = '__sinLeftPortBranchInput';

export function markLeftPortBranch(link: any, sourceNode: any, inputSlot: number) {
    if (!link || !sourceNode) return;
    link[LEFT_PORT_BRANCH_INPUT] = inputSlot;
    link.__sinLeftPortBranchOwnerId = sourceNode.id;
    sourceNode.properties = sourceNode.properties || {};
    const branches = sourceNode.properties.left_port_branch_links || {};
    branches[String(link.id)] = inputSlot;
    sourceNode.properties.left_port_branch_links = branches;
}

export function getLinkEndpoints(
    graph: any,
    link: any,
    fallbackOrigin: [number, number],
    fallbackTarget: [number, number]
) {
    const originNode = link ? graph?.getNodeById?.(link.origin_id) : null;
    const targetNode = link ? graph?.getNodeById?.(link.target_id) : null;
    const branchOwner = graph?.getNodeById?.(link?.__sinLeftPortBranchOwnerId)
        || [originNode, targetNode].find((node: any) =>
            Number.isInteger(node?.properties?.left_port_branch_links?.[String(link?.id)])
        );
    const inputSlot = link?.[LEFT_PORT_BRANCH_INPUT]
        ?? branchOwner?.properties?.left_port_branch_links?.[String(link?.id)];

    if (branchOwner && Number.isInteger(inputSlot)) {
        const childNode = branchOwner.id === originNode?.id ? targetNode : originNode;
        if (childNode) {
            return {
                origin: branchOwner.getConnectionPos(true, inputSlot),
                target: childNode.getConnectionPos(false, childNode.id === originNode?.id ? link.origin_slot : 0)
            };
        }
    }
    return { origin: fallbackOrigin, target: fallbackTarget };
}

export function getDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function getLinkControlPoints(
    origin: [number, number] | Float32Array,
    target: [number, number] | Float32Array
): { cp1: [number, number]; cp2: [number, number] } {
    const dx = Math.abs(target[0] - origin[0]);
    const dy = Math.abs(target[1] - origin[1]);
    const offset = Math.max(24, Math.min(130, dx * 0.42 + dy * 0.12));
    return {
        cp1: [origin[0] + offset, origin[1]],
        cp2: [target[0] - offset, target[1]]
    };
}

export function getDistanceToCubicBezier(
    px: number,
    py: number,
    p0: [number, number] | Float32Array,
    cp1: [number, number],
    cp2: [number, number],
    p3: [number, number] | Float32Array
): number {
    const steps = 16;
    let minDist = Infinity;
    let prevX = p0[0];
    let prevY = p0[1];
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * cp1[0] + 3 * mt * t * t * cp2[0] + t * t * t * p3[0];
        const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * cp1[1] + 3 * mt * t * t * cp2[1] + t * t * t * p3[1];
        const d = getDistanceToSegment(px, py, prevX, prevY, x, y);
        if (d < minDist) minDist = d;
        prevX = x;
        prevY = y;
    }
    return minDist;
}

export function updateModifiersForParent(parentNode: any): void {
    if (!parentNode || !parentNode.graph) return;
    const allNodes: any[] = (parentNode.graph as any)._nodes || [];
    const modifiers = allNodes.filter(n =>
        n && isModifierNode(n) && n.properties?.parentId === parentNode.id
    );
    if (!modifiers.length) return;

    const parentWidth = parentNode.size?.[0] || BaseNode.visualSize || 44;
    const parentHeight = parentNode.size?.[1] || BaseNode.visualSize || 44;
    const parentCenterX = parentNode.pos[0] + parentWidth * 0.5;
    const parentBottomY = parentNode.pos[1] + parentHeight;

    const spacing = 56;
    const totalWidth = (modifiers.length - 1) * spacing + BaseNode.visualSize;
    const startX = parentCenterX - totalWidth * 0.5;
    const targetY = parentBottomY + 32;

    modifiers.forEach((mod, index) => {
        const targetX = startX + index * spacing;
        if (!mod.pos) {
            mod.pos = [targetX, targetY];
        } else {
            mod.pos[0] = targetX;
            mod.pos[1] = targetY;
        }
    });
}

export function syncAllModifierPositions(graph?: any): void {
    const targetGraph = graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
    if (!targetGraph || !targetGraph._nodes) return;
    for (const node of targetGraph._nodes) {
        if (node && !isModifierNode(node)) {
            updateModifiersForParent(node);
        }
    }
}

export function syncNodesDistanceStage(graph: any, scale: number): boolean {
    const nodes = graph?._nodes;
    if (!Array.isArray(nodes)) return false;
    let anyStageChanged = false;
    for (const node of nodes) {
        if (node && typeof node.syncDistanceStage === 'function') {
            if (node.syncDistanceStage(scale)) {
                anyStageChanged = true;
            }
        }
    }
    if (anyStageChanged) {
        syncAllModifierPositions(graph);
    }
    return anyStageChanged;
}

export function frameCanvasSelectionOrGraph(canvasInstance: any): void {
    const graph = canvasInstance?.graph;
    const ds = canvasInstance?.ds;
    const htmlCanvas = canvasInstance?.canvas;
    if (!graph || !ds || !htmlCanvas) return;

    const selectedMap = canvasInstance.selected_nodes || {};
    const selectedNodes = Object.values(selectedMap).filter((n: any) => n && !(n.flags as any)?.hidden) as any[];
    const allNodes = (((graph as any)._nodes || []) as any[]).filter((n: any) => n && !(n.flags as any)?.hidden);
    const targetNodes = selectedNodes.length > 0 ? selectedNodes : allNodes;
    if (targetNodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of targetNodes) {
        const w = n.size?.[0] || 44;
        const h = n.size?.[1] || 44;
        minX = Math.min(minX, n.pos[0]);
        minY = Math.min(minY, n.pos[1]);
        maxX = Math.max(maxX, n.pos[0] + w);
        maxY = Math.max(maxY, n.pos[1] + h);
    }

    const viewW = htmlCanvas.clientWidth || htmlCanvas.width || 800;
    const viewH = htmlCanvas.clientHeight || htmlCanvas.height || 600;
    const boundsW = Math.max(80, maxX - minX);
    const boundsH = Math.max(80, maxY - minY);
    const centerX = minX + boundsW * 0.5;
    const centerY = minY + boundsH * 0.5;

    let targetScale = 1.0;
    if (selectedNodes.length === 0) {
        const pad = 120;
        const scaleX = (viewW - pad) / boundsW;
        const scaleY = (viewH - pad) / boundsH;
        targetScale = Math.max(0.25, Math.min(1.0, Math.min(scaleX, scaleY)));
    }

    ds.scale = targetScale;
    ds.offset[0] = (viewW * 0.5) / targetScale - centerX;
    ds.offset[1] = (viewH * 0.5) / targetScale - centerY;
    syncNodesDistanceStage(graph, targetScale);
    canvasInstance.setDirty(true, true);
}

