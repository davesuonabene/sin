import { LiteGraph } from 'litegraph.js';
import { ModulatorNode } from './ModulatorNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

/**
 * A typed modifier that selects one item from an explicit ordered asset pool.
 * It remains parent-owned like every other modifier, but it does not process an
 * audio/control chain: its value is assigned explicitly to an asset_path field.
 */
export class AssetFilterNode extends ModulatorNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'FILTER',
                label: 'Asset Pool',
                sections: [
                    { type: 'fields', fields: ['playbackMode', 'refresh_mode'] },
                    { type: 'pool_editor' }
                ]
            },
            {
                id: 'COMMON',
                label: 'Common',
                sections: [
                    { type: 'info_table' },
                    { type: 'fields', fields: ['node_name'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Asset Pool', tab: 'COMMON' },
        { key: 'playbackMode', label: 'Playback', type: 'select', default: 'Random', options: [{ value: 'Random', label: 'Random' }, { value: 'Sequential', label: 'Sequential' }], tab: 'FILTER' },
        { key: 'refresh_mode', label: 'Refresh Mode', type: 'select', default: 'parent_refresh', options: [{ value: 'local_refresh', label: 'Local · Owner render' }, { value: 'parent_refresh', label: 'Parent · Ancestor render' }, { value: 'global_refresh', label: 'Global · Highlighted refresh' }], tab: 'FILTER' }
    ];

    static defaultColor = "#7c3aed";
    static defaultIcon = "search";
    static defaultShape = "diamond" as const;
    static badgeLabel = "PATH";
    static nodeType = "asset_filter";
    static defaultTab = "FILTER";
    static tabs = ["FILTER", "COMMON"];

    constructor() {
        super();
        this.title = "Asset Pool";
        this.color = "#7c3aed";
        this.bgcolor = "#7c3aed";
        this.boxcolor = "#6d28d9";

        this.properties = {
            node_name: "Asset Pool",
            node_type: "asset_filter",
            modifier_kind: "asset_filter",
            output_type: "asset_path",
            output_value: "",
            selected_items: [],
            playbackMode: "Random",
            refresh_mode: "parent_refresh",
            sequence_index: -1,
            seed: 0,
            color: "#7c3aed",
            icon: "search",
            shape: "diamond"
        };

    }

    getTitle(): string {
        return this.properties?.node_name || "Asset Pool";
    }
}

(AssetFilterNode as any).title = "Asset Pool";
LiteGraph.registerNodeType("Audio/AssetFilter", AssetFilterNode);
