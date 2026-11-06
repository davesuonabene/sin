import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { type SignalTelemetry, type VisualizationTypeId } from '../../../packages/iride/src/index.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import { mixAudioBuffers, getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';

export class TrackNode extends BaseNode {
    private audioBuffer: AudioBuffer | null = null;
    private _cachedMixedInput: AudioBuffer | null = null;
    private _lastMixedSources: AudioBuffer[] = [];
    private _lastMixedGain: number = 1.0;

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
    static badgeLabel = "TRACK";
    static nodeType = "track";
    static defaultTab = "TRACK";
    static tabs = ["TRACK", "CHAIN", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'loop';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['loop', 'realtime', 'spectrum'];

    constructor() {
        super();
        this.title = "Track";
        this.size = this.computeSize();

        // Indigo theme for container track
        this.color = "#4f46e5";
        this.bgcolor = "#4f46e5";
        this.boxcolor = "#4338ca";

        this.properties = {
            ...this.properties,
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: "global",
            target_bpm: 120,
            total_bars: "global",
            visualization_type: "loop",
            color: "#4f46e5",
            icon: "mixer"
        };

        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    private resolveInputBuffer(visited?: Set<number>): AudioBuffer | undefined {
        const cycleSet = visited || new Set<number>();
        if (cycleSet.has(this.id)) return undefined;
        cycleSet.add(this.id);

        const inputs = this.getInputNodes();
        const availableBuffers: AudioBuffer[] = [];
        for (const inputNode of inputs) {
            const buf = (inputNode as any).manifestStemBuffer
                || (inputNode as any)._lastRenderedBuffer
                || (inputNode as any).getAudioBuffer?.(cycleSet)
                || (inputNode as any).audioBuffer
                || (inputNode.id === (window as any).activeRamPreviewNodeId ? globalAudioScheduler.getFullAudioBuffer() : undefined);
            if (buf) availableBuffers.push(buf);
        }
        if (availableBuffers.length === 0) {
            this._cachedMixedInput = null;
            this._lastMixedSources = [];
            return undefined;
        }

        const nodeGain = getNodeGainMultiplier(this);
        const sameLength = this._lastMixedSources.length === availableBuffers.length;
        const sameSources = sameLength && availableBuffers.every((b, i) => b === this._lastMixedSources[i]);
        if (this._cachedMixedInput && sameSources && this._lastMixedGain === nodeGain) {
            return this._cachedMixedInput;
        }

        const raw = availableBuffers.length === 1 ? availableBuffers[0] : mixAudioBuffers(availableBuffers);
        if (!raw) return undefined;

        const scaled = (nodeGain !== 1.0) ? applyGainToBuffer(raw, nodeGain) : raw;
        this._cachedMixedInput = scaled;
        this._lastMixedSources = [...availableBuffers];
        this._lastMixedGain = nodeGain;
        return scaled;
    }

    override getAudioBuffer(visited?: Set<number>): AudioBuffer | null {
        return (this as any).manifestStemBuffer
            || (this as any)._lastRenderedBuffer
            || this.audioBuffer
            || this.resolveInputBuffer(visited)
            || null;
    }

    override updateProperty(key: string, value: any): void {
        if (key === 'chain' || key === 'gain') {
            this._cachedMixedInput = null;
            this._lastMixedSources = [];
        }

        if (key !== 'bpm' && key !== 'target_bpm') {
            super.updateProperty(key, value);
            return;
        }

        // `bpm` is the track's scope setting ("global" or a local number).
        // `target_bpm` is the resolved numeric value maintained by the graph.
        super.updateProperty('bpm', value);
    }

    override onGlobalParametersChanged(parameters: Record<string, any>): void {
        super.onGlobalParametersChanged(parameters);
        if (this.properties?.bpm === 'global' && parameters.bpm) {
            this.properties.target_bpm = parameters.bpm;
        }
        this.setDirtyCanvas?.(true, true);
    }

    override getLiveActivityState(telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        if (!telemetry?.isPlaying) return { isTriggered: false };
        const dur = telemetry.duration > 0 ? telemetry.duration : 1.0;
        const progress = Math.max(0, Math.min(1, ((telemetry.time % dur) + dur) % dur / dur));
        return { isTriggered: true, progress };
    }

    override onVisualizationToggled(_enabled: boolean): void {
        // Toggling visual feedback should only update presentation state without hijacking master playback.
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
