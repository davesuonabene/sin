import { drawRoundRect, drawPlayhead } from '../../../packages/iride/src/utils/drawingUtils.ts';
import { defaultTransportClock } from '../../../packages/iride/src/index.ts';

export type ArrangementAnchor = 'start' | 'end';
export type ArrangementVisualizerMode = 'select' | 'edit';

export interface ArrangementSourceVisual {
    bars: number;
    label: string;
    kind: 'loop' | 'sample' | 'sequence' | 'mixed';
}

export interface ArrangementVisualizerOptions {
    container: HTMLElement;
    totalBars: number;
    sectionPoints: number[];
    sectionProbability?: number[];
    sectionSampleStart?: number[];
    sectionQuant?: string[];
    sectionQuantAnchor?: ArrangementAnchor[];
    selectedSection: number;
    mode?: ArrangementVisualizerMode;
    source?: ArrangementSourceVisual | null;
    onSectionStructureChange: (
        points: number[],
        probability?: number[],
        sampleStart?: number[],
        quant?: string[],
        anchor?: ArrangementAnchor[]
    ) => void;
    onSectionSelect: (index: number) => void;
    onSplitAtBar?: (bar: number) => void;
    onMergeCut?: (cutIndex: number) => void;
}

/**
 * Clean, lightweight IRIDE-style arrangement visualizer with dual Selection / Edit modes.
 */
export class ArrangementVisualizer {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly resizeObserver: ResizeObserver;
    private options: ArrangementVisualizerOptions;
    private mode: ArrangementVisualizerMode = 'select';
    private hoverSection: number | null = null;
    private hoverCutIndex: number | null = null;
    private hoverMergeCutIndex: number | null = null;
    private hoverSnapBar: number | null = null;
    private draggingCutIndex: number | null = null;
    private didDragCut: boolean = false;
    private dragStartX: number = 0;
    private dragStartY: number = 0;
    private width = 0;
    private readonly height = 60;
    private readonly padding = 3;
    private animationFrameId: number | null = null;

    constructor(options: ArrangementVisualizerOptions) {
        this.options = {
            ...options,
            sectionPoints: [...options.sectionPoints],
            sectionProbability: [...(options.sectionProbability || [])],
            sectionSampleStart: [...(options.sectionSampleStart || [])],
            sectionQuant: [...(options.sectionQuant || [])],
            sectionQuantAnchor: [...(options.sectionQuantAnchor || [])]
        };
        this.mode = options.mode || 'select';
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'arrangement-visualizer-canvas';
        this.canvas.setAttribute('aria-label', 'Arrangement timeline. Click a section to select it, or use Edit mode to modify subdivisions.');
        this.canvas.tabIndex = 0;
        const context = this.canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        this.context = context;
        options.container.replaceChildren(this.canvas);

        this.canvas.addEventListener('pointerdown', this.handlePointerDown);
        this.canvas.addEventListener('pointermove', this.handlePointerMove);
        this.canvas.addEventListener('pointerup', this.handlePointerUp);
        this.canvas.addEventListener('pointercancel', this.handlePointerUp);
        this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
        this.canvas.addEventListener('click', this.handleClick);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(options.container);
        this.resize();

        // Animate playhead while playing
        this.tick = this.tick.bind(this);
        this.startPlayheadLoop();
    }

    destroy(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.resizeObserver.disconnect();
        this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvas.removeEventListener('pointermove', this.handlePointerMove);
        this.canvas.removeEventListener('pointerup', this.handlePointerUp);
        this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
        this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
        this.canvas.removeEventListener('click', this.handleClick);
        this.canvas.remove();
    }

    setMode(mode: ArrangementVisualizerMode): void {
        this.mode = mode;
        this.hoverCutIndex = null;
        this.hoverMergeCutIndex = null;
        this.hoverSnapBar = null;
        this.canvas.style.cursor = 'default';
        this.draw();
    }

    getMode(): ArrangementVisualizerMode {
        return this.mode;
    }

    setTotalBars(totalBars: number): void {
        this.options.totalBars = Math.max(0.25, Number(totalBars) || 4);
        this.draw();
    }

    setSectionPoints(points: number[]): void {
        this.options.sectionPoints = [...points];
        this.draw();
    }

    setSectionProbability(index: number, probability: number): void {
        if (!this.options.sectionProbability) this.options.sectionProbability = [];
        this.options.sectionProbability[index] = Math.max(0, Math.min(1, Number(probability) || 0));
        this.draw();
    }

