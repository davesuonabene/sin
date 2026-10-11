/**
 * Gapless Web Audio scheduler for progressive bar-by-bar streaming previews.
 * Provides dynamic lead latency, sample-accurate chunk stitching, and seamless hot-swap transitions.
 */

export interface BarChunk {
    barIndex: number;
    totalBars: number;
    bpm: number;
    startSeconds: number;
    durationSeconds: number;
    audioBuffer: AudioBuffer;
    peaks?: number[];
}

export class GaplessAudioScheduler {
    private audioCtx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private activeSources: { source: AudioBufferSourceNode; gain: GainNode; startTime: number; endTime: number }[] = [];
    private barBuffers = new Map<number, AudioBuffer>();
    private totalBars = 0;
    private bpm = 120;
    private secondsPerBar = 2.0;

    private isPlaying = false;
    private loop = true;
    private playbackStartTime = 0; // AudioContext time when playback began
    private nextScheduleTime = 0;  // AudioContext time where next bar should start
    private lastScheduledBar = -1;
    public onTimeUpdate?: (currentTime: number, duration: number, isPlaying: boolean, bufferedProgress: number) => void;

    getBpm(): number {
        return this.bpm;
    }

    constructor() {
        // AudioContext initialized lazily on user gesture
    }

    private ensureContext(): AudioContext {
        if (!this.audioCtx) {
            const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
            this.audioCtx = new AudioCtx();
            this.masterGain = this.audioCtx.createGain();
            this.masterGain.connect(this.audioCtx.destination);
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        return this.audioCtx;
    }

    getAudioContext(): AudioContext {
        return this.ensureContext();
    }

    connectToAnalyser(analyser: AnalyserNode): void {
        const ctx = this.ensureContext();
        if (this.masterGain) {
            try { this.masterGain.disconnect(); } catch {}
            this.masterGain.connect(analyser);
            analyser.connect(ctx.destination);
        }
    }

    setCallback(cb: (currentTime: number, duration: number, isPlaying: boolean, bufferedProgress: number) => void): void {
        this.onTimeUpdate = cb;
    }

    reset(): void {
        this.stop();
        this.barBuffers.clear();
        this.totalBars = 0;
        this.lastScheduledBar = -1;
    }

    stop(): void {
        this.isPlaying = false;
        for (const item of this.activeSources) {
            try {
                item.source.stop();
                item.source.disconnect();
                item.gain.disconnect();
            } catch {}
        }
        this.activeSources = [];
        this.lastScheduledBar = -1;
    }

    getBufferedProgress(): number {
        if (this.totalBars <= 0) return 0;
        return Math.min(1.0, this.barBuffers.size / this.totalBars);
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    getCurrentTime(): number {
        if (!this.isPlaying || !this.audioCtx) return 0;
        const elapsed = this.audioCtx.currentTime - this.playbackStartTime;
        const totalDuration = this.totalBars * this.secondsPerBar;
        if (totalDuration <= 0) return 0;
        if (this.loop) {
            return ((elapsed % totalDuration) + totalDuration) % totalDuration;
        }
        return Math.min(totalDuration, Math.max(0, elapsed));
    }

    getTotalDuration(): number {
        return this.totalBars * this.secondsPerBar;
    }

    /**
     * Decode base64 WAV string into an AudioBuffer using the shared AudioContext.
     */
    async decodeBase64Wav(base64Wav: string): Promise<AudioBuffer | null> {
        try {
            const ctx = this.ensureContext();
            const binary = atob(base64Wav);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return await ctx.decodeAudioData(bytes.buffer);
        } catch (err) {
            console.warn('[GaplessAudioScheduler] Failed to decode base64 chunk:', err);
            return null;
        }
    }

    /**
     * Ingest a progressive bar chunk from the streaming preview endpoint.
     */
    addBarChunk(chunk: BarChunk, autoplay: boolean = true): void {
        this.ensureContext();
        this.barBuffers.set(chunk.barIndex, chunk.audioBuffer);
        this.totalBars = Math.max(this.totalBars, chunk.totalBars);
        this.bpm = chunk.bpm;
        this.secondsPerBar = chunk.durationSeconds;

        // If Bar 0 arrives and we are not playing, dynamic latency threshold is met!
        if (chunk.barIndex === 0 && autoplay && !this.isPlaying) {
            this.startPlaybackFromBarZero();
        } else if (this.isPlaying) {
            this.scheduleNextAvailableBars();
        }
    }

    private startPlaybackFromBarZero(): void {
        const ctx = this.ensureContext();
        const bar0Buffer = this.barBuffers.get(0);
        if (!bar0Buffer) return;

        this.stop();
        this.isPlaying = true;

        // Dynamic Lead Latency: 40ms safety offset
        const leadOffset = 0.04;
        const startTime = ctx.currentTime + leadOffset;
        this.playbackStartTime = startTime;
        this.nextScheduleTime = startTime;
        this.lastScheduledBar = -1;

        this.scheduleBar(0, startTime);
        this.scheduleNextAvailableBars();
    }

    private scheduleNextAvailableBars(): void {
        if (!this.isPlaying) return;
        let nextBar = this.lastScheduledBar + 1;
        while (this.barBuffers.has(nextBar)) {
            this.scheduleBar(nextBar, this.nextScheduleTime);
            nextBar++;
        }
    }

    private scheduleBar(barIndex: number, scheduleTime: number): void {
        const ctx = this.ensureContext();
        const buffer = this.barBuffers.get(barIndex);
        if (!buffer || !this.masterGain) return;

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(1.0, scheduleTime);

        source.connect(gain);
        gain.connect(this.masterGain);

        source.start(scheduleTime);
        const endTime = scheduleTime + buffer.duration;
        this.activeSources.push({ source, gain, startTime: scheduleTime, endTime });

        this.lastScheduledBar = barIndex;
        this.nextScheduleTime = endTime;

        // Cleanup expired source records
        source.onended = () => {
            const idx = this.activeSources.findIndex(s => s.source === source);
            if (idx >= 0) {
                this.activeSources.splice(idx, 1);
            }
            // Loop check
            if (this.loop && this.isPlaying && barIndex === this.totalBars - 1) {
                // Loop back to bar 0 seamlessly
                this.lastScheduledBar = -1;
                this.scheduleNextAvailableBars();
            }
        };
    }

    /**
     * Hot-swap update: updates the buffer for a specific bar with crossfade
     */
    hotSwapBarBuffer(barIndex: number, newBuffer: AudioBuffer): void {
        this.barBuffers.set(barIndex, newBuffer);
        if (!this.isPlaying || !this.audioCtx) return;

        // Crossfade currently playing instance if active
        const now = this.audioCtx.currentTime;
        for (const item of this.activeSources) {
            if (now >= item.startTime && now < item.endTime) {
                // Smooth 10ms micro-crossfade
                try {
                    item.gain.gain.setValueAtTime(item.gain.gain.value, now);
                    item.gain.gain.linearRampToValueAtTime(0.001, now + 0.01);
                } catch {}
            }
        }
    }
}

export const globalAudioScheduler = new GaplessAudioScheduler();
