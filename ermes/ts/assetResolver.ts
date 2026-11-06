/**
 * ERMES Dynamic Asset Resolver & Seed Management Engine
 * Manages asset filter pool resolution, seed advancement, and library metadata syncing.
 */

import {
    type NodeSlot,
    hashSeed,
    isRandomToken,
    isRangeOperatorToken,
    mulberry32,
    resolveModifierSlotSeeds,
    rollSeedExpression,
    tokenizeFieldOperator,
    wrapSlotIndex
} from './slotLanguage.ts';

/**
 * Resolves a single item from an asset pool using a selector query or Field Operator:
 * - List / Cycle Operator ("0 0 0 1", "kick_a kick_b"): selects token at `triggerCount % tokens.length`
 *   (strictly driven by `triggerCount`, independent of `slotSeed`)
 * - Range Operator ("0..2", "rand(0, 2)"): deterministic seeded selection in [min, max]
 * - Random ("rand", "random", or ""): deterministic seeded selection for `slotIndex`
 * - Integer index ("0", "1", ...): modulo-wrapped index into `items`
 * - String (matching asset name): case-insensitive exact, prefix, or substring match against item name / filename
 */
export function resolvePoolItemByQuery(
    items: any[],
    query: unknown,
    slotIndex: number = 0,
    slotSeed: number = 42,
    isSequential: boolean = false,
    triggerCount: number = 0
): any | null {
    if (!Array.isArray(items) || items.length === 0) return null;
    const raw = String(query ?? '').trim();
    const lower = raw.toLowerCase();
    const triggerIdx = Math.max(0, Math.floor(Number(triggerCount) || 0));

    const extractNames = (item: any) => {
        const name = String(item?.name || '').trim().toLowerCase();
        const nameStem = name.replace(/\.[^.]+$/, '');
        const fp = String(item?.filepath || item?.absolute_path || '').trim();
        const base = (fp.split(/[\\/]/).pop() || '').toLowerCase();
        const baseStem = base.replace(/\.[^.]+$/, '');
        return { name, nameStem, base, baseStem, fpLower: fp.toLowerCase() };
    };

    // If raw is an exact match for a single item name (even if it contains spaces), return it directly
    if (raw && !isRandomToken(raw) && !isRangeOperatorToken(raw)) {
        for (const item of items) {
            const { name, nameStem, base, baseStem } = extractNames(item);
            if (name === lower || nameStem === lower || base === lower || baseStem === lower) {
                return item;
            }
        }
    }

    // Multi-token list operator: select token strictly by `triggerCount` (independent of seed)
    const tokens = tokenizeFieldOperator(raw);
    if (tokens.length > 1) {
        const activeToken = tokens[wrapSlotIndex(triggerIdx, tokens.length)];
        return resolvePoolItemByQuery(items, activeToken, slotIndex, slotSeed, isSequential, triggerIdx);
    }

    const rangeSpec = isRangeOperatorToken(raw);
    if (rangeSpec) {
        const loIdx = Math.floor(rangeSpec.min);
        const hiIdx = Math.floor(rangeSpec.max);
        const span = Math.max(1, hiIdx - loIdx + 1);
        const prng = mulberry32(hashSeed(slotSeed, slotIndex + triggerIdx, 0xA55E));
        const chosenIdx = loIdx + Math.floor(prng() * span);
        return items[wrapSlotIndex(chosenIdx, items.length)] || null;
    }

    if (!raw || lower === 'rand' || lower === 'random') {
        if (isSequential) {
            const idx = wrapSlotIndex(slotSeed + slotIndex + triggerIdx, items.length);
            return items[idx] || null;
        }
        const prng = mulberry32(hashSeed(slotSeed, slotIndex + triggerIdx, 0xA55E));
        const idx = Math.floor(prng() * items.length);
        return items[idx] || null;
    }

    if (/^-?\d+$/.test(raw)) {
        const parsedIdx = parseInt(raw, 10);
        const idx = wrapSlotIndex(parsedIdx, items.length);
        return items[idx] || null;
    }

    // 1. Exact match on name, stem, or filename
    for (const item of items) {
        const { name, nameStem, base, baseStem } = extractNames(item);
        if (name === lower || nameStem === lower || base === lower || baseStem === lower) {
            return item;
        }
    }

    // 2. Prefix match on name or filename
    for (const item of items) {
        const { name, base } = extractNames(item);
        if ((name && name.startsWith(lower)) || (base && base.startsWith(lower))) {
            return item;
        }
    }

    // 3. Substring match on name, filename, or path
    for (const item of items) {
        const { name, base, fpLower } = extractNames(item);
        if ((name && name.includes(lower)) || (base && base.includes(lower)) || (fpLower && fpLower.includes(lower))) {
            return item;
        }
    }

    return null;
}

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
    if (modifierNode?.properties?.seed_refresh === false) {
        return;
    }
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined);
    if (modifierNode?.properties) {
        modifierNode.properties.seed_salt = (Number(modifierNode.properties.seed_salt) || 0) + 1;
    }
    if (modifierNode?.properties?.playbackMode === 'Sequential') {
        const length = Math.max(1, modifierNode.properties.selected_items?.length || 0);
        const storedIndex = Number(modifierNode.properties.sequence_index);
        const currentIndex = Number.isFinite(storedIndex) ? storedIndex : -1;
        const nextIndex = (currentIndex + 1) % length;
        modifierNode.properties.sequence_index = nextIndex;
        modifierNode.properties.seed = nextIndex;
    } else if (modifierNode?.properties) {
        modifierNode.properties.seed = rollSeedExpression(modifierNode.properties.seed ?? 42);
    }
    const modifierData = trackNodes?.get(modifierNode.id);
    if (modifierData) {
        modifierData.seed = modifierNode.properties.seed;
        modifierData.seed_salt = modifierNode.properties.seed_salt;
    }
}

