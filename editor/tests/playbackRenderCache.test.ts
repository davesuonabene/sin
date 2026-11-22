import assert from 'node:assert/strict';
import test from 'node:test';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { WaveformRenderer, ArrangementRenderer } from '../../packages/iride/src/index.ts';

function makeMockAudioBuffer(length = 4410, sr = 44100): AudioBuffer {
    const ch0 = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        ch0[i] = Math.sin(i * 0.1) * 0.5;
    }
    return {
        sampleRate: sr,
        length,
        duration: length / sr,
        numberOfChannels: 1,
        getChannelData: () => ch0,
    } as unknown as AudioBuffer;
}

function makeMockAudioContext() {
    let createBufferCalls = 0;
    const ctx = {
        createBuffer(numChannels: number, length: number, sampleRate: number) {
            createBufferCalls++;
            const channels = Array.from({ length: numChannels }, () => new Float32Array(length));
            return {
                sampleRate,
                length,
                duration: length / sampleRate,
                numberOfChannels: numChannels,
                getChannelData: (c: number) => channels[c],
            };
        }
    };
    return { ctx, getCreateBufferCalls: () => createBufferCalls };
}

test('SequenceNode.getSlotBuffersMap caches composited buffers across repeated playback frames', () => {
    const prevWindow = (globalThis as any).window;
    const prevAudioCtx = (globalThis as any).AudioContext;
    const { ctx, getCreateBufferCalls } = makeMockAudioContext();

    try {
        (globalThis as any).AudioContext = function () { return ctx; };
        (globalThis as any).window = {
            AudioContext: (globalThis as any).AudioContext,
            getGlobalParameter: (k: string) => (k === 'bpm' ? 120 : 4),
            dispatchEvent: () => true,
        };

        const sampleBuf = makeMockAudioBuffer(1024, 44100);
        const seqNode = new SequenceNode();
        seqNode.id = 11;
        seqNode.properties.total_bars = 1;
        seqNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        (seqNode as any).getInputNodes = () => [{
            id: 9,
            audioBuffer: sampleBuf,
            getAudioBuffer: () => sampleBuf,
            getSlots: () => [{ slot: 0 }],
        }];

        // Simulate 30 animation frames calling getSlotBuffersMap()
        const firstMap = seqNode.getSlotBuffersMap();
        assert.equal(firstMap.size, 1);
        const callsAfterFirst = getCreateBufferCalls();
        assert.equal(callsAfterFirst, 1);

        for (let frame = 0; frame < 30; frame++) {
            const nextMap = seqNode.getSlotBuffersMap();
            assert.strictEqual(nextMap, firstMap, 'Single-slot map must reuse cached Map across frames');
            assert.strictEqual(nextMap.get(0), firstMap.get(0), 'Single-slot buffer must reuse cached AudioBuffer across frames');
        }
        assert.equal(getCreateBufferCalls(), callsAfterFirst, 'Zero AudioBuffer reallocations during steady playback frames');

        // Mutating sequence invalidates cache cleanly
        seqNode.properties.sequence = [1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        const updatedMap = seqNode.getSlotBuffersMap();
        assert.notStrictEqual(updatedMap.get(0), firstMap.get(0));
        assert.equal(getCreateBufferCalls(), callsAfterFirst + 1);
    } finally {
        (globalThis as any).window = prevWindow;
        (globalThis as any).AudioContext = prevAudioCtx;
    }
});

test('WaveformRenderer and ArrangementRenderer skip redundant offscreen tint compositing when only playhead advances', () => {
    const prevDoc = (globalThis as any).document;
    let sourceInOps = 0;

    function createFakeCanvas() {
        let gco = 'source-over';
        const ctx: any = {
            save() { },
            restore() { },
            clip() { },
            beginPath() { },
            moveTo() { },
            lineTo() { },
            closePath() { },
            arc() { },
            arcTo() { },
            roundRect() { },
            rect() { },
            stroke() { },
            fill() { },
            clearRect() { },
            fillRect() {
                if (gco === 'source-in') sourceInOps++;
            },
            drawImage() { },
            fillText() { },
            measureText: (t: string) => ({ width: t.length * 6 }),
            get globalCompositeOperation() { return gco; },
            set globalCompositeOperation(v: string) { gco = v; },
        };
        return {
            width: 0,
            height: 0,
            getContext: () => ctx,
        };
    }

    try {
        (globalThis as any).document = { createElement: () => createFakeCanvas() };
        const mainCtx = createFakeCanvas().getContext() as unknown as CanvasRenderingContext2D;

        const wf = new WaveformRenderer({ accentColor: '#059669' });
        const peaks = new Float32Array([-0.5, 0.5, -0.3, 0.4, -0.8, 0.8, -0.2, 0.2]);
        const bounds = { x: 0, y: 0, width: 200, height: 50 };

        for (let f = 0; f < 20; f++) {
            wf.setSignal({
                peaks,
                duration: 16,
                accentColor: '#059669',
                playbackProgress: f / 20,
                isInvalidated: false,
            });
            wf.render(mainCtx, bounds, { isPlaying: true, time: f * 0.5, duration: 16, bpm: 120, beat: f, bar: f / 4, phase: 0 });
        }
        assert.equal(sourceInOps, 1, 'WaveformRenderer must tint its offscreen mask ONCE across 20 steady playback frames');

        sourceInOps = 0;
        const arr = new ArrangementRenderer({ accentColor: '#f59e0b' });
        const sections = [
            { index: 0, startBar: 0, lengthBars: 8, probability: 1, quant: 'auto', slotIndex: 0 },
            { index: 1, startBar: 8, lengthBars: 8, probability: 0.7, quant: 'bar', slotIndex: 0 },
        ];
        for (let f = 0; f < 20; f++) {
            arr.setSignal({ totalBars: 16, sections, accentColor: '#f59e0b' });
            arr.render(mainCtx, bounds, { isPlaying: true, time: f * 0.5, duration: 32, bpm: 120, beat: f * 2, bar: f * 0.5, phase: 0 });
        }
        assert.equal(sourceInOps, 1, 'ArrangementRenderer must tint its offscreen mask ONCE across 20 steady playback frames');
    } finally {
        (globalThis as any).document = prevDoc;
    }
});
