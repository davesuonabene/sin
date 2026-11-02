import { getSharedAudioContext } from './audioBufferCache.ts';

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
    private analyser: AnalyserNode | null = null;
    private activeSources: { source: AudioBufferSourceNode; gain: GainNode; startTime: number; endTime: number; barIndex: number }[] = [];
    private barBuffers = new Map<number, AudioBuffer>();
    private fullAudioBuffer: AudioBuffer | null = null;
    private fullBufferDirty = false;
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
            const shared = getSharedAudioContext();
            if (shared) {
                this.audioCtx = shared;
            } else {
                const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
                this.audioCtx = new AudioCtx();
            }
            this.masterGain = this.audioCtx.createGain();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.5;
            this.masterGain.connect(this.analyser);
            this.analyser.connect(this.audioCtx.destination);
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        return this.audioCtx;
    }

    getAudioContext(): AudioContext {
        return this.ensureContext();
    }

    async ensureContextReady(): Promise<AudioContext> {
        const ctx = this.ensureContext();
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            try {
                await ctx.resume();
            } catch {
                // Ignore resume failures in headless or restricted environments
            }
        }
        return ctx;
    }

    getFloatTimeDomainData(array: Float32Array): void {
        if (this.analyser) {
            (this.analyser as any).getFloatTimeDomainData(array);
        } else {
            array.fill(0);
        }
    }

    getFullAudioBuffer(): AudioBuffer | null {
        if (this.fullBufferDirty) {
            this.updateFullBuffer();
        }
        return this.fullAudioBuffer;
    }

    connectToAnalyser(analyser: AnalyserNode): void {
        const ctx = this.ensureContext();
        if (this.masterGain) {
            try { this.masterGain.disconnect(); } catch { }
            this.masterGain.connect(analyser);
            analyser.connect(ctx.destination);
        }
    }

    setCallback(cb: (currentTime: number, duration: number, isPlaying: boolean, bufferedProgress: number) => void): void {
        this.onTimeUpdate = cb;
    }

    private pausedTime = 0;
    private stagedSession: {
        sessionId: number;
        barBuffers: Map<number, AudioBuffer>;
        totalBars: number;
        bpm: number;
        secondsPerBar: number;
    } | null = null;

    reset(): void {
        this.stop();
        this.barBuffers.clear();
        this.stagedSession = null;
        this.fullAudioBuffer = null;
        this.fullBufferDirty = false;
        this.totalBars = 0;
        this.lastScheduledBar = -1;
        this.pausedTime = 0;
    }

    private stopSources(): void {
        for (const item of this.activeSources) {
            try {
                item.source.stop();
                item.source.disconnect();
                item.gain.disconnect();
            } catch { }
        }
        this.activeSources = [];
        this.lastScheduledBar = -1;
    }

    stop(): void {
        this.pausedTime = 0;
        this.stopSources();
        this.isPlaying = false;
    }

    pause(): void {
        if (!this.isPlaying) return;
        this.pausedTime = this.getCurrentTime();
        this.stopSources();
        this.isPlaying = false;
    }

    play(): void {
        if (this.isPlaying) return;
        if (this.barBuffers.size === 0) return;
        this.ensureContext();
        const totalDuration = this.getTotalDuration();
        const resumeTime = this.pausedTime || 0;
        const startTime = (totalDuration > 0 && resumeTime >= totalDuration && !this.loop) ? 0 : resumeTime;
        this.isPlaying = true;
        this.seek(startTime);
    }

    async playAsync(): Promise<void> {
        if (this.isPlaying) return;
        if (this.barBuffers.size === 0) return;
        await this.ensureContextReady();
        this.play();
    }

    async playFromStart(): Promise<void> {
        if (this.barBuffers.size === 0) return;
        await this.ensureContextReady();
        this.pausedTime = 0;
        this.startPlaybackFromBarZero();
    }

    getBufferedProgress(): number {
        if (this.totalBars <= 0) return 0;
        return Math.min(1.0, this.barBuffers.size / this.totalBars);
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    setLoop(loop: boolean): void {
        this.loop = loop;
    }

    getLoop(): boolean {
        return this.loop;
    }

    getCurrentTime(): number {
        if (!this.isPlaying) return this.pausedTime || 0;
        if (!this.audioCtx) return 0;
        const outputLatency = Number((this.audioCtx as any).outputLatency || (this.audioCtx as any).baseLatency || 0);
        const elapsed = Math.max(0, (this.audioCtx.currentTime - this.playbackStartTime) - outputLatency);
        const totalDuration = this.totalBars * this.secondsPerBar;
        if (totalDuration <= 0) return 0;
        if (elapsed < 0) return 0;
        if (this.loop) {
            return ((elapsed % totalDuration) + totalDuration) % totalDuration;
        }
        return Math.min(totalDuration, Math.max(0, elapsed));
    }

    getTotalDuration(): number {
        return this.totalBars * this.secondsPerBar;
    }

    /**
     * Decode raw binary WAV ArrayBuffer into an AudioBuffer directly without base64 CPU overhead.
     */
    async decodeWav(arrayBuffer: ArrayBuffer): Promise<AudioBuffer | null> {
        try {
            const ctx = this.ensureContext();
            return await ctx.decodeAudioData(arrayBuffer.slice(0));
        } catch (err) {
            console.warn('[GaplessAudioScheduler] Failed to decode WAV ArrayBuffer:', err);
            return null;
        }
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

    private spawnBarSource(
        barIndex: number,
        buffer: AudioBuffer,
        startTime: number,
        offsetInBar: number = 0,
        fadeIn: boolean = false,
        logicalStartTime: number = startTime
    ) {
        if (!this.audioCtx || !this.masterGain) return null;
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        const gain = this.audioCtx.createGain();
        if (fadeIn) {
            gain.gain.setValueAtTime(0.0001, startTime);
            gain.gain.linearRampToValueAtTime(1.0, startTime + 0.015);
        } else {
            gain.gain.setValueAtTime(1.0, startTime);
        }
        source.connect(gain);
        gain.connect(this.masterGain);
        if (offsetInBar > 0) {
            source.start(startTime, offsetInBar);
        } else {
            source.start(startTime);
        }
        const duration = offsetInBar > 0
            ? (buffer.duration - offsetInBar)
            : Math.max(buffer.duration, this.secondsPerBar);
        const entry = { source, gain, startTime: logicalStartTime, endTime: startTime + duration, barIndex };
        source.onended = () => {
            const idx = this.activeSources.findIndex(s => s.source === source);
            if (idx >= 0) this.activeSources.splice(idx, 1);
            if (!this.loop && this.activeSources.length === 0 && this.lastScheduledBar >= this.totalBars - 1) {
                this.stop();
            }
        };
        return entry;
    }

    seek(targetTime: number): void {
        const totalDuration = this.totalBars * this.secondsPerBar;
        if (totalDuration <= 0 || !this.audioCtx) {
            this.pausedTime = Math.max(0, targetTime);
            return;
        }
        const clamped = Math.max(0, Math.min(totalDuration, targetTime));
        this.pausedTime = clamped;

        if (!this.isPlaying) {
            return;
        }

        const barIndex = Math.min(this.totalBars - 1, Math.floor(clamped / this.secondsPerBar));
        const offsetInBar = clamped - (barIndex * this.secondsPerBar);

        this.stopSources();
        this.isPlaying = true;
        const now = this.audioCtx.currentTime;
        this.playbackStartTime = now - clamped;
        this.lastScheduledBar = barIndex - 1;
        this.nextScheduleTime = now;

        const buffer = this.barBuffers.get(barIndex);
        if (buffer) {
            const entry = this.spawnBarSource(barIndex, buffer, now, offsetInBar);
            if (entry) {
                this.activeSources.push(entry);
                this.lastScheduledBar = barIndex;
                this.nextScheduleTime = entry.endTime;
            }
        }
        this.scheduleNextAvailableBars();
    }

    private updateFullBuffer(): void {
        this.fullBufferDirty = false;
        if (this.barBuffers.size === 0 || !this.audioCtx) return;
        const sortedIndices = Array.from(this.barBuffers.keys()).sort((a, b) => a - b);
        let totalLen = 0;
        let numChannels = 1;
        let sr = 44100;
        for (const idx of sortedIndices) {
            const b = this.barBuffers.get(idx);
            if (b) {
                totalLen += b.length;
                numChannels = Math.max(numChannels, b.numberOfChannels);
                sr = b.sampleRate;
            }
        }
        if (totalLen === 0) return;

        const merged = this.audioCtx.createBuffer(numChannels, totalLen, sr);
        let offset = 0;
        for (const idx of sortedIndices) {
            const b = this.barBuffers.get(idx);
            if (!b) continue;
            for (let ch = 0; ch < numChannels; ch++) {
                const src = b.numberOfChannels > ch ? b.getChannelData(ch) : b.getChannelData(0);
                merged.getChannelData(ch).set(src, offset);
            }
            offset += b.length;
        }
        this.fullAudioBuffer = merged;
    }

    private currentSessionId = 0;

    startSession(chunk: BarChunk, autoplay: boolean = true, sessionId?: number): void {
        this.ensureContext();
        if (sessionId !== undefined) {
            this.currentSessionId = sessionId;
        }

        if (autoplay || !this.isPlaying) {
            this.stagedSession = null;
            this.barBuffers.clear();
            this.barBuffers.set(0, chunk.audioBuffer);
            this.totalBars = chunk.totalBars || 1;
            this.bpm = chunk.bpm || 120;
            this.secondsPerBar = chunk.durationSeconds || 2.0;
            this.fullBufferDirty = true;

            if (autoplay) {
                this.pausedTime = 0;
                this.startPlaybackFromBarZero();
            } else {
                this.pausedTime = 0;
                this.stopSources();
                this.isPlaying = false;
            }
        } else {
            // Live evaluation or parameter change while transport is playing:
            // Stage incoming bars off-screen and swap atomically on commitSession()
            this.stagedSession = {
                sessionId: this.currentSessionId,
                barBuffers: new Map([[0, chunk.audioBuffer]]),
                totalBars: chunk.totalBars || this.totalBars,
                bpm: chunk.bpm || this.bpm,
                secondsPerBar: chunk.durationSeconds || this.secondsPerBar,
            };
        }
    }

    /**
     * Ingest a progressive bar chunk from the streaming preview endpoint.
     */
    addBarChunk(chunk: BarChunk, sessionId?: number): void {
        if (sessionId !== undefined && sessionId !== this.currentSessionId) {
            return; // Discard stale chunk from superseded preview request
        }
        if (chunk.barIndex === 0) {
            this.startSession(chunk, false, sessionId);
            return;
        }

        this.ensureContext();
        if (this.stagedSession && (sessionId === undefined || this.stagedSession.sessionId === sessionId)) {
            this.stagedSession.barBuffers.set(chunk.barIndex, chunk.audioBuffer);
            this.stagedSession.totalBars = Math.max(this.stagedSession.totalBars, chunk.totalBars);
            this.stagedSession.bpm = chunk.bpm || this.stagedSession.bpm;
            this.stagedSession.secondsPerBar = chunk.durationSeconds || this.stagedSession.secondsPerBar;
            return;
        }

        this.barBuffers.set(chunk.barIndex, chunk.audioBuffer);
        this.totalBars = Math.max(this.totalBars, chunk.totalBars);
        this.bpm = chunk.bpm || this.bpm;
        this.secondsPerBar = chunk.durationSeconds || this.secondsPerBar;
        this.fullBufferDirty = true;

        if (this.isPlaying) {
            this.hotSwapBarBuffer(chunk.barIndex, chunk.audioBuffer);
            this.scheduleNextAvailableBars();
        }
    }

    /**
     * Stage incoming progressive bar chunks off-screen without mutating active playback buffers
     * or triggering partial-buffer visual refreshes until commitSession() is called.
     */
    stageBarChunk(chunk: BarChunk, sessionId: number): number {
        this.ensureContext();
        if (chunk.barIndex === 0 || !this.stagedSession || this.stagedSession.sessionId !== sessionId) {
            this.currentSessionId = sessionId;
            this.stagedSession = {
                sessionId,
                barBuffers: new Map([[chunk.barIndex, chunk.audioBuffer]]),
                totalBars: Math.max(1, chunk.totalBars || 1),
                bpm: chunk.bpm || this.bpm || 120,
                secondsPerBar: chunk.durationSeconds || this.secondsPerBar || 2.0,
            };
        } else {
            if (sessionId !== this.currentSessionId) {
                return 0;
            }
            this.stagedSession.barBuffers.set(chunk.barIndex, chunk.audioBuffer);
            this.stagedSession.totalBars = Math.max(this.stagedSession.totalBars, chunk.totalBars || 1);
            this.stagedSession.bpm = chunk.bpm || this.stagedSession.bpm;
            this.stagedSession.secondsPerBar = chunk.durationSeconds || this.stagedSession.secondsPerBar;
        }
        return Math.min(1.0, this.stagedSession.barBuffers.size / Math.max(1, this.stagedSession.totalBars));
    }

    /**
     * Atomically swap a completed background session into live transport without interrupting playback.
     */
    commitSession(sessionId?: number): void {
        if (!this.stagedSession) return;
        if (sessionId !== undefined && this.stagedSession.sessionId !== sessionId) return;

        const staged = this.stagedSession;
        this.stagedSession = null;
        if (staged.barBuffers.size === 0) return;

        this.barBuffers = new Map(staged.barBuffers);
        this.totalBars = staged.totalBars;
        this.bpm = staged.bpm;
        this.secondsPerBar = staged.secondsPerBar;
        this.updateFullBuffer();

        if (this.isPlaying) {
            for (const [barIdx, buf] of this.barBuffers.entries()) {
                this.hotSwapBarBuffer(barIdx, buf);
            }
            this.scheduleNextAvailableBars();
        } else {
            const totalDuration = this.getTotalDuration();
            if (totalDuration > 0 && this.pausedTime >= totalDuration) {
                this.pausedTime = 0;
            }
        }
    }

    private startPlaybackFromBarZero(): void {
        const ctx = this.ensureContext();
        const bar0Buffer = this.barBuffers.get(0);
        if (!bar0Buffer) return;

        // Smoothly fade out currently playing sources to prevent audio clicks/pops
        const now = ctx.currentTime;
        for (const item of this.activeSources) {
            try {
                item.gain.gain.setValueAtTime(item.gain.gain.value, now);
                item.gain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
                item.source.stop(now + 0.02);
            } catch { }
        }
        this.activeSources = [];

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

    /**
     * Periodic lookahead check to schedule upcoming bars before buffer underrun.
     */
    tick(): void {
        if (this.isPlaying) {
            this.scheduleNextAvailableBars();
        }
    }

    private scheduleNextAvailableBars(): void {
        if (!this.isPlaying || !this.audioCtx) return;
        const lookaheadHorizon = this.audioCtx.currentTime + 0.5;

        // Re-synchronize schedule time if it fell behind actual Web Audio currentTime
        if (this.nextScheduleTime < this.audioCtx.currentTime - 0.05) {
            this.nextScheduleTime = this.audioCtx.currentTime + 0.02;
            const nextBarToPlay = Math.max(0, (this.lastScheduledBar + 1) % Math.max(1, this.totalBars));
            this.playbackStartTime = this.nextScheduleTime - (nextBarToPlay * this.secondsPerBar);
        }

        let guard = 0;
        while (this.isPlaying && this.nextScheduleTime < lookaheadHorizon && this.barBuffers.size > 0 && guard++ < 32) {
            let nextBar = this.lastScheduledBar + 1;
            if (nextBar >= this.totalBars) {
                if (this.loop && this.totalBars > 0) {
                    nextBar = 0;
                } else {
                    break;
                }
            }

            if (!this.barBuffers.has(nextBar)) {
                break;
            }

            this.scheduleBar(nextBar, this.nextScheduleTime);
        }
    }

    private scheduleBar(barIndex: number, scheduleTime: number): void {
        this.ensureContext();
        const buffer = this.barBuffers.get(barIndex);
        if (!buffer) return;
        const entry = this.spawnBarSource(barIndex, buffer, scheduleTime);
        if (entry) {
            this.activeSources.push(entry);
            this.lastScheduledBar = barIndex;
            this.nextScheduleTime = entry.endTime;
        }
    }

    /**
     * Hot-swap update: updates the buffer for a specific bar with smooth micro-crossfade
     */
    hotSwapBarBuffer(barIndex: number, newBuffer: AudioBuffer): void {
        this.barBuffers.set(barIndex, newBuffer);
        this.fullBufferDirty = true;
        if (!this.isPlaying || !this.audioCtx || !this.masterGain) return;

        const now = this.audioCtx.currentTime;
        for (let i = 0; i < this.activeSources.length; i++) {
            const item = this.activeSources[i];
            if (item.barIndex !== barIndex) continue;
            if (now >= item.startTime && now < item.endTime) {
                const offset = Math.max(0, now - item.startTime);
                if (offset < newBuffer.duration) {
                    try {
                        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
                        item.gain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
                        item.source.stop(now + 0.02);
                        const entry = this.spawnBarSource(barIndex, newBuffer, now, offset, true, item.startTime);
                        if (entry) this.activeSources[i] = entry;
                    } catch (e) {
                        console.warn('[GaplessAudioScheduler] Hot-swap crossfade error:', e);
                    }
                }
            } else if (item.startTime > now) {
                try {
                    item.source.stop();
                    item.source.disconnect();
                    item.gain.disconnect();
                    const entry = this.spawnBarSource(barIndex, newBuffer, item.startTime);
                    if (entry) this.activeSources[i] = entry;
                } catch (e) {
                    console.warn('[GaplessAudioScheduler] Future source hot-swap error:', e);
                }
            }
        }
    }
}

export const globalAudioScheduler = new GaplessAudioScheduler();
