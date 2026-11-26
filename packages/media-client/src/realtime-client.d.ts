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
    bus_rms?: Record<string, number>;
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
    processor_statuses?: Record<string, any>;
    tiled?: boolean;
    has_peak_pyramid?: boolean;
    pack_ms?: number;
}

export interface RealtimeMasterPeaks {
    duration_sec: number;
    master_peaks: number[];
    bus_peaks?: Record<string, number[]>;
    peak_tiers?: number[];
    has_peak_pyramid?: boolean;
    coverage?: {
        num_tiles: number;
        tile_sec: number;
        fast_tiles: number;
        ml_tiles: number;
        stale_tiles: number;
    } | null;
}

export interface RealtimeTileUpdate {
    type: 'tile_update';
    tile_index?: number;
    num_tiles?: number;
    start_sec?: number;
    end_sec?: number;
    duration_sec: number;
    tier?: number;
    stale?: boolean;
    stale_all?: boolean;
    clear_all?: boolean;
    peaks?: number[];
    coverage?: {
        num_tiles: number;
        tile_sec: number;
        fast_tiles: number;
        ml_tiles: number;
        stale_tiles: number;
    };
}

export interface RealtimePeaksViewport {
    ok: boolean;
    start_sec?: number;
    end_sec?: number;
    duration_sec?: number;
    peaks?: number[];
    tiers?: number[];
    coverage?: RealtimeTileUpdate['coverage'] | null;
}

export interface RealtimeEngineSettings {
    ok?: boolean;
    wait_for_fx: boolean;
    tile_sec?: number;
    default_precook_sec?: number;
    cache_stats?: {
        ram_used_mb: number;
        ram_budget_mb: number;
        disk_used_mb: number;
        disk_budget_gb: number;
        ram_entries: number;
        disk_entries: number;
    };
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
    cookNode(nodeId: string | number, model?: any): Promise<RealtimePlanLoadedResult>;
    cancelCook(nodeId: string | number): boolean;
    cookFullTrack(nodeId: string | number, enable?: boolean): Promise<{ ok: boolean }>;
    updateProcessorParam(opts: { nodeId: string | number; key: string; value: any; commit?: boolean }): boolean;
    queryPeaks(opts: { startSec: number; endSec: number; columns?: number; signal?: AbortSignal | null }): Promise<RealtimePeaksViewport>;
    setEngineSettings(settings: { wait_for_fx?: boolean; tile_ram_mb?: number; dsp_cache_max_gb?: number; clear_tile_cache?: boolean }): Promise<RealtimeEngineSettings>;
    getEngineSettings(): Promise<RealtimeEngineSettings>;
    release(): boolean;
    onTelemetry(cb: (tel: RealtimeTelemetry) => void): () => void;
    onPlanLoaded(cb: (res: RealtimePlanLoadedResult) => void): () => void;
    onMasterPeaks(cb: (res: RealtimeMasterPeaks) => void): () => void;
    onTileUpdate(cb: (msg: RealtimeTileUpdate) => void): () => void;
    onEngineSettings(cb: (msg: RealtimeEngineSettings) => void): () => void;
    onProcessorStatus(cb: (msg: Record<string, any>) => void): () => void;
    onPlanHotSwapped(cb: (msg: RealtimePlanLoadedResult & { node_id?: string; stage?: string }) => void): () => void;
    onModelDownload(cb: (msg: Record<string, any>) => void): () => void;
    onStatusChange(cb: (status: RealtimeStatus) => void): () => void;
}
