import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { WaveformRenderer, type RenderBox, type SignalTelemetry } from '../../../packages/iride/src/index.ts';

export class TrackNode extends BaseNode {
    private waveformRenderer = new WaveformRenderer({ accentColor: '#4f46e5' });
    private audioBuffer: AudioBuffer | null = null;

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'TRACK',
                label: 'Track',
                sections: [
                    { type: 'fields', fields: ['mix_mode', 'bpm', 'total_bars'] }
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
                    { type: 'info_table' },
                    { type: 'fields', fields: ['scope_mode', 'scope_window', 'scope_gain'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Master Track', tab: 'COMMON' },
        {
            key: 'scope_mode',
            label: 'Scope Mode',
            type: 'select',
            default: 'full',
            options: [
                { value: 'full', label: 'Full Stem' },
                { value: 'drawn', label: 'Real-Time Drawn' },
                { value: 'scrolled', label: 'Real-Time Scrolled' }
            ],
            tab: 'COMMON',
            description: 'Visualizer mode: Full stem, Real-time drawn sweep, or Real-time scrolled'
        },
        { key: 'scope_window', label: 'Scope Window', type: 'float', default: 0.0, min: 0.0, max: 64.0, step: 0.25, unit: 's', tab: 'COMMON', description: 'Window size for oscilloscope sweep (0 = auto-inherit track length)' },
        { key: 'scope_gain', label: 'Scope Gain', type: 'float', default: 1.0, min: 0.2, max: 5.0, step: 0.1, tab: 'COMMON', description: 'Real-time oscilloscope amplitude gain' },
        { key: 'mix_mode', label: 'Mix Mode', type: 'select', default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'first', label: 'First' }, { value: 'last', label: 'Last' }], tab: 'TRACK' },
        { key: 'bpm', label: 'Engine BPM', type: 'global_float', default: 'global', min: 20, max: 300, unit: 'BPM', tab: 'TRACK' },
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'TRACK' }
    ];

    static defaultColor = "#4f46e5";
    static defaultIcon = "mixer";
    static defaultShape = "diamond" as const;
    static badgeLabel = "TRACK";
    static nodeType = "track";
    static defaultTab = "TRACK";
    static tabs = ["TRACK", "CHAIN", "COMMON"];

    constructor() {
        super();
        this.title = "Track";
        this.size = this.computeSize();
        
        // Indigo theme for container track
        this.color = "#4f46e5";
        this.bgcolor = "#4f46e5";
        this.boxcolor = "#4338ca";
        
        this.properties = {
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: "global",
            target_bpm: 120,
            total_bars: "global",
            scope_mode: "full",
            scope_window: 0.0,
            scope_gain: 1.0,
            color: "#4f46e5",
            icon: "mixer",
            shape: "diamond"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    override updateProperty(key: string, value: any): void {
        if (key !== 'bpm' && key !== 'target_bpm') {
            super.updateProperty(key, value);
            return;
        }

        // `bpm` is the track's scope setting ("global" or a local number).
        // `target_bpm` is the resolved numeric value maintained by the graph.
        super.updateProperty('bpm', value);
    }

    override drawVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const isPreviewTarget = this.id === (window as any).activeRamPreviewNodeId
            || ((window as any).activeRamPreviewNodeId == null && Boolean(this.properties?.is_main_preview));

        const isPlaying = Boolean(telemetry?.isPlaying);
        const scopeMode = (this.properties?.scope_mode || 'full') as 'full' | 'drawn' | 'scrolled';
        const customWindow = Number(this.properties?.scope_window) || 0;
        const totalBars = Number(this.properties?.total_bars) || 4;
        const bpm = Number(this.properties?.target_bpm) || 120;
        const autoTrackWindow = totalBars * 4 * (60 / bpm);
        const scopeWindow = customWindow > 0 ? customWindow : autoTrackWindow;
        const scopeGain = Number(this.properties?.scope_gain) || 1.0;

        const manifestStem = (this as any).manifestStemBuffer as AudioBuffer | undefined;
        const masterBuf = isPreviewTarget ? ((window as any).activeRamPreviewBuffer as AudioBuffer | undefined) : undefined;
        const displayBuffer = manifestStem || this.audioBuffer || masterBuf;

        this.waveformRenderer.setOptions({
            scopeMode: isPlaying ? scopeMode : 'full',
            scopeWindow,
            scopeGain
        });
        const bufferedProgress = (this as any).bufferedProgress != null ? (this as any).bufferedProgress : 1.0;
        const isInvalidated = Boolean((this as any).isInvalidated);
        this.waveformRenderer.setSignal({
            buffer: displayBuffer,
            duration: displayBuffer?.duration || autoTrackWindow || (telemetry?.duration || 0),
            accentColor: this.nodeColor,
            bufferedProgress,
            isInvalidated
        });

        this.waveformRenderer.render(ctx, bounds, telemetry);
    }

    override onVisualizationToggled(enabled: boolean): void {
        if (enabled && !this.audioBuffer && !(window as any).activeRamPreviewBuffer) {
            window.dispatchEvent(new CustomEvent('preview-node', {
                detail: { nodeId: this.id }
            }));
        }
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
