import { LiteGraph, LGraphNode } from 'litegraph.js';
import { CanvasButton } from '../ui/CanvasButton';

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
        this.size = [64, 64];
        this.shape = LiteGraph.BOX_SHAPE || 1;
        
        if (!this.properties) {
            this.properties = {};
        }
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultFxChain();
        }

        // Action buttons positioned floating on the right side of the node
        this.renderBtn = new CanvasButton(
            68, 4, 18, 18, "▶", "#3b82f6", "#2563eb",
            () => {
                window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: this.id } }));
            }
        );

        this.modulatorBtn = new CanvasButton(
            68, 24, 18, 18, "⚡", "#a855f7", "#9333ea",
            () => {
                window.dispatchEvent(new CustomEvent('add-modulator-node', { detail: { parentId: this.id } }));
            }
        );

        this.removeBtn = new CanvasButton(
            68, 44, 18, 18, "✕", "#ef4444", "#dc2626",
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
        return [64, 64];
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "AudioNode";
    }

    isPointInside(x: number, y: number, margin: number = 0): boolean {
        const width = 64;
        const height = 64;
        const isHoveredOrSelected = Boolean(this.is_selected || ((window as any).editorCanvas?.node_over === this));
        const extraRight = isHoveredOrSelected ? 28 : 0;
        const extraTop = isHoveredOrSelected ? 32 : 0;

        return (
            x >= this.pos[0] - margin - 20 &&
            x <= this.pos[0] + width + margin + extraRight &&
            y >= this.pos[1] - margin - extraTop &&
            y <= this.pos[1] + height + margin
        );
    }

    onDrawForeground(ctx: CanvasRenderingContext2D, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;
        
        if (isHovered || isSelected) {
            for (const btn of this.buttons) {
                btn.draw(ctx, this);
            }
        }
    }

    onMouseMove(_e: MouseEvent, local_pos: any, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;
        if (!isHovered && !isSelected) return;

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

    onMouseDown(_e: MouseEvent, local_pos: any, canvas: any): boolean {
        if (this.flags.collapsed || (this.flags as any).hidden) return false;

        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;

        if (local_pos && local_pos.length >= 2) {
            const x = local_pos[0];
            const y = local_pos[1];
            if (isHovered || isSelected) {
                for (const btn of this.buttons) {
                    if (btn.checkHit(x, y, this)) {
                        btn.onClick(_e);
                        return true;
                    }
                }
            }
        }

        // Trigger node selection & open properties window
        if (canvas) {
            canvas.selectNode(this);
            if (typeof (window as any).openParamWindow === 'function') {
                (window as any).openParamWindow(this);
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
        const width = 64;
        const height = 64;

        if (is_input) {
            // Lateral left connection
            out[0] = this.pos[0];
            out[1] = this.pos[1] + height * 0.5;
        } else {
            // Lateral right connection
            out[0] = this.pos[0] + width;
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
