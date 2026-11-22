/**
 * Instant Audio Audition Engine for GAIA Library Browsing.
 *
 * Primary path: Reuses the already-compiled C++20 libsin_dsp engine over the
 * existing `/editor/realtime/ws` channel (< 5 ms latency, 16-slot C++ RAM LRU).
 * Fallback path: Web Audio API decoded AudioBuffer LRU (short samples <= 15 s)
 * + fast `/items/{id}/stream` HTMLAudioElement (long tracks or when native DLL is absent).
 */

import { RealtimeAudioClient } from '/packages/media-client/src/realtime-client.js';

const MAX_WEBAUDIO_CACHE = 32;
const MAX_WEBAUDIO_BYTES = 8 * 1024 * 1024; // 8 MB (~45s stereo 16-bit WAV)

class InstantAudioPreview {
    constructor({ wsPath = '/editor/realtime/ws' } = {}) {
        this.realtime = new RealtimeAudioClient(wsPath, { ownerId: 'gaia-library-preview' });
        this._connectStarted = false;

        this._audioCtx = null;
        this._bufferCache = new Map(); // url -> AudioBuffer
        this._inFlightDecodes = new Map(); // url -> Promise<AudioBuffer|null>
        this._activeSource = null;
        this._activeAudioEl = null;
        this._activeMode = null; // 'native' | 'webaudio' | 'html5' | null
        this._activeEntry = null;
        this._activeKey = null;
        this._playToken = 0;

        // Track Web Audio playback timing for transport bar
        this._waStartTime = 0;
        this._waOffset = 0;
        this._waDuration = 0;
        this._waPlaying = false;
        this._waBuffer = null;

        // Track native playback timing from telemetry
        this._nativePlaying = false;
        this._nativePlayhead = 0;
        this._nativeDuration = 0;

        this.realtime.onTelemetry((tel) => {
            if (this._activeMode !== 'native') return;
            const footerSeeking = Boolean(window.gaiaTransport?.isFooterSeeking?.());
            const wasPlaying = this._nativePlaying;
            if (!footerSeeking) {
                this._nativePlaying = Boolean(tel.is_playing);
                this._nativePlayhead = Number(tel.playhead_sec) || 0;
            }
            if (Number.isFinite(tel.duration_sec) && tel.duration_sec > 0) {
                this._nativeDuration = Number(tel.duration_sec);
            }
            window.gaiaTransport?.render?.();
            if (!footerSeeking && wasPlaying && !this._nativePlaying && this._nativeDuration > 0 && this._nativePlayhead >= this._nativeDuration - 0.05) {
                this._activeMode = null;
                this._activeKey = null;
                this._activeEntry = null;
                window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
                window.dispatchEvent(new CustomEvent('gaia:stop'));
            }
        });

        this._transportDriver = {
            getState: () => {
                if (this._activeMode === 'native') {
                    return {
                        hasPlayback: Boolean(this._activeEntry),
                        playing: this._nativePlaying,
                        currentTime: this._nativePlayhead,
                        duration: this._nativeDuration,
                        targetLabel: this._activeEntry?.title || 'Preview',
                    };
                }
                if (this._activeMode === 'webaudio') {
                    const ctx = this._audioCtx;
                    const nowPos = this._waPlaying && ctx
                        ? Math.min(this._waDuration, this._waOffset + (ctx.currentTime - this._waStartTime))
                        : this._waOffset;
                    return {
                        hasPlayback: Boolean(this._activeEntry),
                        playing: this._waPlaying,
                        currentTime: nowPos,
                        duration: this._waDuration,
                        targetLabel: this._activeEntry?.title || 'Preview',
                    };
                }
                if (this._activeMode === 'html5' && this._activeAudioEl) {
                    const el = this._activeAudioEl;
                    return {
                        hasPlayback: Boolean(this._activeEntry),
                        playing: !el.paused && !el.ended,
                        currentTime: Number.isFinite(el.currentTime) ? el.currentTime : 0,
                        duration: Number.isFinite(el.duration) ? el.duration : 0,
                        targetLabel: this._activeEntry?.title || 'Preview',
                    };
                }
                return { hasPlayback: false, playing: false, currentTime: 0, duration: 0 };
            },
            playPause: () => {
                if (this._activeMode === 'native') {
                    const nextPlaying = !this._nativePlaying;
                    this._nativePlaying = nextPlaying;
                    let seekSec = -1;
                    if (nextPlaying && this._nativeDuration > 0 && this._nativePlayhead >= this._nativeDuration - 0.05) {
                        seekSec = 0;
                        this._nativePlayhead = 0;
                    }
                    this.realtime.setTransport({
                        playing: nextPlaying,
                        seekSec,
                    });
                } else if (this._activeMode === 'webaudio') {
                    if (this._waPlaying) this._pauseWebAudio();
                    else this._resumeWebAudio();
                } else if (this._activeMode === 'html5' && this._activeAudioEl) {
                    if (this._activeAudioEl.paused || this._activeAudioEl.ended) {
                        if (this._activeAudioEl.ended) this._activeAudioEl.currentTime = 0;
                        this._activeAudioEl.play().catch(() => {});
                    } else {
                        this._activeAudioEl.pause();
                    }
                }
            },
            stop: () => {
                // User-triggered Stop rewinds cleanly to 0:00 while keeping the track ready to replay/seek
                if (this._activeMode === 'native') {
                    this._nativePlaying = false;
                    this._nativePlayhead = 0;
                    this.realtime.setTransport({ playing: false, seekSec: 0 });
                    window.gaiaTransport?.render?.();
                    return;
                }
                if (this._activeMode === 'webaudio') {
                    this._waPlaying = false;
                    this._waOffset = 0;
                    this._stopWebAudioSourceOnly();
                    window.gaiaTransport?.render?.();
                    return;
                }
                if (this._activeMode === 'html5' && this._activeAudioEl) {
                    this._activeAudioEl.pause();
                    this._activeAudioEl.currentTime = 0;
                    window.gaiaTransport?.render?.();
                    return;
                }
                this.stop();
            },
            seek: (sec, opts = {}) => {
                const dur = this._activeMode === 'native'
                    ? this._nativeDuration
                    : (this._activeMode === 'webaudio'
                        ? this._waDuration
                        : (Number.isFinite(this._activeAudioEl?.duration) ? this._activeAudioEl.duration : 0));
                const keepPlaying = opts?.keepPlaying != null ? Boolean(opts.keepPlaying) : null;
                const clamped = Math.max(0, dur > 0 ? Math.min(keepPlaying ? Math.max(0, dur - 0.02) : dur, Number(sec) || 0) : (Number(sec) || 0));
                if (this._activeMode === 'native') {
                    const playing = keepPlaying !== null ? keepPlaying : this._nativePlaying;
                    this._nativePlaying = playing;
                    this._nativePlayhead = clamped;
                    this.realtime.setTransport({ playing, seekSec: clamped });
                } else if (this._activeMode === 'webaudio' && this._waBuffer) {
                    const wasPlaying = keepPlaying !== null ? keepPlaying : this._waPlaying;
                    this._stopWebAudioSourceOnly();
                    this._waOffset = Math.min(this._waDuration, clamped);
                    if (wasPlaying) this._startWebAudioBuffer(this._waBuffer, this._waOffset);
                } else if (this._activeMode === 'html5' && this._activeAudioEl) {
                    const el = this._activeAudioEl;
                    const wasPlaying = keepPlaying !== null ? keepPlaying : (!el.paused && !el.ended);
                    el.currentTime = clamped;
                    if (wasPlaying && el.paused) {
                        el.play().catch(() => {});
                    }
                }
            },
        };
        // When stopped (not playing and at 0:00) and user selects another library item, release the stale
        // stopped preview so the bottom transport bar transparently reflects the newly selected track.
        window.addEventListener('gaia:selection', (event) => {
            if (window.gaiaEditorHost?.isOpen?.()) return;
            const nextKey = event.detail?.entry?.id ?? null;
            if (!this._activeKey || nextKey === this._activeKey) return;
            const st = this._transportDriver.getState();
            if (!st.playing && (st.currentTime || 0) <= 0.05) {
                this.stop();
            }
        });

        // Proactively open WS connection on page load so first click is instant native playback
        queueMicrotask(() => this.warmUp());
    }

