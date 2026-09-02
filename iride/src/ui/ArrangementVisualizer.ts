export type ArrangementAnchor = 'start' | 'end';

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
    source: ArrangementSourceVisual | null;
    onSectionStructureChange: (
        points: number[],
        probability?: number[],
        sampleStart?: number[],
        quant?: string[],
        anchor?: ArrangementAnchor[]
    ) => void;
    onSectionSelect: (index: number) => void;
}

/**
 * Minimal section editor. It intentionally shows source blocks only once the
 * direct input reports a dependable rendered length; until then the timeline
 * is a concise map of each section's own settings.
 */
export class ArrangementVisualizer {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly resizeObserver: ResizeObserver;
    private options: ArrangementVisualizerOptions;
    private hoverBars: number | null = null;
    private hoverSection: number | null = null;
    private hoverMode: 'ruler' | 'section' | null = null;
    private width = 0;
    private readonly height = 146;
    private readonly inset = 8;
    private readonly rulerY = 25;
    private readonly barY = 51;
    private readonly barHeight = 66;
    private readonly rulerHitRadius = 12;

    constructor(options: ArrangementVisualizerOptions) {
        this.options = {
            ...options,
            sectionPoints: [...options.sectionPoints],
            sectionProbability: [...(options.sectionProbability || [])],
            sectionSampleStart: [...(options.sectionSampleStart || [])],
            sectionQuant: [...(options.sectionQuant || [])],
            sectionQuantAnchor: [...(options.sectionQuantAnchor || [])]
        };
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'arrangement-visualizer-canvas';
        this.canvas.setAttribute('aria-label', 'Arrangement timeline. Click the ruler to add or remove section markers. Click a section to edit it.');
        this.canvas.tabIndex = 0;
        const context = this.canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        this.context = context;
        options.container.replaceChildren(this.canvas);

        this.canvas.addEventListener('pointermove', this.handlePointerMove);
        this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
        this.canvas.addEventListener('click', this.handleClick);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(options.container);
        this.resize();
    }

    destroy() {
        this.resizeObserver.disconnect();
        this.canvas.removeEventListener('pointermove', this.handlePointerMove);
        this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
        this.canvas.removeEventListener('click', this.handleClick);
        this.canvas.remove();
    }

    setSectionProbability(index: number, probability: number) {
        if (index < 0 || index >= this.getBoundaries().length - 1) return;
        if (!this.options.sectionProbability) this.options.sectionProbability = [];
        this.options.sectionProbability[index] = Math.max(0, Math.min(1, Number(probability) || 0));
        this.draw();
    }

    setSectionSampleStart(index: number, sampleStart: number) {
        if (index < 0 || index >= this.getBoundaries().length - 1) return;
        if (!this.options.sectionSampleStart) this.options.sectionSampleStart = [];
        this.options.sectionSampleStart[index] = Math.max(0, Math.min(1, Number(sampleStart) || 0));
        this.draw();
    }

    setSectionQuant(index: number, quant: string) {
        if (index < 0 || index >= this.getBoundaries().length - 1) return;
        if (!this.options.sectionQuant) this.options.sectionQuant = [];
        this.options.sectionQuant[index] = quant;
        this.draw();
    }

    setSectionQuantAnchor(index: number, anchor: ArrangementAnchor) {
        if (index < 0 || index >= this.getBoundaries().length - 1) return;
        if (!this.options.sectionQuantAnchor) this.options.sectionQuantAnchor = [];
        this.options.sectionQuantAnchor[index] = anchor;
        this.draw();
    }

