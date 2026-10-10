export interface FxItemDef {
    type: string;
    label: string;
    category: "ALL" | "DYNAMICS" | "EQ & FILTER" | "DELAY & REVERB" | "MODULATION & DISTORTION";
    badge: string;
    badgeColor: string;
    defaultParams: Record<string, any>;
}

export class FxPopupMenu {
    private menuElement: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private gridContainer: HTMLDivElement;
    private tabsContainer: HTMLDivElement;
    private onSelectCallback: ((fxDef: FxItemDef) => void) | null = null;
    private isVisible: boolean = false;
    private openTime: number = 0;
    private activeTab: "ALL" | "DYNAMICS" | "EQ & FILTER" | "DELAY & REVERB" | "MODULATION & DISTORTION" = "ALL";

    private items: FxItemDef[] = [
        { type: "eq", label: "3-Band EQ", category: "EQ & FILTER", badge: "EQ", badgeColor: "#0284c7", defaultParams: { low_gain: 1.0, mid_gain: 1.0, high_gain: 1.0 } },
        { type: "compressor", label: "Compressor", category: "DYNAMICS", badge: "COMP", badgeColor: "#f59e0b", defaultParams: { threshold: -12.0, ratio: 4.0, attack: 10.0, release: 100.0 } },
        { type: "delay", label: "Stereo Delay", category: "DELAY & REVERB", badge: "DLY", badgeColor: "#10b981", defaultParams: { delay_time: 0.25, feedback: 0.4, mix: 0.3 } },
        { type: "reverb", label: "Reverb", category: "DELAY & REVERB", badge: "VERB", badgeColor: "#8b5cf6", defaultParams: { room_size: 0.5, mix: 0.3 } },
        { type: "filter", label: "Cutoff Filter", category: "EQ & FILTER", badge: "FLTR", badgeColor: "#ec4899", defaultParams: { mode: "lowpass", cutoff: 1000.0 } },
        { type: "distortion", label: "Overdrive", category: "MODULATION & DISTORTION", badge: "DIST", badgeColor: "#ef4444", defaultParams: { drive: 3.0, mix: 0.5 } },
        { type: "chorus", label: "Stereo Chorus", category: "MODULATION & DISTORTION", badge: "CHOR", badgeColor: "#06b6d4", defaultParams: { rate: 1.5, depth: 0.005, mix: 0.4 } },
        { type: "limiter", label: "Peak Limiter", category: "DYNAMICS", badge: "LMT", badgeColor: "#84cc16", defaultParams: { threshold: -0.1 } },
        { type: "gain", label: "Gain Stage", category: "DYNAMICS", badge: "GAIN", badgeColor: "#64748b", defaultParams: { gain: 1.0 } }
    ];

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'td-node-popup-container fx-popup-container sin-menu-surface';
        this.menuElement.style.display = 'none';

        // Header
        const header = document.createElement('div');
        header.className = 'td-node-popup-header';

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'td-node-popup-search';
        this.searchInput.placeholder = 'Search FX...';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'td-node-popup-close';
        closeBtn.innerText = 'Close';
        closeBtn.onclick = () => this.hide();

        header.appendChild(this.searchInput);
        header.appendChild(closeBtn);

        // Tabs
        this.tabsContainer = document.createElement('div');
        this.tabsContainer.className = 'td-node-popup-tabs';

        const categories: Array<"ALL" | "DYNAMICS" | "EQ & FILTER" | "DELAY & REVERB" | "MODULATION & DISTORTION"> = [
            "ALL", "DYNAMICS", "EQ & FILTER", "DELAY & REVERB", "MODULATION & DISTORTION"
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
            empty.innerText = query ? `No matching FX for "${query}"` : `No FX in ${this.activeTab}`;
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
                    this.onSelectCallback(item);
                }
                this.hide();
            };

            el.onpointerdown = selectHandler;
            el.onclick = selectHandler;

            this.gridContainer.appendChild(el);
        });
    }

    show(x: number, y: number, onSelect: (fxDef: FxItemDef) => void) {
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
