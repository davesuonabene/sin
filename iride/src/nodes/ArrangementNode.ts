import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';

export interface ArrangementSectionStructure {
    points: number[];
    enabled: boolean[];
    probability: number[];
    sampleStart: number[];
    quant: string[];
    quantAnchor: ArrangementSectionAnchor[];
}

export type ArrangementSectionAnchor = 'global' | 'start' | 'end';

export class ArrangementNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'ARRANGEMENT',
                label: 'Arrangement',
                sections: [
                    { type: 'arrangement_timeline' },
                    { type: 'fields', fields: ['total_bars', 'probability', 'quant', 'quant_anchor', 'seed'] }
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
        { key: 'probability', label: 'Global Prob', type: 'float', default: 1.0, min: 0, max: 1, step: 0.05, tab: 'ARRANGEMENT' },
        { key: 'section_sample_start', label: 'Sample Start', type: 'slider', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'ARRANGEMENT', description: 'Normalized source position for the selected section.' },
        { key: 'section_quant', label: 'Local Quant', type: 'select', default: 'global', options: [{ value: 'global', label: 'Global' }, { value: 'none', label: 'None' }, { value: 'auto', label: 'Source Length' }, { value: 'bar', label: 'Bar' }, { value: '0.5', label: 'Half Bar' }, { value: 'beat', label: 'Beat' }], tab: 'ARRANGEMENT', description: 'Quantization for the selected section. Global inherits Global Quant.' },
        { key: 'section_quant_anchor', label: 'Local Anchor', type: 'select', default: 'global', options: [{ value: 'global', label: 'Global' }, { value: 'start', label: 'Start' }, { value: 'end', label: 'End' }], tab: 'ARRANGEMENT' },
        { key: 'quant', label: 'Global Quant', type: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'auto', label: 'Source Length' }, { value: 'bar', label: 'Bar' }, { value: '0.5', label: 'Half Bar' }, { value: 'beat', label: 'Beat' }], tab: 'ARRANGEMENT' },
        { key: 'quant_anchor', label: 'Global Anchor', type: 'select', default: 'start', options: [{ value: 'start', label: 'Start' }, { value: 'end', label: 'End' }], tab: 'ARRANGEMENT' },
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
            probability: 1.0,
            section_points: [],
            section_enabled: [true],
            section_probability: [1.0],
            section_sample_start: [0.0],
            section_quant: ["global"],
            section_quant_anchor: ["global"],
            quant: "none",
            quant_anchor: "start",
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

        return {
            points,
            enabled: this.normalizeSectionValues<boolean>('section_enabled', sectionCount, true),
            probability: this.normalizeSectionValues<number>('section_probability', sectionCount, 1.0),
            sampleStart: this.normalizeSectionValues<number>('section_sample_start', sectionCount, 0.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            quant: this.normalizeSectionValues<string>('section_quant', sectionCount, 'global'),
            quantAnchor: this.normalizeSectionValues<ArrangementSectionAnchor>('section_quant_anchor', sectionCount, 'global')
                .map(anchor => anchor === 'start' || anchor === 'end' ? anchor : 'global')
        };
    }

    updateSectionStructure(structure: ArrangementSectionStructure): void {
        const sectionCount = structure.points.length + 1;
        const normalized: ArrangementSectionStructure = {
            points: [...structure.points],
            enabled: this.resizeSectionValues(structure.enabled, sectionCount, true),
            probability: this.resizeSectionValues(structure.probability, sectionCount, 1.0),
            sampleStart: this.resizeSectionValues(structure.sampleStart, sectionCount, 0.0)
                .map(value => Math.max(0, Math.min(1, Number(value) || 0))),
            quant: this.resizeSectionValues(structure.quant, sectionCount, 'global'),
            quantAnchor: this.resizeSectionValues(structure.quantAnchor, sectionCount, 'global')
        };

        this.updateProperty('section_points', normalized.points);
        this.updateProperty('section_enabled', normalized.enabled);
        this.updateProperty('section_probability', normalized.probability);
        this.updateProperty('section_sample_start', normalized.sampleStart);
        this.updateProperty('section_quant', normalized.quant);
        this.updateProperty('section_quant_anchor', normalized.quantAnchor);

        // Audio preview serialization also maintains a graph-data cache. Keep it
        // aligned for consumers that have not yet moved to node properties.
        const cachedNode = (window as any).trackNodes?.get(this.id);
        if (cachedNode) {
            cachedNode.section_points = [...normalized.points];
            cachedNode.section_enabled = [...normalized.enabled];
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

    updateSectionQuant(sectionIndex: number, value: string): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.quant.length) return;
        structure.quant[sectionIndex] = String(value || 'global').toLowerCase();
        this.updateSectionStructure(structure);
    }

    updateSectionQuantAnchor(sectionIndex: number, value: ArrangementSectionAnchor): void {
        const structure = this.getSectionStructure();
        if (sectionIndex < 0 || sectionIndex >= structure.quantAnchor.length) return;
        structure.quantAnchor[sectionIndex] = value === 'start' || value === 'end' ? value : 'global';
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
        structure.enabled.splice(removedSectionIndex, 1);
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
}

(ArrangementNode as any).title = "Arrangement";
LiteGraph.registerNodeType("Audio/Arrangement", ArrangementNode);
