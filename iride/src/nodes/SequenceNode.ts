import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

export interface SequenceChannel {
    on: number[];
    probability: number[];
    offset: number[];
    velocity: number[];
    subdivisions: number[];
}

export interface SequenceDocument {
    format: 'sin-sequence';
    version: 1;
    name: string;
    channels: SequenceChannel[];
}

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
                    { type: 'fields', fields: ['step_length', 'play_mode', 'fade_ms', 'seed', 'seed_mode'] }
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Sequence', tab: 'COMMON' },
        { key: 'probability', label: 'Probability', type: 'int', default: 100, min: 0, max: 100, step: 1, unit: '%', tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'offset', label: 'Offset', type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.01, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'bipolar', direction: 'horizontal' } },
        { key: 'velocity', label: 'Velocity', type: 'float', default: 1, min: 0, max: 1, step: 0.01, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'subdivisions', label: 'Subdivisions', type: 'int', default: 1, min: 1, max: 16, step: 1, tab: 'SEQUENCE', stepVisual: { mode: 'fragments' } },
        { key: 'step_length', label: 'Step Length', type: 'float', default: 0.25, min: 0.0625, max: 4.0, step: 0.0625, unit: 'bars', tab: 'SEQUENCE' },
        { key: 'play_mode', label: 'Play Mode', type: 'select', default: 'gate', options: [{ value: 'gate', label: 'Gate' }, { value: 'trigger', label: 'Trigger' }], tab: 'SEQUENCE' },
        { key: 'fade_ms', label: 'Step Fade', type: 'float', default: 0, min: 0, max: 5, step: 0.1, unit: 'ms', tab: 'SEQUENCE', description: 'Applies a short gain fade at the start and end of every triggered sample.' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'SEQUENCE' },
        { key: 'seed_mode', label: 'Seed Mode', type: 'select', default: 'moving', options: [{ value: 'moving', label: 'Moving (per iteration)' }, { value: 'fixed', label: 'Fixed (looped by arranger)' }], tab: 'SEQUENCE' }
    ];

    static defaultColor = "#ec4899";
    static defaultIcon = "sequence";
    static defaultShape = "square" as const;
    static readonly bodySize = 28;
    static badgeLabel = "SEQ";
    static nodeType = "sequence";
    static defaultTab = "SEQUENCE";
    static tabs = ["SEQUENCE", "CHAIN", "COMMON"];

    getStepParameterFields(): FieldSchema[] {
        return SequenceNode.stepParameterKeys
            .map(key => SequenceNode.fields.find(field => field.key === key))
            .filter((field): field is FieldSchema => Boolean(field));
    }

    toSequenceDocument(): SequenceDocument {
        const sequence = Array.isArray(this.properties.sequence) ? this.properties.sequence : [];
        const parameters = Array.isArray(this.properties.step_parameters) ? this.properties.step_parameters : [];
        const valueFor = (key: string, index: number, fallback: number) => {
            const value = Number(parameters[index]?.[key]);
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            format: 'sin-sequence',
            version: 1,
            name: String(this.properties.node_name || this.title || 'Sequence').trim() || 'Sequence',
            channels: [{
                on: sequence.map(value => value ? 1 : 0),
                probability: sequence.map((_, index) => valueFor('probability', index, 100)),
                offset: sequence.map((_, index) => valueFor('offset', index, 0)),
                velocity: sequence.map((_, index) => valueFor('velocity', index, 1)),
                subdivisions: sequence.map((_, index) => valueFor('subdivisions', index, 1)),
            }]
        };
    }

    applySequenceDocument(document: SequenceDocument, channelIndex = 0): void {
        const channel = document.channels?.[channelIndex];
        if (!channel) throw new Error('Sequence file has no playable channel');
        const stepCount = channel.on.length;
        const arrays = [channel.probability, channel.offset, channel.velocity, channel.subdivisions];
        if (!stepCount || arrays.some(values => !Array.isArray(values) || values.length !== stepCount)) {
            throw new Error('Sequence parameter arrays do not have matching lengths');
        }
        const bounded = (value: unknown, min: number, max: number, fallback: number) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
        };
        const stepParameters = Array.from({ length: stepCount }, (_, index) => ({
            probability: Math.round(bounded(channel.probability[index], 0, 100, 100)),
            offset: bounded(channel.offset[index], -0.5, 0.5, 0),
            velocity: bounded(channel.velocity[index], 0, 1, 1),
            subdivisions: Math.round(bounded(channel.subdivisions[index], 1, 16, 1)),
            subdivision_enabled: bounded(channel.subdivisions[index], 1, 16, 1) > 1,
        }));
        this.updateProperty('node_name', document.name || 'Sequence');
        this.updateProperty('sequence', channel.on.map(value => value ? 1 : 0));
        this.updateProperty('step_parameters', stepParameters);
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
            fade_ms: 0,
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
