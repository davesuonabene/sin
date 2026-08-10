import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { fetchLibrary, findLibraryFile, findLibraryFileById, updateLibraryBpm, type LibraryFile } from '../api';

export class SampleNode extends BaseNode {
    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SAMPLE',
                label: 'Sample',
                sections: [
                    { type: 'fields', fields: ['filepath', 'sample_type'] }
                ]
            },
            {
                id: 'CROP',
                label: 'Crop',
                sections: [
                    { type: 'waveform_crop', filepathKey: 'filepath', cropStartKey: 'crop_start', cropEndKey: 'crop_end' },
                    { type: 'fields', fields: ['crop_start', 'crop_end'] }
                ]
            },
            {
                id: 'AUDIO',
                label: 'Audio',
                sections: [
                    { type: 'fields', fields: ['start_beat', 'original_bpm', 'target_bpm', 'key', 'transpose', 'cents', 'stretch_mode'] }
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
                    { type: 'info_table' },
                    { type: 'fields', fields: ['node_name'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'New Sample', tab: 'COMMON' },
        { key: 'filepath', label: 'Asset File', type: 'filepath', default: '', tab: 'SAMPLE', nestedFields: ['asset_fixed'] },
        { key: 'asset_fixed', label: 'Fixed', type: 'boolean', default: false, tab: 'SAMPLE', description: 'Keep the current pool asset when this node refreshes.' },
        { key: 'sample_type', label: 'Type', type: 'select', default: 'loop', options: [{ value: 'loop', label: 'Loop' }, { value: 'one_shot', label: 'One Shot' }], tab: 'SAMPLE' },
        { key: 'start_beat', label: 'Start Beat', type: 'float', default: 0, min: 0, tab: 'AUDIO' },
        { key: 'original_bpm', label: 'Original BPM', type: 'float', default: 120, min: 20, max: 300, unit: 'BPM', tab: 'AUDIO' },
        { key: 'target_bpm', label: 'Target BPM', type: 'float', default: 120, min: 20, max: 300, unit: 'BPM', tab: 'AUDIO' },
        { key: 'key', label: 'Key', type: 'string', default: '', tab: 'AUDIO' },
        { key: 'transpose', label: 'Transpose', type: 'slider', default: 0, min: -24, max: 24, step: 1, unit: 'st', tab: 'AUDIO' },
        { key: 'cents', label: 'Fine Tune', type: 'slider', default: 0, min: -100, max: 100, step: 1, unit: 'ct', tab: 'AUDIO' },
        { key: 'stretch_mode', label: 'Stretch Mode', type: 'select', default: 'time_stretch', options: [{ value: 'time_stretch', label: 'Time Stretch' }, { value: 'pitch_shift', label: 'Pitch Shift' }], tab: 'AUDIO' },
        { key: 'crop_start', label: 'Start Point', type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'CROP' },
        { key: 'crop_end', label: 'End Point', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, tab: 'CROP' }
    ];

    static defaultColor = "#10b981";
    static defaultIcon = "sample";
    static defaultShape = "circle" as const;
    static badgeLabel = "SMPL";
    static nodeType = "sample";
    static defaultTab = "SAMPLE";
    static tabs = ["SAMPLE", "CROP", "AUDIO", "CHAIN", "COMMON"];

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
            asset_fixed: false,
            sample_type: "loop",
            start_beat: 0,
            original_bpm: 120,
            target_bpm: 120,
            bpm: 120,
            key: "",
            crop_start: 0.0,
            crop_end: 1.0,
            transpose: 0.0,
            cents: 0.0,
            stretch_mode: "time_stretch",
            stretch_factor: 1.0,
            color: "#10b981",
            icon: "sample",
            shape: "circle"
        };
        
        this.addOutput("Audio", "audio");
    }

    async syncOriginalBpmFromLibrary(files?: LibraryFile[], preferredId?: number | string | null): Promise<boolean> {
        const filepath = String(this.properties?.filepath || '');
        if (!filepath) return false;
        const libraryFiles = files || await fetchLibrary(true, true);
        const libraryFile = findLibraryFileById(libraryFiles, preferredId ?? this.properties?.library_item_id)
            || findLibraryFile(libraryFiles, filepath);
        const bpm = Number(libraryFile?.bpm);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) return false;
        if (libraryFile?.id != null) this.updateProperty('library_item_id', libraryFile.id);
        if (this.properties.original_bpm !== bpm) this.updateProperty('original_bpm', bpm);
        return true;
    }

    async onPropertyEdited(key: string, value: any, _previousValue: any): Promise<void> {
        if (key === 'target_bpm') {
            this.updateProperty('bpm', value);
            return;
        }
        if (key === 'filepath') {
            this.updateProperty('library_item_id', null);
            await this.syncOriginalBpmFromLibrary();
            return;
        }
        if (key !== 'original_bpm') return;

        const filepath = String(this.properties?.filepath || '');
        if (!filepath) return;
        const result = await updateLibraryBpm(filepath, Number(value), this.properties?.library_item_id);
        this.updateProperty('original_bpm', result.bpm);
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
