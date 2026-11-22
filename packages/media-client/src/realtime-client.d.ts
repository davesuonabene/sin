export interface RealtimeTelemetry {
    playhead_sec: number;
    duration_sec: number;
    bpm: number;
    sample_rate: number;
    is_playing: boolean;
    loop_enabled: boolean;
    audition_active: boolean;
    master_peak_l: number;
    master_peak_r: number;
    master_rms_l: number;
    master_rms_r: number;
    bus_peaks: Record<string, number>;
    scope?: number[] | null;
}

export interface RealtimePlanLoadedResult {
    ok: boolean;
    aborted?: boolean;
    error?: string;
    duration_sec?: number;
    sample_rate?: number;
    bpm?: number;
    bus_ids?: string[];
    manifest?: { nodes: Record<string, any> };
    master_peaks?: number[];
    bus_peaks?: Record<string, number[]>;
    bus_waveforms?: Record<string, number[]>;
    pack_ms?: number;
}

export interface RealtimeMasterPeaks {
    duration_sec: number;
    master_peaks: number[];
    bus_peaks?: Record<string, number[]>;
}

export interface RealtimeStatus {
    connected: boolean;
    available: boolean;
    sampleRate: number;
}

export class RealtimeAudioClient {
    wsPath: string;
    ownerId: string;
    connected: boolean;
    available: boolean;
    sampleRate: number;
    lastTelemetry: RealtimeTelemetry;

    constructor(wsPath: string, options?: { ownerId?: string | null });
    connect(): Promise<boolean>;
    disconnect(): void;
    loadCanonical(payload: {
        graph: any;
        projectId?: number | null;
        snapshot?: any;
        transientOverrides?: any;
        workspace?: any;
        soloIds?: string[] | null;
        signal?: AbortSignal | null;
    }): Promise<RealtimePlanLoadedResult>;
    loadNodeModel(payload: {
        model: any;
        computePeaks?: boolean;
        peakColumns?: number;
        signal?: AbortSignal | null;
    }): Promise<RealtimePlanLoadedResult>;
    previewItem(itemId: number, opts?: { play?: boolean; signal?: AbortSignal | null }): Promise<RealtimePlanLoadedResult & { load_ms?: number; is_playing?: boolean; playhead_sec?: number }>;
    previewFile(
        filepath: string,
        opts?: { play?: boolean; computePeaks?: boolean; peakColumns?: number; signal?: AbortSignal | null }
    ): Promise<RealtimePlanLoadedResult & { load_ms?: number; is_playing?: boolean; playhead_sec?: number }>;
    setParam(nodeId: string | number, param: string, value: number, rampMs?: number): boolean;
    setStageParam(nodeId: string | number, stageIndex: number, paramIndex: number, value: number, rampMs?: number): boolean;
    setStageEnabled(nodeId: string | number, stageIndex: number, enabled: boolean): boolean;
    setTransport(opts: {
        playing: boolean;
        seekSec?: number;
        bpm?: number;
        loopStartSec?: number;
        loopEndSec?: number;
        loop?: boolean;
    }): boolean;
    setAudition(opts: {
        active: boolean;
        nodeId?: string | null;
        startSec?: number;
        endSec?: number;
    }): boolean;
    release(): boolean;
    onTelemetry(cb: (tel: RealtimeTelemetry) => void): () => void;
    onPlanLoaded(cb: (res: RealtimePlanLoadedResult) => void): () => void;
    onMasterPeaks(cb: (res: RealtimeMasterPeaks) => void): () => void;
    onStatusChange(cb: (status: RealtimeStatus) => void): () => void;
}
