export interface NodeContextMenuItem {
    id: string;
    label: string;
    icon: string;
    action: (node: any) => void;
    danger?: boolean;
}

export class NodeContextMenu {
    private menuElement: HTMLDivElement;
    private targetNode: any = null;
    private isVisible: boolean = false;
    private openTime: number = 0;

    constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'td-node-context-menu';
        this.menuElement.style.display = 'none';

        document.body.appendChild(this.menuElement);

        const dismissHandler = (e: Event) => {
            if (this.isVisible && Date.now() - this.openTime > 150 && !this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        };

        window.addEventListener('pointerdown', dismissHandler, true);
        window.addEventListener('click', dismissHandler, true);
        window.addEventListener('contextmenu', (e) => {
            if (this.isVisible && !this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        }, true);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    public show(x: number, y: number, node: any) {
        this.targetNode = node;
        this.openTime = Date.now();
        this.menuElement.innerHTML = '';

        const nodeName = node.properties?.node_name || node.title || `Node #${node.id}`;

        // Context Header
        const header = document.createElement('div');
        header.className = 'ctx-menu-header';
        header.innerHTML = `
            <span class="ctx-menu-title">${nodeName}</span>
            <span class="ctx-menu-id">#${node.id}</span>
        `;
        this.menuElement.appendChild(header);

        const items: NodeContextMenuItem[] = [
            {
                id: 'preview',
                label: 'Preview (RAM)',
                icon: '▶',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'render',
                label: 'Render (Save to Temp)',
                icon: '🎬',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('render-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'properties',
                label: 'Open Parameters',
                icon: '⚙️',
                action: (n) => {
                    if (typeof (window as any).openParamWindow === 'function') {
                        (window as any).openParamWindow(n);
                    }
                }
            },
            {
                id: 'modulator',
                label: 'Add Modulator',
                icon: '⚡',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('add-modulator-node', { detail: { parentId: n.id } }));
                }
            },
            {
                id: 'create-ghost',
                label: 'Create Ghost',
                icon: 'G',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('create-ghost-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'global-refresh-highlight',
                label: node.properties?.global_refresh_highlighted
                    ? 'Remove Global Refresh Highlight'
                    : 'Highlight for Global Refresh',
                icon: node.properties?.global_refresh_highlighted ? '★' : '☆',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('toggle-global-refresh-highlight', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'delete',
                label: 'Delete Node',
                icon: '✕',
                danger: true,
                action: (n) => {
                    if (n.graph) {
                        n.graph.remove(n);
                    } else {
                        window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: n.id } }));
                    }
                }
            }
        ];

        items.forEach(item => {
            const row = document.createElement('div');
            row.className = `ctx-menu-item ${item.danger ? 'danger' : ''}`;
            row.innerHTML = `
                <span class="ctx-item-icon">${item.icon}</span>
                <span class="ctx-item-label">${item.label}</span>
            `;

            const handler = (e: Event) => {
                e.stopPropagation();
                e.preventDefault();
                const targetNode = this.targetNode;
                this.hide();
                if (targetNode) item.action(targetNode);
            };

            row.onpointerdown = handler;
            row.onclick = handler;

            this.menuElement.appendChild(row);
        });

        this.menuElement.style.display = 'flex';

        // Viewport position clamping
        const rect = this.menuElement.getBoundingClientRect();
        const winW = window.innerWidth;
        const winH = window.innerHeight;

        let posX = x;
        let posY = y;

        if (posX + rect.width > winW - 10) posX = winW - rect.width - 10;
        if (posY + rect.height > winH - 10) posY = winH - rect.height - 10;

        this.menuElement.style.left = `${Math.max(10, posX)}px`;
        this.menuElement.style.top = `${Math.max(10, posY)}px`;
        this.isVisible = true;
    }

    public hide() {
        this.menuElement.style.display = 'none';
        this.isVisible = false;
        this.targetNode = null;
    }
}
