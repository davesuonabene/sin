import assert from 'node:assert/strict';
import test from 'node:test';

// Provide minimal Web Audio mocks for headless node test environment
class MockAudioNode {
    connect() {}
    disconnect() {}
}

class MockGainNode extends MockAudioNode {
    gain = {
        value: 1.0,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {}
    };
}

class MockAudioBufferSourceNode extends MockAudioNode {
    buffer: any = null;
    onended: (() => void) | null = null;
    start() {}
    stop() {}
}

class MockAnalyserNode extends MockAudioNode {
    fftSize = 256;
    smoothingTimeConstant = 0.5;
    getFloatTimeDomainData(arr: Float32Array) { arr.fill(0); }
}

class MockAudioContext {
    currentTime = 0;
    state = 'running';
    destination = new MockAudioNode();
    createGain() { return new MockGainNode(); }
    createAnalyser() { return new MockAnalyserNode(); }
    createBufferSource() { return new MockAudioBufferSourceNode(); }
    createBuffer(channels: number, length: number, sampleRate: number) {
        return {
            numberOfChannels: channels,
            length,
            sampleRate,
            duration: length / sampleRate,
            getChannelData: () => new Float32Array(length)
        };
    }
    resume() {}
}

if (typeof window === 'undefined') {
    (globalThis as any).window = globalThis;
    (globalThis as any).AudioContext = MockAudioContext;
}

import { GaplessAudioScheduler, type BarChunk } from '../src/audioScheduler.ts';

test('GaplessAudioScheduler manages bar chunks and buffered progress correctly', () => {
    const scheduler = new GaplessAudioScheduler();
    assert.equal(scheduler.getBufferedProgress(), 0);

    const mockBuffer = {
        numberOfChannels: 2,
        length: 44100 * 2,
        sampleRate: 44100,
        duration: 2.0,
        getChannelData: () => new Float32Array(44100 * 2)
    } as any;

    const chunk0: BarChunk = {
        barIndex: 0,
        totalBars: 4,
        bpm: 120,
        startSeconds: 0,
        durationSeconds: 2.0,
        audioBuffer: mockBuffer
    };

    scheduler.startSession(chunk0, false, 1);
    assert.equal(scheduler.getBufferedProgress(), 0.25);
    assert.equal(scheduler.getTotalDuration(), 8.0);

    const chunk1: BarChunk = {
        barIndex: 1,
        totalBars: 4,
        bpm: 120,
        startSeconds: 2.0,
        durationSeconds: 2.0,
        audioBuffer: mockBuffer
    };

    scheduler.addBarChunk(chunk1, 1);
    assert.equal(scheduler.getBufferedProgress(), 0.5);

    // Stale session chunks must be discarded
    const staleChunk: BarChunk = {
        barIndex: 2,
        totalBars: 4,
        bpm: 120,
        startSeconds: 4.0,
        durationSeconds: 2.0,
        audioBuffer: mockBuffer
    };
    scheduler.addBarChunk(staleChunk, 999);
    assert.equal(scheduler.getBufferedProgress(), 0.5);

    scheduler.stop();
    assert.equal(scheduler.getIsPlaying(), false);
});

test('GaplessAudioScheduler hotSwapBarBuffer isolates updates to matching barIndex', () => {
    const scheduler = new GaplessAudioScheduler();
    const bufA = { numberOfChannels: 2, length: 88200, sampleRate: 44100, duration: 2.0, getChannelData: () => new Float32Array(88200) } as any;
    const bufB = { numberOfChannels: 2, length: 88200, sampleRate: 44100, duration: 2.0, getChannelData: () => new Float32Array(88200) } as any;

    scheduler.startSession({
        barIndex: 0,
        totalBars: 2,
        bpm: 120,
        startSeconds: 0,
        durationSeconds: 2.0,
        audioBuffer: bufA
    }, false, 1);

    scheduler.addBarChunk({
        barIndex: 1,
        totalBars: 2,
        bpm: 120,
        startSeconds: 2.0,
        durationSeconds: 2.0,
        audioBuffer: bufA
    }, 1);

    // Hot-swap bar 1 only
    scheduler.hotSwapBarBuffer(1, bufB);
    assert.equal(scheduler.getBufferedProgress(), 1.0);
});
