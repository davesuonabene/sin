import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { CanvasButton } from '../ui/CanvasButton';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { type NodeShape } from './NodeVisuals';
import { type RandomDestination } from '../../../ermes/ts/randomResolver.ts';

export class RandomNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'RANDOM',
                label: 'Random',
                sections: [
                    { type: 'random_panel' }
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Random', tab: 'COMMON' }
    ];

    static defaultColor = "#ec4899";
    static defaultIcon = "shuffle";
    static defaultShape: NodeShape = "diamond";
    static badgeLabel = "RND";
    static nodeType = "random";
    static defaultTab = "RANDOM";
    static tabs = ["RANDOM", "COMMON"];

    override get isModifier(): boolean {
        return true;
    }

    override get modifierKind(): string {
        return 'random';
    }

    constructor() {
        super();
        this.size = this.computeSize();
        this.shape = LiteGraph.BOX_SHAPE || 1;

        this.color = "#ec4899";
        this.bgcolor = "#ec4899";
        this.boxcolor = "#db2777";

        if (!this.properties) {
            this.properties = {};
        }

        this.properties.node_type = "random";
        this.properties.modifier_kind = "random";
        this.properties.node_name = this.properties.node_name || "Random";
        this.properties.color = this.properties.color || "#ec4899";
        this.properties.icon = this.properties.icon || "shuffle";
        this.properties.shape = this.properties.shape || "diamond";
        this.properties.refresh_mode = this.properties.refresh_mode || "parent";
        this.properties.seed = this.properties.seed ?? 0;
        if (!Array.isArray(this.properties.destinations)) {
            this.properties.destinations = [];
        }

        // Action buttons
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
        return this.properties?.node_name || this.title || "Random";
    }

    canBeMainPreview(): boolean {
        return false;
    }

    getDestinations(): RandomDestination[] {
        return Array.isArray(this.properties?.destinations) ? this.properties.destinations : [];
    }

    addDestination(dest: RandomDestination): void {
        const list = this.getDestinations();
        if (!list.some(d => d.paramKey === dest.paramKey)) {
            list.push(dest);
            this.updateProperty('destinations', [...list]);
        }
    }

    removeDestination(paramKey: string): void {
        const list = this.getDestinations().filter(d => d.paramKey !== paramKey);
        this.updateProperty('destinations', list);
    }
}

(RandomNode as any).title = "Random";
LiteGraph.registerNodeType("Audio/Random", RandomNode);
