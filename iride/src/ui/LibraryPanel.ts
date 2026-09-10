import {
    assetMatchesFilters,
    formatAssetType,
    getCompatibleAssetFacets,
    getAssetDisplayName,
    getAssetType,
    getFilterableAssetItems,
    isAssetOrganizer,
    normalizeFacetValue,
} from './libraryFilters';
import { drawNeonIcon, type NeonIcon } from '../nodes/NodeVisuals';
import { clearLibraryCache, fetchLibrary as fetchCachedLibrary, submitLibraryMetadataProposal } from '../api';
import { groupFileVersions, type GroupedFileVersion } from '../libraryVersioning';

type LibraryTypeVisual = {
    icon: NeonIcon;
    color: string;
    label: string;
};

const LIBRARY_TYPE_VISUALS: Record<string, LibraryTypeVisual> = {
    audio: { icon: 'speaker', color: '#10b981', label: 'Audio' },
    sample: { icon: 'sample', color: '#10b981', label: 'Sample' },
    midi: { icon: 'sequence', color: '#8b5cf6', label: 'MIDI' },
    sequence: { icon: 'sequence', color: '#ec4899', label: 'Sequence' },
    track: { icon: 'mixer', color: '#06b6d4', label: 'Track' },
    multitrack: { icon: 'mixer', color: '#f59e0b', label: 'Multitrack' },
    collection: { icon: 'arrangement', color: '#ec4899', label: 'Collection' },
    sample_pack: { icon: 'arrangement', color: '#ec4899', label: 'Sample pack' },
    project: { icon: 'arrangement', color: '#38bdf8', label: 'Project' },
    folder: { icon: 'arrangement', color: '#ec4899', label: 'Folder' },
};

interface ContainerTreeFolder {
    name: string;
    fullPath: string;
    folders: Map<string, ContainerTreeFolder>;
    files: GroupedFileVersion<any>[];
    totalCount: number;
}

function getLibraryTypeVisual(item: any): LibraryTypeVisual {
    const type = getAssetType(item);
    return LIBRARY_TYPE_VISUALS[type] || LIBRARY_TYPE_VISUALS.audio;
}

function drawLibraryTypeIcon(canvas: HTMLCanvasElement, visual: LibraryTypeVisual): void {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawNeonIcon(context, visual.icon, canvas.width / 2, canvas.height / 2, 16, '#ffffff');
}

let libraryPreviewEnabled = true;

export function isLibraryPreviewEnabled(): boolean {
    return libraryPreviewEnabled;
}

export function setLibraryPreviewEnabled(enabled: boolean): boolean {
    libraryPreviewEnabled = enabled;
    window.dispatchEvent(new CustomEvent('library-preview-changed', { detail: { enabled } }));
    return libraryPreviewEnabled;
}

export class LibraryPanel {
    private static readonly INITIAL_RENDER_LIMIT = 200;
    private static readonly RENDER_BATCH_SIZE = 200;
    private container: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private filterContainer: HTMLDivElement;
    private vaultChipsContainer: HTMLDivElement;
    private typeChipsContainer: HTMLDivElement;
    private tagChipsContainer: HTMLDivElement;
    private filterStatus: HTMLDivElement;
    private listContainer: HTMLDivElement;
    private items: any[] = [];
    private vaults: Array<{ id: number; name: string; description?: string }> = [];
    private selectedVaultId: number | null = null;
    private selectedTypes: Set<string> = new Set();
    private selectedTags: Set<string> = new Set();
    private selectedItemKeys: Set<string> = new Set();
    private selectionAnchorKey: string | null = null;
    private previewEnabled: boolean = isLibraryPreviewEnabled();
    private currentAudio: HTMLAudioElement | null = null;
    private playingRow: HTMLElement | null = null;
    private renderLimit: number = LibraryPanel.INITIAL_RENDER_LIMIT;
    private onlyFavourites: boolean = false;
    private favFilterBtn: HTMLButtonElement | null = null;
    private refreshBtn: HTMLButtonElement | null = null;
    private isRefreshing: boolean = false;
    private fileVersionSelections = new Map<string, string>();
    private expandedOrganizerKeys = new Set<string>();
    private expandedSubfolderKeys = new Set<string>();
    private readonly handlePreviewStateChange = (event: Event) => {
        this.previewEnabled = Boolean((event as CustomEvent).detail?.enabled);
        if (!this.previewEnabled) this.stopCurrentPreview();
    };
    private readonly handleRefreshRequest = () => {
        void this.refresh();
    };

