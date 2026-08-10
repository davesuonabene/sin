export type ArrangementAnchor = 'global' | 'start' | 'end';

export interface ArrangementSourceVisual {
    bars: number;
    label: string;
    kind: 'loop' | 'sample' | 'sequence' | 'mixed';
}

export interface ArrangementVisualizerOptions {
    container: HTMLElement;
    totalBars: number;
    sectionPoints: number[];
    sectionEnabled: boolean[];
    sectionProbability?: number[];
    sectionQuant?: string[];
    sectionQuantAnchor?: ArrangementAnchor[];
    selectedSection: number;
    quant: string;
    anchor: ArrangementAnchor;
    source: ArrangementSourceVisual | null;
    onSectionStructureChange: (
        points: number[],
        enabled: boolean[],
        probability?: number[],
        quant?: string[],
        anchor?: ArrangementAnchor[]
    ) => void;
    onSectionSelect: (index: number) => void;
}

/** Canvas editor for arrangement sections and quantized sample placements. */
export class ArrangementVisualizer {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly resizeObserver: ResizeObserver;
    private options: ArrangementVisualizerOptions;
    private hoverBars: number | null = null;
    private hoverSection: number | null = null;
    private hoverMode: 'ruler' | 'section' | null = null;
    private width = 0;
    private height = 184;
    private readonly inset = 14;
    private readonly rulerY = 35;
    private readonly barY = 68;
    private readonly barHeight = 82;
    private readonly rulerHitRadius = 15;

    constructor(options: ArrangementVisualizerOptions) {
        this.options = { ...options, sectionPoints: [...options.sectionPoints] };
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'arrangement-visualizer-canvas';
        this.canvas.setAttribute('aria-label', 'Arrangement timeline. Click the ruler to add or remove section markers.');
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

    setSectionEnabled(index: number, enabled: boolean) {
        if (index < 0 || index >= this.options.sectionEnabled.length) return;
        this.options.sectionEnabled[index] = enabled;
        this.draw();
    }

    private getSectionProbability(index: number): number {
        const prob = this.options.sectionProbability?.[index];
        if (prob != null && Number.isFinite(prob) && prob >= 0 && prob <= 1) {
            return prob;
        }
        return 1.0;
    }

    private getSectionQuant(index: number): string {
        const q = this.options.sectionQuant?.[index];
        if (q && q !== 'global') {
            return q;
        }
        return this.options.quant;
    }

    private getSectionAnchor(index: number): ArrangementAnchor {
        const a = this.options.sectionQuantAnchor?.[index];
        if (a === 'start' || a === 'end') return a;
        return this.options.anchor;
    }

    private getSectionAt(bars: number) {
        const boundaries = this.getBoundaries();
        for (let index = 0; index < boundaries.length - 1; index++) {
            if (bars < boundaries[index + 1] || index === boundaries.length - 2) return index;
        }
        return boundaries.length - 2;
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
            const selectedSection = this.getSectionAt(rawBars);
            this.options.selectedSection = selectedSection;
            this.options.onSectionSelect(selectedSection);
            this.draw();
            return;
        }

        if (!this.isRulerHit(localY)) return;

        const snapped = Math.round(rawBars);
        if (snapped <= 0 || snapped >= this.options.totalBars) return;
        const existingIndex = this.options.sectionPoints.findIndex(point => Math.abs(point - snapped) < 0.001);
        let nextPoints: number[];
        const nextEnabled = [...this.options.sectionEnabled];
        const nextProb = [...(this.options.sectionProbability || [])];
        const nextQuant = [...(this.options.sectionQuant || [])];
        const nextAnchor = [...(this.options.sectionQuantAnchor || [])];

        if (existingIndex !== -1) {
            nextPoints = this.options.sectionPoints.filter((_, index) => index !== existingIndex);
            nextEnabled.splice(existingIndex + 1, 1);
            if (nextProb.length > existingIndex + 1) nextProb.splice(existingIndex + 1, 1);
            if (nextQuant.length > existingIndex + 1) nextQuant.splice(existingIndex + 1, 1);
            if (nextAnchor.length > existingIndex + 1) nextAnchor.splice(existingIndex + 1, 1);
            if (this.options.selectedSection > existingIndex) this.options.selectedSection--;
        } else {
            const splitSection = this.getSectionAt(snapped);
            nextPoints = [...this.options.sectionPoints, snapped].sort((a, b) => a - b);
            nextEnabled.splice(splitSection + 1, 0, nextEnabled[splitSection] !== false);
            nextProb.splice(splitSection + 1, 0, nextProb[splitSection] ?? 1.0);
            nextQuant.splice(splitSection + 1, 0, nextQuant[splitSection] ?? 'global');
            nextAnchor.splice(splitSection + 1, 0, nextAnchor[splitSection] ?? 'global');
        }
        this.options.sectionPoints = nextPoints;
        this.options.sectionEnabled = nextEnabled;
        this.options.sectionProbability = nextProb;
        this.options.sectionQuant = nextQuant;
        this.options.sectionQuantAnchor = nextAnchor;
        this.options.selectedSection = Math.min(this.options.selectedSection, nextEnabled.length - 1);
        this.options.onSectionStructureChange([...nextPoints], [...nextEnabled], [...nextProb], [...nextQuant], [...nextAnchor]);
        this.options.onSectionSelect(this.options.selectedSection);
        this.draw();
    };

