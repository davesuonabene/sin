import { GraphView } from '/packages/graph-view/src/GraphView.js';
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
        this._detailAbort = null;
        this._detailGen = 0;

        // Cut-scoped bottom transport waveform state
        this._transportWfAbort = null;
        this._activeTransportWfKey = '';
        this._transportCutWaveformCache = new Map(); // key -> { peaks, duration_sec }
        this._cueTimelineSec = 0;

        // Real-time native libsin_dsp client (same-origin WS on :8001)
        this.realtime = null;
        this.liveAvailable = false;
        this.liveLoaded = false;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this.liveBusPeaks = {};
        this._planOriginSec = 0;
        this._previewOriginSec = 0;
        this._loadedMonitorSnapKey = null;
        this._auditionStopSec = null;
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
        this._scrubCursorPos = null; // { x, y, sec } while dragging playhead or handle

        // Smooth edge auto-scroll during zoomed drag
        this._autoScrollRaf = null;
        this._autoScrollClientX = 0;
        this._autoScrollLastTs = 0;

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
        this._viewDragInfo = null;
        this._suppressNextContextMenu = false;
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
        if (this._detailAbort) {
            this._detailAbort.abort();
            this._detailAbort = null;
        }
        this._detailGen += 1;
        if (this._transportWfAbort) {
            this._transportWfAbort.abort();
            this._transportWfAbort = null;
        }
        this._activeTransportWfKey = '';
        this._transportCutWaveformCache.clear();
        this._cueTimelineSec = 0;
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        if (this._scrubIdlePauseTimer) {
            window.clearTimeout(this._scrubIdlePauseTimer);
            this._scrubIdlePauseTimer = null;
        }
        this._stopEdgeAutoScroll();
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
        this._planOriginSec = 0;
        this._previewOriginSec = 0;
        this._loadedMonitorSnapKey = null;
        this._auditionStopSec = null;
        this._viewDragInfo = null;
        this._suppressNextContextMenu = false;
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
        if (this._detailAbort) {
            this._detailAbort.abort();
            this._detailAbort = null;
        }
        this._detailGen += 1;
        if (this._transportWfAbort) {
            this._transportWfAbort.abort();
            this._transportWfAbort = null;
        }
        this._activeTransportWfKey = '';
        this._transportCutWaveformCache.clear();
        this._cueTimelineSec = 0;
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        if (this._scrubIdlePauseTimer) {
            window.clearTimeout(this._scrubIdlePauseTimer);
            this._scrubIdlePauseTimer = null;
        }
        this._stopEdgeAutoScroll();
        if (this.realtime) {
            this.realtime.setTransport({ playing: false, seekSec: 0 });
        }
        this.liveLoaded = false;
        this.livePlaying = false;
        this.liveDurationSec = 0;
        this._planOriginSec = 0;
        this._previewOriginSec = 0;
        this._loadedMonitorSnapKey = null;
        this._auditionStopSec = null;
        this._viewDragInfo = null;
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
        void this.syncRealtimePlan(this.selectedSnapshot() || null, { force: true });
        if (this.activeViewMode !== 'timeline') {
            this.mountGraphView();
        }
    }

    _baseOriginSec() {
        if (!this.layers.length) return 0;
        let minStart = Infinity;
        for (const layer of this.layers) {
            const wf = this.overviewWaveforms.get(layer.item_id);
            const dur = Number(layer.duration_seconds) || Number(wf?.duration_seconds) || 0;
            if (dur <= 0) continue;
            const s0 = clamp(Number(layer.crop_start ?? 0), 0, 1) * dur;
            if (s0 < minStart) minStart = s0;
        }
        return Number.isFinite(minStart) ? minStart : 0;
    }

    engineToTimelineSec(engSec) {
        const fullDur = this.maxTimelineDurationSec();
        return clamp(this._planOriginSec + (Number(engSec) || 0), 0, fullDur);
    }

    timelineToEngineSec(tlSec) {
        const fullDur = this.maxTimelineDurationSec();
        const engDur = this.liveDurationSec > 0 ? this.liveDurationSec : Math.max(0, fullDur - this._planOriginSec);
        return clamp((Number(tlSec) || 0) - this._planOriginSec, 0, Math.max(0, engDur));
    }

    getSnapshotRangeSec(snap = this.selectedSnapshot()) {
        if (!snap?.overrides) return null;
        const ov = snap.overrides;
        const activeLayer = this.selectedLayer();
        let targetLayer = null;
        let entry = null;
        if (activeLayer && ov[activeLayer.src_node_id] && (ov[activeLayer.src_node_id].crop_start != null || ov[activeLayer.src_node_id].crop_end != null)) {
            targetLayer = activeLayer;
            entry = ov[activeLayer.src_node_id];
        } else {
            for (const layer of this.layers) {
                const candidate = ov[layer.src_node_id];
                if (candidate && (candidate.crop_start != null || candidate.crop_end != null)) {
                    targetLayer = layer;
                    entry = candidate;
                    break;
                }
            }
        }
        if (!targetLayer || !entry) return null;
        const wf = this.overviewWaveforms.get(targetLayer.item_id);
        const layerDur = Number(targetLayer.duration_seconds) || Number(wf?.duration_seconds) || this.realTimelineDurationSec();
        if (!(layerDur > 0)) return null;
        const c0 = clamp(Number(entry.crop_start ?? 0), 0, 1);
        const c1 = clamp(Number(entry.crop_end ?? 1), c0, 1);
        return {
            layer: targetLayer,
            layerDur,
            cropStart: c0,
            cropEnd: c1,
            startSec: c0 * layerDur,
            endSec: c1 * layerDur,
        };
    }

    activeTransportWindow() {
        const fullDur = this.realTimelineDurationSec() || (this.liveLoaded ? this.liveDurationSec : 0) || 0;
        const activeSnap = this.selectedSnapshot();
        const snapRange = activeSnap ? this.getSnapshotRangeSec(activeSnap) : null;
        if (snapRange && snapRange.endSec > snapRange.startSec) {
            return {
                isCut: true,
                snapshotId: activeSnap.id,
                label: activeSnap.label || activeSnap.id,
                layer: snapRange.layer,
                startSec: snapRange.startSec,
                endSec: snapRange.endSec,
                durationSec: Math.max(0.01, snapRange.endSec - snapRange.startSec),
                fullDurationSec: Math.max(fullDur, snapRange.endSec),
            };
        }
        const selected = this.selectedLayer() || this.layers[0] || null;
        return {
            isCut: false,
            snapshotId: null,
            label: selected?.label || this.session?.title || 'SIN Live',
            layer: selected,
            startSec: 0,
            endSec: fullDur,
            durationSec: fullDur,
            fullDurationSec: fullDur,
        };
    }

    timelineToTransportSec(tlSec) {
        const win = this.activeTransportWindow();
        return clamp((Number(tlSec) || 0) - win.startSec, 0, Math.max(0, win.durationSec));
    }

    transportToTimelineSec(trSec) {
        const win = this.activeTransportWindow();
        const local = clamp(Number(trSec) || 0, 0, Math.max(0, win.durationSec));
        return clamp(win.startSec + local, 0, this.maxTimelineDurationSec());
    }

    _sampleWaveformPeakAtSec(wf, sec, fallbackSr, layerDur) {
        if (!wf?.peaks?.length) return null;
        const sr = Number(wf.sample_rate || fallbackSr || 44100);
        const startF = Number(wf.start_frame ?? 0);
        const endF = Number(wf.end_frame ?? wf.frames ?? Math.round(layerDur * sr));
        if (!(endF > startF)) return null;
        const f = sec * sr;
        if (f < startF || f >= endF) return null;
        const peaks = wf.peaks;
        const bucketSize = Number(wf.bucket_size || 0);
        const pIdx = bucketSize > 0
            ? Math.floor((f - startF) / bucketSize)
            : Math.floor(((f - startF) / (endF - startF)) * peaks.length);
        if (pIdx < 0 || pIdx >= peaks.length) return null;
        return peaks[pIdx];
    }

    _sliceWaveformPeaks(wf, startSec, endSec, fallbackSr) {
        if (!wf?.peaks?.length || !(endSec > startSec)) return [];
        const sr = Number(wf.sample_rate || fallbackSr || 44100);
        const wfStartF = Number(wf.start_frame ?? 0);
        const wfEndF = Number(wf.end_frame ?? wf.frames ?? 0);
        const wfSpanF = wfEndF - wfStartF;
        if (!(wfSpanF > 0)) return wf.peaks;
        const peaks = wf.peaks;
        const bucketSize = Number(wf.bucket_size || 0);
        const sFrame = clamp(Math.floor(startSec * sr), wfStartF, wfEndF);
        const eFrame = clamp(Math.ceil(endSec * sr), sFrame + 1, wfEndF);
        let idx0;
        let idx1;
        if (bucketSize > 0) {
            idx0 = clamp(Math.floor((sFrame - wfStartF) / bucketSize), 0, peaks.length - 1);
            idx1 = clamp(Math.ceil((eFrame - wfStartF) / bucketSize), idx0 + 1, peaks.length);
        } else {
            idx0 = clamp(Math.floor(((sFrame - wfStartF) / wfSpanF) * peaks.length), 0, peaks.length - 1);
            idx1 = clamp(Math.ceil(((eFrame - wfStartF) / wfSpanF) * peaks.length), idx0 + 1, peaks.length);
        }
        return peaks.slice(idx0, idx1);
    }

    syncTransportWaveform({ fetchHiRes = true } = {}) {
        const transport = window.gaiaTransport;
        if (!transport) return;
        const win = this.activeTransportWindow();
        const layer = win.layer || this.selectedLayer() || this.layers[0];
        if (!layer) return;

        if (!win.isCut) {
            if (this._transportWfAbort) {
                this._transportWfAbort.abort();
                this._transportWfAbort = null;
            }
            const fullKey = `full:${layer.item_id}`;
            this._activeTransportWfKey = fullKey;
            const wf = this.overviewWaveforms.get(layer.item_id);
            const dur = win.durationSec || Number(wf?.duration_seconds) || Number(layer.duration_seconds) || 0;
            if (wf?.peaks?.length) {
                transport.setWaveformPeaks?.(wf.peaks, dur);
            } else if (dur > 0) {
                transport.setWaveformProgressOnly?.(dur, '');
            }
            return;
        }

        const sr = Number(layer.sample_rate || this.overviewWaveforms.get(layer.item_id)?.sample_rate || 44100);
        const totalFrames = Number(layer.frames || this.overviewWaveforms.get(layer.item_id)?.frames || Math.round(win.fullDurationSec * sr));
        const sFrame = totalFrames > 0 ? clamp(Math.floor(win.startSec * sr), 0, Math.max(0, totalFrames - 2)) : 0;
        const eFrame = totalFrames > 0 ? clamp(Math.ceil(win.endSec * sr), sFrame + 1, totalFrames) : 0;
        const cutKey = `cut:${layer.item_id}:${sFrame}:${eFrame}`;
        const cached = this._transportCutWaveformCache.get(cutKey);

        if (cached?.peaks?.length) {
            if (this._transportWfAbort) {
                this._transportWfAbort.abort();
                this._transportWfAbort = null;
            }
            this._activeTransportWfKey = cutKey;
            // Refresh LRU order
            this._transportCutWaveformCache.delete(cutKey);
            this._transportCutWaveformCache.set(cutKey, cached);
            transport.setWaveformPeaks?.(cached.peaks, win.durationSec);
            return;
        }

        // Instant 0ms cut-only slice from overview peaks so the transport updates immediately
        const overviewWf = this.overviewWaveforms.get(layer.item_id);
        const sliced = overviewWf ? this._sliceWaveformPeaks(overviewWf, win.startSec, win.endSec, sr) : [];
        if (sliced.length > 0) {
            transport.setWaveformPeaks?.(sliced, win.durationSec);
        } else if (win.durationSec > 0) {
            transport.setWaveformProgressOnly?.(win.durationSec, '');
        }

        if (!fetchHiRes || !layer.waveform_url || !(eFrame > sFrame)) {
            this._activeTransportWfKey = cutKey;
            return;
        }
        if (this._activeTransportWfKey === cutKey && this._transportWfAbort) {
            return;
        }
        if (this._transportWfAbort) {
            this._transportWfAbort.abort();
        }
        const ac = new AbortController();
        this._transportWfAbort = ac;
        this._activeTransportWfKey = cutKey;

        void (async () => {
            try {
                const res = await fetch(`${layer.waveform_url}?resolution=600&start_frame=${sFrame}&end_frame=${eFrame}`, {
                    signal: ac.signal,
                });
                if (!res.ok || ac.signal.aborted || this._activeTransportWfKey !== cutKey) return;
                const data = await res.json();
                if (ac.signal.aborted || this._activeTransportWfKey !== cutKey) return;
                const peaks = Array.isArray(data?.peaks) ? data.peaks : [];
                if (peaks.length > 0) {
                    this._transportCutWaveformCache.set(cutKey, { peaks, duration_sec: win.durationSec });
                    if (this._transportCutWaveformCache.size > 24) {
                        const oldest = this._transportCutWaveformCache.keys().next().value;
                        this._transportCutWaveformCache.delete(oldest);
                    }
                    window.gaiaTransport?.setWaveformPeaks?.(peaks, win.durationSec);
                    window.gaiaTransport?.render?.();
                }
            } catch {
                // Ignore abort / transient fetch errors; sliced overview remains visible
            } finally {
                if (this._transportWfAbort === ac) {
                    this._transportWfAbort = null;
                }
            }
        })();
    }

    _buildTimelineMonitorSnapshot(snap) {
        // Keep full-timeline scrubbing unlocked by stripping src-* crop_start/crop_end from
        // the live monitor snapshot while preserving any per-snapshot mixer / FX overrides.
        if (!snap?.overrides || typeof snap.overrides !== 'object') return null;
        const keptOverrides = {};
        let hasAny = false;
        for (const [nodeId, propMap] of Object.entries(snap.overrides)) {
            if (!propMap || typeof propMap !== 'object') continue;
            const filtered = {};
            for (const [key, val] of Object.entries(propMap)) {
                if (key === 'crop_start' || key === 'crop_end') continue;
                filtered[key] = val;
            }
            if (Object.keys(filtered).length > 0) {
                keptOverrides[nodeId] = filtered;
                hasAny = true;
            }
        }
        if (!hasAny) return null;
        return {
            ...snap,
            overrides: keptOverrides,
        };
    }

    maxZoomLevel() {
        const total = this.realTimelineDurationSec() || 1;
        return Math.max(64, Math.min(512, Math.ceil(total / 4)));
    }

    setZoomAt(nextZoom, anchorXFrac = 0.5) {
        const maxZ = this.maxZoomLevel();
        const clampedZoom = clamp(Number(nextZoom) || 1, 1, maxZ);
        const total = this.maxTimelineDurationSec();
        const curWin = this.visibleTimeWindow();
        const curSpan = Math.max(0.001, curWin.endSec - curWin.startSec);
        const anchorFrac = clamp(Number(anchorXFrac), 0, 1);
        const anchorSec = curWin.startSec + anchorFrac * curSpan;
        this.zoom = clampedZoom;
        const nextSpan = total / clampedZoom;
        const maxOffset = Math.max(0, 1 - nextSpan / total);
        this.viewOffsetRatio = clamp((anchorSec - anchorFrac * nextSpan) / total, 0, maxOffset);
        this.updateViewSlider();
        this.requestDraw(true);
        this.scheduleDetailWaveforms();
    }

    panByDeltaRatio(deltaRatio) {
        if (this.zoom <= 1.001) return;
        const maxOffset = Math.max(0, 1 - 1 / this.zoom);
        const next = clamp(this.viewOffsetRatio + deltaRatio, 0, maxOffset);
        if (Math.abs(next - this.viewOffsetRatio) < 1e-7) return;
        this.viewOffsetRatio = next;
        this.updateViewSlider();
        this.requestDraw(true);
        this.scheduleDetailWaveforms();
    }

    focusRange(startSec, endSec, { padFraction = 0.14, minPadSec = 10 } = {}) {
        const total = this.realTimelineDurationSec();
        if (!(total > 0) || !(endSec > startSec)) return;
        const span = endSec - startSec;
        const pad = Math.max(minPadSec, span * padFraction);
        const v0 = clamp(startSec - pad, 0, total);
        const v1 = clamp(endSec + pad, v0 + 1, total);
        const viewSpan = Math.max(1, v1 - v0);
        const nextZoom = clamp(total / viewSpan, 1, this.maxZoomLevel());
        this.zoom = nextZoom;
        const actualSpan = total / nextZoom;
        const maxOffset = Math.max(0, 1 - actualSpan / total);
        const center = (startSec + endSec) * 0.5;
        this.viewOffsetRatio = clamp((center - actualSpan * 0.5) / total, 0, maxOffset);
        this.updateViewSlider();
        this.requestDraw(true);
        this.scheduleDetailWaveforms();
    }

    _stopEdgeAutoScroll() {
        if (this._autoScrollRaf !== null) {
            window.cancelAnimationFrame(this._autoScrollRaf);
            this._autoScrollRaf = null;
        }
        this._autoScrollLastTs = 0;
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

    _dispatchSeekTransport(timelineSec, playing) {
        const fullDur = this.maxTimelineDurationSec();
        const engDur = (this.liveLoaded && this.liveDurationSec > 0)
            ? this.liveDurationSec
            : Math.max(0, fullDur - this._planOriginSec);
        const requestedTl = clamp(Number(timelineSec) || 0, 0, fullDur);
        const rawEng = requestedTl - this._planOriginSec;
        const maxEng = playing && engDur > 0.05 ? Math.max(0, engDur - 0.02) : Math.max(0, engDur);
        const clampedEng = clamp(rawEng, 0, maxEng);
        const effectiveTl = clamp(this._planOriginSec + clampedEng, 0, fullDur);
        this._lastSeekSentAt = performance.now();
        this._pendingSeek = null;
        if (this._seekBreathTimer) {
            window.clearTimeout(this._seekBreathTimer);
            this._seekBreathTimer = null;
        }
        this._seekLockSec = effectiveTl;
        this._seekLockUntil = performance.now() + 240;
        this.playheadSec = effectiveTl;
        if (this.liveAvailable && this.realtime) {
            this.livePlaying = Boolean(playing);
            this.realtime.setTransport({
                playing: Boolean(playing),
                seekSec: clampedEng,
                bpm: Number(this.session?.session_data?.graph?.settings?.bpm || 120),
                loop: false,
            });
        } else if (this.previewAudio) {
            const audioSec = clamp(requestedTl - this._previewOriginSec, 0, this.previewAudio.duration || Math.max(0, requestedTl));
            this.previewAudio.currentTime = audioSec;
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
                            if (!this.liveLoaded) return;
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
                                const incomingEngSec = Number(snap.playhead_sec) || 0;
                                const incomingTlSec = this.engineToTimelineSec(incomingEngSec);
                                const nowTs = performance.now();
                                const matchesLock = Math.abs(incomingTlSec - this._seekLockSec) <= 0.12;
                                if (matchesLock && nowTs < this._seekLockUntil) {
                                    this._seekLockUntil = 0;
                                }
                                const withinLock = nowTs < this._seekLockUntil && !matchesLock;
                                if (!withinLock) {
                                    this.playheadSec = incomingTlSec;
                                    if (this.livePlaying && this._auditionStopSec !== null && incomingTlSec >= this._auditionStopSec - 0.02) {
                                        const stopAt = this._auditionStopSec;
                                        this._auditionStopSec = null;
                                        this._dispatchSeekTransport(stopAt, false);
                                    }
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
            await this.syncRealtimePlan(this.selectedSnapshot() || null, { force: true });
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

    async syncRealtimePlan(snapshotOverride = null, { force = false } = {}) {
        if (!this.realtime || !this.liveAvailable || !this.session?.session_data?.graph) return false;
        const monitorSnap = this._buildTimelineMonitorSnapshot(snapshotOverride);
        const monitorKey = monitorSnap ? JSON.stringify(monitorSnap.overrides) : '__base__';
        if (!force && this.liveLoaded && this._loadedMonitorSnapKey === monitorKey) {
            this._planOriginSec = this._baseOriginSec();
            return true;
        }
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
            snapshot: monitorSnap,
            workspace: monitorSnap ? null : (sdata.workspace ?? null),
            soloIds: Array.from(this.soloIds),
            signal: ac.signal,
        });
        if (ac.signal.aborted || res?.aborted) return false;
        if (res?.ok) {
            this.liveLoaded = true;
            this._loadedMonitorSnapKey = monitorKey;
            this._planOriginSec = this._baseOriginSec();
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
        const activeRange = this.getSnapshotRangeSec();
        this.playheadSec = activeRange ? activeRange.startSec : 0;
        this._cueTimelineSec = this.playheadSec;
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
        const span = total / clamp(this.zoom, 1, this.maxZoomLevel());
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
                const win = self.activeTransportWindow();
                const selected = self.selectedLayer();
                if (self.liveAvailable && self.realtime) {
                    const duration = win.durationSec;
                    const currentTime = clamp(self.playheadSec - win.startSec, 0, Math.max(0, duration));
                    return {
                        hasPlayback: Boolean(self.layers.length || self.session?.has_workspace),
                        playing: Boolean(self.livePlaying),
                        currentTime,
                        duration,
                        targetLabel: win.label || selected?.label || self.session?.title || 'SIN Live',
                        displayLabel: win.isCut ? win.label : null,
                        targets: self.session?.targets || [],
                        activeTargetId: selected ? `item:${selected.item_id}` : null,
                    };
                }
                const audio = self.previewAudio;
                const fullDur = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
                    ? (self.realTimelineDurationSec() || audio.duration)
                    : (self.masterPreview?.duration_seconds || self.realTimelineDurationSec());
                const rawTlTime = audio && Number.isFinite(audio.currentTime)
                    ? clamp(self._previewOriginSec + audio.currentTime, 0, fullDur)
                    : self.playheadSec;
                const duration = win.isCut ? win.durationSec : fullDur;
                const currentTime = clamp(rawTlTime - win.startSec, 0, Math.max(0, duration));
                const playing = Boolean(audio && !audio.paused && !audio.ended);
                return {
                    hasPlayback: Boolean(self.layers.length || self.session?.has_workspace || self.masterPreview),
                    playing,
                    currentTime,
                    duration,
                    targetLabel: win.label || selected?.label || self.session?.title || 'SIN Preview',
                    displayLabel: win.isCut ? win.label : null,
                    targets: self.session?.targets || [],
                    activeTargetId: selected ? `item:${selected.item_id}` : null,
                };
            },
            async playPause() {
                const cueOn = Boolean(window.gaiaTransport?.isCueEnabled?.());
                const dur = self.maxTimelineDurationSec();
                const win = self.activeTransportWindow();
                const cueSec = clamp(Number(self._cueTimelineSec) || 0, 0, Math.max(0, dur));
                if (self.liveAvailable && self.realtime) {
                    if (!self.liveLoaded) {
                        const ok = await self.syncRealtimePlan(self.selectedSnapshot() || null);
                        if (!ok) {
                            void self.renderAndPlaySinPreview(self.selectedSnapshot()?.id || null);
                            return;
                        }
                    }
                    const nextPlaying = !self.livePlaying;
                    if (nextPlaying) {
                        let startPos = cueOn
                            ? (dur > 0.05 ? Math.min(cueSec, dur - 0.02) : cueSec)
                            : ((dur > 0 && self.playheadSec >= dur - 0.02) ? (win.isCut ? win.startSec : self._planOriginSec) : self.playheadSec);
                        if (win.isCut && startPos >= win.startSec - 0.05 && startPos <= win.endSec + 0.05) {
                            if (startPos >= win.endSec - 0.05) {
                                startPos = win.startSec;
                            }
                            self._auditionStopSec = win.endSec;
                        } else {
                            self._auditionStopSec = null;
                        }
                        self._dispatchSeekTransport(startPos, true);
                    } else if (cueOn) {
                        self._auditionStopSec = null;
                        self._dispatchSeekTransport(cueSec, false);
                    } else {
                        self._auditionStopSec = null;
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
                            const audioSec = clamp(cueSec - self._previewOriginSec, 0, self.previewAudio.duration || 0);
                            self.previewAudio.currentTime = audioSec;
                            self.playheadSec = self._previewOriginSec + self.previewAudio.currentTime;
                        }
                        self.previewAudio.play().catch(() => {});
                    } else {
                        self.previewAudio.pause();
                        if (cueOn) {
                            const audioSec = clamp(cueSec - self._previewOriginSec, 0, self.previewAudio.duration || 0);
                            self.previewAudio.currentTime = audioSec;
                            self.playheadSec = self._previewOriginSec + self.previewAudio.currentTime;
                        }
                    }
                    self.requestDraw(false);
                    window.gaiaTransport?.render?.();
                    return;
                }
                void self.renderAndPlaySinPreview(self.selectedSnapshot()?.id || null);
            },
            stop() {
                self._auditionStopSec = null;
                const cueOn = Boolean(window.gaiaTransport?.isCueEnabled?.());
                const dur = self.maxTimelineDurationSec();
                const win = self.activeTransportWindow();
                const defaultStop = win.isCut ? win.startSec : self._planOriginSec;
                const cueSec = clamp(Number(self._cueTimelineSec ?? defaultStop), 0, Math.max(0, dur));
                let targetSec = defaultStop;
                if (cueOn) {
                    const alreadyStoppedAtCue = !self.livePlaying
                        && !(self.previewAudio && !self.previewAudio.paused)
                        && Math.abs(self.playheadSec - cueSec) <= 0.05;
                    if (alreadyStoppedAtCue) {
                        targetSec = defaultStop;
                        self._cueTimelineSec = defaultStop;
                        window.gaiaTransport?.setCuePoint?.(self.timelineToTransportSec(defaultStop));
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
                    self.previewAudio.currentTime = clamp(targetSec - self._previewOriginSec, 0, self.previewAudio.duration || 0);
                }
                self.playheadSec = targetSec;
                self.requestDraw(false);
                window.gaiaTransport?.render?.();
            },
            seek(transportSeconds, opts = {}) {
                const win = self.activeTransportWindow();
                const fullDur = self.maxTimelineDurationSec();
                const keepPlaying = opts?.keepPlaying != null ? Boolean(opts.keepPlaying) : Boolean(self.livePlaying);
                const maxLocal = keepPlaying && win.durationSec > 0.05
                    ? Math.max(0, win.durationSec - 0.02)
                    : Math.max(0, win.durationSec);
                const localSec = clamp(Number(transportSeconds) || 0, 0, maxLocal);
                const targetSec = clamp(win.startSec + localSec, 0, fullDur);
                if (win.isCut) {
                    self._auditionStopSec = win.endSec;
                } else {
                    self._auditionStopSec = null;
                }
                self.playheadSec = targetSec;
                if (!opts?.scrubbing) {
                    self._cueTimelineSec = targetSec;
                }
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
        this.syncTransportWaveform({ fetchHiRes: true });
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
        this.syncTransportWaveform({ fetchHiRes: true });
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
    }

    scheduleDetailWaveforms() {
        if (this.zoom <= 1.05 || !this.layers.length) {
            if (this.detailTimer) {
                window.clearTimeout(this.detailTimer);
                this.detailTimer = null;
            }
            if (this._detailAbort) {
                this._detailAbort.abort();
                this._detailAbort = null;
            }
            this._detailGen += 1;
            this.detailWaveforms.clear();
            return;
        }
        if (this.detailTimer) window.clearTimeout(this.detailTimer);
        const gen = ++this._detailGen;
        this.detailTimer = window.setTimeout(async () => {
            this.detailTimer = null;
            if (gen !== this._detailGen) return;
            if (this._detailAbort) {
                this._detailAbort.abort();
            }
            const ac = new AbortController();
            this._detailAbort = ac;
            const { startSec, endSec } = this.visibleTimeWindow();
            await Promise.all(this.layers.map(async layer => {
                if (!layer.waveform_url || !layer.frames || !layer.sample_rate) return;
                const sFrame = clamp(Math.floor(startSec * layer.sample_rate), 0, Math.max(0, layer.frames - 2));
                const eFrame = clamp(Math.ceil(endSec * layer.sample_rate), sFrame + 1, layer.frames);
                try {
                    const res = await fetch(`${layer.waveform_url}?resolution=1200&start_frame=${sFrame}&end_frame=${eFrame}`, {
                        signal: ac.signal,
                    });
                    if (res.ok && !ac.signal.aborted && gen === this._detailGen) {
                        const wf = await res.json();
                        if (!ac.signal.aborted && gen === this._detailGen) {
                            this.detailWaveforms.set(layer.item_id, wf);
                        }
                    }
                } catch {
                    // Ignore abort / transient errors; overview waveform seamlessly fills uncovered spans
                }
            }));
            if (this._detailAbort === ac) {
                this._detailAbort = null;
            }
            if (!ac.signal.aborted && gen === this._detailGen) {
                this.requestDraw(true);
            }
        }, 70);
    }

    updateViewSlider() {
        const slider = this.container?.querySelector('#sin-view-slider');
        const win = this.container?.querySelector('#sin-view-window');
        const zoomLbl = this.container?.querySelector('#sin-zoom-label');
        if (zoomLbl) zoomLbl.textContent = `${this.zoom.toFixed(1).replace(/\.0$/, '')}×`;
        if (!slider || !win) return;
        const spanRatio = 1 / Math.max(1, this.zoom);
        const maxOffset = Math.max(0, 1 - spanRatio);
        const widthPct = clamp(spanRatio * 100, 4, 100);
        const travelPct = Math.max(0, 100 - widthPct);
        const leftPct = maxOffset > 1e-6 ? clamp(this.viewOffsetRatio / maxOffset, 0, 1) * travelPct : 0;
        slider.classList.toggle('disabled', this.zoom <= 1.001);
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
            const cueSec = Number(this._cueTimelineSec || 0);
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

        const rect = canvas.getBoundingClientRect();
        const cssW = rect.width;
        const cssH = rect.height;
        if (cssW <= 0 || cssH <= 0) return;
        this._cachedCanvasW = cssW;
        this._cachedCanvasH = cssH;

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

                const overviewWf = this.overviewWaveforms.get(layer.item_id) || null;
                const detailWf = (this.zoom > 1.05 && this.detailWaveforms.has(layer.item_id))
                    ? this.detailWaveforms.get(layer.item_id)
                    : null;
                const layerDur = Number(layer.duration_seconds)
                    || Number(overviewWf?.duration_seconds)
                    || Number(detailWf?.duration_seconds)
                    || 0;

                if ((overviewWf?.peaks?.length || detailWf?.peaks?.length) && layerDur > 0) {
                    const fallbackSr = Number(layer.sample_rate || overviewWf?.sample_rate || detailWf?.sample_rate || 44100);
                    const linGain = Math.pow(10, Number(layer.pre_gain_db || 0) / 20) * Number(layer.volume ?? 1);
                    bCtx.fillStyle = muted ? 'rgba(148, 163, 184, 0.3)' : (selected ? '#6fc1ff' : '#4a8ec2');
                    const step = Math.max(1, Math.floor(dpr));
                    for (let x = 0; x < w; x += step) {
                        const sec = startSec + ((x + 0.5 * step) / w) * spanSec;
                        if (sec < 0 || sec > layerDur) continue;
                        // Prefer zoomed detail peaks where they cover `sec`, seamlessly falling back to overview peaks
                        const pair = (detailWf ? this._sampleWaveformPeakAtSec(detailWf, sec, fallbackSr, layerDur) : null)
                            || (overviewWf ? this._sampleWaveformPeakAtSec(overviewWf, sec, fallbackSr, layerDur) : null);
                        if (!pair) continue;
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
                        const rawSx0 = secToX(Number(snapOv.crop_start ?? 0) * layerDur);
                        const rawSx1 = secToX(Number(snapOv.crop_end ?? 1) * layerDur);
                        const sx0 = clamp(rawSx0, 0, w);
                        const sx1 = clamp(rawSx1, 0, w);
                        if (sx1 > sx0) {
                            bCtx.fillStyle = 'rgba(247, 178, 59, 0.22)';
                            bCtx.fillRect(sx0, top, sx1 - sx0, laneH);
                            bCtx.strokeStyle = 'rgba(247, 178, 59, 0.78)';
                            bCtx.lineWidth = 1.25 * dpr;
                            bCtx.strokeRect(sx0, top + 0.5 * dpr, sx1 - sx0, laneH - dpr);
                        }
                        // Crisp draggable amber boundary handles when visible inside the viewport
                        const handleW = 3 * dpr;
                        const capH = 7 * dpr;
                        const capW = 7 * dpr;
                        bCtx.fillStyle = '#f7b23b';
                        if (rawSx0 >= -handleW && rawSx0 <= w + handleW) {
                            bCtx.fillRect(rawSx0 - handleW * 0.5, top, handleW, laneH);
                            bCtx.fillRect(rawSx0 - 1 * dpr, top, capW, capH);
                        }
                        if (rawSx1 >= -handleW && rawSx1 <= w + handleW) {
                            bCtx.fillRect(rawSx1 - handleW * 0.5, top, handleW, laneH);
                            bCtx.fillRect(rawSx1 - capW + 1 * dpr, top, capW, capH);
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
            const cueSec = Number(this._cueTimelineSec || 0);
            this._drawCueMarker(ctx, secToX(cueSec), h, dpr);
        }

        const playX = secToX(this.playheadSec);
        if (playX >= 0 && playX <= w) {
            const isScrub = Boolean(this._scrubCursorPos && this.dragState?.mode === 'seek');
            ctx.fillStyle = isScrub ? 'rgba(56, 211, 153, 0.95)' : '#ff5c5c';
            ctx.fillRect(playX - (isScrub ? 1.25 : 0.9) * dpr, 0, (isScrub ? 2.5 : 1.8) * dpr, h);
        }

        // Minimal translucent time pill right beside cursor while scrubbing OR dragging a cut/crop handle
        if (this._scrubCursorPos && Number.isFinite(this._scrubCursorPos.sec)) {
            const isHandleDrag = this.dragState?.mode && this.dragState.mode !== 'seek';
            const pillAnchorX = isHandleDrag ? secToX(this._scrubCursorPos.sec) : playX;
            const label = formatPreciseTime(this._scrubCursorPos.sec);
            ctx.font = `600 ${Math.round(9.5 * dpr)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
            const tw = ctx.measureText(label).width;
            const padX = 5 * dpr;
            const boxW = tw + padX * 2;
            const boxH = 16 * dpr;
            const boxX = clamp(pillAnchorX + 6 * dpr, 3 * dpr, Math.max(3 * dpr, w - boxW - 3 * dpr));
            const boxY = 4 * dpr;
            ctx.fillStyle = 'rgba(10, 14, 22, 0.88)';
            ctx.fillRect(boxX, boxY, boxW, boxH);
            ctx.strokeStyle = isHandleDrag ? 'rgba(247, 178, 59, 0.75)' : 'rgba(56, 211, 153, 0.55)';
            ctx.lineWidth = dpr;
            ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
            ctx.fillStyle = isHandleDrag ? '#fde68a' : '#e2f8ef';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, boxX + padX, boxY + boxH * 0.5 + 0.5);
        }
    }

    selectLayer(idx) {
        if (idx < 0 || idx >= this.layers.length) return;
        this.selectedLayerIdx = idx;
        this.syncMixerRowStates();
        this.renderCuts();
        this.updateHostTrackInfo();
        this.syncTransportWaveform({ fetchHiRes: true });
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
        this.syncTransportWaveform({ fetchHiRes: true });
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
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
        this.syncTransportWaveform({ fetchHiRes: true });
        this.requestDraw(true);
        window.gaiaTransport?.render?.();
    }

    async activateSnapshot(snapshotId, { autoPlay = false, focusView = true, markDirty = false } = {}) {
        const sdata = this.session?.session_data;
        if (!sdata) return;
        const nextId = snapshotId || null;
        sdata.active_snapshot_id = nextId;
        this.renderSnapshotsSelect();
        this.renderCuts();
        if (markDirty) this.markDirty();

        const snap = this.selectedSnapshot();
        const range = this.getSnapshotRangeSec(snap);
        this.syncTransportWaveform({ fetchHiRes: true });
        if (range) {
            this._cueTimelineSec = range.startSec;
            window.gaiaTransport?.setCuePoint?.(0);
        } else {
            this._cueTimelineSec = clamp(this.playheadSec, 0, this.maxTimelineDurationSec());
            window.gaiaTransport?.setCuePoint?.(this.timelineToTransportSec(this._cueTimelineSec));
        }
        if (focusView && range) {
            this.focusRange(range.startSec, range.endSec);
        } else if (!nextId) {
            this.zoom = 1;
            this.viewOffsetRatio = 0;
            this.detailWaveforms.clear();
            this.updateViewSlider();
            this.requestDraw(true);
        } else {
            this.requestDraw(true);
        }

        if (this.liveAvailable && this.realtime) {
            const ok = await this.syncRealtimePlan(snap || null);
            if (!ok && autoPlay && snap) {
                void this.renderAndPlaySinPreview(snap.id);
                return;
            }
            if (range) {
                this._auditionStopSec = autoPlay ? range.endSec : null;
                this._dispatchSeekTransport(range.startSec, Boolean(autoPlay));
                if (autoPlay) {
                    this.host?.setStatus?.(`Playing "${snap.label || snap.id}" live on device audio`);
                }
            } else {
                this._auditionStopSec = null;
                if (autoPlay) {
                    this._dispatchSeekTransport(this._planOriginSec, true);
                }
            }
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
            return;
        }

        if (range) {
            this.playheadSec = range.startSec;
            this.requestDraw(false);
            window.gaiaTransport?.render?.();
        }
        if (autoPlay && snap) {
            void this.renderAndPlaySinPreview(snap.id);
        }
    }

    async auditionCutRealtime(snap) {
        if (!snap) return;
        await this.activateSnapshot(snap.id, { autoPlay: true, focusView: true });
    }

    async renderAndPlaySinPreview(snapshotId = null) {
        const pid = this.session?.project_id;
        if (!pid || this.renderingPreview) return;
        this.renderingPreview = true;
        try {
            this.host?.setStatus?.('Rendering SIN graph preview…');
            const snapObj = snapshotId
                ? (this.session?.session_data?.snapshots || []).find(s => s && s.id === snapshotId) || null
                : null;
            const snapRange = snapObj ? this.getSnapshotRangeSec(snapObj) : null;
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
            this._previewOriginSec = snapRange ? snapRange.startSec : this._baseOriginSec();
            this.drawMasterStrip();
            this.stopPreviewAudio(false);

            const audio = new Audio(data.audio_url);
            audio.addEventListener('timeupdate', () => {
                this.playheadSec = clamp(this._previewOriginSec + (audio.currentTime || 0), 0, this.maxTimelineDurationSec());
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
            this._cueTimelineSec = targetSec;
            window.gaiaTransport?.setCuePoint?.(this.timelineToTransportSec(targetSec));
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
            const sid = snapSelect.value || null;
            void this.activateSnapshot(sid, {
                autoPlay: false,
                focusView: Boolean(sid),
                markDirty: true,
            });
        }, sig);

        // Zoom buttons
        this.container.querySelector('#sin-zoom-in')?.addEventListener('click', () => this.setZoomAt(this.zoom * 2, 0.5), sig);
        this.container.querySelector('#sin-zoom-out')?.addEventListener('click', () => this.setZoomAt(this.zoom / 2, 0.5), sig);
        this.container.querySelector('#sin-zoom-fit')?.addEventListener('click', () => {
            this.viewOffsetRatio = 0;
            this.setZoomAt(1, 0);
        }, sig);

        // View overview slider pan (preserves thumb grab offset & avoids high-zoom clamping bugs)
        const viewSlider = this.container.querySelector('#sin-view-slider');
        const viewWin = this.container.querySelector('#sin-view-window');
        const applyViewSliderOffset = nextOffset => {
            const spanRatio = 1 / Math.max(1, this.zoom);
            const maxOffset = Math.max(0, 1 - spanRatio);
            this.viewOffsetRatio = clamp(nextOffset, 0, maxOffset);
            this.updateViewSlider();
            this.requestDraw(true);
            this.scheduleDetailWaveforms();
        };
        viewSlider?.addEventListener('pointerdown', event => {
            if (event.button !== 0 || this.zoom <= 1.001) return;
            event.preventDefault();
            viewSlider.setPointerCapture(event.pointerId);
            this.viewDragState = true;
            viewSlider.classList.add('is-dragging');
            const sliderRect = viewSlider.getBoundingClientRect();
            const winRect = viewWin?.getBoundingClientRect();
            const spanRatio = 1 / Math.max(1, this.zoom);
            const maxOffset = Math.max(0, 1 - spanRatio);
            const travelPx = Math.max(1, sliderRect.width - (winRect ? winRect.width : sliderRect.width * spanRatio));
            if (winRect && event.clientX >= winRect.left && event.clientX <= winRect.right) {
                this._viewDragInfo = {
                    mode: 'thumb',
                    anchorX: event.clientX,
                    anchorOffset: this.viewOffsetRatio,
                    travelPx,
                    maxOffset,
                };
            } else {
                const ratio = clamp((event.clientX - sliderRect.left) / Math.max(1, sliderRect.width), 0, 1);
                const centered = clamp(ratio - spanRatio * 0.5, 0, maxOffset);
                this._viewDragInfo = {
                    mode: 'thumb',
                    anchorX: event.clientX,
                    anchorOffset: centered,
                    travelPx,
                    maxOffset,
                };
                applyViewSliderOffset(centered);
            }
        }, sig);
        viewSlider?.addEventListener('pointermove', event => {
            if (!this.viewDragState || !this._viewDragInfo) return;
            const dx = event.clientX - this._viewDragInfo.anchorX;
            const deltaOffset = (dx / this._viewDragInfo.travelPx) * this._viewDragInfo.maxOffset;
            applyViewSliderOffset(this._viewDragInfo.anchorOffset + deltaOffset);
        }, sig);
        const endViewSliderDrag = () => {
            if (!this.viewDragState) return;
            this.viewDragState = false;
            this._viewDragInfo = null;
            viewSlider?.classList.remove('is-dragging');
        };
        viewSlider?.addEventListener('pointerup', endViewSliderDrag, sig);
        viewSlider?.addEventListener('pointercancel', endViewSliderDrag, sig);

        // Multi-lane canvas pointer interaction:
        // - Left-click/drag: move playback & scrub smoothly anywhere on the timeline (or drag amber snapshot / green crop handles)
        // - Middle-drag, Right-drag (when zoomed), or Shift/Alt+Left-drag: pan timeline left/right
        // - Wheel: cursor-anchored zoom; Shift+Wheel or horizontal trackpad swipe: pan left/right
        // - Edge auto-scroll: dragging playhead or handles near canvas edges while zoomed smoothly scrolls left/right
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
            if (layerDur > 0) {
                const activeSnap = this.selectedSnapshot();
                const snapOv = activeSnap?.overrides?.[layer.src_node_id];
                if (snapOv && (snapOv.crop_start != null || snapOv.crop_end != null)) {
                    const sx0 = secToCssX(Number(snapOv.crop_start ?? 0) * layerDur);
                    const sx1 = secToCssX(Number(snapOv.crop_end ?? 1) * layerDur);
                    const snapTol = Math.min(10, Math.max(4, Math.floor(Math.abs(sx1 - sx0) * 0.22)));
                    if (Math.abs(x - sx0) <= snapTol) return { mode: 'snap-start', laneIdx };
                    if (Math.abs(x - sx1) <= snapTol) return { mode: 'snap-end', laneIdx };
                }
                if (laneIdx === this.selectedLayerIdx) {
                    if (Math.abs(x - secToCssX(Number(layer.crop_start ?? 0) * layerDur)) <= 9) return { mode: 'crop-start', laneIdx };
                    if (Math.abs(x - secToCssX(Number(layer.crop_end ?? 1) * layerDur)) <= 9) return { mode: 'crop-end', laneIdx };
                }
            }
            return { mode: 'seek', laneIdx };
        };

        const applyActiveDragAtClientX = clientX => {
            if (!this.dragState || !tlCanvas) return;
            const layer = this.layers[this.dragState.laneIdx];
            if (!layer) return;
            const rect = tlCanvas.getBoundingClientRect();
            const { startSec, endSec } = this.visibleTimeWindow();
            const span = Math.max(0.001, endSec - startSec);
            const sec = clamp(startSec + ((clientX - rect.left) / Math.max(1, rect.width)) * span, 0, this.maxTimelineDurationSec());

            if (this.dragState.mode === 'seek') {
                if (!this.dragState.moved && Math.abs(clientX - this.dragState.startX) >= 4) {
                    this.dragState.moved = true;
                    this.dragState.monitoringScrub = true;
                }
                if (this.dragState.moved) {
                    this.playheadSec = sec;
                    this._scrubCursorPos = { x: clientX - rect.left, sec };
                    const snapRange = this.getSnapshotRangeSec();
                    if (snapRange && sec >= snapRange.startSec && sec < snapRange.endSec) {
                        this._auditionStopSec = snapRange.endSec;
                    } else {
                        this._auditionStopSec = null;
                    }
                    // Transparent live position monitoring with a 45ms breath window (leverages C++ sliding window + 4ms overlap crossfade)
                    this._scheduleSeekTransport(sec, true, { immediate: false, breathMs: 45 });
                    if (this._scrubIdlePauseTimer) {
                        window.clearTimeout(this._scrubIdlePauseTimer);
                    }
                    if (!this.dragState.wasPlaying) {
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

            if (this.dragState.mode === 'snap-start' || this.dragState.mode === 'snap-end') {
                const activeSnap = this.selectedSnapshot();
                if (!activeSnap?.overrides) return;
                const refOv = activeSnap.overrides[layer.src_node_id];
                if (!refOv) return;
                const minGap = Math.min(0.002, 0.25 / layerDur);
                const nextStart = this.dragState.mode === 'snap-start'
                    ? roundRatio(Math.min(ratio, Number(refOv.crop_end ?? 1) - minGap))
                    : roundRatio(Number(refOv.crop_start ?? 0));
                const nextEnd = this.dragState.mode === 'snap-end'
                    ? roundRatio(Math.max(ratio, Number(refOv.crop_start ?? 0) + minGap))
                    : roundRatio(Number(refOv.crop_end ?? 1));
                for (const [nid, ov] of Object.entries(activeSnap.overrides)) {
                    if (!ov || typeof ov !== 'object') continue;
                    if (nid === layer.src_node_id || ov.crop_start != null || ov.crop_end != null) {
                        ov.crop_start = nextStart;
                        ov.crop_end = nextEnd;
                    }
                }
                const startS = nextStart * layerDur;
                const endS = nextEnd * layerDur;
                activeSnap.meta = activeSnap.meta || { source_engine: 'sin_timeline' };
                activeSnap.meta.start_sec = Math.round(startS * 1000) / 1000;
                activeSnap.meta.end_sec = Math.round(endS * 1000) / 1000;
                activeSnap.meta.duration_sec = Math.round((endS - startS) * 1000) / 1000;
                if (layer.sample_rate) {
                    activeSnap.meta.start_frame = Math.round(startS * layer.sample_rate);
                    activeSnap.meta.end_frame = Math.round(endS * layer.sample_rate);
                }
                if (this._auditionStopSec !== null) {
                    this._auditionStopSec = endS;
                }
                const rangeSpan = this.container?.querySelector(`[data-snap-id="${CSS.escape(activeSnap.id)}"] .media-cut-range`);
                if (rangeSpan) {
                    rangeSpan.textContent = `${formatPreciseTime(startS)}–${formatPreciseTime(endS)}`;
                }
                this._scrubCursorPos = { x: clientX - rect.left, sec: this.dragState.mode === 'snap-start' ? startS : endS };
                this.markDirty();
                this.syncTransportWaveform({ fetchHiRes: false });
                this.requestDraw(true);
                window.gaiaTransport?.render?.();
                return;
            }

            if (this.dragState.mode === 'crop-start') {
                layer.crop_start = Math.min(ratio, Number(layer.crop_end ?? 1) - 0.002);
                this._planOriginSec = this._baseOriginSec();
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'crop_start', layer.crop_start, 0);
                this._scrubCursorPos = { x: clientX - rect.left, sec: layer.crop_start * layerDur };
            } else if (this.dragState.mode === 'crop-end') {
                layer.crop_end = Math.max(ratio, Number(layer.crop_start ?? 0) + 0.002);
                this.realtime?.setParam(layer.ch_node_id || layer.src_node_id, 'crop_end', layer.crop_end, 0);
                this._scrubCursorPos = { x: clientX - rect.left, sec: layer.crop_end * layerDur };
            }
            this.applyLayerControlToGraph(layer);
            this.markDirty();
            this.requestDraw(true);
        };

        const tickEdgeAutoScroll = ts => {
            this._autoScrollRaf = null;
            if (!this.dragState || this.dragState.mode === 'pan' || this.zoom <= 1.001 || !tlCanvas) return;
            const rect = tlCanvas.getBoundingClientRect();
            const edgePx = 28;
            const localX = this._autoScrollClientX - rect.left;
            let dir = 0;
            let strength = 0;
            if (localX < edgePx) {
                dir = -1;
                strength = clamp((edgePx - localX) / edgePx, 0.15, 2.5);
            } else if (localX > rect.width - edgePx) {
                dir = 1;
                strength = clamp((localX - (rect.width - edgePx)) / edgePx, 0.15, 2.5);
            }
            if (dir === 0) {
                this._autoScrollLastTs = 0;
                return;
            }
            const dt = this._autoScrollLastTs ? Math.min(0.05, (ts - this._autoScrollLastTs) / 1000) : 0.016;
            this._autoScrollLastTs = ts;
            const spanRatio = 1 / Math.max(1, this.zoom);
            this.panByDeltaRatio(dir * strength * spanRatio * 0.65 * dt);
            applyActiveDragAtClientX(this._autoScrollClientX);
            this._autoScrollRaf = window.requestAnimationFrame(tickEdgeAutoScroll);
        };

        const ensureEdgeAutoScroll = (clientX, rect) => {
            this._autoScrollClientX = clientX;
            if (this.zoom <= 1.001) {
                this._stopEdgeAutoScroll();
                return;
            }
            const localX = clientX - rect.left;
            if (localX < 28 || localX > rect.width - 28) {
                if (this._autoScrollRaf === null) {
                    this._autoScrollLastTs = 0;
                    this._autoScrollRaf = window.requestAnimationFrame(tickEdgeAutoScroll);
                }
            } else {
                this._stopEdgeAutoScroll();
            }
        };

        tlCanvas?.addEventListener('contextmenu', event => {
            if (this._suppressNextContextMenu) {
                event.preventDefault();
                this._suppressNextContextMenu = false;
            }
        }, sig);

        tlCanvas?.addEventListener('pointerdown', event => {
            if (!this.layers.length) return;
            const rect = tlCanvas.getBoundingClientRect();
            this._cachedCanvasW = rect.width;
            this._cachedCanvasH = rect.height;

            // Middle-click, Right-drag (when zoomed), or Shift/Alt+Left-drag pans left/right directly on waveform
            const wantsPan = event.button === 1
                || (this.zoom > 1.001 && (event.button === 2 || (event.button === 0 && (event.shiftKey || event.altKey))));
            if (wantsPan) {
                event.preventDefault();
                tlCanvas.setPointerCapture(event.pointerId);
                this.dragState = {
                    mode: 'pan',
                    button: event.button,
                    startX: event.clientX,
                    anchorOffsetRatio: this.viewOffsetRatio,
                    spanRatio: 1 / Math.max(1, this.zoom),
                    rectWidth: Math.max(1, rect.width),
                    moved: false,
                };
                tlCanvas.style.cursor = 'grabbing';
                return;
            }

            if (event.button !== 0) return;
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
                const snapRange = this.getSnapshotRangeSec();
                if (snapRange && sec >= snapRange.startSec && sec < snapRange.endSec) {
                    this._auditionStopSec = snapRange.endSec;
                } else {
                    this._auditionStopSec = null;
                }
                this.playheadSec = sec;
                this._cueTimelineSec = sec;
                window.gaiaTransport?.setCuePoint?.(this.timelineToTransportSec(sec));
                // Click-jump immediately commits exact timeline position
                this._scheduleSeekTransport(sec, wasPlaying, { immediate: true });
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
            }
        }, sig);

        tlCanvas?.addEventListener('pointermove', event => {
            if (!this.dragState) {
                if (this.layers.length && tlCanvas) {
                    if (this.zoom > 1.001 && (event.shiftKey || event.altKey)) {
                        tlCanvas.style.cursor = 'grab';
                    } else {
                        const rect = tlCanvas.getBoundingClientRect();
                        const hit = hitTestCropHandle(event.clientX, event.clientY, rect);
                        tlCanvas.style.cursor = hit.mode === 'seek' ? 'col-resize' : 'ew-resize';
                    }
                }
                return;
            }
            if (this.dragState.mode === 'pan') {
                const dx = event.clientX - this.dragState.startX;
                if (Math.abs(dx) >= 3) {
                    this.dragState.moved = true;
                    if (this.dragState.button === 2) {
                        this._suppressNextContextMenu = true;
                    }
                }
                const deltaRatio = -(dx / this.dragState.rectWidth) * this.dragState.spanRatio;
                const maxOffset = Math.max(0, 1 - this.dragState.spanRatio);
                this.viewOffsetRatio = clamp(this.dragState.anchorOffsetRatio + deltaRatio, 0, maxOffset);
                this.updateViewSlider();
                this.requestDraw(true);
                this.scheduleDetailWaveforms();
                return;
            }
            const rect = tlCanvas.getBoundingClientRect();
            applyActiveDragAtClientX(event.clientX);
            ensureEdgeAutoScroll(event.clientX, rect);
        }, sig);

        const finishTimelineDrag = () => {
            if (!this.dragState) return;
            const st = this.dragState;
            this.dragState = null;
            this._scrubCursorPos = null;
            this._stopEdgeAutoScroll();
            if (this._scrubIdlePauseTimer) {
                window.clearTimeout(this._scrubIdlePauseTimer);
                this._scrubIdlePauseTimer = null;
            }
            if (st.mode === 'pan') {
                if (tlCanvas) tlCanvas.style.cursor = 'col-resize';
                return;
            }
            if (st.mode === 'seek') {
                const cueTarget = st.moved ? this.playheadSec : st.startSec;
                this._cueTimelineSec = cueTarget;
                window.gaiaTransport?.setCuePoint?.(this.timelineToTransportSec(cueTarget));
                if (st.moved || (st.wasPlaying && !this._lastServerPlaying)) {
                    this._dispatchSeekTransport(cueTarget, st.wasPlaying);
                }
                this.requestDraw(false);
                window.gaiaTransport?.render?.();
                return;
            }
            if (st.mode === 'snap-start' || st.mode === 'snap-end') {
                this.syncTransportWaveform({ fetchHiRes: true });
                window.gaiaTransport?.render?.();
            }
            this.requestDraw(true);
        };
        tlCanvas?.addEventListener('pointerup', finishTimelineDrag, sig);
        tlCanvas?.addEventListener('pointercancel', finishTimelineDrag, sig);

        tlCanvas?.addEventListener('wheel', event => {
            if (Math.abs(event.deltaY) < 0.5 && Math.abs(event.deltaX) < 0.5) return;
            event.preventDefault();
            const rect = tlCanvas.getBoundingClientRect();
            if (rect.width <= 0) return;

            // Horizontal trackpad/wheel scroll OR Shift+wheel pans left/right when zoomed in
            const horizontalPan = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
            if (horizontalPan) {
                if (this.zoom > 1.001) {
                    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                    const spanRatio = 1 / Math.max(1, this.zoom);
                    this.panByDeltaRatio((delta / 360) * spanRatio);
                }
                return;
            }

            // Vertical wheel zooms anchored right under the mouse cursor
            const xFrac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
            const factor = event.deltaY < 0 ? 1.28 : (1 / 1.28);
            this.setZoomAt(this.zoom * factor, xFrac);
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
                const wasActive = sdata.active_snapshot_id === sid;
                sdata.snapshots = (sdata.snapshots || []).filter(s => s.id !== sid);
                if (wasActive) {
                    sdata.active_snapshot_id = null;
                    this._auditionStopSec = null;
                }
                this.markDirty();
                this.renderSnapshotsSelect();
                this.renderCuts();
                if (wasActive) {
                    this.syncTransportWaveform({ fetchHiRes: true });
                    window.gaiaTransport?.setCuePoint?.(this.timelineToTransportSec(this._cueTimelineSec));
                    window.gaiaTransport?.render?.();
                }
                this.requestDraw(true);
                return;
            }
            if (event.target.closest('[data-snap-label]')) {
                // Keep label text input focus undisturbed while selecting its snapshot
                if (sdata.active_snapshot_id !== sid) {
                    sdata.active_snapshot_id = sid;
                    this.renderSnapshotsSelect();
                    cutsList.querySelectorAll('[data-snap-id]').forEach(c => c.classList.toggle('active', c.dataset.snapId === sid));
                    this.syncTransportWaveform({ fetchHiRes: true });
                    const range = this.getSnapshotRangeSec();
                    if (range) {
                        this._cueTimelineSec = range.startSec;
                        window.gaiaTransport?.setCuePoint?.(0);
                    }
                    this.requestDraw(true);
                    window.gaiaTransport?.render?.();
                }
                return;
            }
            const autoPlay = Boolean(event.target.closest('[data-snap-play]'));
            void this.activateSnapshot(sid, { autoPlay, focusView: true });
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
            if (this.session?.session_data?.active_snapshot_id === snap.id) {
                window.gaiaTransport?.render?.();
            }
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
