import { colorWithAlpha, drawRoundRect } from './drawingUtils.ts';

export const MASTER_CLIP_THRESHOLD = 0.999;
export const RMS_LEVEL_STEPS = 16;
export const CLIP_FILL_COLOR = '#dc2626';
export const CLIP_MARKER_COLOR = '#ef4444';

export interface RmsHeaderStyle {
    readonly bg: string;
    readonly fg: string;
    readonly border: string;
}

export interface RadialLoopOptions {
    fillColor?: string;
    trackFill?: string;
    trackStroke?: string;
    dividerFractions?: readonly number[];
    dividerColor?: string;
    dimmed?: boolean;
}

const MAX_PALETTE_CACHE_SIZE = 32;
const rmsPaletteCache = new Map<string, string[]>();
const rmsHeaderCache = new Map<string, RmsHeaderStyle[]>();

const CLIP_HEADER_STYLE: RmsHeaderStyle = {
    bg: CLIP_FILL_COLOR,
    fg: '#ffffff',
    border: CLIP_FILL_COLOR
};

const IDLE_HEADER_STYLE: RmsHeaderStyle = {
    bg: '',
    fg: '#0f172a',
    border: ''
};

/**
 * Maps a linear RMS amplitude to a perceptual [0, 1] meter level over [-48 dBFS, 0 dBFS].
 */
export function rmsToMeterLevel(rms: number): number {
    if (!Number.isFinite(rms) || rms <= 1e-4) return 0;
    const db = 20 * Math.log10(rms);
    const norm = (db + 48) / 48;
    return norm <= 0 ? 0 : (norm >= 1 ? 1 : norm);
}

/**
 * Quantizes a normalized meter level [0, 1] to 16 discrete coherence buckets (0..15).
 */
export function quantizeMeterBucket(level: number): number {
    if (!Number.isFinite(level) || level <= 0) return 0;
    if (level >= 1) return RMS_LEVEL_STEPS - 1;
    return Math.round(level * (RMS_LEVEL_STEPS - 1));
}

function parseRgb(color: string): [number, number, number] | null {
    if (!color) return null;
    const trimmed = color.trim();
    if (trimmed.startsWith('#')) {
        let hex = trimmed.slice(1);
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        if (hex.length >= 6) {
            const num = parseInt(hex.slice(0, 6), 16);
            if (!Number.isNaN(num)) {
                return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
            }
        }
        return null;
    }
    const match = trimmed.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
    if (match) {
        return [
            Math.max(0, Math.min(255, Math.round(Number(match[1])))),
            Math.max(0, Math.min(255, Math.round(Number(match[2])))),
            Math.max(0, Math.min(255, Math.round(Number(match[3]))))
        ];
    }
    return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) * 0.5;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn) {
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
    } else if (max === gn) {
        h = (bn - rn) / d + 2;
    } else {
        h = (rn - gn) / d + 4;
    }
    return [h / 6, s, l];
}

