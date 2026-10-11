import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type ArrangementSignal, type RendererOptions } from '../types.ts';
import { drawPlayhead, drawRoundRect } from '../utils/drawingUtils.ts';

export class ArrangementRenderer extends BaseSignalRenderer {
    private signal: ArrangementSignal | null = null;

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#f59e0b',
            ...options
        });
    }

    setSignal(signal: ArrangementSignal | null): void {
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

        // Clip to viewport
        drawRoundRect(ctx, x, y, width, height, 4);
        ctx.clip();

        // Background: clean light background matching theme
        ctx.fillStyle = this.options.backgroundColor || '#ffffff';
        ctx.fillRect(x, y, width, height);

        const signal = this.signal;
        const totalBars = Math.max(1, signal?.totalBars || 4);
        const sections = signal?.sections || [];
        const accent = signal?.accentColor || this.options.accentColor || '#f59e0b';

        const padding = 2;
        const availWidth = width - padding * 2;
        const barWidth = availWidth / totalBars;
        const currentBar = telemetry?.isPlaying ? (telemetry.bar % totalBars) : -1;

        // If no explicit sections, draw a single unified block
        if (sections.length === 0) {
            ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
            drawRoundRect(ctx, x + padding, y + padding, availWidth, height - padding * 2, 2);
            ctx.fill();
        } else {
            for (let i = 0; i < sections.length; i++) {
                const sec = sections[i];
                const secX = x + padding + sec.startBar * barWidth;
                const secW = Math.max(2, sec.lengthBars * barWidth - 1);
                const secH = height - padding * 2;
                const prob = typeof sec.probability === 'number' ? Math.max(0.1, sec.probability) : 1.0;

                const isActiveSection = currentBar >= sec.startBar && currentBar < (sec.startBar + sec.lengthBars);

                // Section background with probability alpha
                ctx.fillStyle = isActiveSection
                    ? accent
                    : `rgba(245, 158, 11, ${0.15 + prob * 0.35})`;

                drawRoundRect(ctx, secX, y + padding, secW, secH, 2);
                ctx.fill();

                // Section border
                ctx.strokeStyle = isActiveSection ? '#ffffff' : 'rgba(245, 158, 11, 0.5)';
                ctx.lineWidth = isActiveSection ? 1.5 : 0.75;
                ctx.stroke();

                // Sample start tick
                if (sec.sampleStart > 0) {
                    const startX = secX + sec.sampleStart * secW;
                    ctx.strokeStyle = '#0284c7';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(startX, y + padding);
                    ctx.lineTo(startX, y + height - padding);
                    ctx.stroke();
                }

                // Section index label
                ctx.fillStyle = isActiveSection ? '#ffffff' : '#1e293b';
                ctx.font = 'bold 9px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const label = sec.label || String(i + 1);
                if (secW > 12) {
                    ctx.fillText(label, secX + secW / 2, y + height / 2);
                }
            }
        }

        // Live playhead line across total bars
        if (telemetry && telemetry.isPlaying && currentBar >= 0) {
            const playheadX = x + padding + (currentBar / totalBars) * availWidth;
            drawPlayhead(ctx, playheadX, y, y + height, '#ffffff');
        }

        ctx.restore();
    }
}
