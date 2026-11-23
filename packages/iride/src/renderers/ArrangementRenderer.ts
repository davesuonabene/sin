import { BaseSignalRenderer } from './BaseSignalRenderer.ts';
import { type RenderBox, type SignalTelemetry, type ArrangementSignal, type RendererOptions } from '../types.ts';
import { drawPlayhead, drawRoundRect } from '../utils/drawingUtils.ts';

function colorWithAlpha(color: string, alpha: number): string {
    if (!color) return `rgba(245, 158, 11, ${alpha})`;
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
        return color.replace(/[\d\.]+\)$/, `${alpha})`);
    }
    return color;
}

function getOrCreateOffscreenCanvas(existing: HTMLCanvasElement | null, width: number, height: number): HTMLCanvasElement | null {
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

export class ArrangementRenderer extends BaseSignalRenderer {
    private signal: ArrangementSignal | null = null;
    private maskCanvas: HTMLCanvasElement | null = null;
    private tintCanvas: HTMLCanvasElement | null = null;
    private maskFingerprint: string = '';
    private tintFingerprint: string = '';
    private cachedSectionsRef: ArrangementSignal['sections'] | null = null;
    private cachedSectionsKey: string = '';

    constructor(options: RendererOptions = {}) {
        super({
            accentColor: '#111111',
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

        // Background: only paint if explicitly opaque
        if (this.options.backgroundColor && this.options.backgroundColor !== 'transparent') {
            ctx.fillStyle = this.options.backgroundColor;
            ctx.fillRect(x, y, width, height);
        }

        const signal = this.signal;
        const totalBars = Math.max(1, signal?.totalBars || 4);
        const sections = signal?.sections || [];
        const dataColor = '#111111';

        const padding = 2;
        const availWidth = width - padding * 2;
        const barWidth = availWidth / totalBars;
        const currentBar = telemetry?.isPlaying ? (telemetry.bar % totalBars) : -1;

        // If no explicit sections, draw a single unified block
        if (sections.length === 0) {
            ctx.fillStyle = colorWithAlpha(dataColor, 0.14);
            drawRoundRect(ctx, x + padding, y + padding, availWidth, height - padding * 2, 2);
            ctx.fill();
        } else {
            if (this.cachedSectionsRef !== sections) {
                this.cachedSectionsRef = sections;
                let sKey = '';
                for (let i = 0; i < sections.length; i++) {
                    const sec = sections[i];
                    sKey += `${sec.startBar},${sec.lengthBars},${sec.probability ?? 1},${sec.slotIndex ?? 0};`;
                }
                this.cachedSectionsKey = sKey;
            }
            const currentFp = `${totalBars}_${Math.floor(availWidth)}_${Math.floor(height)}_${this.cachedSectionsKey}`;
            const mask = getOrCreateOffscreenCanvas(this.maskCanvas, availWidth, height - padding * 2);
            const tint = getOrCreateOffscreenCanvas(this.tintCanvas, availWidth, height - padding * 2);

            if (mask && tint) {
                this.maskCanvas = mask;
                this.tintCanvas = tint;
                const mCtx = mask.getContext('2d');
                const tCtx = tint.getContext('2d');

                if (mCtx && tCtx) {
                    if (this.maskFingerprint !== currentFp) {
                        this.maskFingerprint = currentFp;
                        this.tintFingerprint = '';
                        mCtx.clearRect(0, 0, availWidth, height - padding * 2);

                        for (let i = 0; i < sections.length; i++) {
                            const sec = sections[i];
                            const secX = sec.startBar * barWidth;
                            const secW = Math.max(2, sec.lengthBars * barWidth - 1);
                            const secH = height - padding * 2;
                            const prob = typeof sec.probability === 'number' ? Math.max(0.1, sec.probability) : 1.0;

                            mCtx.fillStyle = `rgba(255, 255, 255, ${0.08 + prob * 0.24})`;
                            drawRoundRect(mCtx, secX, 0, secW, secH, 2);
                            mCtx.fill();

                            mCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
                            mCtx.lineWidth = 0.75;
                            mCtx.stroke();
                        }
                    }

                    // Tint the cached mask with monochrome data ink only when mask changes
                    const nextTintFp = `${currentFp}_${dataColor}`;
                    if (this.tintFingerprint !== nextTintFp) {
                        this.tintFingerprint = nextTintFp;
                        tCtx.clearRect(0, 0, availWidth, height - padding * 2);
                        tCtx.drawImage(mask, 0, 0);
                        tCtx.globalCompositeOperation = 'source-in';
                        tCtx.fillStyle = dataColor;
                        tCtx.fillRect(0, 0, availWidth, height - padding * 2);
                        tCtx.globalCompositeOperation = 'source-over';
                    }

                    ctx.drawImage(tint, x + padding, y + padding);
                }
            } else {
                for (let i = 0; i < sections.length; i++) {
                    const sec = sections[i];
                    const secX = x + padding + sec.startBar * barWidth;
                    const secW = Math.max(2, sec.lengthBars * barWidth - 1);
                    const secH = height - padding * 2;
                    const prob = typeof sec.probability === 'number' ? Math.max(0.1, sec.probability) : 1.0;

                    ctx.fillStyle = colorWithAlpha(dataColor, 0.08 + prob * 0.24);
                    drawRoundRect(ctx, secX, y + padding, secW, secH, 2);
                    ctx.fill();

                    ctx.strokeStyle = colorWithAlpha(dataColor, 0.35);
                    ctx.lineWidth = 0.75;
                    ctx.stroke();
                }
            }

            // Draw active section highlight & labels
            for (let i = 0; i < sections.length; i++) {
                const sec = sections[i];
                const secX = x + padding + sec.startBar * barWidth;
                const secW = Math.max(2, sec.lengthBars * barWidth - 1);
                const secH = height - padding * 2;
                const isActiveSection = currentBar >= sec.startBar && currentBar < (sec.startBar + sec.lengthBars);

                if (isActiveSection) {
                    ctx.fillStyle = dataColor;
                    drawRoundRect(ctx, secX, y + padding, secW, secH, 2);
                    ctx.fill();

                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }

                // Section index label (omitted in chromeless minified middle stage)
                if (!this.options.minified) {
                    ctx.fillStyle = isActiveSection ? '#ffffff' : '#111111';
                    ctx.font = 'bold 9px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const baseLabel = sec.label || String(i + 1);
                    const hasCustomSlot = sec.slotIndex != null && sec.slotIndex > 0;
                    const label = (hasCustomSlot && secW > 26)
                        ? `${baseLabel}[${sec.slotIndex}]`
                        : (hasCustomSlot ? `[${sec.slotIndex}]` : baseLabel);
                    if (secW > 12) {
                        ctx.fillText(label, secX + secW / 2, y + height / 2);
                    }
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
