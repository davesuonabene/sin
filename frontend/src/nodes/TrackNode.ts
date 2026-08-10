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
                    { type: 'info_table' },
                    { type: 'fields', fields: ['node_name'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Master Track', tab: 'COMMON' },
        { key: 'mix_mode', label: 'Mix Mode', type: 'select', default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'first', label: 'First' }, { value: 'last', label: 'Last' }], tab: 'TRACK' },
        { key: 'bpm', label: 'Engine BPM', type: 'float', default: 120, min: 20, max: 300, unit: 'BPM', tab: 'TRACK' },
        { key: 'total_bars', label: 'Total Bars', type: 'float', default: 4.0, min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'TRACK' }
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
            bpm: 120,
            total_bars: 4.0,
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

        // Presets may contain both fields. Keep them as aliases so an edited
        // engine BPM cannot be overridden by a stale target BPM during
        // hierarchy propagation or preview serialization.
        if (this.properties?.target_bpm !== value) {
            super.updateProperty('target_bpm', value);
        }
        if (this.properties?.bpm !== value) {
            super.updateProperty('bpm', value);
        }
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
