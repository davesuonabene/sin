import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { CanvasButton } from '../ui/CanvasButton';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { type NodeShape } from './NodeVisuals';

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
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'MODULATOR',
                label: 'Modulator',
                sections: [
                    { type: 'fx_chain', chainKey: 'chain' }
                ]
            },
            {
                id: 'COMMON',
                label: 'Common',
                sections: [
                    { type: 'appearance' },
                    { type: 'info_table' }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Modulator', tab: 'COMMON' }
    ];
    static defaultColor = "#9333ea";
    static defaultIcon = "pulse";
    static defaultShape: NodeShape = "triangle";
    static badgeLabel = "MOD";
    static nodeType = "modulator";
    static defaultTab = "MODULATOR";
    static tabs = ["MODULATOR", "COMMON"];

    constructor() {
        super();
        this.size = this.computeSize();
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
        this.properties.icon = this.properties.icon || "pulse";
        this.properties.shape = this.properties.shape || "triangle";
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultModulatorChain();
        }

        // A modulator cannot own another modulator, but its preview action can
        // preview the audio node it controls.
        this.buttons = [this.previewBtn];
        this.previewBtn.onClick = () => {
            const previewNodeId = this.properties?.parentId ?? this.id;
            window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: previewNodeId } }));
        };
        this.removeBtn = new CanvasButton(
            48, 18, 16, 16, "×", "#5f1720", "#b91c1c",
            () => {
                if (this.graph) {
                    this.graph.remove(this);
                } else {
                    window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
                }
            },
            "Delete Node"
        );
        this.addButton(this.removeBtn);
    }

    computeSize(): [number, number] {
        return [BaseNode.visualSize, BaseNode.visualSize];
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "Modulator";
    }

    canBeMainPreview(): boolean {
        return false;
    }

    override get isModifier(): boolean {
        return true;
    }

    override get modifierKind(): string {
        return 'modulator';
    }
}

LiteGraph.registerNodeType("Audio/Modulator", ModulatorNode);
