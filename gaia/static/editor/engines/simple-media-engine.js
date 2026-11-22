import { RealtimeAudioClient } from '/packages/media-client/src/realtime-client.js';
import { formatPreciseTime, formatTime } from '../transport.js';

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
        this.dirty = false;
        this.abortController = null;

        // Real-time native libsin_dsp client (primary audio path, zero HTTP PCM decode!)
        this.realtime = null;
        this.liveAvailable = false;
        this.liveLoadedItemId = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this._latestTelemetry = null;
        this._telemetryRaf = null;
        this._unsubRealtime = [];
        this._unsubCue = null;
        this._lastServerPlaying = false;
        this._loadAbort = null;

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

        // Audio waveform + lightweight HTML5 fallback state (native libsin_dsp handles primary audio)
        this.overviewWaveform = null;
        this.detailWaveform = null;
        this.detailTimer = null;
        this.audioFallbackEl = null;
        this.videoEl = null;
        this.videoTimer = null;
        this.playheadTimeSec = 0;

        // Canvas drag state
        this.dragState = null;
        this.viewDragState = null;
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
        this.liveLoadedItemId = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
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
        this.liveLoadedItemId = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.playheadTimeSec = 0;
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

    requestDraw(waveDirty = false) {
        if (waveDirty) this._waveDirty = true;
        if (this._drawRaf !== null) return;
        this._drawRaf = window.requestAnimationFrame(() => {
            this._drawRaf = null;
            this.drawAudioWaveform();
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
                                    this.playheadTimeSec = incomingSec;
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

    pushRealtimeParams() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!this.realtime || !this.liveAvailable || !target || !st || target.media_kind === 'video') return;
        if (this.liveLoadedItemId !== target.item_id) return;
        const total = Math.max(1, this.totalFramesFor(target));
        const c0 = clamp((st.main_start_frame ?? 0) / total, 0, 1);
        const c1 = clamp((st.main_end_frame ?? total) / total, c0 + 0.0001, 1);
        this.realtime.setParam('preview', 'pre_gain_db', Number(st.pre_gain_db || 0), 5);
        this.realtime.setParam('preview', 'volume', clamp(Number(st.volume ?? 1), 0, 1), 5);
        this.realtime.setParam('preview', 'crop_start', c0, 0);
        this.realtime.setParam('preview', 'crop_end', c1, 0);
    }

    async syncRealtimeTarget(target = null) {
        const tgt = target || this.currentTarget();
        if (!this.realtime || !this.liveAvailable || !tgt || tgt.media_kind === 'video' || !tgt.item_id) return false;
        if (this._loadAbort) this._loadAbort.abort();
        const ac = new AbortController();
        this._loadAbort = ac;
        const res = await this.realtime.previewItem(Number(tgt.item_id), { play: false, signal: ac.signal });
        if (ac.signal.aborted || res?.aborted) return false;
        if (res?.ok) {
            this.liveLoadedItemId = tgt.item_id;
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
        } else if (this.liveAvailable && this.realtime && this.liveLoadedItemId === target.item_id) {
            this.livePlaying = Boolean(playing);
            this.realtime.setTransport({
                playing: Boolean(playing),
                seekSec: clamped,
                loop: false,
            });
        } else if (playing) {
            void this.startAudioPlayback(clamped);
        } else if (this.audioFallbackEl) {
            this.audioFallbackEl.currentTime = clamped;
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

    hydrateSessionState(session) {
        const sdata = session?.session_data || {};
        this.targetsState = structuredClone(sdata.targets || {});
        this.activeTargetId = session?.current_target?.id || sdata.active_target_id || session?.targets?.[0]?.id || null;
        if (this.currentTarget()) {
            this.ensureTargetState(this.currentTarget());
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
        const existing = this.targetsState[tid];
        const totalFrames = this.totalFramesFor(target);
        const sr = this.sampleRateFor(target);
        const dur = this.effectiveDuration(target);

        if (!existing) {
            const init = {
                item_id: target.item_id,
                target_id: tid,
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
            this.targetsState[tid] = init;
            return init;
        }

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
        existing.view = existing.view || { waveform_zoom: 1, view_start_frame: 0, selected_cut_id: null };
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
        this.activeTargetId = targetId;
        this.selectedCutId = this.activeState()?.view?.selected_cut_id || null;
        this.overviewWaveform = null;
        this.detailWaveform = null;
        this.liveLoadedItemId = null;
        this.livePlaying = false;
        this.liveDurationSec = 0;
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
        if (this.audioFallbackEl) {
            try {
                this.audioFallbackEl.pause();
                this.audioFallbackEl.removeAttribute('src');
            } catch {
                // Ignore
            }
            this.audioFallbackEl = null;
        }
        if (this.videoEl) {
            try {
                this.videoEl.pause();
                this.videoEl.removeAttribute('src');
            } catch {
                // Ignore
            }
            this.videoEl = null;
        }
    }

    renderShell() {
        if (!this.container) return;
        if (this.session?.is_empty || !this.currentTarget()) {
            this.container.innerHTML = `
                <div id="simple-empty-drop" class="sin-empty-overlay">
                    <span>Drop audio or video from GAIA to trim &amp; slice</span>
                </div>
            `;
            return;
        }

        const target = this.currentTarget();
        const st = this.activeState();
        const isVideo = target.media_kind === 'video';
        const isProject = this.session?.persistence === 'project';
        const hasAudio = !isVideo || Boolean(target.has_audio);

        const stageHtml = isVideo
            ? `
                <div class="simple-video-stage">
                    <div class="simple-video-frame">
                        <video id="simple-video-player" preload="metadata" playsinline></video>
                    </div>
                    <div class="simple-video-timeline-wrap">
                        <canvas id="simple-video-timeline" aria-label="Video timeline"></canvas>
                    </div>
                </div>
            `
            : `
                <div class="media-editor-waveform">
                    <div class="media-editor-waveform-main">
                        <div class="media-editor-view-control" aria-label="View window">
                            <div id="simple-view-slider" class="media-editor-view" role="slider" tabindex="0" aria-label="Waveform view window">
                                <span id="simple-view-window" class="media-editor-view-window"></span>
                            </div>
                        </div>
                        <canvas id="simple-waveform-canvas" aria-label="Waveform"></canvas>
                    </div>
                </div>
            `;

        this.container.innerHTML = `
            <div class="simple-media-shell">
                ${stageHtml}
                <div class="media-editor-toolbar">
                    <div class="media-editor-toolbar-left">
                        <button id="simple-add-cut" class="secondary micro-btn" type="button" title="Add cut from current trim">Cut</button>
                        <button id="simple-split-2" class="secondary micro-btn" type="button" title="Split main range into 2 cuts">÷2</button>
                        <button id="simple-split-4" class="secondary micro-btn" type="button" title="Split main range into 4 cuts">÷4</button>
                        ${!isVideo ? `
                            <span class="media-editor-zoom-controls" aria-label="Zoom">
                                <button id="simple-zoom-out" class="secondary micro-btn" type="button" title="Zoom out">−</button>
                                <span id="simple-zoom-label" class="media-editor-zoom-label">${Math.round(st.view?.waveform_zoom || 1)}×</span>
                                <button id="simple-zoom-in" class="secondary micro-btn" type="button" title="Zoom in">+</button>
                                <button id="simple-zoom-fit" class="secondary micro-btn" type="button" title="Reset zoom">Fit</button>
                            </span>
                        ` : ''}
                        <span class="simple-range-chip" id="simple-range-summary"></span>
                    </div>
                    <div class="media-editor-toolbar-right">
                        ${!isVideo ? `
                            <label class="simple-inline-control" title="Pre-gain (double-click to reset 0 dB)">Gain
                                <input id="simple-pre-gain" type="range" min="-24" max="24" step="0.5" value="${Number(st.pre_gain_db || 0)}">
                                <span id="simple-pre-gain-val">${Number(st.pre_gain_db || 0) >= 0 ? '+' : ''}${Number(st.pre_gain_db || 0).toFixed(0)}dB</span>
                            </label>
                        ` : ''}
                        ${hasAudio ? `
                            <label class="simple-inline-control" title="Volume (double-click to reset 100%)">Vol
                                <input id="simple-volume" type="range" min="0" max="1" step="0.01" value="${Number(st.volume ?? 1)}">
                                <span id="simple-volume-val">${Math.round(Number(st.volume ?? 1) * 100)}%</span>
                            </label>
                        ` : ''}
                        ${!isVideo ? `
                            <button id="simple-normalize" class="secondary micro-btn${st.normalize ? ' active' : ''}" type="button" aria-pressed="${Boolean(st.normalize)}" title="Normalize output">Norm</button>
                        ` : ''}
                        <button id="simple-export-btn" class="primary micro-btn" type="button" title="Export trimmed media or cuts">Export</button>
                        ${!isVideo ? `<button id="simple-add-project-btn" class="secondary micro-btn" type="button" title="Load this track and cuts into a SIN project graph">+ SIN</button>` : ''}
                        ${isProject ? `<button id="simple-render-project-btn" class="secondary micro-btn" type="button" title="Render into current project">Render</button>` : ''}
                    </div>
                </div>
                <div id="simple-cuts-list" class="media-editor-cuts hidden"></div>
            </div>
        `;

        this.renderRangeSummary();
        this.renderCuts();
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
            const sr = target.sample_rate || this.overviewWaveform?.sample_rate;
            if (sr) parts.push(`${Math.round(Number(sr) / 100) / 10} kHz`);
            if (target.channels) parts.push(target.channels === 1 ? 'Mono' : `${target.channels} ch`);
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

        // Audio target
        try {
            const res = await fetch(`${target.waveform_url}?resolution=1400`);
            if (res.ok) {
                const wf = await res.json();
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
                this.updateViewSlider();
            }
        } catch (err) {
            console.warn('Could not fetch audio waveform:', err);
        }
        window.gaiaTransport?.render?.();
    }

    scheduleDetailWaveform() {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st || target.media_kind !== 'audio') return;
        const zoom = Number(st.view?.waveform_zoom || 1);
        if (zoom <= 1.05) {
            this.detailWaveform = null;
            return;
        }
        if (this.detailTimer) window.clearTimeout(this.detailTimer);
        this.detailTimer = window.setTimeout(async () => {
            const { viewStart, viewEnd } = this.visibleFrameRange();
            try {
                const res = await fetch(`${target.waveform_url}?resolution=1400&start_frame=${viewStart}&end_frame=${viewEnd}`);
                if (res.ok) {
                    this.detailWaveform = await res.json();
                    this.requestDraw(true);
                }
            } catch {
                // Ignore
            }
        }, 90);
    }

    visibleFrameRange() {
        const target = this.currentTarget();
        const st = this.activeState();
        const total = Math.max(1, this.totalFramesFor(target));
        const zoom = clamp(Number(st?.view?.waveform_zoom || 1), 1, 128);
        const span = Math.max(64, Math.floor(total / zoom));
        const maxStart = Math.max(0, total - span);
        const start = clamp(Number(st?.view?.view_start_frame || 0), 0, maxStart);
        return { viewStart: start, viewEnd: start + span, totalFrames: total };
    }

    updateViewSlider() {
        const slider = this.container?.querySelector('#simple-view-slider');
        const win = this.container?.querySelector('#simple-view-window');
        const zoomLabel = this.container?.querySelector('#simple-zoom-label');
        const st = this.activeState();
        if (zoomLabel && st) {
            zoomLabel.textContent = `${Number(st.view?.waveform_zoom || 1).toFixed(1).replace(/\.0$/, '')}×`;
        }
        if (!slider || !win) return;
        const { viewStart, viewEnd, totalFrames } = this.visibleFrameRange();
        const leftPct = (viewStart / Math.max(1, totalFrames)) * 100;
        const widthPct = Math.max(4, ((viewEnd - viewStart) / Math.max(1, totalFrames)) * 100);
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

    drawAudioWaveform() {
        const canvas = this.container?.querySelector('#simple-waveform-canvas');
        const target = this.currentTarget();
        const st = this.activeState();
        if (!canvas || !target || !st) return;

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

        // 1. Bake static waveform + trim shading + cuts onto offscreen canvas ONLY when dirty
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

            const wf = (Number(st.view?.waveform_zoom || 1) > 1.05 && this.detailWaveform?.peaks?.length)
                ? this.detailWaveform
                : this.overviewWaveform;

            // Centerline
            const midY = h / 2;
            bCtx.strokeStyle = 'rgba(255,255,255,0.06)';
            bCtx.lineWidth = 1;
            bCtx.beginPath();
            bCtx.moveTo(0, midY);
            bCtx.lineTo(w, midY);
            bCtx.stroke();

            // Waveform bars (linear gain visual preview)
            const linearScale = Math.pow(10, Number(st.pre_gain_db || 0) / 20) * Number(st.volume ?? 1);
            if (wf?.peaks?.length) {
                const wfStart = Number(wf.start_frame ?? 0);
                const wfEnd = Number(wf.end_frame ?? totalFrames);
                const wfSpan = Math.max(1, wfEnd - wfStart);
                const peaks = wf.peaks;
                bCtx.fillStyle = '#5da9e9';
                const pxStep = Math.max(1, Math.floor(dpr));
                for (let x = 0; x < w; x += pxStep) {
                    const frame = viewStart + (x / w) * span;
                    const ratio = (frame - wfStart) / wfSpan;
                    if (ratio < 0 || ratio >= 1) continue;
                    const pIdx = clamp(Math.floor(ratio * peaks.length), 0, peaks.length - 1);
                    const pair = peaks[pIdx];
                    const minV = clamp((Array.isArray(pair) ? pair[0] : -Math.abs(pair)) * linearScale, -1, 1);
                    const maxV = clamp((Array.isArray(pair) ? pair[1] : Math.abs(pair)) * linearScale, -1, 1);
                    const topY = midY - maxV * (h * 0.44);
                    const botY = midY - minV * (h * 0.44);
                    bCtx.fillRect(x, topY, pxStep, Math.max(1.25 * dpr, botY - topY));
                }
            }

            // Shade outside Main Trim
            const mainStartX = clamp(frameToX(st.main_start_frame ?? 0), 0, w);
            const mainEndX = clamp(frameToX(st.main_end_frame ?? totalFrames), 0, w);
            bCtx.fillStyle = 'rgba(8, 12, 18, 0.54)';
            if (mainStartX > 0) bCtx.fillRect(0, 0, mainStartX, h);
            if (mainEndX < w) bCtx.fillRect(mainEndX, 0, w - mainEndX, h);

            // Draw Cuts
            for (const cut of st.cuts || []) {
                const c1 = frameToX(cut.start_frame);
                const c2 = frameToX(cut.end_frame);
                if (c2 < 0 || c1 > w) continue;
                const active = cut.id === this.selectedCutId;
                bCtx.fillStyle = active ? 'rgba(247, 178, 59, 0.24)' : 'rgba(93, 169, 233, 0.13)';
                bCtx.fillRect(Math.max(0, c1), 0, Math.min(w, c2) - Math.max(0, c1), h);
                bCtx.strokeStyle = active ? '#f7b23b' : 'rgba(93, 169, 233, 0.52)';
                bCtx.lineWidth = active ? 1.8 * dpr : dpr;
                bCtx.strokeRect(Math.max(0, c1), 1, Math.max(2, Math.min(w, c2) - Math.max(0, c1)), h - 2);
            }

            // Main Trim Brackets
            bCtx.fillStyle = '#38d399';
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

    drawVideoTimeline() {
        const canvas = this.container?.querySelector('#simple-video-timeline');
        const target = this.currentTarget();
        const st = this.activeState();
        if (!canvas || !target || !st) return;

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
        ctx.fillStyle = 'rgba(56, 211, 153, 0.22)';
        ctx.fillRect(s1, 4 * dpr, Math.max(2, s2 - s1), h - 8 * dpr);

        for (const cut of st.cuts || []) {
            const c1 = secToX(cut.start_sec);
            const c2 = secToX(cut.end_sec);
            const active = cut.id === this.selectedCutId;
            ctx.fillStyle = active ? 'rgba(247, 178, 59, 0.42)' : 'rgba(93, 169, 233, 0.28)';
            ctx.fillRect(c1, 8 * dpr, Math.max(2, c2 - c1), h - 16 * dpr);
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
        const cut = this.selectedCut();
        if (cut) {
            return { startSec: cut.start_sec, endSec: cut.end_sec };
        }
        return {
            startSec: st?.main_start_sec ?? 0,
            endSec: st?.main_end_sec ?? dur,
        };
    }

    currentPlaybackTimeSec() {
        const target = this.currentTarget();
        if (!target) return 0;
        if (target.media_kind === 'video' && this.videoEl) {
            return this.videoEl.currentTime || 0;
        }
        if (this.liveAvailable && this.realtime && this.liveLoadedItemId === target.item_id) {
            return this.playheadTimeSec || 0;
        }
        if (this.audioFallbackEl) {
            return this.audioFallbackEl.currentTime || 0;
        }
        return this.playheadTimeSec || 0;
    }

    async startAudioPlayback(startSec = null, endSec = null) {
        const target = this.currentTarget();
        const st = this.activeState();
        if (!target || !st) return;

        const win = this.playbackWindow();
        const fromSec = startSec !== null ? startSec : clamp(this.playheadTimeSec, win.startSec, Math.max(win.startSec, win.endSec - 0.02));
        const toSec = endSec !== null ? endSec : win.endSec;

        // Primary path: native C++ libsin_dsp (< 5 ms start, zero HTTP download, zero browser RAM cliff!)
        if (this.liveAvailable && this.realtime && target.item_id) {
            if (this.liveLoadedItemId !== target.item_id) {
                await this.syncRealtimeTarget(target);
            }
            if (this.liveLoadedItemId === target.item_id) {
                this.pushRealtimeParams();
                this.playheadTimeSec = fromSec;
                this.livePlaying = true;
                this._seekLockSec = fromSec;
                this._seekLockUntil = performance.now() + 130;
                if (endSec !== null && toSec > fromSec) {
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

        // Lightweight fallback when native libsin_dsp is unavailable
        this.stopPlayback(false);
        const audio = new Audio(target.stream_url);
        audio.volume = clamp(Number(st.volume ?? 1), 0, 1);
        audio.currentTime = fromSec;
        this.audioFallbackEl = audio;
        audio.addEventListener('timeupdate', () => {
            if (toSec > fromSec && audio.currentTime >= toSec) {
                audio.pause();
                window.gaiaTransport?.render?.();
                return;
            }
            this.playheadTimeSec = audio.currentTime;
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        });
        audio.addEventListener('ended', () => window.gaiaTransport?.render?.());
        try {
            await audio.play();
        } catch (err) {
            console.warn('Fallback <audio> playback failed:', err);
        }
        window.gaiaTransport?.render?.();
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
                : Boolean(
                    (this.liveAvailable && this.liveLoadedItemId === target?.item_id && this.livePlaying)
                    || (this.audioFallbackEl && !this.audioFallbackEl.paused)
                );
            const alreadyStoppedAtCue = !isCurrentlyPlaying && Math.abs(this.currentPlaybackTimeSec() - rawCue) <= 0.05;
            if (alreadyStoppedAtCue) {
                resetSec = win.startSec || 0;
                window.gaiaTransport?.setCuePoint?.(resetSec);
            } else {
                resetSec = rawCue;
            }
        }
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
        if (this.audioFallbackEl) {
            try {
                this.audioFallbackEl.pause();
                if (resetPlayhead) this.audioFallbackEl.currentTime = resetSec;
            } catch {
                // Ignore
            }
        }
        if (this.videoEl) {
            try {
                this.videoEl.pause();
                if (resetPlayhead) {
                    this.videoEl.currentTime = resetSec;
                }
            } catch {
                // Ignore
            }
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
        if (this.liveAvailable && this.realtime && this.liveLoadedItemId === target.item_id) {
            if (this.livePlaying) {
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
                const cutEnd = (this.selectedCut() && startPos >= win.startSec && startPos < win.endSec) ? win.endSec : null;
                void this.startAudioPlayback(startPos, cutEnd);
            }
            return;
        }
        if (this.audioFallbackEl && !this.audioFallbackEl.paused) {
            this.audioFallbackEl.pause();
            if (cueOn) {
                this.audioFallbackEl.currentTime = cueSec;
                this.playheadTimeSec = cueSec;
            }
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        } else {
            const startPos = cueOn ? cueSec : null;
            void this.startAudioPlayback(startPos);
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
                : Boolean(this.livePlaying || (this.audioFallbackEl && !this.audioFallbackEl.paused)));
        const maxSeek = isPlaying && dur > 0.05 ? Math.max(0, dur - 0.02) : Math.max(0, dur);
        const clamped = clamp(Number(seconds) || 0, 0, maxSeek);
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
                    : Boolean(
                        (self.liveAvailable && self.liveLoadedItemId === target.item_id && self.livePlaying)
                        || self.audioPlayback?.playing
                        || (self.audioFallbackEl && !self.audioFallbackEl.paused)
                    );
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
        const startF = clamp(Math.round(st.main_start_frame ?? 0), 0, total - 1);
        const endF = clamp(Math.round(st.main_end_frame ?? total), startF + 1, total);
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
        const startF = clamp(Math.round(st.main_start_frame ?? 0), 0, total - count);
        const endF = clamp(Math.round(st.main_end_frame ?? total), startF + count, total);
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
                selectEl.innerHTML = '<option value="">No SIN projects found (use Save as Project… instead)</option>';
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
                statusEl.textContent = 'Adding track to project SIN graph…';
                statusEl.className = 'result';
            }
            try {
                const addRes = await fetch(`/projects/${projectId}/graph/add-item`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
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
                    }),
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

    bindEvents() {
        if (!this.container) return;
        const sig = { signal: this.abortController.signal };

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

        // Gain / Volume / Normalize — real-time <5ms push to libsin_dsp + double-click reset
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
            if (preGainVal) preGainVal.textContent = `${st.pre_gain_db >= 0 ? '+' : ''}${st.pre_gain_db.toFixed(0)}dB`;
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
            this.pushRealtimeParams();
            if (this.videoEl) this.videoEl.volume = st.volume;
            if (this.audioFallbackEl) this.audioFallbackEl.volume = st.volume;
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

        // Zoom controls
        const setZoom = nextZoom => {
            const st = this.activeState();
            const target = this.currentTarget();
            if (!st || !target) return;
            const clamped = clamp(nextZoom, 1, 64);
            st.view.waveform_zoom = clamped;
            const total = Math.max(1, this.totalFramesFor(target));
            const span = Math.floor(total / clamped);
            st.view.view_start_frame = clamp(Number(st.view.view_start_frame || 0), 0, Math.max(0, total - span));
            this.updateViewSlider();
            this.requestDraw(true);
            this.scheduleDetailWaveform();
        };
        this.container.querySelector('#simple-zoom-in')?.addEventListener('click', () => {
            setZoom((this.activeState()?.view?.waveform_zoom || 1) * 2);
        }, sig);
        this.container.querySelector('#simple-zoom-out')?.addEventListener('click', () => {
            setZoom((this.activeState()?.view?.waveform_zoom || 1) / 2);
        }, sig);
        this.container.querySelector('#simple-zoom-fit')?.addEventListener('click', () => {
            if (this.activeState()?.view) this.activeState().view.view_start_frame = 0;
            setZoom(1);
        }, sig);

        // Waveform Pointer Interaction: click repositions, hold + move transparently scrubs through C++ buffer!
        const wfCanvas = this.container.querySelector('#simple-waveform-canvas');
        const hitTestAudioHandle = (clientX, rect) => {
            const st = this.activeState();
            if (!st) return 'seek';
            const { viewStart, viewEnd, totalFrames } = this.visibleFrameRange();
            const span = Math.max(1, viewEnd - viewStart);
            const frameToCssX = f => ((f - viewStart) / span) * rect.width;
            const x = clientX - rect.left;
            const activeCut = this.selectedCut();
            if (activeCut && Math.abs(x - frameToCssX(activeCut.start_frame)) <= 9) return 'cut-start';
            if (activeCut && Math.abs(x - frameToCssX(activeCut.end_frame)) <= 9) return 'cut-end';
            if (Math.abs(x - frameToCssX(st.main_start_frame ?? 0)) <= 9) return 'main-start';
            if (Math.abs(x - frameToCssX(st.main_end_frame ?? totalFrames)) <= 9) return 'main-end';
            return 'seek';
        };

        wfCanvas?.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const rect = wfCanvas.getBoundingClientRect();
            this._cachedCanvasW = rect.width;
            this._cachedCanvasH = rect.height;
            const { viewStart, viewEnd, totalFrames } = this.visibleFrameRange();
            const span = Math.max(1, viewEnd - viewStart);
            const clickFrame = clamp(Math.round(viewStart + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span), 0, totalFrames);
            const mode = hitTestAudioHandle(event.clientX, rect);

            wfCanvas.setPointerCapture(event.pointerId);
            const wasPlaying = Boolean(
                (this.liveAvailable && this.liveLoadedItemId === target.item_id && this.livePlaying)
                || this.audioPlayback?.playing
                || (this.audioFallbackEl && !this.audioFallbackEl.paused)
            );
            const sec0 = clickFrame / this.sampleRateFor(target);
            this.dragState = {
                mode,
                rect,
                totalFrames,
                startX: event.clientX,
                startSec: sec0,
                moved: false,
                wasPlaying,
            };
            if (mode === 'seek') {
                this.playheadTimeSec = sec0;
                window.gaiaTransport?.setCuePoint?.(sec0);
                this._scheduleSeekTransport(sec0, wasPlaying, { immediate: true });
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        }, sig);

        wfCanvas?.addEventListener('pointermove', event => {
            if (!this.dragState) {
                if (wfCanvas) {
                    const rect = wfCanvas.getBoundingClientRect();
                    const mode = hitTestAudioHandle(event.clientX, rect);
                    wfCanvas.style.cursor = mode === 'seek' ? 'col-resize' : 'ew-resize';
                }
                return;
            }
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const { viewStart, viewEnd, totalFrames } = this.visibleFrameRange();
            const span = Math.max(1, viewEnd - viewStart);
            const rect = this.dragState.rect || wfCanvas.getBoundingClientRect();
            const frame = clamp(Math.round(viewStart + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span), 0, totalFrames);
            const sr = this.sampleRateFor(target);

            if (this.dragState.mode === 'seek') {
                const sec = frame / sr;
                if (!this.dragState.moved && Math.abs(event.clientX - this.dragState.startX) >= 4) {
                    this.dragState.moved = true;
                }
                if (this.dragState.moved) {
                    this.playheadTimeSec = sec;
                    this._scrubCursorPos = { x: event.clientX - rect.left, sec };
                    if (this.liveAvailable && this.liveLoadedItemId === target.item_id) {
                        this._scheduleSeekTransport(sec, true, { immediate: false, breathMs: 45 });
                        if (this._scrubIdlePauseTimer) window.clearTimeout(this._scrubIdlePauseTimer);
                        if (!this.dragState.wasPlaying) {
                            this._scrubIdlePauseTimer = window.setTimeout(() => {
                                this._scrubIdlePauseTimer = null;
                                if (this.dragState?.mode === 'seek' && !this.dragState.wasPlaying) {
                                    this._dispatchSeekTransport(this.playheadTimeSec, false);
                                }
                            }, 160);
                        }
                    }
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
                return;
            }
            if (this.dragState.mode === 'main-start') {
                st.main_start_frame = Math.min(frame, (st.main_end_frame ?? totalFrames) - 1);
                st.main_start_sec = st.main_start_frame / sr;
                this.pushRealtimeParams();
            } else if (this.dragState.mode === 'main-end') {
                st.main_end_frame = Math.max(frame, (st.main_start_frame ?? 0) + 1);
                st.main_end_sec = st.main_end_frame / sr;
                this.pushRealtimeParams();
            } else {
                const cut = this.selectedCut();
                if (!cut) return;
                if (this.dragState.mode === 'cut-start') {
                    cut.start_frame = Math.min(frame, cut.end_frame - 1);
                    cut.start_sec = cut.start_frame / sr;
                } else if (this.dragState.mode === 'cut-end') {
                    cut.end_frame = Math.max(frame, cut.start_frame + 1);
                    cut.end_sec = cut.end_frame / sr;
                }
                const rangeSpan = this.container?.querySelector(`[data-cut-id="${CSS.escape(cut.id)}"] .media-cut-range`);
                if (rangeSpan) rangeSpan.textContent = `${formatPreciseTime(cut.start_sec)}–${formatPreciseTime(cut.end_sec)}`;
            }
            this.markDirty();
            this.renderRangeSummary();
            this.requestDraw(true);
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
            if (ds.mode === 'seek') {
                const cueTarget = ds.moved ? this.playheadTimeSec : ds.startSec;
                window.gaiaTransport?.setCuePoint?.(cueTarget);
                if (!(ds.wasPlaying && !ds.moved && this._lastServerPlaying)) {
                    this._dispatchSeekTransport(cueTarget, ds.wasPlaying);
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        };
        wfCanvas?.addEventListener('pointerup', finishAudioDrag, sig);
        wfCanvas?.addEventListener('pointercancel', finishAudioDrag, sig);

        wfCanvas?.addEventListener('wheel', event => {
            if (Math.abs(event.deltaY) < 1 && Math.abs(event.deltaX) < 1) return;
            event.preventDefault();
            const st = this.activeState();
            const target = this.currentTarget();
            if (!st || !target) return;
            const factor = event.deltaY < 0 ? 1.25 : 0.8;
            setZoom((st.view?.waveform_zoom || 1) * factor);
        }, { signal: this.abortController.signal, passive: false });

        // View overview slider pan
        const viewSlider = this.container.querySelector('#simple-view-slider');
        viewSlider?.addEventListener('pointerdown', event => {
            viewSlider.setPointerCapture(event.pointerId);
            this.viewDragState = true;
            this.panViewFromPointer(event, viewSlider);
        }, sig);
        viewSlider?.addEventListener('pointermove', event => {
            if (this.viewDragState) this.panViewFromPointer(event, viewSlider);
        }, sig);
        viewSlider?.addEventListener('pointerup', () => {
            this.viewDragState = false;
        }, sig);

        // Video timeline interaction
        const vCanvas = this.container.querySelector('#simple-video-timeline');
        vCanvas?.addEventListener('pointerdown', event => {
            const target = this.currentTarget();
            const st = this.activeState();
            if (!target || !st) return;
            const dur = Math.max(0.01, this.effectiveDuration(target));
            const rect = vCanvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const sec = clamp((x / Math.max(1, rect.width)) * dur, 0, dur);
            const secToX = s => (s / dur) * rect.width;

            let mode = 'seek';
            const cut = this.selectedCut();
            if (cut && Math.abs(x - secToX(cut.start_sec)) <= 10) mode = 'cut-start';
            else if (cut && Math.abs(x - secToX(cut.end_sec)) <= 10) mode = 'cut-end';
            else if (Math.abs(x - secToX(st.main_start_sec ?? 0)) <= 10) mode = 'main-start';
            else if (Math.abs(x - secToX(st.main_end_sec ?? dur)) <= 10) mode = 'main-end';

            vCanvas.setPointerCapture(event.pointerId);
            const wasPlaying = Boolean(this.videoEl && !this.videoEl.paused && !this.videoEl.ended);
            this.dragState = { mode, wasPlaying, startSec: sec };
            if (mode === 'seek') {
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
            if (this.dragState.mode === 'seek') {
                this.seekTo(sec, { keepPlaying: this.dragState.wasPlaying, scrubbing: true });
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
            if (ds.mode === 'seek') {
                window.gaiaTransport?.setCuePoint?.(this.playheadTimeSec);
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
                // Keep label text input focus undisturbed while selecting this cut
                if (this.selectedCutId !== cutId) {
                    this.selectedCutId = cutId;
                    st.view.selected_cut_id = cutId;
                    cutsList.querySelectorAll('[data-cut-id]').forEach(c => c.classList.toggle('active', c.dataset.cutId === cutId));
                    this.renderRangeSummary();
                    this.requestDraw(true);
                }
                return;
            }

            this.selectedCutId = cutId;
            st.view.selected_cut_id = cutId;
            cutsList.querySelectorAll('[data-cut-id]').forEach(c => c.classList.toggle('active', c.dataset.cutId === cutId));
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

    panViewFromPointer(event, viewSlider) {
        const st = this.activeState();
        const target = this.currentTarget();
        if (!st || !target) return;
        const rect = viewSlider.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const total = Math.max(1, this.totalFramesFor(target));
        const zoom = clamp(Number(st.view?.waveform_zoom || 1), 1, 64);
        const span = Math.floor(total / zoom);
        const nextStart = clamp(Math.round(ratio * total - span / 2), 0, Math.max(0, total - span));
        st.view.view_start_frame = nextStart;
        this.updateViewSlider();
        this.requestDraw(true);
        this.scheduleDetailWaveform();
    }
}
