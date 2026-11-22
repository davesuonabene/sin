import { GraphView } from '/packages/graph-view/src/GraphView.js';
import { RealtimeAudioClient } from '/packages/media-client/src/realtime-client.js';
import { formatPreciseTime } from '../transport.js';

function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function sinEditorBaseUrl() {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = window.location.hostname || '127.0.0.1';
    return `${protocol}//${host}:8000`;
}

export class SinEngine {
    constructor() {
        this.id = 'sin';
        this.label = 'SIN Node Editor';
        this.host = null;
        this.container = null;
        this.session = null;
        this.layers = [];
        this.selectedLayerIdx = 0;
        this.soloIds = new Set();
        this.activeViewMode = 'timeline'; // 'timeline' | 'graph' | 'split'

        // Timeline viewport state
        this.zoom = 1;
        this.viewOffsetRatio = 0; // 0 .. (1 - 1/zoom)
        this.overviewWaveforms = new Map(); // item_id -> waveform data
        this.detailWaveforms = new Map(); // item_id -> detailed waveform
        this.detailTimer = null;

        // Real-time native libsin_dsp client (same-origin WS on :8001)
        this.realtime = null;
        this.liveAvailable = false;
        this.liveLoaded = false;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.liveBusPeaks = {};
        this._latestTelemetry = null;
        this._telemetryRaf = null;
        this._unsubRealtime = [];
        this._unsubCue = null;
        this._lastServerPlaying = false;
        this._syncAbort = null;

        // Smooth position-buffered seek / hold-drag scrub controller
        this._seekBreathTimer = null;
        this._scrubIdlePauseTimer = null;
        this._lastSeekSentAt = 0;
        this._pendingSeek = null;
        this._seekLockUntil = 0;
        this._seekLockSec = 0;
        this._scrubCursorPos = null; // { x, y, sec } while dragging playhead

        // 2-layer offscreen waveform cache (0.2ms blit per playhead frame!)
        this._waveBackingCanvas = null;
        this._waveDirty = true;
        this._drawRaf = null;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this._graphSyncRaf = null;

        // Fallback rendered master preview state (used only if native libsin_dsp is absent)
        this.masterPreview = null;
        this.previewAudio = null;
        this.playheadSec = 0;
        this.renderingPreview = false;
        this.previewDriver = null;

        // Interactive GraphView (for Graph / Split views)
        this.graphView = null;
        this.resizeObserver = null;

        // Pointer interaction
        this.dragState = null;
        this.viewDragState = false;
        this.dirty = false;
        this.abortController = null;
        this.loadDialogCleanup = null;
    }

    mount(container, session, host) {
        this.unmount();
        this.container = container;
        this.session = session;
        this.host = host;
        this.dirty = false;
        this.abortController = new AbortController();
        this.hydrateFromSession(session);
        this.renderShell();
        this.bindEvents();
        this.registerTransport();
        this._unsubCue = window.gaiaTransport?.onCueChange?.(() => this.requestDraw(false)) || null;
        void this.loadLayerWaveforms();
        void this.initRealtimeEngine();
        if (this.activeViewMode !== 'timeline') {
            this.mountGraphView();
        }
    }

    unmount() {
        if (this.loadDialogCleanup) {
            this.loadDialogCleanup();
            this.loadDialogCleanup = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.detailTimer) {
            window.clearTimeout(this.detailTimer);
            this.detailTimer = null;
        }
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        if (this._scrubIdlePauseTimer) {
            window.clearTimeout(this._scrubIdlePauseTimer);
            this._scrubIdlePauseTimer = null;
        }
        if (this._drawRaf !== null) {
            window.cancelAnimationFrame(this._drawRaf);
            this._drawRaf = null;
        }
        if (this._graphSyncRaf !== null) {
            window.cancelAnimationFrame(this._graphSyncRaf);
            this._graphSyncRaf = null;
        }
        if (this._syncAbort) {
            this._syncAbort.abort();
            this._syncAbort = null;
        }
        for (const fn of this._unsubRealtime) {
            try { fn(); } catch { /* ignore */ }
        }
        this._unsubRealtime = [];
        if (this._unsubCue) {
            try { this._unsubCue(); } catch { /* ignore */ }
            this._unsubCue = null;
        }
        this._lastServerPlaying = false;
        if (this._telemetryRaf !== null) {
            window.cancelAnimationFrame(this._telemetryRaf);
            this._telemetryRaf = null;
        }
        this._latestTelemetry = null;
        this._waveBackingCanvas = null;
        this._waveDirty = true;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this._scrubCursorPos = null;
        this._pendingSeek = null;
        if (this.realtime) {
            try {
                this.realtime.setTransport({ playing: false });
            } catch { /* ignore */ }
            this.realtime.disconnect();
            this.realtime = null;
        }
        this.liveAvailable = false;
        this.liveLoaded = false;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.liveBusPeaks = {};
        this.stopPreviewAudio();
        if (this.previewDriver) {
            window.gaiaTransport?.clearCustomDriver?.(this.previewDriver);
            this.previewDriver = null;
        }
        this.graphView = null;
        this.overviewWaveforms.clear();
        this.detailWaveforms.clear();
        this.masterPreview = null;
        this.soloIds.clear();
        if (this.container) {
            this.container.innerHTML = '';
            this.container = null;
        }
        this.session = null;
        this.host = null;
    }

    onSessionUpdated(session) {
        this.stopPreviewAudio();
        if (this._syncAbort) {
            this._syncAbort.abort();
            this._syncAbort = null;
        }
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        if (this._scrubIdlePauseTimer) {
            window.clearTimeout(this._scrubIdlePauseTimer);
            this._scrubIdlePauseTimer = null;
        }
        if (this.realtime) {
            this.realtime.setTransport({ playing: false, seekSec: 0 });
        }
        this.liveLoaded = false;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.playheadSec = 0;
        this.masterPreview = null;
        this._waveDirty = true;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this._scrubCursorPos = null;
        this.session = session;
        this.dirty = false;
        this.hydrateFromSession(session);
        this.renderShell();
        this.bindEvents();
        this.registerTransport();
        if (this._unsubCue) {
            try { this._unsubCue(); } catch { /* ignore */ }
        }
        this._unsubCue = window.gaiaTransport?.onCueChange?.(() => this.requestDraw(false)) || null;
        void this.loadLayerWaveforms();
        void this.syncRealtimePlan();
        if (this.activeViewMode !== 'timeline') {
            this.mountGraphView();
        }
    }

    requestDraw(waveDirty = false) {
        if (waveDirty) this._waveDirty = true;
        if (this._drawRaf !== null) return;
        this._drawRaf = window.requestAnimationFrame(() => {
            this._drawRaf = null;
            this.drawTimeline();
            this.drawMasterStrip();
        });
    }

    _dispatchSeekTransport(sec, playing) {
        const dur = this.liveDurationSec || this.maxTimelineDurationSec();
        const maxSeek = playing && dur > 0.05 ? Math.max(0, dur - 0.02) : Math.max(0, dur);
        const clamped = clamp(Number(sec) || 0, 0, maxSeek);
        this._lastSeekSentAt = performance.now();
        this._pendingSeek = null;
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        this._seekLockSec = clamped;
        this._seekLockUntil = performance.now() + 130;
        this.playheadSec = clamped;
        if (this.liveAvailable && this.realtime) {
            this.livePlaying = Boolean(playing);
            this.realtime.setTransport({
                playing: Boolean(playing),
                seekSec: clamped,
                bpm: Number(this.session?.session_data?.graph?.settings?.bpm || 120),
                loop: false,
            });
        } else if (this.previewAudio) {
            this.previewAudio.currentTime = Math.min(this.previewAudio.duration || clamped, clamped);
        }
    }

    _scheduleSeekTransport(sec, playing, { immediate = false, breathMs = 45 } = {}) {
        if (immediate) {
            this._dispatchSeekTransport(sec, playing);
            return;
        }
        const elapsed = performance.now() - this._lastSeekSentAt;
        if (elapsed >= breathMs) {
            this._dispatchSeekTransport(sec, playing);
            return;
        }
        this._pendingSeek = { sec, playing };
        if (!this._seekBreathTimer) {
            this._seekBreathTimer = window.setTimeout(() => {
                this._seekBreathTimer = null;
                if (this._pendingSeek) {
                    const next = this._pendingSeek;
                    this._pendingSeek = null;
                    this._dispatchSeekTransport(next.sec, next.playing);
                }
            }, Math.max(10, breathMs - elapsed));
        }
    }

    async initRealtimeEngine() {
        if (!this.realtime) {
            this.realtime = new RealtimeAudioClient('/editor/realtime/ws', { ownerId: 'gaia-sin-timeline' });
            this._unsubRealtime.push(
                this.realtime.onStatusChange(st => {
                    this.liveAvailable = Boolean(st.available);
                    this.updateLiveEngineBadge();
                }),
                this.realtime.onTelemetry(tel => {
                    this._latestTelemetry = tel;
                    if (this._telemetryRaf === null) {
                        this._telemetryRaf = window.requestAnimationFrame(() => {
                            this._telemetryRaf = null;
                            const snap = this._latestTelemetry;
                            if (!snap) return;
                            this._latestTelemetry = null;
                            this._lastServerPlaying = Boolean(snap.is_playing);
                            const isScrubbing = Boolean(this.dragState && this.dragState.mode === 'seek');
                            const footerSeeking = Boolean(window.gaiaTransport?.isFooterSeeking?.());
                            const holdingCursor = isScrubbing || footerSeeking;
                            if (!holdingCursor) {
                                this.livePlaying = Boolean(snap.is_playing);
                            }
                            if (Number.isFinite(snap.duration_sec) && snap.duration_sec > 0) {
                                this.liveDurationSec = Number(snap.duration_sec);
                            }
                            const allowPlayheadTrack = !holdingCursor
                                || (isScrubbing && !this.dragState.moved && this.dragState.wasPlaying && snap.is_playing);
                            if (allowPlayheadTrack) {
                                const incomingSec = Number(snap.playhead_sec) || 0;
                                const withinLock = performance.now() < this._seekLockUntil
                                    && Math.abs(incomingSec - this._seekLockSec) > 0.12;
                                if (!withinLock) {
                                    this.playheadSec = incomingSec;
                                }
                            }
                            this.liveBusPeaks = snap.bus_peaks || {};
                            this.updateMixerMeters();
                            this.requestDraw(false);
                            window.gaiaTransport?.render?.();
                        });
                    }
                }),
            );
        }
        const ok = await this.realtime.connect();
        this.liveAvailable = Boolean(ok);
        this.updateLiveEngineBadge();
        if (ok) {
            await this.syncRealtimePlan();
        }
    }

