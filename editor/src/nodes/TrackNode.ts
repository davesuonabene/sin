import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { WaveformRenderer, type RenderBox, type SignalTelemetry } from '../../../packages/iride/src/index.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import { mixAudioBuffers, getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';

export class TrackNode extends BaseNode {
    private waveformRenderer = new WaveformRenderer({ accentColor: '#4f46e5' });
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
                    { type: 'info_table' },
                    { type: 'fields', fields: ['scope_mode', 'scope_window', 'scope_gain'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Master Track', tab: 'COMMON' },
        { key: 'mix_mode', label: 'Mix Mode', type: 'select', default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'first', label: 'First' }, { value: 'last', label: 'Last' }], tab: 'TRACK' },
        { key: 'bpm', label: 'Engine BPM', type: 'global_float', default: 'global', min: 20, max: 300, unit: 'BPM', tab: 'TRACK' },
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'TRACK' },
        { key: 'scope_mode', label: 'Scope Mode', type: 'select', default: 'full', options: [{ value: 'full', label: 'Full Waveform' }, { value: 'drawn', label: 'Drawn Sweep' }, { value: 'scrolled', label: 'Scrolled Window' }], tab: 'COMMON' },
        { key: 'scope_window', label: 'Scope Window', type: 'slider', default: 2.0, min: 0.25, max: 8.0, step: 0.25, unit: 's', tab: 'COMMON' },
        { key: 'scope_gain', label: 'Scope Gain', type: 'slider', default: 1.0, min: 0.1, max: 4.0, step: 0.1, tab: 'COMMON' }
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
            ...this.properties,
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: "global",
            target_bpm: 120,
            total_bars: "global",
            scope_mode: "full",
            scope_window: 2.0,
            scope_gain: 1.0,
            color: "#4f46e5",
            icon: "mixer",
            shape: "diamond"
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

    private resolveInputTotalBars(): number | null {
        const inputs = this.getInputNodes();
        let maxBars = 0;
        for (const inputNode of inputs) {
            const bars = Number(inputNode?.properties?.total_bars);
            if (Number.isFinite(bars) && bars > maxBars) {
                maxBars = bars;
            }
        }
        return maxBars > 0 ? maxBars : null;
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

    override drawVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const activePreviewId = (window as any).activeRamPreviewNodeId;
        const isMainPreview = Boolean(this.properties?.is_main_preview)
            || this.properties?.role === 'master'
            || this.properties?.node_name === 'Master Track'
            || this.title === 'Master Track'
            || this.properties?.node_name === 'Master Output'
            || this.title === 'Master Output'
            || (typeof (window as any).isMainPreviewNode === 'function' && (window as any).isMainPreviewNode(this.id));
        const isPreviewTarget = this.id === activePreviewId
            || (activePreviewId == null && isMainPreview);

        const getGlobal = (window as any).getGlobalParameter;
        const globalBars = typeof getGlobal === 'function' ? Number(getGlobal('total_bars')) : 4;
        const globalBpm = typeof getGlobal === 'function' ? Number(getGlobal('bpm')) : 120;

        const inputBars = this.resolveInputTotalBars();
        const totalBarsSetting = this.properties?.total_bars;
        const totalBars = (totalBarsSetting === 'global' || !Number.isFinite(Number(totalBarsSetting)))
            ? (inputBars ?? (Number.isFinite(globalBars) && globalBars > 0 ? globalBars : 4))
            : Math.max(0.25, Number(totalBarsSetting));

        const bpmSetting = this.properties?.bpm;
        const resolvedBpm = (bpmSetting === 'global' || !Number.isFinite(Number(bpmSetting)))
            ? (Number(this.properties?.target_bpm) || (Number.isFinite(globalBpm) && globalBpm > 0 ? globalBpm : 120))
            : Math.max(20, Number(bpmSetting));

        const autoTrackWindow = totalBars * 4 * (60 / resolvedBpm);

        const isInvalidated = Boolean((this as any).isInvalidated);
        const schedulerBuf = (isPreviewTarget && !isInvalidated) ? globalAudioScheduler.getFullAudioBuffer() : undefined;
        const masterBuf = (!isInvalidated && (isPreviewTarget || (activePreviewId == null && isMainPreview)))
            ? ((window as any).activeRamPreviewBuffer as AudioBuffer | undefined)
            : undefined;
        if (isPreviewTarget && !isInvalidated && (schedulerBuf || masterBuf)) {
            (this as any)._lastRenderedBuffer = schedulerBuf || masterBuf;
        }

        const manifestStem = (this as any).manifestStemBuffer as AudioBuffer | undefined;
        const lastRenderedBuf = (this as any)._lastRenderedBuffer as AudioBuffer | undefined;
        const inputBuf = this.resolveInputBuffer();

        // Signal flow is the source of truth: active preview buffer -> stem buffer -> last rendered master buffer -> incoming input signal
        const displayBuffer = isPreviewTarget
            ? (schedulerBuf || masterBuf || manifestStem || lastRenderedBuf || this.audioBuffer || inputBuf)
            : (manifestStem || lastRenderedBuf || (isMainPreview && activePreviewId == null && !isInvalidated ? masterBuf : undefined) || this.audioBuffer || inputBuf);

        const explicitProgress = (this as any).bufferedProgress;
        const schedulerProgress = isPreviewTarget ? globalAudioScheduler.getBufferedProgress() : 0;
        const bufferedProgress = explicitProgress != null
            ? explicitProgress
            : (schedulerProgress > 0 ? schedulerProgress : 1.0);

        const bufferDuration = (this as any).manifestStemDuration || displayBuffer?.duration || 0;
        const expectedDuration = bufferDuration > autoTrackWindow
            ? bufferDuration
            : (autoTrackWindow > 0 ? autoTrackWindow : (telemetry?.duration || bufferDuration || 0));

        let playbackProgress: number | undefined;
        if (telemetry && telemetry.isPlaying && expectedDuration > 0) {
            const curTime = ((telemetry.time % expectedDuration) + expectedDuration) % expectedDuration;
            playbackProgress = curTime / expectedDuration;
        }

        const scopeMode = (this.properties?.scope_mode as 'full' | 'drawn' | 'scrolled') || 'full';
        const scopeWindow = Number(this.properties?.scope_window) || 2.0;
        const scopeGain = Number(this.properties?.scope_gain) || 1.0;

        const isMaster = isMainPreview || this.properties?.role === 'master' || this.title === 'Master Track' || this.title === 'Master Output';
        const accent = (isMaster && (!this.properties?.user_color || this.nodeColor === '#0f172a'))
            ? (this.boxcolor || '#f59e0b')
            : (this.nodeColor || this.boxcolor || '#4f46e5');

        this.waveformRenderer.setOptions({
            scopeMode,
            scopeWindow,
            scopeGain,
            accentColor: accent,
            minified: this.isMinifiedStage
        });
        this.waveformRenderer.setSignal({
            buffer: displayBuffer,
            duration: expectedDuration,
            accentColor: accent,
            bufferedProgress,
            isInvalidated,
            playbackProgress
        });

        this.waveformRenderer.render(ctx, bounds, telemetry);
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
