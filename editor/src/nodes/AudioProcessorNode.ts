import { BaseNode, type NodeToolbarControl } from './BaseNode.ts';
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
import { applyGainToBuffer, getNodeGainMultiplier, mixAudioBuffers } from '../audioCompositor.ts';

export type ProcessorCookState =
    | 'ready'
    | 'bypassed'
    | 'cooking_bypassed'
    | 'partial_ready'
    | 'stale_bypassed'
    | 'model_missing'
    | 'downloading'
    | 'error';

export interface ProcessorStatusSnapshot {
    node_id?: string;
    node_type?: string;
    node_name?: string;
    state: ProcessorCookState;
    progress?: number;
    phase?: string;
    cook_ms?: number;
    model_id?: string;
    model_status?: Record<string, any>;
    stem_rms?: { voice?: number; reverb?: number; ambience?: number };
    detected_spurs_hz?: number[];
    profile_id?: string;
    error?: string;
}

/**
 * Abstract base class for standalone cooked Python DSP processor nodes.
 * Inherits full BaseNode loop-buffer, IRIDE visualization, FX chain, export, and modifier support
 * without touching `engine/` or `core/fx.py`.
 */
export abstract class AudioProcessorNode extends BaseNode {
    static readonly isAudioProcessor = true;
    static processorParamKeys: readonly string[] = [];

    private _cachedPassBuffer: AudioBuffer | null = null;
    private _lastSourceBuffers: AudioBuffer[] = [];
    private _lastGain: number = 1.0;
    public hasClipWarning = false;
    private _smoothedRms = 0;
    private _smoothedPeak = 0;
    private _peakHoldUntil = 0;
    private _lastVisualUpdateMs = 0;
    private _clipFlashUntil = 0;
    private _isActivelyClipping = false;

    public processorStatus: ProcessorStatusSnapshot = {
        state: 'ready',
        progress: 1,
        phase: 'ready',
    };

    static override defaultShape: 'through' = 'through';
    static override defaultVisualizationType: VisualizationTypeId = 'loop';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['loop', 'realtime', 'spectrum'];

    constructor() {
        super();
        this.addInput('Input', 'audio');
        this.addOutput('Audio', 'audio');
    }

    get isAudioProcessor(): boolean {
        return true;
    }

    getProcessorParamKeys(): readonly string[] {
        return (this.constructor as typeof AudioProcessorNode).processorParamKeys || [];
    }

    getProcessorParams(): Record<string, any> {
        const out: Record<string, any> = {};
        const props = this.properties || {};
        for (const key of this.getProcessorParamKeys()) {
            if (props[key] !== undefined) {
                out[key] = props[key];
            }
        }
        return out;
    }

    prepareSerializedModel(model: Record<string, any>): Record<string, any> {
        const globalBars = typeof window !== 'undefined' ? (window as any).getGlobalParameter?.('total_bars') : undefined;
        const ownBars = this.properties?.total_bars;
        const isFree = ownBars === 'auto' || ownBars === 'free'
            || (typeof ownBars === 'number' && ownBars <= 0)
            || ((ownBars == null || ownBars === 'global') && typeof globalBars === 'number' && globalBars <= 0);
        return {
            ...model,
            node_type: this.nodeType,
            total_bars: isFree ? undefined : model.total_bars,
            processor_params: this.getProcessorParams(),
        };
    }

    isComplexMl(): boolean {
        if (this.nodeType === 'voice_isolator') {
            return String(this.properties?.backend || 'fast_onnx').toLowerCase() !== 'dsp_lite';
        }
        return false;
    }