    private chooseTickInterval() {
        const idealTicks = Math.max(2, Math.floor(this.plotWidth / 54));
        const raw = this.options.totalBars / idealTicks;
        const candidates = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
        return candidates.find(candidate => candidate >= raw) || 128;
    }

    private drawRuler() {
        const ctx = this.context;
        const endX = this.width - this.inset;
        ctx.strokeStyle = '#64748b';
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
            ctx.moveTo(x, this.rulerY - 4);
            ctx.lineTo(x, this.rulerY + 4);
            ctx.stroke();
            if (bar < this.options.totalBars) ctx.fillText(this.formatBars(bar), x, this.rulerY + 7);
        }

        const totalLabel = `${this.formatBars(this.options.totalBars)} ${this.options.totalBars === 1 ? 'bar' : 'bars'}`;
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        const labelWidth = ctx.measureText(totalLabel).width + 10;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(endX - labelWidth, this.rulerY - 19, labelWidth, 15);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(totalLabel, endX - 5, this.rulerY - 11.5);
    }

    private getBoundaries() {
        return [0, ...this.options.sectionPoints, this.options.totalBars]
            .filter((point, index, values) => point >= 0 && point <= this.options.totalBars && values.indexOf(point) === index)
            .sort((a, b) => a - b);
    }

    private drawTimeline() {
        const ctx = this.context;
        const boundaries = this.getBoundaries();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(this.inset, this.barY, this.plotWidth, this.barHeight, 5);
        ctx.fill();
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(this.inset, this.barY, this.plotWidth, this.barHeight, 5);
        ctx.clip();
        for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index];
            const end = boundaries[index + 1];
            const startX = this.barsToX(start);
            const sectionWidth = this.barsToX(end) - startX;
            if (this.options.sectionEnabled[index] === false) {
                ctx.fillStyle = 'rgba(100, 116, 139, .16)';
                ctx.fillRect(startX, this.barY, sectionWidth, this.barHeight);
                ctx.strokeStyle = 'rgba(100, 116, 139, .18)';
                ctx.lineWidth = 1;
                for (let stripeX = startX - this.barHeight; stripeX < startX + sectionWidth; stripeX += 10) {
                    ctx.beginPath();
                    ctx.moveTo(stripeX, this.barY + this.barHeight);
                    ctx.lineTo(stripeX + this.barHeight, this.barY);
                    ctx.stroke();
                }
            } else if (index % 2 === 1) {
                ctx.fillStyle = 'rgba(245, 158, 11, 0.055)';
                ctx.fillRect(startX, this.barY, sectionWidth, this.barHeight);
            }
            if (this.hoverSection === index && this.hoverMode === 'section') {
                ctx.fillStyle = 'rgba(14, 165, 233, .10)';
                ctx.fillRect(startX, this.barY, sectionWidth, this.barHeight);
            }
        }
        this.drawPlacements(boundaries);
        ctx.restore();

        const selectedIndex = Math.max(0, Math.min(boundaries.length - 2, this.options.selectedSection));
        const selectedX = this.barsToX(boundaries[selectedIndex]);
        const selectedWidth = this.barsToX(boundaries[selectedIndex + 1]) - selectedX;
        ctx.strokeStyle = '#0ea5e9';
        ctx.lineWidth = 2;
        ctx.strokeRect(selectedX + 1, this.barY + 1, Math.max(0, selectedWidth - 2), this.barHeight - 2);

        for (const point of this.options.sectionPoints) {
            const x = this.barsToX(point);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, this.rulerY - 5);
            ctx.lineTo(x, this.barY + this.barHeight);
            ctx.stroke();
            ctx.fillStyle = '#f59e0b';
            ctx.beginPath();
            ctx.moveTo(x - 5, this.rulerY - 6);
            ctx.lineTo(x + 5, this.rulerY - 6);
            ctx.lineTo(x, this.rulerY + 1);
            ctx.closePath();
            ctx.fill();
        }
    }

    private drawPlacements(boundaries: number[]) {
        const source = this.options.source;
        if (!source || !Number.isFinite(source.bars) || source.bars <= 0) return;
        let placementIndex = 0;

        for (let sectionIndex = 0; sectionIndex < boundaries.length - 1; sectionIndex++) {
            if (this.options.sectionEnabled[sectionIndex] === false) continue;
            const sectionStart = boundaries[sectionIndex];
            const sectionEnd = boundaries[sectionIndex + 1];

            const secQuant = this.getSectionQuant(sectionIndex);
            const secAnchor = this.getSectionAnchor(sectionIndex);
            const quantValue = Number.parseFloat(secQuant);
            const interval = secQuant === 'none'
                ? null
                : secQuant === 'auto'
                    ? source.bars
                    : Number.isFinite(quantValue) && quantValue > 0 ? quantValue : null;

            let cellStart = sectionStart;
            do {
                const cellEnd = interval === null ? sectionEnd : Math.min(sectionEnd, cellStart + interval);
                const placementStart = secAnchor === 'start' ? cellStart : cellEnd - source.bars;
                const visibleStart = Math.max(sectionStart, placementStart);
                const visibleEnd = Math.min(sectionEnd, placementStart + source.bars);
                if (visibleEnd > visibleStart) {
                    const prob = this.getSectionProbability(sectionIndex);
                    this.drawSourceBox(visibleStart, visibleEnd, source, placementIndex++, secAnchor, prob);
                }
                if (interval === null) break;
                cellStart += interval;
            } while (cellStart < sectionEnd - 0.0001 && placementIndex < 256);
        }
    }

    private drawSourceBox(
        startBars: number,
        endBars: number,
        source: ArrangementSourceVisual,
        index: number,
        anchor: ArrangementAnchor = 'start',
        probability: number = 1.0
    ) {
        const ctx = this.context;
        const x = this.barsToX(startBars);
        const width = Math.max(2, this.barsToX(endBars) - x);
        const y = this.barY + 31;
        const height = 37;
        const isLoop = source.kind === 'loop' || source.kind === 'sequence';
        
        ctx.save();
        if (probability < 1.0) {
            ctx.globalAlpha = Math.max(0.35, probability);
        }

        ctx.fillStyle = isLoop ? '#10b981' : source.kind === 'mixed' ? '#8b5cf6' : '#334155';
        ctx.strokeStyle = isLoop ? '#047857' : '#0f172a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 1, y, Math.max(1, width - 2), height, 3);
        ctx.fill();
        ctx.stroke();

        if (isLoop) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 1, y, Math.max(1, width - 2), height);
            ctx.clip();
            ctx.strokeStyle = 'rgba(255,255,255,.22)';
            for (let stripeX = x - height; stripeX < x + width; stripeX += 9) {
                ctx.beginPath();
                ctx.moveTo(stripeX, y + height);
                ctx.lineTo(stripeX + height, y);
                ctx.stroke();
            }
            ctx.restore();
        }

        if (width >= 48) {
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 9px Inter, system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const label = index === 0 ? source.label : `${source.kind === 'sample' ? 'SHOT' : 'LOOP'} ${index + 1}`;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 5, y, Math.max(1, width - 10), height);
            ctx.clip();
            ctx.fillText(label, x + 7, y + height / 2);
            ctx.restore();
        }

        const anchorX = anchor === 'end' ? x + width - 5 : x + 5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(anchorX, y + height - 6, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    private drawHover() {
        if (this.hoverMode !== 'ruler' || this.hoverBars === null) return;
        const ctx = this.context;
        const x = this.barsToX(this.hoverBars);
        ctx.strokeStyle = 'rgba(15, 23, 42, .65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, this.rulerY - 5);
        ctx.lineTo(x, this.barY + this.barHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        const isBoundary = this.hoverBars <= 0 || this.hoverBars >= this.options.totalBars;
        const label = isBoundary ? `Bar ${this.formatBars(this.hoverBars)} · boundary` : `Cut at bar ${this.formatBars(this.hoverBars)}`;
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        const width = ctx.measureText(label).width + 12;
        const tooltipX = Math.max(this.inset, Math.min(this.width - this.inset - width, x - width / 2));
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.roundRect(tooltipX, this.height - 25, width, 18, 3);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tooltipX + width / 2, this.height - 16);
    }

    private draw() {
        const ctx = this.context;
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, this.width, this.height);
        this.drawRuler();
        this.drawTimeline();
        this.drawHover();
    }
}
