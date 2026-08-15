export interface ModulatorItemDef {
    type: string;
    label: string;
    category: "ALL" | "GENERATORS" | "MODIFIERS";
    badge: string;
    badgeColor: string;
    defaultParams: Record<string, any>;
}

export class ModulatorPopupMenu {
    private menuElement: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private gridContainer: HTMLDivElement;
    private tabsContainer: HTMLDivElement;
    private onSelectCallback: ((itemDef: ModulatorItemDef) => void) | null = null;
    private isVisible: boolean = false;
    private openTime: number = 0;
    private activeTab: "ALL" | "GENERATORS" | "MODIFIERS" = "ALL";

    private items: ModulatorItemDef[] = [
        { type: "lfo", label: "LFO Generator", category: "GENERATORS", badge: "LFO", badgeColor: "#a855f7", defaultParams: { shape: "sine", rate: 1.0, depth: 1.0, phase: 0.0 } },
        { type: "envelope", label: "ADSR Envelope", category: "GENERATORS", badge: "ENV", badgeColor: "#3b82f6", defaultParams: { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.5 } },
        { type: "trigger", label: "Pulse Trigger", category: "GENERATORS", badge: "TRIG", badgeColor: "#f59e0b", defaultParams: { rate: 2.0, pulse_width: 0.5, threshold: 0.5 } },
        { type: "noise", label: "Random / Noise", category: "GENERATORS", badge: "NOISE", badgeColor: "#ec4899", defaultParams: { type: "white", rate: 4.0, smooth: 0.1 } },
        { type: "scale", label: "Scale & Offset", category: "MODIFIERS", badge: "SCL", badgeColor: "#10b981", defaultParams: { multiplier: 1.0, offset: 0.0 } },
        { type: "clamp", label: "Min / Max Clamp", category: "MODIFIERS", badge: "CLMP", badgeColor: "#06b6d4", defaultParams: { min: 0.0, max: 1.0 } },
        { type: "invert", label: "Signal Inverter", category: "MODIFIERS", badge: "INV", badgeColor: "#ef4444", defaultParams: { amount: 1.0 } },
        { type: "smooth", label: "Slew Smoother", category: "MODIFIERS", badge: "SMTH", badgeColor: "#84cc16", defaultParams: { rise: 0.05, fall: 0.05 } }
    ];

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'td-node-popup-container mod-popup-container';
        this.menuElement.style.display = 'none';

        // Header
        const header = document.createElement('div');
        header.className = 'td-node-popup-header';

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search Modulator Modules...';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'td-node-popup-close';
        closeBtn.innerText = '✕';
        closeBtn.onclick = () => this.hide();

        header.appendChild(this.searchInput);
        header.appendChild(closeBtn);

        // Tabs
        this.tabsContainer = document.createElement('div');
        this.tabsContainer.className = 'td-node-popup-tabs';

        const categories: Array<"ALL" | "GENERATORS" | "MODIFIERS"> = [
            "ALL", "GENERATORS", "MODIFIERS"
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

        const filtered = this.items.filter(item => {
            const matchesQuery = item.label.toLowerCase().includes(query) || item.type.toLowerCase().includes(query);
            if (query.length > 0) return matchesQuery;
            if (this.activeTab === "ALL") return true;
            return item.category === this.activeTab;
        });

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'td-node-popup-empty';
            empty.innerText = query ? `No matching module for "${query}"` : `No items in ${this.activeTab}`;
            this.gridContainer.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            const el = document.createElement('div');
            el.className = 'td-node-popup-item';

            el.innerHTML = `
                <span class="item-badge" style="background-color: ${item.badgeColor}">${item.badge}</span>
                <span class="item-label">${item.label}</span>
            `;

            const selectHandler = (e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                if (this.onSelectCallback) {
                    this.onSelectCallback(item);
                }
                this.hide();
            };

            el.onpointerdown = selectHandler;
            el.onclick = selectHandler;

            this.gridContainer.appendChild(el);
        });
    }

    show(x: number, y: number, onSelect: (itemDef: ModulatorItemDef) => void) {
        this.openTime = Date.now();
        this.onSelectCallback = onSelect;
        this.activeTab = "ALL";
        this.searchInput.value = '';
        this.updateTabsStyle();
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
        this.isVisible = false;
        this.onSelectCallback = null;
    }
}
