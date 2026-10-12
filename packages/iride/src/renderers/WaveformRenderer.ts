import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type WaveformSignal, type RendererOptions } from '../types.ts';
import { extractPeaksFromBuffer } from '../utils/peakExtractor.ts';
import { drawPlayhead, drawRoundRect } from '../utils/drawingUtils.ts';

export class WaveformRenderer extends BaseSignalRenderer {
    private signal: WaveformSignal | null = null;
    private cachedPeaks: Float32Array | null = null;
    private cachedBuffer: AudioBuffer | null = null;
    private cachedWidth = 0;
    private sweepHistoryMin = new Float32Array(256);
    private sweepHistoryMax = new Float32Array(256);
    private sweepIndex = 0;
    private lastPhase = 0;

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
            this.sweepHistoryMin.fill(0);
            this.sweepHistoryMax.fill(0);
            this.sweepIndex = 0;
            this.lastPhase = 0;
        } else if (signal.buffer && signal.buffer !== this.cachedBuffer) {
            this.cachedPeaks = null;
            this.cachedBuffer = signal.buffer;
            this.sweepHistoryMin.fill(0);
            this.sweepHistoryMax.fill(0);
            this.sweepIndex = 0;
            this.lastPhase = 0;
        } else if (signal.peaks) {
            this.cachedPeaks = signal.peaks;
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

        // Clip to viewport
        drawRoundRect(ctx, x, y, width, height, 4);
        ctx.clip();

        // Background: clean light background matching theme
        ctx.fillStyle = this.options.backgroundColor || '#ffffff';
        ctx.fillRect(x, y, width, height);

        const midY = y + height * 0.5;
        const signal = this.signal;
        const accent = signal?.accentColor || this.options.accentColor || '#059669';
        const isPlaying = Boolean(telemetry?.isPlaying);
        const scopeMode = this.options.scopeMode || (this.options.isMasterScope ? 'drawn' : 'full');

        // MODE 1: Real-Time Drawn Oscilloscope Sweep (Left-to-Right from RAM preview)
        if (scopeMode === 'drawn' && isPlaying) {
            this.renderDrawnScope(ctx, x, y, width, height, midY, accent, telemetry);
            ctx.restore();
            return;
        }

        // MODE 2: Real-Time Scrolled Oscilloscope (Scrolling window from RAM preview)
        if (scopeMode === 'scrolled' && isPlaying) {
            this.renderScrolledScope(ctx, x, y, width, height, midY, accent, telemetry);
            ctx.restore();
            return;
        }

        // MODE 3: Full Static Stem / Sample Waveform with Scrubber
        // Center line
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        ctx.stroke();

        // Check if we have peaks or need to extract them from buffer
        if (signal?.buffer && (!this.cachedPeaks || this.cachedWidth !== Math.floor(width) || this.cachedBuffer !== signal.buffer)) {
            this.cachedWidth = Math.floor(width);
            this.cachedBuffer = signal.buffer;
            const buf = signal.buffer;
            const totalDur = (signal.duration && signal.duration > 0) ? signal.duration : buf.duration;
            const bufferRatio = Math.min(1.0, Math.max(0.01, buf.duration / Math.max(0.01, totalDur)));
            if (bufferRatio < 0.99) {
                // Buffer is progressively filling: extract peaks proportionally up to buffer front
                const bufferedCols = Math.max(1, Math.min(this.cachedWidth, Math.floor(this.cachedWidth * bufferRatio)));
                const partialPeaks = extractPeaksFromBuffer(buf, bufferedCols);
                const fullPeaks = new Float32Array(this.cachedWidth * 2);
                fullPeaks.set(partialPeaks.subarray(0, Math.min(fullPeaks.length, partialPeaks.length)));
                this.cachedPeaks = fullPeaks;
            } else {
                this.cachedPeaks = extractPeaksFromBuffer(buf, this.cachedWidth);
            }
        } else if (signal?.peaks && !this.cachedPeaks) {
            this.cachedPeaks = signal.peaks;
        }

        const peaks = this.cachedPeaks;

        // Trigger-reactive logic for samples:
        // If playback is running and the node specifies isTriggered:
        // When not triggered, dim the waveform. When triggered, light up bright and sweep triggerProgress.
        const hasTriggerState = signal?.isTriggered !== undefined;
        const isTriggerActive = hasTriggerState ? Boolean(signal?.isTriggered) : true;
        const isDimmed = isPlaying && hasTriggerState && !isTriggerActive;

        if (peaks && peaks.length >= 2) {
            const columns = Math.floor(peaks.length / 2);
            const colWidth = width / columns;
            const halfHeight = (height - 4) * 0.5;

            // Crop boundaries (if any)
            const cropStartNorm = signal?.cropStart != null ? Math.max(0, Math.min(1, signal.cropStart)) : 0;
            const cropEndNorm = signal?.cropEnd != null ? Math.max(0, Math.min(1, signal.cropEnd)) : 1;
            const cropStartX = x + cropStartNorm * width;
            const cropEndX = x + cropEndNorm * width;

            const bufferedProgress = signal?.bufferedProgress;
            const hasBufferConstraint = bufferedProgress != null && bufferedProgress < 0.999;
            const bufferFrontX = hasBufferConstraint ? x + Math.max(0, Math.min(1, bufferedProgress)) * width : null;
            const isInvalidated = Boolean(signal?.isInvalidated);

            // Waveform columns
            for (let i = 0; i < columns; i++) {
                const min = peaks[i * 2];
                const max = peaks[i * 2 + 1];
                const top = midY - max * halfHeight;
                const bottom = midY - min * halfHeight;
                const colX = x + i * colWidth;
                const h = Math.max(1, bottom - top);
                const isPastBufferFront = bufferFrontX != null && colX > bufferFrontX;

                if (colX < cropStartX || colX > cropEndX) {
                    ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
                } else if (isPastBufferFront) {
                    // Unbuffered region in RAM
                    ctx.fillStyle = 'rgba(203, 213, 225, 0.35)';
                } else if (isInvalidated) {
                    // Refilling / refreshing state
                    ctx.fillStyle = 'rgba(245, 158, 11, 0.6)';
                } else if (isDimmed) {
                    ctx.fillStyle = 'rgba(5, 150, 105, 0.25)';
                } else {
                    ctx.fillStyle = accent;
                }
                ctx.fillRect(colX, top, Math.max(1, colWidth - 0.5), h);
            }

            // Draw buffer-fill leading front edge
            if (bufferFrontX != null) {
                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(bufferFrontX, y + 2);
                ctx.lineTo(bufferFrontX, y + height - 2);
                ctx.stroke();
            }

            // Draw crop lines (only when not playing or when editing)
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
            // Idle placeholder line
            ctx.strokeStyle = isDimmed ? 'rgba(5, 150, 105, 0.15)' : 'rgba(5, 150, 105, 0.35)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x + 4, midY);
            ctx.lineTo(x + width - 4, midY);
            ctx.stroke();

            if (!isPlaying) {
                ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
                ctx.font = '9px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Ready for preview', x + width / 2, midY - 8);
            }
        }

        // Live Playhead Scrubber
        if (isPlaying) {
            if (signal?.playbackProgress != null) {
                // Explicit node-level playback progress (e.g. sample length loop follow)
                const playheadX = x + Math.max(0, Math.min(1, signal.playbackProgress)) * width;
                drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
            } else if (hasTriggerState) {
                // In trigger-reactive mode: only sweep when triggered
                if (isTriggerActive && signal?.triggerProgress != null) {
                    const playheadX = x + Math.max(0, Math.min(1, signal.triggerProgress)) * width;
                    drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
                }
            } else if (telemetry && telemetry.duration > 0) {
                // Continuous playhead across full stem
                const progress = Math.max(0, Math.min(1, telemetry.time / telemetry.duration));
                const playheadX = x + progress * width;
                drawPlayhead(ctx, playheadX, y, y + height, '#0284c7');
            }
        }

        ctx.restore();
    }

    private getPeakFromBuffer(
        buffer: AudioBuffer,
        startTime: number,
        endTime: number,
        gain: number = 1.0
    ): { min: number; max: number } {
        const sr = buffer.sampleRate;
        const totalSamples = buffer.length;
        const startSample = Math.max(0, Math.floor(startTime * sr));
        const endSample = Math.min(totalSamples, Math.max(startSample + 1, Math.ceil(endTime * sr)));

        if (startSample >= totalSamples || endSample <= startSample) {
            return { min: 0, max: 0 };
        }

        const channelData = buffer.getChannelData(0);
        const span = endSample - startSample;
        const step = Math.max(1, Math.floor(span / 16));

        let min = 0;
        let max = 0;
        for (let i = startSample; i < endSample; i += step) {
            const v = channelData[i] * gain;
            if (v < min) min = v;
            if (v > max) max = v;
        }

        return {
            min: Math.max(-1.0, Math.min(1.0, min)),
            max: Math.max(-1.0, Math.min(1.0, max))
        };
    }

    private renderDrawnScope(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number,
        midY: number,
        accent: string,
        telemetry?: SignalTelemetry
    ): void {
        // Grid / Center line
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        ctx.stroke();

        const configuredWindow = Number(this.options.scopeWindow);
        const windowDuration = configuredWindow > 0
            ? configuredWindow
            : (this.signal?.duration && this.signal.duration > 0
                ? this.signal.duration
                : (telemetry?.duration && telemetry.duration > 0 ? telemetry.duration : 1.0));

        const time = Math.max(0, telemetry?.time || 0);
        const cycleIndex = Math.floor(time / windowDuration);
        const windowStartTime = cycleIndex * windowDuration;
        const phase = Math.max(0, Math.min(1, (time - windowStartTime) / windowDuration));

        // When phase wraps around (left-to-right reset), clear upcoming sweep
        if (phase < this.lastPhase) {
            this.sweepHistoryMin.fill(0);
            this.sweepHistoryMax.fill(0);
            this.sweepIndex = 0;
        }
        this.lastPhase = phase;

        const scopeGain = Number(this.options.scopeGain) || 1.0;
        const buffer = this.signal?.buffer;
        const numColumns = 256;
        const targetIdx = Math.min(numColumns - 1, Math.floor(phase * (numColumns - 1)));

        // Extract waveform data for elapsed portion of the window
        if (buffer) {
            const bufDur = buffer.duration > 0 ? buffer.duration : windowDuration;
            const cropS = this.signal?.cropStart ?? 0;
            const cropE = this.signal?.cropEnd ?? 1;
            const span = Math.max(0.01, cropE - cropS);
            const isSampleSignal = (cropS > 0 || cropE < 1 || this.signal?.playbackProgress != null);

            for (let i = this.sweepIndex; i <= targetIdx; i++) {
                const normPos = i / numColumns;
                let bufferTime: number;
                let stepTime: number;

                if (isSampleSignal) {
                    bufferTime = (cropS * bufDur) + (normPos * span * bufDur);
                    stepTime = (span * bufDur) / numColumns;
                } else {
                    const cycleStart = (cycleIndex * windowDuration) % bufDur;
                    bufferTime = (cycleStart + normPos * windowDuration) % bufDur;
                    stepTime = windowDuration / numColumns;
                }

                const { min, max } = this.getPeakFromBuffer(buffer, bufferTime, bufferTime + stepTime, scopeGain);
                this.sweepHistoryMin[i] = min;
                this.sweepHistoryMax[i] = max;
            }
        } else if (telemetry?.realtimeScope && telemetry.realtimeScope.length >= 2) {
            // Fallback to live master analyser when buffer is not yet generated
            const scopeData = telemetry.realtimeScope;
            let maxAbs = 0;
            let signedVal = 0;
            for (let i = 0; i < scopeData.length; i++) {
                const s = scopeData[i];
                if (Math.abs(s) > maxAbs) {
                    maxAbs = Math.abs(s);
                    signedVal = s;
                }
            }
            const amp = Math.max(-1.0, Math.min(1.0, signedVal * scopeGain));
            for (let i = this.sweepIndex; i <= targetIdx; i++) {
                this.sweepHistoryMin[i] = Math.min(0, amp);
                this.sweepHistoryMax[i] = Math.max(0, amp);
            }
        }
        this.sweepIndex = targetIdx;

        const ampScale = height * 0.44;
        const colWidth = width / numColumns;

        // Trace waveform from LEFT to current phase position
        for (let i = 0; i <= targetIdx; i++) {
            const px = x + (i / numColumns) * width;
            const top = midY - this.sweepHistoryMax[i] * ampScale;
            const bottom = midY - this.sweepHistoryMin[i] * ampScale;
            const h = Math.max(1.25, bottom - top);
            ctx.fillStyle = accent;
            ctx.fillRect(px, top, Math.max(1, colWidth), h);
        }

        // Glowing sweep head dot at current leading edge
        if (targetIdx > 0) {
            const headX = x + phase * width;
            const headY = midY - (this.sweepHistoryMax[targetIdx] || 0) * ampScale;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(headX, headY, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Scope Mode Badge
        ctx.fillStyle = '#059669';
        ctx.beginPath();
        ctx.arc(x + width - 10, y + 10, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#059669';
        ctx.font = 'bold 8px Inter, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const winLabel = configuredWindow > 0 ? `${windowDuration.toFixed(2)}s` : `AUTO (${windowDuration.toFixed(2)}s)`;
        ctx.fillText(`SCOPE · ${winLabel}`, x + width - 16, y + 10);
    }

    private renderScrolledScope(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number,
        midY: number,
        accent: string,
        telemetry?: SignalTelemetry
    ): void {
        // Center line
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, midY);
        ctx.lineTo(x + width, midY);
        ctx.stroke();

        const configuredWindow = Number(this.options.scopeWindow);
        const windowDuration = configuredWindow > 0
            ? configuredWindow
            : (this.signal?.duration && this.signal.duration > 0
                ? this.signal.duration
                : (telemetry?.duration && telemetry.duration > 0 ? telemetry.duration : 1.0));

        const time = Math.max(0, telemetry?.time || 0);
        const startTime = time - windowDuration * 0.5;
        const scopeGain = Number(this.options.scopeGain) || 1.0;
        const buffer = this.signal?.buffer;
        const ampScale = height * 0.44;
        const totalCols = Math.floor(width);

        if (buffer) {
            const bufDur = buffer.duration > 0 ? buffer.duration : windowDuration;
            const cropS = this.signal?.cropStart ?? 0;
            const cropE = this.signal?.cropEnd ?? 1;
            const span = Math.max(0.01, cropE - cropS);
            const isSampleSignal = (cropS > 0 || cropE < 1 || this.signal?.playbackProgress != null);

            for (let c = 0; c < totalCols; c++) {
                const colNorm = c / totalCols;
                let t1: number;
                let t2: number;

                if (isSampleSignal) {
                    const activeDur = bufDur * span;
                    const cycleT = ((time % activeDur) + activeDur) % activeDur;
                    const offsetInWin = (colNorm - 0.5) * windowDuration;
                    const sampleT = (((cycleT + offsetInWin) % activeDur) + activeDur) % activeDur;
                    t1 = (cropS * bufDur) + sampleT;
                    t2 = t1 + (windowDuration / totalCols);
                } else {
                    t1 = ((startTime + colNorm * windowDuration) % bufDur + bufDur) % bufDur;
                    t2 = t1 + (windowDuration / totalCols);
                }

                const { min, max } = this.getPeakFromBuffer(buffer, t1, t2, scopeGain);
                const top = midY - max * ampScale;
                const bottom = midY - min * ampScale;
                const h = Math.max(1.25, bottom - top);
                ctx.fillStyle = accent;
                ctx.fillRect(x + c, top, 1.25, h);
            }
        }

        // Center Scrubber Needle (NOW)
        const needleX = x + width * 0.5;
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(needleX, y);
        ctx.lineTo(needleX, y + height);
        ctx.stroke();

        ctx.fillStyle = '#0284c7';
        ctx.beginPath();
        ctx.arc(needleX, midY, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Scope Mode Badge
        ctx.fillStyle = '#0284c7';
        ctx.beginPath();
        ctx.arc(x + width - 10, y + 10, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0284c7';
        ctx.font = 'bold 8px Inter, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const winLabel = configuredWindow > 0 ? `${windowDuration.toFixed(2)}s` : `AUTO (${windowDuration.toFixed(2)}s)`;
        ctx.fillText(`SCROLL · ${winLabel}`, x + width - 16, y + 10);
    }
}