    updateLiveEngineBadge() {
        const badge = this.container?.querySelector('#sin-live-engine-badge');
        const previewBtn = this.container?.querySelector('#sin-render-preview');
        if (badge) {
            if (this.liveAvailable) {
                const srK = Math.round((this.realtime?.sampleRate || 48000) / 100) / 10;
                badge.textContent = `● ${srK}k`;
                badge.classList.add('is-live');
                badge.title = `Native C++ libsin_dsp live device audio (${srK} kHz) — edits & scrubbing run in real time`;
            } else {
                badge.textContent = '○ Offline';
                badge.classList.remove('is-live');
                badge.title = 'Native libsin_dsp unavailable; using server-rendered preview fallback';
            }
        }
        if (previewBtn) {
            previewBtn.classList.toggle('hidden', this.liveAvailable);
        }
    }

    updateMixerMeters() {
        const rail = this.container?.querySelector('#sin-mixer-rail');
        if (!rail) return;
        for (let idx = 0; idx < this.layers.length; idx += 1) {
            const layer = this.layers[idx];
            const bar = rail.querySelector(`[data-mixer-meter="${idx}"]`);
            if (!bar) continue;
            const peak = Number(this.liveBusPeaks?.[layer.ch_node_id] ?? this.liveBusPeaks?.[layer.src_node_id] ?? 0);
            bar.style.width = `${Math.round(clamp(peak, 0, 1) * 100)}%`;
        }
    }

    async syncRealtimePlan(snapshotOverride = null) {
        if (!this.realtime || !this.liveAvailable || !this.session?.session_data?.graph) return false;
        if (this._syncAbort) {
            this._syncAbort.abort();
        }
        const ac = new AbortController();
        this._syncAbort = ac;
        const sdata = this.session.session_data;
        const graph = sdata.graph;
        const res = await this.realtime.loadCanonical({
            graph,
            projectId: this.session.project_id ?? null,
            snapshot: snapshotOverride,
            workspace: snapshotOverride ? null : (sdata.workspace ?? null),
            soloIds: Array.from(this.soloIds),
            signal: ac.signal,
        });
        if (ac.signal.aborted || res?.aborted) return false;
        if (res?.ok) {
            this.liveLoaded = true;
            if (Number.isFinite(res.duration_sec) && res.duration_sec > 0) {
                this.liveDurationSec = Number(res.duration_sec);
            }
            this.updateHostTrackInfo();
            window.gaiaTransport?.render?.();
            return true;
        }
        return false;
    }

    hydrateFromSession(session) {
        this.layers = Array.isArray(session?.layers) ? structuredClone(session.layers) : [];
        if (this.selectedLayerIdx >= this.layers.length) {
            this.selectedLayerIdx = 0;
        }
        this.soloIds.clear();
        this.playheadSec = 0;
        this.zoom = 1;
        this.viewOffsetRatio = 0;
    }

    isDirty() {
        return this.dirty;
    }

    clearDirty() {
        this.dirty = false;
    }

    markDirty() {
        this.dirty = true;
        this.invalidatePreview();
        this.host?.setDirty?.(true);
    }

    invalidatePreview() {
        this.masterPreview = null;
        this.drawMasterStrip();
    }

    getSavePayload() {
        const sdata = this.session?.session_data || {};
        return {
            engine: 'sin',
            data: {
                graph: sdata.graph || { format: 'sin-graph', version: 1, settings: { bpm: 120, total_bars: 'auto' }, output: 'master', nodes: [{ id: 'master', type: 'track', role: 'master', properties: { node_name: 'Master Output', total_bars: 'auto', chain: [] } }], connections: [] },
                workspace: sdata.workspace ?? null,
                snapshots: Array.isArray(sdata.snapshots) ? sdata.snapshots : [],
                active_snapshot_id: sdata.active_snapshot_id ?? null,
            },
        };
    }

    handleTargetSelect(targetId) {
        if (!targetId) return;
        const parsed = Number(String(targetId).replace(/^item:/, ''));
        const idx = this.layers.findIndex(l => Number(l.item_id) === parsed);
        if (idx >= 0) {
            this.selectLayer(idx);
        }
        if (this.graphView && typeof this.graphView.highlightNode === 'function') {
            this.graphView.highlightNode(`ch-${parsed}`);
        }
    }

    selectedLayer() {
        return this.layers[this.selectedLayerIdx] || this.layers[0] || null;
    }

    selectedSnapshot() {
        const sdata = this.session?.session_data || {};
        const sid = sdata.active_snapshot_id;
        if (!sid) return null;
        return (sdata.snapshots || []).find(s => s && s.id === sid) || null;
    }

    realTimelineDurationSec() {
        let maxDur = 0;
        for (const layer of this.layers) {
            const wf = this.overviewWaveforms.get(layer.item_id);
            const dur = Number(layer.duration_seconds) || Number(wf?.duration_seconds) || 0;
            if (dur > maxDur) maxDur = dur;
        }
        if (this.masterPreview?.duration_seconds) {
            maxDur = Math.max(maxDur, Number(this.masterPreview.duration_seconds));
        }
        return maxDur;
    }

    maxTimelineDurationSec() {
        return Math.max(0.01, this.realTimelineDurationSec() || 1);
    }

    updateHostTrackInfo() {
        const layer = this.selectedLayer();
        const parts = [];
        if (this.layers.length > 1) parts.push(`${this.layers.length} tracks`);
        if (layer?.sample_rate) parts.push(`${Math.round(Number(layer.sample_rate) / 100) / 10} kHz`);
        else if (this.realtime?.sampleRate) parts.push(`${Math.round(Number(this.realtime.sampleRate) / 100) / 10} kHz`);
        const dur = this.liveDurationSec || this.realTimelineDurationSec();
        if (dur > 0) parts.push(formatPreciseTime(dur));
        this.host?.setTrackInfo?.(parts.join(' · '));
    }

    visibleTimeWindow() {
        const total = this.maxTimelineDurationSec();
        const span = total / clamp(this.zoom, 1, 64);
        const maxOffset = Math.max(0, 1 - span / total);
        this.viewOffsetRatio = clamp(this.viewOffsetRatio, 0, maxOffset);
        const startSec = this.viewOffsetRatio * total;
        return { startSec, endSec: startSec + span, totalSec: total };
    }

    effectivelyMuted(layer) {
        if (this.soloIds.size > 0) {
            return !this.soloIds.has(layer.src_node_id);
        }
        return Boolean(layer.muted);
    }

    applyLayerControlToGraph(layer) {
        const graph = this.session?.session_data?.graph;
        if (!graph || !Array.isArray(graph.nodes)) return;
        const srcNode = graph.nodes.find(n => n.id === layer.src_node_id);
        if (srcNode) {
            const props = srcNode.properties = srcNode.properties || {};
            props.crop_start = roundRatio(layer.crop_start);
            props.crop_end = roundRatio(layer.crop_end);
        }
        const chNode = graph.nodes.find(n => n.id === layer.ch_node_id);
        if (chNode) {
            const preLin = 10 ** (Number(layer.pre_gain_db || 0) / 20);
            const props = chNode.properties = chNode.properties || {};
            props.chain = [
                { id: 'pre', name: 'Pre-Gain', type: 'gain', enabled: true, params: { gain: preLin } },
                { id: 'fader', name: 'Fader', type: 'gain', enabled: true, params: { gain: clamp(Number(layer.volume ?? 1), 0, 1) } },
                { id: 'mute', name: 'Mute', type: 'gain', enabled: Boolean(layer.muted), params: { gain: 0.0 } },
            ];
        }
        if (this.graphView && this._graphSyncRaf === null) {
            this._graphSyncRaf = window.requestAnimationFrame(() => {
                this._graphSyncRaf = null;
                if (this.graphView && this.session?.session_data?.graph) {
                    this.graphView.setGraph(this.session.session_data.graph, this.session.positions || {});
                }
            });
        }
    }

    buildTransientOverrides() {
        const overrides = {};
        for (const layer of this.layers) {
            if (layer.src_node_id) {
                overrides[layer.src_node_id] = {
                    crop_start: roundRatio(layer.crop_start),
                    crop_end: roundRatio(layer.crop_end),
                };
            }
            if (layer.ch_node_id) {
                const preLin = 10 ** (Number(layer.pre_gain_db || 0) / 20);
                overrides[layer.ch_node_id] = {
                    chain: [
                        { id: 'pre', name: 'Pre-Gain', type: 'gain', enabled: true, params: { gain: preLin } },
                        { id: 'fader', name: 'Fader', type: 'gain', enabled: true, params: { gain: clamp(Number(layer.volume ?? 1), 0, 1) } },
                        { id: 'mute', name: 'Mute', type: 'gain', enabled: this.effectivelyMuted(layer), params: { gain: 0.0 } },
                    ],
                };
            }
        }
        return overrides;
    }

    stopPreviewAudio(resetPlayhead = false) {
        if (this.previewAudio) {
            try {
                this.previewAudio.pause();
                this.previewAudio.removeAttribute('src');
            } catch {
                // Ignore
            }
            this.previewAudio = null;
        }
        if (resetPlayhead) {
            this.playheadSec = 0;
            this.drawTimeline();
            this.drawMasterStrip();
        }
    }

