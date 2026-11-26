import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
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
    type VisualizationTypeId,
} from '../../../packages/iride/src/index.ts';
import { traceNodeShape } from './NodeVisuals.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import { applyGainToBuffer, getNodeGainMultiplier } from '../audioCompositor.ts';

/**
 * Single-cable pass-through node for mid-graph FX staging and IRIDE visualization.
 * Strictly prohibits summing: accepts at most 1 incoming audio connection.
 */
export class NullNode extends BaseNode {
    private _cachedPassBuffer: AudioBuffer | null = null;
    private _lastSourceBuffer: AudioBuffer | null = null;
    private _lastGain: number = 1.0;
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
                id: 'CHAIN',
                label: 'FX Chain',
                sections: [
                    { type: 'fx_chain', chainKey: 'chain' }
                ]
            },
            {
                id: 'EXPORT',
                label: 'Export',
                sections: [
                    { type: 'export_panel' }
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Null', tab: 'COMMON' },
        ...BaseNode.exportFields,
    ];

    static defaultColor = "#64748b";
    static defaultIcon = "activity";
    static defaultShape: 'through' = "through";
    static badgeLabel = "NULL";
    static nodeType = "null";
    static defaultTab = "CHAIN";
    static tabs = ["CHAIN", "EXPORT", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'loop';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['loop', 'realtime', 'spectrum'];

    constructor() {
        super();
        this.title = "Null";
        this.size = this.computeSize();

        this.color = "#64748b";
        this.bgcolor = "#64748b";
        this.boxcolor = "#475569";

        this.properties = {
            ...this.properties,
            node_name: "Null",
            node_type: "null",
            mix_mode: "first",
            visualization_type: "loop",
            color: "#64748b",
            icon: "activity",
        };

        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    override onConnectInput(
        targetSlot: number,
        _type: any,
        _output: any,
        _originNode: any,
        _originSlot: number
    ): boolean {
        if (targetSlot !== 0) return false;
        // Strict single-cable pass-through: replace any existing input link rather than summing.
        const existingLinkId = this.inputs?.[0]?.link;
        if (existingLinkId != null && this.graph && typeof (this.graph as any).removeLink === 'function') {
            (this.graph as any).removeLink(existingLinkId);
        }
        return true;
    }

    private resolveInputBuffer(visited?: Set<number>): AudioBuffer | undefined {
        const cycleSet = visited || new Set<number>();
        if (cycleSet.has(this.id)) return undefined;
        cycleSet.add(this.id);

        const inputs = this.getInputNodes();
        const singleInput = inputs[0];
        if (!singleInput) {
            this._cachedPassBuffer = null;
            this._lastSourceBuffer = null;
            return undefined;
        }
        const raw = (singleInput as any).manifestStemBuffer
            || (singleInput as any)._lastRenderedBuffer
            || (singleInput as any).getAudioBuffer?.(cycleSet)
            || (singleInput as any).audioBuffer
            || (singleInput.id === (window as any).activeRamPreviewNodeId ? globalAudioScheduler.getFullAudioBuffer() : undefined);
        if (!raw) {
            this._cachedPassBuffer = null;
            this._lastSourceBuffer = null;
            return undefined;
        }

        const nodeGain = getNodeGainMultiplier(this);
        if (this._cachedPassBuffer && this._lastSourceBuffer === raw && this._lastGain === nodeGain) {
            return this._cachedPassBuffer;
        }
        const scaled = (nodeGain !== 1.0) ? applyGainToBuffer(raw, nodeGain) : raw;
        this._cachedPassBuffer = scaled;
        this._lastSourceBuffer = raw;
        this._lastGain = nodeGain;
        return scaled;
    }

    override getAudioBuffer(visited?: Set<number>): AudioBuffer | null {
        return (this as any).manifestStemBuffer
            || (this as any)._lastRenderedBuffer
            || this.resolveInputBuffer(visited)
            || null;
    }

    override updateProperty(key: string, value: any): void {
        if (key === 'chain' || key === 'gain') {
            this._cachedPassBuffer = null;
            this._lastSourceBuffer = null;
        }
        super.updateProperty(key, value);
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
            } else if ((this as any).realtimePeaks) {
                const dur = Number((this as any).realtimePeaksDuration || telemetry.duration || 1);
                const progress = dur > 0 ? (((telemetry.time % dur) + dur) % dur) / dur : 0;
                const sampled = samplePeaksMeterLevels((this as any).realtimePeaks as Float32Array, progress, 0.025);
                rawRms = sampled.rms;
                rawPeak = sampled.peak;
            } else {
                const buf = this.getAudioBuffer();
                if (buf && buf.length > 0) {
                    const dur = buf.duration > 0 ? buf.duration : (telemetry.duration || 1);
                    const sampled = sampleBufferMeterLevels(buf, telemetry.time, dur, 0.045);
                    rawRms = sampled.rms;
                    rawPeak = sampled.peak;
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
        // Keep presentation toggle non-intrusive
    }
}

(NullNode as any).title = "Null";
LiteGraph.registerNodeType("Audio/Null", NullNode);
