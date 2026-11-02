import { getSharedAudioContext } from './audioBufferCache.ts';

/**
 * Client-Side Signal Flow Audio Compositor
 * 
 * Provides real-time, zero-latency buffer synthesis and mixing directly
 * along graph signal flow (Sample -> Sequence -> Bus -> Master).
 * Ensures waveforms and previews are instantly available without waiting
 * for backend offline/progressive render passes.
 */

export function getNodeGainMultiplier(node: any): number {
    if (!node || !node.properties) return 1.0;
    let multiplier = 1.0;

    const chain = Array.isArray(node.properties.chain) ? node.properties.chain : [];

    // Direct property gain (dB) only when chain is empty (prevent double-application when normalized into chain)
    if (chain.length === 0 && typeof node.properties.gain === 'number') {
        const db = node.properties.gain;
        if (db <= -35.9) return 0;
        multiplier *= Math.pow(10, db / 20);
    }

    // FX Chain modules (Pre Gain, Post Gain)
    for (const mod of chain) {
        if (!mod || mod.enabled === false) continue;
        const modType = String(mod.type || '').toLowerCase();
        if (modType === 'gain' && mod.params) {
            if (typeof mod.params.gain === 'number') {
                multiplier *= mod.params.gain;
            } else if (typeof mod.params.gain_db === 'number') {
                const db = mod.params.gain_db;
                if (db <= -35.9) return 0;
                multiplier *= Math.pow(10, db / 20);
            }
        }
    }

    return multiplier;
}

export function applyGainToBuffer(buffer: AudioBuffer, gain: number): AudioBuffer {
    if (!buffer || gain === 1.0) return buffer;
    const ctx = getSharedAudioContext();
    if (!ctx) return buffer;

    const numChannels = buffer.numberOfChannels;
    const output = ctx.createBuffer(numChannels, buffer.length, buffer.sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
        const src = buffer.getChannelData(ch);
        const dst = output.getChannelData(ch);
        for (let i = 0; i < buffer.length; i++) {
            dst[i] = src[i] * gain;
        }
    }
    return output;
}

export function mixAudioBuffers(buffers: (AudioBuffer | null | undefined)[], gains?: number[]): AudioBuffer | null {
    const valid = buffers.filter((b): b is AudioBuffer => Boolean(b && b.length > 0));
    if (valid.length === 0) return null;
    if (valid.length === 1 && (!gains || gains[0] === 1.0)) return valid[0];

    const ctx = getSharedAudioContext();
    if (!ctx) return valid[0];

    let maxChannels = 1;
    let maxLength = 0;
    const sampleRate = valid[0].sampleRate;

    for (const buf of valid) {
        if (buf.numberOfChannels > maxChannels) maxChannels = buf.numberOfChannels;
        if (buf.length > maxLength) maxLength = buf.length;
    }
    if (maxLength === 0) return null;

    const output = ctx.createBuffer(maxChannels, maxLength, sampleRate);

    for (let bIdx = 0; bIdx < valid.length; bIdx++) {
        const buf = valid[bIdx];
        const g = gains && Number.isFinite(gains[bIdx]) ? gains[bIdx] : 1.0;
        if (g === 0) continue;

        for (let ch = 0; ch < maxChannels; ch++) {
            const src = buf.numberOfChannels > ch ? buf.getChannelData(ch) : buf.getChannelData(0);
            const dst = output.getChannelData(ch);
            const len = Math.min(buf.length, maxLength);
            for (let i = 0; i < len; i++) {
                dst[i] += src[i] * g;
            }
        }
    }
    return output;
}

