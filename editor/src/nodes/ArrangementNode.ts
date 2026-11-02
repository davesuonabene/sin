import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { ArrangementRenderer, type RenderBox, type SignalTelemetry, type ArrangementSection } from '../../../packages/iride/src/index.ts';
import { compositeArrangementBuffer, getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';

export interface ArrangementSectionStructure {
    points: number[];
    probability: number[];
    sampleStart: number[];
    quant: string[];
    quantAnchor: ArrangementSectionAnchor[];
    slots?: number[];
}

export type ArrangementSectionAnchor = 'start' | 'end';

export class ArrangementNode extends BaseNode {
    private arrangementRenderer = new ArrangementRenderer({ accentColor: '#f59e0b' });
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'ARRANGEMENT',
                label: 'Arrangement',
                sections: [
                    { type: 'arrangement_timeline' },
                    { type: 'fields', fields: ['seed'] }
                ]
            },
            {
                id: 'CHAIN',
                label: 'FX Chain',
                sections: [
                    { type: 'fx_chain', chainKey: 'chain' }
                ]
            },
            {
                id: 'COMMON',
                label: 'Common',
                sections: [
                    { type: 'appearance' },
                    { type: 'info_table' }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Arrangement', tab: 'COMMON' },
        { key: 'section_slots', label: 'Slot', type: 'int', default: 0, min: 0, max: 64, step: 1, tab: 'ARRANGEMENT', description: 'Upstream slot index for the selected section.' },
        { key: 'section_probability', label: 'Probability', type: 'float', default: 1.0, min: 0, max: 1, step: 0.1, tab: 'ARRANGEMENT', description: 'Playback probability for the selected section.' },
        { key: 'section_sample_start', label: 'Start Offset', type: 'slider', default: 0.0, min: 0, max: 1, step: 0.1, tab: 'ARRANGEMENT', description: 'Normalized cue playback start offset for the incoming audio (0.0 to 1.0).' },
        { key: 'section_quant', label: 'Quantize', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Continuous' }, { value: 'bar', label: 'Bar' }, { value: '0.5', label: 'Half Bar' }, { value: 'beat', label: 'Beat' }, { value: 'none', label: 'Once' }], tab: 'ARRANGEMENT', description: 'Retrigger interval for the selected section.' },
        { key: 'section_quant_anchor', label: 'Anchor', type: 'select', default: 'start', options: [{ value: 'start', label: 'Start' }, { value: 'end', label: 'End' }], tab: 'ARRANGEMENT', description: 'Align each section trigger to the start or end of its quant cell.' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'ARRANGEMENT' }
    ];

    static defaultColor = "#f59e0b";
    static defaultIcon = "arrangement";
    static defaultShape = "square" as const;
    static readonly bodySize = 28;
    static badgeLabel = "ARR";
    static nodeType = "arrangement";
    static defaultTab = "ARRANGEMENT";
    static tabs = ["ARRANGEMENT", "CHAIN", "COMMON"];

    constructor() {
        super();
        this.title = "Arrangement";
        this.size = this.computeSize();
        
        // Distinct amber/orange style for arrangement nodes
        this.color = "#f59e0b";
        this.bgcolor = "#f59e0b";
        this.boxcolor = "#d97706";
        
        this.properties = {
            ...this.properties,
            node_name: "Arrangement",
            node_type: "arrangement",
            total_bars: 4.0,
            section_points: [],
            section_probability: [1.0],
            section_sample_start: [0.0],
            section_quant: ["auto"],
            section_quant_anchor: ["start"],
            section_slots: [0],
            seed: 42,
            seed_refresh: true,
            start_beat: 0,
            color: "#f59e0b",
            icon: "arrangement",
            shape: "square"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    getSectionStructure(): ArrangementSectionStructure {
        const totalBars = Math.max(0.25, Number(this.properties.total_bars) || 4);
        const points = [...new Set(
            (Array.isArray(this.properties.section_points) ? this.properties.section_points : [])
                .map(Number)
                .filter((point: number) => Number.isFinite(point) && point > 0 && point < totalBars)
        )].sort((a, b) => a - b);
        const sectionCount = points.length + 1;

        const legacyProbability = this.legacyProbability();
        const legacyQuant = this.legacyQuant();
        const legacyAnchor = this.legacyAnchor();

        const legacyEnabled = this.normalizeSectionValues<boolean>('section_enabled', sectionCount, true);
        return {
            points,
            probability: this.normalizeSectionValues<number>('section_probability', sectionCount, legacyProbability)
                .map((value, index) => legacyEnabled[index] === false
                    ? 0
                    : Math.max(0, Math.min(1, Number(value) || 0))),
            sampleStart: this.normalizeSectionValues<number>('section_sample_start', sectionCount, 0.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            quant: this.normalizeSectionValues<string>('section_quant', sectionCount, legacyQuant)
                .map(quant => this.normalizeQuant(quant, legacyQuant)),
            quantAnchor: this.normalizeSectionValues<ArrangementSectionAnchor>('section_quant_anchor', sectionCount, legacyAnchor)
                .map(anchor => anchor === 'end' ? 'end' : anchor === 'start' ? 'start' : legacyAnchor),
            slots: this.normalizeSectionValues<number>('section_slots', sectionCount, 0)
                .map(slot => Math.max(0, Math.floor(Number(slot) || 0)))
        };
    }

    /**
     * Saved arrangements before section-only controls used a node-wide
     * probability, quant and anchor. Resolve those values into each section
     * once, then remove the retired properties from the editable node state.
     */
    migrateLegacySectionSettings(): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        if (Array.isArray(this.properties.section_quant) && this.properties.section_quant.length > 0 && this.properties.section_quant.every(q => q === 'none' || q === 'global' || q === 'inherit')) {
            structure.quant = structure.quant.map(() => 'auto');
            this.updateSectionStructure(structure);
        }
        if (!this.hasLegacySectionSettings()) return structure;
        this.updateSectionStructure(structure);
        delete this.properties.probability;
        delete this.properties.quant;
        delete this.properties.quant_anchor;
        delete this.properties.section_enabled;

        const cachedNode = typeof window !== 'undefined' ? (window as any).trackNodes?.get(this.id) : undefined;
        if (cachedNode) {
            delete cachedNode.probability;
            delete cachedNode.quant;
            delete cachedNode.quant_anchor;
            delete cachedNode.section_enabled;
        }
        return structure;
    }

    updateSectionStructure(structure: ArrangementSectionStructure): void {
        const sectionCount = structure.points.length + 1;
        const currentSlots = Array.isArray(structure.slots)
            ? structure.slots
            : (Array.isArray(this.properties.section_slots) ? this.properties.section_slots : []);
        const normalized: ArrangementSectionStructure = {
            points: [...structure.points],
            probability: this.resizeSectionValues(structure.probability, sectionCount, 1.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            sampleStart: this.resizeSectionValues(structure.sampleStart, sectionCount, 0.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            quant: this.resizeSectionValues(structure.quant, sectionCount, 'auto')
                .map(quant => this.normalizeQuant(quant, 'auto')),
            quantAnchor: this.resizeSectionValues(structure.quantAnchor, sectionCount, 'start')
                .map(anchor => anchor === 'end' ? 'end' : 'start'),
            slots: this.resizeSectionValues(currentSlots, sectionCount, 0)
                .map(slot => Math.max(0, Math.floor(Number(slot) || 0)))
        };

        this.updateProperty('section_points', normalized.points);
        this.updateProperty('section_probability', normalized.probability);
        this.updateProperty('section_sample_start', normalized.sampleStart);
        this.updateProperty('section_quant', normalized.quant);
        this.updateProperty('section_quant_anchor', normalized.quantAnchor);
        this.updateProperty('section_slots', normalized.slots);

        // Audio preview serialization also maintains a graph-data cache. Keep it
        // aligned for consumers that have not yet moved to node properties.
        const cachedNode = typeof window !== 'undefined' ? (window as any).trackNodes?.get(this.id) : undefined;
        if (cachedNode) {
            cachedNode.section_points = [...normalized.points];
            cachedNode.section_probability = [...normalized.probability];
            cachedNode.section_sample_start = [...normalized.sampleStart];
            cachedNode.section_quant = [...normalized.quant];
            cachedNode.section_quant_anchor = [...normalized.quantAnchor];
            cachedNode.section_slots = [...(normalized.slots || [])];
        }
    }

    updateSectionSlot(sectionIndex: number, value: number): void {
        const structure = this.getSectionStructure();
        const slots = structure.slots || [];
        if (sectionIndex < 0 || sectionIndex >= slots.length) return;
        slots[sectionIndex] = Math.max(0, Math.floor(Number(value) || 0));
        structure.slots = slots;
        this.updateSectionStructure(structure);
    }

    updateSectionSampleStart(sectionIndex: number, value: number): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.sampleStart.length) return;
        structure.sampleStart[sectionIndex] = Math.max(0, Math.min(1, Number(value) || 0));
        this.updateSectionStructure(structure);
    }

    updateSectionProbability(sectionIndex: number, value: number): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.probability.length) return;
        structure.probability[sectionIndex] = Math.max(0, Math.min(1, Number(value) || 0));
        this.updateSectionStructure(structure);
    }

    updateSectionQuant(sectionIndex: number, value: string): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.quant.length) return;
        structure.quant[sectionIndex] = this.normalizeQuant(value, 'auto');
        this.updateSectionStructure(structure);
    }

    updateSectionQuantAnchor(sectionIndex: number, value: ArrangementSectionAnchor): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.quantAnchor.length) return;
        structure.quantAnchor[sectionIndex] = value === 'end' ? 'end' : 'start';
        this.updateSectionStructure(structure);
    }

    override updateProperty(key: string, value: any): void {
        if (key === 'total_bars') {
            const prevTotal = Math.max(0.25, Number(this.properties.total_bars) || 4);
            const newTotal = Math.max(0.25, Number(value) || 4);
            super.updateProperty(key, newTotal);
            if (prevTotal !== newTotal && Array.isArray(this.properties.section_points) && this.properties.section_points.length > 0) {
                // Adapt existing cut points proportionally to new total length
                const scaledPoints = [...new Set(
                    this.properties.section_points
                        .map((p: number) => Math.round((p / prevTotal) * newTotal))
                        .filter((p: number) => p > 0 && p < newTotal)
                )].sort((a, b) => a - b);
                const curStructure = this.getSectionStructure();
                curStructure.points = scaledPoints;
                this.updateSectionStructure(curStructure);
            }
            return;
        }
        super.updateProperty(key, value);
    }

    splitSectionAtBar(bar: number): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        const totalBars = Math.max(0.25, Number(this.properties.total_bars) || 4);
        const intBar = Math.round(bar);
        if (intBar <= 0 || intBar >= totalBars || structure.points.includes(intBar)) {
            return structure;
        }

        const boundaries = [0, ...structure.points, totalBars];
        let sectionIdx = -1;
        for (let i = 0; i < boundaries.length - 1; i++) {
            if (intBar > boundaries[i] && intBar < boundaries[i + 1]) {
                sectionIdx = i;
                break;
            }
        }
        if (sectionIdx === -1) return structure;

        structure.points.push(intBar);
        structure.points.sort((a, b) => a - b);

        const newSectionIdx = sectionIdx + 1;
        structure.probability.splice(newSectionIdx, 0, structure.probability[sectionIdx] ?? 1.0);
        structure.sampleStart.splice(newSectionIdx, 0, structure.sampleStart[sectionIdx] ?? 0.0);
        structure.quant.splice(newSectionIdx, 0, structure.quant[sectionIdx] ?? 'auto');
        structure.quantAnchor.splice(newSectionIdx, 0, structure.quantAnchor[sectionIdx] ?? 'start');
        if (structure.slots) {
            structure.slots.splice(newSectionIdx, 0, structure.slots[sectionIdx] ?? 0);
        }

        this.updateSectionStructure(structure);
        return structure;
    }

    removeSectionCut(cutIndex: number): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        if (cutIndex < 0 || cutIndex >= structure.points.length) return structure;

        structure.points.splice(cutIndex, 1);
        // Removing a cut merges the section on its right into the section on its
        // left. Keep the expanding section's parameters and discard the old
        // right-hand section's values so every array stays aligned to the range.
        const removedSectionIndex = cutIndex + 1;
        structure.probability.splice(removedSectionIndex, 1);
        structure.sampleStart.splice(removedSectionIndex, 1);
        structure.quant.splice(removedSectionIndex, 1);
        structure.quantAnchor.splice(removedSectionIndex, 1);
        if (structure.slots) {
            structure.slots.splice(removedSectionIndex, 1);
        }
        this.updateSectionStructure(structure);
        return structure;
    }

    updateSectionCut(cutIndex: number, newBar: number): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        if (cutIndex < 0 || cutIndex >= structure.points.length) return structure;
        const totalBars = Math.max(0.25, Number(this.properties.total_bars) || 4);
        const prevBoundary = cutIndex > 0 ? structure.points[cutIndex - 1] : 0;
        const nextBoundary = cutIndex < structure.points.length - 1 ? structure.points[cutIndex + 1] : totalBars;
        const minGap = totalBars >= 2 ? 1 : 0.25;
        const clampedBar = Math.max(prevBoundary + minGap, Math.min(nextBoundary - minGap, Math.round(newBar)));
        structure.points[cutIndex] = clampedBar;
        this.updateSectionStructure(structure);
        return structure;
    }

    updateSectionLength(sectionIndex: number, newLength: number): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        const totalBars = Math.max(0.25, Number(this.properties.total_bars) || 4);
        const boundaries = [0, ...structure.points, totalBars]
            .filter((p, i, a) => p >= 0 && p <= totalBars && a.indexOf(p) === i)
            .sort((a, b) => a - b);
        const sectionCount = boundaries.length - 1;
        if (sectionIndex < 0 || sectionIndex >= sectionCount) return structure;

        const start = boundaries[sectionIndex];
        if (sectionIndex < structure.points.length) {
            const nextBoundary = sectionIndex < structure.points.length - 1 ? structure.points[sectionIndex + 1] : totalBars;
            const targetEnd = start + Math.max(1, Math.round(newLength));
            const clampedEnd = Math.max(start + 1, Math.min(nextBoundary - 1, targetEnd));
            structure.points[sectionIndex] = clampedEnd;
            this.updateSectionStructure(structure);
        }
        return structure;
    }

    private normalizeSectionValues<T>(key: string, sectionCount: number, fallback: T): T[] {
        const values = Array.isArray(this.properties[key]) ? this.properties[key] as T[] : [];
        return this.resizeSectionValues(values, sectionCount, fallback);
    }

    private resizeSectionValues<T>(values: T[], sectionCount: number, fallback: T): T[] {
        return Array.from({ length: sectionCount }, (_, index) => values[index] ?? fallback);
    }

    private legacyProbability(): number {
        const value = Number(this.properties.probability);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1.0;
    }

    private legacyQuant(): string {
        return this.normalizeQuant(this.properties.quant, 'auto');
    }

    private legacyAnchor(): ArrangementSectionAnchor {
        return this.properties.quant_anchor === 'end' ? 'end' : 'start';
    }

    private normalizeQuant(value: unknown, fallback: string): string {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized || normalized === 'global' || normalized === 'inherit') return fallback;
        if (normalized === 'continuous') return 'auto';
        return normalized;
    }

    private hasLegacySectionSettings(): boolean {
        if (
            this.properties.probability !== undefined
            || this.properties.quant !== undefined
            || this.properties.quant_anchor !== undefined
            || this.properties.section_enabled !== undefined
        ) return true;

        const isInherited = (value: unknown) => ['global', 'inherit'].includes(String(value ?? '').toLowerCase());
        return (Array.isArray(this.properties.section_quant) && this.properties.section_quant.some(isInherited))
            || (Array.isArray(this.properties.section_quant_anchor) && this.properties.section_quant_anchor.some(isInherited));
    }

    override prepareSerializedModel(model: any): any {
        const structure = this.getSectionStructure();
        const { probability: _probability, quant: _quant, quant_anchor: _quantAnchor, ...sectionOnlyModel } = model;
        const resolvedSlots = Array.isArray(model.section_slots) && model.section_slots.length === (structure.slots || []).length
            ? model.section_slots
            : (structure.slots || [0]);
        return {
            ...sectionOnlyModel,
            section_points: structure.points,
            section_probability: structure.probability,
            section_sample_start: structure.sampleStart,
            section_quant: structure.quant,
            section_quant_anchor: structure.quantAnchor,
            section_slots: resolvedSlots
        };
    }

    private _cachedVisualSections: ArrangementSection[] | null = null;
    private _cachedVisualFingerprint: string = '';

    override drawVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const totalBars = Math.max(0.25, Number(this.properties?.total_bars) || 4.0);
        const structure = this.getSectionStructure();
        const fingerprint = `${totalBars}:${JSON.stringify(structure)}`;

        let sections = this._cachedVisualSections;
        if (!sections || this._cachedVisualFingerprint !== fingerprint) {
            this._cachedVisualFingerprint = fingerprint;
            const cutPoints = Array.isArray(structure.points) ? [...structure.points].sort((a, b) => a - b) : [];
            const sectionBoundaries = [0, ...cutPoints.filter(p => p > 0 && p < totalBars), totalBars];

            sections = [];
            for (let i = 0; i < sectionBoundaries.length - 1; i++) {
                const startBar = sectionBoundaries[i];
                const endBar = sectionBoundaries[i + 1];
                const lengthBars = Math.max(0.01, endBar - startBar);
                const prob = typeof structure.probability[i] === 'number' ? structure.probability[i] : 1.0;
                const sampleStart = typeof structure.sampleStart[i] === 'number' ? structure.sampleStart[i] : 0.0;
                const quant = structure.quant[i] || 'auto';
                const slotIndex = typeof structure.slots?.[i] === 'number' ? structure.slots[i] : 0;

                sections.push({
                    index: i,
                    startBar,
                    lengthBars,
                    probability: prob,
                    sampleStart,
                    quant,
                    slotIndex
                });
            }
            this._cachedVisualSections = sections;
        }

        this.arrangementRenderer.setOptions({
            minified: this.isMinifiedStage
        });
        this.arrangementRenderer.setSignal({
            totalBars,
            sections: sections || [],
            accentColor: this.nodeColor
        });

        this.arrangementRenderer.render(ctx, bounds, telemetry);
    }

    override getLiveActivityState(telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        if (!telemetry?.isPlaying) return { isTriggered: false };
        const totalBars = Math.max(0.25, Number(this.properties?.total_bars) || 4.0);
        const currentBar = ((telemetry.bar % totalBars) + totalBars) % totalBars;
        const structure = this.getSectionStructure();
        const cutPoints = Array.isArray(structure.points) ? [...structure.points].sort((a, b) => a - b) : [];
        const boundaries = [0, ...cutPoints.filter(p => p > 0 && p < totalBars), totalBars];
        let activeProb = 1.0;
        for (let i = 0; i < boundaries.length - 1; i++) {
            if (currentBar >= boundaries[i] && currentBar < boundaries[i + 1]) {
                activeProb = typeof structure.probability[i] === 'number' ? structure.probability[i] : 1.0;
                break;
            }
        }
        return {
            isTriggered: activeProb > 0,
            progress: Math.max(0, Math.min(1, currentBar / totalBars))
        };
    }

    private _cachedCompositedBuffer: AudioBuffer | null = null;
    private _lastInputBufferRef: AudioBuffer | null = null;
    private _lastArrangementFingerprint: string = '';

    override shouldRefreshTabOnGraphChange(tab: string): boolean {
        return tab === 'ARRANGEMENT';
    }

    override getGhostBoundFieldOverrides(): Record<string, string[]> {
        return {
            'probability': ['section_probability'],
            'sample start': ['section_sample_start']
        };
    }

    override getAudioBuffer(visited?: Set<number>): AudioBuffer | null {
        if ((this as any).manifestStemBuffer) return (this as any).manifestStemBuffer;
        if ((this as any)._lastRenderedBuffer) return (this as any)._lastRenderedBuffer;

        const cycleSet = visited || new Set<number>();
        if (cycleSet.has(this.id)) return null;
        cycleSet.add(this.id);

        const inputNodes = this.getInputNodes();
        let inputBuffer: AudioBuffer | null = null;
        let inputSlotsMap: Map<number, AudioBuffer> | null = null;
        for (const inputNode of inputNodes) {
            if (typeof (inputNode as any)?.getSlotBuffersMap === 'function') {
                const map = (inputNode as any).getSlotBuffersMap(cycleSet);
                if (map && map.size > 0) {
                    inputSlotsMap = map;
                }
            }
            const buf = inputNode?.getAudioBuffer?.(cycleSet) || inputNode?.audioBuffer;
            if (buf) {
                inputBuffer = buf;
                break;
            }
        }
        if (!inputBuffer && (!inputSlotsMap || inputSlotsMap.size === 0)) return null;

        const getGlobal = (typeof window !== 'undefined') ? (window as any).getGlobalParameter : null;
        const globalBars = typeof getGlobal === 'function' ? Number(getGlobal('total_bars')) : 4;
        const globalBpm = typeof getGlobal === 'function' ? Number(getGlobal('bpm')) : 120;

        const totalBars = Number(this.properties?.total_bars) || globalBars || 4;
        const bpm = Number.isFinite(globalBpm) && globalBpm > 0 ? globalBpm : 120;
        const structure = this.getSectionStructure();
        const sectionPoints = structure.points;
        const sectionEnabled = Array.isArray(this.properties?.section_enabled) ? this.properties.section_enabled : undefined;
        const seed = Number.isFinite(Number(this.properties?.seed)) ? Number(this.properties?.seed) : 42;
        const enabledKey = sectionEnabled ? sectionEnabled.map(Boolean).join(',') : 'all';

        const nodeGain = getNodeGainMultiplier(this);
        const fp = `${totalBars}_${bpm}_${sectionPoints.join(',')}_${enabledKey}_${(structure.slots || []).join(',')}_${structure.probability.join(',')}_${structure.sampleStart.join(',')}_${structure.quant.join(',')}_${structure.quantAnchor.join(',')}_${seed}_${nodeGain}`;
        if (this._cachedCompositedBuffer && this._lastInputBufferRef === inputBuffer && this._lastArrangementFingerprint === fp) {
            return this._cachedCompositedBuffer;
        }

        const composited = compositeArrangementBuffer(
            inputSlotsMap && inputSlotsMap.size > 0 ? inputSlotsMap : (inputBuffer as AudioBuffer),
            sectionPoints,
            sectionEnabled,
            totalBars,
            bpm,
            {
                sectionSlots: structure.slots,
                sectionProbability: structure.probability,
                sectionSampleStart: structure.sampleStart,
                sectionQuant: structure.quant,
                sectionQuantAnchor: structure.quantAnchor,
                seed
            }
        );

        if (!composited) return null;
        const finalBuffer = (nodeGain !== 1.0) ? applyGainToBuffer(composited, nodeGain) : composited;

        this._cachedCompositedBuffer = finalBuffer;
        this._lastInputBufferRef = inputBuffer;
        this._lastArrangementFingerprint = fp;
        return finalBuffer;
    }
}

(ArrangementNode as any).title = "Arrangement";
LiteGraph.registerNodeType("Audio/Arrangement", ArrangementNode);
