import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

export class TrackNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'TRACK',
                label: 'Track',
                sections: [
                    { type: 'fields', fields: ['mix_mode', 'bpm', 'total_bars'] }
                ]
            },
            {
                id: 'CHAIN',
                label: 'FX Chain',
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Master Track', tab: 'COMMON' },
        { key: 'mix_mode', label: 'Mix Mode', type: 'select', default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'first', label: 'First' }, { value: 'last', label: 'Last' }], tab: 'TRACK' },
        { key: 'bpm', label: 'Engine BPM', type: 'global_float', default: 'global', min: 20, max: 300, unit: 'BPM', tab: 'TRACK' },
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'TRACK' }
    ];

    static defaultColor = "#4f46e5";
    static defaultIcon = "mixer";
    static defaultShape = "diamond" as const;
    static badgeLabel = "TRACK";
    static nodeType = "track";
    static defaultTab = "TRACK";
    static tabs = ["TRACK", "CHAIN", "COMMON"];

    constructor() {
        super();
        this.title = "Track";
        this.size = this.computeSize();
        
        // Indigo theme for container track
        this.color = "#4f46e5";
        this.bgcolor = "#4f46e5";
        this.boxcolor = "#4338ca";
        
        this.properties = {
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: "global",
            target_bpm: 120,
            total_bars: "global",
            color: "#4f46e5",
            icon: "mixer",
            shape: "diamond"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    override updateProperty(key: string, value: any): void {
        if (key !== 'bpm' && key !== 'target_bpm') {
            super.updateProperty(key, value);
            return;
        }

        // `bpm` is the track's scope setting ("global" or a local number).
        // `target_bpm` is the resolved numeric value maintained by the graph.
        super.updateProperty('bpm', value);
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
