/**
 * ERMES Dynamic Asset Resolver & Seed Management Engine
 * Manages asset filter pool resolution, seed advancement, and library metadata syncing.
 */

export function parseBpmFromFilename(filename: string): number | null {
    const match = filename.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i) || filename.match(/(\d{2,3}(?:\.\d+)?)[_\s-]+bpm/i);
    if (match) return parseFloat(match[1]);
    const numMatches = filename.match(/(?:^|[_\s-])(\d{2,3})(?=[._\s-]|$)/g);
    if (numMatches) {
        for (let i = numMatches.length - 1; i >= 0; i--) {
            const val = parseFloat(numMatches[i].replace(/^[_\s-]/, ''));
            if (val >= 60 && val <= 220) return val;
        }
    }
    return null;
}

export function advanceAssetPoolSeed(modifierNode: any, trackNodesMap?: Map<number, any>) {
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    if (modifierNode?.properties?.playbackMode === 'Sequential') {
        const length = Math.max(1, modifierNode.properties.selected_items?.length || 0);
        const storedIndex = Number(modifierNode.properties.sequence_index);
        const currentIndex = Number.isFinite(storedIndex) ? storedIndex : -1;
        const nextIndex = (currentIndex + 1) % length;
        modifierNode.properties.sequence_index = nextIndex;
        modifierNode.properties.seed = nextIndex;
    } else {
        modifierNode.properties.seed = Math.random();
    }
    const modifierData = trackNodes?.get(modifierNode.id);
    if (modifierData) modifierData.seed = modifierNode.properties.seed;
}

export type AssetRefreshMode = 'local' | 'parent' | 'ancestor' | 'global' | 'off';

export interface AssetResolutionRequest {
    kind: 'preview' | 'render';
    globalPreview?: boolean;
    globalFreeze?: boolean;
    libraryFiles?: any[];
}

export function normalizeAssetRefreshMode(value: unknown): AssetRefreshMode {
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

export function shouldRefreshAssetPool(
    modeValue: unknown,
    ownerNodeId: number,
    requestedNodeId: number,
    trackNodes: Map<number, any> | undefined,
    request: AssetResolutionRequest
): boolean {
    const mode = normalizeAssetRefreshMode(modeValue);
    if (mode === 'off') return false;
    if (mode === 'global') return request.kind === 'preview' && Boolean(request.globalPreview);
    if (mode === 'local') return true;
    if (request.kind !== 'preview' || request.globalPreview) return false;
    if (mode === 'parent') return trackNodes?.get(ownerNodeId)?.parentId === requestedNodeId;
    return topAncestorId(ownerNodeId, trackNodes) === requestedNodeId;
}

function poolItemLocator(item: any): any {
    if (item?.id != null && String(item.id).trim()) return { id: item.id };
    throw new Error('Asset Pool item is missing its GAIA id');
}

function notifyResolvedProperties(node: any): void {
    if (node?.id == null || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
        detail: { nodeId: node.id }
    }));
}

function notifyArrangementSourceChanged(ownerNode: any): void {
    if (ownerNode?.id == null || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
        detail: { nodeId: ownerNode.id }
    }));
}

