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

const WORKLET_PROCESSOR_CODE = `
class RingBufferProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queues = [[], []];
        this.offsets = [0, 0];
        this.isPlaying = false;
        this.port.onmessage = (e) => {
            const data = e.data;
            if (!data) return;
            if (data.type === 'push_pcm') {
                const chans = data.channels;
                for (let c = 0; c < chans.length; c++) {
                    if (!this.queues[c]) this.queues[c] = [];
                    this.queues[c].push(chans[c]);
                }
            } else if (data.type === 'clear') {
                this.queues = [[], []];
                this.offsets = [0, 0];
            } else if (data.type === 'set_playing') {
                this.isPlaying = Boolean(data.isPlaying);
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!this.isPlaying || !output || output.length === 0) return true;
        const q0 = this.queues[0];
        if (!q0 || q0.length === 0) return true;
        const frames = output[0].length;
        const numChans = output.length;

        for (let c = 0; c < numChans; c++) {
            const outChan = output[c];
            const q = this.queues[c] || this.queues[0];
            let written = 0;

            while (q && q.length > 0 && written < frames) {
                const block = q[0];
                const off = this.offsets[c] || 0;
                const avail = block.length - off;
                const toCopy = Math.min(frames - written, avail);
                outChan.set(block.subarray(off, off + toCopy), written);
                written += toCopy;
                const nextOff = off + toCopy;
                if (nextOff >= block.length) {
                    q.shift();
                    this.offsets[c] = 0;
                } else {
                    this.offsets[c] = nextOff;
                }
            }

            if (written < frames) {
                outChan.fill(0, written);
            }
        }
        return true;
    }
}
registerProcessor('ring-buffer-processor', RingBufferProcessor);
`;

export class GaplessAudioScheduler {
    private audioCtx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private analyser: AnalyserNode | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private workletEnabled = false;
    private workletInitAttempted = false;
    private activeSources: { source: AudioBufferSourceNode; gain: GainNode; startTime: number; endTime: number; barIndex: number }[] = [];
    private barBuffers = new Map<number, AudioBuffer>();
    private fullAudioBuffer: AudioBuffer | null = null;
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

    private async initAudioWorklet(ctx: AudioContext): Promise<boolean> {
        if (this.workletInitAttempted) return this.workletEnabled;
        this.workletInitAttempted = true;
        try {
            if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
                return false;
            }
            const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);

