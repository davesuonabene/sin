import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type WaveformSignal, type RendererOptions } from '../types.ts';
import {
    colorWithAlpha,
    drawRoundRect,
    drawSlotBadge,
    sampleSignalAmplitude
} from '../utils/drawingUtils.ts';

const HISTORY_COLS = 128;
const WINDOW_SECONDS = 2.0;
const STEP_SECONDS = WINDOW_SECONDS / HISTORY_COLS;

/**
 * Real-time horizontal scrolling amplitude & RMS envelope visualizer.
 * Newest signal amplitude enters on the right and scrolls horizontally to the left.
 */
export class OscilloscopeRenderer extends BaseSignalRenderer {
    private signal: WaveformSignal | null = null;
    private readonly historyMin = new Float32Array(HISTORY_COLS);
    private readonly historyMax = new Float32Array(HISTORY_COLS);
    private readonly historyRms = new Float32Array(HISTORY_COLS);
    private writeIndex = 0;
    private lastTime = -1;
    private wasPlaying = false;

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

    private pushColumn(min: number, max: number, rms: number): void {
        this.historyMin[this.writeIndex] = min;
        this.historyMax[this.writeIndex] = max;
        this.historyRms[this.writeIndex] = rms;
        this.writeIndex = (this.writeIndex + 1) % HISTORY_COLS;
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

        const midY = y + height * 0.5;
        const halfH = (height - 4) * 0.5;
        const signal = this.signal;
        const accent = signal?.accentColor || this.options.accentColor || '#059669';
        const gain = Number(this.options.scopeGain) || 1.0;
        const isPlaying = Boolean(telemetry?.isPlaying);

        // Reference lines: 0 center line and ±0.5 (-6 dB) amplitude guides
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        const guideTop = Math.floor(midY - halfH * 0.5) + 0.5;
        const guideBot = Math.floor(midY + halfH * 0.5) + 0.5;
        ctx.moveTo(x, guideTop);
        ctx.lineTo(x + width, guideTop);
        ctx.moveTo(x, guideBot);
        ctx.lineTo(x + width, guideBot);
        ctx.stroke();

        // Advance horizontal scrolling history during playback
        if (isPlaying && telemetry) {
            if (!this.wasPlaying) {
                this.lastTime = telemetry.time;
                this.wasPlaying = true;
            }
            const dt = telemetry.time >= this.lastTime
                ? (telemetry.time - this.lastTime)
                : STEP_SECONDS;

            if (dt >= STEP_SECONDS * 0.45 || this.lastTime === telemetry.time) {
                const steps = Math.max(1, Math.min(6, Math.round(Math.max(STEP_SECONDS, dt) / STEP_SECONDS)));
                const amp = sampleSignalAmplitude(signal, telemetry, STEP_SECONDS * steps, gain);
                for (let s = 0; s < steps; s++) {
                    this.pushColumn(amp.min, amp.max, amp.rms);
                }
                this.lastTime = telemetry.time;
            }
        } else {
            this.wasPlaying = false;
        }

        const rightMargin = 4;
        const plotW = Math.max(10, width - rightMargin);
        const colW = plotW / HISTORY_COLS;
        const barW = Math.max(1, colW - 0.35);

        const peakFill = signal?.isInvalidated
            ? 'rgba(245, 158, 11, 0.38)'
            : colorWithAlpha(accent, 0.38);
        const rmsFill = signal?.isInvalidated
            ? 'rgba(245, 158, 11, 0.88)'
            : accent;

        // Render scrolling columns from oldest (left) to newest (right)
        for (let i = 0; i < HISTORY_COLS; i++) {
            const ringIdx = (this.writeIndex + i) % HISTORY_COLS;
            const min = this.historyMin[ringIdx];
            const max = this.historyMax[ringIdx];
            const rms = this.historyRms[ringIdx];

            if (max - min < 0.002 && rms < 0.001) continue;

            const colX = x + i * colW;

            // Outer Peak envelope (min..max)
            const peakTop = midY - max * halfH;
            const peakBot = midY - min * halfH;
            const peakH = Math.max(1.25, peakBot - peakTop);
            ctx.fillStyle = peakFill;
            ctx.fillRect(colX, peakTop, barW, peakH);

            // Inner RMS energy core (-rms..+rms)
            if (rms > 0.002) {
                const rmsTop = midY - rms * halfH;
                const rmsH = Math.max(1.25, rms * 2 * halfH);
                ctx.fillStyle = rmsFill;
                ctx.fillRect(colX, rmsTop, barW, rmsH);
            }
        }

        // Right-edge live entry head ("NOW" playhead line)
        if (isPlaying) {
            const headX = x + plotW;
            ctx.strokeStyle = '#0284c7';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(headX, y + 1);
            ctx.lineTo(headX, y + height - 1);
            ctx.stroke();
        }

        if (!this.options.minified) {
            drawSlotBadge(ctx, x, y, signal?.activeSlot, signal?.slotCount);
        }

        ctx.restore();
    }
}
