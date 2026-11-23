import { type SignalTelemetry, type WaveformSignal } from '../types.ts';

/**
 * Clean 2D canvas drawing and signal helpers for IRIDE visualizations.
 */

export interface MatteNodePalette {
    readonly panelBg: string;
    readonly borderHover: string;
    readonly borderSelected: string;
    readonly iconBg: string;
    readonly iconSelectedRing: string;
    readonly iconSelectedHalo: string;
}

const MATTE_PALETTE_CACHE = new Map<string, MatteNodePalette>();
const MAX_MATTE_CACHE_SIZE = 48;

function parseColorRgb(color: string): [number, number, number] {
    if (color && color.startsWith('#')) {
        let c = color.slice(1).trim();
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        if (c.length >= 6) {
            const num = parseInt(c.slice(0, 6), 16);
            if (!Number.isNaN(num)) {
                return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
            }
        }
    }
    const match = String(color || '').match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
    if (match) {
        return [
            Math.max(0, Math.min(255, Math.round(Number(match[1])))),
            Math.max(0, Math.min(255, Math.round(Number(match[2])))),
            Math.max(0, Math.min(255, Math.round(Number(match[3]))))
        ];
    }
    return [100, 116, 139];
}

function mixRgbWithWhite(r: number, g: number, b: number, alpha: number): string {
    const mr = Math.round(255 * (1 - alpha) + r * alpha);
    const mg = Math.round(255 * (1 - alpha) + g * alpha);
    const mb = Math.round(255 * (1 - alpha) + b * alpha);
    return `rgb(${mr}, ${mg}, ${mb})`;
}

export function deriveMatteNodePalette(baseColor: string): MatteNodePalette {
    const key = String(baseColor || '#64748b').trim().toLowerCase();
    const cached = MATTE_PALETTE_CACHE.get(key);
    if (cached) return cached;

    const [r, g, b] = parseColorRgb(key);
    const surfaceBg = mixRgbWithWhite(r, g, b, 0.16);
    const borderHover = mixRgbWithWhite(r, g, b, 0.45);
    const borderSelected = `rgb(${r}, ${g}, ${b})`;

    const palette: MatteNodePalette = {
        panelBg: surfaceBg,
        borderHover,
        borderSelected,
        iconBg: surfaceBg,
        iconSelectedRing: borderSelected,
        iconSelectedHalo: 'transparent'
    };

    if (MATTE_PALETTE_CACHE.size >= MAX_MATTE_CACHE_SIZE) {
        const oldest = MATTE_PALETTE_CACHE.keys().next().value;
        if (oldest !== undefined) MATTE_PALETTE_CACHE.delete(oldest);
    }
    MATTE_PALETTE_CACHE.set(key, palette);
    return palette;
}

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
    color = '#000000'
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
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
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

/**
 * Computes un-clamped stereo RMS and true peak over a trailing window of an AudioBuffer
 * at the given playhead time. Preserves values >= 1.0 so clipping is detected accurately.
 */
export function sampleBufferMeterLevels(
    buffer: AudioBuffer | null | undefined,
    timeSec: number,
    durationSec: number,
    windowSeconds = 0.045
): { rms: number; peak: number; active: boolean } {
    if (!buffer || buffer.length <= 0) {
        return { rms: 0, peak: 0, active: false };
    }
    const sr = buffer.sampleRate || 44100;
    const totalSamples = buffer.length;
    const dur = durationSec > 0 ? durationSec : (buffer.duration > 0 ? buffer.duration : totalSamples / sr);
    if (dur <= 0) {
        return { rms: 0, peak: 0, active: false };
    }
    const wrappedTime = ((timeSec % dur) + dur) % dur;
    const normPos = Math.max(0, Math.min(1, wrappedTime / dur));
    const windowSamples = Math.max(32, Math.min(4096, Math.floor(windowSeconds * sr)));
    const endSample = Math.min(totalSamples, Math.max(1, Math.floor(normPos * totalSamples)));
    const startSample = Math.max(0, endSample - windowSamples);
    const count = Math.max(1, endSample - startSample);

    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    let peak = 0;
    let sumSq = 0;

    if (ch1) {
        for (let i = startSample; i < endSample; i++) {
            const l = ch0[i];
            const r = ch1[i];
            const al = l < 0 ? -l : l;
            const ar = r < 0 ? -r : r;
            if (al > peak) peak = al;
            if (ar > peak) peak = ar;
            sumSq += 0.5 * (l * l + r * r);
        }
    } else {
        for (let i = startSample; i < endSample; i++) {
            const v = ch0[i];
            const av = v < 0 ? -v : v;
            if (av > peak) peak = av;
            sumSq += v * v;
        }
    }

    return {
        rms: Math.sqrt(sumSq / count),
        peak,
        active: true
    };
}

/**
 * Estimates RMS and peak meter levels around normalized progress [0..1] from interleaved [min, max] peaks.
 */
export function samplePeaksMeterLevels(
    peaks: Float32Array | null | undefined,
    progress: number,
    windowFraction = 0.025
): { rms: number; peak: number; active: boolean } {
    if (!peaks || peaks.length < 2) {
        return { rms: 0, peak: 0, active: false };
    }
    const cols = Math.floor(peaks.length / 2);
    if (cols <= 0) return { rms: 0, peak: 0, active: false };
    const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const endCol = Math.min(cols, Math.max(1, Math.ceil(p * cols)));
    const span = Math.max(1, Math.min(cols, Math.ceil(cols * windowFraction)));
    const startCol = Math.max(0, endCol - span);
    let peak = 0;
    let sumSq = 0;
    let count = 0;
    for (let i = startCol; i < endCol; i++) {
        const mn = Math.abs(peaks[i * 2]);
        const mx = Math.abs(peaks[i * 2 + 1]);
        const colPeak = mn > mx ? mn : mx;
        if (colPeak > peak) peak = colPeak;
        const estRms = colPeak * 0.7071;
        sumSq += estRms * estRms;
        count++;
    }
    return {
        rms: count > 0 ? Math.sqrt(sumSq / count) : 0,
        peak,
        active: true
    };
}
