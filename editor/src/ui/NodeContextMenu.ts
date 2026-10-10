export interface NodeContextMenuItem {
    id: string;
    label: string;
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
        this.menuElement.className = 'td-node-context-menu sin-menu-surface';
        this.menuElement.style.display = 'none';

        this.menuElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        document.body.appendChild(this.menuElement);

        const dismissHandler = (e: Event) => {
            if (this.isVisible && Date.now() - this.openTime > 150 && !this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        };

        window.addEventListener('pointerdown', dismissHandler, true);
        window.addEventListener('click', dismissHandler, true);
        window.addEventListener('contextmenu', (e) => {
            if (this.isVisible) {
                e.preventDefault();
                if (Date.now() - this.openTime > 150 && !this.menuElement.contains(e.target as Node)) {
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
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'render',
                label: 'Render (Save to Temp)',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('render-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'properties',
                label: 'Open Parameters',
                action: (n) => {
                    if (typeof (window as any).openParamWindow === 'function') {
                        (window as any).openParamWindow(n);
                    }
                }
            },
            {
                id: 'modulator',
                label: 'Add Modulator',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('add-modulator-node', { detail: { parentId: n.id } }));
                }
            },
            {
                id: 'random',
                label: 'Add Random Mod',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('add-random-node', { detail: { parentId: n.id } }));
                }
            },
            {
                id: 'create-ghost',
                label: 'Create Ghost',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('create-ghost-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'main-preview',
                label: (window as any).isManualMainPreviewNode?.(node.id)
                    ? 'Use Automatic Main Preview'
                    : 'Set as Main Preview',
                action: (n) => {
                    window.dispatchEvent(new CustomEvent('set-main-preview-node', { detail: { nodeId: n.id } }));
                }
            },
            {
                id: 'delete',
                label: 'Delete Node',
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

        items
            .filter(item => item.id !== 'main-preview' || node.canBeMainPreview?.())
            .forEach(item => {
            const row = document.createElement('div');
            row.className = `ctx-menu-item sin-menu-item ${item.danger ? 'danger' : ''}`;
            row.textContent = item.label;

            row.onpointerdown = (e) => {
                e.stopPropagation();
            };

            row.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                const targetNode = this.targetNode;
                this.hide();
                if (targetNode) item.action(targetNode);
            };

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