    requestCookFullTrack(enable: boolean = true): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sin-cook-full-track', {
                detail: { nodeId: this.id, enable },
            }));
        }
    }

    emitLiveParam(key: string, value: any, commit: boolean = true): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sin-processor-live-param', {
                detail: { nodeId: this.id, key, value, commit },
            }));
        }
    }

    applyProcessorStatus(status: Partial<ProcessorStatusSnapshot>): void {
        this.processorStatus = {
            ...this.processorStatus,
            ...status,
            state: (status.state || this.processorStatus.state || 'ready') as ProcessorCookState,
        };
        // Foreground-only dirty keeps graph pan/zoom smooth without redrawing background grid
        this.setDirtyCanvas?.(true, false);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sin-processor-status-changed', {
                detail: { nodeId: this.id, status: this.processorStatus },
            }));
        }
    }

    override resolveVisualizationSignal(telemetry?: SignalTelemetry) {
        const base = super.resolveVisualizationSignal(telemetry);
        if (this.properties?.bypass) {
            return { ...base, isLoading: false, loadingLabel: undefined };
        }
        const st = this.processorStatus?.state || 'ready';
        const pct = Math.round(Math.max(0, Math.min(1, Number(this.processorStatus?.progress ?? 0))) * 100);
        if (st === 'cooking_bypassed') {
            return {
                ...base,
                isLoading: true,
                loadingProgress: this.processorStatus?.progress ?? 0,
                loadingLabel: pct > 0 ? `Cooking ${pct}% · Dry` : 'Cooking · Dry',
            };
        }
        if (st === 'downloading') {
            return {
                ...base,
                isLoading: true,
                loadingProgress: this.processorStatus?.progress ?? 0,
                loadingLabel: `Downloading ${pct}%`,
            };
        }
        if (st === 'partial_ready' && pct < 100) {
            return {
                ...base,
                isLoading: true,
                loadingProgress: this.processorStatus?.progress ?? 0,
                loadingLabel: `Precook ${pct}%`,
            };
        }
        return base;
    }

    requestManualCook(): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sin-cook-processor-node', {
                detail: { nodeId: this.id },
            }));
        }
    }

    override getToolbarControls(): NodeToolbarControl[] {
        const isBypassed = Boolean(this.properties?.bypass);
        const cookMode = String(this.properties?.cook_mode || 'auto');
        const controls: NodeToolbarControl[] = [
            {
                kind: 'toggle',
                id: 'bypass',
                label: isBypassed ? 'Bypassed' : 'Active',
                title: 'Bypass processor (passes clean dry audio)',
                active: isBypassed,
                tone: isBypassed ? 'amber' : 'emerald',
                onToggle: () => {
                    const next = !Boolean(this.properties?.bypass);
                    this.updateProperty('bypass', next);
                    this.applyProcessorStatus({ state: next ? 'bypassed' : 'ready', phase: next ? 'bypassed' : 'active' });
                    if (typeof window !== 'undefined') {
                        if ((window as any).__sinRealtimeTiled) {
                            this.emitLiveParam('bypass', next, true);
                        } else {
                            window.dispatchEvent(new CustomEvent('sin-node-preview-refresh', { detail: { nodeId: this.id } }));
                        }
                    }
                },
            },
            {
                kind: 'segmented',
                id: 'cook_mode',
                title: 'Auto cooks after 500ms edit debounce; Manual holds Bypassed (Stale) until Process is clicked',
                value: cookMode,
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'manual', label: 'Manual' },
                ],
                onChange: (val: string) => {
                    const nextMode = val === 'manual' ? 'manual' : 'auto';
                    this.updateProperty('cook_mode', nextMode);
                    if (typeof window !== 'undefined') {
                        if ((window as any).__sinRealtimeTiled) {
                            this.emitLiveParam('cook_mode', nextMode, true);
                        } else {
                            window.dispatchEvent(new CustomEvent('sin-node-preview-refresh', { detail: { nodeId: this.id } }));
                        }
                    }
                },
            },
        ];
        if (cookMode === 'manual' || this.processorStatus.state === 'stale_bypassed') {
            controls.push({
                kind: 'button',
                id: 'process_now',
                label: 'Process',
                title: 'Cook this processor node now',
                onClick: () => this.requestManualCook(),
            });
        }
        if (this.isComplexMl()) {
            controls.push({
                kind: 'button',
                id: 'cook_full_track',
                label: 'Cook Full',
                title: 'Cook ML across the entire track in background (beyond the sliding precook window)',
                onClick: () => this.requestCookFullTrack(true),
            });
        }
        return controls;
    }

    private _liveParamLastSentAt = 0;
    private static readonly STRUCTURAL_KEYS = new Set([
        'profile_id', 'stft_mode', 'hp_hz', 'noise_start', 'noise_end',
        'backend', 'reverb_sensitivity', 'cook_mode', 'bypass', 'precook_window_sec',
    ]);

    override updateProperty(key: string, value: any): void {
        if (key === 'chain' || key === 'gain') {
            this._cachedPassBuffer = null;
            this._lastSourceBuffers = [];
        }
        if (key === 'bypass') {
            this.processorStatus = {
                ...this.processorStatus,
                state: value ? 'bypassed' : (this.processorStatus.state === 'bypassed' ? 'ready' : this.processorStatus.state),
            };
        }
        super.updateProperty(key, value);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sin-processor-prop-changed', {
                detail: { nodeId: this.id, key, value },
            }));
            // Stream fast Level-2 synth knob drags live to the active playhead tile (throttled ~45ms)
            if (
                (window as any).__sinRealtimeTiled
                && this.getProcessorParamKeys().includes(key)
                && !AudioProcessorNode.STRUCTURAL_KEYS.has(key)
            ) {
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                if (now - this._liveParamLastSentAt >= 45) {
                    this._liveParamLastSentAt = now;
                    this.emitLiveParam(key, value, false);
                }
            }
        }
    }

    private resolveInputBuffer(visited?: Set<number>): AudioBuffer | undefined {
        const cycleSet = visited || new Set<number>();
        if (cycleSet.has(this.id)) return undefined;
        cycleSet.add(this.id);

        const inputs = this.getInputNodes();
        const available: AudioBuffer[] = [];
        for (const inputNode of inputs) {
            const buf = (inputNode as any).manifestStemBuffer
                || (inputNode as any)._lastRenderedBuffer
                || (inputNode as any).getAudioBuffer?.(cycleSet)
                || (inputNode as any).audioBuffer
                || (inputNode.id === (window as any).activeRamPreviewNodeId ? globalAudioScheduler.getFullAudioBuffer() : undefined);
            if (buf) available.push(buf);
        }
        if (available.length === 0) {
            this._cachedPassBuffer = null;
            this._lastSourceBuffers = [];
            return undefined;
        }
        const nodeGain = getNodeGainMultiplier(this);
        const same = available.length === this._lastSourceBuffers.length
            && available.every((b, i) => b === this._lastSourceBuffers[i]);
        if (this._cachedPassBuffer && same && this._lastGain === nodeGain) {
            return this._cachedPassBuffer;
        }
        const raw = available.length === 1 ? available[0] : mixAudioBuffers(available);
        if (!raw) return undefined;
        const scaled = nodeGain !== 1.0 ? applyGainToBuffer(raw, nodeGain) : raw;
        this._cachedPassBuffer = scaled;
        this._lastSourceBuffers = [...available];
        this._lastGain = nodeGain;
        return scaled;
    }

    override getAudioBuffer(visited?: Set<number>): AudioBuffer | null {
        return (this as any).manifestStemBuffer
            || (this as any)._lastRenderedBuffer
            || this.resolveInputBuffer(visited)
            || null;
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
            if (!isParamOpen) this.hasClipWarning = true;
        }
        this._isActivelyClipping = Boolean(isPlaying && (hitClip || now < this._clipFlashUntil));
    }

    override onParametersOpened(): void {
        if (this.hasClipWarning) {
            this.hasClipWarning = false;
            this.setDirtyCanvas?.(true, true);
        }
    }

    protected getProcessorBadgeInfo(): { text: string; bg: string; fg: string } | null {
        const st = this.properties?.bypass ? 'bypassed' : (this.processorStatus?.state || 'ready');
        const pct = Math.round((this.processorStatus?.progress ?? 0) * 100);
        switch (st) {
            case 'bypassed':
                return { text: 'BYPASS', bg: 'rgba(245,158,11,0.28)', fg: '#fde68a' };
            case 'cooking_bypassed':
                return { text: `COOK ${pct}%`, bg: 'rgba(56,189,248,0.28)', fg: '#bae6fd' };
            case 'partial_ready':
                return { text: `PARTIAL ${pct}%`, bg: 'rgba(16,185,129,0.28)', fg: '#a7f3d0' };
            case 'stale_bypassed':
                return { text: 'STALE', bg: 'rgba(245,158,11,0.32)', fg: '#fcd34d' };
            case 'model_missing':
                return { text: 'MODEL?', bg: 'rgba(239,68,68,0.30)', fg: '#fecaca' };
            case 'downloading':
                return { text: `DL ${pct}%`, bg: 'rgba(139,92,246,0.32)', fg: '#ddd6fe' };
            case 'error':
                return { text: 'ERR', bg: 'rgba(239,68,68,0.36)', fg: '#fca5a5' };
            default:
                return null;
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
        if (this.properties?.bypass || this.processorStatus.state === 'cooking_bypassed') {
            traceNodeShape(ctx, this.nodeShape, 1, 1, size - 2);
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = this.properties?.bypass ? '#f59e0b' : '#38bdf8';
            ctx.stroke();
            ctx.setLineDash([]);
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

        const badge = this.getProcessorBadgeInfo();
        if (badge && width >= 120) {
            ctx.save();
            ctx.font = '600 9px "Inter", system-ui, sans-serif';
            const tw = ctx.measureText(badge.text).width;
            const bw = tw + 10;
            const bh = 14;
            const bx = Math.max(4, width - bw - 6);
            const by = Math.round((headerHeight - bh) * 0.5);
            ctx.fillStyle = badge.bg;
            ctx.beginPath();
            ctx.roundRect?.(bx, by, bw, bh, 3);
            if (!ctx.roundRect) ctx.rect(bx, by, bw, bh);
            ctx.fill();
            ctx.fillStyle = badge.fg;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(badge.text, bx + bw * 0.5, by + bh * 0.5 + 0.5);
            ctx.restore();
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
        } else {
            const [width, height] = this.size;
            traceNodeShape(ctx, this.nodeShape, -3, -3, width + 6, height + 6);
            ctx.stroke();
        }
        ctx.restore();
    }
}
