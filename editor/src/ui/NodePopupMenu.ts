export type SupportedNodeType = "sample" | "sequence" | "track" | "arrangement";

export interface PopupNodeItem {
    type: SupportedNodeType;
    label: string;
    badge: string;
    badgeColor: string;
}

export interface NodePopupMenuShowOptions {
    mode?: 'default' | 'insert';
    placeholder?: string;
}

export class NodePopupMenu {
    private menuElement: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private gridContainer: HTMLDivElement;
    private tabsContainer: HTMLDivElement;
    private onSelectCallback: ((nodeType: SupportedNodeType) => void) | null = null;
    private isVisible: boolean = false;
    private openTime: number = 0;
    private mode: 'default' | 'insert' = 'default';

    private readonly items: PopupNodeItem[] = [
        { type: "sample", label: "Sample Node", badge: "SMPL", badgeColor: "#10b981" },
        { type: "sequence", label: "Sequence Node", badge: "SEQ", badgeColor: "#ec4899" },
        { type: "track", label: "Track Node", badge: "TRACK", badgeColor: "#3b82f6" },
        { type: "arrangement", label: "Arrangement Node", badge: "ARR", badgeColor: "#f59e0b" },
    ];

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'td-node-popup-container sin-menu-surface';
        this.menuElement.style.display = 'none';

        const header = document.createElement('div');
        header.className = 'td-node-popup-header';

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search OP...';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'td-node-popup-close';
        closeBtn.innerText = 'Close';
        closeBtn.onclick = () => this.hide();

        header.appendChild(this.searchInput);
        header.appendChild(closeBtn);

        // Single non-switchable NODES tab (shows only active callable nodes)
        this.tabsContainer = document.createElement('div');
        this.tabsContainer.className = 'td-node-popup-tabs';
        const tab = document.createElement('div');
        tab.className = 'td-node-popup-tab active';
        tab.setAttribute('data-category', 'NODES');
        tab.innerText = 'NODES';
        this.tabsContainer.appendChild(tab);

        this.gridContainer = document.createElement('div');
        this.gridContainer.className = 'td-node-popup-grid';

        this.menuElement.appendChild(header);
        this.menuElement.appendChild(this.tabsContainer);
        this.menuElement.appendChild(this.gridContainer);

        this.menuElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        document.body.appendChild(this.menuElement);

        this.searchInput.addEventListener('input', () => {
            this.renderGrid();
        });

        const outsideDismissHandler = (e: Event) => {
            if (this.isVisible && Date.now() - this.openTime > 200 && !this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        };

        window.addEventListener('pointerdown', outsideDismissHandler, true);
        window.addEventListener('click', outsideDismissHandler, true);
        window.addEventListener('contextmenu', (e) => {
            if (this.isVisible) {
                e.preventDefault();
                if (Date.now() - this.openTime > 200 && !this.menuElement.contains(e.target as Node)) {
                    this.hide();
                }
            }
        }, true);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    private renderGrid() {
        this.gridContainer.innerHTML = '';
        const query = this.searchInput.value.toLowerCase().trim();

        const filtered = this.items.filter(item => {
            if (this.mode === 'insert' && item.type === 'sample') {
                return false;
            }
            if (query.length === 0) return true;
            return item.label.toLowerCase().includes(query) || item.type.toLowerCase().includes(query);
        });

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matching OPs for "${query}"` : 'No nodes available';
            this.gridContainer.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            const el = document.createElement('div');
            el.className = 'td-node-popup-item sin-menu-item';
            el.style.setProperty('--menu-row-accent', item.badgeColor);
            el.innerHTML = `<span class="item-label">${item.label}</span>`;

            const selectHandler = (e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                if (this.onSelectCallback) {
                    this.onSelectCallback(item.type);
                }
                this.hide();
            };

            el.onpointerdown = selectHandler;
            el.onclick = selectHandler;

            this.gridContainer.appendChild(el);
        });
    }

    show(
        x: number,
        y: number,
        onSelect: (nodeType: SupportedNodeType) => void,
        options?: NodePopupMenuShowOptions
    ) {
        this.openTime = Date.now();
        this.onSelectCallback = onSelect;
        this.mode = options?.mode || 'default';
        this.searchInput.value = '';
        this.searchInput.placeholder = options?.placeholder || (this.mode === 'insert' ? 'Insert OP into cable...' : 'Search OP...');
        this.menuElement.classList.toggle('is-cable-insert', this.mode === 'insert');
        this.renderGrid();

        this.menuElement.style.display = 'flex';

        const rect = this.menuElement.getBoundingClientRect();
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        let posX = x;
        let posY = y;

        if (posX + rect.width > winWidth - 10) {
            posX = winWidth - rect.width - 10;
        }
        if (posY + rect.height > winHeight - 10) {
            posY = winHeight - rect.height - 10;
        }

        this.menuElement.style.left = `${Math.max(10, posX)}px`;
        this.menuElement.style.top = `${Math.max(10, posY)}px`;
        this.isVisible = true;

        setTimeout(() => this.searchInput.focus(), 50);
    }

    hide() {
        this.menuElement.style.display = 'none';
        this.menuElement.classList.remove('is-cable-insert');
        this.mode = 'default';
        this.searchInput.placeholder = 'Search OP...';
        this.isVisible = false;
        this.onSelectCallback = null;
    }
}