    registerTransport() {
        const self = this;
        this.previewDriver = {
            getState() {
                if (self.liveAvailable && self.realtime) {
                    const duration = self.liveDurationSec || self.realTimelineDurationSec();
                    const selected = self.selectedLayer();
                    return {
                        hasPlayback: Boolean(self.layers.length || self.session?.has_workspace),
                        playing: Boolean(self.livePlaying),
                        currentTime: self.playheadSec,
                        duration,
                        targetLabel: selected?.label || self.session?.title || 'SIN Live',
                        targets: self.session?.targets || [],
                        activeTargetId: selected ? `item:${selected.item_id}` : null,
                    };
                }
                const audio = self.previewAudio;
                const duration = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
                    ? audio.duration
                    : (self.masterPreview?.duration_seconds || self.realTimelineDurationSec());
                const currentTime = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : self.playheadSec;
                const playing = Boolean(audio && !audio.paused && !audio.ended);
                const selected = self.selectedLayer();
                return {
                    hasPlayback: Boolean(self.layers.length || self.session?.has_workspace || self.masterPreview),
                    playing,
                    currentTime,
                    duration,
                    targetLabel: selected?.label || self.session?.title || 'SIN Preview',
                    targets: self.session?.targets || [],
                    activeTargetId: selected ? `item:${selected.item_id}` : null,
                };
            },
            async playPause() {
                const cueOn = Boolean(window.gaiaTransport?.isCueEnabled?.());
                const dur = self.liveDurationSec || self.maxTimelineDurationSec();
                const cueSec = clamp(Number(window.gaiaTransport?.getCuePoint?.() || 0), 0, Math.max(0, dur));
                if (self.liveAvailable && self.realtime) {
                    if (!self.liveLoaded) {
                        const ok = await self.syncRealtimePlan();
                        if (!ok) {
                            void self.renderAndPlaySinPreview(self.selectedSnapshot()?.id || null);
                            return;
                        }
                    }
                    const nextPlaying = !self.livePlaying;
                    if (nextPlaying) {
                        const startPos = cueOn
                            ? (dur > 0.05 ? Math.min(cueSec, dur - 0.02) : cueSec)
                            : ((dur > 0 && self.playheadSec >= dur - 0.02) ? 0 : self.playheadSec);
                        self._dispatchSeekTransport(startPos, true);
                    } else if (cueOn) {
                        self._dispatchSeekTransport(cueSec, false);
                    } else {
                        self.livePlaying = false;
                        self.realtime.setTransport({
                            playing: false,
                            seekSec: -1,
                            bpm: Number(self.session?.session_data?.graph?.settings?.bpm || 120),
                            loop: false,
                        });
                    }
                    self.requestDraw(false);
                    window.gaiaTransport?.render?.();
                    return;
                }
                if (self.previewAudio && self.masterPreview) {
                    if (self.previewAudio.paused || self.previewAudio.ended) {
                        if (cueOn) {
                            self.previewAudio.currentTime = Math.min(self.previewAudio.duration || cueSec, cueSec);
                            self.playheadSec = self.previewAudio.currentTime;
                        }
                        self.previewAudio.play().catch(() => {});
                    } else {
                        self.previewAudio.pause();
                        if (cueOn) {
                            self.previewAudio.currentTime = Math.min(self.previewAudio.duration || cueSec, cueSec);
                            self.playheadSec = self.previewAudio.currentTime;
                        }
                    }
                    self.requestDraw(false);
                    window.gaiaTransport?.render?.();
                    return;
                }
                void self.renderAndPlaySinPreview(self.selectedSnapshot()?.id || null);
            },
            stop() {
                const cueOn = Boolean(window.gaiaTransport?.isCueEnabled?.());
                const dur = self.liveDurationSec || self.maxTimelineDurationSec();
                const cueSec = clamp(Number(window.gaiaTransport?.getCuePoint?.() || 0), 0, Math.max(0, dur));
                let targetSec = 0;
                if (cueOn) {
                    const alreadyStoppedAtCue = !self.livePlaying
                        && !(self.previewAudio && !self.previewAudio.paused)
                        && Math.abs(self.playheadSec - cueSec) <= 0.05;
                    if (alreadyStoppedAtCue) {
                        targetSec = 0;
                        window.gaiaTransport?.setCuePoint?.(0);
                    } else {
                        targetSec = cueSec;
                    }
                }
                if (self.liveAvailable && self.realtime) {
                    self._dispatchSeekTransport(targetSec, false);
                    self.requestDraw(false);
                    window.gaiaTransport?.render?.();
                    return;
                }
                if (self.previewAudio) {
                    self.previewAudio.pause();
                    self.previewAudio.currentTime = Math.min(self.previewAudio.duration || targetSec, targetSec);
                }
                self.playheadSec = targetSec;
                self.requestDraw(false);
                window.gaiaTransport?.render?.();
            },
            seek(seconds, opts = {}) {
                const dur = self.liveDurationSec || self.maxTimelineDurationSec();
                const keepPlaying = opts?.keepPlaying != null ? Boolean(opts.keepPlaying) : Boolean(self.livePlaying);
                const maxSeek = keepPlaying && dur > 0.05 ? Math.max(0, dur - 0.02) : Math.max(0, dur);
                const targetSec = clamp(Number(seconds) || 0, 0, maxSeek);
                self.playheadSec = targetSec;
                self._scheduleSeekTransport(targetSec, keepPlaying, {
                    immediate: !opts?.scrubbing,
                    breathMs: 42,
                });
                self.requestDraw(false);
            },
            selectTarget(targetId) {
                self.handleTargetSelect(targetId);
            },
        };
        window.gaiaTransport?.setCustomDriver?.(this.previewDriver);
    }

    renderShell() {
        if (!this.container) return;
        const pid = this.session?.project_id;
        const sdata = this.session?.session_data || {};
        const normOn = Boolean(sdata.graph?.settings?.output?.normalize);
        const isEmpty = Boolean(this.session?.is_empty);
        const showMasterOnlyWorkspace = Boolean(this.session?.has_workspace && this.layers.length === 0);
        const srK = Math.round((this.realtime?.sampleRate || 48000) / 100) / 10;

        this.container.innerHTML = `
            <div id="sin-editor-dropzone" class="sin-engine-shell">
                <div class="sin-engine-toolbar">
                    <div class="sin-engine-toolbar-group">
                        <div class="media-editor-view-toggle ui-segmented" role="group" aria-label="View">
                            <button id="sin-view-timeline" class="micro-btn ${this.activeViewMode === 'timeline' ? 'active' : 'secondary'}" type="button">Timeline</button>
                            <button id="sin-view-graph" class="micro-btn ${this.activeViewMode === 'graph' ? 'active' : 'secondary'}" type="button">Graph</button>
                            <button id="sin-view-split" class="micro-btn ${this.activeViewMode === 'split' ? 'active' : 'secondary'}" type="button">Split</button>
                        </div>
                        <button id="sin-load-sample-btn" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Load sample or track into SIN graph" ${pid ? '' : 'disabled'}>+ Add</button>
                        <button id="sin-add-cut" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Save current trim as a cut snapshot" ${this.layers.length ? '' : 'disabled'}>Cut</button>
                        <button id="sin-split-2" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Split active lane into 2 cuts" ${this.layers.length ? '' : 'disabled'}>÷2</button>
                        <button id="sin-split-4" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Split active lane into 4 cuts" ${this.layers.length ? '' : 'disabled'}>÷4</button>
                        <span class="media-editor-zoom-controls" aria-label="Zoom">
                            <button id="sin-zoom-out" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Zoom out" ${this.layers.length ? '' : 'disabled'}>−</button>
                            <span id="sin-zoom-label" class="media-editor-zoom-label">1×</span>
                            <button id="sin-zoom-in" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Zoom in" ${this.layers.length ? '' : 'disabled'}>+</button>
                            <button id="sin-zoom-fit" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Reset zoom" ${this.layers.length ? '' : 'disabled'}>Fit</button>
                        </span>
                    </div>
                    <div class="sin-engine-toolbar-group">
                        <span id="sin-live-engine-badge" class="sin-live-badge ui-badge${this.liveAvailable ? ' is-live ui-badge--live-dot' : ''}" title="${this.liveAvailable ? `Native C++ libsin_dsp live device audio (${srK} kHz)` : 'Connecting to native audio engine…'}">${this.liveAvailable ? `${srK}k` : '…'}</span>
                        <select id="sin-snapshot-select" class="sin-select hidden" aria-label="SIN snapshot"></select>
                        <button id="sin-normalize-btn" class="ui-btn ui-btn--bordered secondary micro-btn${normOn ? ' active' : ''}" type="button" aria-pressed="${normOn}" title="Normalize master output">Norm</button>
                        <button id="sin-render-preview" class="ui-btn ui-btn--primary primary micro-btn${this.liveAvailable ? ' hidden' : ''}" type="button" ${pid ? '' : 'disabled'}>Preview</button>
                        <button id="sin-open-external" class="ui-btn ui-btn--bordered secondary micro-btn" type="button" title="Open full SIN Node Editor" ${pid ? '' : 'disabled'}>SIN ↗</button>
                    </div>
                </div>

                <div id="sin-timeline-section" class="sin-timeline-section${this.activeViewMode === 'graph' ? ' hidden' : ''}">
                    <div id="sin-master-strip-wrap" class="sin-master-strip-wrap${showMasterOnlyWorkspace || this.masterPreview ? '' : ' hidden'}">
                        <canvas id="sin-master-preview-canvas" aria-label="SIN master preview"></canvas>
                    </div>
                    ${isEmpty ? `
                        <div id="sin-empty-timeline" class="sin-empty-overlay">
                            <span>Empty graph — drop audio here or add a track</span>
                            <div class="sin-empty-actions">
                                <button id="sin-empty-load-btn" class="primary micro-btn" type="button">+ Add Track</button>
                                <button id="sin-empty-open-btn" class="secondary micro-btn" type="button">SIN ↗</button>
                            </div>
                        </div>
                    ` : (this.layers.length ? `
                        <div class="sin-timeline-grid">
                            <div class="sin-timeline-lanes-col">
                                <div class="media-editor-view-control" aria-label="Timeline window">
                                    <div id="sin-view-slider" class="media-editor-view" role="slider" tabindex="0">
                                        <span id="sin-view-window" class="media-editor-view-window"></span>
                                    </div>
                                </div>
                                <canvas id="sin-timeline-canvas" aria-label="SIN project timeline"></canvas>
                            </div>
                            <div id="sin-mixer-rail" class="sin-mixer-rail" aria-label="Mixer"></div>
                        </div>
                    ` : `
                        <div class="sin-empty-overlay">
                            <span>SIN workspace active — press Play or open in SIN</span>
                        </div>
                    `)}
                    <div id="sin-cuts-list" class="media-editor-cuts hidden"></div>
                </div>

                <div id="sin-graph-section" class="sin-graph-stage${this.activeViewMode === 'timeline' ? ' hidden' : ''}">
                    <div id="sin-graph-canvas" class="media-editor-graph-canvas"></div>
                </div>
            </div>
        `;

        this.renderSnapshotsSelect();
        this.renderMixerRail();
        this.renderCuts();
        this.updateViewSlider();
        this.updateHostTrackInfo();
        const activeLayer = this.selectedLayer() || this.layers[0];
        const activeWf = activeLayer ? this.overviewWaveforms.get(activeLayer.item_id) : null;
        if (activeLayer && activeWf?.peaks?.length) {
            window.gaiaTransport?.setWaveformPeaks?.(
                activeWf.peaks,
                activeWf.duration_seconds || activeWf.duration_sec || activeLayer.duration_seconds || 0
            );
        }
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
    }

