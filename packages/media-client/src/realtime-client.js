/**
 * Thin same-origin WebSocket client for the in-process native `libsin_dsp`
 * real-time audio engine running on SIN (:8000) and GAIA (:8001).
 *
 * - Zero extra ports, zero WASM, zero AudioWorklet, zero browser RAM cliff.
 * - Coordinates multi-tab device playback via BroadcastChannel so pressing Play
 *   in GAIA smoothly pauses SIN (and vice versa).
 */

const TRANSPORT_CHANNEL_NAME = 'sin-realtime-audio-transport';

export class RealtimeAudioClient {
    constructor(wsPath, { ownerId = null } = {}) {
        this.wsPath = wsPath;
        this.ownerId = ownerId || `${wsPath}-${Math.random().toString(36).slice(2, 8)}`;
        this.ws = null;
        this.connected = false;
        this.available = false;
        this.sampleRate = 48000;
        this._connectPromise = null;
        this._reqCounter = 1;
        this._pendingReqs = new Map();
        this._telemetryListeners = new Set();
        this._planListeners = new Set();
        this._peaksListeners = new Set();
        this._statusListeners = new Set();
        this._processorStatusListeners = new Set();
        this._hotSwapListeners = new Set();
        this._modelDownloadListeners = new Set();
        this._tileUpdateListeners = new Set();
        this._engineSettingsListeners = new Set();
        this._reconnectTimer = null;
        this._closedExplicitly = false;
        this._selfPlaying = false;
        this.lastTelemetry = {
            playhead_sec: 0,
            duration_sec: 0,
            bpm: 120,
            sample_rate: 48000,
            is_playing: false,
            loop_enabled: false,
            audition_active: false,
            master_peak_l: 0,
            master_peak_r: 0,
            master_rms_l: 0,
            master_rms_r: 0,
            bus_peaks: {},
            bus_rms: {},
            scope: null,
        };

        this._broadcast = null;
        const endpointKey = typeof window !== 'undefined'
            ? `${window.location.origin}${this.wsPath}`
            : this.wsPath;
        this._endpointKey = endpointKey;
        if (typeof BroadcastChannel !== 'undefined') {
            try {
                this._broadcast = new BroadcastChannel(TRANSPORT_CHANNEL_NAME);
                this._broadcast.onmessage = (evt) => {
                    const data = evt?.data;
                    // Only pause if ANOTHER client on a DIFFERENT server endpoint claimed transport
                    // while THIS client instance was actively playing; sibling tabs/widgets on the
                    // same server endpoint keep shared ownership transitions on the Python host.
                    const remoteEndpoint = data?.endpoint || data?.wsPath;
                    if (
                        data
                        && data.type === 'claim'
                        && data.owner !== this.ownerId
                        && remoteEndpoint !== this._endpointKey
                        && this._selfPlaying
                    ) {
                        this.setTransport({ playing: false });
                    }
                };
            } catch {
                this._broadcast = null;
            }
        }
    }

