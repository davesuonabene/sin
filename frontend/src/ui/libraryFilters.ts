export type AssetFilterSelection = {
    vaultIds?: Iterable<number | string>;
    types?: Iterable<string>;
    tags?: Iterable<string>;
};

export type CompatibleAssetFacets = {
    vaultIds: Set<number>;
    types: Set<string>;
    tags: Map<string, string>;
};

export function normalizeFacetValue(value: unknown): string {
    return String(value ?? '').trim().toLocaleLowerCase();
}

export function getAssetType(item: any): string {
    const declaredType = normalizeFacetValue(item?.type);
    if (declaredType && declaredType !== 'item') return declaredType;

    const source = normalizeFacetValue(item?.name || item?.absolute_path || item?.filepath);
    return source.endsWith('.mid') || source.endsWith('.midi') ? 'midi' : 'audio';
}

export function getAssetTags(item: any): string[] {
    if (!Array.isArray(item?.tags)) return [];
    const tags: string[] = item.tags
        .map((tag: any) => String(typeof tag === 'string' ? tag : tag?.name ?? '').trim())
        .filter(Boolean);
    const seen = new Set<string>();
    return tags.filter(tag => {
        const normalized = normalizeFacetValue(tag);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
    });
}

export function getAssetVaultIds(item: any): number[] {
    const rawIds = [
        ...(Array.isArray(item?.vault_ids) ? item.vault_ids : []),
        item?.vault_id,
    ];
    const ids: number[] = rawIds
        .map((value: unknown) => Number(value))
        .filter((value: number): value is number => Number.isFinite(value));
    return [...new Set(ids)];
}

function tagMatches(selectedTag: string, itemTag: string): boolean {
    return itemTag === selectedTag
        || itemTag.startsWith(`${selectedTag}/`)
        || itemTag.startsWith(`${selectedTag}:`);
}

/** Values within the type facet are ORed; every tag and separate facet must match. */
export function assetMatchesFilters(item: any, selection: AssetFilterSelection): boolean {
    const selectedVaultIds = [...(selection.vaultIds || [])]
        .map(value => Number(value))
        .filter(Number.isFinite);
    if (selectedVaultIds.length) {
        const itemVaultIds = getAssetVaultIds(item);
        if (!selectedVaultIds.some(vaultId => itemVaultIds.includes(vaultId))) return false;
    }

    const selectedTypes = [...(selection.types || [])].map(normalizeFacetValue).filter(Boolean);
    if (selectedTypes.length && !selectedTypes.includes(getAssetType(item))) return false;

    const selectedTags = [...(selection.tags || [])].map(normalizeFacetValue).filter(Boolean);
    if (!selectedTags.length) return true;

    const itemTags = getAssetTags(item).map(normalizeFacetValue);
    return selectedTags.every(selectedTag => itemTags.some(itemTag => tagMatches(selectedTag, itemTag)));
}

/** Each row is constrained by every other row; tags also constrain their own row because they use AND semantics. */
export function getCompatibleAssetFacets(
    items: any[],
    selection: AssetFilterSelection,
): CompatibleAssetFacets {
    const vaultIds = new Set<number>();
    const types = new Set<string>();
    const tags = new Map<string, string>();

    items.forEach(item => {
        if (assetMatchesFilters(item, { types: selection.types, tags: selection.tags })) {
            getAssetVaultIds(item).forEach(vaultId => vaultIds.add(vaultId));
        }
        if (assetMatchesFilters(item, { vaultIds: selection.vaultIds, tags: selection.tags })) {
            types.add(getAssetType(item));
        }
        if (assetMatchesFilters(item, selection)) {
            getAssetTags(item).forEach(tag => {
                const normalized = normalizeFacetValue(tag);
                if (!tags.has(normalized)) tags.set(normalized, tag);
            });
        }
    });

    return { vaultIds, types, tags };
}

export function getAssetDisplayName(item: any): string {
    const source = String(item?.name || item?.title || item?.absolute_path || item?.filepath || 'Untitled asset');
    return source.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled asset';
}

export function formatAssetType(type: string): string {
    return type.replaceAll('_', ' ');
}
