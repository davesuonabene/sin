export class NodePopupMenu {
    private menuElement: HTMLDivElement;
    private onSelectCallback: ((nodeType: "sample" | "sequence" | "track") => void) | null = null;
    private isVisible: boolean = false;
    private openTime: number = 0;

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'node-popup-menu';
        this.menuElement.style.position = 'fixed';
        this.menuElement.style.zIndex = '10000';
        this.menuElement.style.display = 'none';
        this.menuElement.style.backgroundColor = '#1e293b';
        this.menuElement.style.border = '1px solid #334155';
        this.menuElement.style.borderRadius = '8px';
        this.menuElement.style.padding = '6px';
        this.menuElement.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3)';
        this.menuElement.style.minWidth = '140px';
        this.menuElement.style.backdropFilter = 'blur(8px)';
        this.menuElement.style.userSelect = 'none';

        const options: { type: "sample" | "sequence" | "track"; label: string; icon: string; color: string }[] = [
            { type: "sample", label: "Sample Node", icon: "🎵", color: "#10b981" },
            { type: "sequence", label: "Sequence Node", icon: "🔄", color: "#ec4899" },
            { type: "track", label: "Track Node", icon: "📁", color: "#3b82f6" },
        ];

        options.forEach(opt => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            item.style.padding = '8px 12px';
            item.style.borderRadius = '6px';
            item.style.cursor = 'pointer';
            item.style.color = '#f8fafc';
            item.style.fontSize = '13px';
            item.style.fontWeight = '500';
            item.style.transition = 'background 0.15s ease, transform 0.1s ease';

            item.innerHTML = `
                <span style="font-size: 14px;">${opt.icon}</span>
                <span>${opt.label}</span>
            `;

            item.onmouseover = () => {
                item.style.backgroundColor = '#334155';
            };
            item.onmouseout = () => {
                item.style.backgroundColor = 'transparent';
            };

            const selectHandler = (e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                if (this.onSelectCallback) {
                    this.onSelectCallback(opt.type);
                }
                this.hide();
            };

            item.onpointerdown = selectHandler;
            item.onclick = selectHandler;

            this.menuElement.appendChild(item);
        });

        document.body.appendChild(this.menuElement);

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

    show(x: number, y: number, onSelect: (nodeType: "sample" | "sequence" | "track") => void) {
        this.openTime = Date.now();
        this.onSelectCallback = onSelect;
        this.menuElement.style.display = 'block';

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
    }

    hide() {
        this.menuElement.style.display = 'none';
        this.isVisible = false;
        this.onSelectCallback = null;
    }
}