    constructor(parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.className = 'td-library-panel';
        
        const searchRow = document.createElement('div');
        searchRow.className = 'td-library-search-row';
        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search loops...';

        this.refreshBtn = document.createElement('button');
        this.refreshBtn.type = 'button';
        this.refreshBtn.className = 'td-library-refresh-btn';
        this.refreshBtn.title = 'Refresh library';
        this.refreshBtn.setAttribute('aria-label', 'Refresh library');
        this.refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';
        this.refreshBtn.onclick = () => {
            void this.refresh();
        };

        this.favFilterBtn = document.createElement('button');
        this.favFilterBtn.type = 'button';
        this.favFilterBtn.className = 'td-library-fav-filter-btn';
        this.favFilterBtn.innerHTML = '★';
        this.favFilterBtn.title = 'Filter by favourites only';
        this.favFilterBtn.onclick = () => {
            this.onlyFavourites = !this.onlyFavourites;
            this.favFilterBtn?.classList.toggle('active', this.onlyFavourites);
            this.favFilterBtn?.setAttribute('title', this.onlyFavourites ? 'Show all assets' : 'Filter by favourites only');
            this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
            this.reconcileFilterSelection();
            this.refreshView();
        };

        searchRow.appendChild(this.searchInput);
        searchRow.appendChild(this.refreshBtn);
        searchRow.appendChild(this.favFilterBtn);

        // Filter Bar
        this.filterContainer = document.createElement('div');
        this.filterContainer.className = 'td-filter-bar';

        const vaultRow = document.createElement('div');
        vaultRow.className = 'td-filter-row';
        this.vaultChipsContainer = document.createElement('div');
        this.vaultChipsContainer.className = 'td-filter-chips';
        vaultRow.appendChild(this.createFilterRail(this.vaultChipsContainer));

        const typeRow = document.createElement('div');
        typeRow.className = 'td-filter-row';
        this.typeChipsContainer = document.createElement('div');
        this.typeChipsContainer.className = 'td-filter-chips';
        typeRow.appendChild(this.createFilterRail(this.typeChipsContainer));

        const tagRow = document.createElement('div');
        tagRow.className = 'td-filter-row';
        this.tagChipsContainer = document.createElement('div');
        this.tagChipsContainer.className = 'td-filter-chips';
        tagRow.appendChild(this.createFilterRail(this.tagChipsContainer));

        this.filterContainer.appendChild(vaultRow);
        this.filterContainer.appendChild(typeRow);
        this.filterContainer.appendChild(tagRow);

        this.filterStatus = document.createElement('div');
        this.filterStatus.className = 'td-library-filter-status';
        this.filterContainer.appendChild(this.filterStatus);

        // List
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'td-library-list';

        this.container.appendChild(searchRow);
        this.container.appendChild(this.filterContainer);
        this.container.appendChild(this.listContainer);
        
        parent.appendChild(this.container);
        window.addEventListener('library-preview-changed', this.handlePreviewStateChange);
        window.addEventListener('request-library-refresh', this.handleRefreshRequest);

        [this.vaultChipsContainer, this.typeChipsContainer, this.tagChipsContainer]
            .forEach(rail => this.enableHorizontalDragScroll(rail));

        this.searchInput.addEventListener('input', () => {
            this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
            this.renderList();
        });
        window.addEventListener('library-metadata-changed', (event: Event) => {
            const { filepath, bpm } = (event as CustomEvent).detail || {};
            const normalized = String(filepath || '').replace(/\\/g, '/').toLocaleLowerCase();
            const item = this.items.find(candidate =>
                String(candidate.absolute_path || '').replace(/\\/g, '/').toLocaleLowerCase() === normalized
            );
            if (item) {
                item.bpm = bpm;
                this.renderList();
            }
        });
        window.addEventListener('library-favourite-changed', (event: Event) => {
            const { item, favourite } = (event as CustomEvent).detail || {};
            if (!item) return;
            const key = this.getItemKey(item);
            const found = this.items.find(candidate => this.getItemKey(candidate) === key);
            if (found) {
                found.favourite = favourite;
                if (found.attributes) found.attributes.favourite = favourite;
            }
            this.items.forEach(parent => {
                if (Array.isArray(parent.contents)) {
                    const child = parent.contents.find((c: any) => this.getItemKey(c) === key);
                    if (child) {
                        child.favourite = favourite;
                        if (child.attributes) child.attributes.favourite = favourite;
                    }
                }
            });
            if (this.onlyFavourites) {
                this.renderList();
            }
        });
        window.addEventListener('library-content-changed', () => {
            void this.refresh();
        });
        this.loadVaults();
    }

    dispose(): void {
        window.removeEventListener('library-preview-changed', this.handlePreviewStateChange);
        window.removeEventListener('request-library-refresh', this.handleRefreshRequest);
        this.stopCurrentPreview();
    }

    private stopCurrentPreview(): void {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        if (this.playingRow) {
            this.playingRow.style.backgroundColor = '';
            this.playingRow.style.borderColor = '';
            this.playingRow = null;
        }
    }

    private createFilterRail(chips: HTMLDivElement): HTMLDivElement {
        const rail = document.createElement('div');
        rail.className = 'td-filter-rail';
        const makeArrow = (direction: -1 | 1) => {
            const arrow = document.createElement('button');
            arrow.type = 'button';
            arrow.className = 'td-filter-scroll-control';
            arrow.textContent = direction < 0 ? '‹' : '›';
            arrow.title = direction < 0 ? 'Scroll filters left' : 'Scroll filters right';
            arrow.setAttribute('aria-label', arrow.title);
            arrow.onclick = event => {
                event.stopPropagation();
                chips.scrollBy({ left: direction * Math.max(100, chips.clientWidth * 0.7), behavior: 'smooth' });
            };
            return arrow;
        };
        rail.append(makeArrow(-1), chips, makeArrow(1));
        return rail;
    }

