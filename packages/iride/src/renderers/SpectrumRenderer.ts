import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type WaveformSignal, type RendererOptions } from '../types.ts';
import {
    colorWithAlpha,
    drawRoundRect,
    drawSlotBadge,
    extractRealtimeSliceFromSignal
} from '../utils/drawingUtils.ts';
import {
    FFT_SIZE,
    computeLogSpectrum,
    computeLogSpectrumFromByteBins
} from '../utils/fft.ts';

const NUM_POINTS = 96;
const MIN_FREQ = 30;
const MAX_FREQ = 20000;
const LOG_FREQ_SPAN = Math.log(MAX_FREQ / MIN_FREQ);

const FREQ_MARKERS: ReadonlyArray<{ hz: number; label: string; normX: number }> = [
    { hz: 100, label: '100', normX: Math.log(100 / MIN_FREQ) / LOG_FREQ_SPAN },
    { hz: 1000, label: '1k', normX: Math.log(1000 / MIN_FREQ) / LOG_FREQ_SPAN },
    { hz: 10000, label: '10k', normX: Math.log(10000 / MIN_FREQ) / LOG_FREQ_SPAN }
];

export class SpectrumRenderer extends BaseSignalRenderer {
    private signal: WaveformSignal | null = null;
    private readonly rawSlice = new Float32Array(FFT_SIZE);
    private readonly targetPoints = new Float32Array(NUM_POINTS);
    private readonly smoothedPoints = new Float32Array(NUM_POINTS);
    private readonly peakEnvelope = new Float32Array(NUM_POINTS);

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#059669',
            ...options
        });
    }

    setSignal(signal: WaveformSignal | null): void {
        this.signal = signal;
        this.markDirty();
    }

    render(
        ctx: CanvasRenderingContext2D,
        bounds: RenderBox,
        telemetry?: SignalTelemetry
    ): void {
        const { x, y, width, height } = bounds;
        if (width <= 0 || height <= 0) return;

        ctx.save();
        drawRoundRect(ctx, x, y, width, height, 4);
        ctx.clip();

        ctx.fillStyle = this.options.backgroundColor || '#ffffff';
        ctx.fillRect(x, y, width, height);

        const signal = this.signal;
        const accent = signal?.accentColor || this.options.accentColor || '#059669';
        const gain = Number(this.options.scopeGain) || 1.0;
        const bottomY = y + height - 1;
        const topPad = 3;
        const usableH = Math.max(8, height - topPad - 1);

        // Analytical dB reference grid (-16dB, -32dB, -48dB) and log-frequency lines (100Hz, 1kHz, 10kHz)
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let d = 1; d <= 3; d++) {
            const gy = Math.floor(y + topPad + (d / 4) * usableH) + 0.5;
            ctx.moveTo(x, gy);
            ctx.lineTo(x + width, gy);
        }
        for (const m of FREQ_MARKERS) {
            const gx = Math.floor(x + m.normX * width) + 0.5;
            ctx.moveTo(gx, y);
            ctx.lineTo(gx, y + height);
        }
        ctx.stroke();

        // Compute real-time 1024-pt FFT spectrum for this node
        const hasSlice = extractRealtimeSliceFromSignal(signal, telemetry, this.rawSlice, gain);
        if (hasSlice) {
            const sr = signal?.buffer?.sampleRate || 44100;
            computeLogSpectrum(this.rawSlice, this.targetPoints, sr);
        } else if (
            telemetry?.isPlaying &&
            signal?.isTriggered !== false &&
            telemetry.realtimeSpectrum &&
            telemetry.realtimeSpectrum.length > 0
        ) {
            computeLogSpectrumFromByteBins(telemetry.realtimeSpectrum, this.targetPoints);
        } else {
            this.targetPoints.fill(0);
        }

        // Update fast real-time curve and slower peak-hold envelope
        let hasVisibleEnergy = false;
        for (let i = 0; i < NUM_POINTS; i++) {
            const target = this.targetPoints[i];
            const prev = this.smoothedPoints[i];
            const next = target > prev
                ? prev * 0.2 + target * 0.8
                : prev * 0.74;
            this.smoothedPoints[i] = next < 0.003 ? 0 : next;

            if (this.smoothedPoints[i] >= this.peakEnvelope[i]) {
                this.peakEnvelope[i] = this.smoothedPoints[i];
            } else {
                this.peakEnvelope[i] = Math.max(0, this.peakEnvelope[i] - 0.012);
            }

            if (this.peakEnvelope[i] > 0.005) {
                hasVisibleEnergy = true;
            }
        }

        const stepX = width / (NUM_POINTS - 1);
        const strokeColor = signal?.isInvalidated ? 'rgba(245, 158, 11, 0.85)' : accent;

        if (hasVisibleEnergy) {
            // 1. Secondary Peak-Hold Envelope Trace
            ctx.strokeStyle = colorWithAlpha(strokeColor, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < NUM_POINTS; i++) {
                const px = x + i * stepX;
                const py = bottomY - this.peakEnvelope[i] * usableH;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();

            // 2. Filled Area Under Live FFT Curve
            ctx.fillStyle = colorWithAlpha(strokeColor, 0.18);
            ctx.beginPath();
            ctx.moveTo(x, bottomY);
            for (let i = 0; i < NUM_POINTS; i++) {
                const px = x + i * stepX;
                const py = bottomY - this.smoothedPoints[i] * usableH;
                ctx.lineTo(px, py);
            }
            ctx.lineTo(x + width, bottomY);
            ctx.closePath();
            ctx.fill();

            // 3. Primary Live FFT Curve Stroke
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 1.35;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i = 0; i < NUM_POINTS; i++) {
                const px = x + i * stepX;
                const py = bottomY - this.smoothedPoints[i] * usableH;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        // Frequency axis micro-labels in normal view
        if (!this.options.minified && height >= 36) {
            ctx.fillStyle = 'rgba(100, 116, 139, 0.75)';
            ctx.font = '7.5px Inter, monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            for (const m of FREQ_MARKERS) {
                const gx = Math.floor(x + m.normX * width) + 2;
                ctx.fillText(m.label, gx, y + height - 1);
            }
        }

        if (!this.options.minified) {
            drawSlotBadge(ctx, x, y, signal?.activeSlot, signal?.slotCount);
        }

        ctx.restore();
    }
}
