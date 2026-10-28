export interface RenderBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SignalTelemetry {
    time: number;             // Elapsed playback time in seconds
    duration: number;         // Master audio duration in seconds
    beat: number;             // Global beat count
    bar: number;              // Global bar count
    step: number;             // Current 16th-note step index (0-15)
    isPlaying: boolean;       // Playback transport active
    activeNodeIds?: Set<number | string>;
    realtimeScope?: Float32Array | null; // Real-time oscilloscope waveform buffer
}

export interface WaveformSignal {
    buffer?: AudioBuffer | null;
    peaks?: Float32Array | null;
    duration: number;
    cropStart?: number;       // Normalized 0.0 - 1.0
    cropEnd?: number;         // Normalized 0.0 - 1.0
    channels?: number;
    accentColor?: string;
    isTriggered?: boolean;    // Live trigger state from graph (e.g. sequencer step fired)
    triggerProgress?: number; // 0.0 - 1.0 progress through triggered hit window
    playbackProgress?: number;// Explicit normalized playhead position (0.0 - 1.0)
    bufferedProgress?: number;// Normalized RAM buffer fill front (0.0 - 1.0)
    isInvalidated?: boolean;  // True when buffer was dirtied and is refilling
}

export interface SequenceStep {
    gate: boolean;
    velocity: number;         // 0.0 - 1.0
    subdivisions?: number;    // 1, 2, 3, 4
    probability?: number;     // 0.0 - 1.0
    sampleStart?: number;     // 0.0 - 1.0
    gateLength?: number;      // 0.0 - 1.0
}

export interface SequenceSignal {
    stepCount: number;
    steps: SequenceStep[];
    stepLength?: number;      // e.g. 0.25 (16th note)
    accentColor?: string;
}

export interface ArrangementSection {
    id?: string | number;
    index: number;
    startBar: number;
    lengthBars: number;
    probability: number;      // 0.0 - 1.0
    sampleStart: number;      // 0.0 - 1.0
    quant?: string;
    label?: string;
}

export interface ArrangementSignal {
    totalBars: number;
    sections: ArrangementSection[];
    accentColor?: string;
}

export type ScopeMode = 'full' | 'drawn' | 'scrolled';

export interface RendererOptions {
    theme?: 'dark' | 'light';
    accentColor?: string;
    backgroundColor?: string;
    borderColor?: string;
    isMasterScope?: boolean;  // Toggles real-time audio oscilloscope mode during playback (legacy alias for scopeMode='drawn')
    scopeMode?: ScopeMode;    // 'full' (full stem), 'drawn' (sweep left-to-right), or 'scrolled' (continuous window scroll)
    scopeWindow?: number;     // Window size (seconds) for real-time scope (0 = auto-inherit)
    scopeSpeed?: number;      // Deprecated sweep speed multiplier
    scopeGain?: number;       // Oscilloscope amplitude gain multiplier
}