    renderSnapshotsSelect() {
        const select = this.container?.querySelector('#sin-snapshot-select');
        if (!select) return;
        const sdata = this.session?.session_data || {};
        const snaps = Array.isArray(sdata.snapshots) ? sdata.snapshots : [];
        const activeId = sdata.active_snapshot_id || '';
        select.classList.toggle('hidden', snaps.length === 0);
        select.innerHTML = '<option value="">Full Mix</option>';
        for (const snap of snaps) {
            const opt = document.createElement('option');
            opt.value = snap.id;
            opt.textContent = snap.label || snap.id;
            select.appendChild(opt);
        }
        select.value = activeId && snaps.some(s => s.id === activeId) ? activeId : '';
        window.sinUI?.enhanceSelect?.(select, { size: 'sm' })?.sync?.();
    }

    renderMixerRail() {
        const rail = this.container?.querySelector('#sin-mixer-rail');
        if (!rail) return;
        if (!this.layers.length) {
            rail.innerHTML = '';
            return;
        }
        rail.innerHTML = this.layers.map((layer, idx) => {
            const selected = idx === this.selectedLayerIdx;
            const muted = this.effectivelyMuted(layer);
            const solo = this.soloIds.has(layer.src_node_id);
            const preVal = Number(layer.pre_gain_db || 0);
            const volVal = Math.round(Number(layer.volume ?? 1) * 100);
            return `
                <div class="sin-mixer-row${selected ? ' is-selected' : ''}${muted ? ' is-muted' : ''}" data-layer-idx="${idx}">
                    <div class="sin-mixer-row-head">
                        <span class="sin-mixer-name" title="${escapeHtml(layer.label)}">${escapeHtml(layer.label)}</span>
                        ${layer.is_mixdown ? '<span class="sin-mixdown-tag">LR</span>' : ''}
                        <button class="sin-mixer-flag${solo ? ' active' : ''}" type="button" data-mixer-solo="${idx}" aria-pressed="${solo}" title="Solo">S</button>
                        <button class="sin-mixer-flag${layer.muted ? ' active is-mute' : ''}" type="button" data-mixer-mute="${idx}" aria-pressed="${Boolean(layer.muted)}" title="Mute">M</button>
                        <button class="sin-mixer-remove" type="button" data-remove-ch="${escapeHtml(layer.ch_node_id || layer.src_node_id)}" title="Remove track">×</button>
                    </div>
                    <div class="sin-mixer-controls">
                        <label class="sin-mixer-slider-label" title="Pre-gain (double-click to reset 0 dB)">
                            <input type="range" min="-24" max="24" step="0.5" value="${preVal}" data-mixer-pre="${idx}">
                            <span class="sin-mixer-val" data-mixer-pre-lbl="${idx}">${preVal >= 0 ? '+' : ''}${preVal.toFixed(0)}dB</span>
                        </label>
                        <label class="sin-mixer-slider-label" title="Volume (double-click to reset 100%)">
                            <input type="range" min="0" max="1" step="0.01" value="${Number(layer.volume ?? 1)}" data-mixer-vol="${idx}">
                            <span class="sin-mixer-val" data-mixer-vol-lbl="${idx}">${volVal}%</span>
                        </label>
                    </div>
                    <div class="sin-mixer-meter-track"><span class="sin-mixer-meter-fill" data-mixer-meter="${idx}"></span></div>
                </div>
            `;
        }).join('');
        rail.querySelectorAll('[data-mixer-pre]').forEach(el => {
            window.sinUI?.enhanceRangeSlider?.(el, { bipolar: true, defaultValue: 0, compact: true, showValue: false });
        });
        rail.querySelectorAll('[data-mixer-vol]').forEach(el => {
            window.sinUI?.enhanceRangeSlider?.(el, { defaultValue: 1, compact: true, showValue: false });
        });
    }

    syncMixerRowStates() {
        const rail = this.container?.querySelector('#sin-mixer-rail');
        if (!rail) return;
        for (let idx = 0; idx < this.layers.length; idx += 1) {
            const layer = this.layers[idx];
            const row = rail.querySelector(`[data-layer-idx="${idx}"]`);
            if (!row) continue;
            const selected = idx === this.selectedLayerIdx;
            const muted = this.effectivelyMuted(layer);
            const solo = this.soloIds.has(layer.src_node_id);
            row.classList.toggle('is-selected', selected);
            row.classList.toggle('is-muted', muted);
            const soloBtn = row.querySelector(`[data-mixer-solo="${idx}"]`);
            if (soloBtn) {
                soloBtn.classList.toggle('active', solo);
                soloBtn.setAttribute('aria-pressed', String(solo));
            }
            const muteBtn = row.querySelector(`[data-mixer-mute="${idx}"]`);
            if (muteBtn) {
                muteBtn.classList.toggle('active', Boolean(layer.muted));
                muteBtn.classList.toggle('is-mute', Boolean(layer.muted));
                muteBtn.setAttribute('aria-pressed', String(Boolean(layer.muted)));
            }
        }
    }

    renderCuts() {
        const listEl = this.container?.querySelector('#sin-cuts-list');
        if (!listEl) return;
        const sdata = this.session?.session_data || {};
        const snaps = Array.isArray(sdata.snapshots) ? sdata.snapshots : [];
        if (!snaps.length) {
            listEl.innerHTML = '';
            listEl.classList.add('hidden');
            return;
        }
        listEl.classList.remove('hidden');
        const activeLayer = this.selectedLayer();
        const activeId = sdata.active_snapshot_id || null;
        listEl.innerHTML = snaps.map((snap, idx) => {
            const selected = snap.id === activeId;
            const ov = snap.overrides || {};
            let rangeText = 'Override';
            if (activeLayer && ov[activeLayer.src_node_id]) {
                const dur = Number(activeLayer.duration_seconds) || this.maxTimelineDurationSec();
                const s0 = Number(ov[activeLayer.src_node_id].crop_start ?? 0) * dur;
                const s1 = Number(ov[activeLayer.src_node_id].crop_end ?? 1) * dur;
                rangeText = `${formatPreciseTime(s0)}–${formatPreciseTime(s1)}`;
            } else {
                const firstKey = Object.keys(ov)[0];
                if (firstKey && ov[firstKey]?.crop_start != null) {
                    const layer = this.layers.find(l => l.src_node_id === firstKey);
                    const dur = Number(layer?.duration_seconds) || this.maxTimelineDurationSec();
                    rangeText = `${formatPreciseTime(Number(ov[firstKey].crop_start) * dur)}–${formatPreciseTime(Number(ov[firstKey].crop_end ?? 1) * dur)}`;
                }
            }
            return `
                <div class="media-cut-card${selected ? ' active' : ''}" data-snap-id="${escapeHtml(snap.id)}">
                    <input class="media-cut-label" type="text" data-snap-label value="${escapeHtml(snap.label || `Cut ${idx + 1}`)}" aria-label="Cut label">
                    <span class="media-cut-range">${rangeText}</span>
                    <button class="secondary micro-btn" type="button" data-snap-play title="Play cut">▶</button>
                    <button class="secondary icon-button" type="button" data-snap-delete aria-label="Delete cut" title="Delete">×</button>
                </div>
            `;
        }).join('');
    }

    async loadLayerWaveforms() {
        await Promise.all(this.layers.map(async layer => {
            if (!layer.waveform_url) return;
            try {
                const res = await fetch(`${layer.waveform_url}?resolution=1400`);
                if (res.ok) {
                    const wf = await res.json();
                    this.overviewWaveforms.set(layer.item_id, wf);
                    if (!layer.duration_seconds && wf.duration_seconds) layer.duration_seconds = wf.duration_seconds;
                    if (!layer.frames && wf.frames) layer.frames = wf.frames;
                    if (!layer.sample_rate && wf.sample_rate) layer.sample_rate = wf.sample_rate;
                }
            } catch {
                // Ignore transient errors
            }
        }));
        this.renderCuts();
        this.updateViewSlider();
        this.updateHostTrackInfo();
        const activeLayer = this.selectedLayer() || this.layers[0];
        const activeWf = activeLayer ? this.overviewWaveforms.get(activeLayer.item_id) : null;
        if (activeLayer && activeWf?.peaks?.length) {
            window.gaiaTransport?.setWaveformPeaks?.(
                activeWf.peaks,
                activeWf.duration_seconds || activeWf.duration_sec || activeLayer.duration_seconds || 0
            );
        }
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
    }

    scheduleDetailWaveforms() {
        if (this.zoom <= 1.05 || !this.layers.length) {
            this.detailWaveforms.clear();
            return;
        }
        if (this.detailTimer) window.clearTimeout(this.detailTimer);
        this.detailTimer = window.setTimeout(async () => {
            const { startSec, endSec } = this.visibleTimeWindow();
            await Promise.all(this.layers.map(async layer => {
                if (!layer.waveform_url || !layer.frames || !layer.sample_rate) return;
                const sFrame = clamp(Math.floor(startSec * layer.sample_rate), 0, Math.max(0, layer.frames - 2));
                const eFrame = clamp(Math.ceil(endSec * layer.sample_rate), sFrame + 1, layer.frames);
                try {
                    const res = await fetch(`${layer.waveform_url}?resolution=1200&start_frame=${sFrame}&end_frame=${eFrame}`);
                    if (res.ok) {
                        this.detailWaveforms.set(layer.item_id, await res.json());
                    }
                } catch {
                    // Ignore
                }
            }));
            this.requestDraw(true);
        }, 90);
    }

