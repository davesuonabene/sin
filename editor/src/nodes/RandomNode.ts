import { LiteGraph } from 'litegraph.js';
import { ModulatorNode } from './ModulatorNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { type RandomDestination, applyRandomModulation } from '../../../ermes/ts/randomResolver.ts';

export class RandomNode extends ModulatorNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'RANDOM',
                label: 'Random',
                sections: [
                    { type: 'fields', fields: ['seed'] },
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Random', tab: 'COMMON' },
        {
            key: 'seed',
            label: 'Seed',
            type: 'seed',
            default: 42,
            tab: 'RANDOM',
            description: 'Deterministic seed or seed sequence (e.g. "42", "42 108", "rand") for parameter modulation.'
        }
    ];

    static defaultColor = "#7e22ce";
    static defaultIcon = "shuffle";
    static badgeLabel = "RND";
    static nodeType = "random";
    static defaultTab = "RANDOM";
    static tabs = ["RANDOM", "COMMON"];

    override get modifierKind(): string {
        return 'random';
    }

    constructor() {
        super();
        this.title = "Random";
        this.properties = {
            node_type: "random",
            modifier_kind: "random",
            node_name: "Random",
            color: "#7e22ce",
            icon: "shuffle",
            refresh_mode: "global",
            seed: 42,
            seed_refresh: true,
            destinations: []
        };
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "Random";
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

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if (key === 'seed' || key === 'destinations') {
            const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
            const parentId = this.properties?.parentId;
            const ownerNode = parentId != null && graph ? graph.getNodeById?.(parentId) : null;
            if (ownerNode) {
                applyRandomModulation(this, ownerNode);
            }
        }
    }
}

(RandomNode as any).title = "Random";
LiteGraph.registerNodeType("Audio/Random", RandomNode);
