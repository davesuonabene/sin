export interface WorkspaceItem {
    name: string;
    filename?: string;
    updated_at?: number;
    size?: number;
}

export interface FileExplorerModalOptions {
    onSelect: (workspaceName: string) => Promise<void> | void;
    onDelete?: (workspaceName: string) => Promise<void> | void;
    onImportJson?: (presetData: any, filename: string) => Promise<void> | void;
    initialSearch?: string;
}

export class FileExplorerModal {
    private static currentModal: HTMLElement | null = null;
    private static keyHandler: ((e: KeyboardEvent) => void) | null = null;

    static close(): void {
        if (this.keyHandler) {
            window.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.currentModal) {
            this.currentModal.remove();
            this.currentModal = null;
        }
    }

    static async show(options: FileExplorerModalOptions): Promise<void> {
        this.close();

        const overlay = document.createElement('div');
        overlay.className = 'sin-modal file-explorer-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(15, 23, 42, 0.5)';
        overlay.style.backdropFilter = 'blur(2px)';
        overlay.style.zIndex = '10000';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const modal = document.createElement('div');
        modal.className = 'file-explorer-modal folder-picker-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'file-explorer-header';
        header.innerHTML = `
            <h4>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                Open Workspace
                <span class="file-explorer-location-badge">saves/</span>
            </h4>
            <button type="button" class="close-picker-btn td-param-action-btn" title="Close (Esc)" style="border: none; background: transparent; font-size: 13px; padding: 0 4px; cursor: pointer;">✕</button>
        `;
        modal.appendChild(header);

        // Search Bar (default search location is saves folder)
        const searchBar = document.createElement('div');
        searchBar.className = 'file-explorer-searchbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'file-explorer-search-input';
        searchInput.placeholder = 'Search saves...';
        searchInput.setAttribute('aria-label', 'Search workspaces in saves folder');
        if (options.initialSearch) searchInput.value = options.initialSearch;

        const countBadge = document.createElement('span');
        countBadge.className = 'file-explorer-count';

        searchBar.appendChild(searchInput);
        searchBar.appendChild(countBadge);
        modal.appendChild(searchBar);

        // File List Container
        const listContainer = document.createElement('div');
        listContainer.className = 'file-explorer-list';
        modal.appendChild(listContainer);

        // Footer Actions
        const footer = document.createElement('div');
        footer.className = 'file-explorer-footer';

        const browseLocalBtn = document.createElement('button');
        browseLocalBtn.type = 'button';
        browseLocalBtn.className = 'td-param-action-btn';
        browseLocalBtn.textContent = 'Browse local file…';
        browseLocalBtn.title = 'Select a JSON workspace file from local disk';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        footer.appendChild(fileInput);

        const footerRight = document.createElement('div');
        footerRight.className = 'file-explorer-footer-right';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'td-param-action-btn';
        cancelBtn.textContent = 'Cancel';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'td-param-action-btn td-param-action-primary';
        openBtn.textContent = 'Open';
        openBtn.disabled = true;

        footerRight.appendChild(cancelBtn);
        footerRight.appendChild(openBtn);

        footer.appendChild(browseLocalBtn);
        footer.appendChild(footerRight);
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        this.currentModal = overlay;

        // Fetch workspaces
        let workspaces: WorkspaceItem[] = [];
        let selectedItemName: string | null = null;
        let selectedRowElement: HTMLElement | null = null;

        const formatSize = (bytes?: number): string => {
            if (!bytes || bytes <= 0) return '';
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };

        const formatDate = (mtime?: number): string => {
            if (!mtime) return '';
            try {
                const date = new Date(mtime * 1000);
                return date.toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch {
                return '';
            }
        };

        const renderList = (filterText: string = '') => {
            const query = filterText.trim().toLowerCase();
            const filtered = workspaces.filter(w => !query || w.name.toLowerCase().includes(query));

            countBadge.textContent = `${filtered.length} save${filtered.length === 1 ? '' : 's'}`;
            listContainer.innerHTML = '';

            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'file-explorer-empty';
                empty.textContent = query
                    ? `No workspaces matching "${filterText}" in saves/`
                    : 'No workspace saves found in saves/.';
                listContainer.appendChild(empty);
                openBtn.disabled = true;
                selectedItemName = null;
                selectedRowElement = null;
                return;
            }

            // Auto-select first if none selected or current selection filtered out
            if (!selectedItemName || !filtered.some(w => w.name === selectedItemName)) {
                selectedItemName = filtered[0].name;
            }

            filtered.forEach(item => {
                const row = document.createElement('div');
                row.className = 'file-explorer-item';
                if (item.name === selectedItemName) {
                    row.classList.add('is-selected');
                    selectedRowElement = row;
                    openBtn.disabled = false;
                }

                const mainInfo = document.createElement('div');
                mainInfo.className = 'file-explorer-item-main';
                mainInfo.innerHTML = `
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #64748b; flex-shrink: 0;">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                        <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <span class="file-explorer-item-name" title="${item.name}">${item.name}</span>
                `;

                const meta = document.createElement('div');
                meta.className = 'file-explorer-item-meta';

                const dateSpan = document.createElement('span');
                dateSpan.textContent = formatDate(item.updated_at);
                meta.appendChild(dateSpan);

                if (item.size) {
                    const sizeSpan = document.createElement('span');
                    sizeSpan.textContent = formatSize(item.size);
                    meta.appendChild(sizeSpan);
                }

                if (options.onDelete) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.type = 'button';
                    deleteBtn.className = 'file-explorer-item-delete';
                    deleteBtn.title = `Delete ${item.name}`;
                    deleteBtn.innerHTML = '🗑';
                    deleteBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete workspace "${item.name}" from saves/?`)) {
                            await options.onDelete!(item.name);
                            workspaces = workspaces.filter(w => w.name !== item.name);
                            renderList(searchInput.value);
                        }
                    });
                    meta.appendChild(deleteBtn);
                }

                row.appendChild(mainInfo);
                row.appendChild(meta);

                row.addEventListener('click', () => {
                    selectedRowElement?.classList.remove('is-selected');
                    row.classList.add('is-selected');
                    selectedRowElement = row;
                    selectedItemName = item.name;
                    openBtn.disabled = false;
                });

                row.addEventListener('dblclick', async () => {
                    selectedItemName = item.name;
                    FileExplorerModal.close();
                    await options.onSelect(item.name);
                });

                listContainer.appendChild(row);
            });
        };

        const doOpenSelected = async () => {
            if (!selectedItemName) return;
            const nameToOpen = selectedItemName;
            FileExplorerModal.close();
            await options.onSelect(nameToOpen);
        };

        // Event listeners
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void doOpenSelected();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const items = Array.from(listContainer.querySelectorAll('.file-explorer-item')) as HTMLElement[];
                const curIdx = items.findIndex(el => el.classList.contains('is-selected'));
                if (curIdx < items.length - 1) {
                    items[curIdx + 1]?.click();
                    items[curIdx + 1]?.scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const items = Array.from(listContainer.querySelectorAll('.file-explorer-item')) as HTMLElement[];
                const curIdx = items.findIndex(el => el.classList.contains('is-selected'));
                if (curIdx > 0) {
                    items[curIdx - 1]?.click();
                    items[curIdx - 1]?.scrollIntoView({ block: 'nearest' });
                }
            }
        });

        openBtn.addEventListener('click', () => {
            void doOpenSelected();
        });

        cancelBtn.addEventListener('click', () => {
            FileExplorerModal.close();
        });

        header.querySelector('.close-picker-btn')?.addEventListener('click', () => {
            FileExplorerModal.close();
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                FileExplorerModal.close();
            }
        });

        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                FileExplorerModal.close();
            }
        };
        window.addEventListener('keydown', this.keyHandler);

        // Browse local disk file handler
        browseLocalBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const parsed = JSON.parse(String(reader.result));
                    FileExplorerModal.close();
                    if (options.onImportJson) {
                        await options.onImportJson(parsed, file.name);
                    }
                } catch (err) {
                    alert('Invalid JSON workspace file: ' + err);
                }
            };
            reader.readAsText(file);
        });

        // Load saves from api
        listContainer.innerHTML = '<div class="file-explorer-empty">Loading saves…</div>';
        try {
            const res = await fetch('/api/workspaces');
            if (res.ok) {
                const data = await res.json();
                workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
            }
        } catch (e) {
            console.error('Failed to load workspaces', e);
        }

        renderList(searchInput.value);
        setTimeout(() => searchInput.focus(), 20);
    }
}

