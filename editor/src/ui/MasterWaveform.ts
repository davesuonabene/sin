import { loggedTask } from '../runtimeLog';
import { getSharedAudioContext } from '../audioBufferCache.ts';
import { WaveformScrubCanvas, formatTransportTime } from '../../../packages/ui/src/waveform-scrub.js';

export interface MasterWaveformContextInfo {
    label?: string;
    color?: string;
    badge?: string;
    bpm?: number;
    totalBars?: number | null;
}

export class MasterWaveform {
    private readonly scrub: WaveformScrubCanvas;
    private readonly hudLeftEl: HTMLDivElement | null = null;
    private readonly hudDotEl: HTMLSpanElement | null = null;
    private readonly hudLabelEl: HTMLSpanElement | null = null;
    private readonly hudBadgeEl: HTMLSpanElement | null = null;
    private readonly hudZoomEl: HTMLSpanElement | null = null;
    private readonly hudTimeEl: HTMLSpanElement | null = null;
    private readonly hudMetaEl: HTMLSpanElement | null = null;
    private loadToken = 0;
    private lastTimeText = '';
    private lastZoomText = '';
    private lastMetaText = '';
    private lastContextKey = '';

    constructor(
        container: HTMLElement,
        onSeek: (progress: number) => void,
        onViewportChange?: (startSec: number, endSec: number, columns: number) => void
    ) {
        this.scrub = new WaveformScrubCanvas(container, {
            emptyMessage: 'Ready to render',
            ariaLabel: 'Audio timeline',
            enableZoom: true,
            onSeek,
            onViewportChange: (startSec: number, endSec: number, columns: number) => {
                this.syncZoomHud();
                onViewportChange?.(startSec, endSec, columns);
            },
        });

        // Lightweight non-interactive HUD inside the waveform visualizer (reusing shared WaveformScrubCanvas)
        if (typeof document !== 'undefined') {
            const hud = document.createElement('div');
            hud.className = 'master-waveform-hud';
            hud.setAttribute('aria-hidden', 'true');

            const left = document.createElement('div');
            left.className = 'master-waveform-hud-left';
            const dot = document.createElement('span');
            dot.className = 'master-waveform-hud-dot';
            const label = document.createElement('span');
            label.className = 'master-waveform-hud-label';
            const badge = document.createElement('span');
            badge.className = 'master-waveform-hud-badge is-hidden';
            const zoom = document.createElement('span');
            zoom.className = 'master-waveform-hud-zoom is-hidden';
            left.append(dot, label, badge, zoom);
            left.classList.add('is-hidden');

            const right = document.createElement('div');
            right.className = 'master-waveform-hud-right';
            const meta = document.createElement('span');
            meta.className = 'master-waveform-hud-meta is-hidden';
            const time = document.createElement('span');
            time.className = 'master-waveform-hud-time';
            right.append(meta, time);

            hud.append(left, right);
            container.appendChild(hud);

            this.hudLeftEl = left;
            this.hudDotEl = dot;
            this.hudLabelEl = label;
            this.hudBadgeEl = badge;
            this.hudZoomEl = zoom;
            this.hudTimeEl = time;
            this.hudMetaEl = meta;
        }

        this.syncTimeDisplay();
    }

    setContext(info: MasterWaveformContextInfo): void {
        const label = (info.label || '').trim();
        const color = info.color || '#4f46e5';
        const badge = (info.badge || '').trim();
        const bpm = Number.isFinite(info.bpm) && Number(info.bpm) > 0 ? Math.round(Number(info.bpm)) : 0;
        const bars = info.totalBars;
        const barsText = bars == null ? '' : (bars < 0 ? 'Free' : `${bars} ${bars === 1 ? 'bar' : 'bars'}`);
        const metaText = bpm > 0 ? (barsText ? `${bpm} BPM · ${barsText}` : `${bpm} BPM`) : barsText;

        const key = `${label}|${color}|${badge}`;
        if (key !== this.lastContextKey) {
            this.lastContextKey = key;
            if (this.hudLeftEl && this.hudDotEl && this.hudLabelEl && this.hudBadgeEl) {
                this.hudLeftEl.classList.toggle('is-hidden', !label);
                this.hudDotEl.style.backgroundColor = color;
                this.hudLabelEl.textContent = label;
                this.hudBadgeEl.textContent = badge;
                this.hudBadgeEl.classList.toggle('is-hidden', !badge);
            }
        }
        if (metaText !== this.lastMetaText) {
            this.lastMetaText = metaText;
            if (this.hudMetaEl) {
                this.hudMetaEl.textContent = metaText;
                this.hudMetaEl.classList.toggle('is-hidden', !metaText);
            }
        }
    }