export async function resolveAssetFilterNode(
    modifierNode: any,
    ownerNode?: any,
    preferDifferent: boolean = false,
    lockedLocator?: any,
    resolvedLibraryFiles?: any[]
): Promise<string> {
    if (!modifierNode?.properties || modifierNode.properties.output_type !== 'asset_path') return '';
    const log = typeof window !== 'undefined' ? (window as any).runtimeLog as ((message: string, level?: string) => void) | undefined : undefined;
    const resolutionStartedAt = Date.now();
    const poolName = modifierNode.properties.node_name || modifierNode.title || `Pool ${modifierNode.id ?? ''}`;
    log?.(`Resolving ${poolName}`, 'debug');
    const previousPath = modifierNode.properties.output_value || '';
    const acceptedType = modifierNode.properties.accepted_asset_type;
    const fetchLibrary = typeof window !== 'undefined' ? (window as any).fetchLibrary : undefined;
    const findLibraryFileById = typeof window !== 'undefined' ? (window as any).findLibraryFileById : undefined;
    const findLibraryFile = typeof window !== 'undefined' ? (window as any).findLibraryFile : undefined;
    const findLibraryFileForPoolLocator = typeof window !== 'undefined' ? (window as any).findLibraryFileForPoolLocator : undefined;
    const resolveLibraryAssets = typeof window !== 'undefined' ? (window as any).resolveLibraryAssets : undefined;
    const libraryFiles = resolvedLibraryFiles || (
        typeof resolveLibraryAssets === 'function'
            ? await resolveLibraryAssets(modifierNode.properties.selected_items || [])
            : typeof fetchLibrary === 'function' ? await fetchLibrary(false, true) : []
    );
    for (const item of modifierNode.properties.selected_items || []) {
        if (item?.id == null || !String(item.id).trim()) {
            throw new Error('Asset Pool item is missing its GAIA id');
        }
        const path = item.absolute_path || item.filepath || '';
        const latest = (typeof findLibraryFileForPoolLocator === 'function'
            ? findLibraryFileForPoolLocator(libraryFiles, item)
            : null)
            || (item.id == null && typeof findLibraryFile === 'function' && path
                ? findLibraryFile(libraryFiles, path)
                : null);
        if (!latest) {
            throw new Error(`Asset Pool asset is unavailable: ${item?.id ?? item?.name ?? 'unknown asset'}`);
        }
        item.id = latest.id ?? item.id;
        item.absolute_path = latest.absolute_path || path;
        item.filepath = latest.absolute_path || path;
        item.name = latest.name || item.name;
        item.type = latest.type || item.type;
        item.key = latest.key ?? null;
        item.bpm = latest.bpm ?? null;
        item.original_bpm = latest.bpm ?? null;
        item.duration_seconds = latest.duration_seconds ?? null;
        item.collection_id = latest.collection_id ?? item.collection_id;
    }
    const selectedItems = (modifierNode.properties.selected_items || []).filter((item: any) => {
        if (!(item.absolute_path || item.filepath)) return false;
        if (!acceptedType) return true;
        const path = String(item.absolute_path || item.filepath || item.name || '').toLowerCase();
        const isMidi = item.type === 'midi' || item.itemType === 'midi' || path.endsWith('.mid') || path.endsWith('.midi');
        const isSequence = item.type === 'sequence' || item.itemType === 'sequence' || path.endsWith('.seq');
        if (acceptedType === 'midi') return isMidi;
        if (acceptedType === 'sequence_source') return isMidi || isSequence;
        return !isMidi && !isSequence;
    });
    let requestItems = selectedItems;
    if (lockedLocator) {
        const lockedId = lockedLocator?.id;
        if (lockedId == null || !String(lockedId).trim()) {
            throw new Error('Locked pool asset is missing its GAIA id');
        }
        const lockedItem = selectedItems.find((item: any) => {
            return String(item.id) === String(lockedId);
        });
        if (!lockedItem) {
            throw new Error(`Locked pool asset is unavailable: ${lockedId}`);
        }
        requestItems = [lockedItem];
    }
    const response = await fetch('/api/pool/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            selected_items: requestItems,
            seed: modifierNode.properties.seed || 0,
            playbackMode: modifierNode.properties.playbackMode || 'Random',
            items_resolved: true,
            previous_sample: previousPath || null,
            prefer_different: preferDifferent
        })
    });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.detail || `Unable to resolve Asset Filter (${response.status})`);
    }
    const diagnostics = result?.diagnostics;
    if (diagnostics) {
        log?.(
            `Pool request: ${diagnostics.item_count ?? requestItems.length} items, ${diagnostics.metadata_queries ?? 0} metadata queries (${diagnostics.duration_ms ?? '?'} ms)`,
            'debug'
        );
    }
    const assetPath = typeof result?.sample === 'string' ? result.sample : '';
    modifierNode.properties.output_value = assetPath;

    const selectedItem = (modifierNode.properties.selected_items || []).find((item: any) =>
        (item.absolute_path || item.filepath) === assetPath
    );
    const resolvedPoolItem = result?.item || selectedItem;
    const libraryItem = (typeof findLibraryFile === 'function' ? findLibraryFile(libraryFiles, assetPath) : null)
        || (resolvedPoolItem?.id != null && typeof findLibraryFileById === 'function'
            ? findLibraryFileById(libraryFiles, resolvedPoolItem?.id)
            : null);

    let resolvedBpm: number | null = libraryItem?.bpm ?? result?.bpm ?? selectedItem?.bpm ?? selectedItem?.original_bpm ?? null;
    if (resolvedBpm == null && assetPath) {
        resolvedBpm = parseBpmFromFilename(assetPath);
    }

    if (resolvedBpm != null) {
        if (selectedItem) {
            selectedItem.bpm = resolvedBpm;
            selectedItem.original_bpm = resolvedBpm;
        }
        modifierNode.properties.output_bpm = resolvedBpm;
    }
    const resolvedKey = String(libraryItem?.key ?? result?.key ?? resolvedPoolItem?.key ?? selectedItem?.key ?? '').trim();
    modifierNode.properties.output_key = resolvedKey;
    if (selectedItem) selectedItem.key = resolvedKey;
    const libraryItemId = libraryItem?.id ?? resolvedPoolItem?.id ?? selectedItem?.id;
    if (libraryItemId != null) modifierNode.properties.output_item_id = libraryItemId;
    if (normalizeAssetRefreshMode(modifierNode.properties.refresh_mode) === 'off' && resolvedPoolItem) {
        modifierNode.properties.fixed_item = poolItemLocator(resolvedPoolItem);
    }

    if (ownerNode?.properties) {
        const isSeq = ownerNode.type === 'Audio/Sequence'
            || ownerNode.type === 'sequence'
            || ownerNode.type === 'Sequence'
            || ownerNode.properties?.node_type === 'sequence';
        if (isSeq && assetPath) {
            const applySequence = typeof window !== 'undefined' ? (window as any).applyLibraryItemToSequence : undefined;
            if (typeof applySequence === 'function') {
                await applySequence(ownerNode, {
                    id: libraryItemId,
                    filepath: assetPath,
                    itemType: libraryItem?.type || selectedItem?.type || (assetPath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi'),
                    name: selectedItem?.name || assetPath.split(/[\\/]/).pop(),
                    bpm: selectedItem?.bpm || null,
                    key: resolvedKey || null
                });
            }
        } else {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty('filepath', assetPath);
                if (libraryItemId != null) ownerNode.updateProperty('library_item_id', libraryItemId);
                if (resolvedBpm != null) ownerNode.updateProperty('original_bpm', resolvedBpm);
                ownerNode.updateProperty('key', resolvedKey);
            } else {
                ownerNode.properties.filepath = assetPath;
                if (libraryItemId != null) ownerNode.properties.library_item_id = libraryItemId;
                if (resolvedBpm != null) ownerNode.properties.original_bpm = resolvedBpm;
                ownerNode.properties.key = resolvedKey;
            }
        }
    }
    notifyResolvedProperties(modifierNode);
    notifyResolvedProperties(ownerNode);
    notifyArrangementSourceChanged(ownerNode);
    log?.(`Resolved ${poolName} (${Date.now() - resolutionStartedAt} ms)`, 'common');
    return assetPath;
}

