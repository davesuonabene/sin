import { RealtimeAudioClient } from '/packages/media-client/src/realtime-client.js';
import { formatPreciseTime } from '../transport.js?v=6';

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

function dbToLinear(db) {
    const num = Number(db) || 0;
    return num <= -59.9 ? 0 : Math.pow(10, num / 20);
}

function formatDb(db) {
    const num = Number(db) || 0;
    const rounded = Math.round(num * 10) / 10;
    const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
    return `${rounded > 0 ? '+' : ''}${text}dB`;
}

export class SimpleMediaEngine {
    constructor() {
        this.id = 'simple_media';
        this.label = 'Simple Media Editor';
        this.host = null;
        this.container = null;
        this.session = null;
        this.targetsState = {};
        this.activeTargetId = null;
        this.selectedCutId = null;
        this.selectionRange = null; // { startFrame, endFrame, startSec, endSec }
        this.dirty = false;
        this.abortController = null;

        // Real-time native libsin_dsp client (primary audio path, zero HTTP PCM decode!)
        this.realtime = null;
        this.liveAvailable = false;
        this.liveLoadedTargetKey = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this._auditionStopSec = null;
        this._latestTelemetry = null;
        this._telemetryRaf = null;
        this._unsubRealtime = [];
        this._unsubCue = null;
        this._lastServerPlaying = false;
        this._loadAbort = null;
        this._waveformAbort = null;

        // Smooth position-buffered seek / hold-drag scrub controller
        this._seekBreathTimer = null;
        this._scrubIdlePauseTimer = null;
        this._lastSeekSentAt = 0;
        this._pendingSeek = null;
        this._seekLockUntil = 0;
        this._seekLockSec = 0;
        this._scrubCursorPos = null;

        // 2-layer offscreen waveform cache
        this._waveBackingCanvas = null;
        this._waveDirty = true;
        this._drawRaf = null;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;

        // Waveform data (single-file overview + multitrack per-layer + computed sum)
        this.overviewWaveform = null;
        this.layerWaveforms = new Map(); // item_id -> waveform payload
        this.summedPeaks = []; // [[min, max], ...]

        // Lightweight HTML5 / Web Audio fallback when native libsin_dsp is unavailable
        this.audioFallbackEl = null;
        this.audioFallbackLayers = []; // [{ itemId, audio, gainNode, sourceNode }]
        this._fallbackAudioCtx = null;
        this._fallbackMasterGain = null;
        this._fallbackStopSec = null;
        this._fallbackRaf = null;
        this.videoEl = null;
        this.videoTimer = null;
        this.playheadTimeSec = 0;

        // Canvas drag state
        this.dragState = null;
        this.resizeObserver = null;
        this.transportDriver = null;
    }

    mount(container, session, host) {
        this.unmount();
        this.container = container;
        this.session = session;
        this.host = host;
        this.dirty = false;
        this.abortController = new AbortController();
        this.hydrateSessionState(session);
        this.renderShell();
        this.bindEvents();
        this.registerTransport();
        if (this._unsubCue) {
            try { this._unsubCue(); } catch { /* ignore */ }
        }
        this._unsubCue = window.gaiaTransport?.onCueChange?.(() => this.requestDraw(false)) || null;
        if (!session.is_empty && this.currentTarget()) {
            void this.loadActiveTargetAssets();
            if (this.currentTarget().media_kind !== 'video') {
                void this.initRealtimeEngine();
            }
        }
    }

