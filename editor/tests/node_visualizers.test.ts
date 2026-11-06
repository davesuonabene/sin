import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import {
    extractRealtimeSliceFromSignal,
    sampleSignalAmplitude,
    computeLogSpectrum,
    FFT_SIZE,
    type SignalTelemetry
} from '../../packages/iride/src/index.ts';

function createFakeAudioBuffer(durationSec: number, sampleRate = 44100, freqHz = 220): AudioBuffer {
    const length = Math.max(1, Math.floor(durationSec * sampleRate));
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        data[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.8;
    }
    return {
        length,
        duration: length / sampleRate,
        sampleRate,
        numberOfChannels: 1,
        getChannelData: () => data,
        copyFromChannel: () => {},
        copyToChannel: () => {}
    } as unknown as AudioBuffer;
}

test('Node subclasses declare expected supported visualization types and defaults', () => {
    const track = new TrackNode();
    const seq = new SequenceNode();
    const arr = new ArrangementNode();
    const sample = new SampleNode();

    assert.equal(track.getVisualizationType(), 'loop');
    assert.deepEqual(
        track.getSupportedVisualizationOptions().map(o => o.id),
        ['loop', 'realtime', 'spectrum']
    );

    assert.equal(seq.getVisualizationType(), 'sequence');
    assert.deepEqual(
        seq.getSupportedVisualizationOptions().map(o => o.id),
        ['sequence', 'loop', 'realtime', 'spectrum']
    );

    assert.equal(arr.getVisualizationType(), 'arrangement');
    assert.deepEqual(
        arr.getSupportedVisualizationOptions().map(o => o.id),
        ['arrangement', 'loop', 'realtime', 'spectrum']
    );

    assert.equal(sample.getVisualizationType(), 'sample');
    assert.deepEqual(
        sample.getSupportedVisualizationOptions().map(o => o.id),
        ['sample', 'realtime', 'spectrum']
    );
});

test('setVisualizationType updates property, validates against supported types, and auto-enables viewer cook', () => {
    const seq = new SequenceNode();
    seq.updateProperty('visualization_enabled', false);
    assert.equal(seq.isViewerCookEnabled, false);

    seq.setVisualizationType('loop');
    assert.equal(seq.getVisualizationType(), 'loop');
    assert.equal(seq.properties.visualization_type, 'loop');
    assert.equal(seq.isViewerCookEnabled, true);

    seq.setVisualizationType('spectrum');
    assert.equal(seq.getVisualizationType(), 'spectrum');

    // Unsupported type on SequenceNode ('sample' is SampleNode-only) falls back to default ('sequence')
    seq.setVisualizationType('sample');
    assert.equal(seq.getVisualizationType(), 'sequence');

    // Legacy TrackNode scope_mode='drawn' migrates to 'realtime' when visualization_type is unset
    const track = new TrackNode();
    delete track.properties.visualization_type;
    track.properties.scope_mode = 'drawn';
    assert.equal(track.getVisualizationType(), 'realtime');
});

test('General nodes share resolveVisualizationSignal with playhead needle and no crop, while SampleNode includes crop', () => {
    const seq = new SequenceNode();
    const fakeLoop = createFakeAudioBuffer(2.0);
    (seq as any).manifestStemBuffer = fakeLoop;

    const telemetry: SignalTelemetry = {
        time: 0.5,
        duration: 2.0,
        beat: 1,
        bar: 0.25,
        step: 4,
        isPlaying: true
    };

    const seqSignal = seq.resolveVisualizationSignal(telemetry);
    assert.equal(seqSignal.buffer, fakeLoop);
    assert.equal(seqSignal.cropStart, undefined);
    assert.equal(seqSignal.cropEnd, undefined);
    assert.ok(Math.abs((seqSignal.playbackProgress ?? 0) - 0.25) < 1e-6);

    const sample = new SampleNode();
    sample.audioBuffer = fakeLoop;
    sample.updateProperty('crop_start', 0.2);
    sample.updateProperty('crop_end', 0.7);

    const sampleSignal = sample.resolveVisualizationSignal(telemetry);
    assert.equal(sampleSignal.buffer, fakeLoop);
    assert.equal(sampleSignal.cropStart, 0.2);
    assert.equal(sampleSignal.cropEnd, 0.7);
    assert.equal(sampleSignal.isTriggered, true);
    assert.ok((sampleSignal.playbackProgress ?? 0) >= 0.2 && (sampleSignal.playbackProgress ?? 0) <= 0.7);
});