    warmUp() {
        if (!this._connectStarted) {
            this._connectStarted = true;
            void this.realtime.connect();
        }
    }

    _ensureAudioContext() {
        if (!this._audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) this._audioCtx = new Ctx();
        }
        if (this._audioCtx?.state === 'suspended') {
            void this._audioCtx.resume();
        }
        return this._audioCtx;
    }

    _stopWebAudioSourceOnly() {
        if (this._activeSource) {
            try {
                this._activeSource.onended = null;
                this._activeSource.stop();
                this._activeSource.disconnect();
            } catch { /* ignore */ }
            this._activeSource = null;
        }
    }

    _pauseWebAudio() {
        if (!this._waPlaying || !this._audioCtx) return;
        this._waOffset = Math.min(this._waDuration, this._waOffset + (this._audioCtx.currentTime - this._waStartTime));
        this._waPlaying = false;
        this._stopWebAudioSourceOnly();
    }

    _resumeWebAudio() {
        if (!this._waBuffer) return;
        const offset = this._waOffset >= this._waDuration - 0.02 ? 0 : this._waOffset;
        this._startWebAudioBuffer(this._waBuffer, offset);
    }

    _startWebAudioBuffer(buffer, offset = 0) {
        const ctx = this._ensureAudioContext();
        if (!ctx) return;
        this._stopWebAudioSourceOnly();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const token = this._playToken;
        src.onended = () => {
            if (this._playToken !== token || this._activeMode !== 'webaudio') return;
            this._waPlaying = false;
            this._waOffset = 0;
            this._activeSource = null;
            this._activeMode = null;
            this._activeKey = null;
            this._activeEntry = null;
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
            window.dispatchEvent(new CustomEvent('gaia:stop'));
        };
        this._waBuffer = buffer;
        this._waDuration = buffer.duration;
        this._waOffset = offset;
        this._waStartTime = ctx.currentTime;
        this._waPlaying = true;
        this._activeSource = src;
        src.start(0, offset);
        window.gaiaTransport?.setCustomDriver?.(this._transportDriver);
        window.gaiaTransport?.render?.();
    }

    async _decodeToCache(url) {
        if (this._bufferCache.has(url)) {
            const buf = this._bufferCache.get(url);
            this._bufferCache.delete(url);
            this._bufferCache.set(url, buf);
            return buf;
        }
        if (this._inFlightDecodes.has(url)) {
            return this._inFlightDecodes.get(url);
        }
        const ctx = this._ensureAudioContext();
        if (!ctx) return null;

        const promise = (async () => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) return null;
                const ab = await resp.arrayBuffer();
                if (ab.byteLength > MAX_WEBAUDIO_BYTES) return null;
                const decoded = await ctx.decodeAudioData(ab);
                this._bufferCache.set(url, decoded);
                if (this._bufferCache.size > MAX_WEBAUDIO_CACHE) {
                    const oldest = this._bufferCache.keys().next().value;
                    this._bufferCache.delete(oldest);
                }
                return decoded;
            } catch {
                return null;
            } finally {
                this._inFlightDecodes.delete(url);
            }
        })();
        this._inFlightDecodes.set(url, promise);
        return promise;
    }

    prefetch(entry, streamUrl) {
        // Only needed for browser fallback when native libsin_dsp isn't active
        if (this.realtime.connected && this.realtime.available) return;
        if (!streamUrl) return;
        const size = entry?.content?.size_bytes ?? entry?.item?.size_bytes ?? 0;
        if (size > 0 && size <= MAX_WEBAUDIO_BYTES) {
            void this._decodeToCache(streamUrl);
        }
    }

    stop() {
        this._playToken += 1;
        if (this._activeMode === 'native') {
            this._nativePlaying = false;
            this.realtime.setTransport({ playing: false });
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
        }
        if (this._activeMode === 'webaudio') {
            this._waPlaying = false;
            this._stopWebAudioSourceOnly();
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
        }
        if (this._activeAudioEl) {
            try {
                this._activeAudioEl.pause();
                this._activeAudioEl.removeAttribute('src');
                this._activeAudioEl.load();
            } catch { /* ignore */ }
            this._activeAudioEl = null;
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
        }
        this._activeMode = null;
        this._activeKey = null;
        this._activeEntry = null;
        window.dispatchEvent(new CustomEvent('gaia:stop'));
    }

    isPlayingKey(key) {
        return Boolean(this._activeKey && this._activeKey === key);
    }

    async play(entry, { streamUrl, itemId = null, toggleIfSame = true } = {}) {
        const key = entry?.id;
        if (toggleIfSame && this._activeKey === key) {
            if (this._activeMode === 'native' || this._activeMode === 'webaudio' || this._activeMode === 'html5') {
                this._transportDriver.playPause();
                window.gaiaTransport?.render?.();
                return;
            }
        }

        this.stop();
        const token = ++this._playToken;
        this._activeKey = key;
        this._activeEntry = entry;

        // 1. Primary path: Existing native C++ libsin_dsp engine (< 5 ms from SSD / 0 ms C++ RAM LRU!)
        const numericId = Number(itemId ?? entry?.itemId ?? entry?.item?.id ?? entry?.content?.child_id);
        const durSec = entry?.content?.duration_seconds ?? entry?.item?.duration_seconds ?? 0;
        if (Number.isFinite(numericId) && numericId > 0) {
            void window.gaiaTransport?.loadWaveformForItem?.(numericId, durSec);
        }
        const editorOpen = Boolean(window.gaiaEditorHost?.isOpen?.());
        if (!editorOpen && Number.isFinite(numericId) && numericId > 0) {
            // Always await an in-flight warmUp() or initial connect() so first-click never falls through prematurely
            if (!this.realtime.connected) {
                this._connectStarted = true;
                await this.realtime.connect();
            }
            if (this._playToken !== token) return;
            if (this.realtime.connected && this.realtime.available) {
                const res = await this.realtime.previewItem(numericId, { play: true });
                if (this._playToken !== token) return;
                if (res && res.ok) {
                    this._activeMode = 'native';
                    this._nativePlaying = true;
                    this._nativePlayhead = Number(res.playhead_sec) || 0;
                    this._nativeDuration = Number(res.duration_sec) || 0;
                    window.gaiaTransport?.setCustomDriver?.(this._transportDriver);
                    window.gaiaTransport?.render?.();
                    return;
                }
            }
        }

        // 2. Web Audio LRU fallback (instant decoded replay for samples <= 8 MB)
        if (!streamUrl) return;
        const sizeBytes = entry?.content?.size_bytes ?? entry?.item?.size_bytes ?? 0;
        if ((!sizeBytes || sizeBytes <= MAX_WEBAUDIO_BYTES) && (!durSec || durSec <= 25)) {
            const buffer = await this._decodeToCache(streamUrl);
            if (this._playToken !== token) return;
            if (buffer) {
                this._activeMode = 'webaudio';
                if (!Number.isFinite(numericId) || numericId <= 0) {
                    window.gaiaTransport?.setWaveformAudioBuffer?.(buffer, buffer.duration);
                }
                this._startWebAudioBuffer(buffer, 0);
                return;
            }
        }

        // 3. HTML5 streaming fallback (long audio tracks / unsupported Web Audio codecs)
        const audio = new Audio(streamUrl);
        this._activeAudioEl = audio;
        this._activeMode = 'html5';
        const syncHtml5 = () => {
            if (this._playToken !== token || this._activeMode !== 'html5') return;
            window.gaiaTransport?.render?.();
        };
        for (const ev of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'seeked']) {
            audio.addEventListener(ev, syncHtml5);
        }
        audio.onended = () => {
            if (this._playToken !== token) return;
            if (window.gaiaTransport?.isFooterSeeking?.()) return;
            this._activeAudioEl = null;
            this._activeMode = null;
            this._activeKey = null;
            this._activeEntry = null;
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
            window.dispatchEvent(new CustomEvent('gaia:stop'));
        };
        window.gaiaTransport?.setCustomDriver?.(this._transportDriver);
        window.gaiaTransport?.render?.();
        audio.play().catch(() => {
            if (this._playToken !== token) return;
            this._activeAudioEl = null;
            this._activeMode = null;
            this._activeKey = null;
            this._activeEntry = null;
            window.gaiaTransport?.clearCustomDriver?.(this._transportDriver);
            window.dispatchEvent(new CustomEvent('gaia:stop'));
        });
    }
}

export const gaiaAudioPreview = new InstantAudioPreview();
window.gaiaAudioPreview = gaiaAudioPreview;
