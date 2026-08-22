import {
    assetMatchesFilters,
    formatAssetType,
    getCompatibleAssetFacets,
    getAssetDisplayName,
    getAssetType,
    getAssetVaultIds,
    getFilterableAssetItems,
    isAssetOrganizer,
    normalizeFacetValue,
} from './libraryFilters';
import { drawNeonIcon, type NeonIcon } from '../nodes/NodeVisuals';

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
};

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
    private previewEnabled: boolean = true;
    private currentAudio: HTMLAudioElement | null = null;
    private playingRow: HTMLElement | null = null;
    private renderLimit: number = LibraryPanel.INITIAL_RENDER_LIMIT;

    constructor(parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.className = 'td-library-panel';
        
        // Header
        const header = document.createElement('div');
        header.className = 'td-node-popup-header';
        
        const togglePreviewBtn = document.createElement('button');
        togglePreviewBtn.className = 'td-node-popup-close';
        togglePreviewBtn.innerText = '🔊';
        togglePreviewBtn.title = 'Toggle Auto-Preview';
        togglePreviewBtn.onclick = () => {
            this.previewEnabled = !this.previewEnabled;
            togglePreviewBtn.innerText = this.previewEnabled ? '🔊' : '🔇';
            if (!this.previewEnabled && this.currentAudio) {
                this.currentAudio.pause();
                if (this.playingRow) {
                    this.playingRow.style.backgroundColor = '';
                    this.playingRow.style.borderColor = '';
                }
                this.playingRow = null;
            }
        };

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'td-node-popup-close';
        refreshBtn.innerText = '↻';
        refreshBtn.title = 'Refresh Library';
        refreshBtn.onclick = () => this.fetchLibrary();

        const isFloating = () => {
            const dv = (window as any).dockview;
            const p = dv?.getGroupPanel('library_panel');
            return p?.group?.api?.location?.type === 'floating';
        };

        const dockBtn = document.createElement('button');
        dockBtn.className = 'td-node-popup-close';
        dockBtn.innerText = isFloating() ? '📌' : '↗';
        dockBtn.title = isFloating() ? 'Dock to Left Side' : 'Float Window';
        dockBtn.onclick = () => {
            window.dispatchEvent(new CustomEvent('toggle-library-dock'));
        };

        const closeBtn = document.createElement('button');
        closeBtn.className = 'td-node-popup-close';
        closeBtn.innerText = '✕';
        closeBtn.title = 'Close Library';
        closeBtn.onclick = () => {
            window.dispatchEvent(new CustomEvent('close-library-panel'));
        };

        header.appendChild(togglePreviewBtn);
        header.appendChild(refreshBtn);
        header.appendChild(dockBtn);
        header.appendChild(closeBtn);

        const searchRow = document.createElement('div');
        searchRow.className = 'td-library-search-row';
        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search loops...';
        searchRow.appendChild(this.searchInput);

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

        this.container.appendChild(header);
        this.container.appendChild(searchRow);
        this.container.appendChild(this.filterContainer);
        this.container.appendChild(this.listContainer);
        
        parent.appendChild(this.container);

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
        window.addEventListener('library-content-changed', () => {
            void this.loadVaults();
        });
        this.loadVaults();
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

    private async loadVaults(selectId?: number) {
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
            await this.fetchLibrary();
        } catch (error) {
            console.error('Failed to load vaults', error);
            this.listContainer.innerHTML = '<div class="td-node-popup-empty">Unable to load vaults</div>';
        }
    }

    private updateVaultUI(availableVaultIds: Set<number>) {
        const scrollLeft = this.vaultChipsContainer.scrollLeft;
        this.vaultChipsContainer.replaceChildren();
        this.vaults.filter(vault => availableVaultIds.has(vault.id)).forEach(vault => {
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
                this.reconcileFilterSelection();
                this.refreshView();
            };
            this.vaultChipsContainer.appendChild(chip);
        });
        this.vaultChipsContainer.scrollLeft = scrollLeft;
    }

    private async fetchLibrary() {
        this.listContainer.innerHTML = '<div class="td-node-popup-empty">Loading...</div>';
        try {
            const res = await fetch('/api/library');
            if (!res.ok) throw new Error('Unable to load vault assets');
            const data = await res.json();
            this.items = data.files || [];
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
        const populatedVaultIds = new Set(this.items.flatMap(item => getAssetVaultIds(item)));
        if (this.selectedVaultId !== null && !populatedVaultIds.has(this.selectedVaultId)) {
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
                .filter(item => assetMatchesFilters(item, { vaultIds }))
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
            }));
            if (hasMatch) compatibleTags.add(tag);
        });
        this.selectedTags = compatibleTags;

        const compatibleTypes = new Set(
            this.items
                .flatMap(getFilterableAssetItems)
                .filter(item => assetMatchesFilters(item, { vaultIds, tags: this.selectedTags }))
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

    private itemMatchesSearch(item: any, query: string): boolean {
        if (!query) return true;
        return [item?.name, item?.title, item?.filename, item?.absolute_path, item?.filepath]
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
            });
        });
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
            });
        });

        const activeFilterCount = this.selectedTypes.size + this.selectedTags.size;
        this.filterStatus.replaceChildren();
        const summary = document.createElement('span');
        summary.textContent = `${filtered.length} of ${this.items.length} assets${activeFilterCount ? ' · types match any, tags match all' : ''}`;
        this.filterStatus.appendChild(summary);
        if (activeFilterCount) {
            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.textContent = 'Clear filters';
            clearButton.onclick = () => {
                this.selectedTypes.clear();
                this.selectedTags.clear();
                this.renderLimit = LibraryPanel.INITIAL_RENDER_LIMIT;
                this.refreshView();
            };
            this.filterStatus.appendChild(clearButton);
        }

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matches for "${query}"` : 'No matching items';
            this.listContainer.appendChild(empty);
            return;
        }

        filtered.slice(0, this.renderLimit).forEach(item => {
            const itemWrapper = document.createElement('div');
            const visibleOrganizerContents = this.getVisibleOrganizerContents(item, query);
            itemWrapper.className = 'td-library-item-wrapper';

            const el = document.createElement('div');
            el.className = 'td-node-popup-item';
            const itemKey = this.getItemKey(item);
            el.dataset.libraryItemKey = itemKey;
            el.classList.toggle('is-selected', this.selectedItemKeys.has(itemKey));
            el.setAttribute('aria-selected', String(this.selectedItemKeys.has(itemKey)));
            
            const displayName = getAssetDisplayName(item);
            const typeVisual = getLibraryTypeVisual(item);

            const metaParts: string[] = [];
            if (item.type === 'multitrack' && Array.isArray(item.stems)) {
                metaParts.push(`${item.stems.length} Stems`);
            } else if (isAssetOrganizer(item)) {
                metaParts.push(`${visibleOrganizerContents.length} Items`);
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

            let accordionToggle = '';
            if (item.type === 'multitrack' && Array.isArray(item.stems) && item.stems.length > 0) {
                accordionToggle = `<button class="multitrack-toggle-btn" title="Toggle Stem List" aria-label="Toggle stem list">▼</button>`;
            } else if (isAssetOrganizer(item) && visibleOrganizerContents.length > 0) {
                accordionToggle = `<button class="pack-toggle-btn multitrack-toggle-btn" title="Toggle Pack Contents" aria-label="Toggle pack contents">▼</button>`;
            }

            el.innerHTML = `
                <span class="library-type-icon" style="--library-icon-color: ${typeVisual.color}; background-color: ${typeVisual.color}; border-color: ${typeVisual.color}" title="${typeVisual.label}" aria-label="${typeVisual.label}">
                    <canvas width="24" height="24"></canvas>
                </span>
                <span class="item-label" title="${item.absolute_path}">${displayName}${metaStr} ${lengthBadge}</span>
                ${accordionToggle}
            `;
            const typeIconCanvas = el.querySelector('.library-type-icon canvas') as HTMLCanvasElement | null;
            if (typeIconCanvas) drawLibraryTypeIcon(typeIconCanvas, typeVisual);

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
                        ? this.items.filter(candidate => this.selectedItemKeys.has(this.getItemKey(candidate)))
                        : [item];
                    const draggedItems = selectedItems.length ? selectedItems : [item];
                    const payload = draggedItems.length === 1
                        ? { type: 'library-item', ...this.toDragItem(draggedItems[0]) }
                        : { type: 'library-items', items: draggedItems.map(candidate => this.toDragItem(candidate)) };
                    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = 'copy';
                }
            };

            el.onmousedown = (e) => {
                if (isAssetOrganizer(item)) return;
                if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    this.selectItem(item, filtered, e);
                    // Keep this modifier gesture out of the preview click handler.
                    e.preventDefault();
                }
            };

            el.onclick = (e) => {
                const target = e.target as HTMLElement;
                if (target.classList.contains('multitrack-toggle-btn')) {
                    e.stopPropagation();
                    const stemContainer = itemWrapper.querySelector('.multitrack-stem-container') as HTMLElement;
                    if (stemContainer) {
                        const isHidden = stemContainer.style.display === 'none';
                        stemContainer.style.display = isHidden ? 'block' : 'none';
                        target.innerText = isHidden ? '▲' : '▼';
                    }
                    return;
                }
                if (target.classList.contains('pack-toggle-btn')) {
                    e.stopPropagation();
                    const packContainer = itemWrapper.querySelector('.pack-content-container') as HTMLElement;
                    if (packContainer) {
                        const isHidden = packContainer.style.display === 'none';
                        packContainer.style.display = isHidden ? 'block' : 'none';
                        target.innerText = isHidden ? '▲' : '▼';
                    }
                    return;
                }

                // Modifier clicks are selection gestures, not preview gestures.
                if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                if (isAssetOrganizer(item)) return;

                this.selectItem(item, filtered, e);

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

            if (isAssetOrganizer(item) && visibleOrganizerContents.length > 0) {
                const packContainer = document.createElement('div');
                packContainer.className = 'pack-content-container multitrack-stem-container';
                packContainer.style.display = 'none';

                visibleOrganizerContents.forEach((content: any) => {
                    const contentRow = document.createElement('div');
                    contentRow.className = 'multitrack-stem-row pack-content-row';
                    contentRow.draggable = true;
                    const contentVisual = getLibraryTypeVisual(content);

                    const contentMeta: string[] = [];
                    if (content.bpm) contentMeta.push(`${content.bpm} BPM`);
                    if (content.key) contentMeta.push(content.key);
                    const metaInfo = contentMeta.length ? ` (${contentMeta.join(' • ')})` : '';

                    contentRow.innerHTML = `
                        <span class="library-type-icon library-type-icon--small" style="--library-icon-color: ${contentVisual.color}; background-color: ${contentVisual.color}; border-color: ${contentVisual.color}" title="${contentVisual.label}" aria-label="${contentVisual.label}">
                            <canvas width="24" height="24"></canvas>
                        </span>
                        <span class="stem-name" title="${content.absolute_path || content.relative_path}">${content.filename}${metaInfo}</span>
                        <span class="stem-duration">${content.duration_seconds ? content.duration_seconds + 's' : ''}</span>
                    `;
                    const contentIconCanvas = contentRow.querySelector('.library-type-icon canvas') as HTMLCanvasElement | null;
                    if (contentIconCanvas) drawLibraryTypeIcon(contentIconCanvas, contentVisual);

                    contentRow.ondragstart = (e) => {
                        if (e.dataTransfer) {
                            const payload = {
                                type: 'library-item',
                                itemType: content.type || 'sample',
                                id: content.id,
                                filepath: content.absolute_path,
                                name: content.filename,
                                key: content.key || null,
                                bpm: content.bpm || null,
                                duration_seconds: content.duration_seconds || null,
                            };
                            e.dataTransfer.setData('text/plain', JSON.stringify(payload));
                            e.dataTransfer.effectAllowed = 'copy';
                        }
                    };

                    contentRow.onclick = () => {
                        const streamUrl = content.stream_url || `/api/library/stream/${content.id}`;
                        this.previewAudio(streamUrl, contentRow, contentVisual.color);
                    };

                    packContainer.appendChild(contentRow);
                });

                itemWrapper.appendChild(packContainer);
            }

            this.listContainer.appendChild(itemWrapper);
        });

        if (filtered.length > this.renderLimit) {
            const remaining = filtered.length - this.renderLimit;
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
}
