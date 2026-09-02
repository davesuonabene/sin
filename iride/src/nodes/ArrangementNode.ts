import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

export interface ArrangementSectionStructure {
    points: number[];
    probability: number[];
    sampleStart: number[];
    quant: string[];
    quantAnchor: ArrangementSectionAnchor[];
}

export type ArrangementSectionAnchor = 'start' | 'end';

export class ArrangementNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'ARRANGEMENT',
                label: 'Arrangement',
                sections: [
                    { type: 'arrangement_timeline' },
                    { type: 'fields', fields: ['total_bars', 'seed'] }
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
        { key: 'total_bars', label: 'Total Length', type: 'float', default: 4.0, min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'ARRANGEMENT' },
        { key: 'section_probability', label: 'Probability', type: 'float', default: 1.0, min: 0, max: 1, step: 0.05, tab: 'ARRANGEMENT', description: 'Playback probability for the selected section.' },
        { key: 'section_sample_start', label: 'Sample Start', type: 'slider', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'ARRANGEMENT', description: 'Normalized source position for the selected section.' },
        { key: 'section_quant', label: 'Quantize', type: 'select', default: 'none', options: [{ value: 'none', label: 'Continuous' }, { value: 'auto', label: 'Source Length' }, { value: 'bar', label: 'Bar' }, { value: '0.5', label: 'Half Bar' }, { value: 'beat', label: 'Beat' }], tab: 'ARRANGEMENT', description: 'Retrigger interval for the selected section.' },
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
            node_name: "Arrangement",
            node_type: "arrangement",
            total_bars: 4.0,
            section_points: [],
            section_probability: [1.0],
            section_sample_start: [0.0],
            section_quant: ["none"],
            section_quant_anchor: ["start"],
            seed: Math.random(),
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
                .map(anchor => anchor === 'end' ? 'end' : anchor === 'start' ? 'start' : legacyAnchor)
        };
    }

    /**
     * Saved arrangements before section-only controls used a node-wide
     * probability, quant and anchor. Resolve those values into each section
     * once, then remove the retired properties from the editable node state.
     */
    migrateLegacySectionSettings(): ArrangementSectionStructure {
        const structure = this.getSectionStructure();
        if (!this.hasLegacySectionSettings()) return structure;
        this.updateSectionStructure(structure);
        delete this.properties.probability;
        delete this.properties.quant;
        delete this.properties.quant_anchor;
        delete this.properties.section_enabled;

        const cachedNode = (window as any).trackNodes?.get(this.id);
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
        const normalized: ArrangementSectionStructure = {
            points: [...structure.points],
            probability: this.resizeSectionValues(structure.probability, sectionCount, 1.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            sampleStart: this.resizeSectionValues(structure.sampleStart, sectionCount, 0.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            quant: this.resizeSectionValues(structure.quant, sectionCount, 'none')
                .map(quant => this.normalizeQuant(quant, 'none')),
            quantAnchor: this.resizeSectionValues(structure.quantAnchor, sectionCount, 'start')
                .map(anchor => anchor === 'end' ? 'end' : 'start')
        };

        this.updateProperty('section_points', normalized.points);
        this.updateProperty('section_probability', normalized.probability);
        this.updateProperty('section_sample_start', normalized.sampleStart);
        this.updateProperty('section_quant', normalized.quant);
        this.updateProperty('section_quant_anchor', normalized.quantAnchor);

        // Audio preview serialization also maintains a graph-data cache. Keep it
        // aligned for consumers that have not yet moved to node properties.
        const cachedNode = (window as any).trackNodes?.get(this.id);
        if (cachedNode) {
            cachedNode.section_points = [...normalized.points];
            cachedNode.section_probability = [...normalized.probability];
            cachedNode.section_sample_start = [...normalized.sampleStart];
            cachedNode.section_quant = [...normalized.quant];
            cachedNode.section_quant_anchor = [...normalized.quantAnchor];
        }
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
        structure.quant[sectionIndex] = this.normalizeQuant(value, 'none');
        this.updateSectionStructure(structure);
    }

    updateSectionQuantAnchor(sectionIndex: number, value: ArrangementSectionAnchor): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.quantAnchor.length) return;
        structure.quantAnchor[sectionIndex] = value === 'end' ? 'end' : 'start';
        this.updateSectionStructure(structure);
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
        this.updateSectionStructure(structure);
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
        return this.normalizeQuant(this.properties.quant, 'none');
    }

    private legacyAnchor(): ArrangementSectionAnchor {
        return this.properties.quant_anchor === 'end' ? 'end' : 'start';
    }

    private normalizeQuant(value: unknown, fallback: string): string {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized || normalized === 'global' || normalized === 'inherit') return fallback;
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
        return {
            ...sectionOnlyModel,
            section_points: structure.points,
            section_probability: structure.probability,
            section_sample_start: structure.sampleStart,
            section_quant: structure.quant,
            section_quant_anchor: structure.quantAnchor
        };
    }
}

(ArrangementNode as any).title = "Arrangement";
LiteGraph.registerNodeType("Audio/Arrangement", ArrangementNode);
