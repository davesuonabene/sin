import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { ArrangementRenderer, type RenderBox, type SignalTelemetry, type ArrangementSection, type VisualizationTypeId } from '../../../packages/iride/src/index.ts';
import { compositeArrangementBuffer, getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';
import { resolveCycleSeeds, resolveSectionSlot } from '../../../ermes/ts/slotLanguage.ts';

export interface ArrangementSectionStructure {
    points: number[];
    probability: number[];
    quant: string[];
    quantAnchor: ArrangementSectionAnchor[];
    slots?: Array<number | string>;
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
                    { type: 'arrangement_timeline' }
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
        { key: 'section_slots', label: 'Slot', type: 'string', default: '*', tab: 'ARRANGEMENT', description: 'Upstream slot selector for the selected section ("*" for active upstream slot, integer index, or "rand").' },
        { key: 'section_probability', label: 'Probability', type: 'float', default: 1.0, min: 0, max: 1, step: 0.1, tab: 'ARRANGEMENT', description: 'Playback probability for the selected section.' },
        { key: 'section_quant', label: 'Quantize', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Continuous' }, { value: 'bar', label: 'Bar' }, { value: '0.5', label: 'Half Bar' }, { value: 'beat', label: 'Beat' }, { value: 'none', label: 'Once' }], tab: 'ARRANGEMENT', description: 'Retrigger interval for the selected section.' },
        { key: 'section_quant_anchor', label: 'Anchor', type: 'select', default: 'start', options: [{ value: 'start', label: 'Start' }, { value: 'end', label: 'End' }], tab: 'ARRANGEMENT', description: 'Align each section trigger to the start or end of its quant cell.' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'ARRANGEMENT' }
    ];

    static defaultColor = "#f59e0b";
    static defaultIcon = "arrangement";
    static badgeLabel = "ARR";
    static nodeType = "arrangement";
    static defaultTab = "ARRANGEMENT";
    static tabs = ["ARRANGEMENT", "CHAIN", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'arrangement';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['arrangement', 'loop', 'realtime', 'spectrum'];

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
            target_bpm: "global",
            bpm: "global",
            total_bars: 4.0,
            section_points: [],
            section_probability: [1.0],
            section_quant: ["auto"],
            section_quant_anchor: ["start"],
            section_slots: ["*"],
            seed: 42,
            seed_refresh: true,
            start_beat: 0,
            color: "#f59e0b",
            icon: "arrangement"
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
            quant: this.normalizeSectionValues<string>('section_quant', sectionCount, legacyQuant)
                .map(quant => this.normalizeQuant(quant, legacyQuant)),
            quantAnchor: this.normalizeSectionValues<ArrangementSectionAnchor>('section_quant_anchor', sectionCount, legacyAnchor)
                .map(anchor => anchor === 'end' ? 'end' : anchor === 'start' ? 'start' : legacyAnchor),
            slots: this.normalizeSectionValues<number | string>('section_slots', sectionCount, '*')
                .map(slot => this.normalizeSectionSlot(slot))
        };
    }

    public getUpstreamSlotCount(): number {
        const inputNodes = this.getInputNodes();
        for (const inputNode of inputNodes) {
            if (typeof (inputNode as any)?.getSlots === 'function') {
                return Math.max(1, (inputNode as any).getSlots().length);
            }
            if (Array.isArray(inputNode?.properties?.slots) && inputNode.properties.slots.length > 0) {
                return inputNode.properties.slots.length;
            }
        }
        return 1;
    }

    public getUpstreamActiveSlot(): number {
        const inputNodes = this.getInputNodes();
        for (const inputNode of inputNodes) {
            const active = (inputNode as any)?.activeSlotIndex ?? inputNode?.properties?.active_slot;
            if (active !== undefined && Number.isFinite(Number(active))) {
                return Math.max(0, Math.trunc(Number(active)));
            }
        }
        return 0;
    }

    public getResolvedSectionSlots(): number[] {
        const structure = this.getSectionStructure();
        const rawSlots = structure.slots || ['*'];
        const upstreamCount = this.getUpstreamSlotCount();
        const upstreamActive = this.getUpstreamActiveSlot();
        const seedSalt = Number(this.properties?.seed_salt || 0) * 9973;
        const cycleSeeds = resolveCycleSeeds(this.properties?.seed ?? 42, Math.max(1, rawSlots.length), (this.id || 1) + seedSalt);
        return rawSlots.map((slotVal, idx) =>
            resolveSectionSlot(slotVal, upstreamCount, upstreamActive, cycleSeeds[idx % cycleSeeds.length] ?? 42, idx)
        );
    }

    private normalizeSectionSlot(slot: unknown): number | string {
        if (typeof slot === 'number' && Number.isFinite(slot)) {
            return Math.max(0, Math.floor(slot));
        }
        const str = String(slot ?? '*').trim();
        if (!str || str === '*' || str.toLowerCase() === 'default' || str.toLowerCase() === 'active') {
            return '*';
        }
        if (str.toLowerCase() === 'rand' || str.toLowerCase() === 'random') {
            return 'rand';
        }
        const num = Number(str);
        if (Number.isFinite(num)) {
            return Math.max(0, Math.floor(num));
        }
        return '*';
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
            quant: this.resizeSectionValues(structure.quant, sectionCount, 'auto')
                .map(quant => this.normalizeQuant(quant, 'auto')),
            quantAnchor: this.resizeSectionValues(structure.quantAnchor, sectionCount, 'start')
                .map(anchor => anchor === 'end' ? 'end' : 'start'),
            slots: this.resizeSectionValues<number | string>(currentSlots, sectionCount, '*')
                .map(slot => this.normalizeSectionSlot(slot))
        };

        this.updateProperty('section_points', normalized.points);
        this.updateProperty('section_probability', normalized.probability);
        this.updateProperty('section_quant', normalized.quant);
        this.updateProperty('section_quant_anchor', normalized.quantAnchor);
        this.updateProperty('section_slots', normalized.slots);

        // Audio preview serialization also maintains a graph-data cache. Keep it
        // aligned for consumers that have not yet moved to node properties.
        const cachedNode = typeof window !== 'undefined' ? (window as any).trackNodes?.get(this.id) : undefined;
        if (cachedNode) {
            cachedNode.section_points = [...normalized.points];
            cachedNode.section_probability = [...normalized.probability];
            cachedNode.section_quant = [...normalized.quant];
            cachedNode.section_quant_anchor = [...normalized.quantAnchor];
            cachedNode.section_slots = [...(normalized.slots || [])];
        }
    }

    updateSectionSlot(sectionIndex: number, value: number | string): void {
        const structure = this.getSectionStructure();
        const slots = structure.slots || [];
        if (sectionIndex < 0 || sectionIndex >= slots.length) return;
        slots[sectionIndex] = this.normalizeSectionSlot(value);
        structure.slots = slots;
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
        structure.quant.splice(newSectionIdx, 0, structure.quant[sectionIdx] ?? 'auto');
        structure.quantAnchor.splice(newSectionIdx, 0, structure.quantAnchor[sectionIdx] ?? 'start');
        if (structure.slots) {
            structure.slots.splice(newSectionIdx, 0, structure.slots[sectionIdx] ?? '*');
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
        const resolvedSlots = Array.isArray(model.section_slots)
            && model.section_slots.length === (structure.slots || []).length
            && model.section_slots.every((s: any) => typeof s === 'number' && Number.isFinite(s))
            ? model.section_slots
            : this.getResolvedSectionSlots();
        return {
            ...sectionOnlyModel,
            section_points: structure.points,
            section_probability: structure.probability,
            section_quant: structure.quant,
            section_quant_anchor: structure.quantAnchor,
            section_slots: resolvedSlots
        };
    }

    private _cachedVisualSections: ArrangementSection[] | null = null;
    private _cachedVisualFingerprint: string = '';

    protected override drawDedicatedVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const totalBars = Math.max(0.25, Number(this.properties?.total_bars) || 4.0);
        const structure = this.getSectionStructure();
        const resolvedSlots = this.getResolvedSectionSlots();
        const fingerprint = `${totalBars}:${JSON.stringify(structure)}:${resolvedSlots.join(',')}`;

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
                const quant = structure.quant[i] || 'auto';
                const slotIndex = typeof resolvedSlots[i] === 'number' ? resolvedSlots[i] : 0;

                sections.push({
                    index: i,
                    startBar,
                    lengthBars,
                    probability: prob,
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
            'probability': ['section_probability']
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
        const resolvedSlots = this.getResolvedSectionSlots();
        const sectionPoints = structure.points;
        const sectionEnabled = Array.isArray(this.properties?.section_enabled) ? this.properties.section_enabled : undefined;
        const seed = Number.isFinite(Number(this.properties?.seed)) ? Number(this.properties?.seed) : 42;
        const enabledKey = sectionEnabled ? sectionEnabled.map(Boolean).join(',') : 'all';

        const nodeGain = getNodeGainMultiplier(this);
        const fp = `${totalBars}_${bpm}_${sectionPoints.join(',')}_${enabledKey}_${resolvedSlots.join(',')}_${structure.probability.join(',')}_${structure.quant.join(',')}_${structure.quantAnchor.join(',')}_${seed}_${nodeGain}`;
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
                sectionSlots: resolvedSlots,
                sectionProbability: structure.probability,
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
