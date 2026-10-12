import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import { WaveformRenderer, type RenderBox, type SignalTelemetry } from '../../../packages/iride/src/index.ts';
import { globalAudioScheduler } from '../audioScheduler';

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

    override onGlobalParametersChanged(parameters: Record<string, any>): void {
        super.onGlobalParametersChanged(parameters);
        if (this.properties?.bpm === 'global' && parameters.bpm) {
            this.properties.target_bpm = parameters.bpm;
        }
        this.setDirtyCanvas?.(true, true);
    }

    override drawVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const isPreviewTarget = this.id === (window as any).activeRamPreviewNodeId
            || ((window as any).activeRamPreviewNodeId == null && Boolean(this.properties?.is_main_preview));

        const getGlobal = (window as any).getGlobalParameter;
        const globalBars = typeof getGlobal === 'function' ? Number(getGlobal('total_bars')) : 4;
        const globalBpm = typeof getGlobal === 'function' ? Number(getGlobal('bpm')) : 120;

        const totalBarsSetting = this.properties?.total_bars;
        const totalBars = (totalBarsSetting === 'global' || !Number.isFinite(Number(totalBarsSetting)))
            ? (Number.isFinite(globalBars) && globalBars > 0 ? globalBars : 4)
            : Math.max(0.25, Number(totalBarsSetting));

        const bpmSetting = this.properties?.bpm;
        const resolvedBpm = (bpmSetting === 'global' || !Number.isFinite(Number(bpmSetting)))
            ? (Number(this.properties?.target_bpm) || (Number.isFinite(globalBpm) && globalBpm > 0 ? globalBpm : 120))
            : Math.max(20, Number(bpmSetting));

        const autoTrackWindow = totalBars * 4 * (60 / resolvedBpm);

        const schedulerBuf = isPreviewTarget ? globalAudioScheduler.getFullAudioBuffer() : undefined;
        const masterBuf = isPreviewTarget ? ((window as any).activeRamPreviewBuffer as AudioBuffer | undefined) : undefined;
        const manifestStem = (this as any).manifestStemBuffer as AudioBuffer | undefined;
        // For the active preview target, the live scheduler buffer is authoritative
        const displayBuffer = isPreviewTarget
            ? (schedulerBuf || masterBuf || manifestStem || this.audioBuffer)
            : (manifestStem || this.audioBuffer || schedulerBuf || masterBuf);

        const bufferedProgress = (this as any).bufferedProgress != null
            ? (this as any).bufferedProgress
            : (isPreviewTarget ? globalAudioScheduler.getBufferedProgress() : 1.0);
        const isInvalidated = Boolean((this as any).isInvalidated);

        // Fixed track window duration ensures the buffer fills from left to right without stretching
        const expectedDuration = autoTrackWindow > 0
            ? autoTrackWindow
            : ((this as any).manifestStemDuration || telemetry?.duration || displayBuffer?.duration || 0);

        let playbackProgress: number | undefined;
        if (telemetry && telemetry.isPlaying && expectedDuration > 0) {
            const curTime = ((telemetry.time % expectedDuration) + expectedDuration) % expectedDuration;
            playbackProgress = curTime / expectedDuration;
        }

        this.waveformRenderer.setOptions({
            scopeMode: 'full'
        });
        this.waveformRenderer.setSignal({
            buffer: displayBuffer,
            duration: expectedDuration,
            accentColor: this.nodeColor,
            bufferedProgress,
            isInvalidated,
            playbackProgress
        });

        this.waveformRenderer.render(ctx, bounds, telemetry);
    }

    override onVisualizationToggled(_enabled: boolean): void {
        // Toggling visual feedback should only update presentation state without hijacking master playback.
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
