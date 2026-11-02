import { LiteGraph } from 'litegraph.js';
import { ModulatorNode } from './ModulatorNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { refreshLibraryAssetSnapshot, resolveLibraryAssets, type LibraryFile } from '../api.ts';
import { populateOwnerSlotsFromPool } from '../../../ermes/ts/assetResolver.ts';

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
                    { type: 'fields', fields: ['playbackMode', 'seed'] },
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
            key: 'seed',
            label: 'Seed',
            type: 'seed',
            default: 42,
            tab: 'FILTER',
            description: 'Deterministic seed or seed sequence (e.g. "42", "42 108", "rand") used to populate sample slots.'
        }
    ];

    static defaultColor = "#7e22ce";
    static defaultIcon = "search";
    static defaultShape = "diamond" as const;
    static badgeLabel = "PATH";
    static nodeType = "asset_filter";
    static defaultTab = "FILTER";
    static tabs = ["FILTER", "COMMON"];

    constructor() {
        super();
        this.title = "Asset Pool";
        this.color = "#7e22ce";
        this.bgcolor = "#7e22ce";
        this.boxcolor = "#6b21a8";

        this.properties = {
            node_name: "Asset Pool",
            node_type: "asset_filter",
            modifier_kind: "asset_filter",
            output_type: "asset_path",
            output_value: "",
            selected_items: [],
            playbackMode: "Random",
            refresh_mode: "global",
            sequence_index: -1,
            seed: 42,
            seed_refresh: true,
            color: "#7e22ce",
            icon: "search",
            shape: "diamond"
        };

    }

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if (key === 'seed' || key === 'playbackMode' || key === 'selected_items') {
            if (key === 'selected_items' && (!Array.isArray(value) || value.length === 0)) {
                this.properties.output_value = '';
                this.properties.output_item_id = null;
                this.properties.output_bpm = null;
                this.properties.output_key = '';
                return;
            }
            const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
            const parentId = this.properties?.parentId;
            let ownerNode = parentId != null && graph ? graph.getNodeById?.(parentId) : null;
            if (!ownerNode && graph && this.id != null) {
                const allNodes = ((graph as any)._nodes || (graph as any).nodes || []) as any[];
                ownerNode = allNodes.find((n: any) => n?.properties?.asset_modifier_id === this.id) || null;
            }
            if (ownerNode) {
                populateOwnerSlotsFromPool(this, ownerNode);
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: ownerNode.id } }));
                }
            }
        }
    }

    getTitle(): string {
        return this.properties?.node_name || "Asset Pool";
    }

    override get modifierKind(): string {
        return 'asset_filter';
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
