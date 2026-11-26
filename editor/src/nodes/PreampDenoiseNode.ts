import { LiteGraph } from 'litegraph.js';
import { AudioProcessorNode } from './AudioProcessorNode.ts';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';

export const PREAMP_DENOISE_PROFILE_DEFAULT_TOPOLOGY: Record<string, string> = {
    generic_adc: 'mono_or_dual_mono',
    usb_interface: 'mono_or_dual_mono',
    zoom_h4: 'coincident_xy_stereo',
    zoom_h4n: 'coincident_xy_stereo',
    zoom_h4n_pro: 'coincident_xy_stereo',
    zoom_h4essential: 'coincident_xy_stereo',
};

export class PreampDenoiseNode extends AudioProcessorNode {
    static override readonly processorParamKeys: readonly string[] = [
        'profile_id',
        'input_topology',
        'stft_mode',
        'reduction_db',
        'sensitivity',
        'profile_weight',
        'stereo_coherence',
        'hp_hz',
        'spur_notch',
        'psychoacoustic_preserve',
        'natural_floor',
        'output_mode',
        'noise_start',
        'noise_end',
        'cook_mode',
        'precook_window_sec',
        'mix',
        'bypass',
    ];

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'DENOISE',
                label: 'Preamp De-Noise',
                sections: [
                    { type: 'preamp_denoise_panel' },
                    {
                        type: 'fields',
                        title: 'Parameters',
                        fields: [
                            'profile_id',
                            'input_topology',
                            'stft_mode',
                            'reduction_db',
                            'sensitivity',
                            'profile_weight',
                            'stereo_coherence',
                            'hp_hz',
                            'spur_notch',
                            'psychoacoustic_preserve',
                            'natural_floor',
                            'output_mode',
                            'noise_start',
                            'noise_end',
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
        { key: 'node_name', label: 'Name', type: 'string', default: 'Preamp De-Noise', tab: 'COMMON' },
        {
            key: 'profile_id',
            label: 'Device Profile',
            type: 'select',
            default: 'generic_adc',
            tab: 'DENOISE',
            options: [
                { value: 'generic_adc', label: 'Generic Preamp / ADC Floor' },
                { value: 'usb_interface', label: 'USB Audio Interface / Soundcard' },
                { value: 'zoom_h4', label: 'Zoom H4 (Original X/Y)' },
                { value: 'zoom_h4n', label: 'Zoom H4n (X/Y Capsules)' },
                { value: 'zoom_h4n_pro', label: 'Zoom H4n Pro (X/Y Capsules)' },
                { value: 'zoom_h4essential', label: 'Zoom H4essential (32-bit X/Y)' },
            ],
            description: 'Built-in or GAIA-calibrated hardware preamp noise floor prior',
        },
        {
            key: 'input_topology',
            label: 'Input Topology',
            type: 'select',
            default: 'mono_or_dual_mono',
            tab: 'DENOISE',
            options: [
                { value: 'mono_or_dual_mono', label: 'Mono / Dual-Mono Interface' },
                { value: 'coincident_xy_stereo', label: 'Coincident X/Y Stereo' },
                { value: 'spaced_stereo', label: 'Spaced Stereo Pair' },
            ],
            description: 'Stereo MSC coherence only engages on correlated stereo mic topologies',
        },
        {
            key: 'stft_mode',
            label: 'Resolution',
            type: 'select',
            default: 'hq_dual_res',
            tab: 'DENOISE',
            options: [
                { value: 'hq_dual_res', label: 'HQ Dual-Res (4096 + 512 Transient)' },
                { value: 'fast_single_res', label: 'Fast Single-Res (2048)' },
            ],
        },
        { key: 'reduction_db', label: 'Reduction', type: 'slider', default: 12.0, min: 0, max: 36, step: 0.5, unit: 'dB', tab: 'DENOISE' },
        { key: 'sensitivity', label: 'Sensitivity', type: 'slider', default: 0.0, min: -12, max: 12, step: 0.5, unit: 'dB', tab: 'DENOISE' },
        { key: 'profile_weight', label: 'Profile Prior', type: 'slider', default: 0.7, min: 0, max: 1, step: 0.05, tab: 'DENOISE' },
        { key: 'stereo_coherence', label: 'X/Y Coherence', type: 'slider', default: 0.6, min: 0, max: 1, step: 0.05, tab: 'DENOISE' },
        { key: 'hp_hz', label: '1/f High-Pass', type: 'slider', default: 40.0, min: 0, max: 150, step: 1, unit: 'Hz', tab: 'DENOISE' },
        { key: 'spur_notch', label: 'Hum / Spur Notch', type: 'slider', default: 0.5, min: 0, max: 1, step: 0.05, tab: 'DENOISE' },
        { key: 'psychoacoustic_preserve', label: 'Bark Preserve', type: 'slider', default: 0.75, min: 0, max: 1, step: 0.05, tab: 'DENOISE' },
        { key: 'natural_floor', label: 'Natural Floor', type: 'slider', default: 0.15, min: 0, max: 1, step: 0.05, tab: 'DENOISE' },
        {
            key: 'output_mode',
            label: 'Audition',
            type: 'radio',
            default: 'denoised',
            options: [
                { value: 'denoised', label: 'Denoised' },
                { value: 'noise_only', label: 'Noise Only (Diff)' },
            ],
            tab: 'DENOISE',
        },
        { key: 'noise_start', label: 'Noise Print Start', type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'DENOISE' },
        { key: 'noise_end', label: 'Noise Print End', type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, tab: 'DENOISE' },
        {
            key: 'cook_mode',
            label: 'Cook Mode',
            type: 'select',
            default: 'auto',
            options: [
                { value: 'auto', label: 'Auto (500ms Debounce)' },
                { value: 'manual', label: 'Manual (Hold Stale)' },
            ],
            tab: 'DENOISE',
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
            tab: 'DENOISE',
            description: 'Seconds ahead of playhead prioritized before full-track background propagation',
        },
        { key: 'mix', label: 'Dry / Wet', type: 'slider', default: 1.0, min: 0, max: 1, step: 0.01, tab: 'DENOISE' },
        { key: 'bypass', label: 'Bypass', type: 'boolean', default: false, tab: 'DENOISE' },
        ...BaseNode.exportFields,
    ];

    static override defaultColor = '#14b8a6';
    static override defaultIcon = 'wave';
    static override badgeLabel = 'PREAMP';
    static override nodeType = 'preamp_denoise';
    static override defaultTab = 'DENOISE';
    static override tabs = ['DENOISE', 'CHAIN', 'EXPORT', 'COMMON'];

    constructor() {
        super();
        this.title = 'Preamp De-Noise';
        this.size = this.computeSize();
        this.color = '#14b8a6';
        this.bgcolor = '#14b8a6';
        this.boxcolor = '#0f766e';

        this.properties = {
            ...this.properties,
            node_name: 'Preamp De-Noise',
            node_type: 'preamp_denoise',
            profile_id: 'generic_adc',
            input_topology: 'mono_or_dual_mono',
            stft_mode: 'hq_dual_res',
            reduction_db: 12.0,
            sensitivity: 0.0,
            profile_weight: 0.7,
            stereo_coherence: 0.6,
            hp_hz: 40.0,
            spur_notch: 0.5,
            psychoacoustic_preserve: 0.75,
            natural_floor: 0.15,
            output_mode: 'denoised',
            noise_start: 0.0,
            noise_end: 0.0,
            cook_mode: 'auto',
            precook_window_sec: 24.0,
            mix: 1.0,
            bypass: false,
            visualization_type: 'spectrum',
            color: '#14b8a6',
            icon: 'wave',
        };
    }

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if (key === 'profile_id') {
            const mappedTopo = PREAMP_DENOISE_PROFILE_DEFAULT_TOPOLOGY[String(value || '').toLowerCase()];
            if (mappedTopo && this.properties.input_topology !== mappedTopo) {
                super.updateProperty('input_topology', mappedTopo);
            }
        }
    }
}

(PreampDenoiseNode as any).title = 'Preamp De-Noise';
LiteGraph.registerNodeType('Audio/PreampDenoise', PreampDenoiseNode);
