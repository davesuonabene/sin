export class LibraryPanel {
    private container: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private listContainer: HTMLDivElement;
    private items: any[] = [];
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

        // List
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'td-library-list';

        this.container.appendChild(header);
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
            this.renderList();
        } catch (e) {
            console.error("Failed to fetch library", e);
            this.listContainer.innerHTML = '<div class="td-node-popup-empty">Error loading library</div>';
        }
    }

    private renderList() {
        this.listContainer.innerHTML = '';
        const query = this.searchInput.value.toLowerCase().trim();

        const filtered = this.items.filter(item => {
            if (!query) return true;
            return item.name.toLowerCase().includes(query) || item.absolute_path.toLowerCase().includes(query);
        });

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matches for "${query}"` : 'Library is empty';
            this.listContainer.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            const el = document.createElement('div');
            el.className = 'td-node-popup-item'; // Reuse item style
            
            // Use type if available, otherwise 'audio'
            let typeName = item.type ? item.type.toUpperCase() : 'AUDIO';
            let badgeColor = "#10b981"; // Sample green

            el.innerHTML = `
                <span class="item-badge" style="background-color: ${badgeColor}">${typeName}</span>
                <span class="item-label" title="${item.absolute_path}">${item.name}</span>
            `;

            el.draggable = true;
            el.ondragstart = (e) => {
                if (e.dataTransfer) {
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        type: 'library-item',
                        filepath: item.absolute_path,
                        name: item.name
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

                if (item.id) {
                    this.currentAudio = new Audio(`/api/library/stream/${item.id}`);
                    this.currentAudio.play().catch(e => console.error("Preview failed", e));
                    el.style.backgroundColor = 'rgba(56, 189, 248, 0.15)';
                    el.style.borderColor = '#38bdf8';
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
