import { LiteGraph } from 'litegraph.js';
import { ModulatorNode } from './ModulatorNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { refreshLibraryAssetSnapshot, resolveLibraryAssets, type LibraryFile } from '../api';

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
                    { type: 'appearance' },
                    { type: 'info_table' }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Asset Pool', tab: 'COMMON' },
        { key: 'playbackMode', label: 'Playback', type: 'select', default: 'Random', options: [{ value: 'Random', label: 'Random' }, { value: 'Sequential', label: 'Sequential' }], tab: 'FILTER' },
        {
            key: 'refresh_mode',
            label: 'Refresh Mode',
            type: 'radio',
            default: 'parent',
            options: [
                { value: 'local', label: 'Local' },
                { value: 'parent', label: 'Parent' },
                { value: 'ancestor', label: 'Ancestor' },
                { value: 'global', label: 'Global' },
                { value: 'off', label: 'Off' }
            ],
            tab: 'FILTER',
            description: 'Local advances on every output request. Parent advances when its direct parent renders. Off keeps the current item.'
        }
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
            refresh_mode: "parent",
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

    async syncMetadataFromLibrary(files?: LibraryFile[]): Promise<void> {
        const items = Array.isArray(this.properties?.selected_items) ? this.properties.selected_items : [];
        const libraryFiles = files || await resolveLibraryAssets(items);
        const outputId = this.properties?.output_item_id;
        const outputPath = String(this.properties?.output_value || '');
        const outputItem = items.find((item: any) =>
            outputPath && (item.absolute_path || item.filepath) === outputPath
        ) || items.find((item: any) =>
            outputId != null && String(item.id) === String(outputId)
        );
        for (const item of items) refreshLibraryAssetSnapshot(item, libraryFiles);
        if (outputItem) {
            this.properties.output_value = outputItem.absolute_path || outputItem.filepath || outputPath;
            this.properties.output_item_id = outputItem.id ?? outputId;
            this.properties.output_bpm = outputItem.bpm ?? null;
            this.properties.output_key = String(outputItem.key ?? '');
        }
        this.setDirtyCanvas?.(true, true);
    }
}

(AssetFilterNode as any).title = "Asset Pool";
LiteGraph.registerNodeType("Audio/AssetFilter", AssetFilterNode);
