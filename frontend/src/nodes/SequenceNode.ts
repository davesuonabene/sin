import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

export class SequenceNode extends BaseNode {
    static readonly stepCount = 16;
    static readonly stepParameterKeys = ['probability', 'offset', 'velocity', 'subdivisions'];

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SEQUENCE',
                label: 'Sequence',
                sections: [
                    { type: 'sequence_grid' },
                    { type: 'fields', fields: ['step_length', 'play_mode', 'seed', 'seed_mode'] }
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Sequence', tab: 'COMMON' },
        { key: 'probability', label: 'Probability', type: 'int', default: 100, min: 0, max: 100, step: 1, unit: '%', tab: 'SEQUENCE' },
        { key: 'offset', label: 'Offset', type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.01, tab: 'SEQUENCE' },
        { key: 'velocity', label: 'Velocity', type: 'float', default: 1, min: 0, max: 1, step: 0.01, tab: 'SEQUENCE' },
        { key: 'subdivisions', label: 'Subdivisions', type: 'int', default: 1, min: 1, max: 16, step: 1, tab: 'SEQUENCE' },
        { key: 'step_length', label: 'Step Length', type: 'float', default: 0.25, min: 0.0625, max: 4.0, step: 0.0625, unit: 'bars', tab: 'SEQUENCE' },
        { key: 'play_mode', label: 'Play Mode', type: 'select', default: 'gate', options: [{ value: 'gate', label: 'Gate' }, { value: 'trigger', label: 'Trigger' }], tab: 'SEQUENCE' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'SEQUENCE' },
        { key: 'seed_mode', label: 'Seed Mode', type: 'select', default: 'moving', options: [{ value: 'moving', label: 'Moving (per iteration)' }, { value: 'fixed', label: 'Fixed (looped by arranger)' }], tab: 'SEQUENCE' }
    ];

    static defaultColor = "#ec4899";
    static defaultIcon = "sequence";
    static defaultShape = "square" as const;
    static badgeLabel = "SEQ";
    static nodeType = "sequence";
    static defaultTab = "SEQUENCE";
    static tabs = ["SEQUENCE", "CHAIN", "COMMON"];

    getStepParameterFields(): FieldSchema[] {
        return SequenceNode.stepParameterKeys
            .map(key => SequenceNode.fields.find(field => field.key === key))
            .filter((field): field is FieldSchema => Boolean(field));
    }

    constructor() {
        super();
        this.title = "Sequence";
        this.size = this.computeSize();
        
        // Vibrant Pink / Magenta theme for Sequence loop generator
        this.color = "#ec4899";
        this.bgcolor = "#ec4899";
        this.boxcolor = "#db2777";
        
        this.properties = {
            node_name: "Sequence",
            node_type: "sequence",
            sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_parameters: Array.from({ length: SequenceNode.stepCount }, () => ({
                offset: 0,
                velocity: 1,
                probability: 100,
                subdivision_enabled: false,
                subdivisions: 1
            })),
            step_length: 0.25,
            play_mode: "gate",
            selected_step: 0,
            seed: Math.floor(Math.random() * 10000),
            seed_mode: "moving",
            color: "#ec4899",
            icon: "sequence",
            shape: "square"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }
}

(SequenceNode as any).title = "Sequence";
LiteGraph.registerNodeType("Audio/Sequence", SequenceNode);
