import { LiteGraph, LGraphNode } from 'litegraph.js';
import { CanvasButton } from '../ui/CanvasButton';

let measureCtx: CanvasRenderingContext2D | null = null;

function truncateText(text: string, maxWidth: number, font: string = "bold 14px Arial"): string {
    if (!text) return "";
    if (typeof document === 'undefined') return text;
    if (!measureCtx) {
        const c = document.createElement('canvas');
        measureCtx = c.getContext('2d');
    }
    if (measureCtx) {
        measureCtx.font = font;
        if (measureCtx.measureText(text).width <= maxWidth) {
            return text;
        }
        let truncated = text;
        while (truncated.length > 0 && measureCtx.measureText(truncated + '...').width > maxWidth) {
            truncated = truncated.slice(0, -1);
        }
        return truncated + '...';
    }
    return text;
}

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
        const fullName = this.properties?.node_name || this.title || "AudioNode";
        if (typeof document !== 'undefined' && !measureCtx) {
            const c = document.createElement('canvas');
            measureCtx = c.getContext('2d');
        }
        let textWidth = 80;
        if (measureCtx) {
            measureCtx.font = "bold 14px Arial";
            textWidth = measureCtx.measureText(fullName).width;
        }
        // Reserved width for buttons (-76, -50, -24) + margins (~110px total)
        const desiredWidth = Math.ceil(textWidth + 110);
        // Min width 200px, max width 360px
        const finalWidth = Math.max(200, Math.min(360, desiredWidth));
        return [finalWidth, 44];
    }

    getTitle(): string {
        const fullName = this.properties?.node_name || this.title || "AudioNode";
        const nodeWidth = this.size ? this.size[0] : 200;
        // Available header width for text (reserving ~85px for buttons on right)
        const availWidth = Math.max(40, nodeWidth - 85);
        return truncateText(fullName, availWidth, "bold 14px Arial");
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

    onConnectionsChange(type: number, slotIndex: number, isConnected: boolean, link_info: any, ioSlot: any) {
        if (type === LiteGraph.INPUT && this.inputs && this.inputs.length > 0) {
            this.ensureEmptyInput();
        }
    }

    ensureEmptyInput() {
        if (!this.inputs) return;
        
        // Remove extra empty inputs from the end
        for (let i = this.inputs.length - 1; i >= 1; i--) {
            if (!this.inputs[i].link && !this.inputs[i-1].link) {
                this.removeInput(i);
            } else {
                break;
            }
        }

        // Ensure at least one empty input at the end
        const lastInput = this.inputs[this.inputs.length - 1];
        if (lastInput && lastInput.link != null) {
            this.addInput("Input", "audio");
        }
    }

    getConnectionPos(is_input: boolean, slot_number: number | string, out?: any): any {
        out = out || new Float32Array(2);
        if (is_input) {
            out[0] = this.pos[0];
            out[1] = this.pos[1] + this.size[1] * 0.5;
        } else {
            out[0] = this.pos[0] + this.size[0];
            out[1] = this.pos[1] + this.size[1] * 0.5;
        }
        return out;
    }

    onRemoved() {
        // Automatically notify application when node is deleted
        window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
    }
}