    setSectionSampleStart(index: number, sampleStart: number): void {
        if (!this.options.sectionSampleStart) this.options.sectionSampleStart = [];
        this.options.sectionSampleStart[index] = Math.max(0, Math.min(1, Number(sampleStart) || 0));
        this.draw();
    }

    setSectionQuant(index: number, quant: string): void {
        if (!this.options.sectionQuant) this.options.sectionQuant = [];
        this.options.sectionQuant[index] = quant;
        this.draw();
    }

    setSectionQuantAnchor(index: number, anchor: ArrangementAnchor): void {
        if (!this.options.sectionQuantAnchor) this.options.sectionQuantAnchor = [];
        this.options.sectionQuantAnchor[index] = anchor;
        this.draw();
    }

    setSelectedSection(index: number): void {
        this.options.selectedSection = index;
        this.draw();
    }

    private startPlayheadLoop(): void {
        const loop = () => {
            const telemetry = defaultTransportClock.getTelemetry();
            if (telemetry?.isPlaying) {
                this.draw();
            }
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }

    private tick(): void {
        this.draw();
    }

    private resize(): void {
        const cssWidth = Math.max(200, this.options.container.clientWidth);
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        this.width = cssWidth;
        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${this.height}px`;
        this.canvas.width = Math.round(cssWidth * ratio);
        this.canvas.height = Math.round(this.height * ratio);
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.draw();
    }

    private getBoundaries(): number[] {
        return [0, ...this.options.sectionPoints, this.options.totalBars]
            .filter((p, i, a) => p >= 0 && p <= this.options.totalBars && a.indexOf(p) === i)
            .sort((a, b) => a - b);
    }

    private getCutAtX(x: number): number | null {
        const availWidth = Math.max(1, this.width - this.padding * 2);
        const totalBars = Math.max(0.25, this.options.totalBars);
        const barWidth = availWidth / totalBars;
        for (let i = 0; i < this.options.sectionPoints.length; i++) {
            const cutX = this.padding + this.options.sectionPoints[i] * barWidth;
            if (Math.abs(x - cutX) <= 8) return i;
        }
        return null;
    }

    private getSectionAtX(x: number): number {
        const boundaries = this.getBoundaries();
        const availWidth = Math.max(1, this.width - this.padding * 2);
        const totalBars = Math.max(0.25, this.options.totalBars);
        const bar = ((x - this.padding) / availWidth) * totalBars;

        for (let i = 0; i < boundaries.length - 1; i++) {
            if (bar < boundaries[i + 1] || i === boundaries.length - 2) return i;
        }
        return boundaries.length - 2;
    }

    private handlePointerDown = (event: PointerEvent): void => {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Check if clicking merge button in edit mode
        const cutIdx = this.getCutAtX(x);
        if (this.mode === 'edit' && cutIdx !== null && y <= this.padding + 22) {
            // Merge action handled in handleClick
            return;
        }

        // Allow dragging section border dividers in both selection and edit modes
        if (cutIdx !== null) {
            this.draggingCutIndex = cutIdx;
            this.dragStartX = x;
            this.dragStartY = y;
            this.didDragCut = false;
            try {
                this.canvas.setPointerCapture(event.pointerId);
            } catch {}
            event.preventDefault();
            this.draw();
        }
    };

    private handlePointerMove = (event: PointerEvent): void => {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        if (this.draggingCutIndex !== null) {
            if (Math.abs(x - this.dragStartX) > 2 || Math.abs(y - this.dragStartY) > 2) {
                this.didDragCut = true;
            }
            const availWidth = Math.max(1, this.width - this.padding * 2);
            const totalBars = Math.max(0.25, this.options.totalBars);
            let rawBar = ((x - this.padding) / availWidth) * totalBars;
            let newBar = Math.round(rawBar);

            const prevBoundary = this.draggingCutIndex > 0 ? this.options.sectionPoints[this.draggingCutIndex - 1] : 0;
            const nextBoundary = this.draggingCutIndex < this.options.sectionPoints.length - 1
                ? this.options.sectionPoints[this.draggingCutIndex + 1]
                : totalBars;
            const minGap = totalBars >= 2 ? 1 : 0.25;
            newBar = Math.max(prevBoundary + minGap, Math.min(nextBoundary - minGap, newBar));

            if (this.options.sectionPoints[this.draggingCutIndex] !== newBar) {
                this.options.sectionPoints[this.draggingCutIndex] = newBar;
                this.didDragCut = true;
                // Live visual redraw at 60fps without audio preview invalidation storm
                this.draw();
            }
            return;
        }

        const cutIdx = this.getCutAtX(x);
        if (cutIdx !== null) {
            if (this.mode === 'edit' && y <= this.padding + 22) {
                this.hoverMergeCutIndex = cutIdx;
                this.hoverCutIndex = null;
                this.hoverSnapBar = null;
                this.canvas.style.cursor = 'pointer';
            } else {
                this.hoverMergeCutIndex = null;
                this.hoverCutIndex = cutIdx;
                this.hoverSnapBar = null;
                this.canvas.style.cursor = 'col-resize';
            }
        } else {
            this.hoverCutIndex = null;
            this.hoverMergeCutIndex = null;
            this.hoverSection = this.getSectionAtX(x);

            if (this.mode === 'edit') {
                const availWidth = Math.max(1, this.width - this.padding * 2);
                const totalBars = Math.max(0.25, this.options.totalBars);
                const rawBar = ((x - this.padding) / availWidth) * totalBars;
                const nearestInt = Math.round(rawBar);
                const dist = Math.abs(rawBar - nearestInt);

                if (
                    nearestInt > 0
                    && nearestInt < totalBars
                    && dist < 0.4
                    && !this.options.sectionPoints.includes(nearestInt)
                ) {
                    this.hoverSnapBar = nearestInt;
                    this.canvas.style.cursor = 'copy';
                } else {
                    this.hoverSnapBar = null;
                    this.canvas.style.cursor = 'pointer';
                }
            } else {
                this.hoverSnapBar = null;
                this.canvas.style.cursor = 'pointer';
            }
        }
        this.draw();
    };

    private handlePointerUp = (event: PointerEvent): void => {
        if (this.draggingCutIndex !== null) {
            try {
                this.canvas.releasePointerCapture(event.pointerId);
            } catch {}
            const wasDragged = this.didDragCut;
            this.draggingCutIndex = null;

            // Commit single clean update to node model & audio scheduler on release if dragged
            if (wasDragged) {
                this.options.onSectionStructureChange?.(
                    this.options.sectionPoints,
                    this.options.sectionProbability,
                    this.options.sectionSampleStart,
                    this.options.sectionQuant,
                    this.options.sectionQuantAnchor
                );
            }
            this.draw();
        }
    };

    private handlePointerLeave = (): void => {
        if (this.draggingCutIndex === null) {
            this.hoverSection = null;
            this.hoverCutIndex = null;
            this.hoverMergeCutIndex = null;
            this.hoverSnapBar = null;
            this.canvas.style.cursor = 'default';
            this.draw();
        }
    };

    private handleClick = (event: MouseEvent): void => {
        if (this.didDragCut) {
            this.didDragCut = false;
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        if (this.mode === 'edit') {
            const cutIdx = this.getCutAtX(x);
            // Clicked merge button on divider
            if (cutIdx !== null && y <= this.padding + 22) {
                this.options.onMergeCut?.(cutIdx);
                return;
            }
            if (cutIdx !== null) return;

            // Clicked integer snap bar to split
            if (this.hoverSnapBar !== null) {
                const targetBar = this.hoverSnapBar;
                this.hoverSnapBar = null;
                this.options.onSplitAtBar?.(targetBar);
                return;
            }
        }

        // Selection mode or clicking inside a section in edit mode
        const clickedIndex = this.getSectionAtX(x);
        this.options.selectedSection = clickedIndex;
        this.options.onSectionSelect(clickedIndex);
        this.draw();
    };

    private draw(): void {
        const ctx = this.context;
        const width = this.width;
        const height = this.height;
        if (width <= 0 || height <= 0) return;

        ctx.clearRect(0, 0, width, height);

        // Frame
        drawRoundRect(ctx, 0, 0, width, height, 4);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.stroke();

        const boundaries = this.getBoundaries();
        const sectionCount = boundaries.length - 1;
        const totalBars = Math.max(0.25, this.options.totalBars);
        const availWidth = width - this.padding * 2;
        const barWidth = availWidth / totalBars;

        const telemetry = defaultTransportClock.getTelemetry();
        const currentBar = telemetry?.isPlaying ? (telemetry.bar % totalBars) : -1;

        // In edit mode: draw subtle whole-bar grid tick marks
        if (this.mode === 'edit') {
            ctx.strokeStyle = '#f1f5f9';
            ctx.lineWidth = 1;
            for (let b = 1; b < totalBars; b++) {
                const gx = this.padding + b * barWidth;
                ctx.beginPath();
                ctx.moveTo(gx, this.padding);
                ctx.lineTo(gx, height - this.padding);
                ctx.stroke();
            }
        }

        // Render Section Boxes (Label-Free: Section Numbers Only)
        for (let i = 0; i < sectionCount; i++) {
            const startBar = boundaries[i];
            const endBar = boundaries[i + 1];
            const lengthBars = endBar - startBar;
            const secX = this.padding + startBar * barWidth;
            const secW = Math.max(2, lengthBars * barWidth - 1);
            const secH = height - this.padding * 2;

            const prob = typeof this.options.sectionProbability?.[i] === 'number'
                ? Math.max(0, Math.min(1, this.options.sectionProbability[i]))
                : 1.0;

            const isSelected = this.options.selectedSection === i;
            const isHovered = this.hoverSection === i;
            const isPlayingInSec = currentBar >= startBar && currentBar < endBar;

            // Section background styling
            if (isSelected) {
                ctx.fillStyle = '#f59e0b';
            } else if (isPlayingInSec) {
                ctx.fillStyle = 'rgba(245, 158, 11, 0.75)';
            } else if (isHovered) {
                ctx.fillStyle = `rgba(245, 158, 11, ${0.28 + prob * 0.35})`;
            } else {
                ctx.fillStyle = `rgba(245, 158, 11, ${0.12 + prob * 0.35})`;
            }

            drawRoundRect(ctx, secX, this.padding, secW, secH, 3);
            ctx.fill();

            // Border
            ctx.strokeStyle = isSelected ? '#b45309' : isHovered ? '#d97706' : 'rgba(245, 158, 11, 0.45)';
            ctx.lineWidth = isSelected ? 1.5 : 0.75;
            ctx.stroke();

            // Label-free: Only Section Number S1, S2...
            if (secW > 12) {
                ctx.fillStyle = isSelected ? '#ffffff' : '#0f172a';
                ctx.font = 'bold 12px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const label = secW >= 28 ? `S${i + 1}` : `${i + 1}`;
                ctx.fillText(label, secX + secW / 2, this.padding + secH / 2);
            }
        }

        // In Edit Mode: Draw subtle hover split guide without text badge
        if (this.mode === 'edit' && this.hoverSnapBar !== null) {
            const snapX = this.padding + this.hoverSnapBar * barWidth;
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(snapX, this.padding);
            ctx.lineTo(snapX, height - this.padding);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw cut dividers and interactive drag handles
        for (let pIdx = 0; pIdx < this.options.sectionPoints.length; pIdx++) {
            const cutBar = this.options.sectionPoints[pIdx];
            const cutX = this.padding + cutBar * barWidth;
            const isCutHovered = this.hoverCutIndex === pIdx || this.draggingCutIndex === pIdx;
            const isMergeHovered = this.hoverMergeCutIndex === pIdx;

            // Divider vertical line
            ctx.strokeStyle = isCutHovered ? '#b45309' : '#d97706';
            ctx.lineWidth = isCutHovered ? 2.5 : 1.5;
            ctx.beginPath();
            ctx.moveTo(cutX, this.padding);
            ctx.lineTo(cutX, height - this.padding);
            ctx.stroke();

            // Handle notch at bottom
            ctx.fillStyle = isCutHovered ? '#b45309' : '#d97706';
            ctx.beginPath();
            ctx.arc(cutX, height - this.padding - 5, isCutHovered ? 3.5 : 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Handle notch or merge (×) button at top
            if (this.mode === 'edit') {
                const mergeBtnY = this.padding + 10;
                const mergeRadius = isMergeHovered ? 7.5 : 6;
                ctx.fillStyle = isMergeHovered ? '#ef4444' : 'rgba(245, 158, 11, 0.9)';
                ctx.beginPath();
                ctx.arc(cutX, mergeBtnY, mergeRadius, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.25;
                const crossSize = 3;
                ctx.beginPath();
                ctx.moveTo(cutX - crossSize, mergeBtnY - crossSize);
                ctx.lineTo(cutX + crossSize, mergeBtnY + crossSize);
                ctx.moveTo(cutX + crossSize, mergeBtnY - crossSize);
                ctx.lineTo(cutX - crossSize, mergeBtnY + crossSize);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(cutX, this.padding + 5, isCutHovered ? 3.5 : 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Live playhead across total bars
        if (telemetry?.isPlaying && currentBar >= 0) {
            const playheadX = this.padding + (currentBar / totalBars) * availWidth;
            drawPlayhead(ctx, playheadX, this.padding, height - this.padding, '#ffffff');
        }
    }
}

