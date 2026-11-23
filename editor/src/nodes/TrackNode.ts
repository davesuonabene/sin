import { LiteGraph } from 'litegraph.js';
import { BaseNode, type NodeToolbarControl } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import {
    CLIP_FILL_COLOR,
    CLIP_MARKER_COLOR,
    MASTER_CLIP_THRESHOLD,
    deriveMatteNodePalette,
    drawHeaderRmsMeter,
    drawIconRmsFill,
    rmsToMeterLevel,
    sampleBufferMeterLevels,
    samplePeaksMeterLevels,
    type SignalTelemetry,
    type VisualizationTypeId
} from '../../../packages/iride/src/index.ts';
import { traceNodeShape } from './NodeVisuals.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import { mixAudioBuffers, getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';

export class TrackNode extends BaseNode {
    private audioBuffer: AudioBuffer | null = null;
    private _cachedMixedInput: AudioBuffer | null = null;
    private _lastMixedSources: AudioBuffer[] = [];
    private _lastMixedGain: number = 1.0;
    public hasClipWarning = false;
    private _smoothedRms = 0;
    private _smoothedPeak = 0;
    private _peakHoldUntil = 0;
    private _lastVisualUpdateMs = 0;
    private _clipFlashUntil = 0;
    private _isActivelyClipping = false;

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
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0, max: 128, step: 0.25, unit: 'bars', tab: 'TRACK' }
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

    protected override updateLiveVisualState(telemetry?: SignalTelemetry): void {
        const isPlaying = Boolean(telemetry?.isPlaying);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const dt = this._lastVisualUpdateMs > 0
            ? Math.max(0.008, Math.min(0.08, (now - this._lastVisualUpdateMs) / 1000))
            : 0.016;
        this._lastVisualUpdateMs = now;

        let rawRms = 0;
        let rawPeak = 0;

        if (isPlaying && telemetry) {
            const busLevel = telemetry.busLevels?.get(String(this.id));
            if (busLevel) {
                rawRms = Math.max(0, busLevel.rms);
                rawPeak = Math.max(0, busLevel.peak);
            } else if (telemetry.busLevels && telemetry.busLevels.size > 0) {
                if (this.isMasterNode && typeof telemetry.masterRms === 'number' && Number.isFinite(telemetry.masterRms)) {
                    rawRms = Math.max(0, telemetry.masterRms);
                    rawPeak = typeof telemetry.masterPeak === 'number' && Number.isFinite(telemetry.masterPeak)
                        ? Math.max(0, telemetry.masterPeak)
                        : rawRms;
                }
            } else if (this.isMasterNode && typeof telemetry.masterRms === 'number' && Number.isFinite(telemetry.masterRms)
                && (telemetry.masterRms > 0 || (telemetry.masterPeak ?? 0) > 0)) {
                rawRms = Math.max(0, telemetry.masterRms);
                rawPeak = typeof telemetry.masterPeak === 'number' && Number.isFinite(telemetry.masterPeak)
                    ? Math.max(0, telemetry.masterPeak)
                    : rawRms;
            } else {
                const buf = this.getAudioBuffer();
                if (buf && buf.length > 0) {
                    const dur = buf.duration > 0 ? buf.duration : (telemetry.duration || 1);
                    const sampled = sampleBufferMeterLevels(buf, telemetry.time, dur, 0.045);
                    rawRms = sampled.rms;
                    rawPeak = sampled.peak;
                } else if ((this as any).realtimePeaks) {
                    const dur = Number((this as any).realtimePeaksDuration || telemetry.duration || 1);
                    const progress = dur > 0 ? (((telemetry.time % dur) + dur) % dur) / dur : 0;
                    const sampled = samplePeaksMeterLevels((this as any).realtimePeaks as Float32Array, progress, 0.025);
                    rawRms = sampled.rms;
                    rawPeak = sampled.peak;
                } else if (this.isMasterNode && telemetry.realtimeScope && telemetry.realtimeScope.length > 0) {
                    const scope = telemetry.realtimeScope;
                    let sumSq = 0;
                    let count = 0;
                    for (let i = 0; i < scope.length; i += 2) {
                        const v = scope[i];
                        const av = v < 0 ? -v : v;
                        if (av > rawPeak) rawPeak = av;
                        sumSq += v * v;
                        count++;
                    }
                    rawRms = count > 0 ? Math.sqrt(sumSq / count) : 0;
                }
            }
        }

        if (!isPlaying) {
            const decay = Math.exp(-dt / 0.090);
            this._smoothedRms *= decay;
            this._smoothedPeak *= decay;
            if (this._smoothedRms < 0.001) this._smoothedRms = 0;
            if (this._smoothedPeak < 0.001) this._smoothedPeak = 0;
        } else {
            const tauRms = rawRms > this._smoothedRms ? 0.024 : 0.220;
            const alphaRms = 1 - Math.exp(-dt / tauRms);
            this._smoothedRms += (rawRms - this._smoothedRms) * alphaRms;
            if (this._smoothedRms < 0.0005 && rawRms === 0) this._smoothedRms = 0;

            if (rawPeak >= this._smoothedPeak) {
                this._smoothedPeak = rawPeak;
                this._peakHoldUntil = now + 180;
            } else if (now >= this._peakHoldUntil) {
                const peakDecay = Math.exp(-dt / 0.240);
                this._smoothedPeak = Math.max(rawPeak, this._smoothedPeak * peakDecay);
                if (this._smoothedPeak < 0.001) this._smoothedPeak = 0;
            }
        }

        const isParamOpen = this.isParametersPanelOpen();
        const hitClip = isPlaying && rawPeak >= MASTER_CLIP_THRESHOLD;
        if (hitClip) {
            this._clipFlashUntil = now + 260;
            if (!isParamOpen) {
                this.hasClipWarning = true;
            }
        }
        this._isActivelyClipping = Boolean(
            isPlaying && (hitClip || now < this._clipFlashUntil)
        );
    }

    override onParametersOpened(): void {
        if (this.hasClipWarning) {
            this.hasClipWarning = false;
            this.setDirtyCanvas?.(true, true);
        }
    }

    protected override drawBody(ctx: CanvasRenderingContext2D, telemetry?: SignalTelemetry): void {
        const size = BaseNode.visualSize;
        const level = rmsToMeterLevel(this._smoothedRms);
        const peakLevel = telemetry?.isPlaying ? rmsToMeterLevel(this._smoothedPeak) : 0;
        const baseFill = deriveMatteNodePalette(this.nodeColor).iconBg;
        const fillColor = this._isActivelyClipping ? CLIP_FILL_COLOR : baseFill;
        ctx.save();
        traceNodeShape(ctx, this.nodeShape, 0, 0, size);
        ctx.fillStyle = fillColor;
        ctx.fill();
        if (level > 0.005 || peakLevel > 0.01 || this._isActivelyClipping) {
            ctx.save();
            traceNodeShape(ctx, this.nodeShape, 0, 0, size);
            ctx.clip?.();
            drawIconRmsFill(ctx, size, level, peakLevel, baseFill, this._isActivelyClipping);
            ctx.restore();
        }
        if (this._isActivelyClipping) {
            traceNodeShape(ctx, this.nodeShape, 0, 0, size);
            ctx.lineWidth = 1.75;
            ctx.strokeStyle = CLIP_MARKER_COLOR;
            ctx.stroke();
        }
        ctx.restore();
    }

    protected override drawPanelHeaderDecorations(
        ctx: CanvasRenderingContext2D,
        width: number,
        headerHeight: number,
        _titleX: number,
        telemetry?: SignalTelemetry
    ): void {
        const level = telemetry?.isPlaying ? rmsToMeterLevel(this._smoothedRms) : 0;
        const peakLevel = telemetry?.isPlaying ? rmsToMeterLevel(this._smoothedPeak) : 0;
        const style = drawHeaderRmsMeter(
            ctx,
            width,
            headerHeight,
            level,
            peakLevel,
            '#111111',
            this._isActivelyClipping
        );
        this._headerDeco.titleColor = style.fg;
        if (this._isActivelyClipping && style.border) {
            this._headerDeco.borderColor = style.border;
            this._headerDeco.borderWidth = 1.75;
        }
    }

    protected override drawAlertBorder(ctx: CanvasRenderingContext2D, isOpenedPanel: boolean): void {
        if (!this.hasClipWarning && !this._isActivelyClipping) return;
        ctx.save();
        ctx.strokeStyle = CLIP_MARKER_COLOR;
        ctx.lineWidth = 2.5;
        if (!isOpenedPanel) {
            const size = BaseNode.visualSize;
            traceNodeShape(ctx, this.nodeShape, -3.5, -3.5, size + 7);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(size - 4.5, size - 4.5, 4, 0, Math.PI * 2);
            ctx.fillStyle = CLIP_MARKER_COLOR;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        } else {
            const [width, height] = this.size;
            traceNodeShape(ctx, this.nodeShape, -3, -3, width + 6, height + 6);
            ctx.stroke();
        }
        ctx.restore();
    }

    override onVisualizationToggled(_enabled: boolean): void {
        // Toggling visual feedback should only update presentation state without hijacking master playback.
    }

    override getToolbarControls(): NodeToolbarControl[] {
        return [
            {
                kind: 'select',
                id: 'mix_mode',
                label: 'Mix',
                title: 'Track Mix Mode',
                value: String(this.properties?.mix_mode || 'sum'),
                options: [
                    { value: 'sum', label: 'Sum' },
                    { value: 'first', label: 'First' },
                    { value: 'last', label: 'Last' }
                ],
                onChange: (value) => {
                    this.updateProperty('mix_mode', value);
                    this.setDirtyCanvas(true, true);
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
                    }
                }
            }
        ];
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
