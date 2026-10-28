import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { SequenceRenderer, type RenderBox, type SignalTelemetry, type SequenceStep } from '../../../packages/iride/src/index.ts';

export interface SequenceChannel {
    on: number[];
    probability: number[];
    offset: number[];
    velocity: number[];
    subdivisions: number[];
    sample_start?: number[];
    gate_length?: number[];
}

export interface SequenceDocument {
    format: 'sin-sequence';
    version: 1;
    name: string;
    channels: SequenceChannel[];
}

export class SequenceNode extends BaseNode {
    private sequenceRenderer = new SequenceRenderer({ accentColor: '#ec4899' });
    static readonly stepCount = 16;
    static readonly stepParameterKeys = ['sample_start', 'gate_length', 'velocity', 'offset', 'probability', 'subdivisions'];

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SEQUENCE',
                label: 'Sequence',
                sections: [
                    { type: 'sequence_grid' },
                    { type: 'fields', fields: ['total_bars', 'step_length', 'play_mode', 'release', 'fade_ms', 'seed', 'seed_mode'] }
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
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'SEQUENCE', description: 'Pattern playback duration. "global" inherits from parent track or project setting.' },
        { key: 'sample_start', label: 'Sample Start', type: 'float', default: 0, min: 0, max: 100, step: 1, unit: '%', tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' }, description: 'Sample playback start position for this step.' },
        { key: 'gate_length', label: 'Gate Length', type: 'float', default: 1.0, min: 0.0, max: 1.0, step: 0.01, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' }, description: 'Multiplier for current step length (0.0 to 1.0), followed by release.' },
        { key: 'velocity', label: 'Velocity', type: 'float', default: 1, min: 0, max: 1, step: 0.01, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'offset', label: 'Offset', type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.01, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'bipolar', direction: 'horizontal' } },
        { key: 'probability', label: 'Probability', type: 'int', default: 100, min: 0, max: 100, step: 1, unit: '%', tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'subdivisions', label: 'Subdivisions', type: 'int', default: 1, min: 1, max: 16, step: 1, tab: 'SEQUENCE', stepVisual: { mode: 'fragments' } },
        { key: 'step_length', label: 'Step Length', type: 'float', default: 0.25, min: 0.0625, max: 4.0, step: 0.0625, unit: 'bars', tab: 'SEQUENCE' },
        { key: 'play_mode', label: 'Voice Mode', type: 'radio', default: 'gate', options: [{ value: 'gate', label: 'Mono' }, { value: 'trigger', label: 'Multivoice' }], tab: 'SEQUENCE', description: 'Mono cuts previous playing sample when a note comes in; Multivoice allows overlapping voices.' },
        { key: 'release', label: 'Release', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, tab: 'SEQUENCE', description: 'Fade-out release mapped to sample percentage (0.0 to 1.0).' },
        { key: 'fade_ms', label: 'Step Fade', type: 'float', default: 0, min: 0, max: 5, step: 0.1, unit: 'ms', tab: 'SEQUENCE', description: 'Applies a short gain fade at the start and end of every triggered sample.' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'SEQUENCE' },
        { key: 'seed_mode', label: 'Seed Mode', type: 'radio', default: 'moving', options: [{ value: 'moving', label: 'Moving (per iteration)' }, { value: 'fixed', label: 'Fixed (looped by arranger)' }], tab: 'SEQUENCE' }
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
                sample_start: sequence.map((_, index) => valueFor('sample_start', index, 0)),
                gate_length: sequence.map((_, index) => valueFor('gate_length', index, 1.0)),
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
        const stepParameters = Array.from({ length: stepCount }, (_, index) => {
            const rawGate = Number(channel.gate_length?.[index] ?? 1.0);
            const normGate = rawGate > 1.0 ? rawGate / 100.0 : rawGate;
            return {
                probability: Math.round(bounded(channel.probability[index], 0, 100, 100)),
                offset: bounded(channel.offset[index], -0.5, 0.5, 0),
                velocity: bounded(channel.velocity[index], 0, 1, 1),
                subdivisions: Math.round(bounded(channel.subdivisions[index], 1, 16, 1)),
                subdivision_enabled: bounded(channel.subdivisions[index], 1, 16, 1) > 1,
                sample_start: bounded(channel.sample_start?.[index], 0, 100, 0),
                gate_length: bounded(normGate, 0.0, 1.0, 1.0),
            };
        });
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
            ...this.properties,
            node_name: "Sequence",
            node_type: "sequence",
            total_bars: "global",
            length_inherited: true,
            sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_parameters: Array.from({ length: SequenceNode.stepCount }, () => ({
                sample_start: 0,
                gate_length: 1.0,
                offset: 0,
                velocity: 1,
                probability: 100,
                subdivision_enabled: false,
                subdivisions: 1
            })),
            step_length: 0.25,
            play_mode: "gate",
            release: 0,
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

    override drawVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        let rawSeq: any[] | null = null;
        if (Array.isArray(this.properties?.sequence) && this.properties.sequence.length > 0) {
            rawSeq = this.properties.sequence;
        }

        if (!rawSeq) {
            const trackData = (window as any).trackNodes?.get?.(this.id);
            if (Array.isArray(trackData?.sequence) && trackData.sequence.length > 0) {
                rawSeq = trackData.sequence;
            }
        }

        if (!rawSeq) {
            const channels = (this.properties as any)?.channels;
            if (Array.isArray(channels) && channels[0] && Array.isArray(channels[0].on) && channels[0].on.length > 0) {
                rawSeq = channels[0].on;
            }
        }

        if (!rawSeq || rawSeq.length === 0) {
            rawSeq = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
            if (this.properties) {
                this.properties.sequence = [...rawSeq];
            }
        }

        const rawParams = Array.isArray(this.properties?.step_parameters) ? this.properties.step_parameters : [];
        const stepCount = SequenceNode.stepCount;
        const steps: SequenceStep[] = [];

        for (let i = 0; i < stepCount; i++) {
            const rawVal = rawSeq[i];
            const isGateOn = typeof rawVal === 'number'
                ? rawVal > 0
                : typeof rawVal === 'string'
                    ? (rawVal === '1' || rawVal === 'true')
                    : typeof rawVal === 'object' && rawVal !== null
                        ? Boolean((rawVal as any).gate ?? (rawVal as any).on)
                        : Boolean(rawVal);

            const param = rawParams[i] || {};
            const velocity = typeof param.velocity === 'number' ? param.velocity : 1.0;
            const subdivisions = Number(param.subdivisions) || 1;
            const probability = typeof param.probability === 'number' ? param.probability / 100 : 1.0;
            const sampleStart = typeof param.sample_start === 'number' ? param.sample_start / 100 : 0.0;
            const rawGate = typeof param.gate_length === 'number' ? param.gate_length : 1.0;
            const gateLength = rawGate > 1.0 ? rawGate / 100 : Math.max(0.0, Math.min(1.0, rawGate));

            steps.push({
                gate: isGateOn,
                velocity,
                subdivisions,
                probability,
                sampleStart,
                gateLength
            });
        }

        this.sequenceRenderer.setSignal({
            stepCount,
            steps,
            stepLength: Number(this.properties?.step_length) || 0.25,
            accentColor: this.nodeColor || '#ec4899'
        });

        this.sequenceRenderer.render(ctx, bounds, telemetry);
    }
}

(SequenceNode as any).title = "Sequence";
LiteGraph.registerNodeType("Audio/Sequence", SequenceNode);