    updateViewSlider() {
        const slider = this.container?.querySelector('#sin-view-slider');
        const win = this.container?.querySelector('#sin-view-window');
        const zoomLbl = this.container?.querySelector('#sin-zoom-label');
        if (zoomLbl) zoomLbl.textContent = `${this.zoom.toFixed(1).replace(/\.0$/, '')}×`;
        if (!slider || !win) return;
        const leftPct = clamp(this.viewOffsetRatio, 0, 1) * 100;
        const widthPct = clamp(100 / Math.max(1, this.zoom), 4, 100);
        win.style.left = `${leftPct}%`;
        win.style.width = `${widthPct}%`;
    }

    _drawCueMarker(ctx, x, h, dpr) {
        if (x < -4 * dpr || x > ctx.canvas.width + 4 * dpr) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(247, 178, 59, 0.32)';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.setLineDash([2 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(x, 4 * dpr);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(247, 178, 59, 0.85)';
        const half = 3.5 * dpr;
        const triH = 4.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(x - half, 0);
        ctx.lineTo(x + half, 0);
        ctx.lineTo(x, triH);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    drawMasterStrip() {
        const wrap = this.container?.querySelector('#sin-master-strip-wrap');
        const canvas = this.container?.querySelector('#sin-master-preview-canvas');
        if (!canvas || !wrap) return;
        if (!this.masterPreview && !(this.session?.has_workspace && !this.layers.length)) {
            wrap.classList.add('hidden');
            return;
        }
        wrap.classList.remove('hidden');
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        const peaks = this.masterPreview?.peaks || [];
        const dur = Number(this.masterPreview?.duration_seconds) || this.maxTimelineDurationSec();
        const midY = h / 2;
        if (peaks.length > 0) {
            ctx.fillStyle = '#38d399';
            const step = Math.max(1, Math.floor(dpr));
            for (let x = 0; x < w; x += step) {
                const idx = clamp(Math.floor((x / w) * peaks.length), 0, peaks.length - 1);
                const pair = peaks[idx];
                const minV = clamp(pair[0], -1, 1);
                const maxV = clamp(pair[1], -1, 1);
                const topY = midY - maxV * (h * 0.44);
                const botY = midY - minV * (h * 0.44);
                ctx.fillRect(x, topY, step, Math.max(1.5 * dpr, botY - topY));
            }
        }
        if (window.gaiaTransport?.isCueEnabled?.()) {
            const cueSec = Number(window.gaiaTransport.getCuePoint?.() || 0);
            const cueX = clamp((cueSec / Math.max(0.01, dur)) * w, 0, w);
            this._drawCueMarker(ctx, cueX, h, dpr);
        }
        const playX = clamp((this.playheadSec / Math.max(0.01, dur)) * w, 0, w);
        ctx.fillStyle = '#ff5c5c';
        ctx.fillRect(playX - dpr, 0, 2 * dpr, h);
    }

    drawTimeline() {
        const canvas = this.container?.querySelector('#sin-timeline-canvas');
        if (!canvas || !this.layers.length) return;
        const nLanes = this.layers.length;
        const targetCssHeight = clamp(nLanes * 50, 96, 230);
        if (canvas.style.height !== `${targetCssHeight}px`) {
            canvas.style.height = `${targetCssHeight}px`;
            this._cachedCanvasW = 0;
            this._waveDirty = true;
        }

        const rail = this.container?.querySelector('#sin-mixer-rail');
        if (rail && rail.style.height !== `${targetCssHeight}px`) {
            rail.style.height = `${targetCssHeight}px`;
            const rows = rail.querySelectorAll('.sin-mixer-row');
            rows.forEach(r => { r.style.height = `${targetCssHeight / nLanes}px`; });
        }

        let cssW = this._cachedCanvasW;
        let cssH = this._cachedCanvasH;
        if (cssW <= 0 || cssH <= 0) {
            const rect = canvas.getBoundingClientRect();
            cssW = rect.width;
            cssH = rect.height;
            if (cssW <= 0 || cssH <= 0) return;
            this._cachedCanvasW = cssW;
            this._cachedCanvasH = cssH;
        }

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            this._waveDirty = true;
        }

        const { startSec, endSec } = this.visibleTimeWindow();
        const spanSec = Math.max(0.001, endSec - startSec);
        const secToX = sec => ((sec - startSec) / spanSec) * w;

        // 1. Bake static multi-lane waveforms + crop shading + cut overlays onto offscreen canvas ONLY when dirty
        if (!this._waveBackingCanvas) {
            this._waveBackingCanvas = document.createElement('canvas');
            this._waveDirty = true;
        }
        if (this._waveBackingCanvas.width !== w || this._waveBackingCanvas.height !== h) {
            this._waveBackingCanvas.width = w;
            this._waveBackingCanvas.height = h;
            this._waveDirty = true;
        }
        if (this._waveDirty) {
            this._waveDirty = false;
            const bCtx = this._waveBackingCanvas.getContext('2d');
            bCtx.clearRect(0, 0, w, h);
            const laneH = h / nLanes;
            const activeSnap = this.selectedSnapshot();

            this.layers.forEach((layer, idx) => {
                const top = idx * laneH;
                const midY = top + laneH / 2;
                const selected = idx === this.selectedLayerIdx;
                const muted = this.effectivelyMuted(layer);

                if (selected) {
                    bCtx.fillStyle = 'rgba(93, 169, 233, 0.07)';
                    bCtx.fillRect(0, top, w, laneH);
                }
                bCtx.strokeStyle = 'rgba(255,255,255,0.06)';
                bCtx.lineWidth = 1;
                bCtx.beginPath();
                bCtx.moveTo(0, top + laneH);
                bCtx.lineTo(w, top + laneH);
                bCtx.stroke();

                const wf = (this.zoom > 1.05 && this.detailWaveforms.has(layer.item_id))
                    ? this.detailWaveforms.get(layer.item_id)
                    : this.overviewWaveforms.get(layer.item_id);
                const layerDur = Number(layer.duration_seconds) || Number(wf?.duration_seconds) || 0;

                if (wf?.peaks?.length && layerDur > 0) {
                    const sr = Number(wf.sample_rate || layer.sample_rate || 44100);
                    const wfStartSec = Number(wf.start_frame ?? 0) / sr;
                    const wfEndSec = Number(wf.end_frame ?? wf.frames ?? layerDur * sr) / sr;
                    const wfSpan = Math.max(0.0001, wfEndSec - wfStartSec);
                    const peaks = wf.peaks;
                    const linGain = Math.pow(10, Number(layer.pre_gain_db || 0) / 20) * Number(layer.volume ?? 1);
                    bCtx.fillStyle = muted ? 'rgba(148, 163, 184, 0.3)' : (selected ? '#6fc1ff' : '#4a8ec2');
                    const step = Math.max(1, Math.floor(dpr));
                    for (let x = 0; x < w; x += step) {
                        const sec = startSec + (x / w) * spanSec;
                        if (sec > layerDur) break;
                        const ratio = (sec - wfStartSec) / wfSpan;
                        if (ratio < 0 || ratio >= 1) continue;
                        const pIdx = clamp(Math.floor(ratio * peaks.length), 0, peaks.length - 1);
                        const pair = peaks[pIdx];
                        const minV = clamp(pair[0] * linGain, -1, 1);
                        const maxV = clamp(pair[1] * linGain, -1, 1);
                        const yTop = midY - maxV * (laneH * 0.42);
                        const yBot = midY - minV * (laneH * 0.42);
                        bCtx.fillRect(x, yTop, step, Math.max(dpr, yBot - yTop));
                    }
                }

                if (layerDur > 0) {
                    const c0Sec = Number(layer.crop_start ?? 0) * layerDur;
                    const c1Sec = Number(layer.crop_end ?? 1) * layerDur;
                    const x0 = clamp(secToX(c0Sec), 0, w);
                    const x1 = clamp(secToX(c1Sec), 0, w);
                    bCtx.fillStyle = 'rgba(8, 12, 18, 0.5)';
                    if (x0 > 0) bCtx.fillRect(0, top, x0, laneH);
                    if (x1 < w) bCtx.fillRect(x1, top, w - x1, laneH);
                    if (selected) {
                        bCtx.fillStyle = '#38d399';
                        bCtx.fillRect(x0 - 1.25 * dpr, top, 2.5 * dpr, laneH);
                        bCtx.fillRect(x1 - 1.25 * dpr, top, 2.5 * dpr, laneH);
                    }
                    const snapOv = activeSnap?.overrides?.[layer.src_node_id];
                    if (snapOv) {
                        const sx0 = clamp(secToX(Number(snapOv.crop_start ?? 0) * layerDur), 0, w);
                        const sx1 = clamp(secToX(Number(snapOv.crop_end ?? 1) * layerDur), 0, w);
                        if (sx1 > sx0) {
                            bCtx.fillStyle = 'rgba(247, 178, 59, 0.22)';
                            bCtx.fillRect(sx0, top, sx1 - sx0, laneH);
                            bCtx.strokeStyle = '#f7b23b';
                            bCtx.lineWidth = 1.5 * dpr;
                            bCtx.strokeRect(sx0, top + 1, sx1 - sx0, laneH - 2);
                        }
                    }
                }
            });
        }

        // 2. Fast GPU blit of cached static waveform + cue marker + live playhead cursor
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this._waveBackingCanvas, 0, 0);

        if (window.gaiaTransport?.isCueEnabled?.()) {
            const cueSec = Number(window.gaiaTransport.getCuePoint?.() || 0);
            this._drawCueMarker(ctx, secToX(cueSec), h, dpr);
        }

