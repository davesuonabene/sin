import { LiteGraph } from 'litegraph.js';
import { BaseNode, type NodeToolbarControl } from './BaseNode.ts';
import { CanvasButton } from '../ui/CanvasButton.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';

export class ModulatorNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
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
    static defaultColor = "#7e22ce";
    static defaultIcon = "pulse";
    static badgeLabel = "MOD";
    static nodeType = "modulator";
    static defaultTab = "COMMON";
    static tabs = ["COMMON"];

    constructor() {
        super();
        this.size = this.computeSize();
        this.shape = LiteGraph.BOX_SHAPE || 1;

        this.color = "#7e22ce";
        this.bgcolor = "#7e22ce";
        this.boxcolor = "#6b21a8";

        if (!this.properties) {
            this.properties = {};
        }
        this.properties.node_type = "modulator";
        this.properties.node_name = this.properties.node_name || "Modulator";
        this.properties.color = this.properties.color || "#7e22ce";
        this.properties.icon = this.properties.icon || "pulse";

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

    override getToolbarControls(): NodeToolbarControl[] {
        const parentId = this.properties?.parentId;
        const controls: NodeToolbarControl[] = [];
        if (parentId != null) {
            controls.push({
                kind: 'button',
                id: 'parent_node',
                label: 'Node',
                icon: 'arrowLeft',
                title: 'Select and inspect parent node',
                onClick: () => {
                    if (typeof window === 'undefined') return;
                    const graph = (window as any).editorGraph;
                    const canvas = (window as any).editorCanvas;
                    const parentNode = graph?.getNodeById?.(parentId);
                    if (parentNode && canvas?.selectNode) {
                        canvas.selectNode(parentNode);
                    }
                    window.dispatchEvent(new CustomEvent('open-node-properties', { detail: { nodeId: parentId } }));
                }
            });
        }
        controls.push({
            kind: 'button',
            id: 'delete_mod',
            label: 'Remove',
            icon: 'trash',
            tone: 'danger',
            title: 'Remove this Modifier',
            onClick: () => {
                if (typeof window === 'undefined') return;
                window.dispatchEvent(new CustomEvent('delete-node', { detail: { nodeId: this.id } }));
                if (parentId != null) {
                    const graph = (window as any).editorGraph;
                    const canvas = (window as any).editorCanvas;
                    const parentNode = graph?.getNodeById?.(parentId);
                    if (parentNode && canvas?.selectNode) {
                        canvas.selectNode(parentNode);
                    }
                    window.dispatchEvent(new CustomEvent('open-node-properties', { detail: { nodeId: parentId } }));
                }
            }
        });
        return controls;
    }
}

LiteGraph.registerNodeType("Audio/Modulator", ModulatorNode);