            this.workletNode = new AudioWorkletNode(ctx, 'ring-buffer-processor');
            if (this.masterGain) {
                this.workletNode.connect(this.masterGain);
            }
            this.workletEnabled = true;
            return true;
        } catch (e) {
            console.warn('[GaplessAudioScheduler] AudioWorklet fallback to AudioBufferSourceNode:', e);
            this.workletEnabled = false;
            return false;
        }
    }

    private ensureContext(): AudioContext {
        if (!this.audioCtx) {
            const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
            this.audioCtx = new AudioCtx();
            this.masterGain = this.audioCtx.createGain();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.5;
            this.masterGain.connect(this.analyser);
            this.analyser.connect(this.audioCtx.destination);
            void this.initAudioWorklet(this.audioCtx);
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        return this.audioCtx;
    }

    getAudioContext(): AudioContext {
        return this.ensureContext();
    }

    getFloatTimeDomainData(array: Float32Array): void {
        if (this.analyser) {
            (this.analyser as any).getFloatTimeDomainData(array);
        } else {
            array.fill(0);
        }
    }

    getFullAudioBuffer(): AudioBuffer | null {
        return this.fullAudioBuffer;
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
            } catch {}
        }
        this.activeSources = [];
        this.lastScheduledBar = -1;
    }

    stop(): void {
        this.pausedTime = 0;
        this.stopSources();
        this.isPlaying = false;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'clear' });
            this.workletNode.port.postMessage({ type: 'set_playing', isPlaying: false });
        }
    }

    pause(): void {
        if (!this.isPlaying) return;
        this.pausedTime = this.getCurrentTime();
        this.stopSources();
        this.isPlaying = false;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'set_playing', isPlaying: false });
        }
    }

    play(): void {
        if (this.isPlaying) return;
        if (this.barBuffers.size === 0) return;
        this.ensureContext();
        const totalDuration = this.getTotalDuration();
        const resumeTime = this.pausedTime || 0;
        const startTime = (totalDuration > 0 && resumeTime >= totalDuration && !this.loop) ? 0 : resumeTime;
        this.isPlaying = true;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'set_playing', isPlaying: true });
        }
        this.seek(startTime);
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
        const elapsed = this.audioCtx.currentTime - this.playbackStartTime;
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
        if (buffer && this.masterGain) {
            const source = this.audioCtx.createBufferSource();
            source.buffer = buffer;
            const gain = this.audioCtx.createGain();
            source.connect(gain);
            gain.connect(this.masterGain);
            source.start(now, offsetInBar);
            const remainingDuration = buffer.duration - offsetInBar;
            const endTime = now + remainingDuration;
            this.activeSources.push({ source, gain, startTime: now, endTime, barIndex });
            this.lastScheduledBar = barIndex;
            this.nextScheduleTime = endTime;
            source.onended = () => {
                const idx = this.activeSources.findIndex(s => s.source === source);
                if (idx >= 0) this.activeSources.splice(idx, 1);
                if (!this.loop && this.activeSources.length === 0 && this.lastScheduledBar >= this.totalBars - 1) {
                    this.stop();
                }
            };
        }
        this.scheduleNextAvailableBars();
    }

    private updateFullBuffer(): void {
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
            this.updateFullBuffer();

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
        this.updateFullBuffer();

        if (this.isPlaying) {
            this.hotSwapBarBuffer(chunk.barIndex, chunk.audioBuffer);
            this.scheduleNextAvailableBars();
        }
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
            } catch {}
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
        const stepDuration = Math.max(buffer.duration, this.secondsPerBar);
        const endTime = scheduleTime + stepDuration;
        this.activeSources.push({ source, gain, startTime: scheduleTime, endTime, barIndex });

        this.lastScheduledBar = barIndex;
        this.nextScheduleTime = endTime;

        // Cleanup expired source records
        source.onended = () => {
            const idx = this.activeSources.findIndex(s => s.source === source);
            if (idx >= 0) {
                this.activeSources.splice(idx, 1);
            }
            if (!this.loop && this.activeSources.length === 0 && this.lastScheduledBar >= this.totalBars - 1) {
                this.stop();
            }
        };
    }

    /**
     * Hot-swap update: updates the buffer for a specific bar with smooth micro-crossfade
     */
    hotSwapBarBuffer(barIndex: number, newBuffer: AudioBuffer): void {
        this.barBuffers.set(barIndex, newBuffer);
        if (!this.isPlaying || !this.audioCtx || !this.masterGain) return;

        const now = this.audioCtx.currentTime;
        for (let i = 0; i < this.activeSources.length; i++) {
            const item = this.activeSources[i];
            if (item.barIndex !== barIndex) {
                continue; // Only hot-swap sources that belong to this bar
            }
            if (now >= item.startTime && now < item.endTime) {
                // Currently playing: micro-crossfade into updated buffer
                const offset = Math.max(0, now - item.startTime);
                if (offset < newBuffer.duration) {
                    try {
                        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
                        item.gain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
                        item.source.stop(now + 0.02);

                        const newSource = this.audioCtx.createBufferSource();
                        newSource.buffer = newBuffer;
                        const newGain = this.audioCtx.createGain();
                        newGain.gain.setValueAtTime(0.0001, now);
                        newGain.gain.linearRampToValueAtTime(1.0, now + 0.015);

                        newSource.connect(newGain);
                        newGain.connect(this.masterGain);

                        newSource.start(now, offset);
                        const remaining = newBuffer.duration - offset;
                        const newEndTime = now + remaining;

                        this.activeSources[i] = {
                            source: newSource,
                            gain: newGain,
                            startTime: item.startTime,
                            endTime: newEndTime,
                            barIndex: item.barIndex
                        };

                        newSource.onended = () => {
                            const idx = this.activeSources.findIndex(s => s.source === newSource);
                            if (idx >= 0) {
                                this.activeSources.splice(idx, 1);
                            }
                        };
                    } catch (e) {
                        console.warn('[GaplessAudioScheduler] Hot-swap crossfade error:', e);
                    }
                }
            } else if (item.startTime > now) {
                // Pre-scheduled future bar: replace pending source seamlessly
                try {
                    item.source.stop();
                    item.source.disconnect();
                    item.gain.disconnect();

                    const newSource = this.audioCtx.createBufferSource();
                    newSource.buffer = newBuffer;
                    const newGain = this.audioCtx.createGain();
                    newGain.gain.setValueAtTime(1.0, item.startTime);

                    newSource.connect(newGain);
                    newGain.connect(this.masterGain);

                    newSource.start(item.startTime);
                    const stepDuration = Math.max(newBuffer.duration, this.secondsPerBar);
                    const newEndTime = item.startTime + stepDuration;

                    this.activeSources[i] = {
                        source: newSource,
                        gain: newGain,
                        startTime: item.startTime,
                        endTime: newEndTime,
                        barIndex: item.barIndex
                    };

                    newSource.onended = () => {
                        const idx = this.activeSources.findIndex(s => s.source === newSource);
                        if (idx >= 0) {
                            this.activeSources.splice(idx, 1);
                        }
                    };
                } catch (e) {
                    console.warn('[GaplessAudioScheduler] Future source hot-swap error:', e);
                }
            }
        }
    }
}

export const globalAudioScheduler = new GaplessAudioScheduler();
