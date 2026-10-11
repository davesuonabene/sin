import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type SequenceSignal, type RendererOptions } from '../types.ts';
import { drawRoundRect } from '../utils/drawingUtils.ts';

export class SequenceRenderer extends BaseSignalRenderer {
    private signal: SequenceSignal | null = null;

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#f43f5e',
            ...options
        });
    }

    setSignal(signal: SequenceSignal | null): void {
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

        // 1. Clip to viewport
        drawRoundRect(ctx, x, y, width, height, 4);
        ctx.clip();

        // 2. Background: clean light background matching theme
        ctx.fillStyle = this.options.backgroundColor || '#ffffff';
        ctx.fillRect(x, y, width, height);

        const signal = this.signal;
        const stepCount = signal?.stepCount || 16;
        const steps = signal?.steps || [];
        const accent = signal?.accentColor || this.options.accentColor || '#f43f5e';

        // 3. Spacing & Beat Grouping (4 beats of 4 steps)
        const paddingLeft = 4;
        const paddingRight = 4;
        const paddingTop = 3;
        const paddingBottom = 11; // Space for beat labels 1, 2, 3, 4
        const innerGap = 2;       // Gap between steps inside a beat
        const beatGap = 6;        // Gap between 4-step groups

        const numBeats = Math.max(1, Math.ceil(stepCount / 4));
        const totalBeatGaps = Math.max(0, numBeats - 1) * beatGap;
        const totalInnerGaps = (stepCount - numBeats) * innerGap;
        const availWidth = width - (paddingLeft + paddingRight) - totalBeatGaps - totalInnerGaps;
        const stepWidth = Math.max(3, Math.floor(availWidth / stepCount));
        const stepHeight = Math.max(6, height - (paddingTop + paddingBottom));

        const stepLength = signal?.stepLength || 0.25;
        const currentStep = telemetry?.isPlaying
            ? (((Math.floor(telemetry.beat / stepLength) % stepCount) + stepCount) % stepCount)
            : -1;

        // 4. Render Step Pads
        let currentX = x + paddingLeft;

        for (let i = 0; i < stepCount; i++) {
            const beatIndex = Math.floor(i / 4);
            const stepInBeat = i % 4;

            // Extra gap on beat boundary (except first)
            if (i > 0 && stepInBeat === 0) {
                currentX += beatGap;
            } else if (i > 0) {
                currentX += innerGap;
            }

            const stepX = currentX;
            const stepY = y + paddingTop;

            const stepData = steps[i];
            const isGateOn = Boolean(stepData?.gate);
            const velocity = typeof stepData?.velocity === 'number' ? Math.max(0.1, Math.min(1, stepData.velocity)) : 0.85;
            const subdivisions = stepData?.subdivisions || 1;

            const isCurrent = i === currentStep;
            const isDownbeat = stepInBeat === 0;

            // Pad Background
            if (isGateOn) {
                if (isCurrent) {
                    ctx.fillStyle = '#ffffff'; // White flash on trigger hit
                } else {
                    ctx.fillStyle = accent;    // Bright vivid neon active step
                }
            } else {
                if (isCurrent) {
                    ctx.fillStyle = '#38bdf8'; // Bright vivid cyan light runner
                } else {
                    ctx.fillStyle = isDownbeat ? '#cbd5e1' : '#e2e8f0'; // Subtle light slate pad
                }
            }

            drawRoundRect(ctx, stepX, stepY, stepWidth, stepHeight, 2.5);
            ctx.fill();

            // Velocity indicator bar (inside active steps)
            if (isGateOn && !isCurrent && velocity < 0.95) {
                const velEmptyH = stepHeight * (1 - velocity);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
                ctx.fillRect(stepX, stepY, stepWidth, velEmptyH);
            }

            // Pad Border
            if (isCurrent) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.75;
            } else if (isGateOn) {
                ctx.strokeStyle = '#fbcfe8';
                ctx.lineWidth = 1;
            } else {
                ctx.strokeStyle = isDownbeat ? '#94a3b8' : '#cbd5e1';
                ctx.lineWidth = 0.75;
            }

            drawRoundRect(ctx, stepX, stepY, stepWidth, stepHeight, 2.5);
            ctx.stroke();

            // Downbeat top accent notch
            if (isDownbeat && !isCurrent) {
                ctx.fillStyle = isGateOn ? '#ffffff' : '#64748b';
                ctx.fillRect(stepX + 1, stepY + 1, stepWidth - 2, 1.5);
            }

            // Subdivision dots
            if (subdivisions > 1 && isGateOn) {
                ctx.fillStyle = isCurrent ? '#000000' : '#ffffff';
                const dotY = stepY + stepHeight - 2.5;
                const dotCount = Math.min(4, subdivisions);
                for (let d = 0; d < dotCount; d++) {
                    const dotX = stepX + (stepWidth / (dotCount + 1)) * (d + 1);
                    ctx.beginPath();
                    ctx.arc(dotX, dotY, 0.9, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Beat Label (centered under each 4-step beat)
            if (stepInBeat === 1 && height >= 34) {
                const beatCenterX = stepX + (stepWidth * 2 + innerGap) / 2;
                ctx.fillStyle = (telemetry?.isPlaying && Math.floor(currentStep / 4) === beatIndex)
                    ? '#0284c7'
                    : '#64748b';
                ctx.font = 'bold 8px Inter, monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(String(beatIndex + 1), beatCenterX, stepY + stepHeight + 2);
            }

            currentX += stepWidth;
        }

        ctx.restore();
    }
}
