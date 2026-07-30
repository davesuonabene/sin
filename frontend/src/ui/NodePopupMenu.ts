export interface PopupNodeItem {
    type: "sample" | "sample_pool" | "sequence" | "track" | string;
    label: string;
    category: "NODES" | "GROUPS" | "PRESETS" | "MODULATORS" | "ADDONS";
    badge: string;
    badgeColor: string;
    isCallable?: boolean;
}

export class NodePopupMenu {
    private menuElement: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private gridContainer: HTMLDivElement;
    private tabsContainer: HTMLDivElement;
    private onSelectCallback: ((nodeType: "sample" | "sample_pool" | "sequence" | "track") => void) | null = null;
    private isVisible: boolean = false;
    private openTime: number = 0;
    private activeTab: "NODES" | "GROUPS" | "PRESETS" | "MODULATORS" | "ADDONS" = "NODES";

    private items: PopupNodeItem[] = [
        // NODES
        { type: "sample", label: "Sample Node", category: "NODES", badge: "SMPL", badgeColor: "#10b981", isCallable: true },
        { type: "sample_pool", label: "Sample Pool Node", category: "NODES", badge: "POOL", badgeColor: "#8b5cf6", isCallable: true },
        { type: "sequence", label: "Sequence Node", category: "NODES", badge: "SEQ", badgeColor: "#ec4899", isCallable: true },
        { type: "track", label: "Track Node", category: "NODES", badge: "TRACK", badgeColor: "#3b82f6", isCallable: true },
        
        // GROUPS
        { type: "group", label: "Group Container", category: "GROUPS", badge: "GRP", badgeColor: "#8b5cf6", isCallable: false },
        
        // PRESETS
        { type: "preset_drum", label: "4x4 Drum Kit", category: "PRESETS", badge: "PSET", badgeColor: "#f59e0b", isCallable: false },
        { type: "preset_synth", label: "Synth Lead", category: "PRESETS", badge: "PSET", badgeColor: "#84cc16", isCallable: false },

        // MODULATORS
        { type: "mod_lfo", label: "LFO Generator", category: "MODULATORS", badge: "MOD", badgeColor: "#06b6d4", isCallable: false },
        { type: "mod_env", label: "ADSR Envelope", category: "MODULATORS", badge: "MOD", badgeColor: "#06b6d4", isCallable: false },

        // ADDONS
        { type: "addon_analyzer", label: "Spectrum Analyzer", category: "ADDONS", badge: "ADD", badgeColor: "#14b8a6", isCallable: false }
    ];

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'td-node-popup-container';
        this.menuElement.style.display = 'none';

        // Header
        const header = document.createElement('div');
        header.className = 'td-node-popup-header';

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search OP...';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'td-node-popup-close';
        closeBtn.innerText = '✕';
        closeBtn.onclick = () => this.hide();

        header.appendChild(this.searchInput);
        header.appendChild(closeBtn);

        // Tabs
        this.tabsContainer = document.createElement('div');
        this.tabsContainer.className = 'td-node-popup-tabs';

        const categories: Array<"NODES" | "GROUPS" | "PRESETS" | "MODULATORS" | "ADDONS"> = [
            "NODES", "GROUPS", "PRESETS", "MODULATORS", "ADDONS"
        ];

        categories.forEach(cat => {
            const tab = document.createElement('div');
            tab.className = `td-node-popup-tab ${cat === this.activeTab ? 'active' : ''}`;
            tab.setAttribute('data-category', cat);
            tab.innerText = cat;
            tab.onclick = () => {
                this.activeTab = cat;
                this.updateTabsStyle();
                this.renderGrid();
            };
            this.tabsContainer.appendChild(tab);
        });

        // Grid
        this.gridContainer = document.createElement('div');
        this.gridContainer.className = 'td-node-popup-grid';

        this.menuElement.appendChild(header);
        this.menuElement.appendChild(this.tabsContainer);
        this.menuElement.appendChild(this.gridContainer);

        document.body.appendChild(this.menuElement);

        // Search Filter Event
        this.searchInput.addEventListener('input', () => {
            this.renderGrid();
        });

        // Dismissal Handlers
        const outsideDismissHandler = (e: Event) => {
            if (this.isVisible && Date.now() - this.openTime > 200 && !this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        };

        window.addEventListener('pointerdown', outsideDismissHandler, true);
        window.addEventListener('click', outsideDismissHandler, true);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    private updateTabsStyle() {
        const tabs = this.tabsContainer.querySelectorAll('.td-node-popup-tab');
        tabs.forEach(tab => {
            const cat = tab.getAttribute('data-category');
            if (cat === this.activeTab) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
    }

    private renderGrid() {
        this.gridContainer.innerHTML = '';
        const query = this.searchInput.value.toLowerCase().trim();

        // If query is present, search across all categories; otherwise filter by active tab
        const filtered = this.items.filter(item => {
            const matchesQuery = item.label.toLowerCase().includes(query) || item.type.toLowerCase().includes(query);
            if (query.length > 0) return matchesQuery;
            return item.category === this.activeTab;
        });

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matching OPs for "${query}"` : `No items in ${this.activeTab}`;
            this.gridContainer.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            const el = document.createElement('div');
            el.className = 'td-node-popup-item';
            if (!item.isCallable) {
                el.style.opacity = '0.5';
            }

            el.innerHTML = `
                <span class="item-badge" style="background-color: ${item.badgeColor}">${item.badge}</span>
                <span class="item-label">${item.label}</span>
            `;

            const selectHandler = (e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                if (item.isCallable && (item.type === "sample" || item.type === "sample_pool" || item.type === "sequence" || item.type === "track")) {
                    if (this.onSelectCallback) {
                        this.onSelectCallback(item.type as any);
                    }
                    this.hide();
                }
            };

            el.onpointerdown = selectHandler;
            el.onclick = selectHandler;

            this.gridContainer.appendChild(el);
        });
    }

    show(x: number, y: number, onSelect: (nodeType: "sample" | "sample_pool" | "sequence" | "track") => void) {
        this.openTime = Date.now();
        this.onSelectCallback = onSelect;
        this.activeTab = "NODES";
        this.searchInput.value = '';
        this.updateTabsStyle();
        this.renderGrid();

        this.menuElement.style.display = 'flex';

        // Constrain popup menu within viewport
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
        this.isVisible = false;
        this.onSelectCallback = null;
    }
}

