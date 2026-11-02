import { getSharedAudioContext } from './audioBufferCache.ts';
import { hashSeed, mulberry32, wrapSlotIndex } from '../../ermes/ts/slotLanguage.ts';

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

export interface SequenceCompositorOptions {
    stepSlots?: number[];
    cycleSeeds?: number[];
    playMode?: string;
    release?: number;
    fadeMs?: number;
    seed?: number;
}

export interface ArrangementCompositorOptions {
    sectionSlots?: number[];
    sectionProbability?: number[];
    sectionSampleStart?: number[];
    sectionQuant?: string[];
    sectionQuantAnchor?: string[];
    seed?: number;
}

export function compositeSequenceBuffer(
    sampleBufferOrSlots: AudioBuffer | Map<number, AudioBuffer>,
    sequence: any[],
    stepParameters: any[] | undefined,
    stepLengthBeats: number,
    totalBars: number,
    bpm: number,
    gain: number = 1.0,
    options?: SequenceCompositorOptions
): AudioBuffer | null {
    const slotMap: Map<number, AudioBuffer> = sampleBufferOrSlots instanceof Map
        ? sampleBufferOrSlots
        : new Map([[0, sampleBufferOrSlots]]);
    const primaryBuffer = slotMap.get(0) || Array.from(slotMap.values())[0];
    if (!primaryBuffer || primaryBuffer.length === 0) return null;

    const slotCount = Math.max(1, slotMap.size);
    const resolvedBars = Number.isFinite(totalBars) && totalBars > 0 ? totalBars : 4;
    const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const resolvedStepBeats = Number.isFinite(stepLengthBeats) && stepLengthBeats > 0 ? stepLengthBeats : 0.25;

    const ctx = getSharedAudioContext();
    if (!ctx) return null;

    const sr = primaryBuffer.sampleRate;
    const secondsPerBeat = 60 / resolvedBpm;
    const secondsPerBar = 4 * secondsPerBeat;
    const totalBeats = resolvedBars * 4;
    const totalDuration = resolvedBars * secondsPerBar;
    const totalSamples = Math.ceil(totalDuration * sr);
    if (totalSamples <= 0) return null;

    const numChannels = Math.min(2, Math.max(1, primaryBuffer.numberOfChannels));
    const output = ctx.createBuffer(numChannels, totalSamples, sr);

    const stepCount = sequence.length > 0 ? sequence.length : 16;
    const patternBeats = stepCount * resolvedStepBeats;
    const repetitions = Math.max(1, Math.ceil(totalBeats / Math.max(0.01, patternBeats)));

    const stepSlots = options?.stepSlots;
    const cycleSeeds = options?.cycleSeeds && options.cycleSeeds.length > 0
        ? options.cycleSeeds
        : [options?.seed ?? 42];
    const isMono = (options?.playMode || 'gate') === 'gate';
    const releasePct = Math.max(0, Math.min(1, Number(options?.release ?? 0)));
    const fadeSamples = Math.max(0, Math.floor((Number(options?.fadeMs ?? 0) / 1000) * sr));

    interface ScheduledHit {
        startSample: number;
        sampleBuffer: AudioBuffer;
        srcBase: number;
        availSample: number;
        gateSamples: number;
        effGain: number;
    }

    const hits: ScheduledHit[] = [];

    for (let rep = 0; rep < repetitions; rep++) {
        const repOffsetBeats = rep * patternBeats;
        if (repOffsetBeats >= totalBeats) break;
        const cycleSeed = cycleSeeds[rep % cycleSeeds.length] ?? 42;

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
            const rawProb = typeof param.probability === 'number' ? param.probability : 1.0;
            const prob = rawProb > 1.0 ? rawProb / 100 : Math.max(0, Math.min(1, rawProb));
            if (prob <= 0) continue;
            if (prob < 1.0) {
                const prng = mulberry32(hashSeed(cycleSeed, rep, step, 0x5E9));
                if (prng() > prob) continue;
            }

            const vel = typeof param.velocity === 'number' ? param.velocity : 1.0;
            if (vel <= 0) continue;

            const requestedSlot = stepSlots ? (stepSlots[step % stepSlots.length] ?? 0) : 0;
            const slotIdx = wrapSlotIndex(requestedSlot, slotCount);
            const stepBuffer = slotMap.get(slotIdx) || primaryBuffer;

            const rawSampleStart = typeof param.sample_start === 'number' ? param.sample_start : 0;
            const sampleStartNorm = Math.max(0, Math.min(1, rawSampleStart > 1 ? rawSampleStart / 100 : rawSampleStart));
            const sampleStartOffset = Math.floor(sampleStartNorm * stepBuffer.length);
            const remainingSample = stepBuffer.length - sampleStartOffset;
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
                const gateSamples = (gateLength >= 1.0 && subdivs === 1 && releasePct === 0)
                    ? availSample
                    : Math.max(0, Math.floor(subDurationSec * gateLength * sr) - trimLeadingSamples);

                hits.push({
                    startSample,
                    sampleBuffer: stepBuffer,
                    srcBase: sampleStartOffset + trimLeadingSamples,
                    availSample,
                    gateSamples: gateSamples > 0 ? Math.min(availSample, gateSamples) : availSample,
                    effGain: vel * gain
                });
            }
        }
    }

    for (let hIdx = 0; hIdx < hits.length; hIdx++) {
        const hit = hits[hIdx];
        const nextHitStart = (isMono && hIdx + 1 < hits.length)
            ? hits[hIdx + 1].startSample
            : totalSamples;

        const tailAvail = Math.max(0, hit.availSample - hit.gateSamples);
        const relSamples = releasePct > 0 ? Math.floor(tailAvail * releasePct) : 0;
        let playSamples = Math.min(hit.availSample, hit.gateSamples + relSamples);
        if (isMono) {
            playSamples = Math.min(playSamples, Math.max(0, nextHitStart - hit.startSample));
        }
        const copySamples = Math.min(playSamples, totalSamples - hit.startSample);
        if (copySamples <= 0) continue;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = hit.sampleBuffer.numberOfChannels > ch
                ? hit.sampleBuffer.getChannelData(ch)
                : hit.sampleBuffer.getChannelData(0);
            const dst = output.getChannelData(ch);
            for (let s = 0; s < copySamples; s++) {
                let env = hit.effGain;
                if (relSamples > 0 && s >= hit.gateSamples) {
                    const relPos = (s - hit.gateSamples) / relSamples;
                    env *= Math.max(0, 1 - relPos);
                }
                if (fadeSamples > 0) {
                    if (s < fadeSamples) {
                        env *= s / fadeSamples;
                    } else if (copySamples - 1 - s < fadeSamples) {
                        env *= (copySamples - 1 - s) / fadeSamples;
                    }
                }
                dst[hit.startSample + s] += src[hit.srcBase + s] * env;
            }
        }
    }

    return output;
}