test('extractRealtimeSliceFromSignal and computeLogSpectrum isolate per-node audio and silence untriggered nodes', () => {
    const buf = createFakeAudioBuffer(1.0, 44100, 440);
    const slice = new Float32Array(FFT_SIZE);
    const bands = new Float32Array(28);

    const activeTelemetry: SignalTelemetry = {
        time: 0.25,
        duration: 1.0,
        beat: 0.5,
        bar: 0.125,
        step: 2,
        isPlaying: true
    };

    // Active node extracts real non-zero samples and produces non-zero spectral energy
    const hasSignal = extractRealtimeSliceFromSignal(
        { buffer: buf, duration: 1.0, playbackProgress: 0.25, isTriggered: true },
        activeTelemetry,
        slice,
        1.0
    );
    assert.equal(hasSignal, true);
    assert.ok(slice.some(v => Math.abs(v) > 0.1));

    computeLogSpectrum(slice, bands, 44100);
    const maxBand = Math.max(...bands);
    assert.ok(maxBand > 0.3, `Expected active 440Hz tone to produce spectrum energy, got max=${maxBand}`);

    // Untriggered node outputs silence even while transport is playing
    const hasUntriggered = extractRealtimeSliceFromSignal(
        { buffer: buf, duration: 1.0, playbackProgress: 0.25, isTriggered: false },
        activeTelemetry,
        slice,
        1.0
    );
    assert.equal(hasUntriggered, false);
    assert.ok(slice.every(v => v === 0));

    computeLogSpectrum(slice, bands, 44100);
    assert.ok(bands.every(b => b === 0));

    // Verify sampleSignalAmplitude extracts accurate peak & RMS for horizontal amplitude scope
    const amp = sampleSignalAmplitude(
        { buffer: buf, duration: 1.0, playbackProgress: 0.5, isTriggered: true },
        activeTelemetry,
        0.02,
        1.0
    );
    assert.equal(amp.active, true);
    assert.ok(amp.max > 0.7 && amp.min < -0.7);
    assert.ok(amp.rms > 0.4 && amp.rms < 0.7);

    // Verify 1024-pt FFT separates low bass (100 Hz) from high treble (4000 Hz)
    const bassBuf = createFakeAudioBuffer(1.0, 44100, 100);
    const trebleBuf = createFakeAudioBuffer(1.0, 44100, 4000);
    const bassBands = new Float32Array(96);
    const trebleBands = new Float32Array(96);

    extractRealtimeSliceFromSignal({ buffer: bassBuf, duration: 1.0, playbackProgress: 0.5 }, activeTelemetry, slice);
    computeLogSpectrum(slice, bassBands, 44100);
    const bassPeakIdx = bassBands.indexOf(Math.max(...bassBands));

    extractRealtimeSliceFromSignal({ buffer: trebleBuf, duration: 1.0, playbackProgress: 0.5 }, activeTelemetry, slice);
    computeLogSpectrum(slice, trebleBands, 44100);
    const treblePeakIdx = trebleBands.indexOf(Math.max(...trebleBands));

    assert.ok(bassPeakIdx < 30, `Expected 100Hz peak in lower third of log spectrum, got idx=${bassPeakIdx}`);
    assert.ok(treblePeakIdx > 60, `Expected 4000Hz peak in upper third of log spectrum, got idx=${treblePeakIdx}`);
});

