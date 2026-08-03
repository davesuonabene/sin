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
        this.size = [64, 64];
        this.shape = LiteGraph.BOX_SHAPE || 1;

        this.color = "#9333ea";
        this.bgcolor = "#9333ea";
        this.boxcolor = "#7e22ce";

        if (!this.properties) {
            this.properties = {};
        }
        this.properties.node_type = "modulator";
        this.properties.node_name = this.properties.node_name || "Modulator";
        this.properties.color = this.properties.color || "#9333ea";
        this.properties.icon = this.properties.icon || "⚡";
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultModulatorChain();
        }

        // Remove render & modulator button for modulator node so only remove button remains
        this.buttons = [];
        this.removeBtn = new CanvasButton(
            68, 4, 18, 18, "✕", "#ef4444", "#dc2626",
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
        return [64, 64];
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "Modulator";
    }
}

LiteGraph.registerNodeType("Audio/Modulator", ModulatorNode);