/**
 * Deterministically populates `ownerNode.properties.slots[0..S-1]` from an attached AssetFilterNode (Pool).
 */
export function populateOwnerSlotsFromPool(
    modifierNode: any,
    ownerNode: any,
    resolvedSelectedItems?: any[]
): void {
    if (!modifierNode?.properties || !ownerNode?.properties) return;
    const isSeq = ownerNode.type === 'Audio/Sequence'
        || ownerNode.type === 'sequence'
        || ownerNode.type === 'Sequence'
        || ownerNode.properties?.node_type === 'sequence';

    const rawItems = resolvedSelectedItems || modifierNode.properties.selected_items || [];
    const items = rawItems.filter((item: any) => Boolean(item?.absolute_path || item?.filepath));
    if (items.length === 0) return;

    if (!Array.isArray(ownerNode.properties.slots) || ownerNode.properties.slots.length === 0) {
        if (typeof ownerNode.getSlots === 'function') {
            ownerNode.getSlots();
        } else if (isSeq) {
            ownerNode.properties.slots = [{
                slot: 0,
                index: 0,
                pool_query: ownerNode.properties.pool_query,
                filepath: ownerNode.properties.filepath || '',
                library_item_id: ownerNode.properties.library_item_id,
                sequence: Array.isArray(ownerNode.properties.sequence) ? [...ownerNode.properties.sequence] : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
                step_parameters: Array.isArray(ownerNode.properties.step_parameters) ? ownerNode.properties.step_parameters : [],
                sample_slot: String(ownerNode.properties.sample_slot ?? '*'),
                step_length: Number(ownerNode.properties.step_length ?? 0.25),
            }];
        } else {
            const cropStart = Number(ownerNode.properties.crop_start ?? ownerNode.properties.sample_start ?? 0);
            const cropEnd = Number(ownerNode.properties.crop_end ?? ownerNode.properties.sample_end ?? 1);
            ownerNode.properties.slots = [{
                slot: 0,
                index: 0,
                pool_query: ownerNode.properties.pool_query,
                filepath: ownerNode.properties.filepath || '',
                library_item_id: ownerNode.properties.library_item_id,
                original_bpm: ownerNode.properties.original_bpm,
                key: ownerNode.properties.key || 'C',
                crop_start: cropStart,
                crop_end: cropEnd,
                sample_start: cropStart,
                sample_end: cropEnd,
                pitch_shift: Number(ownerNode.properties.pitch_shift ?? ownerNode.properties.transpose ?? 0),
                time_stretch: Number(ownerNode.properties.time_stretch ?? ownerNode.properties.stretch_factor ?? 1),
            }];
        }
    }

    const slots: NodeSlot[] = ownerNode.properties.slots;
    const activeIdx = Math.min(
        Math.max(0, Number(ownerNode.activeSlotIndex ?? ownerNode.properties.active_slot ?? 0)),
        slots.length - 1
    );
    const seedSalt = Number(modifierNode.properties.seed_salt || ownerNode.properties.seed_salt || 0) * 9973;
    const slotSeeds = resolveModifierSlotSeeds(
        modifierNode.properties.seed ?? 42,
        slots.length,
        Number(ownerNode.id || modifierNode.id || 1) + seedSalt
    );
    const isSequential = modifierNode.properties.playbackMode === 'Sequential';
    const triggerCount = Math.max(0, Math.floor(Number(ownerNode.properties.trigger_count) || 0));

    for (let s = 0; s < slots.length; s++) {
        const slotQuery = slots[s]?.pool_query ?? (s === activeIdx ? ownerNode.properties?.pool_query : undefined);
        const hasExistingFixedAsset = Boolean(slots[s]?.filepath) && slotQuery === '';
        if (hasExistingFixedAsset) {
            continue;
        }
        const seedForSlot = isSequential ? slotSeeds[0] : slotSeeds[s];
        const chosen = resolvePoolItemByQuery(items, slotQuery, s, seedForSlot, isSequential, triggerCount)
            || resolvePoolItemByQuery(items, 'rand', s, seedForSlot, isSequential, triggerCount);
        if (!chosen) continue;
        const filepath = String(chosen.absolute_path || chosen.filepath || '');
        const bpm = chosen.bpm ?? chosen.original_bpm ?? parseBpmFromFilename(filepath);
        const key = chosen.key != null ? String(chosen.key).trim() : undefined;

        if (isSeq) {
            slots[s] = {
                ...(slots[s] || {}),
                slot: s,
                index: s,
                filepath,
                library_item_id: chosen.id ?? slots[s]?.library_item_id,
                sequence_name: chosen.name || slots[s]?.sequence_name,
            };
        } else {
            slots[s] = {
                ...(slots[s] || {}),
                slot: s,
                index: s,
                filepath,
                library_item_id: chosen.id,
                original_bpm: bpm ?? slots[s]?.original_bpm,
                key: key || slots[s]?.key || 'C',
                ...(Number.isFinite(Number(chosen.duration_seconds)) && Number(chosen.duration_seconds) > 0
                    ? { duration_seconds: Number(chosen.duration_seconds) }
                    : {}),
            };
        }
    }

    const activeSlot = slots[activeIdx] || slots[0];
    if (isSeq) {
        if (activeSlot?.filepath) {
            modifierNode.properties.output_value = activeSlot.filepath;
            if (activeSlot.library_item_id != null) modifierNode.properties.output_item_id = activeSlot.library_item_id;
        }
        return;
    }

    if (activeSlot?.filepath) {
        if (typeof ownerNode.updateProperty === 'function') {
            if (ownerNode.properties.filepath !== activeSlot.filepath) {
                ownerNode.updateProperty('filepath', activeSlot.filepath);
            }
            if (activeSlot.library_item_id != null && ownerNode.properties.library_item_id !== activeSlot.library_item_id) {
                ownerNode.updateProperty('library_item_id', activeSlot.library_item_id);
            }
            if (activeSlot.original_bpm != null && !ownerNode.properties.original_bpm_is_local_override && ownerNode.properties.original_bpm !== activeSlot.original_bpm) {
                ownerNode.updateProperty('original_bpm', activeSlot.original_bpm);
            }
            if (activeSlot.key != null && !ownerNode.properties.key_is_local_override && ownerNode.properties.key !== activeSlot.key) {
                ownerNode.updateProperty('key', activeSlot.key);
            }
        } else {
            ownerNode.properties.filepath = activeSlot.filepath;
            if (activeSlot.library_item_id != null) ownerNode.properties.library_item_id = activeSlot.library_item_id;
            if (activeSlot.original_bpm != null) ownerNode.properties.original_bpm = activeSlot.original_bpm;
            if (activeSlot.key != null) ownerNode.properties.key = activeSlot.key;
        }
        modifierNode.properties.output_value = activeSlot.filepath;
        if (activeSlot.library_item_id != null) modifierNode.properties.output_item_id = activeSlot.library_item_id;
        if (activeSlot.original_bpm != null) modifierNode.properties.output_bpm = activeSlot.original_bpm;
        if (activeSlot.key != null) modifierNode.properties.output_key = activeSlot.key;
    }
    if (typeof ownerNode.preloadAllSlotBuffers === 'function') {
        void ownerNode.preloadAllSlotBuffers();
    } else if (typeof ownerNode.ensureAudioLoaded === 'function') {
        void ownerNode.ensureAudioLoaded();
    }
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
    let libraryFiles = resolvedLibraryFiles || (
        typeof resolveLibraryAssets === 'function'
            ? await resolveLibraryAssets(modifierNode.properties.selected_items || [])
            : typeof fetchLibrary === 'function' ? await fetchLibrary(false, true) : []
    );
    for (const item of modifierNode.properties.selected_items || []) {
        if (item?.id == null || !String(item.id).trim()) {
            throw new Error('Asset Pool item is missing its GAIA id');
        }
        const path = item.absolute_path || item.filepath || '';
        let latest = (typeof findLibraryFileForPoolLocator === 'function'
            ? findLibraryFileForPoolLocator(libraryFiles, item)
            : null)
            || (item.id == null && typeof findLibraryFile === 'function' && path
                ? findLibraryFile(libraryFiles, path)
                : null);
        if (!latest && resolvedLibraryFiles && typeof resolveLibraryAssets === 'function') {
            libraryFiles = await resolveLibraryAssets(modifierNode.properties.selected_items || []);
            resolvedLibraryFiles = undefined;
            latest = (typeof findLibraryFileForPoolLocator === 'function'
                ? findLibraryFileForPoolLocator(libraryFiles, item)
                : null)
                || (item.id == null && typeof findLibraryFile === 'function' && path
                    ? findLibraryFile(libraryFiles, path)
                    : null);
        }
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
            if (requestItems.length > 0) {
                populateOwnerSlotsFromPool(modifierNode, ownerNode, requestItems);
            }
            const activeIdx = Math.max(0, Number(ownerNode.activeSlotIndex ?? ownerNode.properties?.active_slot ?? 0));
            const seqSlot = Array.isArray(ownerNode.properties?.slots) ? ownerNode.properties.slots[activeIdx] : undefined;
            const seqAssetPath = String(seqSlot?.filepath || assetPath);
            const seqItemId = seqSlot?.library_item_id ?? libraryItemId;
            const seqItemName = seqSlot?.sequence_name || selectedItem?.name || seqAssetPath.split(/[\\/]/).pop();
            const applySequence = typeof window !== 'undefined' ? (window as any).applyLibraryItemToSequence : undefined;
            if (typeof applySequence === 'function') {
                await applySequence(ownerNode, {
                    id: seqItemId,
                    filepath: seqAssetPath,
                    itemType: libraryItem?.type || selectedItem?.type || (seqAssetPath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi'),
                    name: seqItemName,
                    bpm: selectedItem?.bpm || null,
                    key: resolvedKey || null
                });
            }
        } else {
            if (requestItems.length > 0) {
                populateOwnerSlotsFromPool(modifierNode, ownerNode, requestItems);
            } else if (assetPath) {
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
                if (Array.isArray(ownerNode.properties.slots) && ownerNode.properties.slots.length === 1) {
                    ownerNode.properties.slots[0] = {
                        ...(ownerNode.properties.slots[0] || {}),
                        slot: 0,
                        index: 0,
                        filepath: assetPath,
                        library_item_id: libraryItemId ?? ownerNode.properties.slots[0]?.library_item_id,
                        original_bpm: resolvedBpm ?? ownerNode.properties.slots[0]?.original_bpm,
                        key: resolvedKey || ownerNode.properties.slots[0]?.key || 'C',
                    };
                }
            }
        }
    }
    notifyResolvedProperties(modifierNode);
    notifyResolvedProperties(ownerNode);
    notifyArrangementSourceChanged(ownerNode);
    log?.(`Resolved ${poolName} (${Date.now() - resolutionStartedAt} ms)`, 'common');
    return modifierNode.properties.output_value || assetPath;
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
                const shouldRefresh = !isFrozen
                    && (modifier.properties?.seed_refresh !== false)
                    && shouldRefreshAssetPool(
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
                    let ownerChanged = false;
                    let modifierChanged = false;

                    const isSeq = sampleNode.type === 'Audio/Sequence'
                        || sampleNode.type === 'sequence'
                        || sampleNode.type === 'Sequence'
                        || sampleNode.properties?.node_type === 'sequence';
                    const rawSlots = Array.isArray(sampleNode.properties.slots) ? sampleNode.properties.slots : [];
                    const hasUnpopulatedSlots = !isSeq && rawSlots.length > 0 && rawSlots.some((s: any) => !s?.filepath);

                    const activeSlotIdx = Math.max(0, Number(sampleNode.activeSlotIndex ?? sampleNode.properties?.active_slot ?? 0));
                    const activeSlotFp = rawSlots[activeSlotIdx]?.filepath;
                    const assetPath = sampleNode.properties?.filepath || activeSlotFp || modifier.properties.output_value;
                    if (assetPath && !modifier.properties.output_value) {
                        modifier.properties.output_value = assetPath;
                        modifierChanged = true;
                    }
                    const selectedItem = (modifier.properties.selected_items || []).find((item: any) =>
                        (item.absolute_path || item.filepath) === assetPath
                    );
                    const preferredId = modifier.properties.output_item_id ?? sampleNode.properties?.library_item_id ?? selectedItem?.id;
                    if (preferredId != null && modifier.properties.output_item_id == null) {
                        modifier.properties.output_item_id = preferredId;
                        modifierChanged = true;
                    }
                    if (!isSeq && hasUnpopulatedSlots) {
                        const prevFp = sampleNode.properties.filepath;
                        const prevId = sampleNode.properties.library_item_id;
                        populateOwnerSlotsFromPool(modifier, sampleNode);
                        if (sampleNode.properties.filepath !== prevFp || sampleNode.properties.library_item_id !== prevId) {
                            ownerChanged = true;
                            modifierChanged = true;
                        }
                    } else if (rawSlots.length <= 1) {
                        if (assetPath && sampleNode.properties.filepath !== assetPath) {
                            sampleNode.updateProperty?.('filepath', assetPath);
                            if (rawSlots.length === 1) {
                                rawSlots[0] = {
                                    ...(rawSlots[0] || {}),
                                    slot: 0,
                                    index: 0,
                                    filepath: assetPath,
                                    library_item_id: preferredId ?? rawSlots[0]?.library_item_id,
                                };
                            }
                            ownerChanged = true;
                        }
                        if (preferredId != null && sampleNode.properties.library_item_id !== preferredId) {
                            sampleNode.updateProperty?.('library_item_id', preferredId);
                            ownerChanged = true;
                        }
                    }
                    // When frozen, preserve the node's current BPM and key settings (never overwrite manual edits)
                    if (sampleNode.properties.original_bpm == null && modifier.properties.output_bpm != null) {
                        sampleNode.updateProperty?.('original_bpm', modifier.properties.output_bpm);
                        ownerChanged = true;
                    } else if (sampleNode.properties.original_bpm != null) {
                        if (modifier.properties.output_bpm !== sampleNode.properties.original_bpm) {
                            modifier.properties.output_bpm = sampleNode.properties.original_bpm;
                            modifierChanged = true;
                        }
                        if (selectedItem) {
                            selectedItem.bpm = sampleNode.properties.original_bpm;
                            selectedItem.original_bpm = sampleNode.properties.original_bpm;
                        }
                    }
                    if (!sampleNode.properties.key && modifier.properties.output_key) {
                        sampleNode.updateProperty?.('key', modifier.properties.output_key);
                        ownerChanged = true;
                    } else if (sampleNode.properties.key) {
                        if (modifier.properties.output_key !== sampleNode.properties.key) {
                            modifier.properties.output_key = sampleNode.properties.key;
                            modifierChanged = true;
                        }
                        if (selectedItem) selectedItem.key = sampleNode.properties.key;
                    }
                    if (modifierChanged) notifyResolvedProperties(modifier);
                    if (ownerChanged) {
                        notifyResolvedProperties(node);
                        notifyArrangementSourceChanged(node);
                    }
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
