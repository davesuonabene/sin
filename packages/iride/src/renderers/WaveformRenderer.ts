import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type WaveformSignal, type RendererOptions } from '../types.ts';
import { extractPeaksFromBuffer } from '../utils/peakExtractor.ts';
import {
    colorWithAlpha,
    drawPlayhead,
    drawRoundRect,
    drawSlotBadge,
    getOrCreateOffscreenCanvas
} from '../utils/drawingUtils.ts';

export class WaveformRenderer extends BaseSignalRenderer {
    private signal: WaveformSignal | null = null;
    private cachedPeaks: Float32Array | null = null;
    private cachedBuffer: AudioBuffer | null = null;
    private cachedWidth = 0;
    private maskCanvas: HTMLCanvasElement | null = null;
    private tintCanvas: HTMLCanvasElement | null = null;
    private maskFingerprint = '';

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#059669',
            ...options
        });
    }

    setSignal(signal: WaveformSignal | null): void {
        this.signal = signal;
        if (!signal?.buffer && !signal?.peaks) {
            this.cachedPeaks = null;
            this.cachedBuffer = null;
            this.maskFingerprint = '';
        } else if (signal.buffer && signal.buffer !== this.cachedBuffer) {
            this.cachedPeaks = null;
            this.cachedBuffer = signal.buffer;
            this.maskFingerprint = '';
        } else if (signal.peaks && signal.peaks !== this.cachedPeaks) {
            this.cachedPeaks = signal.peaks;
            this.maskFingerprint = '';
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

        ctx.fillStyle = this.options.backgroundColor || '#ffffff';
        ctx.fillRect(x, y, width, height);

        const midY = y + height * 0.5;
        const signal = this.signal;
        const accent = signal?.accentColor || this.options.accentColor || '#059669';
        const isPlaying = Boolean(telemetry?.isPlaying);

        // Center reference line
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
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

        const peaks = this.cachedPeaks;
        const hasTriggerState = signal?.isTriggered !== undefined;
        const isTriggerActive = hasTriggerState ? Boolean(signal?.isTriggered) : true;
        const isDimmed = isPlaying && hasTriggerState && !isTriggerActive;

        if (peaks && peaks.length >= 2) {
            const columns = Math.floor(peaks.length / 2);
            const colWidth = width / columns;
            const halfHeight = (height - 4) * 0.5;

            const cropStartNorm = signal?.cropStart != null ? Math.max(0, Math.min(1, signal.cropStart)) : 0;
            const cropEndNorm = signal?.cropEnd != null ? Math.max(0, Math.min(1, signal.cropEnd)) : 1;
            const cropStartX = x + cropStartNorm * width;
            const cropEndX = x + cropEndNorm * width;

            const bufferedProgress = signal?.bufferedProgress;
            const hasBufferConstraint = bufferedProgress != null && bufferedProgress < 0.999;
            const bufferFrontX = hasBufferConstraint ? x + Math.max(0, Math.min(1, bufferedProgress)) * width : null;
            const isInvalidated = Boolean(signal?.isInvalidated);

            let peakChecksum = 0;
            for (let i = 0; i < peaks.length; i++) {
                peakChecksum = ((peakChecksum * 31) + Math.round(peaks[i] * 1000)) | 0;
            }
            const peakHash = `${peaks.length}_${peakChecksum}`;
            const bufId = signal?.buffer ? `${signal.buffer.length}_${signal.buffer.duration.toFixed(3)}` : 'nobuf';
            const currentFp = `${bufId}_${peakHash}_${columns}_${Math.floor(width)}_${Math.floor(height)}_${cropStartNorm}_${cropEndNorm}`;
            const mask = getOrCreateOffscreenCanvas(this.maskCanvas, width, height);
            const tint = getOrCreateOffscreenCanvas(this.tintCanvas, width, height);

            if (mask && tint) {
                this.maskCanvas = mask;
                this.tintCanvas = tint;
                const mCtx = mask.getContext('2d');
                const tCtx = tint.getContext('2d');

                if (mCtx && tCtx) {
                    if (this.maskFingerprint !== currentFp) {
                        this.maskFingerprint = currentFp;
                        mCtx.clearRect(0, 0, width, height);
                        const maskMidY = height * 0.5;

                        for (let i = 0; i < columns; i++) {
                            const min = peaks[i * 2];
                            const max = peaks[i * 2 + 1];
                            const top = maskMidY - max * halfHeight;
                            const bottom = maskMidY - min * halfHeight;
                            const colX = i * colWidth;
                            const h = Math.max(1, bottom - top);

                            mCtx.fillStyle = (colX < cropStartNorm * width || colX > cropEndNorm * width)
                                ? 'rgba(255, 255, 255, 0.25)'
                                : '#ffffff';
                            mCtx.fillRect(colX, top, Math.max(1, colWidth - 0.5), h);
                        }
                    }

                    tCtx.clearRect(0, 0, width, height);
                    tCtx.drawImage(mask, 0, 0);
                    tCtx.globalCompositeOperation = 'source-in';
                    if (isInvalidated) {
                        tCtx.fillStyle = 'rgba(245, 158, 11, 0.6)';
                    } else if (isDimmed) {
                        tCtx.fillStyle = colorWithAlpha(accent, 0.25);
                    } else {
                        tCtx.fillStyle = accent;
                    }
                    tCtx.fillRect(0, 0, width, height);
                    tCtx.globalCompositeOperation = 'source-over';

                    ctx.drawImage(tint, x, y);
                }
            } else {
                for (let i = 0; i < columns; i++) {
                    const min = peaks[i * 2];
                    const max = peaks[i * 2 + 1];
                    const top = midY - max * halfHeight;
                    const bottom = midY - min * halfHeight;
                    const colX = x + i * colWidth;
                    const h = Math.max(1, bottom - top);

                    if (colX < cropStartX || colX > cropEndX) {
                        ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
                    } else if (isInvalidated) {
                        ctx.fillStyle = 'rgba(245, 158, 11, 0.6)';
                    } else if (isDimmed) {
                        ctx.fillStyle = colorWithAlpha(accent, 0.25);
                    } else {
                        ctx.fillStyle = accent;
                    }
                    ctx.fillRect(colX, top, Math.max(1, colWidth - 0.5), h);
                }
            }

            if (bufferFrontX != null) {
                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(bufferFrontX, y + 2);
                ctx.lineTo(bufferFrontX, y + height - 2);
                ctx.stroke();
            }

            // Sample crop boundaries (only when crop is active on SampleNode)
            if (!isPlaying) {
                if (cropStartNorm > 0.001) {
                    ctx.strokeStyle = '#f59e0b';
                    ctx.lineWidth = 1.25;
                    ctx.beginPath();
                    ctx.moveTo(cropStartX, y);
                    ctx.lineTo(cropStartX, y + height);
                    ctx.stroke();
                }
                if (cropEndNorm < 0.999) {
                    ctx.strokeStyle = '#f59e0b';
                    ctx.lineWidth = 1.25;
                    ctx.beginPath();
                    ctx.moveTo(cropEndX, y);
                    ctx.lineTo(cropEndX, y + height);
                    ctx.stroke();
                }
            }
        } else {
            ctx.strokeStyle = isDimmed ? colorWithAlpha(accent, 0.15) : colorWithAlpha(accent, 0.35);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x + 4, midY);
            ctx.lineTo(x + width - 4, midY);
            ctx.stroke();

            if (!isPlaying && !this.options.minified) {
                ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
                ctx.font = '9px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Ready for preview', x + width / 2, midY - 8);
            }
        }

        // Playhead Needle
        if (isPlaying) {
            if (signal?.playbackProgress != null) {
                if (!hasTriggerState || isTriggerActive) {
                    const playheadX = x + Math.max(0, Math.min(1, signal.playbackProgress)) * width;
                    drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
                }
            } else if (hasTriggerState) {
                if (isTriggerActive && signal?.triggerProgress != null) {
                    const playheadX = x + Math.max(0, Math.min(1, signal.triggerProgress)) * width;
                    drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
                }
            } else if (telemetry && telemetry.duration > 0) {
                const progress = Math.max(0, Math.min(1, ((telemetry.time % telemetry.duration) + telemetry.duration) % telemetry.duration / telemetry.duration));
                const playheadX = x + progress * width;
                drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
            }
        }

        if (!this.options.minified) {
            drawSlotBadge(ctx, x, y, signal?.activeSlot, signal?.slotCount);
        }

        ctx.restore();
    }
}
