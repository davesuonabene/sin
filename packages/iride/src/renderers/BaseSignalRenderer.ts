import { type RenderBox, type SignalTelemetry, type RendererOptions } from '../types.ts';

export abstract class BaseSignalRenderer {
    protected dirty = true;
    protected options: RendererOptions;

    constructor(options: RendererOptions = {}) {
        this.options = {
            theme: 'light',
            accentColor: '#059669',
            backgroundColor: '#ffffff',
            borderColor: '#e2e8f0',
            ...options
        };
    }

    setOptions(options: Partial<RendererOptions>): void {
        this.options = { ...this.options, ...options };
        this.markDirty();
    }

    markDirty(): void {
        this.dirty = true;
    }

    abstract render(
        ctx: CanvasRenderingContext2D,
        bounds: RenderBox,
        telemetry?: SignalTelemetry
    ): void;
}
