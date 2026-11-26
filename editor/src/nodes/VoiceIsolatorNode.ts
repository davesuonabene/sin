import { LiteGraph } from 'litegraph.js';
import { AudioProcessorNode } from './AudioProcessorNode.ts';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { type RenderBox, type SignalTelemetry } from '../../../packages/iride/src/index.ts';

export class VoiceIsolatorNode extends AudioProcessorNode {
    static override readonly processorParamKeys: readonly string[] = [
        'voice_db',
        'reverb_db',
        'ambience_db',
        'reverb_sensitivity',
        'mask_sharpness',
        'backend',
        'solo_stem',
        'mute_voice',
        'mute_reverb',
        'mute_ambience',
        'cook_mode',
        'precook_window_sec',
        'mix',
        'bypass',
    ];

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'ISOLATOR',
                label: 'Voice Isolator',
                sections: [
                    { type: 'voice_isolator_panel' },
                    {
                        type: 'fields',
                        title: 'Parameters',
                        fields: [
                            'ambience_db',
                            'voice_db',
                            'reverb_db',
                            'reverb_sensitivity',
                            'mask_sharpness',
                            'backend',
                            'solo_stem',
                            'cook_mode',
                            'precook_window_sec',
                            'mix',
                            'bypass',
                        ],
                    },
                ],
            },
            {
                id: 'CHAIN',
                label: 'FX Chain',
                sections: [{ type: 'fx_chain', chainKey: 'chain' }],
            },
            {
                id: 'EXPORT',
                label: 'Export',
                sections: [{ type: 'export_panel' }],
            },
            {
                id: 'COMMON',
                label: 'Common',
                sections: [{ type: 'appearance' }, { type: 'info_table' }],
            },
        ],
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Voice Isolator', tab: 'COMMON' },
        { key: 'ambience_db', label: 'Ambience', type: 'db', default: 0.0, min: -60, max: 12, step: 0.5, unit: 'dB', tab: 'ISOLATOR' },
        { key: 'voice_db', label: 'Voice (Dry)', type: 'db', default: 0.0, min: -60, max: 12, step: 0.5, unit: 'dB', tab: 'ISOLATOR' },
        { key: 'reverb_db', label: 'Voice Reverb', type: 'db', default: 0.0, min: -60, max: 12, step: 0.5, unit: 'dB', tab: 'ISOLATOR' },
        { key: 'reverb_sensitivity', label: 'DeReverb Depth', type: 'slider', default: 0.5, min: 0, max: 1, step: 0.05, tab: 'ISOLATOR' },
        { key: 'mask_sharpness', label: 'Artifact Guard', type: 'slider', default: 0.25, min: 0, max: 1, step: 0.05, tab: 'ISOLATOR' },
        {
            key: 'backend',
            label: 'Model Backend',
            type: 'select',
            default: 'fast_onnx',
            tab: 'ISOLATOR',
            options: [
                { value: 'fast_onnx', label: 'Fast ONNX (DeepFilterNet3 + WPE, ~8.5 MB)' },
                { value: 'dsp_lite', label: 'DSP Lite (Zero-Download Offline + WPE)' },
                { value: 'speech_hq', label: 'Speech HQ (MossFormer2 48k, ~210 MB)' },
                { value: 'studio_hq', label: 'Studio HQ (Mel-Band RoFormer Pack, ~860 MB)' },
            ],
        },
        {
            key: 'solo_stem',
            label: 'Solo Stem',
            type: 'select',
            default: 'none',
            options: [
                { value: 'none', label: 'None (Mix All)' },
                { value: 'ambience', label: 'Ambience' },
                { value: 'voice', label: 'Voice (Dry)' },
                { value: 'reverb', label: 'Voice Reverb' },
            ],
            tab: 'ISOLATOR',
        },
        {
            key: 'cook_mode',
            label: 'Cook Mode',
            type: 'select',
            default: 'auto',
            options: [
                { value: 'auto', label: 'Auto (500ms Debounce)' },
                { value: 'manual', label: 'Manual (Hold Stale)' },
            ],
            tab: 'ISOLATOR',
        },
        {
            key: 'precook_window_sec',
            label: 'Precook Window',
            type: 'slider',
            default: 24.0,
            min: 8,
            max: 120,
            step: 4,
            unit: 's',
            tab: 'ISOLATOR',
            description: 'Sliding lookahead window (seconds) cooked ahead of the playhead for ML inference',
        },
        { key: 'mix', label: 'Dry / Wet', type: 'slider', default: 1.0, min: 0, max: 1, step: 0.01, tab: 'ISOLATOR' },
        { key: 'bypass', label: 'Bypass', type: 'boolean', default: false, tab: 'ISOLATOR' },
        ...BaseNode.exportFields,
    ];

    static override defaultColor = '#06b6d4';
    static override defaultIcon = 'speaker';
    static override badgeLabel = 'VOICE';
    static override nodeType = 'voice_isolator';
    static override defaultTab = 'ISOLATOR';
    static override tabs = ['ISOLATOR', 'CHAIN', 'EXPORT', 'COMMON'];

    constructor() {
        super();
        this.title = 'Voice Isolator';
        this.size = this.computeSize();
        this.color = '#06b6d4';
        this.bgcolor = '#06b6d4';
        this.boxcolor = '#0e7490';

        this.properties = {
            ...this.properties,
            node_name: 'Voice Isolator',
            node_type: 'voice_isolator',
            voice_db: 0.0,
            reverb_db: 0.0,
            ambience_db: 0.0,
            reverb_sensitivity: 0.5,
            mask_sharpness: 0.25,
            backend: 'fast_onnx',
            solo_stem: 'none',
            mute_voice: false,
            mute_reverb: false,
            mute_ambience: false,
            cook_mode: 'auto',
            precook_window_sec: 24.0,
            mix: 1.0,
            bypass: false,
            visualization_type: 'loop',
            color: '#06b6d4',
            icon: 'speaker',
        };
    }

    protected override drawDedicatedVisualization(
        ctx: CanvasRenderingContext2D,
        box: RenderBox,
        telemetry?: SignalTelemetry
    ): void {
        super.drawDedicatedVisualization(ctx, box, telemetry);
        if (box.width < 110 || box.height < 32) return;

        // Compact 3-stem balance overlay strip (AMB / VOX / REV) along the bottom of the IRIDE box
        const stems: Array<{ label: string; db: number; color: string; muted: boolean }> = [
            { label: 'AMB', db: Number(this.properties?.ambience_db ?? 0), color: '#f59e0b', muted: Boolean(this.properties?.mute_ambience) },
            { label: 'VOX', db: Number(this.properties?.voice_db ?? 0), color: '#22d3ee', muted: Boolean(this.properties?.mute_voice) },
            { label: 'REV', db: Number(this.properties?.reverb_db ?? 0), color: '#a78bfa', muted: Boolean(this.properties?.mute_reverb) },
        ];
        const solo = String(this.properties?.solo_stem || 'none');
        const stripH = 11;
        const pad = 4;
        const cellW = (box.width - pad * 4) / 3;
        const y0 = box.y + box.height - stripH - 3;

        ctx.save();
        ctx.font = '600 8px "Inter", system-ui, sans-serif';
        stems.forEach((s, i) => {
            const x0 = box.x + pad + i * (cellW + pad);
            const active = solo === 'none'
                ? !s.muted
                : (solo === 'ambience' && i === 0) || (solo === 'voice' && i === 1) || (solo === 'reverb' && i === 2);
            const norm = active ? Math.max(0, Math.min(1, (s.db + 60) / 72)) : 0;

            ctx.fillStyle = 'rgba(15,23,42,0.72)';
            ctx.fillRect(x0, y0, cellW, stripH);
            ctx.fillStyle = active ? s.color : 'rgba(148,163,184,0.25)';
            ctx.globalAlpha = active ? 0.55 : 0.25;
            ctx.fillRect(x0, y0, cellW * norm, stripH);
            ctx.globalAlpha = 1;
            ctx.fillStyle = active ? '#f8fafc' : '#94a3b8';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const dbTxt = !active || s.db <= -59.9 ? '-inf' : `${s.db > 0 ? '+' : ''}${Math.round(s.db)}`;
            ctx.fillText(`${s.label} ${dbTxt}`, x0 + 3, y0 + stripH * 0.5 + 0.5);
        });
        ctx.restore();
    }
}

(VoiceIsolatorNode as any).title = 'Voice Isolator';
LiteGraph.registerNodeType('Audio/VoiceIsolator', VoiceIsolatorNode);
