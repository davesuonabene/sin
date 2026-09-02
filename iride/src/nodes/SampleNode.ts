import { LiteGraph } from 'litegraph.js';
import { BaseNode, DEFAULT_SAMPLE_INPUT_GAIN_DB, getDefaultFxChain } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { findLibraryFileForSnapshot, resolveLibraryAssets, submitLibraryMetadataProposal, type LibraryFile } from '../api';

type MusicalMode = 'major' | 'minor' | null;
type KeyMatchAlgorithm = 'nearest' | 'higher' | 'lower';

interface ParsedKey {
    pitchClass: number;
    mode: MusicalMode;
}

export class SampleNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SAMPLE',
                label: 'Sample',
                sections: [
                    { type: 'waveform_crop', filepathKey: 'filepath', cropStartKey: 'crop_start', cropEndKey: 'crop_end' },
                    { type: 'fields', layout: 'inline', fields: ['crop_start', 'crop_end'] },
                    { type: 'fields', fields: ['sample_type'] },
                    { type: 'fields', fields: ['start_beat', 'original_bpm', 'target_bpm', 'key', 'key_match_mode', 'key_match_algorithm', 'transpose', 'cents', 'stretch_mode', 'stretch_algorithm'] }
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'New Sample', tab: 'COMMON' },
        { key: 'filepath', label: 'Asset File', type: 'filepath', default: '', tab: 'SAMPLE' },
        { key: 'sample_type', label: 'Type', type: 'select', default: 'loop', options: [{ value: 'loop', label: 'Loop' }, { value: 'one_shot', label: 'One Shot' }], tab: 'SAMPLE' },
        { key: 'start_beat', label: 'Start Beat', type: 'float', default: 0, min: 0, tab: 'SAMPLE' },
        {
            key: 'original_bpm',
            label: 'Source BPM',
            type: 'float',
            default: 120,
            min: 20,
            max: 300,
            unit: 'BPM',
            tab: 'SAMPLE',
            description: 'Used locally now and staged as a proposal for GAIA to review before changing the library asset.'
        },
        { key: 'target_bpm', label: 'Target BPM', type: 'float', default: 120, min: 20, max: 300, unit: 'BPM', tab: 'SAMPLE' },
        {
            key: 'key',
            label: 'Key',
            type: 'string',
            default: '',
            tab: 'SAMPLE',
            description: 'Used locally now and staged as a proposal for GAIA to review before changing the library asset.'
        },
        {
            key: 'key_match_mode',
            label: 'Key Matching',
            type: 'radio',
            default: 'off',
            options: [
                { value: 'off', label: 'Off' },
                { value: 'follow', label: 'Follow' },
                { value: 'lead', label: 'Lead' }
            ],
            tab: 'SAMPLE',
            description: 'Follow matches the global key; Lead makes this sample control the global key.'
        },
        {
            key: 'key_match_algorithm',
            label: 'Matching Algorithm',
            type: 'select',
            default: 'nearest',
            options: [
                { value: 'nearest', label: 'Shift Nearest' },
                { value: 'higher', label: 'Shift Higher' },
                { value: 'lower', label: 'Shift Lower' }
            ],
            tab: 'SAMPLE',
            description: 'Choose whether Follow shifts to the closest compatible key, only upward, or only downward.'
        },
        { key: 'transpose', label: 'Transpose', type: 'slider', default: 0, min: -24, max: 24, step: 1, unit: 'st', tab: 'SAMPLE' },
        { key: 'cents', label: 'Fine Tune', type: 'slider', default: 0, min: -100, max: 100, step: 1, unit: 'ct', tab: 'SAMPLE' },
        {
            key: 'stretch_mode',
            label: 'Stretch Mode',
            type: 'select',
            default: 'time_stretch',
            options: [
                { value: 'time_stretch', label: 'Time Stretch (Independent Pitch)' },
                { value: 'pitch_shift', label: 'Repitch (Speed + Pitch)' }
            ],
            tab: 'SAMPLE',
            description: 'Time Stretch keeps key shifts independent from timing. Repitch links the key shift to playback speed, like tape or vinyl.'
        },
        {
            key: 'stretch_algorithm',
            label: 'Stretch Algorithm',
            type: 'select',
            default: 'rubberband',
            options: [
                { value: 'rubberband', label: 'General / Tonal — R3 Finer' },
                { value: 'rubberband_vocal', label: 'Vocals / Speech — R3 Formant' },
                { value: 'rubberband_percussive', label: 'Drums / Percussion — R2 Crisp' }
            ],
            tab: 'SAMPLE',
            description: 'General is best for most musical samples and manual pitch-down. Vocals preserves formants. Percussion favours drum transients. Repitch always uses tape-style resampling.'
        },
        { key: 'crop_start', label: 'Start Point', type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'SAMPLE' },
        { key: 'crop_end', label: 'End Point', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, tab: 'SAMPLE' }
    ];

    static defaultColor = "#10b981";
    static defaultIcon = "sample";
    static defaultShape = "circle" as const;
    static badgeLabel = "SMPL";
    static nodeType = "sample";
    static defaultTab = "SAMPLE";
    static tabs = ["SAMPLE", "CHAIN", "COMMON"];

    constructor() {
        super();
        this.title = "Sample";
        this.size = this.computeSize();
        
        // Leaf node visual style (Emerald)
        this.color = "#10b981";
        this.bgcolor = "#10b981";
        this.boxcolor = "#059669";
        
        this.properties = {
            node_name: "New Sample",
            filepath: "",
            sample_type: "loop",
            start_beat: 0,
            original_bpm: 120,
            target_bpm: 120,
            bpm: 120,
            key: "",
            key_match_mode: "off",
            key_match_algorithm: "nearest",
            key_match_transpose: 0,
            crop_start: 0.0,
            crop_end: 1.0,
            transpose: 0.0,
            cents: 0.0,
            stretch_mode: "time_stretch",
            stretch_factor: 1.0,
            stretch_algorithm: "rubberband",
            chain: getDefaultFxChain(DEFAULT_SAMPLE_INPUT_GAIN_DB),
            color: "#10b981",
            icon: "sample",
            shape: "circle"
        };
        
        this.addOutput("Audio", "audio");
    }

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if (!this.graph) return;
        if (key === 'key_match_mode' || key === 'key_match_algorithm' || key === 'key') {
            SampleNode.propagateKeyMatch(
                this.graph,
                key === 'key_match_mode' && value === 'lead' ? this : undefined
            );
        }
    }

    override preparePropertyEdit(key: string, value: any, previousValue: any): boolean {
        if (key !== 'key' && key !== 'original_bpm') return true;
        if (Object.is(value, previousValue)) return true;

        const overrideKey = key === 'key' ? 'key_is_local_override' : 'original_bpm_is_local_override';
        if (this.properties?.[overrideKey]) return true;

        const label = key === 'key' ? 'key' : 'source BPM';
        const accepted = typeof window === 'undefined' || typeof window.confirm !== 'function'
            ? true
            : window.confirm(
                `Use a node-local ${label} override?\n\n`
                + 'SIN will use this value now and stage it for GAIA review. Only GAIA can apply it to the library asset.'
            );
        if (accepted) this.updateProperty(overrideKey, true);
        return accepted;
    }

    async syncMetadataFromLibrary(files?: LibraryFile[], preferredId?: number | string | null): Promise<LibraryFile | null> {
        const filepath = String(this.properties?.filepath || '');
        if (!filepath) return null;
        const libraryFiles = files || await resolveLibraryAssets([{
            id: preferredId ?? this.properties?.library_item_id,
            absolute_path: filepath
        }]);
        // Presets store both a path and an ID. Collection-content IDs contain a
        // manifest index that may point at another file after a GAIA rescan, so
        // never let that stale index override the exact saved asset path.
        const libraryFile = findLibraryFileForSnapshot(
            libraryFiles,
            filepath,
            preferredId ?? this.properties?.library_item_id
        );
        if (!libraryFile) return null;

        const bpm = Number(libraryFile?.bpm);
        if (libraryFile?.id != null) this.updateProperty('library_item_id', libraryFile.id);
        if (libraryFile.absolute_path && libraryFile.absolute_path !== filepath) {
            this.updateProperty('filepath', libraryFile.absolute_path);
        }
        if (!this.properties?.original_bpm_is_local_override
            && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 && this.properties.original_bpm !== bpm) {
            this.updateProperty('original_bpm', bpm);
        }

        const duration = Number(libraryFile.duration_seconds);
        if (Number.isFinite(duration) && duration >= 0 && this.properties.duration_seconds !== duration) {
            this.updateProperty('duration_seconds', duration);
        }

        const libraryKey = String(libraryFile.key || '').trim();
        if (!this.properties?.key_is_local_override && this.properties.key !== libraryKey) {
            this.updateProperty('key', libraryKey);
        }
        SampleNode.propagateKeyMatch(this.graph);
        return libraryFile;
    }

    async syncOriginalBpmFromLibrary(files?: LibraryFile[], preferredId?: number | string | null): Promise<boolean> {
        const libraryFile = await this.syncMetadataFromLibrary(files, preferredId);
        const bpm = Number(libraryFile?.bpm);
        return Number.isFinite(bpm) && bpm >= 20 && bpm <= 400;
    }

    async onPropertyEdited(key: string, value: any, previousValue: any): Promise<void> {
        if (key === 'target_bpm') {
            this.updateProperty('bpm', value);
            return;
        }
        if (key === 'key' || key === 'original_bpm') {
            const field = key === 'key' ? 'key' : 'bpm';
            const proposalKey = key === 'key' ? 'key_proposal' : 'original_bpm_proposal';
            const stagedProposal = {
                field,
                value,
                previousValue,
                status: 'staging',
                updatedAt: new Date().toISOString(),
            };
            this.updateProperty(proposalKey, stagedProposal);
            try {
                const proposal = await submitLibraryMetadataProposal({
                    filepath: String(this.properties?.filepath || ''),
                    fileId: this.properties?.library_item_id,
                    field,
                    value: field === 'bpm' ? Number(value) : String(value),
                    previousValue: field === 'bpm' ? Number(previousValue) : String(previousValue ?? ''),
                    sourceNodeId: this.id ?? null,
                });
                this.updateProperty(proposalKey, {
                    ...stagedProposal,
                    id: proposal.id,
                    value: proposal.proposed_value,
                    status: proposal.status,
                    updatedAt: proposal.updated_at,
                });
            } catch (error) {
                // Keep the useful node-local edit. A later metadata edit will
                // retry staging it when GAIA becomes available.
                this.updateProperty(proposalKey, {
                    ...stagedProposal,
                    status: 'pending_sync',
                    error: error instanceof Error ? error.message : 'GAIA proposal queue is unavailable',
                });
                console.warn('Could not stage GAIA metadata proposal', error);
            }
            return;
        }
        if (key === 'filepath') {
            this.updateProperty('library_item_id', null);
            this.updateProperty('key_is_local_override', false);
            this.updateProperty('original_bpm_is_local_override', false);
            await this.syncMetadataFromLibrary();
            return;
        }
    }

    override onGlobalParametersChanged(parameters: Record<string, any>): void {
        SampleNode.propagateKeyMatch(this.graph, undefined, String(parameters.key || ''));
    }

    override prepareSerializedModel(model: any): any {
        SampleNode.propagateKeyMatch(this.graph);
        const matchTranspose = this.properties?.key_match_mode === 'follow'
            ? Number(this.properties?.key_match_transpose) || 0
            : 0;
        if (matchTranspose === 0) return model;

        return {
            ...model,
            key: this.properties?.key_match_target || model.key,
            transpose: (Number(model.transpose) || 0) + matchTranspose
        };
    }

    static calculateKeyMatch(
        sourceKey: string,
        leadKey: string,
        algorithm: KeyMatchAlgorithm = 'nearest'
    ): { transpose: number; targetKey: string } | null {
        const source = this.parseKey(sourceKey);
        const lead = this.parseKey(leadKey);
        if (!source || !lead) return null;

        let targetPitchClass = lead.pitchClass;
        if (source.mode && lead.mode && source.mode !== lead.mode) {
            // Transposition preserves mode, so match the relative major/minor in the lead scale.
            targetPitchClass = lead.mode === 'minor'
                ? (lead.pitchClass + 3) % 12
                : (lead.pitchClass + 9) % 12;
        }

        const upward = (targetPitchClass - source.pitchClass + 12) % 12;
        let transpose: number;
        switch (algorithm) {
            case 'higher':
                transpose = upward;
                break;
            case 'lower':
                transpose = upward === 0 ? 0 : upward - 12;
                break;
            default:
                transpose = upward > 6 ? upward - 12 : upward;
                break;
        }
        return { transpose, targetKey: this.formatKey(targetPitchClass, source.mode) };
    }

    private static coordinatingGraphs = new WeakSet<object>();

    private static propagateKeyMatch(graph: any, preferredLead?: SampleNode, globalKeyOverride?: string): void {
        if (!graph) return;
        if (this.coordinatingGraphs.has(graph)) return;
        this.coordinatingGraphs.add(graph);

        try {
            const samples = (((graph as any)._nodes || []) as any[])
                .filter((node: any): node is SampleNode =>
                    node instanceof SampleNode || node?.nodeType === SampleNode.nodeType
                );
            const lead = preferredLead?.properties?.key_match_mode === 'lead'
                ? preferredLead
                : samples.find(sample => sample.properties?.key_match_mode === 'lead');

            for (const sample of samples) {
                if (sample !== lead && sample.properties?.key_match_mode === 'lead') {
                    sample.updateProperty('key_match_mode', 'off');
                }
            }

            const leadKey = String(lead?.properties?.key || '');
            const savedGlobalKey = String(
                globalKeyOverride
                ?? graph?.extra?.global_parameters?.key
                ?? (typeof window !== 'undefined' ? (window as any).getGlobalParameter?.('key') : '')
                ?? ''
            ).trim();
            const targetKey = leadKey.trim() || savedGlobalKey;

            if (leadKey.trim() && leadKey.trim() !== savedGlobalKey) {
                const setGlobalParameters = typeof window !== 'undefined'
                    ? (window as any).setGlobalParameters
                    : undefined;
                if (typeof setGlobalParameters === 'function') {
                    setGlobalParameters({ key: leadKey.trim() }, graph);
                } else {
                    if (!graph.extra) graph.extra = {};
                    graph.extra.global_parameters = {
                        ...(graph.extra.global_parameters || {}),
                        key: leadKey.trim()
                    };
                }
            }

            for (const sample of samples) {
                const match = sample.properties?.key_match_mode === 'follow'
                    ? this.calculateKeyMatch(
                        String(sample.properties?.key || ''),
                        targetKey,
                        this.normalizeKeyMatchAlgorithm(sample.properties?.key_match_algorithm)
                    )
                    : null;
                sample.properties.key_match_transpose = match?.transpose ?? 0;
                sample.properties.key_match_target = match?.targetKey ?? '';
                sample.setDirtyCanvas?.(true, true);
            }
        } finally {
            this.coordinatingGraphs.delete(graph);
        }
    }

    private static normalizeKeyMatchAlgorithm(value: unknown): KeyMatchAlgorithm {
        return value === 'higher' || value === 'lower' ? value : 'nearest';
    }

    private static parseKey(value: string): ParsedKey | null {
        const match = String(value || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b')
            .match(/^([A-Ga-g])([#b]?)(?:[\s_-]*(maj(?:or)?|min(?:or)?|m))?$/i);
        if (!match) return null;

        const naturalPitchClasses: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
        const suffix = (match[3] || '').toLowerCase();
        const mode: MusicalMode = suffix === 'm' || suffix.startsWith('min')
            ? 'minor'
            : suffix.startsWith('maj') ? 'major' : null;
        return {
            pitchClass: (naturalPitchClasses[match[1].toUpperCase()] + accidental + 12) % 12,
            mode
        };
    }

    private static formatKey(pitchClass: number, mode: MusicalMode): string {
        const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const suffix = mode === 'major' ? 'maj' : mode === 'minor' ? 'min' : '';
        return `${pitchNames[pitchClass]}${suffix}`;
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