    private resize() {
        const cssWidth = Math.max(260, this.options.container.clientWidth);
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        this.width = cssWidth;
        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${this.height}px`;
        this.canvas.width = Math.round(cssWidth * ratio);
        this.canvas.height = Math.round(this.height * ratio);
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.draw();
    }

    private get plotWidth() {
        return Math.max(1, this.width - this.inset * 2);
    }

    private barsToX(bars: number) {
        return this.inset + (bars / this.options.totalBars) * this.plotWidth;
    }

    private eventToBars(event: PointerEvent | MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.max(this.inset, Math.min(this.width - this.inset, event.clientX - rect.left));
        return ((x - this.inset) / this.plotWidth) * this.options.totalBars;
    }

    private formatBars(value: number) {
        if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
        return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }

    private getSectionProbability(index: number): number {
        const probability = this.options.sectionProbability?.[index];
        return probability != null && Number.isFinite(probability)
            ? Math.max(0, Math.min(1, probability))
            : 1;
    }

    private getSectionSampleStart(index: number): number {
        const sampleStart = this.options.sectionSampleStart?.[index];
        return sampleStart != null && Number.isFinite(sampleStart)
            ? Math.max(0, Math.min(1, sampleStart))
            : 0;
    }

    private getSectionQuant(index: number): string {
        return String(this.options.sectionQuant?.[index] || 'none').toLowerCase();
    }

    private getSectionAnchor(index: number): ArrangementAnchor {
        return this.options.sectionQuantAnchor?.[index] === 'end' ? 'end' : 'start';
    }

    private getSectionAt(bars: number) {
        const boundaries = this.getBoundaries();
        for (let index = 0; index < boundaries.length - 1; index++) {
            if (bars < boundaries[index + 1] || index === boundaries.length - 2) return index;
        }
        return boundaries.length - 2;
    }

    private getBoundaries() {
        return [0, ...this.options.sectionPoints, this.options.totalBars]
            .filter((point, index, values) => point >= 0 && point <= this.options.totalBars && values.indexOf(point) === index)
            .sort((a, b) => a - b);
    }

    private isRulerHit(localY: number) {
        return Math.abs(localY - this.rulerY) <= this.rulerHitRadius;
    }

    private handlePointerMove = (event: PointerEvent) => {
        const rect = this.canvas.getBoundingClientRect();
        const localY = event.clientY - rect.top;
        const bars = this.eventToBars(event);
        if (this.isRulerHit(localY)) {
            this.hoverMode = 'ruler';
            this.hoverBars = Math.round(bars);
            this.hoverSection = null;
            this.canvas.style.cursor = 'crosshair';
        } else if (localY >= this.barY && localY <= this.barY + this.barHeight) {
            this.hoverMode = 'section';
            this.hoverBars = null;
            this.hoverSection = this.getSectionAt(bars);
            this.canvas.style.cursor = 'pointer';
        } else {
            this.hoverMode = null;
            this.hoverBars = null;
            this.hoverSection = null;
            this.canvas.style.cursor = 'default';
        }
        this.draw();
    };

    private handlePointerLeave = () => {
        this.hoverMode = null;
        this.hoverBars = null;
        this.hoverSection = null;
        this.canvas.style.cursor = 'default';
        this.draw();
    };

    private handleClick = (event: MouseEvent) => {
        const rect = this.canvas.getBoundingClientRect();
        const localY = event.clientY - rect.top;
        const rawBars = this.eventToBars(event);

        if (localY >= this.barY && localY <= this.barY + this.barHeight) {
            this.options.selectedSection = this.getSectionAt(rawBars);
            this.options.onSectionSelect(this.options.selectedSection);
            this.draw();
            return;
        }
        if (!this.isRulerHit(localY)) return;

        const snapped = Math.round(rawBars);
        if (snapped <= 0 || snapped >= this.options.totalBars) return;
        const existingIndex = this.options.sectionPoints.findIndex(point => Math.abs(point - snapped) < 0.001);
        const nextProbability = [...(this.options.sectionProbability || [])];
        const nextSampleStart = [...(this.options.sectionSampleStart || [])];
        const nextQuant = [...(this.options.sectionQuant || [])];
        const nextAnchor = [...(this.options.sectionQuantAnchor || [])];
        let points: number[];

        if (existingIndex !== -1) {
            points = this.options.sectionPoints.filter((_, index) => index !== existingIndex);
            nextProbability.splice(existingIndex + 1, 1);
            nextSampleStart.splice(existingIndex + 1, 1);
            nextQuant.splice(existingIndex + 1, 1);
            nextAnchor.splice(existingIndex + 1, 1);
            if (this.options.selectedSection > existingIndex) this.options.selectedSection--;
        } else {
            const splitSection = this.getSectionAt(snapped);
            points = [...this.options.sectionPoints, snapped].sort((a, b) => a - b);
            nextProbability.splice(splitSection + 1, 0, nextProbability[splitSection] ?? 1);
            nextSampleStart.splice(splitSection + 1, 0, nextSampleStart[splitSection] ?? 0);
            nextQuant.splice(splitSection + 1, 0, nextQuant[splitSection] ?? 'none');
            nextAnchor.splice(splitSection + 1, 0, nextAnchor[splitSection] ?? 'start');
        }

        this.options.sectionPoints = points;
        this.options.sectionProbability = nextProbability;
        this.options.sectionSampleStart = nextSampleStart;
        this.options.sectionQuant = nextQuant;
        this.options.sectionQuantAnchor = nextAnchor;
        this.options.selectedSection = Math.min(this.options.selectedSection, points.length);
        this.options.onSectionStructureChange(points, nextProbability, nextSampleStart, nextQuant, nextAnchor);
        this.options.onSectionSelect(this.options.selectedSection);
        this.draw();
    };

    private chooseTickInterval() {
        const idealTicks = Math.max(2, Math.floor(this.plotWidth / 54));
        const raw = this.options.totalBars / idealTicks;
        return [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].find(candidate => candidate >= raw) || 128;
    }

    private drawRuler() {
        const ctx = this.context;
        const endX = this.width - this.inset;
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.inset, this.rulerY);
        ctx.lineTo(endX, this.rulerY);
        ctx.stroke();

        const tickInterval = this.chooseTickInterval();
        ctx.font = '600 9px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let bar = 0; bar <= this.options.totalBars + 0.0001; bar += tickInterval) {
            const x = this.barsToX(Math.min(bar, this.options.totalBars));
            ctx.beginPath();
            ctx.moveTo(x, this.rulerY - 3);
            ctx.lineTo(x, this.rulerY + 3);
            ctx.stroke();
            if (bar < this.options.totalBars) ctx.fillText(this.formatBars(bar), x, this.rulerY + 6);
        }
        ctx.textAlign = 'right';
        ctx.fillText(`${this.formatBars(this.options.totalBars)} bars`, endX, 3);
    }

    private quantLabel(quant: string) {
        switch (quant) {
            case 'auto': return 'source length';
            case 'bar': return '1 bar';
            case '0.5': return '½ bar';
            case 'beat': return 'beat';
            case 'none':
            case 'off':
            case '': return 'continuous';
            default: return `${quant} bars`;
        }
    }

    private sectionLabel(index: number) {
        const probability = Math.round(this.getSectionProbability(index) * 100);
        const offset = Math.round(this.getSectionSampleStart(index) * 100);
        const anchor = this.getSectionAnchor(index) === 'end' ? 'end' : 'start';
        return `S${index + 1}  ${this.quantLabel(this.getSectionQuant(index))} · ${anchor} · ${probability}% · +${offset}%`;
    }

    private drawTextWithin(text: string, x: number, y: number, width: number, color: string) {
        if (width < 24) return;
        const ctx = this.context;
        ctx.font = '600 9px Inter, system-ui, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let visible = text;
        while (visible.length > 1 && ctx.measureText(`${visible}…`).width > width) visible = visible.slice(0, -1);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y - 7, width, 14);
        ctx.clip();
        ctx.fillText(visible === text ? text : `${visible}…`, x, y);
        ctx.restore();
    }

    private drawTimeline() {
        const ctx = this.context;
        const boundaries = this.getBoundaries();
        const hasSource = this.options.source !== null;

        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.inset, this.barY);
        ctx.lineTo(this.width - this.inset, this.barY);
        ctx.stroke();

        for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index];
            const end = boundaries[index + 1];
            const startX = this.barsToX(start);
            const width = this.barsToX(end) - startX;
            const selected = index === this.options.selectedSection;
            const hovered = index === this.hoverSection && this.hoverMode === 'section';

            if (selected || hovered) {
                ctx.fillStyle = selected ? 'rgba(245, 158, 11, .07)' : 'rgba(14, 165, 233, .05)';
                ctx.fillRect(startX, this.barY, width, this.barHeight);
            }

            this.drawTextWithin(
                this.sectionLabel(index),
                startX + 6,
                this.barY + 12,
                Math.max(0, width - 12),
                '#64748b'
            );

            ctx.strokeStyle = selected ? '#f59e0b' : '#cbd5e1';
            ctx.lineWidth = selected ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(startX + (selected ? 1 : 0), this.barY);
            ctx.lineTo(startX + (selected ? 1 : 0), this.barY + this.barHeight);
            ctx.stroke();
            if (index === boundaries.length - 2) {
                ctx.beginPath();
                ctx.moveTo(this.barsToX(end), this.barY);
                ctx.lineTo(this.barsToX(end), this.barY + this.barHeight);
                ctx.stroke();
            }
        }

        if (hasSource) this.drawPlacements(boundaries);
        else {
            ctx.font = '500 9px Inter, system-ui, sans-serif';
            ctx.fillStyle = '#94a3b8';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText('Waiting for a known input duration', this.inset, this.height - 5);
        }

        for (const point of this.options.sectionPoints) {
            const x = this.barsToX(point);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, this.rulerY - 5);
            ctx.lineTo(x, this.barY + this.barHeight);
            ctx.stroke();
        }
    }

    private quantInterval(quant: string, sourceBars: number): number | null {
        if (quant === 'none' || quant === 'off' || !quant) return null;
        if (quant === 'auto') return sourceBars;
        if (quant === 'bar') return 1;
        if (quant === 'beat') return 0.25;
        const value = Number.parseFloat(quant);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    private drawPlacements(boundaries: number[]) {
        const source = this.options.source;
        if (!source || !Number.isFinite(source.bars) || source.bars <= 0) return;
        let placementIndex = 0;

        for (let sectionIndex = 0; sectionIndex < boundaries.length - 1; sectionIndex++) {
            const sectionStart = boundaries[sectionIndex];
            const sectionEnd = boundaries[sectionIndex + 1];
            const probability = this.getSectionProbability(sectionIndex);
            if (probability <= 0) continue;
            const interval = this.quantInterval(this.getSectionQuant(sectionIndex), source.bars);
            const playableBars = source.bars * (1 - this.getSectionSampleStart(sectionIndex));
            const anchor = this.getSectionAnchor(sectionIndex);
            let cellStart = sectionStart;

            do {
                const cellEnd = interval === null ? sectionEnd : Math.min(sectionEnd, cellStart + interval);
                const eventStart = anchor === 'start' ? cellStart : cellEnd - playableBars;
                const eventEnd = eventStart + playableBars;
                // This is the same gate used by ArrangementObject.render: an
                // event cannot spill outside its section or quant cell.
                const visibleStart = Math.max(sectionStart, cellStart, eventStart);
                const visibleEnd = Math.min(sectionEnd, cellEnd, eventEnd);
                if (visibleEnd > visibleStart) {
                    this.drawSourceBlock(visibleStart, visibleEnd, source, placementIndex++, anchor, probability);
                }
                if (interval === null || interval <= 0) break;
                cellStart += interval;
            } while (cellStart < sectionEnd - 0.0001 && placementIndex < 256);
        }
    }

    private drawSourceBlock(
        startBars: number,
        endBars: number,
        source: ArrangementSourceVisual,
        index: number,
        anchor: ArrangementAnchor,
        probability: number
    ) {
        const ctx = this.context;
        const x = this.barsToX(startBars);
        const width = Math.max(1, this.barsToX(endBars) - x);
        const y = this.barY + 25;
        const height = 25;
        ctx.save();
        ctx.globalAlpha = Math.max(0.28, probability);
        ctx.fillStyle = source.kind === 'sample' ? '#475569' : '#0f766e';
        ctx.fillRect(x + 1, y, Math.max(1, width - 2), height);
        ctx.strokeStyle = 'rgba(15, 23, 42, .35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1, y + .5, Math.max(1, width - 2), height - 1);
        const anchorX = anchor === 'end' ? x + width - 4 : x + 4;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.beginPath();
        ctx.moveTo(anchorX, y + 6);
        ctx.lineTo(anchorX, y + height - 6);
        ctx.stroke();
        if (index === 0) this.drawTextWithin(source.label, x + 7, y + height / 2, Math.max(0, width - 14), '#ffffff');
        ctx.restore();
    }

    private drawHover() {
        if (this.hoverMode !== 'ruler' || this.hoverBars === null) return;
        const ctx = this.context;
        const x = this.barsToX(this.hoverBars);
        ctx.strokeStyle = 'rgba(100, 116, 139, .65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, this.rulerY - 5);
        ctx.lineTo(x, this.barY + this.barHeight);
        ctx.stroke();
        ctx.setLineDash([]);
        const boundary = this.hoverBars <= 0 || this.hoverBars >= this.options.totalBars;
        this.drawTextWithin(
            boundary ? `bar ${this.formatBars(this.hoverBars)}` : `cut ${this.formatBars(this.hoverBars)}`,
            Math.max(this.inset, Math.min(this.width - 74, x + 5)),
            this.height - 6,
            70,
            '#64748b'
        );
    }

    private draw() {
        this.context.clearRect(0, 0, this.width, this.height);
        this.drawRuler();
        this.drawTimeline();
        this.drawHover();
    }
}
