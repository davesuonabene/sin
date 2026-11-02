export const SIGNAL_STEM_PALETTE = [
    '#059669', // Emerald
    '#0284c7', // Sky Blue
    '#7c3aed', // Electric Violet
    '#ea580c', // Coral
    '#db2777', // Rose Pink
    '#d97706', // Golden Amber
    '#0891b2', // Cyan
    '#4f46e5', // Indigo
    '#65a30d', // Lime
    '#c026d3', // Fuchsia
];

export function applySignalFlowColors(graphOrData: any): void {
    if (!graphOrData) return;

    const isLiveGraph = typeof graphOrData.getNodeById === 'function';
    const nodes: any[] = isLiveGraph
        ? ((graphOrData as any)._nodes || [])
        : (graphOrData.nodes || []);
    const rawLinks: any = graphOrData.links || (isLiveGraph ? {} : []);

    const nodeMap = new Map<number, any>();
    for (const n of nodes) {
        if (n && n.id != null) nodeMap.set(n.id, n);
    }

    const outLinks = new Map<number, any[]>();
    const inLinks = new Map<number, any[]>();
    for (const n of nodes) {
        if (n && n.id != null) {
            outLinks.set(n.id, []);
            inLinks.set(n.id, []);
        }
    }

    const isArrayLinks = Array.isArray(rawLinks);
    if (isArrayLinks) {
        for (const l of rawLinks) {
            if (!l) continue;
            const originId = l[1];
            const targetId = l[3];
            if (outLinks.has(originId)) outLinks.get(originId)!.push(l);
            if (inLinks.has(targetId)) inLinks.get(targetId)!.push(l);
        }
    } else {
        for (const linkId in rawLinks) {
            const l = rawLinks[linkId];
            if (!l) continue;
            const originId = l.origin_id;
            const targetId = l.target_id;
            if (outLinks.has(originId)) outLinks.get(originId)!.push(l);
            if (inLinks.has(targetId)) inLinks.get(targetId)!.push(l);
        }
    }

    const modifiersByParent = new Map<number, any[]>();
    for (const n of nodes) {
        if (!n) continue;
        const parentId = n.properties?.parentId ?? n.parentId;
        if (parentId != null) {
            if (!modifiersByParent.has(parentId)) modifiersByParent.set(parentId, []);
            modifiersByParent.get(parentId)!.push(n);
        }
    }

    function setNodeColor(node: any, color: string, boxcolor?: string) {
        if (!node) return;
        if (node.properties?.disabled || node.type === 'Audio/Disabled') return;
        node.color = color;
        node.bgcolor = color;
        node.boxcolor = boxcolor || color;
        if (!node.properties) node.properties = {};
        node.properties.color = color;
        if (typeof node.setDirtyCanvas === 'function') {
            node.setDirtyCanvas(true, true);
        }
    }

    function setLinkColor(link: any, color: string) {
        if (!link) return;
        if (Array.isArray(link)) {
            link[6] = color;
        } else {
            link.color = color;
        }
    }

    // 1. Identify sample root sources
    const sampleNodes = nodes.filter(n => n && (n.type === 'Audio/Sample' || n.properties?.node_type === 'sample'));
    // Sort top-to-bottom spatially if pos is available, else by id
    sampleNodes.sort((a, b) => {
        const ya = a.pos ? a.pos[1] : a.id;
        const yb = b.pos ? b.pos[1] : b.id;
        return ya - yb;
    });

    sampleNodes.forEach((sample, idx) => {
        // If sample has an explicitly assigned color (from user change or existing properties.color), preserve it!
        // The resolver only assigns initial palette colors on creation / when missing.
        const existingColor = sample.properties?.color;
        const hasUserColor = Boolean(sample.properties?.user_color);
        const hasExistingColor = hasUserColor || Boolean(existingColor && existingColor !== '#10b981');
        const stemColor = hasExistingColor
            ? existingColor
            : (existingColor || SIGNAL_STEM_PALETTE[idx % SIGNAL_STEM_PALETTE.length]);

        if (!existingColor || sample.color !== stemColor) {
            setNodeColor(sample, stemColor);
        } else {
            sample.color = stemColor;
            sample.bgcolor = stemColor;
            sample.boxcolor = sample.boxcolor || stemColor;
        }

        // Follow route forward along cables
        const queue = [sample.id];
        const visited = new Set<number>([sample.id]);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            const outgoing = outLinks.get(currentId) || [];

            for (const link of outgoing) {
                setLinkColor(link, stemColor);
                const targetId = isArrayLinks ? link[3] : link.target_id;
                const target = nodeMap.get(targetId);
                if (!target) continue;

                const isProcessor = target.type === 'Audio/Sequence' || target.type === 'Audio/Arrangement';
                if (isProcessor) {
                    if (!target.properties?.user_color) {
                        setNodeColor(target, stemColor);
                    } else {
                        const targetColor = target.properties?.color || target.color;
                        target.color = targetColor;
                        target.bgcolor = targetColor;
                    }

                    // Color attached modifiers
                    const mods = modifiersByParent.get(target.id) || [];
                    for (const m of mods) {
                        if (!m.properties?.user_color) {
                            setNodeColor(m, target.properties?.color || stemColor);
                        }
                    }

                    if (!visited.has(target.id)) {
                        visited.add(target.id);
                        queue.push(target.id);
                    }
                } else if (target.type === 'Audio/Track') {
                    // Cable to track carries stemColor into the bus
                }
            }
        }
    });

    // 2. Track nodes (Buses and Master)
    const trackNodes = nodes.filter(n => n && (n.type === 'Audio/Track' || n.properties?.node_type === 'track'));
    for (const t of trackNodes) {
        const outs = outLinks.get(t.id) || [];
        const isMaster = outs.length === 0 || t.properties?.role === 'master' || t.properties?.is_main_preview;
        if (isMaster) {
            if (!t.properties?.user_color) {
                setNodeColor(t, '#0f172a', '#f59e0b');
            } else {
                setNodeColor(t, t.properties.color, t.boxcolor || '#f59e0b');
            }
        } else {
            const busColor = t.properties?.color || '#4f46e5';
            if (!t.properties?.user_color) {
                setNodeColor(t, '#4f46e5', '#4338ca');
            } else {
                setNodeColor(t, busColor, t.boxcolor || busColor);
            }
            for (const l of outs) {
                setLinkColor(l, t.color || busColor);
            }
        }
    }

    if (isLiveGraph && typeof (graphOrData as any).setDirtyCanvas === 'function') {
        (graphOrData as any).setDirtyCanvas(true, true);
    }
}
