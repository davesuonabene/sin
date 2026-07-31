export class LibraryPanel {
    private container: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private filterContainer: HTMLDivElement;
    private typeChipsContainer: HTMLDivElement;
    private tagChipsContainer: HTMLDivElement;
    private listContainer: HTMLDivElement;
    private items: any[] = [];
    private selectedTypes: Set<string> = new Set();
    private selectedTags: Set<string> = new Set();
    private previewEnabled: boolean = true;
    private currentAudio: HTMLAudioElement | null = null;
    private playingRow: HTMLElement | null = null;

    constructor(parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.className = 'td-library-panel';
        
        // Header
        const header = document.createElement('div');
        header.className = 'td-node-popup-header';
        
        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search loops...';
        
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
        refreshBtn.className = 'td-node-popup-close'; // Reuse style for simplicity
        refreshBtn.innerText = '↻';
        refreshBtn.title = 'Refresh Library';
        refreshBtn.onclick = () => this.fetchLibrary();

        header.appendChild(this.searchInput);
        header.appendChild(togglePreviewBtn);
        header.appendChild(refreshBtn);

        // Filter Bar
        this.filterContainer = document.createElement('div');
        this.filterContainer.className = 'td-filter-bar';

        const typeRow = document.createElement('div');
        typeRow.className = 'td-filter-row';
        const typeLabel = document.createElement('span');
        typeLabel.className = 'td-filter-label';
        typeLabel.innerText = 'Types:';
        this.typeChipsContainer = document.createElement('div');
        this.typeChipsContainer.className = 'td-filter-chips';
        typeRow.appendChild(typeLabel);
        typeRow.appendChild(this.typeChipsContainer);

        const tagRow = document.createElement('div');
        tagRow.className = 'td-filter-row';
        const tagLabel = document.createElement('span');
        tagLabel.className = 'td-filter-label';
        tagLabel.innerText = 'Tags:';
        this.tagChipsContainer = document.createElement('div');
        this.tagChipsContainer.className = 'td-filter-chips';
        tagRow.appendChild(tagLabel);
        tagRow.appendChild(this.tagChipsContainer);

        this.filterContainer.appendChild(typeRow);
        this.filterContainer.appendChild(tagRow);

        // List
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'td-library-list';

        this.container.appendChild(header);
        this.container.appendChild(this.filterContainer);
        this.container.appendChild(this.listContainer);
        
        parent.appendChild(this.container);

        this.searchInput.addEventListener('input', () => this.renderList());

        this.fetchLibrary();
    }

    private async fetchLibrary() {
        this.listContainer.innerHTML = '<div class="td-node-popup-empty">Loading...</div>';
        try {
            const res = await fetch('/api/library');
            const data = await res.json();
            this.items = data.files || [];
            this.updateFilterUI();
            this.renderList();
        } catch (e) {
            console.error("Failed to fetch library", e);
            this.listContainer.innerHTML = '<div class="td-node-popup-empty">Error loading library</div>';
        }
    }

    private updateFilterUI() {
        const defaultTypes = ['audio', 'track', 'sample', 'loop', 'one_shot', 'midi'];
        const fileTypes = new Set<string>(defaultTypes);
        const fileTags = new Set<string>();

        this.items.forEach(item => {
            if (item.type && item.type !== 'item') fileTypes.add(item.type);
            if (Array.isArray(item.tags)) {
                item.tags.forEach((t: any) => {
                    const tagName = typeof t === 'string' ? t : (t && t.name ? t.name : null);
                    if (tagName) fileTags.add(tagName);
                });
            }
        });

        // Type Chips
        this.typeChipsContainer.innerHTML = '';
        Array.from(fileTypes).sort().forEach(type => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `td-filter-chip ${this.selectedTypes.has(type) ? 'active' : ''}`;
            chip.innerText = type;
            chip.onclick = (e) => {
                e.stopPropagation();
                if (this.selectedTypes.has(type)) {
                    this.selectedTypes.delete(type);
                } else {
                    this.selectedTypes.add(type);
                }
                this.updateFilterUI();
                this.renderList();
            };
            this.typeChipsContainer.appendChild(chip);
        });

        // Tag Chips
        this.tagChipsContainer.innerHTML = '';
        if (fileTags.size === 0) {
            this.tagChipsContainer.innerHTML = '<span style="font-size:10px; color:#94a3b8;">No tags available</span>';
        } else {
            Array.from(fileTags).sort().forEach(tag => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `td-filter-chip ${this.selectedTags.has(tag) ? 'active' : ''}`;
                chip.innerText = tag;
                chip.onclick = (e) => {
                    e.stopPropagation();
                    if (this.selectedTags.has(tag)) {
                        this.selectedTags.delete(tag);
                    } else {
                        this.selectedTags.add(tag);
                    }
                    this.updateFilterUI();
                    this.renderList();
                };
                this.tagChipsContainer.appendChild(chip);
            });
        }
    }

    private getEffectiveSelectedTypes(): Set<string> {
        const TYPE_HIERARCHY: Record<string, string[]> = {
            'audio': ['audio', 'item', 'track', 'sample', 'loop', 'one_shot'],
            'sample': ['sample', 'loop', 'one_shot'],
            'track': ['track'],
            'loop': ['loop'],
            'one_shot': ['one_shot'],
            'midi': ['midi']
        };
        const effective = new Set<string>();
        this.selectedTypes.forEach(t => {
            const subTypes = TYPE_HIERARCHY[t] || [t];
            subTypes.forEach(st => effective.add(st));
        });
        return effective;
    }

    private getItemType(item: any): string {
        if (item.type && item.type !== 'item') return item.type;
        const name = (item.name || item.absolute_path || '').toLowerCase();
        if (name.endsWith('.mid') || name.endsWith('.midi')) return 'midi';
        return 'audio';
    }

    private renderList() {
        this.listContainer.innerHTML = '';
        const query = this.searchInput.value.toLowerCase().trim();
        const effectiveTypes = this.getEffectiveSelectedTypes();

        const filtered = this.items.filter(item => {
            // Text Search Query
            if (query) {
                const matchesName = item.name && item.name.toLowerCase().includes(query);
                const matchesPath = item.absolute_path && item.absolute_path.toLowerCase().includes(query);
                if (!matchesName && !matchesPath) return false;
            }

            // Type Filter with Inheritance
            if (this.selectedTypes.size > 0) {
                const itemType = this.getItemType(item);
                if (!effectiveTypes.has(itemType)) {
                    return false;
                }
            }

            // Tag Filter
            if (this.selectedTags.size > 0) {
                const itemTags = Array.isArray(item.tags)
                    ? item.tags.map((t: any) => typeof t === 'string' ? t : t.name)
                    : [];
                const hasMatchingTag = itemTags.some((t: string) => {
                    if (!t) return false;
                    return Array.from(this.selectedTags).some(st => t === st || t.startsWith(st + '/') || t.startsWith(st + ':'));
                });
                if (!hasMatchingTag) return false;
            }

            return true;
        });

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matches for "${query}"` : 'No matching items';
            this.listContainer.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            const el = document.createElement('div');
            el.className = 'td-node-popup-item'; // Reuse item style
            
            // Use type if available, otherwise 'audio'
            let typeName = item.type ? item.type.toUpperCase() : 'AUDIO';
            let badgeColor = "#10b981"; // Sample green
            if (item.type === 'midi' || item.name.endsWith('.mid') || item.name.endsWith('.midi')) {
                typeName = 'MIDI';
                badgeColor = '#8b5cf6'; // Midi purple
            } else if (item.type === 'loop') {
                badgeColor = '#0284c7'; // Loop blue
            }

            const metaParts: string[] = [];
            if (item.bpm) metaParts.push(`${item.bpm} BPM`);
            if (item.key) metaParts.push(item.key);
            const metaStr = metaParts.length > 0 ? `<span style="font-size: 11px; color: #64748b; margin-left: 6px; font-weight: normal;">(${metaParts.join(' • ')})</span>` : '';

            el.innerHTML = `
                <span class="item-badge" style="background-color: ${badgeColor}">${typeName}</span>
                <span class="item-label" title="${item.absolute_path}">${item.name}${metaStr}</span>
            `;

            el.draggable = true;
            el.ondragstart = (e) => {
                if (e.dataTransfer) {
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        type: 'library-item',
                        itemType: item.type || 'audio',
                        id: item.id,
                        filepath: item.absolute_path,
                        name: item.name,
                        key: item.key || null,
                        bpm: item.bpm || null
                    }));
                }
            };

            el.onclick = () => {
                if (!this.previewEnabled) return;
                
                if (this.currentAudio) {
                    this.currentAudio.pause();
                    if (this.playingRow) {
                        this.playingRow.style.backgroundColor = '';
                        this.playingRow.style.borderColor = '';
                    }
                }
                
                // Toggle pause if clicking the same currently playing row
                if (this.playingRow === el) {
                    this.playingRow = null;
                    return;
                }

                if (item.type === 'midi' || item.name.endsWith('.mid') || item.name.endsWith('.midi')) {
                    // Highlight row for MIDI without audio playback
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
                    this.currentAudio = new Audio(`/api/library/stream/${item.id}`);
                    this.currentAudio.play().catch(e => console.error("Preview failed", e));
                    el.style.backgroundColor = 'rgba(2, 132, 199, 0.12)';
                    el.style.borderColor = '#0284c7';
                    this.playingRow = el;
                    
                    this.currentAudio.onended = () => {
                        el.style.backgroundColor = '';
                        el.style.borderColor = '';
                        if (this.playingRow === el) this.playingRow = null;
                    };
                }
            };

            this.listContainer.appendChild(el);
        });
    }
}
