export type AssetFilterSelection = {
    vaultIds?: Iterable<number | string>;
    types?: Iterable<string>;
    tags?: Iterable<string>;
    onlyFavourites?: boolean;
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
    if (source.endsWith('.mid') || source.endsWith('.midi')) return 'midi';
    if (source.endsWith('.seq')) return 'sequence';
    return 'audio';
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
    const vaultId = Number(item?.vault_id);
    return Number.isFinite(vaultId) ? [vaultId] : [];
}

/**
 * Typed folder rows are library organizers, not filterable
 * assets themselves. Keep their contents as the filter candidates so the UI
 * can retain the organizer row while facets and matching operate on the
 * actual assets inside it.
 */
export function isAssetOrganizer(item: any): boolean {
    return ['collection', 'sample_pack', 'project'].includes(normalizeFacetValue(item?.type))
        && Array.isArray(item?.contents);
}

export function getFilterableAssetItems(item: any): any[] {
    if (!isAssetOrganizer(item)) return [item];

    return item.contents
        .filter((content: any) => content && typeof content === 'object')
        .map((content: any) => ({
            ...content,
            name: content.name || content.title || content.filename,
            vault_id: getAssetVaultIds(content).length
                ? content.vault_id
                : item.vault_id,
        }));
}

function tagMatches(selectedTag: string, itemTag: string): boolean {
    return itemTag === selectedTag
        || itemTag.startsWith(`${selectedTag}/`)
        || itemTag.startsWith(`${selectedTag}:`);
}

/** Values within the type facet are ORed; every tag and separate facet must match. */
export function assetMatchesFilters(item: any, selection: AssetFilterSelection): boolean {
    const candidates = getFilterableAssetItems(item);
    const hasSelection = Boolean(
        [...(selection.vaultIds || [])].length
        || [...(selection.types || [])].some(value => normalizeFacetValue(value))
        || [...(selection.tags || [])].some(value => normalizeFacetValue(value))
        || selection.onlyFavourites,
    );
    // An empty organizer can still be displayed when no asset filter is
    // active, but it cannot satisfy a filter without a contained asset.
    if (candidates.length === 0) return !hasSelection;

    if (isAssetOrganizer(item)) {
        return candidates.some(candidate => assetMatchesFilters(candidate, selection));
    }

    if (selection.onlyFavourites) {
        const isFav = Boolean(item?.favourite ?? item?.attributes?.favourite);
        if (!isFav) return false;
    }

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

    items.flatMap(getFilterableAssetItems).forEach(item => {
        if (assetMatchesFilters(item, { types: selection.types, tags: selection.tags, onlyFavourites: selection.onlyFavourites })) {
            getAssetVaultIds(item).forEach(vaultId => vaultIds.add(vaultId));
        }
        if (assetMatchesFilters(item, { vaultIds: selection.vaultIds, tags: selection.tags, onlyFavourites: selection.onlyFavourites })) {
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
    const source = String(item?.name || item?.title || item?.filename || item?.absolute_path || item?.filepath || 'Untitled asset');
    return source.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled asset';
}

export function formatAssetType(type: string): string {
    return type.replaceAll('_', ' ');
}
