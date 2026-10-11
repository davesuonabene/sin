import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPeaksFromRawChannel } from '../src/utils/peakExtractor.ts';
import { TransportClock } from '../src/telemetry/TransportClock.ts';

test('extractPeaksFromRawChannel produces correct min/max bounds', () => {
    const raw = new Float32Array([0.1, -0.5, 0.8, -0.2, 0.4, -0.9]);
    const peaks = extractPeaksFromRawChannel(raw, 2);

    assert.equal(peaks.length, 4);
    // First column: samples [0.1, -0.5, 0.8] -> min: -0.5, max: 0.8
    assert.ok(Math.abs(peaks[0] - (-0.5)) < 1e-4);
    assert.ok(Math.abs(peaks[1] - 0.8) < 1e-4);
    // Second column: samples [-0.2, 0.4, -0.9] -> min: -0.9, max: 0.4
    assert.ok(Math.abs(peaks[2] - (-0.9)) < 1e-4);
    assert.ok(Math.abs(peaks[3] - 0.4) < 1e-4);
});

test('TransportClock calculates musical positions accurately', () => {
    const clock = new TransportClock();
    clock.setBpm(120); // 1 beat = 0.5 sec, 1 bar = 2.0 sec, 1 16th = 0.125 sec

    clock.update(1.25, 10.0, true);
    const telemetry = clock.getTelemetry();

    assert.equal(telemetry.isPlaying, true);
    assert.equal(telemetry.time, 1.25);
    assert.equal(telemetry.duration, 10.0);
    // beat = 1.25 / 0.5 = 2.5
    assert.ok(Math.abs(telemetry.beat - 2.5) < 1e-4);
    // bar = 2.5 / 4 = 0.625
    assert.ok(Math.abs(telemetry.bar - 0.625) < 1e-4);
    // step = floor(2.5 * 4) % 16 = floor(10) % 16 = 10
    assert.equal(telemetry.step, 10);
});

test('SequenceRenderer renders without throwing and tracks active pads', async () => {
    const { SequenceRenderer } = await import('../src/renderers/SequenceRenderer.ts');
    const renderer = new SequenceRenderer();
    renderer.setSignal({
        stepCount: 16,
        steps: [
            { gate: true, velocity: 1 },
            { gate: false, velocity: 0.5 },
            { gate: true, velocity: 0.8 }
        ],
        stepLength: 0.25,
        accentColor: '#ec4899'
    });

    const calls: string[] = [];
    const mockCtx = {
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        clip: () => calls.push('clip'),
        fillRect: () => calls.push('fillRect'),
        fill: () => calls.push('fill'),
        stroke: () => calls.push('stroke'),
        beginPath: () => calls.push('beginPath'),
        closePath: () => calls.push('closePath'),
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        fillText: () => {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1
    } as any;

    renderer.render(mockCtx, { x: 0, y: 0, width: 200, height: 50 }, {
        time: 0,
        duration: 4,
        beat: 0,
        bar: 0,
        step: 0,
        isPlaying: true
    });

    assert.ok(calls.includes('save'));
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('fill'));
    assert.ok(calls.includes('stroke'));
    assert.ok(calls.includes('beginPath'));
});

test('WaveformRenderer renders live scope sweep when isMasterScope is true and playing', async () => {
    const { WaveformRenderer } = await import('../src/renderers/WaveformRenderer.ts');
    const renderer = new WaveformRenderer({ isMasterScope: true, scopeWindow: 2.0, scopeGain: 2.0 });

    const calls: string[] = [];
    const mockCtx = {
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        clip: () => calls.push('clip'),
        fillRect: () => calls.push('fillRect'),
        fill: () => calls.push('fill'),
        stroke: () => calls.push('stroke'),
        beginPath: () => calls.push('beginPath'),
        closePath: () => calls.push('closePath'),
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => calls.push('arc'),
        fillText: (_text: string) => calls.push(`fillText:${_text}`),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1
    } as any;

    const fakeScope = new Float32Array(128).fill(0.2);
    renderer.render(mockCtx, { x: 0, y: 0, width: 200, height: 50 }, {
        time: 1.0,
        duration: 4.0,
        beat: 2.0,
        bar: 0.5,
        step: 8,
        isPlaying: true,
        realtimeScope: fakeScope
    });

    assert.ok(calls.includes('save'));
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('stroke'));
    assert.ok(calls.some(c => c.startsWith('fillText:SCOPE · 2.00s')));
});

test('WaveformRenderer renders DRAWN and SCROLLED scopes from AudioBuffer', async () => {
    const { WaveformRenderer } = await import('../src/renderers/WaveformRenderer.ts');
    
    // Mock AudioBuffer with a simple sine waveform
    const sampleRate = 44100;
    const duration = 2.0;
    const channelData = new Float32Array(sampleRate * 2);
    for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 0.8;
    }
    const mockAudioBuffer = {
        sampleRate,
        length: channelData.length,
        duration,
        numberOfChannels: 1,
        getChannelData: (_ch: number) => channelData
    } as any;

    const drawnRenderer = new WaveformRenderer({ scopeMode: 'drawn', scopeWindow: 1.0 });
    drawnRenderer.setSignal({ buffer: mockAudioBuffer, duration });

    const calls: string[] = [];
    const mockCtx = {
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        clip: () => calls.push('clip'),
        fillRect: () => calls.push('fillRect'),
        fill: () => calls.push('fill'),
        stroke: () => calls.push('stroke'),
        beginPath: () => calls.push('beginPath'),
        closePath: () => calls.push('closePath'),
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => calls.push('arc'),
        fillText: (_text: string) => calls.push(`fillText:${_text}`),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1
    } as any;

    drawnRenderer.render(mockCtx, { x: 0, y: 0, width: 200, height: 50 }, {
        time: 0.5,
        duration: 2.0,
        beat: 1.0,
        bar: 0.25,
        step: 4,
        isPlaying: true
    });

    assert.ok(calls.includes('save'));
    assert.ok(calls.includes('fillRect'));
    assert.ok(calls.some(c => c.startsWith('fillText:SCOPE · 1.00s')));

    // Now test scrolled mode
    calls.length = 0;
    const scrolledRenderer = new WaveformRenderer({ scopeMode: 'scrolled', scopeWindow: 1.0 });
    scrolledRenderer.setSignal({ buffer: mockAudioBuffer, duration });

    scrolledRenderer.render(mockCtx, { x: 0, y: 0, width: 200, height: 50 }, {
        time: 0.5,
        duration: 2.0,
        beat: 1.0,
        bar: 0.25,
        step: 4,
        isPlaying: true
    });

    assert.ok(calls.includes('save'));
    assert.ok(calls.includes('fillRect'));
    assert.ok(calls.some(c => c.startsWith('fillText:SCROLL · 1.00s')));
});