    private enableHorizontalDragScroll(element: HTMLElement) {
        let pointerId: number | null = null;
        let lastX = 0;
        let distance = 0;
        let suppressClick = false;

        element.addEventListener('pointerdown', event => {
            if (event.button !== 0 && event.button !== 1) return;
            pointerId = event.pointerId;
            lastX = event.clientX;
            distance = 0;
            if (event.button === 1) event.preventDefault();
        });
        element.addEventListener('pointermove', event => {
            if (pointerId !== event.pointerId) return;
            const delta = event.clientX - lastX;
            lastX = event.clientX;
            distance += Math.abs(delta);
            if (distance < 4) return;
            if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
            element.scrollLeft -= delta;
            element.classList.add('is-dragging');
            event.preventDefault();
        });
        const stopDragging = (event: PointerEvent) => {
            if (pointerId !== event.pointerId) return;
            suppressClick = distance >= 4;
            pointerId = null;
            element.classList.remove('is-dragging');
            if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        };
        element.addEventListener('pointerup', stopDragging);
        element.addEventListener('pointercancel', stopDragging);
        element.addEventListener('pointerleave', event => {
            if (pointerId === event.pointerId && !element.hasPointerCapture(event.pointerId)) pointerId = null;
        });
        element.addEventListener('click', event => {
            if (!suppressClick) return;
            suppressClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        element.addEventListener('auxclick', event => {
            if (event.button === 1) {
                suppressClick = false;
                event.preventDefault();
            }
        });
    }

    public async refresh(): Promise<void> {
        if (this.isRefreshing) return;
        this.isRefreshing = true;
        this.refreshBtn?.classList.add('spinning');
        this.refreshBtn?.setAttribute('disabled', 'true');
        try {
            clearLibraryCache();
            await this.loadVaults(undefined, true);
        } finally {
            this.isRefreshing = false;
            this.refreshBtn?.classList.remove('spinning');
            this.refreshBtn?.removeAttribute('disabled');
        }
    }

    private async loadVaults(selectId?: number, forceRefresh = false) {
        try {
            const res = await fetch('/api/vaults');
            if (!res.ok) throw new Error('Unable to load vaults');
            this.vaults = await res.json();
            const remembered = localStorage.getItem('sin.selectedVaultId');
            const preferredId = selectId ?? Number(remembered);
            this.selectedVaultId = selectId === undefined && remembered === 'all'
                ? null
                : this.vaults.some(vault => vault.id === preferredId)
                    ? preferredId
                    : this.vaults[0]?.id ?? null;
            localStorage.setItem(
                'sin.selectedVaultId',
                this.selectedVaultId === null ? 'all' : String(this.selectedVaultId),
            );
            await this.fetchLibrary(forceRefresh);
        } catch (error) {
            console.error('Failed to load vaults', error);
            this.listContainer.innerHTML = '<div class="td-node-popup-empty">Unable to load vaults</div>';
        }
    }

    private updateVaultUI(_availableVaultIds: Set<number>) {
        const scrollLeft = this.vaultChipsContainer.scrollLeft;
        this.vaultChipsContainer.replaceChildren();
        // Keep every vault selectable even when only the active vault's compact
        // dataset is loaded. Previously the panel downloaded every vault just
        // to populate these chips.
        this.vaults.forEach(vault => {
            const chip = document.createElement('button');
            const isSelected = vault.id === this.selectedVaultId;
            chip.type = 'button';
            chip.className = `td-filter-chip ${isSelected ? 'active' : ''}`;
            chip.textContent = vault.name;
            chip.dataset.vaultId = String(vault.id);
            chip.title = isSelected
                ? 'Show assets from all vaults'
                : vault.description || `Show assets from ${vault.name}`;
            chip.setAttribute('aria-pressed', String(isSelected));
            chip.onclick = event => {
                event.stopPropagation();
                this.selectedVaultId = isSelected ? null : vault.id;
                localStorage.setItem(
                    'sin.selectedVaultId',
                    this.selectedVaultId === null ? 'all' : String(this.selectedVaultId),
                );
                void this.fetchLibrary();
            };
            this.vaultChipsContainer.appendChild(chip);
        });
        this.vaultChipsContainer.scrollLeft = scrollLeft;
    }

    private async fetchLibrary(forceRefresh = false) {
        this.listContainer.innerHTML = '<div class="td-node-popup-empty">Loading...</div>';
        try {
            this.items = await fetchCachedLibrary(forceRefresh, this.selectedVaultId === null);
            this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
            this.reconcileFilterSelection();
            this.refreshView();
        } catch (e) {
            console.error("Failed to fetch library", e);
            this.listContainer.innerHTML = '<div class="td-node-popup-empty">Error loading library</div>';
        }
    }

    private getSelectedVaultIds(): number[] {
        return this.selectedVaultId === null ? [] : [this.selectedVaultId];
    }

    /** Remove stale choices after a refresh or externally changed vault without broadening valid filters. */
    private reconcileFilterSelection() {
        if (
            this.selectedVaultId !== null
            && !this.vaults.some(vault => vault.id === this.selectedVaultId)
        ) {
            this.selectedVaultId = null;
        }
        localStorage.setItem(
            'sin.selectedVaultId',
            this.selectedVaultId === null ? 'all' : String(this.selectedVaultId),
        );

        const vaultIds = this.getSelectedVaultIds();
        const typesInVault = new Set(
            this.items
                .flatMap(getFilterableAssetItems)
                .filter(item => assetMatchesFilters(item, { vaultIds, onlyFavourites: this.onlyFavourites }))
                .map(getAssetType),
        );
        this.selectedTypes.forEach(type => {
            if (!typesInVault.has(type)) this.selectedTypes.delete(type);
        });

        const compatibleTags = new Set<string>();
        this.selectedTags.forEach(tag => {
            const candidateTags = new Set([...compatibleTags, tag]);
            const hasMatch = this.items.some(item => assetMatchesFilters(item, {
                vaultIds,
                types: this.selectedTypes,
                tags: candidateTags,
                onlyFavourites: this.onlyFavourites,
            }));
            if (hasMatch) compatibleTags.add(tag);
        });
        this.selectedTags = compatibleTags;

        const compatibleTypes = new Set(
            this.items
                .flatMap(getFilterableAssetItems)
                .filter(item => assetMatchesFilters(item, { vaultIds, tags: this.selectedTags, onlyFavourites: this.onlyFavourites }))
                .map(getAssetType),
        );
        this.selectedTypes.forEach(type => {
            if (!compatibleTypes.has(type)) this.selectedTypes.delete(type);
        });
    }

    private refreshView() {
        this.updateFilterUI();
        this.renderList();
    }



    private updateFilterUI() {
        const vaultScrollLeft = this.vaultChipsContainer.scrollLeft;
        const typeScrollLeft = this.typeChipsContainer.scrollLeft;
        const tagScrollLeft = this.tagChipsContainer.scrollLeft;
        const facets = getCompatibleAssetFacets(this.items, {
            vaultIds: this.getSelectedVaultIds(),
            types: this.selectedTypes,
            tags: this.selectedTags,
            onlyFavourites: this.onlyFavourites,
        });

        this.updateVaultUI(facets.vaultIds);

        // Type Chips
        this.typeChipsContainer.innerHTML = '';
        Array.from(facets.types).sort().forEach(type => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `td-filter-chip ${this.selectedTypes.has(type) ? 'active' : ''}`;
            chip.innerText = formatAssetType(type);
            chip.setAttribute('aria-pressed', String(this.selectedTypes.has(type)));
            chip.title = 'Types match any selected type';
            chip.onclick = (e) => {
                e.stopPropagation();
                if (this.selectedTypes.has(type)) {
                    this.selectedTypes.delete(type);
                } else {
                    this.selectedTypes.add(type);
                }
                this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
                this.refreshView();
            };
            this.typeChipsContainer.appendChild(chip);
        });

        // Tag Chips
        this.tagChipsContainer.innerHTML = '';
        if (facets.tags.size === 0) {
            this.tagChipsContainer.innerHTML = '<span class="td-filter-empty">No tags available</span>';
        } else {
            Array.from(facets.tags.values()).sort().forEach(tag => {
                const tagKey = normalizeFacetValue(tag);
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `td-filter-chip ${this.selectedTags.has(tagKey) ? 'active' : ''}`;
                chip.innerText = tag;
                chip.setAttribute('aria-pressed', String(this.selectedTags.has(tagKey)));
                chip.title = 'Every selected tag must match';
                chip.onclick = (e) => {
                    e.stopPropagation();
                    if (this.selectedTags.has(tagKey)) {
                        this.selectedTags.delete(tagKey);
                    } else {
                        this.selectedTags.add(tagKey);
                    }
                    this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
                    this.refreshView();
                };
                this.tagChipsContainer.appendChild(chip);
            });
        }
        this.vaultChipsContainer.scrollLeft = vaultScrollLeft;
        this.typeChipsContainer.scrollLeft = typeScrollLeft;
        this.tagChipsContainer.scrollLeft = tagScrollLeft;
    }

    private getItemKey(item: any): string {
        return String(item.id ?? item.absolute_path ?? item.filepath ?? item.name ?? '');
    }

    private getItemPath(item: any): string {
        return String(item?.absolute_path || item?.filepath || item?.relative_path || item?.name || '');
    }

    private groupFileVersions(items: any[], scope: string): GroupedFileVersion<any>[] {
        return groupFileVersions(items, {
            pathFor: item => this.getItemPath(item),
            idFor: item => this.getItemKey(item),
            scope,
            selections: this.fileVersionSelections,
        });
    }

    private createFileVersionSelector(versionedItem: GroupedFileVersion<any>): HTMLSpanElement | null {
        if (!versionedItem.fileVersionGroup || !versionedItem.fileVersions || versionedItem.fileVersions.length < 2) {
            return null;
        }

        const control = document.createElement('span');
        control.className = 'td-library-file-version-control';

        const select = document.createElement('select');
        select.className = 'td-library-file-version-selector';
        select.title = 'Select file version';
        select.setAttribute('aria-label', `Select version for ${versionedItem.fileVersionDisplayName || 'file'}`);
        for (const version of versionedItem.fileVersions) {
            const option = document.createElement('option');
            option.value = version.id;
            option.textContent = version.label;
            option.selected = version.record === versionedItem.record;
            select.appendChild(option);
        }

        const chevron = document.createElement('span');
        chevron.className = 'td-library-file-version-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '⌄';
        control.append(select, chevron);

        // A version choice is a view interaction, not an asset preview or a
        // library mutation. Re-rendering swaps only the exposed GAIA record.
        select.addEventListener('mousedown', event => event.stopPropagation());
        select.addEventListener('click', event => event.stopPropagation());
        select.addEventListener('change', event => {
            event.stopPropagation();
            this.fileVersionSelections.set(versionedItem.fileVersionGroup!, select.value);
            this.renderList();
        });
        return control;
    }

    private itemMatchesSearch(item: any, query: string): boolean {
        if (!query) return true;
        return [item?.name, item?.title, item?.filename, item?.absolute_path, item?.filepath, item?.folder]
            .some(value => String(value || '').toLowerCase().includes(query));
    }

    private getVisibleOrganizerContents(item: any, query: string): any[] {
        if (!isAssetOrganizer(item)) return [];
        const parentMatchesSearch = this.itemMatchesSearch(item, query);
        return getFilterableAssetItems(item).filter(content => {
            const matchesSearch = !query || parentMatchesSearch || this.itemMatchesSearch(content, query);
            return matchesSearch && assetMatchesFilters(content, {
                vaultIds: this.getSelectedVaultIds(),
                types: this.selectedTypes,
                tags: this.selectedTags,
                onlyFavourites: this.onlyFavourites,
            });
        });
    }

    private buildContainerTree(
        organizerKey: string,
        versionedContents: GroupedFileVersion<any>[],
    ): { rootFiles: GroupedFileVersion<any>[]; subfolders: ContainerTreeFolder[] } {
        const rootFiles: GroupedFileVersion<any>[] = [];
        const foldersMap = new Map<string, ContainerTreeFolder>();

        const getOrCreateFolder = (parentMap: Map<string, ContainerTreeFolder>, folderName: string, fullPath: string): ContainerTreeFolder => {
            let folder = parentMap.get(folderName);
            if (!folder) {
                folder = {
                    name: folderName,
                    fullPath,
                    folders: new Map(),
                    files: [],
                    totalCount: 0,
                };
                parentMap.set(folderName, folder);
            }
            return folder;
        };

        for (const versionedContent of versionedContents) {
            const record = versionedContent.record;
            const folderStr = String(record.folder || '').replace(/\\/g, '/').trim();
            if (!folderStr) {
                rootFiles.push(versionedContent);
                continue;
            }
            const segments = folderStr.split('/').filter(Boolean);
            if (segments.length === 0) {
                rootFiles.push(versionedContent);
                continue;
            }

            let currentMap = foldersMap;
            let currentPath = organizerKey;
            let currentFolder: ContainerTreeFolder | null = null;
            for (const segment of segments) {
                currentPath += `/${segment}`;
                currentFolder = getOrCreateFolder(currentMap, segment, currentPath);
                currentFolder.totalCount++;
                currentMap = currentFolder.folders;
            }
            if (currentFolder) {
                currentFolder.files.push(versionedContent);
            }
        }

        const sortedFolders = Array.from(foldersMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
        return { rootFiles, subfolders: sortedFolders };
    }

    private renderSubfolder(
        folder: ContainerTreeFolder,
        container: HTMLElement,
        isSearchActive: boolean,
        parentOrganizerItem: any,
        depth: number = 0,
    ): void {
        const subfolderWrapper = document.createElement('div');
        subfolderWrapper.className = 'td-library-subfolder';
        if (depth > 0) {
            subfolderWrapper.style.marginLeft = `${depth * 8}px`;
        }

        const subfolderRow = document.createElement('div');
        subfolderRow.className = 'td-library-subfolder-row';
        subfolderRow.setAttribute('role', 'button');
        subfolderRow.setAttribute('tabindex', '0');

        const isExpanded = isSearchActive || this.expandedSubfolderKeys.has(folder.fullPath);

        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'td-library-subfolder-toggle';
        toggleSpan.textContent = isExpanded ? '▾' : '▸';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'td-library-subfolder-icon';
        iconSpan.textContent = '📁';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'td-library-subfolder-title';
        titleSpan.textContent = folder.name;
        titleSpan.title = folder.name;

        const countSpan = document.createElement('span');
        countSpan.className = 'td-library-subfolder-count';
        countSpan.textContent = `(${folder.totalCount})`;

        subfolderRow.append(toggleSpan, iconSpan, titleSpan, countSpan);

        const subfolderContents = document.createElement('div');
        subfolderContents.className = 'td-library-subfolder-contents';
        subfolderContents.style.display = isExpanded ? 'block' : 'none';

        subfolderRow.onclick = (e) => {
            e.stopPropagation();
            const willExpand = subfolderContents.style.display === 'none';
            subfolderContents.style.display = willExpand ? 'block' : 'none';
            toggleSpan.textContent = willExpand ? '▾' : '▸';
            if (willExpand) {
                this.expandedSubfolderKeys.add(folder.fullPath);
            } else {
                this.expandedSubfolderKeys.delete(folder.fullPath);
            }
        };

        const childFolders = Array.from(folder.folders.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
        for (const childFolder of childFolders) {
            this.renderSubfolder(childFolder, subfolderContents, isSearchActive, parentOrganizerItem, depth + 1);
        }

        for (const file of folder.files) {
            const fileRow = this.createOrganizerFileRow(file, parentOrganizerItem);
            subfolderContents.appendChild(fileRow);
        }

        subfolderWrapper.append(subfolderRow, subfolderContents);
        container.appendChild(subfolderWrapper);
    }

    private createOrganizerFileRow(
        versionedContent: GroupedFileVersion<any>,
        parentOrganizerItem: any,
    ): HTMLElement {
        const content = versionedContent.record;
        const contentRow = document.createElement('div');
        contentRow.className = 'multitrack-stem-row pack-content-row';
        contentRow.draggable = true;
        const contentVisual = getLibraryTypeVisual(content);

        const contentMeta: string[] = [];
        if (content.bpm) contentMeta.push(`${content.bpm} BPM`);
        if (content.key) contentMeta.push(content.key);
        const metaInfo = contentMeta.length ? ` (${contentMeta.join(' • ')})` : '';

        const isContentFav = Boolean(content.favourite ?? content.attributes?.favourite);
        const externalBadge = content.is_external ? '<span class="td-library-external-badge" title="External vault reference">↗ ext</span>' : '';

        contentRow.innerHTML = `
            <span class="library-type-icon library-type-icon--small" style="--library-icon-color: ${contentVisual.color}; background-color: ${contentVisual.color}; border-color: ${contentVisual.color}" title="${contentVisual.label}" aria-label="${contentVisual.label}">
                <canvas width="24" height="24"></canvas>
            </span>
            <span class="stem-name" title="${content.absolute_path || content.relative_path}">${versionedContent.fileVersionDisplayName || content.filename || content.name || content.title}${metaInfo}${externalBadge}</span>
            <span class="stem-duration">${content.duration_seconds ? content.duration_seconds + 's' : ''}</span>
            <button class="td-library-row-fav-btn${isContentFav ? ' active' : ''}" type="button" title="${isContentFav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${isContentFav ? '★' : '☆'}</button>
        `;
        const contentIconCanvas = contentRow.querySelector('.library-type-icon canvas') as HTMLCanvasElement | null;
        if (contentIconCanvas) drawLibraryTypeIcon(contentIconCanvas, contentVisual);

        const contentFavBtn = contentRow.querySelector('.td-library-row-fav-btn') as HTMLButtonElement | null;
        if (contentFavBtn) {
            contentFavBtn.onmousedown = (e) => e.stopPropagation();
            contentFavBtn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                void this.toggleFavourite(content, contentFavBtn, parentOrganizerItem);
            };
        }

        const contentVersionSelector = this.createFileVersionSelector(versionedContent);
        if (contentVersionSelector) {
            contentRow.querySelector('.stem-name')?.after(contentVersionSelector);
        }

        contentRow.ondragstart = (e) => {
            if (e.dataTransfer) {
                const payload = {
                    type: 'library-item',
                    itemType: content.type || 'sample',
                    id: content.id,
                    filepath: content.absolute_path,
                    name: content.filename || content.name || content.title,
                    key: content.key || null,
                    bpm: content.bpm || null,
                    duration_seconds: content.duration_seconds || null,
                    stems: content.stems || [],
                    is_valid_length: content.is_valid_length ?? true,
                    length_variance: content.length_variance ?? 0.0,
                };
                e.dataTransfer.setData('text/plain', JSON.stringify(payload));
                e.dataTransfer.setData('application/x-gaia-library-item', JSON.stringify(payload));
                e.dataTransfer.effectAllowed = 'copy';
            }
        };

        contentRow.onclick = (e) => {
            e.stopPropagation();
            const streamUrl = content.stream_url || `/api/library/stream/${content.id}`;
            this.previewAudio(streamUrl, contentRow, contentVisual.color);
        };

        return contentRow;
    }

    private previewAudio(url: string, row: HTMLElement, accent: string): void {
        if (!this.previewEnabled) return;

        if (this.currentAudio) this.currentAudio.pause();
        if (this.playingRow) {
            this.playingRow.classList.remove('is-playing');
            this.playingRow.style.backgroundColor = '';
            this.playingRow.style.borderColor = '';
        }

        if (this.playingRow === row) {
            this.currentAudio = null;
            this.playingRow = null;
            return;
        }

        this.currentAudio = new Audio(url);
        this.currentAudio.play().catch(error => console.error('Preview failed', error));
        row.classList.add('is-playing');
        row.style.backgroundColor = `${accent}18`;
        row.style.borderColor = accent;
        this.playingRow = row;
        this.currentAudio.onended = () => {
            row.classList.remove('is-playing');
            row.style.backgroundColor = '';
            row.style.borderColor = '';
            if (this.playingRow === row) {
                this.currentAudio = null;
                this.playingRow = null;
            }
        };
    }

    private updateSelectedItemStyles() {
        this.listContainer.querySelectorAll<HTMLElement>('[data-library-item-key]').forEach(element => {
            const isSelected = this.selectedItemKeys.has(element.dataset.libraryItemKey || '');
            element.classList.toggle('is-selected', isSelected);
            element.setAttribute('aria-selected', String(isSelected));
        });
    }

    private selectItem(item: any, visibleItems: any[], event: MouseEvent) {
        const key = this.getItemKey(item);
        const additive = event.ctrlKey || event.metaKey;

        if (event.shiftKey && this.selectionAnchorKey) {
            const start = visibleItems.findIndex(candidate => this.getItemKey(candidate) === this.selectionAnchorKey);
            const end = visibleItems.findIndex(candidate => this.getItemKey(candidate) === key);
            if (start >= 0 && end >= 0) {
                if (!additive) this.selectedItemKeys.clear();
                const [first, last] = start < end ? [start, end] : [end, start];
                visibleItems.slice(first, last + 1).forEach(candidate => this.selectedItemKeys.add(this.getItemKey(candidate)));
            } else {
                this.selectedItemKeys.clear();
                this.selectedItemKeys.add(key);
            }
        } else if (additive) {
            this.selectedItemKeys.has(key) ? this.selectedItemKeys.delete(key) : this.selectedItemKeys.add(key);
            this.selectionAnchorKey = key;
        } else {
            this.selectedItemKeys.clear();
            this.selectedItemKeys.add(key);
            this.selectionAnchorKey = key;
        }

        this.updateSelectedItemStyles();
    }

    private toDragItem(item: any) {
        return {
            itemType: item.type || 'audio',
            id: item.id,
            filepath: item.absolute_path,
            name: item.name,
            key: item.key || null,
            bpm: item.bpm || null,
            duration_seconds: item.duration_seconds || null,
            stems: item.stems || [],
            is_valid_length: item.is_valid_length ?? true,
            length_variance: item.length_variance ?? 0.0
        };
    }

    private renderList() {
        this.listContainer.innerHTML = '';
        this.updateSelectedItemStyles();
        const query = this.searchInput.value.toLowerCase().trim();

        const filtered = this.items.filter(item => {
            // Text Search Query
            if (query && !this.itemMatchesSearch(item, query)) {
                const childMatchesSearch = isAssetOrganizer(item)
                    && getFilterableAssetItems(item).some(content => this.itemMatchesSearch(content, query));
                if (!childMatchesSearch) return false;
            }

            return assetMatchesFilters(item, {
                vaultIds: this.getSelectedVaultIds(),
                types: this.selectedTypes,
                tags: this.selectedTags,
                onlyFavourites: this.onlyFavourites,
            });
        });
        const visibleItems = this.groupFileVersions(filtered, 'root');

        const activeFilterCount = this.selectedTypes.size + this.selectedTags.size + (this.onlyFavourites ? 1 : 0);
        this.filterStatus.replaceChildren();
        const summary = document.createElement('span');
        const favSuffix = this.onlyFavourites ? ' · ★ favourites only' : '';
        summary.textContent = `${visibleItems.length} logical assets (${filtered.length} files) of ${this.items.length} files${activeFilterCount ? favSuffix + ' · types match any, tags match all' : ''}`;
        this.filterStatus.appendChild(summary);
        if (activeFilterCount) {
            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.textContent = 'Clear filters';
            clearButton.onclick = () => {
                this.selectedTypes.clear();
                this.selectedTags.clear();
                this.onlyFavourites = false;
                this.favFilterBtn?.classList.remove('active');
                this.favFilterBtn?.setAttribute('title', 'Filter by favourites only');
                this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
                this.refreshView();
            };
            this.filterStatus.appendChild(clearButton);
        }

        if (visibleItems.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matches for "${query}"` : 'No matching items';
            this.listContainer.appendChild(empty);
            return;
        }

        visibleItems.slice(0, this.renderLimit).forEach(versionedItem => {
            const item = versionedItem.record;
            const itemWrapper = document.createElement('div');
            const visibleOrganizerContents = this.getVisibleOrganizerContents(item, query);
            const versionedOrganizerContents = this.groupFileVersions(
                visibleOrganizerContents,
                `organizer:${this.getItemKey(item)}`,
            );
            itemWrapper.className = 'td-library-item-wrapper';

            const el = document.createElement('div');
            el.className = 'td-node-popup-item';
            const itemKey = this.getItemKey(item);
            el.dataset.libraryItemKey = itemKey;
            el.classList.toggle('is-selected', this.selectedItemKeys.has(itemKey));
            el.setAttribute('aria-selected', String(this.selectedItemKeys.has(itemKey)));
            
            const displayName = versionedItem.fileVersionDisplayName || getAssetDisplayName(item);
            const typeVisual = getLibraryTypeVisual(item);

            const metaParts: string[] = [];
            if (item.type === 'multitrack' && Array.isArray(item.stems)) {
                metaParts.push(`${item.stems.length} Stems`);
            } else if (isAssetOrganizer(item)) {
                metaParts.push(`${versionedOrganizerContents.length} Items`);
            }
            if (item.bpm) metaParts.push(`${item.bpm} BPM`);
            if (item.key) metaParts.push(item.key);
            
            let lengthBadge = '';
            if (item.type === 'multitrack' && item.is_valid_length === false) {
                lengthBadge = `<span class="multitrack-length-tag warning" title="Stem length variance: ${item.length_variance}s">⚠️ Length mismatch</span>`;
            } else if (item.type === 'multitrack' && item.is_valid_length === true) {
                lengthBadge = `<span class="multitrack-length-tag valid" title="All stems equal length">✓ Equal length</span>`;
            }

            const metaStr = metaParts.length > 0 ? `<span style="font-size: 11px; color: #64748b; margin-left: 6px; font-weight: normal;">(${metaParts.join(' • ')})</span>` : '';

            const isSearchActive = Boolean(query);
            const isOrganizerExpanded = this.expandedOrganizerKeys.has(itemKey)
                || (isSearchActive && versionedOrganizerContents.length > 0);

            let accordionToggle = '';
            if (item.type === 'multitrack' && Array.isArray(item.stems) && item.stems.length > 0) {
                accordionToggle = `<button class="multitrack-toggle-btn" title="Toggle Stem List" aria-label="Toggle stem list">▼</button>`;
            } else if (isAssetOrganizer(item) && visibleOrganizerContents.length > 0) {
                accordionToggle = `<button class="pack-toggle-btn multitrack-toggle-btn" title="Toggle Pack Contents" aria-label="Toggle pack contents">${isOrganizerExpanded ? '▲' : '▼'}</button>`;
            }

            const isFav = Boolean(item.favourite ?? item.attributes?.favourite);
            const externalBadge = item.is_external ? '<span class="td-library-external-badge" title="External vault reference">↗ ext</span>' : '';

            el.innerHTML = `
                <span class="library-type-icon" style="--library-icon-color: ${typeVisual.color}; background-color: ${typeVisual.color}; border-color: ${typeVisual.color}" title="${typeVisual.label}" aria-label="${typeVisual.label}">
                    <canvas width="24" height="24"></canvas>
                </span>
                <span class="item-label" title="${item.absolute_path}">${displayName}${metaStr} ${lengthBadge}${externalBadge}</span>
                ${accordionToggle}
                <button class="td-library-row-fav-btn${isFav ? ' active' : ''}" type="button" title="${isFav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${isFav ? '★' : '☆'}</button>
            `;
            const typeIconCanvas = el.querySelector('.library-type-icon canvas') as HTMLCanvasElement | null;
            if (typeIconCanvas) drawLibraryTypeIcon(typeIconCanvas, typeVisual);

            const favBtn = el.querySelector('.td-library-row-fav-btn') as HTMLButtonElement | null;
            if (favBtn) {
                favBtn.onmousedown = (e) => e.stopPropagation();
                favBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    void this.toggleFavourite(item, favBtn);
                };
            }

            const versionSelector = this.createFileVersionSelector(versionedItem);
            if (versionSelector) {
                el.querySelector('.item-label')?.after(versionSelector);
            }

            // Organizer rows group assets but are not themselves draggable
            // library assets; contained rows provide the drag payload.
            el.draggable = !isAssetOrganizer(item);
            el.ondragstart = (e) => {
                if (isAssetOrganizer(item)) {
                    e.preventDefault();
                    return;
                }
                if (e.dataTransfer) {
                    const selectedItems = this.selectedItemKeys.has(itemKey)
                        ? visibleItems
                            .map(candidate => candidate.record)
                            .filter(candidate => this.selectedItemKeys.has(this.getItemKey(candidate)))
                        : [item];
                    const draggedItems = selectedItems.length ? selectedItems : [item];
                    const payload = draggedItems.length === 1
                        ? { type: 'library-item', ...this.toDragItem(draggedItems[0]) }
                        : { type: 'library-items', items: draggedItems.map(candidate => this.toDragItem(candidate)) };
                    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
                    e.dataTransfer.setData('application/x-gaia-library-item', JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = 'copy';
                }
            };

            el.onmousedown = (e) => {
                if (isAssetOrganizer(item)) return;
                if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    this.selectItem(item, visibleItems.map(candidate => candidate.record), e);
                    // Keep this modifier gesture out of the preview click handler.
                    e.preventDefault();
                }
            };

            el.onclick = (e) => {
                const target = e.target as HTMLElement;
                if (target.classList.contains('multitrack-toggle-btn') && !target.classList.contains('pack-toggle-btn')) {
                    e.stopPropagation();
                    const stemContainer = itemWrapper.querySelector('.multitrack-stem-container:not(.pack-content-container)') as HTMLElement;
                    if (stemContainer) {
                        const isHidden = stemContainer.style.display === 'none';
                        stemContainer.style.display = isHidden ? 'block' : 'none';
                        target.innerText = isHidden ? '▲' : '▼';
                    }
                    return;
                }
                if (target.classList.contains('pack-toggle-btn') || isAssetOrganizer(item)) {
                    e.stopPropagation();
                    const packContainer = itemWrapper.querySelector('.pack-content-container') as HTMLElement;
                    if (packContainer) {
                        const isHidden = packContainer.style.display === 'none';
                        packContainer.style.display = isHidden ? 'block' : 'none';
                        const toggleBtn = itemWrapper.querySelector('.pack-toggle-btn') as HTMLElement | null;
                        if (toggleBtn) toggleBtn.innerText = isHidden ? '▲' : '▼';
                        if (isHidden) {
                            this.expandedOrganizerKeys.add(itemKey);
                        } else {
                            this.expandedOrganizerKeys.delete(itemKey);
                        }
                    }
                    return;
                }

                // Modifier clicks are selection gestures, not preview gestures.
                if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                if (isAssetOrganizer(item)) return;

                this.selectItem(item, visibleItems.map(candidate => candidate.record), e);

                if (!this.previewEnabled) return;
                
                if (this.currentAudio) {
                    this.currentAudio.pause();
                    if (this.playingRow) {
                        this.playingRow.style.backgroundColor = '';
                        this.playingRow.style.borderColor = '';
                    }
                }
                
                if (this.playingRow === el) {
                    this.playingRow = null;
                    return;
                }

                if (item.type === 'midi' || item.type === 'sequence' || item.name.endsWith('.mid') || item.name.endsWith('.midi') || item.name.endsWith('.seq')) {
                    el.style.backgroundColor = 'rgba(139, 92, 246, 0.15)';
                    el.style.borderColor = '#8b5cf6';
                    this.playingRow = el;
                    setTimeout(() => {
                        if (this.playingRow === el) {
                            el.style.backgroundColor = '';
                            el.style.borderColor = '';
                            this.playingRow = null;
                        }
                    }, 1500);
                    return;
                }

                if (item.id) {
                    this.currentAudio = new Audio(item.stream_url || `/api/library/stream/${item.id}`);
                    this.currentAudio.play().catch(e => console.error("Preview failed", e));
                    el.style.backgroundColor = item.type === 'multitrack' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(2, 132, 199, 0.12)';
                    el.style.borderColor = item.type === 'multitrack' ? '#f59e0b' : '#0284c7';
                    this.playingRow = el;
                    
                    this.currentAudio.onended = () => {
                        el.style.backgroundColor = '';
                        el.style.borderColor = '';
                        if (this.playingRow === el) this.playingRow = null;
                    };
                }
            };

            itemWrapper.appendChild(el);

            if (item.type === 'multitrack' && Array.isArray(item.stems) && item.stems.length > 0) {
                const stemContainer = document.createElement('div');
                stemContainer.className = 'multitrack-stem-container';
                stemContainer.style.display = 'none';

                item.stems.forEach((stem: any, idx: number) => {
                    const stemRow = document.createElement('div');
                    stemRow.className = 'multitrack-stem-row';
                    stemRow.innerHTML = `
                        <span class="stem-badge">${stem.stem_type || 'STEM'}</span>
                        <span class="stem-name" title="${stem.absolute_path}">${stem.filename}</span>
                        <span class="stem-duration">${stem.duration_seconds ? stem.duration_seconds + 's' : ''}</span>
                        <button class="stem-play-btn" title="Preview Stem">▶</button>
                    `;

                    const playBtn = stemRow.querySelector('.stem-play-btn') as HTMLButtonElement;
                    playBtn.onclick = (e) => {
                        e.stopPropagation();
                        if (this.currentAudio) {
                            this.currentAudio.pause();
                        }
                        const stemStreamUrl = `/items/${item.id}/stems/${idx}/stream`;
                        this.currentAudio = new Audio(stemStreamUrl);
                        this.currentAudio.play().catch(err => console.error("Stem preview failed", err));
                    };

                    stemContainer.appendChild(stemRow);
                });

                itemWrapper.appendChild(stemContainer);
            }

            if (isAssetOrganizer(item) && versionedOrganizerContents.length > 0) {
                const packContainer = document.createElement('div');
                packContainer.className = 'pack-content-container multitrack-stem-container';
                packContainer.style.display = isOrganizerExpanded ? 'block' : 'none';

                const { rootFiles, subfolders } = this.buildContainerTree(
                    itemKey,
                    versionedOrganizerContents,
                );

                for (const subfolder of subfolders) {
                    this.renderSubfolder(subfolder, packContainer, isSearchActive, item);
                }

                for (const versionedContent of rootFiles) {
                    const contentRow = this.createOrganizerFileRow(versionedContent, item);
                    packContainer.appendChild(contentRow);
                }

                itemWrapper.appendChild(packContainer);
            }

            this.listContainer.appendChild(itemWrapper);
        });

        if (visibleItems.length > this.renderLimit) {
            const remaining = visibleItems.length - this.renderLimit;
            const loadMore = document.createElement('button');
            loadMore.type = 'button';
            loadMore.className = 'td-library-load-more';
            loadMore.textContent = `Load ${Math.min(LibraryPanel.RENDER_BATCH_SIZE, remaining)} more (${remaining} remaining)`;
            loadMore.onclick = () => {
                this.renderLimit += LibraryPanel.RENDER_BATCH_SIZE;
                this.renderList();
            };
            this.listContainer.appendChild(loadMore);
        }
    }

    private async toggleFavourite(item: any, btn: HTMLElement, _parentItem?: any) {
        const currentFav = Boolean(item.favourite ?? item.attributes?.favourite);
        const newFav = !currentFav;

        item.favourite = newFav;
        if (item.attributes) item.attributes.favourite = newFav;
        btn.classList.toggle('active', newFav);
        btn.innerHTML = newFav ? '★' : '☆';
        btn.title = newFav ? 'Remove from favourites' : 'Add to favourites';

        try {
            await submitLibraryMetadataProposal({
                fileId: item.id,
                filepath: item.absolute_path || item.filepath,
                field: 'favourite',
                value: newFav,
                previousValue: currentFav,
            });
            window.dispatchEvent(new CustomEvent('library-favourite-changed', {
                detail: { item, favourite: newFav },
            }));
        } catch (err) {
            console.error('Failed to toggle favourite', err);
            item.favourite = currentFav;
            if (item.attributes) item.attributes.favourite = currentFav;
            btn.classList.toggle('active', currentFav);
            btn.innerHTML = currentFav ? '★' : '☆';
            btn.title = currentFav ? 'Remove from favourites' : 'Add to favourites';
        }

        if (this.onlyFavourites && !newFav) {
            this.renderList();
        }
    }
}