export function compositeArrangementBuffer(
    inputBufferOrSlots: AudioBuffer | Map<number, AudioBuffer>,
    sectionPoints: number[],
    sectionEnabled: boolean[] | undefined,
    totalBars: number,
    bpm: number,
    options?: ArrangementCompositorOptions
): AudioBuffer | null {
    const slotMap: Map<number, AudioBuffer> = inputBufferOrSlots instanceof Map
        ? inputBufferOrSlots
        : new Map([[0, inputBufferOrSlots]]);
    const primaryBuffer = slotMap.get(0) || Array.from(slotMap.values())[0];
    if (!primaryBuffer || primaryBuffer.length === 0) return null;

    const slotCount = Math.max(1, slotMap.size);
    const resolvedBars = Number.isFinite(totalBars) && totalBars > 0 ? totalBars : 4;
    const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;

    const ctx = getSharedAudioContext();
    if (!ctx) return null;

    const sr = primaryBuffer.sampleRate;
    const secondsPerBar = 4 * (60 / resolvedBpm);
    const totalDuration = resolvedBars * secondsPerBar;
    const totalSamples = Math.ceil(totalDuration * sr);
    if (totalSamples <= 0) return null;

    const numChannels = primaryBuffer.numberOfChannels;
    const output = ctx.createBuffer(numChannels, totalSamples, sr);

    const sectionSlots = options?.sectionSlots;
    const sectionProbability = options?.sectionProbability;
    const sectionSampleStart = options?.sectionSampleStart;
    const baseSeed = options?.seed ?? 42;

    // Place section blocks according to points (even when sectionPoints is empty, there is 1 section [0..resolvedBars])
    const points = [0, ...(sectionPoints || []).filter(p => Number.isFinite(p) && p > 0 && p < resolvedBars), resolvedBars];
    for (let i = 0; i < points.length - 1; i++) {
        const isEnabled = sectionEnabled ? Boolean(sectionEnabled[i] ?? true) : true;
        if (!isEnabled) continue;

        const prob = sectionProbability ? Number(sectionProbability[i] ?? 1.0) : 1.0;
        if (prob <= 0) continue;
        if (prob < 1.0) {
            const prng = mulberry32(hashSeed(baseSeed, i, 0xA22));
            if (prng() > prob) continue;
        }

        const startBar = points[i];
        const endBar = points[i + 1];
        const startSample = Math.floor(startBar * secondsPerBar * sr);
        const endSample = Math.min(totalSamples, Math.floor(endBar * secondsPerBar * sr));
        const sectionSamples = endSample - startSample;
        if (sectionSamples <= 0) continue;

        const requestedSlot = sectionSlots ? (sectionSlots[i] ?? 0) : 0;
        const slotIdx = wrapSlotIndex(requestedSlot, slotCount);
        const secBuffer = slotMap.get(slotIdx) || primaryBuffer;
        const inputLen = secBuffer.length;
        if (inputLen <= 0) continue;

        const rawQuant = options?.sectionQuant?.[i];
        const quantStr = String(rawQuant || 'auto').trim().toLowerCase();
        const isContinuous = quantStr === 'auto' || quantStr === 'continuous';
        const anchor = (options?.sectionQuantAnchor?.[i] === 'end') ? 'end' : 'start';

        const rawSampleStart = sectionSampleStart ? Number(sectionSampleStart[i] ?? 0) : 0;
        const sampleStartOffset = Math.floor(Math.max(0, Math.min(1, rawSampleStart)) * inputLen);

        if (isContinuous) {
            // Continuous: the incoming audio loops onto itself regardless of start point
            for (let ch = 0; ch < numChannels; ch++) {
                const src = secBuffer.numberOfChannels > ch ? secBuffer.getChannelData(ch) : secBuffer.getChannelData(0);
                const dst = output.getChannelData(ch);
                for (let s = 0; s < sectionSamples; s++) {
                    dst[startSample + s] += src[(sampleStartOffset + s) % inputLen];
                }
            }
        } else {
            // Non-continuous quant: playback starts at start offset and stops when reaching the end of the sample
            let quantSamples: number | null = null;
            if (quantStr === 'bar') {
                quantSamples = Math.floor(secondsPerBar * sr);
            } else if (quantStr === '0.5') {
                quantSamples = Math.floor(0.5 * secondsPerBar * sr);
            } else if (quantStr === 'beat') {
                quantSamples = Math.floor(0.25 * secondsPerBar * sr);
            } else if (quantStr === 'none' || quantStr === 'once' || quantStr === 'off') {
                quantSamples = null;
            } else {
                const qNum = parseFloat(quantStr);
                if (Number.isFinite(qNum) && qNum > 0) {
                    quantSamples = Math.floor(qNum * secondsPerBar * sr);
                } else {
                    quantSamples = null;
                }
            }

            let cellStart = startSample;
            let subIteration = 0;
            while (cellStart < endSample) {
                const cellEnd = quantSamples !== null ? Math.min(endSample, cellStart + quantSamples) : endSample;
                const cellLen = cellEnd - cellStart;
                if (cellLen <= 0) break;

                let playCell = true;
                if (prob < 1.0) {
                    const prng = mulberry32(hashSeed(baseSeed, i, 0xA22, subIteration));
                    playCell = prng() <= prob;
                }
                subIteration++;

                if (playCell) {
                    const remainingSample = Math.max(0, inputLen - sampleStartOffset);
                    if (remainingSample > 0) {
                        const eventStart = anchor === 'start' ? cellStart : cellEnd - remainingSample;
                        const eventEnd = eventStart + remainingSample;
                        const writeStart = Math.max(startSample, cellStart, eventStart);
                        const writeEnd = Math.min(endSample, cellEnd, eventEnd);

                        if (writeStart < writeEnd) {
                            const srcBase = sampleStartOffset + (writeStart - eventStart);
                            const copyLen = writeEnd - writeStart;
                            for (let ch = 0; ch < numChannels; ch++) {
                                const src = secBuffer.numberOfChannels > ch ? secBuffer.getChannelData(ch) : secBuffer.getChannelData(0);
                                const dst = output.getChannelData(ch);
                                for (let s = 0; s < copyLen; s++) {
                                    dst[writeStart + s] += src[srcBase + s];
                                }
                            }
                        }
                    }
                }

                if (quantSamples === null || quantSamples <= 0) break;
                cellStart += quantSamples;
            }
        }
    }

    return output;
}