    _wsUrl() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const path = this.wsPath.startsWith('/') ? this.wsPath : `/${this.wsPath}`;
        return `${proto}//${host}${path}`;
    }

    connect() {
        if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve(this.available);
        }
        if (this._connectPromise) {
            return this._connectPromise;
        }
        this._closedExplicitly = false;

        this._connectPromise = new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (!settled) {
                    settled = true;
                    this._connectPromise = null;
                    resolve(ok);
                }
            };

            let ws;
            try {
                ws = new WebSocket(this._wsUrl());
            } catch {
                this.connected = false;
                this.available = false;
                finish(false);
                return;
            }
            this.ws = ws;

            const timeoutId = window.setTimeout(() => finish(false), 2500);

            ws.onopen = () => {
                this.connected = true;
            };

            ws.onmessage = (evt) => {
                let msg;
                try {
                    msg = JSON.parse(evt.data);
                } catch {
                    return;
                }
                if (!msg || typeof msg !== 'object') return;

                if (msg.type === 'hello') {
                    window.clearTimeout(timeoutId);
                    this.available = Boolean(msg.available);
                    if (msg.sample_rate) this.sampleRate = Number(msg.sample_rate);
                    this._emitStatus();
                    finish(this.available);
                    return;
                }

                if (msg.type === 'telemetry') {
                    this.lastTelemetry = {
                        ...this.lastTelemetry,
                        ...msg,
                    };
                    if (!msg.is_playing) {
                        this._selfPlaying = false;
                    }
                    for (const cb of this._telemetryListeners) {
                        try { cb(this.lastTelemetry); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'master_peaks') {
                    for (const cb of this._peaksListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'processor_status') {
                    for (const cb of this._processorStatusListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'plan_hot_swapped') {
                    for (const cb of this._hotSwapListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'model_download') {
                    for (const cb of this._modelDownloadListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'tile_update') {
                    for (const cb of this._tileUpdateListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                    return;
                }

                if (msg.type === 'engine_settings') {
                    for (const cb of this._engineSettingsListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                }

                if (msg.type === 'plan_loaded') {
                    if (Number.isFinite(msg.duration_sec)) {
                        this.lastTelemetry = {
                            ...this.lastTelemetry,
                            duration_sec: Number(msg.duration_sec),
                            bpm: Number(msg.bpm || this.lastTelemetry.bpm),
                        };
                    }
                    for (const cb of this._planListeners) {
                        try { cb(msg); } catch { /* ignore */ }
                    }
                }

                if (msg.req_id != null && this._pendingReqs.has(msg.req_id)) {
                    const entry = this._pendingReqs.get(msg.req_id);
                    this._pendingReqs.delete(msg.req_id);
                    window.clearTimeout(entry.timer);
                    entry.resolve(msg);
                }
            };

            ws.onerror = () => {
                window.clearTimeout(timeoutId);
                finish(false);
            };

            ws.onclose = () => {
                window.clearTimeout(timeoutId);
                this.connected = false;
                this.ws = null;
                this.lastTelemetry = { ...this.lastTelemetry, is_playing: false };
                for (const [, entry] of this._pendingReqs) {
                    window.clearTimeout(entry.timer);
                    entry.resolve({ ok: false, error: 'WebSocket closed' });
                }
                this._pendingReqs.clear();
                this._emitStatus();
                finish(false);

                if (!this._closedExplicitly && !this._reconnectTimer) {
                    this._reconnectTimer = window.setTimeout(() => {
                        this._reconnectTimer = null;
                        if (!this._closedExplicitly) {
                            void this.connect();
                        }
                    }, 1500);
                }
            };
        });

        return this._connectPromise;
    }

    disconnect() {
        this._closedExplicitly = true;
        if (this._reconnectTimer) {
            window.clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            try {
                if (this._selfPlaying && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'set_transport', playing: false }));
                }
                this.ws.close();
            } catch { /* ignore */ }
            this.ws = null;
        }
        this._selfPlaying = false;
        this.connected = false;
        if (this._broadcast) {
            try { this._broadcast.close(); } catch { /* ignore */ }
            this._broadcast = null;
        }
    }

    _sendFireAndForget(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    async _sendRequest(payload, timeoutMs = 15000, signal = null) {
        if (signal?.aborted) {
            return { ok: false, aborted: true };
        }
        const ok = await this.connect();
        if (signal?.aborted) {
            return { ok: false, aborted: true };
        }
        if (!ok || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return { ok: false, error: 'Realtime engine unavailable' };
        }
        const reqId = this._reqCounter++;
        return new Promise((resolve) => {
            const onAbort = () => {
                if (this._pendingReqs.has(reqId)) {
                    const entry = this._pendingReqs.get(reqId);
                    this._pendingReqs.delete(reqId);
                    window.clearTimeout(entry.timer);
                    resolve({ ok: false, aborted: true });
                }
            };
            const timer = window.setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                this._pendingReqs.delete(reqId);
                resolve({ ok: false, error: 'Realtime request timeout' });
            }, timeoutMs);
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this._pendingReqs.set(reqId, {
                timer,
                resolve: (msg) => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve(msg);
                },
            });
            this._sendFireAndForget({ ...payload, req_id: reqId });
        });
    }

    _claimTransport() {
        if (this._broadcast) {
            try {
                this._broadcast.postMessage({
                    type: 'claim',
                    owner: this.ownerId,
                    wsPath: this.wsPath,
                    endpoint: this._endpointKey,
                });
            } catch { /* ignore */ }
        }
    }

    loadCanonical({ graph, projectId = null, snapshot = null, transientOverrides = null, workspace = null, soloIds = null, signal = null }) {
        return this._sendRequest({
            type: 'load_canonical',
            graph,
            project_id: projectId,
            snapshot,
            transient_overrides: transientOverrides,
            workspace,
            solo_ids: soloIds,
        }, 15000, signal);
    }

    loadNodeModel({ model, computePeaks = true, peakColumns = 512, signal = null }) {
        return this._sendRequest({
            type: 'load_node_model',
            model,
            compute_peaks: computePeaks,
            peak_columns: peakColumns,
        }, 15000, signal);
    }

    previewItem(itemId, { play = true, signal = null } = {}) {
        if (!this.available) return Promise.resolve({ ok: false, error: 'Realtime engine unavailable' });
        if (play) {
            if (!this._selfPlaying) this._claimTransport();
            this._selfPlaying = true;
        } else {
            this._selfPlaying = false;
        }
        return this._sendRequest({
            type: 'preview_item',
            item_id: Number(itemId),
            play: Boolean(play),
        }, 5000, signal);
    }

    previewFile(filepath, { play = true, computePeaks = false, peakColumns = 512, signal = null } = {}) {
        if (!this.available) return Promise.resolve({ ok: false, error: 'Realtime engine unavailable' });
        if (play) {
            if (!this._selfPlaying) this._claimTransport();
            this._selfPlaying = true;
        } else {
            this._selfPlaying = false;
        }
        return this._sendRequest({
            type: 'preview_file',
            filepath: String(filepath || ''),
            play: Boolean(play),
            compute_peaks: Boolean(computePeaks),
            peak_columns: Number(peakColumns),
        }, 5000, signal);
    }

    setParam(nodeId, param, value, rampMs = 5.0) {
        if (!this.available) return false;
        return this._sendFireAndForget({
            type: 'set_param',
            node_id: String(nodeId),
            param: String(param),
            value: Number(value),
            ramp_ms: Number(rampMs),
        });
    }

    setStageParam(nodeId, stageIndex, paramIndex, value, rampMs = 5.0) {
        if (!this.available) return false;
        return this._sendFireAndForget({
            type: 'set_stage_param',
            node_id: String(nodeId),
            stage_index: Number(stageIndex),
            param_index: Number(paramIndex),
            value: Number(value),
            ramp_ms: Number(rampMs),
        });
    }

    setStageEnabled(nodeId, stageIndex, enabled) {
        if (!this.available) return false;
        return this._sendFireAndForget({
            type: 'set_stage_enabled',
            node_id: String(nodeId),
            stage_index: Number(stageIndex),
            enabled: Boolean(enabled),
        });
    }

    setTransport({ playing, seekSec = -1, bpm = 0, loopStartSec = 0, loopEndSec = 0, loop = false }) {
        if (!this.available) return false;
        const nextPlaying = Boolean(playing);
        if (nextPlaying && !this._selfPlaying) this._claimTransport();
        this._selfPlaying = nextPlaying;
        this.lastTelemetry = { ...this.lastTelemetry, is_playing: nextPlaying };
        if (seekSec >= 0) {
            this.lastTelemetry.playhead_sec = Number(seekSec);
        }
        return this._sendFireAndForget({
            type: 'set_transport',
            playing: nextPlaying,
            seek_sec: Number(seekSec),
            bpm: Number(bpm),
            loop_start_sec: Number(loopStartSec),
            loop_end_sec: Number(loopEndSec),
            loop: Boolean(loop),
        });
    }

    setAudition({ active, nodeId = null, startSec = 0, endSec = 0 }) {
        if (!this.available) return false;
        const nextActive = Boolean(active);
        if (nextActive && !this._selfPlaying) this._claimTransport();
        this._selfPlaying = nextActive;
        return this._sendFireAndForget({
            type: 'set_audition',
            active: nextActive,
            node_id: nodeId ? String(nodeId) : null,
            start_sec: Number(startSec),
            end_sec: Number(endSec),
        });
    }

    release() {
        return this._sendFireAndForget({ type: 'stop_and_release' });
    }

    onTelemetry(cb) {
        this._telemetryListeners.add(cb);
        return () => this._telemetryListeners.delete(cb);
    }

    onPlanLoaded(cb) {
        this._planListeners.add(cb);
        return () => this._planListeners.delete(cb);
    }

    onMasterPeaks(cb) {
        this._peaksListeners.add(cb);
        return () => this._peaksListeners.delete(cb);
    }

    cookNode(nodeId, model = null) {
        return this._sendRequest({
            type: 'cook_node',
            node_id: String(nodeId),
            ...(model ? { model } : {}),
        }, 30000);
    }

    cancelCook(nodeId) {
        return this._sendFireAndForget({
            type: 'cancel_cook',
            node_id: String(nodeId),
        });
    }

    cookFullTrack(nodeId, enable = true) {
        return this._sendRequest({
            type: 'cook_full_track',
            node_id: String(nodeId),
            enable: Boolean(enable),
        }, 5000);
    }

    updateProcessorParam({ nodeId, key, value, commit = true }) {
        if (!this.available) return false;
        return this._sendFireAndForget({
            type: 'update_processor_param',
            node_id: String(nodeId),
            key: String(key),
            value,
            commit: Boolean(commit),
        });
    }

    queryPeaks({ startSec, endSec, columns = 512, signal = null }) {
        return this._sendRequest({
            type: 'query_peaks',
            start_sec: Number(startSec),
            end_sec: Number(endSec),
            columns: Number(columns),
        }, 5000, signal);
    }

    setEngineSettings(settings) {
        return this._sendRequest({
            type: 'set_engine_settings',
            settings: settings || {},
        }, 5000);
    }

    getEngineSettings() {
        return this._sendRequest({
            type: 'get_engine_settings',
        }, 5000);
    }

    onTileUpdate(cb) {
        this._tileUpdateListeners.add(cb);
        return () => this._tileUpdateListeners.delete(cb);
    }

    onEngineSettings(cb) {
        this._engineSettingsListeners.add(cb);
        return () => this._engineSettingsListeners.delete(cb);
    }

    onProcessorStatus(cb) {
        this._processorStatusListeners.add(cb);
        return () => this._processorStatusListeners.delete(cb);
    }

    onPlanHotSwapped(cb) {
        this._hotSwapListeners.add(cb);
        return () => this._hotSwapListeners.delete(cb);
    }

    onModelDownload(cb) {
        this._modelDownloadListeners.add(cb);
        return () => this._modelDownloadListeners.delete(cb);
    }

    onStatusChange(cb) {
        this._statusListeners.add(cb);
        return () => this._statusListeners.delete(cb);
    }

    _emitStatus() {
        const snap = { connected: this.connected, available: this.available, sampleRate: this.sampleRate };
        for (const cb of this._statusListeners) {
            try { cb(snap); } catch { /* ignore */ }
        }
    }
}
