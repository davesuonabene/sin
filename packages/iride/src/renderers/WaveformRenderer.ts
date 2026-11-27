import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type WaveformSignal, type RendererOptions } from '../types.ts';
import { extractPeaksFromBuffer } from '../utils/peakExtractor.ts';
import {
    drawPlayhead,
    drawRoundRect,
    drawSlotBadge,
    getOrCreateOffscreenCanvas
} from '../utils/drawingUtils.ts';

export class WaveformRenderer extends BaseSignalRenderer {
    private signal: WaveformSignal | null = null;
    private cachedPeaks: Float32Array | null = null;
    private cachedPeakHashRef: Float32Array | null = null;
    private cachedPeakHash = '';
    private cachedBuffer: AudioBuffer | null = null;
    private cachedWidth = 0;
    private maskCanvas: HTMLCanvasElement | null = null;
    private tintCanvas: HTMLCanvasElement | null = null;
    private maskFingerprint = '';
    private tintFingerprint = '';

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#111111',
            ...options
        });
    }

    setSignal(signal: WaveformSignal | null): void {
        this.signal = signal;
        if (!signal?.buffer && !signal?.peaks) {
            this.cachedPeaks = null;
            this.cachedPeakHashRef = null;
            this.cachedPeakHash = '';
            this.cachedBuffer = null;
            this.maskFingerprint = '';
            this.tintFingerprint = '';
        } else if (signal.buffer && signal.buffer !== this.cachedBuffer) {
            this.cachedPeaks = null;
            this.cachedPeakHashRef = null;
            this.cachedPeakHash = '';
            this.cachedBuffer = signal.buffer;
            this.maskFingerprint = '';
            this.tintFingerprint = '';
        } else if (signal.peaks && signal.peaks !== this.cachedPeaks) {
            this.cachedPeaks = signal.peaks;
            this.cachedBuffer = null;
            this.cachedPeakHashRef = null;
            this.cachedPeakHash = '';
            this.maskFingerprint = '';
            this.tintFingerprint = '';
        }
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

        if (this.options.backgroundColor && this.options.backgroundColor !== 'transparent') {
            ctx.fillStyle = this.options.backgroundColor;
            ctx.fillRect(x, y, width, height);
        }

        const midY = y + height * 0.5;
        const signal = this.signal;
        const dataColor = '#111111';
        const isPlaying = Boolean(telemetry?.isPlaying);

        // Center reference line
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        ctx.stroke();

        // Extract peaks from AudioBuffer when buffer or viewport width changes
        if (signal?.buffer && (!this.cachedPeaks || this.cachedWidth !== Math.floor(width) || this.cachedBuffer !== signal.buffer)) {
            this.cachedWidth = Math.floor(width);
            this.cachedBuffer = signal.buffer;
            this.maskFingerprint = '';
            const buf = signal.buffer;
            const totalDur = (signal.duration && signal.duration > 0) ? signal.duration : buf.duration;
            const bufferRatio = Math.min(1.0, Math.max(0.01, buf.duration / Math.max(0.01, totalDur)));
            if (bufferRatio < 0.99) {
                const bufferedCols = Math.max(1, Math.min(this.cachedWidth, Math.floor(this.cachedWidth * bufferRatio)));
                const partialPeaks = extractPeaksFromBuffer(buf, bufferedCols);
                const fullPeaks = new Float32Array(this.cachedWidth * 2);
                fullPeaks.set(partialPeaks.subarray(0, Math.min(fullPeaks.length, partialPeaks.length)));
                this.cachedPeaks = fullPeaks;
            } else {
                this.cachedPeaks = extractPeaksFromBuffer(buf, this.cachedWidth);
            }
        } else if (signal?.peaks && this.cachedPeaks !== signal.peaks) {
            this.cachedPeaks = signal.peaks;
            this.maskFingerprint = '';
        }

        const rawPeaks = this.cachedPeaks;
        const hasTriggerState = signal?.isTriggered !== undefined;
        const isTriggerActive = hasTriggerState ? Boolean(signal?.isTriggered) : true;
        const isDimmed = isPlaying && hasTriggerState && !isTriggerActive;
        const peaks = rawPeaks;

        if (peaks && peaks.length >= 2) {
            const rawCols = Math.floor(peaks.length / 2);
            const wInt = Math.max(1, Math.floor(width));
            const hInt = Math.max(1, Math.floor(height));
            // Downsample dense peak arrays cleanly to <= 1 bar per pixel so long tracks stay crisp and legible
            const renderCols = Math.max(1, Math.min(rawCols, wInt));
            const colWidth = width / renderCols;
            const halfHeight = (height - 4) * 0.5;

            const cropStartNorm = signal?.cropStart != null ? Math.max(0, Math.min(1, signal.cropStart)) : 0;
            const cropEndNorm = signal?.cropEnd != null ? Math.max(0, Math.min(1, signal.cropEnd)) : 1;
            const cropStartX = x + cropStartNorm * width;
            const cropEndX = x + cropEndNorm * width;

            const bufferedProgress = signal?.bufferedProgress;
            const hasBufferConstraint = bufferedProgress != null && bufferedProgress < 0.999;
            const bufferFrontX = hasBufferConstraint ? x + Math.max(0, Math.min(1, bufferedProgress)) * width : null;
            const isInvalidated = Boolean(signal?.isInvalidated);

            if (this.cachedPeakHashRef !== peaks) {
                let peakChecksum = 0;
                const step = Math.max(1, Math.floor(peaks.length / 256));
                for (let i = 0; i < peaks.length; i += step) {
                    peakChecksum = ((peakChecksum * 31) + Math.round(peaks[i] * 1000)) | 0;
                }
                this.cachedPeakHashRef = peaks;
                this.cachedPeakHash = `${peaks.length}_${peakChecksum}`;
            }
            const bufId = signal?.buffer ? `${signal.buffer.length}_${signal.buffer.duration.toFixed(3)}` : 'nobuf';
            const currentFp = `${bufId}_${this.cachedPeakHash}_${renderCols}_${wInt}_${hInt}_${cropStartNorm}_${cropEndNorm}`;
            const mask = getOrCreateOffscreenCanvas(this.maskCanvas, width, height);
            const tint = getOrCreateOffscreenCanvas(this.tintCanvas, width, height);

            const drawDownsampledBars = (
                targetCtx: CanvasRenderingContext2D,
                offsetX: number,
                baseMidY: number,
                resolveColor: (colX: number) => string
            ) => {
                const barW = Math.max(1, colWidth > 1.5 ? colWidth - 0.5 : colWidth);
                for (let i = 0; i < renderCols; i++) {
                    const sIdx = Math.floor((i / renderCols) * rawCols);
                    const eIdx = Math.max(sIdx + 1, Math.floor(((i + 1) / renderCols) * rawCols));
                    let min = 1;
                    let max = -1;
                    for (let k = sIdx; k < eIdx && k < rawCols; k++) {
                        const lo = peaks[k * 2];
                        const hi = peaks[k * 2 + 1];
                        if (lo < min) min = lo;
                        if (hi > max) max = hi;
                    }
                    if (min > max) { min = 0; max = 0; }
                    const top = baseMidY - max * halfHeight;
                    const bottom = baseMidY - min * halfHeight;
                    const colX = offsetX + i * colWidth;
                    const h = Math.max(1, bottom - top);
                    targetCtx.fillStyle = resolveColor(colX);
                    targetCtx.fillRect(colX, top, barW, h);
                }
            };

            if (mask && tint) {
                this.maskCanvas = mask;
                this.tintCanvas = tint;
                const mCtx = mask.getContext('2d');
                const tCtx = tint.getContext('2d');

                if (mCtx && tCtx) {
                    const maskChanged = this.maskFingerprint !== currentFp;
                    if (maskChanged) {
                        this.maskFingerprint = currentFp;
                        this.tintFingerprint = '';
                        mCtx.clearRect(0, 0, width, height);
                        const maskMidY = height * 0.5;
                        drawDownsampledBars(mCtx, 0, maskMidY, (colX) =>
                            (colX < cropStartNorm * width || colX > cropEndNorm * width)
                                ? 'rgba(255, 255, 255, 0.18)'
                                : '#ffffff'
                        );
                    }

                    const tintFill = isInvalidated
                        ? 'rgba(17, 17, 17, 0.45)'
                        : (isDimmed ? 'rgba(17, 17, 17, 0.24)' : dataColor);
                    const nextTintFp = `${currentFp}_${tintFill}`;
                    if (this.tintFingerprint !== nextTintFp) {
                        this.tintFingerprint = nextTintFp;
                        tCtx.clearRect(0, 0, width, height);
                        tCtx.drawImage(mask, 0, 0);
                        tCtx.globalCompositeOperation = 'source-in';
                        tCtx.fillStyle = tintFill;
                        tCtx.fillRect(0, 0, width, height);
                        tCtx.globalCompositeOperation = 'source-over';
                    }

                    ctx.drawImage(tint, x, y);
                }
            } else {
                drawDownsampledBars(ctx, x, midY, (colX) => {
                    if (colX < cropStartX || colX > cropEndX) return 'rgba(17, 17, 17, 0.18)';
                    if (isInvalidated) return 'rgba(17, 17, 17, 0.45)';
                    if (isDimmed) return 'rgba(17, 17, 17, 0.24)';
                    return dataColor;
                });
            }

            if (bufferFrontX != null) {
                ctx.strokeStyle = '#525252';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(bufferFrontX, y + 2);
                ctx.lineTo(bufferFrontX, y + height - 2);
                ctx.stroke();
            }

            // Sample crop boundaries (persistent during both idle and playback)
            if (cropStartNorm > 0.001) {
                ctx.strokeStyle = 'rgba(17, 17, 17, 0.72)';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(cropStartX, y);
                ctx.lineTo(cropStartX, y + height);
                ctx.stroke();
            }
            if (cropEndNorm < 0.999) {
                ctx.strokeStyle = 'rgba(17, 17, 17, 0.72)';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(cropEndX, y);
                ctx.lineTo(cropEndX, y + height);
                ctx.stroke();
            }
        } else if (!signal?.isLoading) {
            ctx.strokeStyle = isDimmed ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.22)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x + 4, midY);
            ctx.lineTo(x + width - 4, midY);
            ctx.stroke();

            if (!isPlaying && !this.options.minified) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
                ctx.font = '9px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Ready for preview', x + width / 2, midY - 8);
            }
        }

        // Loading / Cooking Indicator (makes unloaded or still-cooking playback state unmistakable)
        if (signal?.isLoading) {
            const hasPeaksBehind = Boolean(peaks && peaks.length >= 2);
            const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const angle = (nowMs * 0.006) % (Math.PI * 2);
            const label = signal.loadingLabel || (hasPeaksBehind ? 'Processing…' : 'Loading…');

            if (!hasPeaksBehind) {
                // Centered spinner + label on unloaded visualizer
                const r = Math.min(7, Math.max(4, height * 0.16));
                const showText = !this.options.minified && width >= 92;
                const cx = showText ? x + width * 0.5 - 32 : x + width * 0.5;
                const cy = midY;
                ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();

                ctx.strokeStyle = '#0284c7';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.35);
                ctx.stroke();
                ctx.lineCap = 'butt';

                if (showText) {
                    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
                    ctx.font = '600 9.5px Inter, system-ui, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(label, cx + r + 6, cy + 0.5);
                }
            } else {
                // Subtle frosted wash + compact spinner pill when cooking over raw/partial peaks
                ctx.fillStyle = 'rgba(248, 250, 252, 0.34)';
                ctx.fillRect(x, y, width, height);

                const r = 4.2;
                if (!this.options.minified && width >= 96) {
                    ctx.font = '600 8.5px Inter, system-ui, sans-serif';
                    const textW = ctx.measureText(label).width;
                    const pillW = Math.min(width - 8, textW + 24);
                    const pillH = 16;
                    const px = x + width - pillW - 4;
                    const py = y + 4;

                    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
                    drawRoundRect(ctx, px, py, pillW, pillH, 4);
                    ctx.fill();

                    const cx = px + 9;
                    const cy = py + pillH * 0.5;
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
                    ctx.lineWidth = 1.6;
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    ctx.stroke();

                    ctx.strokeStyle = '#38bdf8';
                    ctx.lineWidth = 1.6;
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.35);
                    ctx.stroke();
                    ctx.lineCap = 'butt';

                    ctx.fillStyle = '#f8fafc';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(label, px + 17, cy + 0.5);
                } else {
                    const cx = x + width - 10;
                    const cy = y + 10;
                    ctx.strokeStyle = '#0284c7';
                    ctx.lineWidth = 1.8;
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.35);
                    ctx.stroke();
                }
            }
        }

        // Playhead Needle
        if (isPlaying) {
            if (signal?.playbackProgress != null) {
                if (!hasTriggerState || isTriggerActive) {
                    const playheadX = x + Math.max(0, Math.min(1, signal.playbackProgress)) * width;
                    drawPlayhead(ctx, playheadX, y, y + height, '#000000');
                }
            } else if (hasTriggerState) {
                if (isTriggerActive && signal?.triggerProgress != null) {
                    const playheadX = x + Math.max(0, Math.min(1, signal.triggerProgress)) * width;
                    drawPlayhead(ctx, playheadX, y, y + height, '#000000');
                }
            } else if (telemetry && telemetry.duration > 0) {
                const progress = Math.max(0, Math.min(1, ((telemetry.time % telemetry.duration) + telemetry.duration) % telemetry.duration / telemetry.duration));
                const playheadX = x + progress * width;
                drawPlayhead(ctx, playheadX, y, y + height, '#000000');
            }
        }

        if (!this.options.minified) {
            drawSlotBadge(ctx, x, y, signal?.activeSlot, signal?.slotCount);
        }

        ctx.restore();
    }
}
