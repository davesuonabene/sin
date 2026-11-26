import { loggedTask } from '../runtimeLog';
import { getSharedAudioContext } from '../audioBufferCache.ts';
import { WaveformScrubCanvas, formatTransportTime } from '../../../packages/ui/src/waveform-scrub.js';

export class MasterWaveform {
    private readonly scrub: WaveformScrubCanvas;
    private readonly timeDisplay: HTMLElement | null;
    private loadToken = 0;
    private lastTimeText = '';

    constructor(
        container: HTMLElement,
        onSeek: (progress: number) => void,
        onViewportChange?: (startSec: number, endSec: number, columns: number) => void
    ) {
        this.timeDisplay = typeof document !== 'undefined' ? document.getElementById('master-time-display') : null;
        this.scrub = new WaveformScrubCanvas(container, {
            emptyMessage: 'Ready to render',
            ariaLabel: 'Audio timeline',
            enableZoom: true,
            onSeek,
            onViewportChange,
        });
        this.syncTimeDisplay();
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
    }

    setPeaks(
        interleavedMinMax: number[],
        durationSeconds: number,
        options?: { tiers?: number[] | Uint8Array | null; viewStartSec?: number; viewEndSec?: number; preserveTiers?: boolean }
    ): void {
        this.loadToken++;
        this.scrub.setInterleavedPeaks(interleavedMinMax, durationSeconds, options);
        this.syncTimeDisplay();
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
    }

    clear(message = 'Ready to render') {
        this.loadToken++;
        this.scrub.clear(message);
        this.syncTimeDisplay();
    }

    private syncTimeDisplay(): void {
        const target = this.timeDisplay || (typeof document !== 'undefined' ? document.getElementById('master-time-display') : null);
        if (!target) return;
        const dur = this.scrub.duration;
        const cur = this.scrub.currentTime;
        const nextText = `${formatTransportTime(cur)} / ${formatTransportTime(dur)}`;
        if (nextText !== this.lastTimeText) {
            this.lastTimeText = nextText;
            target.textContent = nextText;
        }
    }
}