        const playX = secToX(this.playheadSec);
        if (playX >= 0 && playX <= w) {
            const isScrub = Boolean(this._scrubCursorPos);
            ctx.fillStyle = isScrub ? 'rgba(56, 211, 153, 0.95)' : '#ff5c5c';
            ctx.fillRect(playX - (isScrub ? 1.25 : 0.9) * dpr, 0, (isScrub ? 2.5 : 1.8) * dpr, h);

            // Minimal translucent time pill right beside cursor while scrubbing
            if (isScrub) {
                const label = formatPreciseTime(this.playheadSec);
                ctx.font = `600 ${Math.round(9.5 * dpr)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
                const tw = ctx.measureText(label).width;
                const padX = 5 * dpr;
                const boxW = tw + padX * 2;
                const boxH = 16 * dpr;
                const boxX = clamp(playX + 6 * dpr, 3 * dpr, Math.max(3 * dpr, w - boxW - 3 * dpr));
                const boxY = 4 * dpr;
                ctx.fillStyle = 'rgba(10, 14, 22, 0.84)';
                ctx.fillRect(boxX, boxY, boxW, boxH);
                ctx.strokeStyle = 'rgba(56, 211, 153, 0.55)';
                ctx.lineWidth = dpr;
                ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
                ctx.fillStyle = '#e2f8ef';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, boxX + padX, boxY + boxH * 0.5 + 0.5);
            }
        }
    }

    selectLayer(idx) {
        if (idx < 0 || idx >= this.layers.length) return;
        this.selectedLayerIdx = idx;
        this.syncMixerRowStates();
        this.renderCuts();
        this.updateHostTrackInfo();
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
    }

    mountGraphView() {
        const canvasEl = this.container?.querySelector('#sin-graph-canvas');
        if (!canvasEl || !this.session) return;
        if (!this.graphView) {
            this.graphView = new GraphView(canvasEl, {
                onNodeSelect: node => {
                    if (node?.id?.startsWith('ch-') || node?.id?.startsWith('src-')) {
                        const rawId = Number(node.id.replace(/^(ch|src)-/, ''));
                        const idx = this.layers.findIndex(l => Number(l.item_id) === rawId);
                        if (idx >= 0) this.selectLayer(idx);
                    }
                },
            });
        }
        const graph = this.session.session_data?.graph || { format: 'sin-graph', version: 1, nodes: [], connections: [] };
        this.graphView.setGraph(graph, this.session.positions || {});
        requestAnimationFrame(() => this.graphView?.autoFit?.());
    }

    setViewMode(mode) {
        this.activeViewMode = mode;
        const tl = this.container?.querySelector('#sin-timeline-section');
        const gs = this.container?.querySelector('#sin-graph-section');
        tl?.classList.toggle('hidden', mode === 'graph');
        gs?.classList.toggle('hidden', mode === 'timeline');
        this.container?.querySelector('#sin-view-timeline')?.classList.toggle('active', mode === 'timeline');
        this.container?.querySelector('#sin-view-timeline')?.classList.toggle('secondary', mode !== 'timeline');
        this.container?.querySelector('#sin-view-graph')?.classList.toggle('active', mode === 'graph');
        this.container?.querySelector('#sin-view-graph')?.classList.toggle('secondary', mode !== 'graph');
        this.container?.querySelector('#sin-view-split')?.classList.toggle('active', mode === 'split');
        this.container?.querySelector('#sin-view-split')?.classList.toggle('secondary', mode !== 'split');
        if (mode !== 'timeline') {
            this.mountGraphView();
        }
        if (mode !== 'graph') {
            this._cachedCanvasW = 0;
            this._cachedCanvasH = 0;
            this.requestDraw(true);
        }
    }

    addCutSnapshot() {
        const layer = this.selectedLayer();
        if (!layer || !this.session?.session_data) return;
        const sdata = this.session.session_data;
        const snaps = sdata.snapshots = Array.isArray(sdata.snapshots) ? sdata.snapshots : [];
        const id = `cut-${Date.now().toString(36)}-${snaps.length + 1}`;
        const snap = {
            format: 'sin-snapshot',
            version: 1,
            id,
            label: `${layer.label} Cut ${snaps.length + 1}`,
            root: 'master',
            overrides: {
                [layer.src_node_id]: {
                    crop_start: roundRatio(layer.crop_start),
                    crop_end: roundRatio(layer.crop_end),
                },
            },
            meta: { source_engine: 'sin_timeline' },
        };
        snaps.push(snap);
        sdata.active_snapshot_id = id;
        this.markDirty();
        this.renderSnapshotsSelect();
        this.renderCuts();
        this.requestDraw(true);
    }

    splitLayerIntoCuts(count) {
        const layer = this.selectedLayer();
        if (!layer || !this.session?.session_data || count < 2) return;
        const sdata = this.session.session_data;
        const c0 = Number(layer.crop_start ?? 0);
        const c1 = Number(layer.crop_end ?? 1);
        const step = (c1 - c0) / count;
        const nextSnaps = [];
        for (let i = 0; i < count; i += 1) {
            const s0 = c0 + i * step;
            const s1 = i === count - 1 ? c1 : c0 + (i + 1) * step;
            nextSnaps.push({
                format: 'sin-snapshot',
                version: 1,
                id: `cut-${Date.now().toString(36)}-${i + 1}`,
                label: `part-${String(i + 1).padStart(2, '0')}`,
                root: 'master',
                overrides: {
                    [layer.src_node_id]: {
                        crop_start: roundRatio(s0),
                        crop_end: roundRatio(s1),
                    },
                },
                meta: { source_engine: 'sin_timeline' },
            });
        }
        sdata.snapshots = [...(sdata.snapshots || []), ...nextSnaps];
        sdata.active_snapshot_id = nextSnaps[0]?.id || null;
        this.markDirty();
        this.renderSnapshotsSelect();
        this.renderCuts();
        this.requestDraw(true);
    }

    async auditionCutRealtime(snap) {
        if (!this.realtime || !this.liveAvailable || !snap) return;
        const ok = await this.syncRealtimePlan(snap);
        if (!ok) {
            void this.renderAndPlaySinPreview(snap.id);
            return;
        }
        this.playheadSec = 0;
        this.livePlaying = true;
        this.realtime.setTransport({
            playing: true,
            seekSec: 0,
            bpm: Number(this.session?.session_data?.graph?.settings?.bpm || 120),
            loop: false,
        });
        this.host?.setStatus?.(`Playing "${snap.label || snap.id}" live on device audio`);
        window.gaiaTransport?.render?.();
    }

    async renderAndPlaySinPreview(snapshotId = null) {
        const pid = this.session?.project_id;
        if (!pid || this.renderingPreview) return;
        this.renderingPreview = true;
        try {
            this.host?.setStatus?.('Rendering SIN graph preview…');
            const res = await fetch(`/items/${pid}/preview/render`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    snapshot_id: snapshotId || null,
                    transient_overrides: this.buildTransientOverrides(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || 'Preview render failed');

            this.masterPreview = data;
            this.drawMasterStrip();
            this.stopPreviewAudio(false);

            const audio = new Audio(data.audio_url);
            audio.addEventListener('timeupdate', () => {
                this.playheadSec = audio.currentTime || 0;
                this.drawTimeline();
                this.drawMasterStrip();
                window.gaiaTransport?.render?.();
            });
            for (const ev of ['loadedmetadata', 'play', 'pause', 'ended']) {
                audio.addEventListener(ev, () => window.gaiaTransport?.render?.());
            }
            this.previewAudio = audio;
            this.registerTransport();
            await audio.play();
            this.host?.setStatus?.(snapshotId ? 'Playing cut snapshot via SIN backend' : 'Playing full SIN graph preview');
        } catch (err) {
            this.host?.setStatus?.(err.message || 'SIN preview failed', true);
        } finally {
            this.renderingPreview = false;
        }
    }

    async addItemsToProject(itemIds) {
        const pid = this.session?.project_id;
        if (!pid) return;
        try {
            this.host?.setStatus?.('Loading sample(s) into project SIN graph…');
            let updatedSession = null;
            for (const itemId of itemIds) {
                const res = await fetch(`/projects/${pid}/graph/add-item`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ item_id: Number(itemId) }),
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.detail || 'Could not load sample into graph');
                updatedSession = payload;
            }
            window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
            if (updatedSession) {
                this.onSessionUpdated(updatedSession);
            } else {
                await this.host?.reloadCurrentSession?.();
            }
            this.host?.setStatus?.('Loaded into project SIN graph.');
        } catch (err) {
            this.host?.setStatus?.(err.message || 'Could not load sample', true);
        }
    }

    async removeChannelFromGraph(nodeId) {
        const pid = this.session?.project_id;
        if (!pid || !nodeId) return;
        try {
            this.host?.setStatus?.('Removing channel from SIN graph…');
            const res = await fetch(`/projects/${pid}/graph/channels/${encodeURIComponent(nodeId)}`, {
                method: 'DELETE',
            });
            const updatedSession = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(updatedSession.detail || 'Could not remove channel');
            this.onSessionUpdated(updatedSession);
            this.host?.setStatus?.('Removed channel from SIN graph.');
        } catch (err) {
            this.host?.setStatus?.(err.message || 'Remove failed', true);
        }
    }

    async openLoadSampleDialog() {
        const dialog = document.getElementById('sin-load-sample-dialog');
        const listEl = document.getElementById('sin-load-sample-list');
        const searchInput = document.getElementById('sin-load-sample-search');
        const closeBtn = document.getElementById('sin-load-sample-close');
        const cancelBtn = document.getElementById('sin-load-sample-cancel');
        const statusEl = document.getElementById('sin-load-sample-status');
        if (!dialog || !listEl) return;

        if (this.loadDialogCleanup) {
            this.loadDialogCleanup();
            this.loadDialogCleanup = null;
        }
        if (searchInput) searchInput.value = '';
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.classList.add('hidden');
        }
        listEl.innerHTML = '<div class="sin-picker-loading">Loading audio & multitrack items…</div>';
        if (!dialog.open) dialog.showModal();

        const projectAssets = Array.isArray(this.session?.project_assets) ? this.session.project_assets : [];
        const vaultId = window.gaiaAppBridge?.getActiveVaultId?.();
        let vaultItems = [];
        try {
            const url = vaultId ? `/items/?vault_id=${encodeURIComponent(vaultId)}&limit=1000` : '/items/?limit=1000';
            const res = await fetch(url);
            if (res.ok) {
                const all = await res.json();
                vaultItems = (Array.isArray(all) ? all : []).filter(it =>
                    ['audio', 'track', 'sample', 'multitrack', 'zoom_h4'].includes(it.type)
                );
            }
        } catch {
            vaultItems = [];
        }

        const inGraphIds = new Set(this.layers.map(l => Number(l.item_id)).filter(Boolean));
        const renderList = () => {
            const q = (searchInput?.value || '').trim().toLowerCase();
            const projFiltered = projectAssets.filter(a => !q || String(a.label).toLowerCase().includes(q));
            const seenProj = new Set(projectAssets.map(a => Number(a.id)));
            const libFiltered = vaultItems
                .filter(it => !seenProj.has(Number(it.id)))
                .filter(it => !q || String(it.title || it.absolute_path || '').toLowerCase().includes(q))
                .slice(0, 80);

            const makeRow = (id, label, badge, loaded) => `
                <div class="sin-picker-row">
                    <span class="sin-picker-name">${escapeHtml(label)}</span>
                    <span class="type-badge">${escapeHtml(badge)}</span>
                    <button class="${loaded ? 'secondary' : 'primary'} micro-btn" type="button" data-pick-item-id="${id}" ${loaded ? 'disabled' : ''}>
                        ${loaded ? 'In graph' : 'Load'}
                    </button>
                </div>
            `;

            let html = '';
            if (projFiltered.length) {
                html += '<div class="sin-picker-group-label">Project Items</div>';
                html += projFiltered.map(a => makeRow(a.id, a.label, a.is_multitrack ? `Multitrack (${a.stem_count})` : a.type, Boolean(a.in_graph))).join('');
            }
            if (libFiltered.length) {
                html += '<div class="sin-picker-group-label">Library Vault Audio</div>';
                html += libFiltered.map(it => {
                    const name = it.title || String(it.absolute_path || '').split(/[/\\]/).pop() || `Item #${it.id}`;
                    const loaded = inGraphIds.has(Number(it.id));
                    return makeRow(it.id, name, it.type, loaded);
                }).join('');
            }
            if (!html) {
                html = '<div class="sin-picker-loading">No matching audio or multitrack items found.</div>';
            }
            listEl.innerHTML = html;
        };

        renderList();
        const ac = new AbortController();
        searchInput?.addEventListener('input', renderList, { signal: ac.signal });
        listEl.addEventListener('click', async event => {
            const btn = event.target.closest('[data-pick-item-id]');
            if (!btn || btn.disabled) return;
            const id = Number(btn.dataset.pickItemId);
            btn.disabled = true;
            btn.textContent = 'Loading…';
            await this.addItemsToProject([id]);
            dialog.close();
        }, { signal: ac.signal });
        closeBtn?.addEventListener('click', () => dialog.close(), { signal: ac.signal });
        cancelBtn?.addEventListener('click', () => dialog.close(), { signal: ac.signal });
        dialog.addEventListener('close', () => ac.abort(), { signal: ac.signal });
        this.loadDialogCleanup = () => ac.abort();
    }

    bindEvents() {
        if (!this.container) return;
        const sig = { signal: this.abortController.signal };

        this.container.querySelector('#sin-view-timeline')?.addEventListener('click', () => this.setViewMode('timeline'), sig);
        this.container.querySelector('#sin-view-graph')?.addEventListener('click', () => this.setViewMode('graph'), sig);
        this.container.querySelector('#sin-view-split')?.addEventListener('click', () => this.setViewMode('split'), sig);

        this.container.querySelector('#sin-load-sample-btn')?.addEventListener('click', () => void this.openLoadSampleDialog(), sig);
        this.container.querySelector('#sin-empty-load-btn')?.addEventListener('click', () => void this.openLoadSampleDialog(), sig);

        const openSinUrl = () => {
            const pid = this.session?.project_id;
            if (pid) window.open(`${sinEditorBaseUrl()}/?gaia_project=${encodeURIComponent(pid)}`, '_blank', 'noopener');
        };
        this.container.querySelector('#sin-open-external')?.addEventListener('click', openSinUrl, sig);
        this.container.querySelector('#sin-empty-open-btn')?.addEventListener('click', openSinUrl, sig);

        this.container.querySelector('#sin-render-preview')?.addEventListener('click', () => {
            void this.renderAndPlaySinPreview(this.selectedSnapshot()?.id || null);
        }, sig);

        const masterCanvas = this.container.querySelector('#sin-master-preview-canvas');
        masterCanvas?.addEventListener('pointerdown', event => {
            const rect = masterCanvas.getBoundingClientRect();
            const dur = Number(this.masterPreview?.duration_seconds) || this.liveDurationSec || this.maxTimelineDurationSec();
            const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            const targetSec = ratio * dur;
            window.gaiaTransport?.setCuePoint?.(targetSec);
            this._scheduleSeekTransport(targetSec, Boolean(this.livePlaying), { immediate: true });
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        }, sig);

        this.container.querySelector('#sin-add-cut')?.addEventListener('click', () => this.addCutSnapshot(), sig);
        this.container.querySelector('#sin-split-2')?.addEventListener('click', () => this.splitLayerIntoCuts(2), sig);
        this.container.querySelector('#sin-split-4')?.addEventListener('click', () => this.splitLayerIntoCuts(4), sig);

        const normBtn = this.container.querySelector('#sin-normalize-btn');
        normBtn?.addEventListener('click', () => {
            const settings = this.session?.session_data?.graph?.settings;
            if (!settings) return;
            const out = settings.output = settings.output || {};
            out.normalize = !out.normalize;
            normBtn.classList.toggle('active', Boolean(out.normalize));
            normBtn.setAttribute('aria-pressed', String(Boolean(out.normalize)));
            this.markDirty();
        }, sig);

        const snapSelect = this.container.querySelector('#sin-snapshot-select');
        snapSelect?.addEventListener('change', () => {
            if (!this.session?.session_data) return;
            this.session.session_data.active_snapshot_id = snapSelect.value || null;
            this.renderCuts();
            this.requestDraw(true);
            this.markDirty();
            if (this.liveAvailable && this.realtime) {
                void this.syncRealtimePlan(this.selectedSnapshot() || null);
            }
        }, sig);

        // Zoom buttons & wheel
        const setZoom = nextZoom => {
            this.zoom = clamp(nextZoom, 1, 64);
            this.updateViewSlider();
            this.requestDraw(true);
            this.scheduleDetailWaveforms();
        };
        this.container.querySelector('#sin-zoom-in')?.addEventListener('click', () => setZoom(this.zoom * 2), sig);
        this.container.querySelector('#sin-zoom-out')?.addEventListener('click', () => setZoom(this.zoom / 2), sig);
        this.container.querySelector('#sin-zoom-fit')?.addEventListener('click', () => {
            this.viewOffsetRatio = 0;
            setZoom(1);
        }, sig);

        // View overview pan
        const viewSlider = this.container.querySelector('#sin-view-slider');
        const panFromPointer = event => {
            if (!viewSlider) return;
            const rect = viewSlider.getBoundingClientRect();
            const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            const winSpanRatio = 1 / Math.max(1, this.zoom);
            this.viewOffsetRatio = clamp(ratio - winSpanRatio / 2, 0, Math.max(0, 1 - winSpanRatio));
            this.updateViewSlider();
            this.requestDraw(true);
            this.scheduleDetailWaveforms();
        };
        viewSlider?.addEventListener('pointerdown', event => {
            viewSlider.setPointerCapture(event.pointerId);
            this.viewDragState = true;
            panFromPointer(event);
        }, sig);
        viewSlider?.addEventListener('pointermove', event => {
            if (this.viewDragState) panFromPointer(event);
        }, sig);
        viewSlider?.addEventListener('pointerup', () => {
            this.viewDragState = false;
        }, sig);

        // Multi-lane canvas pointer interaction:
        // Click repositions cleanly; hold + move transparently scrubs through the pre-buffered C++ engine!
        const tlCanvas = this.container.querySelector('#sin-timeline-canvas');
        const hitTestCropHandle = (clientX, clientY, rect) => {
            const laneIdx = clamp(Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * this.layers.length), 0, this.layers.length - 1);
            const layer = this.layers[laneIdx];
            if (!layer) return { mode: 'seek', laneIdx };
            const { startSec, endSec } = this.visibleTimeWindow();
            const span = Math.max(0.001, endSec - startSec);
            const layerDur = Number(layer.duration_seconds) || this.maxTimelineDurationSec();
            const secToCssX = s => ((s - startSec) / span) * rect.width;
            const x = clientX - rect.left;
            if (layerDur > 0 && laneIdx === this.selectedLayerIdx) {
                if (Math.abs(x - secToCssX(Number(layer.crop_start ?? 0) * layerDur)) <= 9) return { mode: 'crop-start', laneIdx };
                if (Math.abs(x - secToCssX(Number(layer.crop_end ?? 1) * layerDur)) <= 9) return { mode: 'crop-end', laneIdx };
            }
            return { mode: 'seek', laneIdx };
        };

        tlCanvas?.addEventListener('pointerdown', event => {
            if (!this.layers.length || event.button !== 0) return;
            const rect = tlCanvas.getBoundingClientRect();
            this._cachedCanvasW = rect.width;
            this._cachedCanvasH = rect.height;
            const hit = hitTestCropHandle(event.clientX, event.clientY, rect);
            if (hit.laneIdx !== this.selectedLayerIdx) {
                this.selectLayer(hit.laneIdx);
            }
            const { startSec, endSec } = this.visibleTimeWindow();
            const span = Math.max(0.001, endSec - startSec);
            const sec = clamp(startSec + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span, 0, this.maxTimelineDurationSec());

            tlCanvas.setPointerCapture(event.pointerId);
            const wasPlaying = Boolean(this.livePlaying);
            this.dragState = {
                mode: hit.mode,
                laneIdx: hit.laneIdx,
                rect,
                startX: event.clientX,
                startSec: sec,
                moved: false,
                wasPlaying,
                monitoringScrub: false,
            };
            if (hit.mode === 'seek') {
                this.playheadSec = sec;
                window.gaiaTransport?.setCuePoint?.(sec);
                // Click-jump immediately commits position (and pre-warms disk buffer even when paused!)
                this._scheduleSeekTransport(sec, wasPlaying, { immediate: true });
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        }, sig);

        tlCanvas?.addEventListener('pointermove', event => {
            if (!this.dragState) {
                if (this.layers.length && tlCanvas) {
                    const rect = tlCanvas.getBoundingClientRect();
                    const hit = hitTestCropHandle(event.clientX, event.clientY, rect);
                    tlCanvas.style.cursor = hit.mode === 'seek' ? 'col-resize' : 'ew-resize';
                }
                return;
            }
            const layer = this.layers[this.dragState.laneIdx];
            if (!layer) return;
            const rect = this.dragState.rect || tlCanvas.getBoundingClientRect();
            const { startSec, endSec } = this.visibleTimeWindow();
            const span = Math.max(0.001, endSec - startSec);
            const sec = clamp(startSec + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span, 0, this.maxTimelineDurationSec());
            if (this.dragState.mode === 'seek') {
                if (!this.dragState.moved && Math.abs(event.clientX - this.dragState.startX) >= 4) {
                    this.dragState.moved = true;
                    this.dragState.monitoringScrub = true;
                }
                if (this.dragState.moved) {
                    this.playheadSec = sec;
                    this._scrubCursorPos = { x: event.clientX - rect.left, y: event.clientY - rect.top, sec };
                    // Transparent live position monitoring with a 45ms breath window (leverages C++ sliding window + 4ms overlap crossfade)
                    this._scheduleSeekTransport(sec, true, { immediate: false, breathMs: 45 });
                    if (this._scrubIdlePauseTimer) {
                        window.clearTimeout(this._scrubIdlePauseTimer);
                    }
                    if (!this.dragState.wasPlaying) {
                        // When paused before drag, pause cleanly if pointer stays still for 160ms so audio stays locked to the cursor
                        this._scrubIdlePauseTimer = window.setTimeout(() => {
                            this._scrubIdlePauseTimer = null;
                            if (this.dragState?.mode === 'seek' && !this.dragState.wasPlaying) {
                                this._dispatchSeekTransport(this.playheadSec, false);
                            }
                        }, 160);
                    }
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
                return;
            }
            const layerDur = Math.max(0.01, Number(layer.duration_seconds) || this.maxTimelineDurationSec());
            const ratio = clamp(sec / layerDur, 0, 1);
            if (this.dragState.mode === 'crop-start') {
                layer.crop_start = Math.min(ratio, Number(layer.crop_end ?? 1) - 0.002);
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'crop_start', layer.crop_start, 0);
            } else if (this.dragState.mode === 'crop-end') {
                layer.crop_end = Math.max(ratio, Number(layer.crop_start ?? 0) + 0.002);
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'crop_end', layer.crop_end, 0);
            }
            this.applyLayerControlToGraph(layer);
            this.markDirty();
            this.requestDraw(true);
        }, sig);

        const finishTimelineDrag = () => {
            if (!this.dragState) return;
            const st = this.dragState;
            this.dragState = null;
            this._scrubCursorPos = null;
            if (this._scrubIdlePauseTimer) {
                window.clearTimeout(this._scrubIdlePauseTimer);
                this._scrubIdlePauseTimer = null;
            }
            if (st.mode === 'seek') {
                const cueTarget = st.moved ? this.playheadSec : st.startSec;
                window.gaiaTransport?.setCuePoint?.(cueTarget);
                // If transport was playing and user simply clicked/held without dragging while engine is still running,
                // let playback flow seamlessly without stuttering backward; otherwise commit exact final position & state.
                if (!(st.wasPlaying && !st.moved && this._lastServerPlaying)) {
                    this._dispatchSeekTransport(cueTarget, st.wasPlaying);
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        };
        tlCanvas?.addEventListener('pointerup', finishTimelineDrag, sig);
        tlCanvas?.addEventListener('pointercancel', finishTimelineDrag, sig);

        tlCanvas?.addEventListener('wheel', event => {
            if (Math.abs(event.deltaY) < 1) return;
            event.preventDefault();
            setZoom(this.zoom * (event.deltaY < 0 ? 1.25 : 0.8));
        }, { signal: this.abortController.signal, passive: false });

        // Mixer rail delegation — real-time <5ms parameter push straight to libsin_dsp
        const mixerRail = this.container.querySelector('#sin-mixer-rail');
        mixerRail?.addEventListener('input', event => {
            const preInput = event.target.closest('[data-mixer-pre]');
            if (preInput) {
                const idx = Number(preInput.dataset.mixerPre);
                const layer = this.layers[idx];
                if (!layer) return;
                layer.pre_gain_db = Number(preInput.value) || 0;
                const lbl = mixerRail.querySelector(`[data-mixer-pre-lbl="${idx}"]`);
                if (lbl) lbl.textContent = `${layer.pre_gain_db >= 0 ? '+' : ''}${layer.pre_gain_db.toFixed(0)}dB`;
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'pre_gain_db', layer.pre_gain_db, 5);
                this.applyLayerControlToGraph(layer);
                this.markDirty();
                this.requestDraw(true);
                return;
            }
            const volInput = event.target.closest('[data-mixer-vol]');
            if (volInput) {
                const idx = Number(volInput.dataset.mixerVol);
                const layer = this.layers[idx];
                if (!layer) return;
                layer.volume = clamp(Number(volInput.value) || 0, 0, 1);
                const lbl = mixerRail.querySelector(`[data-mixer-vol-lbl="${idx}"]`);
                if (lbl) lbl.textContent = `${Math.round(layer.volume * 100)}%`;
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'volume', layer.volume, 5);
                this.applyLayerControlToGraph(layer);
                this.markDirty();
                this.requestDraw(true);
            }
        }, sig);

        // Double-click any mixer slider to reset smoothly (0 dB / 100%)
        mixerRail?.addEventListener('dblclick', event => {
            const preInput = event.target.closest('[data-mixer-pre]');
            if (preInput) {
                preInput.value = '0';
                preInput.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            const volInput = event.target.closest('[data-mixer-vol]');
            if (volInput) {
                volInput.value = '1';
                volInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, sig);

        mixerRail?.addEventListener('click', event => {
            const rmBtn = event.target.closest('[data-remove-ch]');
            if (rmBtn) {
                void this.removeChannelFromGraph(rmBtn.dataset.removeCh);
                return;
            }
            const soloBtn = event.target.closest('[data-mixer-solo]');
            if (soloBtn) {
                const idx = Number(soloBtn.dataset.mixerSolo);
                const layer = this.layers[idx];
                if (!layer) return;
                if (this.soloIds.has(layer.src_node_id)) this.soloIds.delete(layer.src_node_id);
                else this.soloIds.add(layer.src_node_id);
                for (const l of this.layers) {
                    this.realtime?.setParam(l.ch_node_id || l.src_node_id, 'solo', this.soloIds.has(l.src_node_id) ? 1 : 0, 5);
                }
                this.syncMixerRowStates();
                this.requestDraw(true);
                return;
            }
            const muteBtn = event.target.closest('[data-mixer-mute]');
            if (muteBtn) {
                const idx = Number(muteBtn.dataset.mixerMute);
                const layer = this.layers[idx];
                if (!layer) return;
                layer.muted = !layer.muted;
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'mute', layer.muted ? 1 : 0, 5);
                this.applyLayerControlToGraph(layer);
                this.markDirty();
                this.syncMixerRowStates();
                this.requestDraw(true);
                return;
            }
            if (event.target.closest('input')) return;
            const row = event.target.closest('[data-layer-idx]');
            if (row) {
                this.selectLayer(Number(row.dataset.layerIdx));
            }
        }, sig);

        // Cuts list delegation — instant real-time cut audition via libsin_dsp
        const cutsList = this.container.querySelector('#sin-cuts-list');
        cutsList?.addEventListener('click', event => {
            const card = event.target.closest('[data-snap-id]');
            if (!card || !this.session?.session_data) return;
            const sid = card.dataset.snapId;
            const sdata = this.session.session_data;
            if (event.target.closest('[data-snap-delete]')) {
                sdata.snapshots = (sdata.snapshots || []).filter(s => s.id !== sid);
                if (sdata.active_snapshot_id === sid) sdata.active_snapshot_id = null;
                this.markDirty();
                this.renderSnapshotsSelect();
                this.renderCuts();
                this.requestDraw(true);
                return;
            }
            if (event.target.closest('[data-snap-label]')) {
                // Keep label text input focus undisturbed while selecting its snapshot
                if (sdata.active_snapshot_id !== sid) {
                    sdata.active_snapshot_id = sid;
                    this.renderSnapshotsSelect();
                    cutsList.querySelectorAll('[data-snap-id]').forEach(c => c.classList.toggle('active', c.dataset.snapId === sid));
                    this.requestDraw(true);
                }
                return;
            }
            sdata.active_snapshot_id = sid;
            this.renderSnapshotsSelect();
            cutsList.querySelectorAll('[data-snap-id]').forEach(c => c.classList.toggle('active', c.dataset.snapId === sid));
            this.requestDraw(true);
            if (event.target.closest('[data-snap-play]')) {
                const snap = (sdata.snapshots || []).find(s => s.id === sid);
                if (this.liveAvailable && this.realtime && snap) {
                    void this.auditionCutRealtime(snap);
                } else {
                    void this.renderAndPlaySinPreview(sid);
                }
            }
        }, sig);

        cutsList?.addEventListener('input', event => {
            const lbl = event.target.closest('[data-snap-label]');
            if (!lbl) return;
            const card = lbl.closest('[data-snap-id]');
            const snap = (this.session?.session_data?.snapshots || []).find(s => s.id === card?.dataset.snapId);
            if (!snap) return;
            snap.label = lbl.value;
            this.markDirty();
            this.renderSnapshotsSelect();
        }, sig);

        // Drag-drop audio/multitrack items from GAIA table onto the editor
        const dropZone = this.container.querySelector('#sin-editor-dropzone');
        dropZone?.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            dropZone.classList.add('is-drop-active');
        }, sig);
        dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('is-drop-active'), sig);
        dropZone?.addEventListener('drop', async event => {
            dropZone.classList.remove('is-drop-active');
            const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
            if (!rawIds) return;
            event.preventDefault();
            let itemIds = [];
            try { itemIds = JSON.parse(rawIds); } catch { return; }
            if (Array.isArray(itemIds) && itemIds.length) {
                await this.addItemsToProject(itemIds);
            }
        }, sig);

        // Responsive redraw
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this._cachedCanvasW = 0;
                this._cachedCanvasH = 0;
                if (this.activeViewMode !== 'graph') {
                    this.requestDraw(true);
                }
                if (this.activeViewMode !== 'timeline') {
                    this.graphView?.autoFit?.();
                }
            });
            this.resizeObserver.observe(this.container);
        }
    }
}

function roundRatio(val) {
    return Math.round(clamp(Number(val) || 0, 0, 1) * 1e6) / 1e6;
}