function hueToChannel(p: number, q: number, tRaw: number): number {
    let t = tRaw;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

function hslToRgbString(h: number, s: number, l: number): string {
    if (s <= 0.0001) {
        const gray = Math.round(l * 255);
        return `rgb(${gray}, ${gray}, ${gray})`;
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = Math.round(hueToChannel(p, q, h + 1 / 3) * 255);
    const g = Math.round(hueToChannel(p, q, h) * 255);
    const b = Math.round(hueToChannel(p, q, h - 1 / 3) * 255);
    return `rgb(${r}, ${g}, ${b})`;
}

function setBounded<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= MAX_PALETTE_CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

function buildRmsPalette(baseColor: string): string[] {
    const palette: string[] = new Array(RMS_LEVEL_STEPS);
    palette[0] = baseColor;
    const rgb = parseRgb(baseColor);
    if (!rgb) {
        for (let i = 1; i < RMS_LEVEL_STEPS; i++) palette[i] = baseColor;
        return palette;
    }
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const denom = RMS_LEVEL_STEPS - 1;
    for (let step = 1; step < RMS_LEVEL_STEPS; step++) {
        const t = step / denom;
        let nextL: number;
        let nextS: number;
        if (l < 0.35) {
            nextL = l + t * (0.56 - l);
            nextS = Math.min(0.88, s + t * 0.32);
        } else if (l <= 0.72) {
            const floorL = l;
            const maxL = Math.min(0.78, l + 0.22);
            nextL = floorL + t * (maxL - floorL);
            nextS = Math.min(0.95, s + t * 0.22);
        } else {
            const floorL = l;
            const maxL = Math.max(0.45, l - 0.24);
            nextL = floorL + t * (maxL - floorL);
            nextS = Math.min(0.98, s + t * 0.25);
        }
        palette[step] = hslToRgbString(h, nextS, nextL);
    }
    return palette;
}

/**
 * Returns a quantized RMS-modulated color within `baseColor`'s own hue,
 * or vivid warning red when actively clipping.
 */
export function getQuantizedRmsColor(baseColor: string, level: number, isClipping: boolean): string {
    if (isClipping) return CLIP_FILL_COLOR;
    const key = baseColor || '#0f172a';
    let palette = rmsPaletteCache.get(key);
    if (!palette) {
        palette = buildRmsPalette(key);
        setBounded(rmsPaletteCache, key, palette);
    }
    return palette[quantizeMeterBucket(level)];
}

/**
 * Returns cached header background/foreground/border colors for an opened Master node.
 */
export function getQuantizedRmsHeaderStyle(
    baseColor: string,
    level: number,
    isClipping: boolean
): RmsHeaderStyle {
    if (isClipping) return CLIP_HEADER_STYLE;
    const bucket = quantizeMeterBucket(level);
    if (bucket === 0) return IDLE_HEADER_STYLE;

    const key = baseColor || '#0f172a';
    let styles = rmsHeaderCache.get(key);
    if (!styles) {
        styles = new Array(RMS_LEVEL_STEPS);
        styles[0] = IDLE_HEADER_STYLE;
        const denom = RMS_LEVEL_STEPS - 1;
        for (let step = 1; step < RMS_LEVEL_STEPS; step++) {
            const t = step / denom;
            const rmsCol = getQuantizedRmsColor(key, t, false);
            styles[step] = {
                bg: colorWithAlpha(rmsCol, Number((0.10 + t * 0.32).toFixed(3))),
                fg: '#0f172a',
                border: rmsCol
            };
        }
        setBounded(rmsHeaderCache, key, styles);
    }
    return styles[bucket];
}

/**
 * Draws a bottom-up RMS level curve and peak-hold crest line inside a clipped square node icon.
 */
export function drawIconRmsFill(
    ctx: CanvasRenderingContext2D,
    size: number,
    level: number,
    peakLevel: number,
    _baseColor: string,
    isClipping: boolean
): void {
    if (size <= 0) return;
    if (isClipping) {
        ctx.fillStyle = CLIP_FILL_COLOR;
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#fecaca';
        ctx.fillRect(0, 0, size, 2);
        return;
    }

    const clampedLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    const clampedPeak = Math.max(clampedLevel, Math.min(1, Number.isFinite(peakLevel) ? peakLevel : 0));

    if (clampedLevel > 0.005) {
        const fillH = Math.max(2, Math.min(size, clampedLevel * size));
        const fillTop = size - fillH;
        ctx.fillStyle = colorWithAlpha('#000000', Number((0.12 + clampedLevel * 0.22).toFixed(3)));
        ctx.fillRect(0, fillTop, size, fillH);

        ctx.fillStyle = '#111111';
        ctx.fillRect(0, Math.max(0, fillTop), size, 1.5);
    }

    if (clampedPeak > clampedLevel + 0.03 && clampedPeak > 0.02) {
        const peakY = Math.max(1, size - clampedPeak * size);
        ctx.fillStyle = clampedPeak >= 0.96 ? CLIP_MARKER_COLOR : 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(2, peakY, Math.max(1, size - 4), 1.25);
    }
}

/**
 * Draws a horizontal RMS curve wash, bottom level ribbon, and peak-hold pip inside an opened node header.
 */
export function drawHeaderRmsMeter(
    ctx: CanvasRenderingContext2D,
    width: number,
    headerHeight: number,
    level: number,
    peakLevel: number,
    baseColor: string,
    isClipping: boolean
): RmsHeaderStyle {
    const style = getQuantizedRmsHeaderStyle(baseColor, level, isClipping);
    if (width <= 0 || headerHeight <= 0) return style;

    if (isClipping) {
        ctx.fillStyle = CLIP_FILL_COLOR;
        ctx.fillRect(0, 0, width, headerHeight);
        return style;
    }

    const clampedLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    const clampedPeak = Math.max(clampedLevel, Math.min(1, Number.isFinite(peakLevel) ? peakLevel : 0));
    const accentCol = style.border || baseColor || '#0f172a';

    if (clampedLevel > 0.005) {
        const fillW = Math.max(2, Math.min(width, clampedLevel * width));
        ctx.fillStyle = style.bg || colorWithAlpha(accentCol, 0.16);
        ctx.fillRect(0, 0, fillW, headerHeight);

        ctx.fillStyle = accentCol;
        ctx.fillRect(0, Math.max(0, headerHeight - 2.5), fillW, 2.5);
    }

    if (clampedPeak > 0.02) {
        const peakX = Math.max(0, Math.min(width - 2, clampedPeak * width - 1));
        ctx.fillStyle = clampedPeak >= 0.96 ? CLIP_MARKER_COLOR : accentCol;
        ctx.fillRect(peakX, Math.max(0, headerHeight - 4), 2, 4);
    }

    return style;
}

/**
 * Draws a centered circular radial loop indicator starting at 12 o'clock and sweeping clockwise.
 */
export function drawRadialLoopProgress(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    progress: number,
    options?: RadialLoopOptions
): void {
    if (radius <= 0) return;
    ctx.save();
    if (options?.dimmed) {
        ctx.globalAlpha *= 0.45;
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = options?.trackFill ?? 'rgba(0, 0, 0, 0.08)';
    ctx.fill();
    ctx.strokeStyle = options?.trackStroke ?? 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = radius >= 10 ? 1.5 : 1;
    ctx.stroke();

    const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    if (p > 0.001) {
        const startAngle = -Math.PI * 0.5;
        const pieRadius = Math.max(1, radius - 0.75);
        ctx.beginPath();
        if (p >= 0.999) {
            ctx.arc(cx, cy, pieRadius, 0, Math.PI * 2);
        } else {
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, pieRadius, startAngle, startAngle + p * Math.PI * 2, false);
            ctx.closePath();
        }
        ctx.fillStyle = options?.fillColor ?? '#111111';
        ctx.fill();
    }

    const dividers = options?.dividerFractions;
    if (radius >= 10 && dividers && dividers.length > 0) {
        ctx.strokeStyle = options?.dividerColor ?? 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < dividers.length; i++) {
            const frac = dividers[i];
            if (frac > 0 && frac < 1) {
                const angle = -Math.PI * 0.5 + frac * Math.PI * 2;
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
            }
        }
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draws the current slot index centered inside a closed/distant SampleNode icon.
 */
export function drawClosedSlotIndex(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    slotIndex: number
): void {
    const label = String(Math.max(0, Math.trunc(slotIndex)));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 12.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#111111';
    ctx.font = label.length > 1 ? '700 13px Inter, monospace' : '700 16px Inter, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 0.5);
    ctx.restore();
}

/**
 * Draws a compact slot index pill in an opened node's header strip and returns its pixel width.
 */
export function drawHeaderSlotPill(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    height: number,
    slotIndex: number,
    _accentColor: string
): number {
    const label = String(Math.max(0, Math.trunc(slotIndex)));
    const pillW = label.length > 2 ? 25 : (label.length > 1 ? 20 : 15);
    ctx.save();
    drawRoundRect(ctx, x, y, pillW, height, 3);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    ctx.fillStyle = '#111111';
    ctx.font = '700 9.5px Inter, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + pillW * 0.5, y + height * 0.5 + 0.5);
    ctx.restore();
    return pillW;
}