    async load(source: string): Promise<AudioBuffer | null> {
        const token = ++this.loadToken;
        this.scrub.setMessage('Loading waveform...');
        try {
            const audioContext = getSharedAudioContext();
            if (!audioContext) throw new Error('AudioContext unavailable');
            const decoded = await loggedTask('Load preview waveform', async () => {
                const response = await fetch(source);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.arrayBuffer();
                return audioContext.decodeAudioData(data);
            });
            if (token !== this.loadToken) return null;
            this.scrub.setAudioBuffer(decoded, decoded.duration);
            this.syncTimeDisplay();
            return decoded;
        } catch (error) {
            if (token !== this.loadToken) return null;
            console.error('Could not load master waveform', error);
            this.scrub.setMessage('Waveform unavailable');
            this.syncTimeDisplay();
            return null;
        }
    }

    get playbackContext(): AudioContext | null {
        return getSharedAudioContext();
    }

    get duration() {
        return this.scrub.duration;
    }

    setPlayback(currentTime: number, duration: number) {
        this.scrub.setPlayback(currentTime, duration);
        this.syncTimeDisplay();
    }

    setAudioBuffer(buffer: AudioBuffer, totalExpectedDuration?: number): void {
        this.loadToken++;
        this.scrub.setAudioBuffer(buffer, totalExpectedDuration);
        this.syncTimeDisplay();
        this.syncZoomHud();
    }

    setPeaks(
        interleavedMinMax: number[],
        durationSeconds: number,
        options?: { tiers?: number[] | Uint8Array | null; viewStartSec?: number; viewEndSec?: number; preserveTiers?: boolean }
    ): void {
        this.loadToken++;
        this.scrub.setInterleavedPeaks(interleavedMinMax, durationSeconds, options);
        this.syncTimeDisplay();
        this.syncZoomHud();
    }

    setProgressOnly(durationSeconds: number, message = ''): void {
        this.loadToken++;
        this.scrub.setProgressOnly(durationSeconds, message);
        this.syncTimeDisplay();
    }

    applyTileDelta(delta: {
        startSec: number;
        endSec: number;
        durationSec?: number;
        tier?: number;
        stale?: boolean;
        peaks?: number[] | null;
        clearAll?: boolean;
    }): void {
        this.scrub.applyTileDelta(delta);
        this.syncTimeDisplay();
    }

    clearTileTiers(): void {
        this.scrub.clearTileTiers();
    }

    markAllTiersStale(): void {
        this.scrub.markAllTiersStale();
    }

    getViewport(): { startSec: number; endSec: number; zoom: number; columns: number } {
        return this.scrub.getViewport();
    }

    resetZoom(): void {
        this.scrub.resetZoom();
        this.syncZoomHud();
    }

    clear(message = 'Ready to render') {
        this.loadToken++;
        this.scrub.clear(message);
        this.syncTimeDisplay();
        this.syncZoomHud();
    }

    private syncZoomHud(): void {
        if (!this.hudZoomEl) return;
        const zoom = this.scrub.getViewport().zoom;
        const nextText = zoom > 1.05 ? `${zoom.toFixed(1)}×` : '';
        if (nextText !== this.lastZoomText) {
            this.lastZoomText = nextText;
            this.hudZoomEl.textContent = nextText;
            this.hudZoomEl.classList.toggle('is-hidden', !nextText);
        }
    }

    private syncTimeDisplay(): void {
        if (!this.hudTimeEl) return;
        const dur = this.scrub.duration;
        const cur = this.scrub.currentTime;
        const nextText = `${formatTransportTime(cur)} / ${formatTransportTime(dur)}`;
        if (nextText !== this.lastTimeText) {
            this.lastTimeText = nextText;
            this.hudTimeEl.textContent = nextText;
        }
    }
}
