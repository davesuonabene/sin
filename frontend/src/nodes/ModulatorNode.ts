import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { CanvasButton } from '../ui/CanvasButton';

export function getDefaultModulatorChain() {
    return [
        {
            id: "lfo_" + Math.random().toString(36).substring(2, 8),
            type: "lfo",
            name: "LFO Generator",
            enabled: true,
            params: {
                shape: "sine",
                rate: 1.0,
                depth: 1.0,
                phase: 0.0
            }
        }
    ];
}

export class ModulatorNode extends BaseNode {
    constructor() {
        super();
        this.size = [200, 44];
        this.shape = LiteGraph.BOX_SHAPE || 1;

        this.color = "#9333ea";
        this.bgcolor = "#9333ea";
        this.boxcolor = "#7e22ce";

        if (!this.properties) {
            this.properties = {};
        }
        this.properties.node_type = "modulator";
        this.properties.node_name = this.properties.node_name || "Modulator";
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultModulatorChain();
        }

        // Remove render button for modulator node so only remove button remains
        this.buttons = [];
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
        this.addButton(this.removeBtn);
    }

    computeSize(): [number, number] {
        const fullName = this.properties?.node_name || this.title || "Modulator";
        let textWidth = 80;
        if (typeof document !== 'undefined') {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.font = "bold 14px Arial";
                textWidth = ctx.measureText(fullName).width;
            }
        }
        const desiredWidth = Math.ceil(textWidth + 60);
        const finalWidth = Math.max(180, Math.min(300, desiredWidth));
        return [finalWidth, 44];
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "Modulator";
    }
}

LiteGraph.registerNodeType("Audio/Modulator", ModulatorNode);