export function compositeSequenceBuffer(
    sampleBuffer: AudioBuffer,
    sequence: any[],
    stepParameters: any[] | undefined,
    stepLengthBeats: number,
    totalBars: number,
    bpm: number,
    gain: number = 1.0
): AudioBuffer | null {
    if (!sampleBuffer || sampleBuffer.length === 0) return null;
    const resolvedBars = Number.isFinite(totalBars) && totalBars > 0 ? totalBars : 4;
    const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const resolvedStepBeats = Number.isFinite(stepLengthBeats) && stepLengthBeats > 0 ? stepLengthBeats : 0.25;

    const ctx = getSharedAudioContext();
    if (!ctx) return null;

    const sr = sampleBuffer.sampleRate;
    const secondsPerBeat = 60 / resolvedBpm;
    const secondsPerBar = 4 * secondsPerBeat;
    const totalBeats = resolvedBars * 4;
    const totalDuration = resolvedBars * secondsPerBar;
    const totalSamples = Math.ceil(totalDuration * sr);
    if (totalSamples <= 0) return null;

    const numChannels = Math.min(2, Math.max(1, sampleBuffer.numberOfChannels));
    const output = ctx.createBuffer(numChannels, totalSamples, sr);

    const stepCount = sequence.length > 0 ? sequence.length : 16;
    const patternBeats = stepCount * resolvedStepBeats;
    const repetitions = Math.max(1, Math.ceil(totalBeats / Math.max(0.01, patternBeats)));

    for (let rep = 0; rep < repetitions; rep++) {
        const repOffsetBeats = rep * patternBeats;
        if (repOffsetBeats >= totalBeats) break;

        for (let step = 0; step < stepCount; step++) {
            const stepStartBeats = repOffsetBeats + (step * resolvedStepBeats);
            if (stepStartBeats >= totalBeats) break;

            const rawVal = sequence[step];
            const isGateOn = typeof rawVal === 'number'
                ? rawVal > 0
                : typeof rawVal === 'string'
                    ? (rawVal === '1' || rawVal === 'true')
                    : typeof rawVal === 'object' && rawVal !== null
                        ? Boolean((rawVal as any).gate ?? (rawVal as any).on)
                        : Boolean(rawVal);

            if (!isGateOn) continue;

            const param = stepParameters?.[step] || {};
            const vel = typeof param.velocity === 'number' ? param.velocity : 1.0;
            if (vel <= 0) continue;

            const rawSampleStart = typeof param.sample_start === 'number' ? param.sample_start : 0;
            const sampleStartNorm = Math.max(0, Math.min(1, rawSampleStart > 1 ? rawSampleStart / 100 : rawSampleStart));
            const sampleStartOffset = Math.floor(sampleStartNorm * sampleBuffer.length);
            const remainingSample = sampleBuffer.length - sampleStartOffset;
            if (remainingSample <= 0) continue;

            const stepDurationSec = resolvedStepBeats * secondsPerBeat;
            const offsetSec = (Number(param.offset) || 0) * stepDurationSec;
            const baseStartTimeSec = (stepStartBeats * secondsPerBeat) + offsetSec;
            if (baseStartTimeSec >= totalDuration) continue;

            const subdivs = (param.subdivision_enabled !== false && typeof param.subdivisions === 'number' && param.subdivisions > 1)
                ? Math.min(16, Math.max(1, Math.floor(param.subdivisions)))
                : 1;
            const subDurationSec = stepDurationSec / subdivs;

            const rawGate = typeof param.gate_length === 'number' ? param.gate_length : 1.0;
            const gateLength = rawGate > 1.0 ? rawGate / 100 : Math.max(0.01, Math.min(1.0, rawGate));

            for (let sub = 0; sub < subdivs; sub++) {
                const subStartSec = baseStartTimeSec + (sub * subDurationSec);
                if (subStartSec >= totalDuration) break;

                let trimLeadingSamples = 0;
                let startSample = Math.floor(subStartSec * sr);
                if (startSample < 0) {
                    trimLeadingSamples = -startSample;
                    startSample = 0;
                }
                if (startSample >= totalSamples || trimLeadingSamples >= remainingSample) continue;

                const availSample = remainingSample - trimLeadingSamples;
                const maxPlaySamples = (gateLength >= 1.0 && subdivs === 1)
                    ? availSample
                    : Math.max(0, Math.floor(subDurationSec * gateLength * sr) - trimLeadingSamples);
                const playSamples = Math.min(availSample, maxPlaySamples > 0 ? maxPlaySamples : availSample);
                const copySamples = Math.min(playSamples, totalSamples - startSample);
                if (copySamples <= 0) continue;

                const effGain = vel * gain;
                const srcBase = sampleStartOffset + trimLeadingSamples;
                for (let ch = 0; ch < numChannels; ch++) {
                    const src = sampleBuffer.numberOfChannels > ch ? sampleBuffer.getChannelData(ch) : sampleBuffer.getChannelData(0);
                    const dst = output.getChannelData(ch);
                    for (let s = 0; s < copySamples; s++) {
                        dst[startSample + s] += src[srcBase + s] * effGain;
                    }
                }
            }
        }
    }

    return output;
}

export function compositeArrangementBuffer(
    inputBuffer: AudioBuffer,
    sectionPoints: number[],
    sectionEnabled: boolean[] | undefined,
    totalBars: number,
    bpm: number
): AudioBuffer | null {
    if (!inputBuffer || inputBuffer.length === 0) return null;
    const resolvedBars = Number.isFinite(totalBars) && totalBars > 0 ? totalBars : 4;
    const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;

    const ctx = getSharedAudioContext();
    if (!ctx) return null;

    const sr = inputBuffer.sampleRate;
    const secondsPerBar = 4 * (60 / resolvedBpm);
    const totalDuration = resolvedBars * secondsPerBar;
    const totalSamples = Math.ceil(totalDuration * sr);
    if (totalSamples <= 0) return null;

    const numChannels = inputBuffer.numberOfChannels;
    const output = ctx.createBuffer(numChannels, totalSamples, sr);

    // If no sections defined, repeat or tile input buffer to fill total bars
    if (!sectionPoints || sectionPoints.length === 0) {
        const inputLen = inputBuffer.length;
        for (let ch = 0; ch < numChannels; ch++) {
            const src = inputBuffer.getChannelData(ch);
            const dst = output.getChannelData(ch);
            for (let i = 0; i < totalSamples; i++) {
                dst[i] = src[i % inputLen];
            }
        }
        return output;
    }

    // Place section blocks according to points
    const points = [0, ...sectionPoints.filter(p => Number.isFinite(p) && p > 0 && p < resolvedBars), resolvedBars];
    for (let i = 0; i < points.length - 1; i++) {
        const isEnabled = sectionEnabled ? Boolean(sectionEnabled[i] ?? true) : true;
        if (!isEnabled) continue;

        const startBar = points[i];
        const endBar = points[i + 1];
        const startSample = Math.floor(startBar * secondsPerBar * sr);
        const endSample = Math.min(totalSamples, Math.floor(endBar * secondsPerBar * sr));
        const sectionSamples = endSample - startSample;
        if (sectionSamples <= 0) continue;

        const inputLen = inputBuffer.length;
        for (let ch = 0; ch < numChannels; ch++) {
            const src = inputBuffer.getChannelData(ch);
            const dst = output.getChannelData(ch);
            for (let s = 0; s < sectionSamples; s++) {
                dst[startSample + s] += src[s % inputLen];
            }
        }
    }

    return output;
}