export async function resolveAssignedAssetFilters(
    graph: any,
    rootNodeId: number,
    request: AssetResolutionRequest = { kind: 'preview' },
    trackNodesMap?: Map<number, any>
) {
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    const visited = new Set<number>();
    const visit = async (nodeId: number) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const node = graph.getNodeById(nodeId);
        const data = trackNodes?.get(nodeId);
        let modifierId = node?.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        let modifier = modifierId != null ? graph.getNodeById(modifierId) : null;

        // Defensive check: ensure modifier is actually an asset filter.
        // If missing or pointing to another modifier kind (e.g. random), resolve via parentId attachment.
        const isAssetFilter = (m: any) => m && (
            m.type === 'Audio/AssetFilter' ||
            m.properties?.node_type === 'asset_filter' ||
            m.properties?.output_type === 'asset_path'
        );

        if (!isAssetFilter(modifier)) {
            const allNodes = ((graph as any)._nodes || (graph as any).nodes || []) as any[];
            const candidate = allNodes.find((c: any) =>
                isAssetFilter(c) && (
                    c.properties?.parentId === nodeId ||
                    trackNodes?.get(c.id)?.parentId === nodeId
                )
            );
            if (candidate) {
                modifier = candidate;
                modifierId = candidate.id;
                if (node?.properties) node.properties.asset_modifier_id = candidate.id;
                if (data) data.asset_modifier_id = candidate.id;
            } else {
                modifier = null;
            }
        }

        if (modifier) {
                const refreshMode = normalizeAssetRefreshMode(modifier.properties?.refresh_mode);
                modifier.properties.refresh_mode = refreshMode;
                const hasResolvedAsset = Boolean(modifier.properties?.output_value);
                const lockedLocator = refreshMode === 'off' ? modifier.properties?.fixed_item : null;
                const isFrozen = Boolean(request.globalFreeze) && (
                    node?.properties
                        ? node.properties.freeze_refresh !== false
                        : modifier?.properties?.freeze_refresh !== false
                );
                const shouldRefresh = !isFrozen && shouldRefreshAssetPool(
                    refreshMode,
                    nodeId,
                    rootNodeId,
                    trackNodes,
                    request
                );
                if (shouldRefresh) advanceAssetPoolSeed(modifier, trackNodes);
                if (shouldRefresh || !hasResolvedAsset) {
                    await resolveAssetFilterNode(
                        modifier,
                        node,
                        shouldRefresh,
                        lockedLocator,
                        request.libraryFiles
                    );
                } else if (node?.properties) {
                    const sampleNode = node as any;
                    const assetPath = modifier.properties.output_value || sampleNode.properties?.filepath;
                    if (assetPath && !modifier.properties.output_value) {
                        modifier.properties.output_value = assetPath;
                    }
                    const selectedItem = (modifier.properties.selected_items || []).find((item: any) =>
                        (item.absolute_path || item.filepath) === assetPath
                    );
                    const preferredId = modifier.properties.output_item_id ?? sampleNode.properties?.library_item_id ?? selectedItem?.id;
                    if (preferredId != null && modifier.properties.output_item_id == null) {
                        modifier.properties.output_item_id = preferredId;
                    }
                    if (assetPath && sampleNode.properties.filepath !== assetPath) {
                        sampleNode.updateProperty?.('filepath', assetPath);
                    }
                    if (preferredId != null && sampleNode.properties.library_item_id !== preferredId) {
                        sampleNode.updateProperty?.('library_item_id', preferredId);
                    }
                    // When frozen, preserve the node's current BPM and key settings (never overwrite manual edits)
                    if (sampleNode.properties.original_bpm == null && modifier.properties.output_bpm != null) {
                        sampleNode.updateProperty?.('original_bpm', modifier.properties.output_bpm);
                    } else if (sampleNode.properties.original_bpm != null) {
                        modifier.properties.output_bpm = sampleNode.properties.original_bpm;
                        if (selectedItem) {
                            selectedItem.bpm = sampleNode.properties.original_bpm;
                            selectedItem.original_bpm = sampleNode.properties.original_bpm;
                        }
                    }
                    if (!sampleNode.properties.key && modifier.properties.output_key) {
                        sampleNode.updateProperty?.('key', modifier.properties.output_key);
                    } else if (sampleNode.properties.key) {
                        modifier.properties.output_key = sampleNode.properties.key;
                        if (selectedItem) selectedItem.key = sampleNode.properties.key;
                    }
                    notifyResolvedProperties(modifier);
                    notifyResolvedProperties(node);
                    notifyArrangementSourceChanged(node);
                }
            }
        const adjacentIds: number[] = [...(data?.children || [])];
        for (const input of node?.inputs || []) {
            const link = input.link != null ? (graph as any).links?.[input.link] : null;
            if (link?.origin_id != null && !adjacentIds.includes(link.origin_id)) adjacentIds.push(link.origin_id);
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