    unmount() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this._loadAbort) {
            this._loadAbort.abort();
            this._loadAbort = null;
        }
        if (this._waveformAbort) {
            this._waveformAbort.abort();
            this._waveformAbort = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
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
        if (this._telemetryRaf !== null) {
            window.cancelAnimationFrame(this._telemetryRaf);
            this._telemetryRaf = null;
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
        this._latestTelemetry = null;
        this._auditionStopSec = null;
        if (this.videoTimer) {
            window.clearInterval(this.videoTimer);
            this.videoTimer = null;
        }
        // Explicitly stop native playback BEFORE disconnecting WebSocket so closing the editor never leaves audio playing
        if (this.realtime) {
            try {
                this.realtime.setTransport({ playing: false });
            } catch { /* ignore */ }
        }
        this.stopPlayback(false);
        if (this.realtime) {
            this.realtime.disconnect();
            this.realtime = null;
        }
        this.liveAvailable = false;
        this.liveLoadedTargetKey = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.selectionRange = null;
        this.layerWaveforms.clear();
        this.summedPeaks = [];
        this.overviewWaveform = null;
        this._waveBackingCanvas = null;
        this._waveDirty = true;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this._scrubCursorPos = null;
        this._pendingSeek = null;
        this.cleanupMediaElements();
        if (this.transportDriver) {
            window.gaiaTransport?.clearCustomDriver?.(this.transportDriver);
            this.transportDriver = null;
        }
        if (this.container) {
            this.container.innerHTML = '';
            this.container = null;
        }
        this.session = null;
        this.host = null;
    }

    onSessionUpdated(session) {
        this.stopPlayback(false);
        this.cleanupMediaElements();
        if (this._loadAbort) {
            this._loadAbort.abort();
            this._loadAbort = null;
        }
        if (this._waveformAbort) {
            this._waveformAbort.abort();
            this._waveformAbort = null;
        }
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.liveLoadedTargetKey = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this._auditionStopSec = null;
        this.playheadTimeSec = 0;
        this.selectionRange = null;
        this.overviewWaveform = null;
        this.layerWaveforms.clear();
        this.summedPeaks = [];
        this._waveDirty = true;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this._scrubCursorPos = null;
        this.session = session;
        this.dirty = false;
        this.hydrateSessionState(session);
        this.renderShell();
        this.bindEvents();
        this.registerTransport();
        if (this._unsubCue) {
            try { this._unsubCue(); } catch { /* ignore */ }
        }
        this._unsubCue = window.gaiaTransport?.onCueChange?.(() => this.requestDraw(false)) || null;
        if (!session.is_empty && this.currentTarget()) {
            void this.loadActiveTargetAssets();
            if (this.currentTarget().media_kind !== 'video') {
                void this.initRealtimeEngine();
            }
        }
    }

    isRealtimeReady(target = this.currentTarget()) {
        return Boolean(
            this.liveAvailable
            && this.realtime
            && target
            && target.media_kind !== 'video'
            && this.liveLoadedTargetKey === target.id
        );
    }

    isLayerEffectivelyMuted(layerState, allLayers = null) {
        const list = allLayers || this.activeState()?.layers || [];
        const anySolo = list.some(l => Boolean(l.solo));
        return anySolo ? !Boolean(layerState?.solo) : Boolean(layerState?.muted);
    }

    requestDraw(waveDirty = false) {
        if (waveDirty) this._waveDirty = true;
        if (this._drawRaf !== null) return;
        this._drawRaf = window.requestAnimationFrame(() => {
            this._drawRaf = null;
            this.drawAudioWaveform();
            this.drawMultitrackLayerWaveforms();
            this.drawVideoTimeline();
        });
    }

    async initRealtimeEngine() {
        const target = this.currentTarget();
        if (!target || target.media_kind === 'video' || !target.item_id) return;
        if (!this.realtime) {
            this.realtime = new RealtimeAudioClient('/editor/realtime/ws', { ownerId: 'gaia-simple-media' });
            this._unsubRealtime.push(
                this.realtime.onStatusChange(st => {
                    this.liveAvailable = Boolean(st.available);
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
                            const isScrubbing = Boolean(this.dragState);
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
                                    this.playheadTimeSec = incomingSec;
                                    if (this.livePlaying && this._auditionStopSec !== null && incomingSec >= this._auditionStopSec - 0.02) {
                                        const stopAt = this._auditionStopSec;
                                        this._auditionStopSec = null;
                                        this._dispatchSeekTransport(stopAt, false);
                                    }
                                }
                            }
                            this.requestDraw(false);
                            window.gaiaTransport?.render?.();
                        });
                    }
                }),
            );
        }
        const ok = await this.realtime.connect();
        this.liveAvailable = Boolean(ok);
        if (ok) {
            await this.syncRealtimeTarget(target);
        }
    }

    buildRealtimeMultitrackGraph(target, st) {
        if (!target?.realtime_graph) return null;
        const graph = structuredClone(target.realtime_graph);
        const layers = Array.isArray(st?.layers) ? st.layers : [];
        const byId = new Map(layers.map(l => [Number(l.item_id), l]));

        for (const node of graph.nodes || []) {
            if (!node || typeof node !== 'object') continue;
            node.properties = node.properties || {};
            if (node.type === 'sample') {
                // Keep full-timeline scrubbing unlocked in live playback; trim/cuts/selection control transport bounds
                node.properties.crop_start = 0.0;
                node.properties.crop_end = 1.0;
            } else if (String(node.id || '').startsWith('ch-')) {
                const stemId = Number(String(node.id).slice(3));
                const layer = byId.get(stemId);
                if (layer) {
                    const effMuted = this.isLayerEffectivelyMuted(layer, layers);
                    node.properties.chain = [
                        { id: 'pre', name: 'Pre-Gain', type: 'gain', enabled: true, params: { gain: dbToLinear(layer.pre_gain_db) } },
                        { id: 'fader', name: 'Fader', type: 'gain', enabled: true, params: { gain: clamp(Number(layer.volume ?? 1), 0, 1) } },
                        { id: 'mute', name: 'Mute', type: 'gain', enabled: effMuted, params: { gain: 0.0 } },
                    ];
                }
            } else if (node.id === 'master') {
                node.properties.chain = [
                    { id: 'pre', name: 'Pre-Gain', type: 'gain', enabled: true, params: { gain: dbToLinear(st?.pre_gain_db || 0) } },
                    { id: 'fader', name: 'Fader', type: 'gain', enabled: true, params: { gain: clamp(Number(st?.volume ?? 1), 0, 1) } },
                    { id: 'mute', name: 'Mute', type: 'gain', enabled: false, params: { gain: 0.0 } },
                ];
            }
        }
        return graph;
    }

    pushRealtimeParams() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st || target.media_kind === 'video') return;

        // Also update fallback Web Audio / HTML5 nodes live if active
        this.syncFallbackAudioGains();

        if (!this.isRealtimeReady(target)) return;
        if (target.is_multitrack) {
            const layers = Array.isArray(st.layers) ? st.layers : [];
            for (const layer of layers) {
                const chId = `ch-${layer.item_id}`;
                const effMuted = this.isLayerEffectivelyMuted(layer, layers);
                this.realtime.setParam(chId, 'pre_gain_db', Number(layer.pre_gain_db || 0), 5);
                this.realtime.setParam(chId, 'volume', clamp(Number(layer.volume ?? 1), 0, 1), 5);
                this.realtime.setParam(chId, 'mute', effMuted ? 1 : 0, 5);
            }
            this.realtime.setParam('master', 'pre_gain_db', Number(st.pre_gain_db || 0), 5);
            this.realtime.setParam('master', 'volume', clamp(Number(st.volume ?? 1), 0, 1), 5);
            return;
        }
        this.realtime.setParam('preview', 'pre_gain_db', Number(st.pre_gain_db || 0), 5);
        this.realtime.setParam('preview', 'volume', clamp(Number(st.volume ?? 1), 0, 1), 5);
        this.realtime.setParam('preview', 'crop_start', 0, 0);
        this.realtime.setParam('preview', 'crop_end', 1, 0);
    }

    async syncRealtimeTarget(target = null) {
        const tgt = target || this.currentTarget();
        const st = this.activeState();
        if (!this.realtime || !this.liveAvailable || !tgt || tgt.media_kind === 'video' || !tgt.item_id) return false;
        if (this._loadAbort) this._loadAbort.abort();
        const ac = new AbortController();
        this._loadAbort = ac;

        let res;
        if (tgt.is_multitrack && tgt.realtime_graph) {
            const graph = this.buildRealtimeMultitrackGraph(tgt, st);
            res = await this.realtime.loadCanonical({
                graph,
                projectId: this.session?.project_id ?? null,
                signal: ac.signal,
            });
        } else {
            res = await this.realtime.previewItem(Number(tgt.item_id), { play: false, signal: ac.signal });
        }

        if (ac.signal.aborted || res?.aborted) return false;
        if (res?.ok) {
            this.liveLoadedTargetKey = tgt.id;
            if (Number.isFinite(res.duration_sec) && res.duration_sec > 0) {
                this.liveDurationSec = Number(res.duration_sec);
            }
            this.pushRealtimeParams();
            this.updateHostTrackInfo();
            window.gaiaTransport?.render?.();
            return true;
        }
        return false;
    }

    _dispatchSeekTransport(sec, playing) {
        const target = this.currentTarget();
        if (!target) return;
        const dur = Math.max(0, this.effectiveDuration(target) || this.liveDurationSec);
        const maxSeek = playing && dur > 0.05 ? Math.max(0, dur - 0.02) : dur;
        const clamped = clamp(Number(sec) || 0, 0, maxSeek);
        this._lastSeekSentAt = performance.now();
        this._pendingSeek = null;
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        this._seekLockSec = clamped;
        this._seekLockUntil = performance.now() + 130;
        this.playheadTimeSec = clamped;
        if (target.media_kind === 'video' && this.videoEl) {
            this.videoEl.currentTime = clamped;
            if (playing && this.videoEl.paused) {
                this.videoEl.play().catch(() => { });
            } else if (!playing && !this.videoEl.paused) {
                this.videoEl.pause();
            }
        } else if (this.isRealtimeReady(target)) {
            this.livePlaying = Boolean(playing);
            this.realtime.setTransport({
                playing: Boolean(playing),
                seekSec: clamped,
                loop: false,
            });
        } else if (this.liveAvailable && this.realtime) {
            // Native realtime engine is loading; avoid spawning competing HTML5 fallback audio
            this.livePlaying = false;
        } else if (playing) {
            void this.startFallbackPlayback(clamped, null);
        } else {
            this.pauseFallbackPlayback(clamped);
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

    _scrubTo(sec, wasPlaying) {
        const target = this.currentTarget();
        if (!target || target.media_kind === 'video') return;
        this._auditionStopSec = null;
        this.playheadTimeSec = sec;
        this._scheduleSeekTransport(sec, true, { immediate: false, breathMs: 45 });
        if (this._scrubIdlePauseTimer) window.clearTimeout(this._scrubIdlePauseTimer);
        if (!wasPlaying) {
            this._scrubIdlePauseTimer = window.setTimeout(() => {
                this._scrubIdlePauseTimer = null;
                if (this.dragState && !this.dragState.wasPlaying) {
                    this._dispatchSeekTransport(this.playheadTimeSec, false);
                }
            }, 170);
        }
    }

    hydrateSessionState(session) {
        const sdata = session?.session_data || {};
        this.targetsState = structuredClone(sdata.targets || {});
        this.activeTargetId = session?.current_target?.id || sdata.active_target_id || session?.targets?.[0]?.id || null;
        this.selectionRange = null;
        if (this.currentTarget()) {
            const st = this.ensureTargetState(this.currentTarget());
            this.selectedCutId = st?.view?.selected_cut_id || null;
        } else {
            this.selectedCutId = null;
        }
    }

    currentTarget() {
        const list = this.session?.targets || [];
        return list.find(t => t.id === this.activeTargetId) || this.session?.current_target || list[0] || null;
    }

    totalFramesFor(target) {
        if (!target) return 0;
        if (target.media_kind === 'video') {
            const dur = this.effectiveDuration(target);
            return dur > 0 ? Math.max(1, Math.round(dur * 1000)) : 0;
        }
        if (target.frames) return Number(target.frames);
        const sr = Number(target.sample_rate) || 44100;
        const dur = Number(target.duration_seconds) || 0;
        return Math.round(dur * sr);
    }

    sampleRateFor(target) {
        if (!target) return 44100;
        if (target.media_kind === 'video') return 1000;
        return Number(target.sample_rate) || 44100;
    }

    effectiveDuration(target) {
        if (!target) return 0;
        if (target.media_kind === 'video' && this.videoEl && Number.isFinite(this.videoEl.duration) && this.videoEl.duration > 0) {
            return this.videoEl.duration;
        }
        if (Number.isFinite(target.duration_seconds) && target.duration_seconds > 0) {
            return Number(target.duration_seconds);
        }
        if (this.liveDurationSec > 0) {
            return this.liveDurationSec;
        }
        return 0;
    }

    ensureTargetState(target) {
        if (!target) return null;
        const tid = target.id;
        let existing = this.targetsState[tid];
        const totalFrames = this.totalFramesFor(target);
        const sr = this.sampleRateFor(target);
        const dur = this.effectiveDuration(target);

        if (!existing) {
            existing = {
                item_id: target.item_id,
                target_id: tid,
                is_multitrack: Boolean(target.is_multitrack),
                main_start_frame: 0,
                main_end_frame: totalFrames > 0 ? totalFrames : null,
                main_start_sec: 0,
                main_end_sec: dur > 0 ? dur : null,
                cuts: [],
                pre_gain_db: 0,
                volume: 1,
                normalize: false,
                target_peak_db: -1,
                output_format: target.media_kind === 'video' ? 'mp4' : 'wav',
                view: {
                    waveform_zoom: 1,
                    view_start_frame: 0,
                    selected_cut_id: null,
                },
            };
            this.targetsState[tid] = existing;
        }

        existing.is_multitrack = Boolean(target.is_multitrack);

        if (totalFrames > 0) {
            if (existing.main_start_frame == null) existing.main_start_frame = Math.round((existing.main_start_sec || 0) * sr);
            if (existing.main_end_frame == null || existing.main_end_frame <= 0) {
                existing.main_end_frame = existing.main_end_sec ? Math.round(existing.main_end_sec * sr) : totalFrames;
            }
            existing.main_start_frame = clamp(Math.round(existing.main_start_frame), 0, Math.max(0, totalFrames - 1));
            existing.main_end_frame = clamp(Math.round(existing.main_end_frame), existing.main_start_frame + 1, totalFrames);
            existing.main_start_sec = existing.main_start_frame / sr;
            existing.main_end_sec = existing.main_end_frame / sr;
        }

        if (target.is_multitrack) {
            const prevById = new Map(
                (Array.isArray(existing.layers) ? existing.layers : []).map(l => [Number(l.item_id), l])
            );
            existing.layers = (target.layers || []).map(dl => {
                const prev = prevById.get(Number(dl.item_id));
                return {
                    item_id: Number(dl.item_id),
                    pre_gain_db: prev != null && Number.isFinite(Number(prev.pre_gain_db))
                        ? Number(prev.pre_gain_db)
                        : Number(dl.pre_gain_db ?? 0),
                    volume: prev != null && Number.isFinite(Number(prev.volume))
                        ? clamp(Number(prev.volume), 0, 1)
                        : clamp(Number(dl.volume ?? 1), 0, 1),
                    muted: prev != null && prev.muted !== undefined
                        ? Boolean(prev.muted)
                        : Boolean(dl.default_muted ?? dl.muted ?? false),
                    solo: prev != null && prev.solo !== undefined
                        ? Boolean(prev.solo)
                        : Boolean(dl.solo ?? false),
                };
            });
        }

        existing.view = existing.view || { waveform_zoom: 1, view_start_frame: 0, selected_cut_id: null };
        existing.view.waveform_zoom = 1;
        existing.view.view_start_frame = 0;
        if (!Array.isArray(existing.cuts)) existing.cuts = [];
        return existing;
    }

    activeState() {
        const target = this.currentTarget();
        return target ? this.ensureTargetState(target) : null;
    }

    isDirty() {
        return this.dirty;
    }

    clearDirty() {
        this.dirty = false;
    }

    markDirty() {
        this.dirty = true;
        this.host?.setDirty?.(true);
    }

    getSavePayload() {
        return {
            engine: 'simple_media',
            data: {
                active_target_id: this.activeTargetId,
                targets: this.targetsState,
            },
        };
    }

    getProjectInitData() {
        const t = this.currentTarget();
        if (!t) return this.getSavePayload().data;
        const state = this.ensureTargetState(t);
        return {
            active_target_id: t.id,
            targets: { [t.id]: state },
        };
    }

    async handleTargetSelect(targetId) {
        if (!targetId || targetId === this.activeTargetId) return;
        const exists = (this.session?.targets || []).some(t => t.id === targetId);
        if (!exists) return;
        this.stopPlayback(false);
        this.cleanupMediaElements();
        if (this._waveformAbort) {
            this._waveformAbort.abort();
            this._waveformAbort = null;
        }
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.activeTargetId = targetId;
        this.selectionRange = null;
        this.selectedCutId = this.activeState()?.view?.selected_cut_id || null;
        this.overviewWaveform = null;
        this.layerWaveforms.clear();
        this.summedPeaks = [];
        this.liveLoadedTargetKey = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this._auditionStopSec = null;
        this._waveDirty = true;
        this._cachedCanvasW = 0;
        this._cachedCanvasH = 0;
        this.playheadTimeSec = this.activeState()?.main_start_sec || 0;
        this.renderShell();
        this.bindEvents();
        this.registerTransport();
        await this.loadActiveTargetAssets();
        if (this.currentTarget()?.media_kind !== 'video') {
            void this.initRealtimeEngine();
        }
    }

    cleanupMediaElements() {
        if (this._fallbackRaf !== null) {
            window.cancelAnimationFrame(this._fallbackRaf);
            this._fallbackRaf = null;
        }
        this._fallbackStopSec = null;
        if (this.audioFallbackEl) {
            try {
                this.audioFallbackEl.pause();
                this.audioFallbackEl.removeAttribute('src');
            } catch { /* ignore */ }
            this.audioFallbackEl = null;
        }
        for (const entry of this.audioFallbackLayers) {
            try {
                entry.audio.pause();
                entry.audio.removeAttribute('src');
                entry.sourceNode?.disconnect?.();
                entry.gainNode?.disconnect?.();
            } catch { /* ignore */ }
        }
        this.audioFallbackLayers = [];
        if (this._fallbackMasterGain) {
            try { this._fallbackMasterGain.disconnect(); } catch { /* ignore */ }
            this._fallbackMasterGain = null;
        }
        if (this._fallbackAudioCtx) {
            try { void this._fallbackAudioCtx.close(); } catch { /* ignore */ }
            this._fallbackAudioCtx = null;
        }
        if (this.videoEl) {
            try {
                this.videoEl.pause();
                this.videoEl.removeAttribute('src');
            } catch { /* ignore */ }
            this.videoEl = null;
        }
    }

    renderShell() {
        if (!this.container) return;
        if (this.session?.is_empty || !this.currentTarget()) {
            this.container.innerHTML = `
                <div id="simple-empty-drop" class="sin-empty-overlay">
                    <span>Drop audio, multitracks, or video from GAIA to trim &amp; slice</span>
                </div>
            `;
            return;
        }

        const target = this.currentTarget();
        const st = this.activeState();
        const isVideo = target.media_kind === 'video';
        const isMultitrack = !isVideo && Boolean(target.is_multitrack);
        const isProject = this.session?.persistence === 'project';
        const hasAudio = !isVideo || Boolean(target.has_audio);

        let stageHtml;
        if (isVideo) {
            stageHtml = `
                <div class="simple-video-stage">
                    <div class="simple-video-frame">
                        <video id="simple-video-player" preload="metadata" playsinline></video>
                    </div>
                    <div class="simple-video-timeline-wrap">
                        <canvas id="simple-video-timeline" aria-label="Video timeline — click and drag to select cut area"></canvas>
                    </div>
                </div>
            `;
        } else if (isMultitrack) {
            const descById = new Map((target.layers || []).map(l => [Number(l.item_id), l]));
            const layers = st.layers || [];
            const rowsHtml = layers.map(layer => {
                const desc = descById.get(Number(layer.item_id)) || {};
                const effMuted = this.isLayerEffectivelyMuted(layer, layers);
                const db = Number(layer.pre_gain_db || 0);
                return `
                    <div class="simple-mt-layer-row${effMuted ? ' is-muted' : ''}${layer.solo ? ' is-solo' : ''}" data-layer-id="${layer.item_id}" role="listitem">
                        <div class="simple-mt-layer-wave-wrap">
                            <canvas class="simple-mt-layer-canvas" data-layer-canvas="${layer.item_id}" aria-label="${escapeHtml(desc.label || `Track ${layer.item_id}`)} waveform"></canvas>
                        </div>
                        <div class="simple-mt-layer-controls">
                            <span class="simple-mt-layer-name" title="${escapeHtml(desc.label || desc.filename || '')}">${escapeHtml(desc.label || desc.filename || `Track ${layer.item_id}`)}</span>
                            ${desc.is_mixdown ? '<span class="sin-mixdown-tag" title="Mixdown reference track">MIX</span>' : ''}
                            <button class="sin-mixer-flag simple-mt-flag${layer.muted ? ' active is-mute' : ''}" type="button" data-layer-mute="${layer.item_id}" aria-pressed="${Boolean(layer.muted)}" title="Mute track">M</button>
                            <button class="sin-mixer-flag simple-mt-flag${layer.solo ? ' active is-solo' : ''}" type="button" data-layer-solo="${layer.item_id}" aria-pressed="${Boolean(layer.solo)}" title="Solo track">S</button>
                            <input class="simple-mt-gain-slider" type="range" min="-24" max="24" step="0.5" value="${db}" data-layer-gain="${layer.item_id}" title="Track pre-gain (double-click to reset 0 dB)" aria-label="${escapeHtml(desc.label || 'Track')} gain">
                            <span class="simple-mt-gain-val" data-layer-gain-val="${layer.item_id}">${formatDb(db)}</span>
                        </div>
                    </div>
                `;
            }).join('');

            stageHtml = `
                <div class="simple-mt-stage">
                    <div class="simple-mt-sum-row">
                        <div class="simple-mt-sum-wave-wrap">
                            <span class="simple-mt-sum-badge" title="Sum of active multitrack layers">SUM</span>
                            <canvas id="simple-waveform-canvas" aria-label="Summed multitrack waveform — click and drag to select cut area"></canvas>
                        </div>
                        <div class="simple-mt-sum-side">
                            <div class="simple-mt-sum-head">
                                <span class="simple-mt-sum-title">Summed Mix</span>
                                <span id="simple-mt-active-meta" class="simple-mt-sum-meta"></span>
                            </div>
                            <span class="simple-mt-sum-hint">Drag waveform to select &amp; scrub</span>
                            <div class="simple-mt-sum-actions">
                                <button id="simple-mt-clear-solo" class="secondary micro-btn hidden" type="button" title="Clear solo">Un-solo</button>
                                <button id="simple-mt-unmute-all" class="secondary micro-btn hidden" type="button" title="Unmute all tracks">Unmute</button>
                            </div>
                        </div>
                    </div>
                    <div id="simple-mt-layers" class="simple-mt-layers" role="list" aria-label="Multitrack stem layers">
                        ${rowsHtml}
                    </div>
                </div>
            `;
        } else {
            stageHtml = `
                <div class="media-editor-waveform simple-wave-stage">
                    <div class="media-editor-waveform-main simple-wave-main">
                        <canvas id="simple-waveform-canvas" aria-label="Waveform — click and drag to select cut area"></canvas>
                    </div>
                </div>
            `;
        }

        this.container.innerHTML = `
            <div class="simple-media-shell${isMultitrack ? ' is-multitrack' : ''}">
                ${stageHtml}
                <div class="media-editor-toolbar">
                    <div class="media-editor-toolbar-left">
                        <button id="simple-add-cut" class="secondary micro-btn" type="button" title="Create global cut from selected area or trim">Cut</button>
                        <button id="simple-split-2" class="secondary micro-btn" type="button" title="Split selected area or main range into 2 global cuts">÷2</button>
                        <button id="simple-split-4" class="secondary micro-btn" type="button" title="Split selected area or main range into 4 global cuts">÷4</button>
                        <span class="simple-range-chip" id="simple-range-summary"></span>
                    </div>
                    <div class="media-editor-toolbar-right">
                        ${!isVideo ? `
                            <label class="simple-inline-control" title="${isMultitrack ? 'Sum pre-gain' : 'Pre-gain'} (double-click to reset 0 dB)">${isMultitrack ? 'Sum' : 'Gain'}
                                <input id="simple-pre-gain" type="range" min="-24" max="24" step="0.5" value="${Number(st.pre_gain_db || 0)}">
                                <span id="simple-pre-gain-val">${formatDb(st.pre_gain_db || 0)}</span>
                            </label>
                        ` : ''}
                        ${hasAudio ? `
                            <label class="simple-inline-control" title="Output volume (double-click to reset 100%)">Vol
                                <input id="simple-volume" type="range" min="0" max="1" step="0.01" value="${Number(st.volume ?? 1)}">
                                <span id="simple-volume-val">${Math.round(Number(st.volume ?? 1) * 100)}%</span>
                            </label>
                        ` : ''}
                        ${!isVideo ? `
                            <button id="simple-normalize" class="secondary micro-btn${st.normalize ? ' active' : ''}" type="button" aria-pressed="${Boolean(st.normalize)}" title="Normalize exported output">Norm</button>
                        ` : ''}
                        <button id="simple-export-btn" class="primary micro-btn" type="button" title="${isMultitrack ? 'Export summed multitrack mix or global cuts' : 'Export trimmed media or cuts'}">Export</button>
                        ${!isVideo ? `<button id="simple-add-project-btn" class="secondary micro-btn" type="button" title="${isMultitrack ? 'Load multitrack bus layout and global cuts into a SIN project graph' : 'Load this track and cuts into a SIN project graph'}">+ SIN</button>` : ''}
                        ${isProject ? `<button id="simple-render-project-btn" class="secondary micro-btn" type="button" title="Render into current project">Render</button>` : ''}
                    </div>
                </div>
                <div id="simple-cuts-list" class="media-editor-cuts hidden"></div>
            </div>
        `;

        this.updateMultitrackLayerRowsUI();
        this.updateCutButtonState();
        this.renderRangeSummary();
        this.renderCuts();
    }

    updateMultitrackLayerRowsUI() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target?.is_multitrack || !st || !this.container) return;

        const layers = st.layers || [];
        const anySolo = layers.some(l => Boolean(l.solo));
        const anyMuted = layers.some(l => Boolean(l.muted));
        let activeCount = 0;

        for (const layer of layers) {
            const effMuted = this.isLayerEffectivelyMuted(layer, layers);
            if (!effMuted) activeCount += 1;
            const row = this.container.querySelector(`.simple-mt-layer-row[data-layer-id="${layer.item_id}"]`);
            if (!row) continue;
            row.classList.toggle('is-muted', effMuted);
            row.classList.toggle('is-solo', Boolean(layer.solo));
            const muteBtn = row.querySelector(`[data-layer-mute="${layer.item_id}"]`);
            if (muteBtn) {
                muteBtn.classList.toggle('active', Boolean(layer.muted));
                muteBtn.classList.toggle('is-mute', Boolean(layer.muted));
                muteBtn.setAttribute('aria-pressed', String(Boolean(layer.muted)));
            }
            const soloBtn = row.querySelector(`[data-layer-solo="${layer.item_id}"]`);
            if (soloBtn) {
                soloBtn.classList.toggle('active', Boolean(layer.solo));
                soloBtn.classList.toggle('is-solo', Boolean(layer.solo));
                soloBtn.setAttribute('aria-pressed', String(Boolean(layer.solo)));
            }
            const gainVal = row.querySelector(`[data-layer-gain-val="${layer.item_id}"]`);
            if (gainVal) gainVal.textContent = formatDb(layer.pre_gain_db || 0);
        }

        const metaEl = this.container.querySelector('#simple-mt-active-meta');
        if (metaEl) {
            metaEl.textContent = `${activeCount}/${layers.length} active`;
        }
        const clearSoloBtn = this.container.querySelector('#simple-mt-clear-solo');
        clearSoloBtn?.classList.toggle('hidden', !anySolo);
        const unmuteBtn = this.container.querySelector('#simple-mt-unmute-all');
        unmuteBtn?.classList.toggle('hidden', anySolo || !anyMuted);
    }

    updateCutButtonState() {
        const cutBtn = this.container?.querySelector('#simple-add-cut');
        if (!cutBtn) return;
        const hasSel = Boolean(this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame);
        cutBtn.classList.toggle('is-selection-ready', hasSel);
        cutBtn.title = hasSel
            ? `Create global cut from selection (${formatPreciseTime(this.selectionRange.startSec)}–${formatPreciseTime(this.selectionRange.endSec)})`
            : 'Create global cut from current trim range (or drag on waveform to select an area)';
    }

    updateHostTrackInfo() {
        const target = this.currentTarget();
        if (!target) {
            this.host?.setTrackInfo?.('');
            return;
        }
        const parts = [];
        if (target.media_kind === 'video') {
            if (target.width && target.height) parts.push(`${target.width}×${target.height}`);
            if (target.fps) parts.push(`${Number(target.fps).toFixed(2).replace(/\.00$/, '')} fps`);
            if (target.video_codec) parts.push(String(target.video_codec).toUpperCase());
        } else {
            if (target.is_multitrack) {
                const count = (target.layers || []).length;
                parts.push(`${count} ${count === 1 ? 'track' : 'tracks'} · Sum`);
            }
            const sr = target.sample_rate || this.overviewWaveform?.sample_rate;
            if (sr) parts.push(`${Math.round(Number(sr) / 100) / 10} kHz`);
            if (!target.is_multitrack && target.channels) {
                parts.push(target.channels === 1 ? 'Mono' : `${target.channels} ch`);
            }
        }
        const dur = this.effectiveDuration(target) || this.liveDurationSec;
        if (dur > 0) parts.push(formatPreciseTime(dur));
        this.host?.setTrackInfo?.(parts.join(' · '));
    }

    renderRangeSummary() {
        const el = this.container?.querySelector('#simple-range-summary');
        const target = this.currentTarget();
        const st = this.activeState();
        this.updateHostTrackInfo();
        if (!el || !target || !st) return;

        if (this.selectionRange && this.selectionRange.endSec > this.selectionRange.startSec) {
            const { startSec, endSec } = this.selectionRange;
            el.textContent = `Sel ${formatPreciseTime(startSec)}–${formatPreciseTime(endSec)} (${formatPreciseTime(endSec - startSec)})`;
            el.title = 'Active selection — click Cut to turn into a global cut';
            el.classList.add('is-selection');
            return;
        }
        el.classList.remove('is-selection');

        const cut = this.selectedCut();
        const dur = this.effectiveDuration(target);
        const start = cut ? (cut.start_sec ?? 0) : (st.main_start_sec ?? 0);
        const end = cut ? (cut.end_sec ?? dur) : (st.main_end_sec ?? dur);
        const total = Math.max(0, end - start);
        el.textContent = `${formatPreciseTime(start)}–${formatPreciseTime(end)} (${formatPreciseTime(total)})`;
        el.title = cut ? `Active cut: ${cut.label}` : 'Main trim range';
    }

    selectedCut() {
        const st = this.activeState();
        if (!st || !this.selectedCutId) return null;
        return (st.cuts || []).find(c => c.id === this.selectedCutId) || null;
    }

    renderCuts() {
        const listEl = this.container?.querySelector('#simple-cuts-list');
        const target = this.currentTarget();
        const st = this.activeState();
        if (!listEl || !target || !st) return;
        const cuts = st.cuts || [];
        if (!cuts.length) {
            listEl.innerHTML = '';
            listEl.classList.add('hidden');
            return;
        }
        listEl.classList.remove('hidden');
        listEl.innerHTML = cuts.map((cut, index) => {
            const active = cut.id === this.selectedCutId;
            return `
                <div class="media-cut-card${active ? ' active' : ''}" data-cut-id="${escapeHtml(cut.id)}">
                    <input class="media-cut-label" type="text" data-cut-label value="${escapeHtml(cut.label || `Cut ${index + 1}`)}" aria-label="Cut label">
                    <span class="media-cut-range">${formatPreciseTime(cut.start_sec)}–${formatPreciseTime(cut.end_sec)}</span>
                    <button class="secondary micro-btn" type="button" data-cut-play title="Play cut">▶</button>
                    <button class="secondary micro-btn" type="button" data-cut-export title="Export cut">Exp</button>
                    <button class="secondary icon-button" type="button" data-cut-delete aria-label="Delete cut" title="Delete">×</button>
                </div>
            `;
        }).join('');
    }

    recomputeSummedWaveform() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target?.is_multitrack || !st) {
            this.summedPeaks = [];
            return;
        }
        const layers = st.layers || [];
        const totalSec = this.effectiveDuration(target);
        if (!(totalSec > 0)) {
            this.summedPeaks = [];
            return;
        }

        const activeEntries = [];
        let maxCols = 0;
        for (const layer of layers) {
            if (this.isLayerEffectivelyMuted(layer, layers)) continue;
            const wf = this.layerWaveforms.get(Number(layer.item_id));
            if (!wf?.peaks?.length) continue;
            const gain = dbToLinear(layer.pre_gain_db) * clamp(Number(layer.volume ?? 1), 0, 1);
            if (gain <= 0) continue;
            const dur = Number(wf.duration_seconds) || totalSec;
            activeEntries.push({ peaks: wf.peaks, gain, dur });
            if (wf.peaks.length > maxCols) maxCols = wf.peaks.length;
        }

        const cols = clamp(maxCols || 1000, 256, 1400);
        const summed = new Array(cols);
        const transportPeaks = new Array(cols);
        const masterScale = dbToLinear(st.pre_gain_db || 0) * clamp(Number(st.volume ?? 1), 0, 1);

        for (let i = 0; i < cols; i += 1) {
            const t = ((i + 0.5) / cols) * totalSec;
            let minAcc = 0;
            let maxAcc = 0;
            for (const entry of activeEntries) {
                if (t > entry.dur) continue;
                const ratio = t / Math.max(1e-6, entry.dur);
                const idx = clamp(Math.floor(ratio * entry.peaks.length), 0, entry.peaks.length - 1);
                const pair = entry.peaks[idx];
                const lo = Array.isArray(pair) ? Number(pair[0]) : -Math.abs(Number(pair) || 0);
                const hi = Array.isArray(pair) ? Number(pair[1]) : Math.abs(Number(pair) || 0);
                minAcc += lo * entry.gain;
                maxAcc += hi * entry.gain;
            }
            summed[i] = [minAcc, maxAcc];
            transportPeaks[i] = [
                clamp(minAcc * masterScale, -1, 1),
                clamp(maxAcc * masterScale, -1, 1),
            ];
        }

        this.summedPeaks = summed;
        window.gaiaTransport?.setWaveformPeaks?.(transportPeaks, totalSec);
    }

    async loadActiveTargetAssets() {
        const target = this.currentTarget();
        if (!target) return;

        if (target.media_kind === 'video') {
            const video = this.container?.querySelector('#simple-video-player');
            this.videoEl = video;
            if (video) {
                video.src = target.stream_url;
                video.volume = clamp(Number(this.activeState()?.volume ?? 1), 0, 1);
                video.addEventListener('loadedmetadata', () => {
                    const st = this.ensureTargetState(target);
                    if (video.duration && Number.isFinite(video.duration)) {
                        target.duration_seconds = video.duration;
                        target.frames = Math.round(video.duration * 1000);
                        if (st.main_end_frame == null || st.main_end_sec == null) {
                            st.main_end_sec = video.duration;
                            st.main_end_frame = Math.round(video.duration * 1000);
                        }
                    }
                    this.renderRangeSummary();
                    this.drawVideoTimeline();
                    window.gaiaTransport?.render?.();
                });
                for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'seeked']) {
                    video.addEventListener(ev, () => {
                        if (ev === 'timeupdate' && !video.paused) {
                            const activeRange = this.playbackWindow();
                            if (activeRange.endSec > activeRange.startSec && video.currentTime >= activeRange.endSec) {
                                video.pause();
                                video.currentTime = activeRange.startSec;
                            }
                        }
                        this.playheadTimeSec = video.currentTime || 0;
                        this.drawVideoTimeline();
                        window.gaiaTransport?.render?.();
                    });
                }
                video.addEventListener('click', () => {
                    this.togglePlayPause();
                });
            }
            this.drawVideoTimeline();
            return;
        }

        if (this._waveformAbort) this._waveformAbort.abort();
        const ac = new AbortController();
        this._waveformAbort = ac;

        // Multitrack target: fetch all stem waveforms in parallel and compute summed overview
        if (target.is_multitrack) {
            const layers = target.layers || [];
            await Promise.all(layers.map(async layer => {
                if (!layer.waveform_url) return;
                try {
                    const res = await fetch(`${layer.waveform_url}?resolution=1200`, { signal: ac.signal });
                    if (!res.ok || ac.signal.aborted) return;
                    const wf = await res.json();
                    if (ac.signal.aborted) return;
                    this.layerWaveforms.set(Number(layer.item_id), wf);
                    if (!layer.frames && wf.frames) layer.frames = wf.frames;
                    if (!layer.sample_rate && wf.sample_rate) layer.sample_rate = wf.sample_rate;
                    if (!layer.duration_seconds && wf.duration_seconds) layer.duration_seconds = wf.duration_seconds;
                } catch {
                    // Ignore abort or individual stem fetch failure
                }
            }));
            if (ac.signal.aborted || this.currentTarget()?.id !== target.id) return;

            if (!target.sample_rate) {
                const firstSr = layers.find(l => l.sample_rate)?.sample_rate;
                if (firstSr) target.sample_rate = firstSr;
            }
            if (!target.duration_seconds) {
                const durs = layers.map(l => Number(l.duration_seconds) || 0).filter(d => d > 0);
                if (durs.length) target.duration_seconds = Math.min(...durs);
            }
            if (!target.frames && target.duration_seconds && target.sample_rate) {
                target.frames = Math.round(target.duration_seconds * target.sample_rate);
            }

            this.ensureTargetState(target);
            this.recomputeSummedWaveform();
            this.pushRealtimeParams();
            this.renderRangeSummary();
            this.requestDraw(true);
            window.gaiaTransport?.render?.();
            return;
        }

        // Single-file audio target
        try {
            const res = await fetch(`${target.waveform_url}?resolution=1400`, { signal: ac.signal });
            if (res.ok && !ac.signal.aborted) {
                const wf = await res.json();
                if (ac.signal.aborted || this.currentTarget()?.id !== target.id) return;
                this.overviewWaveform = wf;
                if (!target.frames && wf.frames) target.frames = wf.frames;
                if (!target.sample_rate && wf.sample_rate) target.sample_rate = wf.sample_rate;
                if (!target.duration_seconds && wf.duration_seconds) target.duration_seconds = wf.duration_seconds;
                window.gaiaTransport?.setWaveformPeaks?.(
                    wf.peaks,
                    wf.duration_seconds || wf.duration_sec || target.duration_seconds || 0
                );
                this.ensureTargetState(target);
                this.pushRealtimeParams();
                this.renderRangeSummary();
                this.requestDraw(true);
            }
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.warn('Could not fetch audio waveform:', err);
            }
        }
        window.gaiaTransport?.render?.();
    }

    visibleFrameRange() {
        const target = this.currentTarget();
        const total = Math.max(1, this.totalFramesFor(target));
        return { viewStart: 0, viewEnd: total, totalFrames: total };
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

    drawAudioWaveform() {
        const canvas = this.container?.querySelector('#simple-waveform-canvas');
        const target = this.currentTarget();
        const st = this.activeState();
        if (!canvas || !target || !st || target.media_kind === 'video') return;

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

        const { viewStart, viewEnd, totalFrames } = this.visibleFrameRange();
        const span = Math.max(1, viewEnd - viewStart);
        const frameToX = f => ((f - viewStart) / span) * w;

        // 1. Bake static waveform + trim shading + cuts + selection onto offscreen canvas ONLY when dirty
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

            // Centerline
            const midY = h / 2;
            bCtx.strokeStyle = 'rgba(255,255,255,0.06)';
            bCtx.lineWidth = 1;
            bCtx.beginPath();
            bCtx.moveTo(0, midY);
            bCtx.lineTo(w, midY);
            bCtx.stroke();

            // Waveform bars (linear master gain visual preview)
            const linearScale = dbToLinear(st.pre_gain_db || 0) * clamp(Number(st.volume ?? 1), 0, 1);
            const peaks = target.is_multitrack ? this.summedPeaks : this.overviewWaveform?.peaks;
            if (peaks?.length) {
                const wfStart = target.is_multitrack ? 0 : Number(this.overviewWaveform?.start_frame ?? 0);
                const wfEnd = target.is_multitrack ? totalFrames : Number(this.overviewWaveform?.end_frame ?? totalFrames);
                const wfSpan = Math.max(1, wfEnd - wfStart);
                const baseColor = target.is_multitrack ? '#63c5b8' : '#5da9e9';
                const clipColor = '#f7b23b';
                const pxStep = Math.max(1, Math.floor(dpr));
                for (let x = 0; x < w; x += pxStep) {
                    const frame = viewStart + (x / w) * span;
                    const ratio = (frame - wfStart) / wfSpan;
                    if (ratio < 0 || ratio >= 1) continue;
                    const pIdx = clamp(Math.floor(ratio * peaks.length), 0, peaks.length - 1);
                    const pair = peaks[pIdx];
                    const rawMin = (Array.isArray(pair) ? pair[0] : -Math.abs(pair)) * linearScale;
                    const rawMax = (Array.isArray(pair) ? pair[1] : Math.abs(pair)) * linearScale;
                    const clipped = Math.abs(rawMin) > 1.0 || Math.abs(rawMax) > 1.0;
                    const minV = clamp(rawMin, -1, 1);
                    const maxV = clamp(rawMax, -1, 1);
                    const topY = midY - maxV * (h * 0.44);
                    const botY = midY - minV * (h * 0.44);
                    bCtx.fillStyle = clipped ? clipColor : baseColor;
                    bCtx.fillRect(x, topY, pxStep, Math.max(1.25 * dpr, botY - topY));
                }
            }

            // Shade outside Main Trim
            const mainStartX = clamp(frameToX(st.main_start_frame ?? 0), 0, w);
            const mainEndX = clamp(frameToX(st.main_end_frame ?? totalFrames), 0, w);
            bCtx.fillStyle = 'rgba(8, 12, 18, 0.54)';
            if (mainStartX > 0) bCtx.fillRect(0, 0, mainStartX, h);
            if (mainEndX < w) bCtx.fillRect(mainEndX, 0, w - mainEndX, h);

            // Draw Global Cuts
            for (const cut of st.cuts || []) {
                const c1 = frameToX(cut.start_frame);
                const c2 = frameToX(cut.end_frame);
                if (c2 < 0 || c1 > w) continue;
                const active = cut.id === this.selectedCutId;
                bCtx.fillStyle = active ? 'rgba(247, 178, 59, 0.24)' : 'rgba(93, 169, 233, 0.14)';
                bCtx.fillRect(Math.max(0, c1), 0, Math.min(w, c2) - Math.max(0, c1), h);
                bCtx.strokeStyle = active ? '#f7b23b' : 'rgba(93, 169, 233, 0.52)';
                bCtx.lineWidth = active ? 1.8 * dpr : dpr;
                bCtx.strokeRect(Math.max(0, c1), 1, Math.max(2, Math.min(w, c2) - Math.max(0, c1)), h - 2);
            }

            // Draw active Drag Selection Area (global cut creation area)
            if (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame) {
                const s1 = clamp(frameToX(this.selectionRange.startFrame), 0, w);
                const s2 = clamp(frameToX(this.selectionRange.endFrame), 0, w);
                const sw = Math.max(2 * dpr, s2 - s1);
                bCtx.fillStyle = 'rgba(56, 211, 153, 0.22)';
                bCtx.fillRect(s1, 0, sw, h);
                bCtx.strokeStyle = '#38d399';
                bCtx.lineWidth = 1.6 * dpr;
                bCtx.strokeRect(s1 + 0.5, 0.5, Math.max(1, sw - 1), h - 1);
                // Side grip handles
                bCtx.fillStyle = '#38d399';
                bCtx.fillRect(s1 - 1 * dpr, 0, 2.5 * dpr, h);
                bCtx.fillRect(s2 - 1.5 * dpr, 0, 2.5 * dpr, h);
            }

            // Main Trim Brackets
            bCtx.fillStyle = 'rgba(56, 211, 153, 0.85)';
            bCtx.fillRect(mainStartX - 1.25 * dpr, 0, 2.5 * dpr, h);
            bCtx.fillRect(mainEndX - 1.25 * dpr, 0, 2.5 * dpr, h);
        }

        // 2. Blit cached waveform + cue marker + playhead & translucent scrub time pill
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this._waveBackingCanvas, 0, 0);

        const sr = this.sampleRateFor(target);
        if (window.gaiaTransport?.isCueEnabled?.()) {
            const cueSec = Number(window.gaiaTransport.getCuePoint?.() || 0);
            this._drawCueMarker(ctx, frameToX(cueSec * sr), h, dpr);
        }
        const playSec = this.currentPlaybackTimeSec();
        const playFrame = playSec * sr;
        const playX = frameToX(playFrame);
        if (playX >= 0 && playX <= w) {
            const isScrub = Boolean(this._scrubCursorPos);
            ctx.fillStyle = isScrub ? 'rgba(56, 211, 153, 0.95)' : '#ff5c5c';
            ctx.fillRect(playX - (isScrub ? 1.25 : 0.9) * dpr, 0, (isScrub ? 2.5 : 1.8) * dpr, h);

            if (isScrub) {
                const label = formatPreciseTime(playSec);
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

    drawMultitrackLayerWaveforms() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target?.is_multitrack || !st || !this.container) return;

        const layers = st.layers || [];
        const totalFrames = Math.max(1, this.totalFramesFor(target));
        const sr = this.sampleRateFor(target);
        const totalSec = Math.max(1e-6, this.effectiveDuration(target));
        const playRatio = clamp(this.currentPlaybackTimeSec() / totalSec, 0, 1);
        const dpr = Math.min(2, window.devicePixelRatio || 1);

        for (const layer of layers) {
            const canvas = this.container.querySelector(`[data-layer-canvas="${layer.item_id}"]`);
            if (!canvas) continue;
            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const w = Math.round(rect.width * dpr);
            const h = Math.round(rect.height * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);

            const midY = h / 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, midY);
            ctx.lineTo(w, midY);
            ctx.stroke();

            const effMuted = this.isLayerEffectivelyMuted(layer, layers);
            const wf = this.layerWaveforms.get(Number(layer.item_id));
            const peaks = wf?.peaks;
            if (peaks?.length) {
                const layerGain = dbToLinear(layer.pre_gain_db || 0) * clamp(Number(layer.volume ?? 1), 0, 1);
                const layerDur = Number(wf.duration_seconds) || totalSec;
                ctx.fillStyle = effMuted ? 'rgba(148, 163, 184, 0.34)' : 'rgba(93, 169, 233, 0.85)';
                const pxStep = Math.max(1, Math.floor(dpr));
                for (let x = 0; x < w; x += pxStep) {
                    const t = (x / w) * totalSec;
                    if (t > layerDur) break;
                    const pIdx = clamp(Math.floor((t / Math.max(1e-6, layerDur)) * peaks.length), 0, peaks.length - 1);
                    const pair = peaks[pIdx];
                    const minV = clamp((Array.isArray(pair) ? pair[0] : -Math.abs(pair)) * layerGain, -1, 1);
                    const maxV = clamp((Array.isArray(pair) ? pair[1] : Math.abs(pair)) * layerGain, -1, 1);
                    const topY = midY - maxV * (h * 0.44);
                    const botY = midY - minV * (h * 0.44);
                    ctx.fillRect(x, topY, pxStep, Math.max(dpr, botY - topY));
                }
            }

            // Mirror global trim shading subtly
            const msX = clamp(((st.main_start_frame ?? 0) / totalFrames) * w, 0, w);
            const meX = clamp(((st.main_end_frame ?? totalFrames) / totalFrames) * w, 0, w);
            ctx.fillStyle = 'rgba(8, 12, 18, 0.44)';
            if (msX > 0) ctx.fillRect(0, 0, msX, h);
            if (meX < w) ctx.fillRect(meX, 0, w - meX, h);

            // Mirror global cuts subtly
            for (const cut of st.cuts || []) {
                const c1 = (cut.start_frame / totalFrames) * w;
                const c2 = (cut.end_frame / totalFrames) * w;
                const active = cut.id === this.selectedCutId;
                ctx.fillStyle = active ? 'rgba(247, 178, 59, 0.16)' : 'rgba(93, 169, 233, 0.09)';
                ctx.fillRect(Math.max(0, c1), 0, Math.max(1, Math.min(w, c2) - Math.max(0, c1)), h);
            }

            // Mirror active global drag selection
            if (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame) {
                const s1 = (this.selectionRange.startFrame / totalFrames) * w;
                const s2 = (this.selectionRange.endFrame / totalFrames) * w;
                ctx.fillStyle = 'rgba(56, 211, 153, 0.22)';
                ctx.fillRect(s1, 0, Math.max(1.5 * dpr, s2 - s1), h);
            }

            // Playhead mirror
            const px = playRatio * w;
            ctx.fillStyle = this._scrubCursorPos ? 'rgba(56, 211, 153, 0.9)' : 'rgba(255, 92, 92, 0.85)';
            ctx.fillRect(px - 0.75 * dpr, 0, 1.5 * dpr, h);
        }
    }

    drawVideoTimeline() {
        const canvas = this.container?.querySelector('#simple-video-timeline');
        const target = this.currentTarget();
        const st = this.activeState();
        if (!canvas || !target || !st || target.media_kind !== 'video') return;

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

        const dur = Math.max(0.01, this.effectiveDuration(target));
        const secToX = sec => clamp((sec / dur) * w, 0, w);

        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(0, 6 * dpr, w, h - 12 * dpr);

        const s1 = secToX(st.main_start_sec ?? 0);
        const s2 = secToX(st.main_end_sec ?? dur);
        ctx.fillStyle = 'rgba(56, 211, 153, 0.16)';
        ctx.fillRect(s1, 4 * dpr, Math.max(2, s2 - s1), h - 8 * dpr);

        for (const cut of st.cuts || []) {
            const c1 = secToX(cut.start_sec);
            const c2 = secToX(cut.end_sec);
            const active = cut.id === this.selectedCutId;
            ctx.fillStyle = active ? 'rgba(247, 178, 59, 0.42)' : 'rgba(93, 169, 233, 0.28)';
            ctx.fillRect(c1, 8 * dpr, Math.max(2, c2 - c1), h - 16 * dpr);
        }

        if (this.selectionRange && this.selectionRange.endSec > this.selectionRange.startSec) {
            const sel1 = secToX(this.selectionRange.startSec);
            const sel2 = secToX(this.selectionRange.endSec);
            ctx.fillStyle = 'rgba(56, 211, 153, 0.34)';
            ctx.fillRect(sel1, 2 * dpr, Math.max(2 * dpr, sel2 - sel1), h - 4 * dpr);
            ctx.strokeStyle = '#38d399';
            ctx.lineWidth = 1.4 * dpr;
            ctx.strokeRect(sel1 + 0.5, 2 * dpr, Math.max(2 * dpr, sel2 - sel1), h - 4 * dpr);
        }

        ctx.fillStyle = '#38d399';
        ctx.fillRect(s1 - 1.5 * dpr, 0, 3 * dpr, h);
        ctx.fillRect(s2 - 1.5 * dpr, 0, 3 * dpr, h);

        if (window.gaiaTransport?.isCueEnabled?.()) {
            const cueSec = Number(window.gaiaTransport.getCuePoint?.() || 0);
            this._drawCueMarker(ctx, secToX(cueSec), h, dpr);
        }

        const px = secToX(this.currentPlaybackTimeSec());
        ctx.fillStyle = '#ff5c5c';
        ctx.fillRect(px - dpr, 0, 2 * dpr, h);
    }

    playbackWindow() {
        const target = this.currentTarget();
        const st = this.activeState();
        const dur = this.effectiveDuration(target);
        if (this.selectionRange && this.selectionRange.endSec > this.selectionRange.startSec) {
            return { startSec: this.selectionRange.startSec, endSec: this.selectionRange.endSec, bounded: true };
        }
        const cut = this.selectedCut();
        if (cut) {
            return { startSec: cut.start_sec, endSec: cut.end_sec, bounded: true };
        }
        const startSec = st?.main_start_sec ?? 0;
        const endSec = st?.main_end_sec ?? dur;
        const trimmed = startSec > 0.01 || (dur > 0 && endSec < dur - 0.02);
        return { startSec, endSec, bounded: trimmed };
    }

    isFallbackPlaying() {
        if (this.audioFallbackEl && !this.audioFallbackEl.paused && !this.audioFallbackEl.ended) {
            return true;
        }
        return this.audioFallbackLayers.some(e => !e.audio.paused && !e.audio.ended);
    }

    currentPlaybackTimeSec() {
        const target = this.currentTarget();
        if (!target) return 0;
        if (target.media_kind === 'video' && this.videoEl) {
            return this.videoEl.currentTime || 0;
        }
        if (this.isRealtimeReady(target)) {
            return this.playheadTimeSec || 0;
        }
        if (this.audioFallbackEl) {
            return this.audioFallbackEl.currentTime || 0;
        }
        if (this.audioFallbackLayers.length) {
            return this.audioFallbackLayers[0].audio.currentTime || this.playheadTimeSec || 0;
        }
        return this.playheadTimeSec || 0;
    }

    syncFallbackAudioGains() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;
        const masterGainVal = dbToLinear(st.pre_gain_db || 0) * clamp(Number(st.volume ?? 1), 0, 1);

        if (this.audioFallbackEl) {
            this.audioFallbackEl.volume = clamp(Number(st.volume ?? 1), 0, 1);
        }
        if (this._fallbackMasterGain) {
            this._fallbackMasterGain.gain.value = masterGainVal;
        }
        if (this.audioFallbackLayers.length && Array.isArray(st.layers)) {
            const byId = new Map(st.layers.map(l => [Number(l.item_id), l]));
            for (const entry of this.audioFallbackLayers) {
                const layer = byId.get(entry.itemId);
                if (!layer) continue;
                const effMuted = this.isLayerEffectivelyMuted(layer, st.layers);
                const g = effMuted ? 0 : dbToLinear(layer.pre_gain_db || 0) * clamp(Number(layer.volume ?? 1), 0, 1);
                if (entry.gainNode) {
                    entry.gainNode.gain.value = g;
                } else {
                    entry.audio.muted = effMuted;
                    entry.audio.volume = clamp(g * masterGainVal, 0, 1);
                }
            }
        }
    }

    async startFallbackPlayback(fromSec, toSec = null) {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;

        this._fallbackStopSec = toSec;

        if (target.is_multitrack) {
            if (!this.audioFallbackLayers.length) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (AudioCtx) {
                    try {
                        this._fallbackAudioCtx = new AudioCtx();
                        this._fallbackMasterGain = this._fallbackAudioCtx.createGain();
                        this._fallbackMasterGain.connect(this._fallbackAudioCtx.destination);
                    } catch {
                        this._fallbackAudioCtx = null;
                        this._fallbackMasterGain = null;
                    }
                }
                for (const desc of target.layers || []) {
                    if (!desc.stream_url) continue;
                    const audio = new Audio(desc.stream_url);
                    audio.preload = 'auto';
                    let sourceNode = null;
                    let gainNode = null;
                    if (this._fallbackAudioCtx && this._fallbackMasterGain) {
                        try {
                            sourceNode = this._fallbackAudioCtx.createMediaElementSource(audio);
                            gainNode = this._fallbackAudioCtx.createGain();
                            sourceNode.connect(gainNode);
                            gainNode.connect(this._fallbackMasterGain);
                        } catch {
                            sourceNode = null;
                            gainNode = null;
                        }
                    }
                    this.audioFallbackLayers.push({ itemId: Number(desc.item_id), audio, sourceNode, gainNode });
                }
            }
            if (this._fallbackAudioCtx?.state === 'suspended') {
                await this._fallbackAudioCtx.resume().catch(() => { });
            }
            this.syncFallbackAudioGains();
            for (const entry of this.audioFallbackLayers) {
                try {
                    entry.audio.currentTime = fromSec;
                } catch { /* ignore */ }
            }
            await Promise.all(this.audioFallbackLayers.map(e => e.audio.play().catch(() => { })));
            this.playheadTimeSec = fromSec;
            this._startFallbackTicker();
            window.gaiaTransport?.render?.();
            return;
        }

        if (!this.audioFallbackEl) {
            const audio = new Audio(target.stream_url);
            this.audioFallbackEl = audio;
            audio.addEventListener('timeupdate', () => {
                if (this._fallbackStopSec !== null && audio.currentTime >= this._fallbackStopSec) {
                    audio.pause();
                    this._fallbackStopSec = null;
                    window.gaiaTransport?.render?.();
                    return;
                }
                this.playheadTimeSec = audio.currentTime;
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            });
            audio.addEventListener('ended', () => window.gaiaTransport?.render?.());
        }
        this.audioFallbackEl.volume = clamp(Number(st.volume ?? 1), 0, 1);
        this.audioFallbackEl.currentTime = fromSec;
        try {
            await this.audioFallbackEl.play();
        } catch (err) {
            console.warn('Fallback <audio> playback failed:', err);
        }
        window.gaiaTransport?.render?.();
    }

    pauseFallbackPlayback(seekSec = null) {
        if (this._fallbackRaf !== null) {
            window.cancelAnimationFrame(this._fallbackRaf);
            this._fallbackRaf = null;
        }
        this._fallbackStopSec = null;
        if (this.audioFallbackEl) {
            try {
                this.audioFallbackEl.pause();
                if (seekSec !== null) this.audioFallbackEl.currentTime = seekSec;
            } catch { /* ignore */ }
        }
        for (const entry of this.audioFallbackLayers) {
            try {
                entry.audio.pause();
                if (seekSec !== null) entry.audio.currentTime = seekSec;
            } catch { /* ignore */ }
        }
    }

    _startFallbackTicker() {
        if (this._fallbackRaf !== null) return;
        const tick = () => {
            this._fallbackRaf = null;
            if (!this.audioFallbackLayers.length || !this.isFallbackPlaying()) {
                window.gaiaTransport?.render?.();
                return;
            }
            const cur = this.audioFallbackLayers[0].audio.currentTime || 0;
            this.playheadTimeSec = cur;
            if (this._fallbackStopSec !== null && cur >= this._fallbackStopSec) {
                this.pauseFallbackPlayback(this._fallbackStopSec);
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
                return;
            }
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
            this._fallbackRaf = window.requestAnimationFrame(tick);
        };
        this._fallbackRaf = window.requestAnimationFrame(tick);
    }

    async startAudioPlayback(startSec = null, endSec = null) {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;

        const win = this.playbackWindow();
        const fromSec = startSec !== null
            ? startSec
            : clamp(this.playheadTimeSec, win.startSec, Math.max(win.startSec, win.endSec - 0.02));
        const toSec = endSec !== null ? endSec : (win.bounded ? win.endSec : null);

        // Primary path: native C++ libsin_dsp (< 5 ms start, zero HTTP download, lockstep multitrack streaming!)
        if (this.liveAvailable && this.realtime && target.item_id) {
            if (!this.isRealtimeReady(target)) {
                await this.syncRealtimeTarget(target);
            }
            if (this.isRealtimeReady(target)) {
                this.pushRealtimeParams();
                this.playheadTimeSec = fromSec;
                this.livePlaying = true;
                this._seekLockSec = fromSec;
                this._seekLockUntil = performance.now() + 130;
                this._auditionStopSec = (toSec !== null && toSec > fromSec) ? toSec : null;
                if (toSec !== null && toSec > fromSec) {
                    this.realtime.setAudition({
                        active: true,
                        nodeId: null,
                        startSec: fromSec,
                        endSec: toSec,
                    });
                } else {
                    this.realtime.setTransport({
                        playing: true,
                        seekSec: fromSec,
                        loop: false,
                    });
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
                return;
            }
        }

        // Fallback when native libsin_dsp is unavailable
        await this.startFallbackPlayback(fromSec, toSec);
    }

    stopPlayback(resetPlayhead = true, { fromUser = false } = {}) {
        const target = this.currentTarget();
        const win = this.playbackWindow();
        const dur = Math.max(0, this.effectiveDuration(target) || this.liveDurationSec);
        const cueOn = Boolean(fromUser && resetPlayhead && window.gaiaTransport?.isCueEnabled?.());
        const rawCue = clamp(Number(window.gaiaTransport?.getCuePoint?.() || 0), 0, dur);
        let resetSec = win.startSec || 0;
        if (cueOn) {
            const isCurrentlyPlaying = target?.media_kind === 'video'
                ? Boolean(this.videoEl && !this.videoEl.paused && !this.videoEl.ended)
                : Boolean((this.isRealtimeReady(target) && this.livePlaying) || this.isFallbackPlaying());
            const alreadyStoppedAtCue = !isCurrentlyPlaying && Math.abs(this.currentPlaybackTimeSec() - rawCue) <= 0.05;
            if (alreadyStoppedAtCue) {
                resetSec = win.startSec || 0;
                window.gaiaTransport?.setCuePoint?.(resetSec);
            } else {
                resetSec = rawCue;
            }
        }
        this._auditionStopSec = null;
        if (this.liveAvailable && this.realtime && (this.livePlaying || resetPlayhead)) {
            this.livePlaying = false;
            const seekTarget = resetPlayhead ? resetSec : -1;
            if (resetPlayhead) {
                this.playheadTimeSec = seekTarget;
                this._seekLockSec = seekTarget;
                this._seekLockUntil = performance.now() + 130;
            }
            this.realtime.setTransport({ playing: false, seekSec: seekTarget });
        }
        this.pauseFallbackPlayback(resetPlayhead ? resetSec : null);
        if (this.videoEl) {
            try {
                this.videoEl.pause();
                if (resetPlayhead) {
                    this.videoEl.currentTime = resetSec;
                }
            } catch { /* ignore */ }
        }
        if (resetPlayhead) {
            this.playheadTimeSec = resetSec;
        }
        this.requestDraw(false);
        window.gaiaTransport?.render?.();
    }

    togglePlayPause() {
        const target = this.currentTarget();
        if (!target) return;
        const cueOn = Boolean(window.gaiaTransport?.isCueEnabled?.());
        const win = this.playbackWindow();
        const dur = Math.max(0, this.effectiveDuration(target) || this.liveDurationSec);
        const cueSec = clamp(Number(window.gaiaTransport?.getCuePoint?.() || 0), 0, dur);

        if (target.media_kind === 'video' && this.videoEl) {
            if (this.videoEl.paused || this.videoEl.ended) {
                if (cueOn) {
                    this.videoEl.currentTime = cueSec;
                    this.playheadTimeSec = cueSec;
                } else if (this.videoEl.currentTime < win.startSec || this.videoEl.currentTime >= win.endSec) {
                    this.videoEl.currentTime = win.startSec;
                }
                this.videoEl.play().catch(() => { });
            } else {
                this.videoEl.pause();
                if (cueOn) {
                    this.videoEl.currentTime = cueSec;
                    this.playheadTimeSec = cueSec;
                }
            }
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
            return;
        }

        if (this.isRealtimeReady(target)) {
            if (this.livePlaying) {
                this._auditionStopSec = null;
                if (cueOn) {
                    this._dispatchSeekTransport(cueSec, false);
                } else {
                    this.livePlaying = false;
                    this.realtime.setTransport({ playing: false, seekSec: -1 });
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            } else {
                const startPos = cueOn
                    ? (dur > 0.05 ? Math.min(cueSec, dur - 0.02) : cueSec)
                    : ((this.playheadTimeSec >= (win.endSec - 0.02) || this.playheadTimeSec < win.startSec)
                        ? win.startSec
                        : this.playheadTimeSec);
                const endBound = (win.bounded && startPos >= win.startSec - 0.02 && startPos < win.endSec) ? win.endSec : null;
                void this.startAudioPlayback(startPos, endBound);
            }
            return;
        }

        if (this.isFallbackPlaying()) {
            this.pauseFallbackPlayback(cueOn ? cueSec : null);
            if (cueOn) this.playheadTimeSec = cueSec;
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        } else {
            const startPos = cueOn ? cueSec : win.startSec;
            const endBound = win.bounded ? win.endSec : null;
            void this.startAudioPlayback(startPos, endBound);
        }
    }

    seekTo(seconds, opts = {}) {
        const target = this.currentTarget();
        if (!target) return;
        const dur = this.effectiveDuration(target) || this.liveDurationSec;
        const isPlaying = opts?.keepPlaying != null
            ? Boolean(opts.keepPlaying)
            : (target.media_kind === 'video'
                ? Boolean(this.videoEl && !this.videoEl.paused)
                : Boolean(this.livePlaying || this.isFallbackPlaying()));
        const maxSeek = isPlaying && dur > 0.05 ? Math.max(0, dur - 0.02) : Math.max(0, dur);
        const clamped = clamp(Number(seconds) || 0, 0, maxSeek);
        this._auditionStopSec = null;
        this.playheadTimeSec = clamped;
        this._scheduleSeekTransport(clamped, isPlaying, {
            immediate: !opts?.scrubbing,
            breathMs: 42,
        });
        this.requestDraw(false);
        window.gaiaTransport?.render?.();
    }

    registerTransport() {
        const self = this;
        this.transportDriver = {
            getState() {
                const target = self.currentTarget();
                if (!target) {
                    return { hasPlayback: false, playing: false, currentTime: 0, duration: 0, targets: [], activeTargetId: null };
                }
                const playing = target.media_kind === 'video'
                    ? Boolean(self.videoEl && !self.videoEl.paused && !self.videoEl.ended)
                    : Boolean((self.isRealtimeReady(target) && self.livePlaying) || self.isFallbackPlaying());
                return {
                    hasPlayback: true,
                    playing,
                    currentTime: self.currentPlaybackTimeSec(),
                    duration: self.effectiveDuration(target) || self.liveDurationSec,
                    targets: self.session?.targets || [],
                    activeTargetId: self.activeTargetId,
                };
            },
            playPause() {
                self.togglePlayPause();
            },
            stop() {
                self.stopPlayback(true, { fromUser: true });
            },
            seek(seconds, opts) {
                self.seekTo(seconds, opts);
            },
            selectTarget(targetId) {
                void self.handleTargetSelect(targetId);
            },
        };
        window.gaiaTransport?.setCustomDriver?.(this.transportDriver);
    }

    addCut() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;
        const sr = this.sampleRateFor(target);
        const total = Math.max(1, this.totalFramesFor(target));

        let startF;
        let endF;
        if (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame) {
            startF = clamp(Math.round(this.selectionRange.startFrame), 0, total - 1);
            endF = clamp(Math.round(this.selectionRange.endFrame), startF + 1, total);
            this.selectionRange = null;
        } else {
            startF = clamp(Math.round(st.main_start_frame ?? 0), 0, total - 1);
            endF = clamp(Math.round(st.main_end_frame ?? total), startF + 1, total);
        }

        const id = `cut-${Date.now().toString(36)}-${(st.cuts?.length || 0) + 1}`;
        const label = `Cut ${(st.cuts?.length || 0) + 1}`;
        const cut = {
            id,
            label,
            start_frame: startF,
            end_frame: endF,
            start_sec: startF / sr,
            end_sec: endF / sr,
        };
        st.cuts = [...(st.cuts || []), cut];
        this.selectedCutId = id;
        st.view.selected_cut_id = id;
        this.markDirty();
        this.updateCutButtonState();
        this.renderRangeSummary();
        this.renderCuts();
        this.requestDraw(true);
    }

    splitMainIntoCuts(count) {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st || count < 2) return;
        const sr = this.sampleRateFor(target);
        const total = Math.max(1, this.totalFramesFor(target));

        const srcStart = (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame)
            ? this.selectionRange.startFrame
            : (st.main_start_frame ?? 0);
        const srcEnd = (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame)
            ? this.selectionRange.endFrame
            : (st.main_end_frame ?? total);
        this.selectionRange = null;

        const startF = clamp(Math.round(srcStart), 0, Math.max(0, total - count));
        const endF = clamp(Math.round(srcEnd), startF + count, total);
        const step = (endF - startF) / count;
        const nextCuts = [];
        for (let i = 0; i < count; i += 1) {
            const c1 = Math.round(startF + i * step);
            const c2 = i === count - 1 ? endF : Math.round(startF + (i + 1) * step);
            nextCuts.push({
                id: `cut-${Date.now().toString(36)}-${i + 1}`,
                label: `part-${String(i + 1).padStart(2, '0')}`,
                start_frame: c1,
                end_frame: Math.max(c1 + 1, c2),
                start_sec: c1 / sr,
                end_sec: Math.max(c1 + 1, c2) / sr,
            });
        }
        st.cuts = nextCuts;
        this.selectedCutId = nextCuts[0]?.id || null;
        st.view.selected_cut_id = this.selectedCutId;
        this.markDirty();
        this.updateCutButtonState();
        this.renderRangeSummary();
        this.renderCuts();
        this.requestDraw(true);
    }

    openExport(segments = null, defaultMode = null) {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;
        const exportSegs = segments || (st.cuts?.length ? st.cuts : []);
        this.host?.openExportModal?.({
            session: this.session,
            target,
            stateSnapshot: st,
            segments: exportSegs,
            defaultMode,
            onExported: result => {
                if (result?.registered && this.session?.persistence === 'project') {
                    void this.host?.reloadCurrentSession?.();
                }
            },
        });
    }

    async openAddToSinProjectDialog() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st || target.media_kind !== 'audio') return;

        const dialog = document.getElementById('simple-add-to-project-dialog');
        const selectEl = document.getElementById('simple-add-project-select');
        const closeBtn = document.getElementById('simple-add-project-close');
        const cancelBtn = document.getElementById('simple-add-project-cancel');
        const form = document.getElementById('simple-add-to-project-form');
        const statusEl = document.getElementById('simple-add-project-result');
        if (!dialog || !selectEl || !form) return;

        selectEl.innerHTML = '<option value="">Loading SIN projects…</option>';
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'result hidden';
        }
        if (!dialog.open) dialog.showModal();

        try {
            const res = await fetch('/items/?limit=2000');
            const items = res.ok ? await res.json() : [];
            const sinProjects = (Array.isArray(items) ? items : []).filter(
                it => it.type === 'project' && (it.project_kind || 'audio') === 'audio' && (it.editor_engine || 'sin') === 'sin'
            );
            if (!sinProjects.length) {
                selectEl.innerHTML = '<option value="">No SIN projects found (use + Project instead)</option>';
            } else {
                selectEl.innerHTML = sinProjects.map(p =>
                    `<option value="${p.id}">${escapeHtml(p.title || `Project #${p.id}`)}</option>`
                ).join('');
            }
        } catch {
            selectEl.innerHTML = '<option value="">Could not load projects</option>';
        }

        const ac = new AbortController();
        const submitHandler = async event => {
            event.preventDefault();
            const projectId = Number(selectEl.value);
            if (!projectId) return;
            const totalFrames = Math.max(1, this.totalFramesFor(target));
            const c0 = st.main_start_frame != null ? clamp(Number(st.main_start_frame) / totalFrames, 0, 1) : 0;
            const c1 = st.main_end_frame != null ? clamp(Number(st.main_end_frame) / totalFrames, c0, 1) : 1;
            if (statusEl) {
                statusEl.textContent = target.is_multitrack
                    ? 'Adding multitrack bus layout to project SIN graph…'
                    : 'Adding track to project SIN graph…';
                statusEl.className = 'result';
            }
            try {
                const reqBody = {
                    item_id: target.item_id,
                    crop_start: c0,
                    crop_end: c1,
                    pre_gain_db: Number(st.pre_gain_db || 0),
                    volume: clamp(Number(st.volume ?? 1), 0, 1),
                    muted: false,
                    cuts: (st.cuts || []).map(c => ({
                        id: c.id,
                        label: c.label,
                        start_frame: c.start_frame,
                        end_frame: c.end_frame,
                        start_sec: c.start_sec,
                        end_sec: c.end_sec,
                    })),
                };
                if (target.is_multitrack && Array.isArray(st.layers)) {
                    reqBody.layers = st.layers.map(l => ({
                        item_id: Number(l.item_id),
                        pre_gain_db: Number(l.pre_gain_db || 0),
                        volume: clamp(Number(l.volume ?? 1), 0, 1),
                        muted: Boolean(l.muted),
                        solo: Boolean(l.solo),
                    }));
                }
                const addRes = await fetch(`/projects/${projectId}/graph/add-item`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody),
                });
                const payload = await addRes.json().catch(() => ({}));
                if (!addRes.ok) throw new Error(payload.detail || 'Could not add to project graph');
                dialog.close();
                window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
                await this.host?.openItem?.(projectId);
                this.host?.setStatus?.(`Added "${target.label}" into project SIN graph.`);
            } catch (err) {
                if (statusEl) {
                    statusEl.textContent = err.message || 'Failed to add to project';
                    statusEl.className = 'result error';
                }
            }
        };

        form.addEventListener('submit', submitHandler, { signal: ac.signal });
        closeBtn?.addEventListener('click', () => dialog.close(), { signal: ac.signal });
        cancelBtn?.addEventListener('click', () => dialog.close(), { signal: ac.signal });
        dialog.addEventListener('close', () => ac.abort(), { signal: ac.signal });
    }

    _bindGlobalAudioWaveformCanvas(canvasEl, sig) {
        if (!canvasEl) return;

        const hitTestHandle = (clientX, rect) => {
            const st = this.activeState();
            if (!st) return 'select';
            const { totalFrames } = this.visibleFrameRange();
            const frameToCssX = f => (f / Math.max(1, totalFrames)) * rect.width;
            const x = clientX - rect.left;
            if (this.selectionRange && this.selectionRange.endFrame > this.selectionRange.startFrame) {
                if (Math.abs(x - frameToCssX(this.selectionRange.startFrame)) <= 9) return 'sel-start';
                if (Math.abs(x - frameToCssX(this.selectionRange.endFrame)) <= 9) return 'sel-end';
            }
            const activeCut = this.selectedCut();
            if (activeCut && Math.abs(x - frameToCssX(activeCut.start_frame)) <= 9) return 'cut-start';
            if (activeCut && Math.abs(x - frameToCssX(activeCut.end_frame)) <= 9) return 'cut-end';
            if (Math.abs(x - frameToCssX(st.main_start_frame ?? 0)) <= 9) return 'main-start';
            if (Math.abs(x - frameToCssX(st.main_end_frame ?? totalFrames)) <= 9) return 'main-end';
            return 'select';
        };

        canvasEl.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const rect = canvasEl.getBoundingClientRect();
            if (canvasEl.id === 'simple-waveform-canvas') {
                this._cachedCanvasW = rect.width;
                this._cachedCanvasH = rect.height;
            }
            const { totalFrames } = this.visibleFrameRange();
            const sr = this.sampleRateFor(target);
            const clickFrame = clamp(Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * totalFrames), 0, totalFrames);
            const mode = hitTestHandle(event.clientX, rect);

            canvasEl.setPointerCapture(event.pointerId);
            const wasPlaying = Boolean((this.isRealtimeReady(target) && this.livePlaying) || this.isFallbackPlaying());
            const sec0 = clickFrame / sr;
            this.dragState = {
                mode,
                rect,
                totalFrames,
                anchorFrame: clickFrame,
                startX: event.clientX,
                startSec: sec0,
                moved: false,
                wasPlaying,
            };
            if (mode === 'select') {
                this._auditionStopSec = null;
                this.playheadTimeSec = sec0;
                window.gaiaTransport?.setCuePoint?.(sec0);
                this._scheduleSeekTransport(sec0, wasPlaying, { immediate: true });
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        }, sig);

        canvasEl.addEventListener('pointermove', event => {
            if (!this.dragState) {
                const rect = canvasEl.getBoundingClientRect();
                const mode = hitTestHandle(event.clientX, rect);
                canvasEl.style.cursor = mode === 'select' ? 'crosshair' : 'ew-resize';
                return;
            }
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const totalFrames = this.dragState.totalFrames || Math.max(1, this.totalFramesFor(target));
            const rect = this.dragState.rect || canvasEl.getBoundingClientRect();
            const frame = clamp(Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * totalFrames), 0, totalFrames);
            const sr = this.sampleRateFor(target);
            const sec = frame / sr;

            if (this.dragState.mode === 'select') {
                if (!this.dragState.moved && Math.abs(event.clientX - this.dragState.startX) >= 4) {
                    this.dragState.moved = true;
                    // Clear selected cut so the dragged area becomes the active focus
                    if (this.selectedCutId) {
                        this.selectedCutId = null;
                        st.view.selected_cut_id = null;
                        this.container?.querySelectorAll('#simple-cuts-list [data-cut-id]').forEach(c => c.classList.remove('active'));
                    }
                }
                if (this.dragState.moved) {
                    const sF = Math.min(this.dragState.anchorFrame, frame);
                    let eF = Math.max(this.dragState.anchorFrame, frame);
                    if (eF <= sF) eF = Math.min(totalFrames, sF + 1);
                    this.selectionRange = {
                        startFrame: sF,
                        endFrame: eF,
                        startSec: sF / sr,
                        endSec: eF / sr,
                    };
                    this._scrubCursorPos = { x: event.clientX - rect.left, sec };
                    this._scrubTo(sec, this.dragState.wasPlaying);
                    this.updateCutButtonState();
                    this.renderRangeSummary();
                    this.requestDraw(true);
                    window.gaiaTransport?.render?.();
                }
                return;
            }

            if (this.dragState.mode === 'sel-start' && this.selectionRange) {
                const nextStart = clamp(frame, 0, Math.max(0, this.selectionRange.endFrame - 1));
                this.selectionRange = {
                    ...this.selectionRange,
                    startFrame: nextStart,
                    startSec: nextStart / sr,
                };
                this._scrubCursorPos = { x: event.clientX - rect.left, sec: this.selectionRange.startSec };
                this._scrubTo(this.selectionRange.startSec, this.dragState.wasPlaying);
                this.updateCutButtonState();
                this.renderRangeSummary();
                this.requestDraw(true);
                window.gaiaTransport?.render?.();
                return;
            }

            if (this.dragState.mode === 'sel-end' && this.selectionRange) {
                const nextEnd = clamp(frame, Math.min(totalFrames, this.selectionRange.startFrame + 1), totalFrames);
                this.selectionRange = {
                    ...this.selectionRange,
                    endFrame: nextEnd,
                    endSec: nextEnd / sr,
                };
                this._scrubCursorPos = { x: event.clientX - rect.left, sec: this.selectionRange.endSec };
                this._scrubTo(this.selectionRange.endSec, this.dragState.wasPlaying);
                this.updateCutButtonState();
                this.renderRangeSummary();
                this.requestDraw(true);
                window.gaiaTransport?.render?.();
                return;
            }

            if (this.dragState.mode === 'main-start') {
                st.main_start_frame = Math.min(frame, (st.main_end_frame ?? totalFrames) - 1);
                st.main_start_sec = st.main_start_frame / sr;
                this._scrubCursorPos = { x: event.clientX - rect.left, sec: st.main_start_sec };
                this._scrubTo(st.main_start_sec, this.dragState.wasPlaying);
            } else if (this.dragState.mode === 'main-end') {
                st.main_end_frame = Math.max(frame, (st.main_start_frame ?? 0) + 1);
                st.main_end_sec = st.main_end_frame / sr;
                this._scrubCursorPos = { x: event.clientX - rect.left, sec: st.main_end_sec };
                this._scrubTo(st.main_end_sec, this.dragState.wasPlaying);
            } else {
                const cut = this.selectedCut();
                if (!cut) return;
                if (this.dragState.mode === 'cut-start') {
                    cut.start_frame = Math.min(frame, cut.end_frame - 1);
                    cut.start_sec = cut.start_frame / sr;
                    this._scrubCursorPos = { x: event.clientX - rect.left, sec: cut.start_sec };
                    this._scrubTo(cut.start_sec, this.dragState.wasPlaying);
                } else if (this.dragState.mode === 'cut-end') {
                    cut.end_frame = Math.max(frame, cut.start_frame + 1);
                    cut.end_sec = cut.end_frame / sr;
                    this._scrubCursorPos = { x: event.clientX - rect.left, sec: cut.end_sec };
                    this._scrubTo(cut.end_sec, this.dragState.wasPlaying);
                }
                const rangeSpan = this.container?.querySelector(`[data-cut-id="${CSS.escape(cut.id)}"] .media-cut-range`);
                if (rangeSpan) rangeSpan.textContent = `${formatPreciseTime(cut.start_sec)}–${formatPreciseTime(cut.end_sec)}`;
            }
            this.markDirty();
            this.renderRangeSummary();
            this.requestDraw(true);
            window.gaiaTransport?.render?.();
        }, sig);

        const finishAudioDrag = () => {
            if (!this.dragState) return;
            const ds = this.dragState;
            this.dragState = null;
            this._scrubCursorPos = null;
            if (this._scrubIdlePauseTimer) {
                window.clearTimeout(this._scrubIdlePauseTimer);
                this._scrubIdlePauseTimer = null;
            }
            if (ds.mode === 'select') {
                if (!ds.moved) {
                    // Single click clears any active selection and parks/plays at click position
                    const hadSel = Boolean(this.selectionRange);
                    this.selectionRange = null;
                    if (hadSel) {
                        this.updateCutButtonState();
                        this.renderRangeSummary();
                    }
                    window.gaiaTransport?.setCuePoint?.(ds.startSec);
                    if (!(ds.wasPlaying && this._lastServerPlaying)) {
                        this._dispatchSeekTransport(ds.startSec, ds.wasPlaying);
                    }
                    this.requestDraw(hadSel);
                } else if (this.selectionRange) {
                    window.gaiaTransport?.setCuePoint?.(this.selectionRange.startSec);
                    if (ds.wasPlaying) {
                        void this.startAudioPlayback(this.selectionRange.startSec, this.selectionRange.endSec);
                    } else {
                        this._dispatchSeekTransport(this.selectionRange.startSec, false);
                    }
                    this.requestDraw(true);
                }
                window.gaiaTransport?.render?.();
                return;
            }
            if (ds.mode === 'sel-start' || ds.mode === 'sel-end') {
                if (this.selectionRange) {
                    window.gaiaTransport?.setCuePoint?.(this.selectionRange.startSec);
                    if (ds.wasPlaying) {
                        void this.startAudioPlayback(this.selectionRange.startSec, this.selectionRange.endSec);
                    } else {
                        this._dispatchSeekTransport(this.selectionRange.startSec, false);
                    }
                }
                this.requestDraw(true);
                window.gaiaTransport?.render?.();
                return;
            }
            if (!ds.wasPlaying) {
                this._dispatchSeekTransport(this.playheadTimeSec, false);
            }
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        };

        canvasEl.addEventListener('pointerup', finishAudioDrag, sig);
        canvasEl.addEventListener('pointercancel', finishAudioDrag, sig);
    }

    bindEvents() {
        if (!this.container) return;
        const sig = { signal: this.abortController.signal };

        // Escape clears active drag selection
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.selectionRange) {
                this.selectionRange = null;
                this.updateCutButtonState();
                this.renderRangeSummary();
                this.requestDraw(true);
            }
        }, sig);

        // Empty project drag-drop
        const emptyDrop = this.container.querySelector('#simple-empty-drop');
        emptyDrop?.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
            event.preventDefault();
            emptyDrop.classList.add('is-drop-active');
        }, sig);
        emptyDrop?.addEventListener('dragleave', () => {
            emptyDrop.classList.remove('is-drop-active');
        }, sig);
        emptyDrop?.addEventListener('drop', async event => {
            emptyDrop.classList.remove('is-drop-active');
            const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
            if (!rawIds || !this.session?.project_id) return;
            event.preventDefault();
            let itemIds = [];
            try { itemIds = JSON.parse(rawIds); } catch { return; }
            if (!Array.isArray(itemIds) || !itemIds.length) return;
            try {
                const res = await fetch(`/projects/${this.session.project_id}/items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ item_ids: itemIds }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Could not add items to project');
                }
                window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
                await this.host?.reloadCurrentSession?.();
            } catch (err) {
                this.host?.setStatus?.(err.message || 'Could not add items', true);
            }
        }, sig);

        // Toolbar buttons
        this.container.querySelector('#simple-add-cut')?.addEventListener('click', () => this.addCut(), sig);
        this.container.querySelector('#simple-split-2')?.addEventListener('click', () => this.splitMainIntoCuts(2), sig);
        this.container.querySelector('#simple-split-4')?.addEventListener('click', () => this.splitMainIntoCuts(4), sig);
        this.container.querySelector('#simple-export-btn')?.addEventListener('click', () => this.openExport(), sig);
        this.container.querySelector('#simple-add-project-btn')?.addEventListener('click', () => void this.openAddToSinProjectDialog(), sig);
        this.container.querySelector('#simple-render-project-btn')?.addEventListener('click', () => this.openExport(null, 'project'), sig);

        // Multitrack quick actions (Clear solo / Unmute all)
        this.container.querySelector('#simple-mt-clear-solo')?.addEventListener('click', () => {
            const st = this.activeState();
            if (!st?.layers) return;
            for (const l of st.layers) l.solo = false;
            this.updateMultitrackLayerRowsUI();
            this.recomputeSummedWaveform();
            this.pushRealtimeParams();
            this.markDirty();
            this.requestDraw(true);
        }, sig);
        this.container.querySelector('#simple-mt-unmute-all')?.addEventListener('click', () => {
            const st = this.activeState();
            if (!st?.layers) return;
            for (const l of st.layers) l.muted = false;
            this.updateMultitrackLayerRowsUI();
            this.recomputeSummedWaveform();
            this.pushRealtimeParams();
            this.markDirty();
            this.requestDraw(true);
        }, sig);

        // Multitrack per-layer controls (Gain, Mute, Solo)
        const mtLayersEl = this.container.querySelector('#simple-mt-layers');
        mtLayersEl?.addEventListener('click', event => {
            const st = this.activeState();
            if (!st?.layers) return;
            const muteBtn = event.target.closest('[data-layer-mute]');
            if (muteBtn) {
                const lid = Number(muteBtn.dataset.layerMute);
                const layer = st.layers.find(l => Number(l.item_id) === lid);
                if (!layer) return;
                layer.muted = !layer.muted;
                this.updateMultitrackLayerRowsUI();
                this.recomputeSummedWaveform();
                this.pushRealtimeParams();
                this.markDirty();
                this.requestDraw(true);
                return;
            }
            const soloBtn = event.target.closest('[data-layer-solo]');
            if (soloBtn) {
                const lid = Number(soloBtn.dataset.layerSolo);
                const layer = st.layers.find(l => Number(l.item_id) === lid);
                if (!layer) return;
                layer.solo = !layer.solo;
                this.updateMultitrackLayerRowsUI();
                this.recomputeSummedWaveform();
                this.pushRealtimeParams();
                this.markDirty();
                this.requestDraw(true);
            }
        }, sig);

        mtLayersEl?.addEventListener('input', event => {
            const gainInput = event.target.closest('[data-layer-gain]');
            if (!gainInput) return;
            const st = this.activeState();
            if (!st?.layers) return;
            const lid = Number(gainInput.dataset.layerGain);
            const layer = st.layers.find(l => Number(l.item_id) === lid);
            if (!layer) return;
            layer.pre_gain_db = Number(gainInput.value) || 0;
            const valEl = mtLayersEl.querySelector(`[data-layer-gain-val="${lid}"]`);
            if (valEl) valEl.textContent = formatDb(layer.pre_gain_db);
            this.recomputeSummedWaveform();
            this.pushRealtimeParams();
            this.markDirty();
            this.requestDraw(true);
        }, sig);

        mtLayersEl?.addEventListener('dblclick', event => {
            const gainInput = event.target.closest('[data-layer-gain]');
            if (!gainInput) return;
            gainInput.value = '0';
            gainInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, sig);

        // Master Gain / Volume / Normalize — real-time <5ms push to libsin_dsp + double-click reset
        const preGainInput = this.container.querySelector('#simple-pre-gain');
        const preGainVal = this.container.querySelector('#simple-pre-gain-val');
        const preGainSlider = window.sinUI?.enhanceRangeSlider?.(preGainInput, {
            bipolar: true,
            defaultValue: 0,
            compact: true,
            showValue: false,
        });
        preGainInput?.addEventListener('input', () => {
            const st = this.activeState();
            if (!st) return;
            st.pre_gain_db = Number(preGainInput.value) || 0;
            if (preGainVal) preGainVal.textContent = formatDb(st.pre_gain_db);
            if (this.currentTarget()?.is_multitrack) {
                this.recomputeSummedWaveform();
            }
            this.pushRealtimeParams();
            this.markDirty();
            this.requestDraw(true);
        }, sig);
        preGainInput?.addEventListener('dblclick', () => {
            preGainInput.value = '0';
            preGainSlider?.sync?.();
            preGainInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, sig);

        const volInput = this.container.querySelector('#simple-volume');
        const volVal = this.container.querySelector('#simple-volume-val');
        const volSlider = window.sinUI?.enhanceRangeSlider?.(volInput, {
            defaultValue: 1,
            compact: true,
            showValue: false,
        });
        volInput?.addEventListener('input', () => {
            const st = this.activeState();
            if (!st) return;
            st.volume = clamp(Number(volInput.value) || 0, 0, 1);
            if (volVal) volVal.textContent = `${Math.round(st.volume * 100)}%`;
            if (this.currentTarget()?.is_multitrack) {
                this.recomputeSummedWaveform();
            }
            this.pushRealtimeParams();
            if (this.videoEl) this.videoEl.volume = st.volume;
            this.markDirty();
            this.requestDraw(true);
        }, sig);
        volInput?.addEventListener('dblclick', () => {
            volInput.value = '1';
            volSlider?.sync?.();
            volInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, sig);

        const normBtn = this.container.querySelector('#simple-normalize');
        normBtn?.addEventListener('click', () => {
            const st = this.activeState();
            if (!st) return;
            st.normalize = !st.normalize;
            normBtn.classList.toggle('active', st.normalize);
            normBtn.setAttribute('aria-pressed', String(st.normalize));
            this.markDirty();
        }, sig);

        // Bind global drag-select + scrub interaction on main waveform AND every tiny multitrack layer waveform
        const wfCanvas = this.container.querySelector('#simple-waveform-canvas');
        this._bindGlobalAudioWaveformCanvas(wfCanvas, sig);
        this.container.querySelectorAll('.simple-mt-layer-canvas').forEach(layerCanvas => {
            this._bindGlobalAudioWaveformCanvas(layerCanvas, sig);
        });

        // Video timeline interaction (supports drag-selection too!)
        const vCanvas = this.container.querySelector('#simple-video-timeline');
        vCanvas?.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const dur = Math.max(0.01, this.effectiveDuration(target));
            const rect = vCanvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const sec = clamp((x / Math.max(1, rect.width)) * dur, 0, dur);
            const secToX = s => (s / dur) * rect.width;

            let mode = 'select';
            const cut = this.selectedCut();
            if (this.selectionRange && this.selectionRange.endSec > this.selectionRange.startSec) {
                if (Math.abs(x - secToX(this.selectionRange.startSec)) <= 10) mode = 'sel-start';
                else if (Math.abs(x - secToX(this.selectionRange.endSec)) <= 10) mode = 'sel-end';
            }
            if (mode === 'select') {
                if (cut && Math.abs(x - secToX(cut.start_sec)) <= 10) mode = 'cut-start';
                else if (cut && Math.abs(x - secToX(cut.end_sec)) <= 10) mode = 'cut-end';
                else if (Math.abs(x - secToX(st.main_start_sec ?? 0)) <= 10) mode = 'main-start';
                else if (Math.abs(x - secToX(st.main_end_sec ?? dur)) <= 10) mode = 'main-end';
            }

            vCanvas.setPointerCapture(event.pointerId);
            const wasPlaying = Boolean(this.videoEl && !this.videoEl.paused && !this.videoEl.ended);
            this.dragState = { mode, wasPlaying, startX: event.clientX, startSec: sec, moved: false };
            if (mode === 'select') {
                window.gaiaTransport?.setCuePoint?.(sec);
                this.seekTo(sec, { keepPlaying: wasPlaying, scrubbing: false });
            }
        }, sig);

        vCanvas?.addEventListener('pointermove', event => {
            if (!this.dragState) return;
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const dur = Math.max(0.01, this.effectiveDuration(target));
            const rect = vCanvas.getBoundingClientRect();
            const sec = clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * dur, 0, dur);
            if (this.dragState.mode === 'select') {
                if (!this.dragState.moved && Math.abs(event.clientX - this.dragState.startX) >= 4) {
                    this.dragState.moved = true;
                    this.selectedCutId = null;
                    st.view.selected_cut_id = null;
                    this.container?.querySelectorAll('#simple-cuts-list [data-cut-id]').forEach(c => c.classList.remove('active'));
                }
                if (this.dragState.moved) {
                    const s0 = Math.min(this.dragState.startSec, sec);
                    const s1 = Math.max(this.dragState.startSec, sec);
                    this.selectionRange = {
                        startSec: s0,
                        endSec: Math.max(s0 + 0.05, s1),
                        startFrame: Math.round(s0 * 1000),
                        endFrame: Math.round(Math.max(s0 + 0.05, s1) * 1000),
                    };
                    this.seekTo(sec, { keepPlaying: true, scrubbing: true });
                    this.updateCutButtonState();
                    this.renderRangeSummary();
                    this.drawVideoTimeline();
                }
                return;
            }
            if (this.dragState.mode === 'sel-start' && this.selectionRange) {
                const s0 = Math.min(sec, this.selectionRange.endSec - 0.05);
                this.selectionRange = { ...this.selectionRange, startSec: s0, startFrame: Math.round(s0 * 1000) };
                this.seekTo(s0, { keepPlaying: this.dragState.wasPlaying, scrubbing: true });
                this.renderRangeSummary();
                this.drawVideoTimeline();
                return;
            }
            if (this.dragState.mode === 'sel-end' && this.selectionRange) {
                const s1 = Math.max(sec, this.selectionRange.startSec + 0.05);
                this.selectionRange = { ...this.selectionRange, endSec: s1, endFrame: Math.round(s1 * 1000) };
                this.seekTo(s1, { keepPlaying: this.dragState.wasPlaying, scrubbing: true });
                this.renderRangeSummary();
                this.drawVideoTimeline();
                return;
            }
            if (this.dragState.mode === 'main-start') {
                st.main_start_sec = Math.min(sec, (st.main_end_sec ?? dur) - 0.05);
                st.main_start_frame = Math.round(st.main_start_sec * 1000);
            } else if (this.dragState.mode === 'main-end') {
                st.main_end_sec = Math.max(sec, (st.main_start_sec ?? 0) + 0.05);
                st.main_end_frame = Math.round(st.main_end_sec * 1000);
            } else {
                const cut = this.selectedCut();
                if (!cut) return;
                if (this.dragState.mode === 'cut-start') {
                    cut.start_sec = Math.min(sec, cut.end_sec - 0.05);
                    cut.start_frame = Math.round(cut.start_sec * 1000);
                } else if (this.dragState.mode === 'cut-end') {
                    cut.end_sec = Math.max(sec, cut.start_sec + 0.05);
                    cut.end_frame = Math.round(cut.end_sec * 1000);
                }
                this.renderCuts();
            }
            this.markDirty();
            this.renderRangeSummary();
            this.drawVideoTimeline();
        }, sig);

        const finishVideoDrag = () => {
            if (!this.dragState) return;
            const ds = this.dragState;
            this.dragState = null;
            if (ds.mode === 'select') {
                if (!ds.moved) {
                    this.selectionRange = null;
                    this.updateCutButtonState();
                    this.renderRangeSummary();
                    window.gaiaTransport?.setCuePoint?.(ds.startSec);
                } else if (this.selectionRange) {
                    window.gaiaTransport?.setCuePoint?.(this.selectionRange.startSec);
                    if (!ds.wasPlaying && this.videoEl) {
                        this.videoEl.pause();
                        this.videoEl.currentTime = this.selectionRange.startSec;
                    }
                }
                this.drawVideoTimeline();
            }
        };
        vCanvas?.addEventListener('pointerup', finishVideoDrag, sig);
        vCanvas?.addEventListener('pointercancel', finishVideoDrag, sig);

        // Cuts list delegation
        const cutsList = this.container.querySelector('#simple-cuts-list');
        cutsList?.addEventListener('click', event => {
            const card = event.target.closest('[data-cut-id]');
            if (!card) return;
            const cutId = card.dataset.cutId;
            const st = this.activeState();
            const cut = (st?.cuts || []).find(c => c.id === cutId);
            if (!cut) return;

            if (event.target.closest('[data-cut-delete]')) {
                st.cuts = st.cuts.filter(c => c.id !== cutId);
                if (this.selectedCutId === cutId) {
                    this.selectedCutId = null;
                    st.view.selected_cut_id = null;
                }
                this.markDirty();
                this.renderRangeSummary();
                this.renderCuts();
                this.requestDraw(true);
                return;
            }
            if (event.target.closest('[data-cut-export]')) {
                this.openExport([cut]);
                return;
            }
            if (event.target.closest('[data-cut-label]')) {
                if (this.selectedCutId !== cutId) {
                    this.selectionRange = null;
                    this.selectedCutId = cutId;
                    st.view.selected_cut_id = cutId;
                    cutsList.querySelectorAll('[data-cut-id]').forEach(c => c.classList.toggle('active', c.dataset.cutId === cutId));
                    this.updateCutButtonState();
                    this.renderRangeSummary();
                    this.requestDraw(true);
                }
                return;
            }

            this.selectionRange = null;
            this.selectedCutId = cutId;
            st.view.selected_cut_id = cutId;
            cutsList.querySelectorAll('[data-cut-id]').forEach(c => c.classList.toggle('active', c.dataset.cutId === cutId));
            this.updateCutButtonState();
            this.renderRangeSummary();
            this.requestDraw(true);

            if (event.target.closest('[data-cut-play]')) {
                const target = this.currentTarget();
                if (target?.media_kind === 'video' && this.videoEl) {
                    this.videoEl.currentTime = cut.start_sec;
                    this.videoEl.play().catch(() => { });
                } else {
                    void this.startAudioPlayback(cut.start_sec, cut.end_sec);
                }
            }
        }, sig);

        cutsList?.addEventListener('input', event => {
            const labelInput = event.target.closest('[data-cut-label]');
            if (!labelInput) return;
            const card = labelInput.closest('[data-cut-id]');
            const st = this.activeState();
            const cut = (st?.cuts || []).find(c => c.id === card?.dataset.cutId);
            if (!cut) return;
            cut.label = labelInput.value;
            this.markDirty();
            this.renderRangeSummary();
        }, sig);

        // Responsive redraw
        const observeEl = wfCanvas || vCanvas;
        if (observeEl && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this._cachedCanvasW = 0;
                this._cachedCanvasH = 0;
                this.requestDraw(true);
            });
            this.resizeObserver.observe(observeEl);
        }
    }
}
