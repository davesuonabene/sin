import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';

/** A no-op placeholder used when a saved workspace contains an unavailable node. */
export class DisabledNode extends BaseNode {
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
    static defaultColor = "#64748b";
    static defaultIcon = "warning";
    static badgeLabel = "DIS";
    static nodeType = "disabled";
    static defaultTab = "COMMON";
    static tabs = ["COMMON"];

    constructor() {
        super();
        this.title = "Disabled Node";
        this.size = this.computeSize();
        this.color = "#64748b";
        this.bgcolor = "#64748b";
        this.boxcolor = "#475569";
        this.properties = {
            ...(this.properties || {}),
            disabled: true,
            disabled_reason: "This node could not be loaded.",
            icon: "warning"
        };
    }

    onExecute() {
        // Intentionally inert: a broken node should not stop the rest of the graph.
    }

    canBeMainPreview(): boolean {
        return false;
    }
}

LiteGraph.registerNodeType("Audio/Disabled", DisabledNode as any);
