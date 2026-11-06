import { type SignalTelemetry, type WaveformSignal } from '../types.ts';

/**
 * Clean 2D canvas drawing and signal helpers for IRIDE visualizations.
 */

export function colorWithAlpha(color: string, alpha: number): string {
    if (!color) return `rgba(5, 150, 105, ${alpha})`;
    if (color.startsWith('#')) {
        let c = color.slice(1);
        if (c.length === 3) c = c.split('').map(x => x + x).join('');
        const num = parseInt(c, 16);
        if (!isNaN(num)) {
            const r = (num >> 16) & 255;
            const g = (num >> 8) & 255;
            const b = num & 255;
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
    }
    if (color.startsWith('rgb(')) {
        return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    }
    if (color.startsWith('rgba(')) {
        return color.replace(/[\d.]+\)$/, `${alpha})`);
    }
    return color;
}

export function getOrCreateOffscreenCanvas(
    existing: HTMLCanvasElement | null,
    width: number,
    height: number
): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (existing) {
        if (existing.width !== w || existing.height !== h) {
            existing.width = w;
            existing.height = h;
        }
        return existing;
    }
    try {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    } catch {
        return null;
    }
}

export function drawRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number | number[] = 4
): void {
    ctx.beginPath();
    const rawR = typeof radius === 'number' ? radius : (radius[0] || 0);
    const maxR = Math.max(0, Math.min(width / 2, height / 2));
    const r = Math.max(0, Math.min(rawR, maxR));
    if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(x, y, width, height, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

export function drawPlayhead(
    ctx: CanvasRenderingContext2D,
    x: number,
    topY: number,
    bottomY: number,
    color = '#38bdf8'
): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, bottomY);
    ctx.stroke();

    // Top indicator beacon
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, topY + 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

export function drawSlotBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    activeSlot?: number,
    slotCount?: number
): void {
    if ((slotCount ?? 1) <= 1) return;
    const label = `[${activeSlot ?? 0}/${slotCount}]`;
    ctx.font = 'bold 8px Inter, monospace';
    const textW = ctx.measureText(label).width;
    const pillW = textW + 6;
    const pillH = 11;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    drawRoundRect(ctx, x + 3, y + 3, pillW, pillH, 2.5);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 6, y + 3 + pillH * 0.5);
}

/**
 * Extracts a time-domain sample window for a specific node at the current transport playhead.
 * Ensures oscilloscope and spectrum visualizers display that node's own signal truthfully.
 */
export function extractRealtimeSliceFromSignal(
    signal: WaveformSignal | null,
    telemetry: SignalTelemetry | undefined,
    outSlice: Float32Array,
    gain = 1.0
): boolean {
    const N = outSlice.length;
    if (!telemetry?.isPlaying || signal?.isTriggered === false) {
        outSlice.fill(0);
        return false;
    }

    const buffer = signal?.buffer;
    if (buffer && buffer.length > 0) {
        const totalSamples = buffer.length;
        let normPos = 0;
        if (signal?.playbackProgress != null) {
            normPos = Math.max(0, Math.min(1, signal.playbackProgress));
        } else {
            const dur = (signal?.duration && signal.duration > 0)
                ? signal.duration
                : (buffer.duration > 0 ? buffer.duration : (telemetry.duration || 1));
            normPos = dur > 0 ? (((telemetry.time % dur) + dur) % dur) / dur : 0;
        }

        const centerSample = Math.floor(normPos * totalSamples);
        const startSample = Math.max(0, Math.min(totalSamples - N, centerSample - (N >> 1)));
        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

        if (ch1) {
            for (let i = 0; i < N; i++) {
                const idx = (startSample + i) % totalSamples;
                const val = (ch0[idx] + ch1[idx]) * 0.5 * gain;
                outSlice[i] = Math.max(-1, Math.min(1, val));
            }
        } else {
            for (let i = 0; i < N; i++) {
                const idx = (startSample + i) % totalSamples;
                const val = ch0[idx] * gain;
                outSlice[i] = Math.max(-1, Math.min(1, val));
            }
        }
        return true;
    }

    if (telemetry.realtimeScope && telemetry.realtimeScope.length >= 2) {
        const src = telemetry.realtimeScope;
        const srcLen = src.length;
        for (let i = 0; i < N; i++) {
            const srcIdx = Math.min(srcLen - 1, Math.floor((i / N) * srcLen));
            outSlice[i] = Math.max(-1, Math.min(1, src[srcIdx] * gain));
        }
        return true;
    }

    outSlice.fill(0);
    return false;
}

/**
 * Samples the instantaneous peak (min, max) and RMS amplitude of a node's signal
 * over a short time window at the current playhead position.
 */
export function sampleSignalAmplitude(
    signal: WaveformSignal | null,
    telemetry: SignalTelemetry | undefined,
    windowSeconds = 0.016,
    gain = 1.0
): { min: number; max: number; rms: number; active: boolean } {
    if (!telemetry?.isPlaying || signal?.isTriggered === false) {
        return { min: 0, max: 0, rms: 0, active: false };
    }

    const buffer = signal?.buffer;
    if (buffer && buffer.length > 0) {
        const sr = buffer.sampleRate || 44100;
        const totalSamples = buffer.length;
        let normPos = 0;
        if (signal?.playbackProgress != null) {
            normPos = Math.max(0, Math.min(1, signal.playbackProgress));
        } else {
            const dur = (signal?.duration && signal.duration > 0)
                ? signal.duration
                : (buffer.duration > 0 ? buffer.duration : (telemetry.duration || 1));
            normPos = dur > 0 ? (((telemetry.time % dur) + dur) % dur) / dur : 0;
        }

        const windowSamples = Math.max(32, Math.min(4096, Math.floor(windowSeconds * sr)));
        const endSample = Math.min(totalSamples, Math.max(1, Math.floor(normPos * totalSamples)));
        const startSample = Math.max(0, endSample - windowSamples);
        const count = Math.max(1, endSample - startSample);

        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

        let min = 0;
        let max = 0;
        let sumSq = 0;

        if (ch1) {
            for (let i = startSample; i < endSample; i++) {
                const v = Math.max(-1, Math.min(1, (ch0[i] + ch1[i]) * 0.5 * gain));
                if (v < min) min = v;
                if (v > max) max = v;
                sumSq += v * v;
            }
        } else {
            for (let i = startSample; i < endSample; i++) {
                const v = Math.max(-1, Math.min(1, ch0[i] * gain));
                if (v < min) min = v;
                if (v > max) max = v;
                sumSq += v * v;
            }
        }

        return {
            min,
            max,
            rms: Math.sqrt(sumSq / count),
            active: true
        };
    }

    if (telemetry.realtimeScope && telemetry.realtimeScope.length >= 2) {
        const src = telemetry.realtimeScope;
        let min = 0;
        let max = 0;
        let sumSq = 0;
        for (let i = 0; i < src.length; i++) {
            const v = Math.max(-1, Math.min(1, src[i] * gain));
            if (v < min) min = v;
            if (v > max) max = v;
            sumSq += v * v;
        }
        return {
            min,
            max,
            rms: Math.sqrt(sumSq / src.length),
            active: true
        };
    }

    return { min: 0, max: 0, rms: 0, active: false };
}
