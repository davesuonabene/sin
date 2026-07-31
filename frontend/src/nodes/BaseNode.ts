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

export function getDefaultFxChain() {
    return [
        { id: "pre_gain_" + Math.random().toString(36).substring(2, 8), type: "gain", name: "Pre Gain", enabled: true, fixed: true, params: { gain: 1.0 } },
        { id: "post_gain_" + Math.random().toString(36).substring(2, 8), type: "gain", name: "Post Gain", enabled: true, fixed: true, params: { gain: 1.0 } }
    ];
}

export abstract class BaseNode extends LGraphNode {
    buttons: CanvasButton[] = [];
    renderBtn: CanvasButton;
    modulatorBtn: CanvasButton;
    removeBtn: CanvasButton;

    constructor() {
        super();
        this.size = [200, 44];
        this.shape = LiteGraph.BOX_SHAPE || 1;
        
        if (!this.properties) {
            this.properties = {};
        }
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultFxChain();
        }

        this.renderBtn = new CanvasButton(
            -74, 12, 20, 20, "▶", "#3b82f6", "#2563eb",
            () => {
                window.dispatchEvent(new CustomEvent('render-node', { detail: { nodeId: this.id } }));
            }
        );

        this.modulatorBtn = new CanvasButton(
            -48, 12, 20, 20, "⚡", "#a855f7", "#9333ea",
            () => {
                window.dispatchEvent(new CustomEvent('add-modulator-node', { detail: { parentId: this.id } }));
            }
        );

        this.removeBtn = new CanvasButton(
            -22, 12, 20, 20, "✕", "#ef4444", "#dc2626",
            () => {
                if (this.graph) {
                    this.graph.remove(this);
                } else {
                    window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
                }
            }
        );

        this.addButton(this.renderBtn);
        this.addButton(this.modulatorBtn);
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
        // Reserved width for buttons (-74, -48, -22) + margins (~100px total)
        const desiredWidth = Math.ceil(textWidth + 100);
        // Min width 200px, max width 380px
        const finalWidth = Math.max(200, Math.min(380, desiredWidth));
        return [finalWidth, 44];
    }

    getTitle(): string {
        const fullName = this.properties?.node_name || this.title || "AudioNode";
        const nodeWidth = this.size ? this.size[0] : 200;
        // Available header width for text (reserving ~80px for buttons on right)
        const availWidth = Math.max(40, nodeWidth - 80);
        return truncateText(fullName, availWidth, "bold 14px Arial");
    }

    onDrawForeground(ctx: CanvasRenderingContext2D, _canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
        for (const btn of this.buttons) {
            btn.draw(ctx, this);
        }
    }

    onMouseMove(_e: MouseEvent, local_pos: any, _canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
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
        if (this.flags.collapsed || (this.flags as any).hidden) return false;
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

    onConnectionsChange(type: number, _slotIndex: number, _isConnected: boolean, _link_info: any, _ioSlot: any) {
        if (type === LiteGraph.INPUT && this.inputs) {
            queueMicrotask(() => {
                this.normalizeInputs();
            });
        }
        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    }

    normalizeInputs() {
        if (!this.inputs || this.inputs.length === 0) return;

        // Remove trailing excess empty inputs beyond the first empty one
        for (let i = this.inputs.length - 1; i >= 1; i--) {
            if (this.inputs[i].link == null && this.inputs[i - 1].link == null) {
                this.removeInput(i);
            } else {
                break;
            }
        }

        // Ensure at least one trailing empty input slot exists
        const lastInput = this.inputs[this.inputs.length - 1];
        if (lastInput && lastInput.link != null) {
            this.addInput("Input", "audio");
        }

        if (this.graph) {
            this.setDirtyCanvas(true, true);
        }
    }

    getConnectionPos(is_input: boolean, _slot_number: number | string, out?: any): any {
        out = out || new Float32Array(2);
        const isCollapsed = Boolean(this.flags && this.flags.collapsed);

        if (isCollapsed) {
            const width = (this as any)._collapsed_width || LiteGraph.NODE_COLLAPSED_WIDTH || 80;
            const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 44;
            out[0] = is_input ? this.pos[0] : (this.pos[0] + width);
            out[1] = this.pos[1] - titleHeight * 0.5;
        } else {
            const width = this.size ? this.size[0] : 200;
            const height = this.size ? this.size[1] : 44;
            out[0] = is_input ? this.pos[0] : (this.pos[0] + width);
            out[1] = this.pos[1] + height * 0.5;
        }
        return out;
    }

    onRemoved() {
        // Automatically notify application when node is deleted
        window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    }
}
