import { LiteGraph, LGraphNode } from 'litegraph.js';
import { CanvasButton } from '../ui/CanvasButton';

export abstract class BaseNode extends LGraphNode {
    buttons: CanvasButton[] = [];
    renderBtn: CanvasButton;
    addBtn: CanvasButton;
    removeBtn: CanvasButton;

    constructor() {
        super();
        this.size = [200, 44];
        this.shape = LiteGraph.BOX_SHAPE || 1;

        this.renderBtn = new CanvasButton(
            -76, 12, 20, 20, "▶", "#3b82f6", "#2563eb",
            () => {
                window.dispatchEvent(new CustomEvent('render-node', { detail: { nodeId: this.id } }));
            }
        );

        this.addBtn = new CanvasButton(
            -50, 12, 20, 20, "+", "#10b981", "#059669",
            (e?: MouseEvent) => {
                let screenX = 100;
                let screenY = 100;
                if (e && e.clientX != null && e.clientY != null) {
                    screenX = e.clientX;
                    screenY = e.clientY + 10;
                } else {
                    const canvasEl = document.getElementById('graph-canvas') as HTMLCanvasElement;
                    const canvas = (window as any).editorCanvas;
                    if (canvasEl && canvas) {
                        const rect = canvasEl.getBoundingClientRect();
                        const finalX = this.size[0] - 50;
                        const finalY = 12;
                        const scale = canvas.ds?.scale ?? 1;
                        const offset = canvas.ds?.offset ?? [0, 0];
                        const canvasX = (this.pos[0] + finalX) * scale + offset[0];
                        const canvasY = (this.pos[1] + finalY) * scale + offset[1];
                        screenX = rect.left + canvasX;
                        screenY = rect.top + canvasY + 24;
                    }
                }
                window.dispatchEvent(new CustomEvent('open-add-menu', {
                    detail: {
                        parentId: this.id,
                        x: screenX,
                        y: screenY
                    }
                }));
            }
        );

        this.removeBtn = new CanvasButton(
            -24, 12, 20, 20, "✕", "#ef4444", "#dc2626",
            () => {
                if (this.graph) {
                    this.graph.remove(this);
                } else {
                    window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
                }
            }
        );

        this.addButton(this.renderBtn);
        this.addButton(this.addBtn);
        this.addButton(this.removeBtn);
    }

    addButton(btn: CanvasButton) {
        this.buttons.push(btn);
    }

    computeSize(): [number, number] {
        return [200, 44];
    }

    onDrawForeground(ctx: CanvasRenderingContext2D, _canvas: any) {
        if (this.flags.collapsed) return;
        for (const btn of this.buttons) {
            btn.draw(ctx, this);
        }
    }

    onMouseMove(_e: MouseEvent, local_pos: any, _canvas: any) {
        if (this.flags.collapsed) return;
        if (!local_pos || local_pos.length < 2) return;
        const x = local_pos[0];
        const y = local_pos[1];
        let dirty = false;
        for (const btn of this.buttons) {
            const hit = btn.checkHit(x, y, this);
            if (btn.isHovered !== hit) {
                btn.isHovered = hit;
                dirty = true;
            }
        }
        if (dirty) {
            this.setDirtyCanvas(true, true);
        }
    }

    onMouseDown(_e: MouseEvent, local_pos: any, _canvas: any): boolean {
        if (this.flags.collapsed) return false;
        if (!local_pos || local_pos.length < 2) return false;
        const x = local_pos[0];
        const y = local_pos[1];
        for (const btn of this.buttons) {
            if (btn.checkHit(x, y, this)) {
                btn.onClick(_e);
                return true; // Stop event propagation in LiteGraph
            }
        }
        return false;
    }

    onRemoved() {
        // Automatically notify application when node is deleted
        window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
    }
}
