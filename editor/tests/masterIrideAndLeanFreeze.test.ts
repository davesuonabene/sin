import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('TrackNode inherits unified visualization_type and common visualizers from BaseNode', () => {
    const track = new TrackNode();

    assert.equal(track.properties.visualization_type, 'loop');
    assert.equal(track.getVisualizationType(), 'loop');
    assert.deepEqual(
        track.getSupportedVisualizationOptions().map(o => o.id),
        ['loop', 'realtime', 'spectrum']
    );
});

test('TrackNode getInputNodes resolves incoming connected nodes from graph links', () => {
    const track = new TrackNode();
    track.id = 10;

    const sourceNode: any = {
        id: 5,
        type: 'Audio/Sequence',
        properties: { total_bars: 8 }
    };

    const mockGraph: any = {
        links: {
            1: { id: 1, origin_id: 5, target_id: 10 }
        },
        getNodeById: (id: number) => {
            if (id === 5) return sourceNode;
            if (id === 10) return track;
            return null;
        }
    };

    track.graph = mockGraph;
    track.inputs[0].link = 1;

    const inputs = track.getInputNodes();
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].id, 5);
});

test('serializeNodeSubtree evaluates sequence with seed_mode fixed when frozen without mutating node property', () => {
    const sequenceNode = new SequenceNode();
    sequenceNode.id = 20;
    sequenceNode.properties.seed = 777;
    sequenceNode.properties.seed_mode = 'moving'; // User configured moving

    const mockGraph: any = {
        getNodeById: (id: number) => (id === 20 ? sequenceNode : null),
        _nodes: [sequenceNode],
        extra: {
            global_parameters: { bpm: 120, total_bars: 4 }
        }
    };

    // 1. When unfrozen: serialized model has seed_mode: "moving"
    const unfrozenModel = serializeNodeSubtree(mockGraph, 20, undefined, { isFrozen: false });
    assert.equal(unfrozenModel.seed_mode, 'moving');
    assert.equal(sequenceNode.properties.seed_mode, 'moving', 'Node property must remain "moving"');

    // 2. When frozen: serialized model has seed_mode: "fixed"
    const frozenModel = serializeNodeSubtree(mockGraph, 20, undefined, { isFrozen: true });
    assert.equal(frozenModel.seed_mode, 'fixed');
    assert.equal(sequenceNode.properties.seed_mode, 'moving', 'Node property must NOT be mutated in the UI');

    // 3. When unfreezing again: serialized model reverts to "moving"
    const unfreezingModel = serializeNodeSubtree(mockGraph, 20, undefined, { isFrozen: false });
    assert.equal(unfreezingModel.seed_mode, 'moving');
    assert.equal(sequenceNode.properties.seed_mode, 'moving');
});

test('Signal flow is source of truth: Sequence and Bus/Master Track resolve buffers from upstream inputs', () => {
    // Create a mock AudioBuffer
    function createMockBuffer(length: number, sampleRate = 44100): any {
        const channels = [new Float32Array(length).fill(0.5)];
        return {
            length,
            sampleRate,
            duration: length / sampleRate,
            numberOfChannels: 1,
            getChannelData: (ch: number) => channels[ch] || channels[0]
        };
    }

    // Set up mock window / AudioContext
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.dispatchEvent = (globalThis as any).window.dispatchEvent || (() => true);
    (globalThis as any).CustomEvent = (globalThis as any).CustomEvent || class {
        type: string;
        detail: any;
        constructor(type: string, detail?: any) {
            this.type = type;
            this.detail = detail;
        }
    };
    (globalThis as any).window.AudioContext = class {
        createBuffer(numChannels: number, length: number, sampleRate: number) {
            const channels: Float32Array[] = [];
            for (let i = 0; i < numChannels; i++) {
                channels.push(new Float32Array(length));
            }
            return {
                length,
                sampleRate,
                duration: length / sampleRate,
                numberOfChannels: numChannels,
                getChannelData: (ch: number) => channels[ch]
            };
        }
    };

    // 1. Sample node with buffer
    const sampleNode: any = {
        id: 1,
        type: 'Audio/Sample',
        audioBuffer: createMockBuffer(22050), // 0.5s sample
        getAudioBuffer: () => sampleNode.audioBuffer
    };

    // 2. Sequence node connected to Sample node
    const seqNode = new SequenceNode();
    seqNode.id = 2;
    seqNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0];
    seqNode.properties.total_bars = 4;
    seqNode.properties.step_length = 0.25;

    // 3. Bus track node connected to Sequence node
    const busTrack = new TrackNode();
    busTrack.id = 3;
    busTrack.properties.node_name = 'Punch Drum Bus';

    // 4. Master track node connected to Bus track node
    const masterTrack = new TrackNode();
    masterTrack.id = 4;
    masterTrack.properties.node_name = 'Master Output';
    masterTrack.properties.role = 'master';

    const mockGraph: any = {
        links: {
            1: [1, 1, 0, 2, 0, 'audio'], // LiteGraph array format: 1 (sample) -> 2 (sequence)
            2: { id: 2, origin_id: 2, target_id: 3 }, // LiteGraph object format: 2 (sequence) -> 3 (bus)
            3: [3, 3, 0, 4, 0, 'audio']  // 3 (bus) -> 4 (master)
        },
        getNodeById: (id: number) => {
            if (id === 1) return sampleNode;
            if (id === 2) return seqNode;
            if (id === 3) return busTrack;
            if (id === 4) return masterTrack;
            return null;
        }
    };

    sampleNode.graph = mockGraph;
    seqNode.graph = mockGraph;
    busTrack.graph = mockGraph;
    masterTrack.graph = mockGraph;

    seqNode.inputs[0].link = 1;
    busTrack.inputs[0].link = 2;
    masterTrack.inputs[0].link = 3;

    // Verify upstream resolution
    assert.equal(seqNode.getInputNodes().length, 1);
    assert.equal(seqNode.getInputNodes()[0].id, 1);

    assert.equal(busTrack.getInputNodes().length, 1);
    assert.equal(busTrack.getInputNodes()[0].id, 2);

    assert.equal(masterTrack.getInputNodes().length, 1);
    assert.equal(masterTrack.getInputNodes()[0].id, 3);

    // Verify buffer propagation along signal flow
    const seqBuf = seqNode.getAudioBuffer();
    assert.ok(seqBuf, 'SequenceNode should composite buffer from SampleNode');
    assert.ok(seqBuf.length > 0, 'Sequence buffer must have samples');

    const busBuf = busTrack.getAudioBuffer();
    assert.ok(busBuf, 'Bus TrackNode should resolve buffer from input SequenceNode');
    assert.ok(busBuf.length > 0, 'Bus buffer must have samples');

    const masterBuf = masterTrack.getAudioBuffer();
    assert.ok(masterBuf, 'Master TrackNode should resolve buffer from input Bus TrackNode');
    assert.ok(masterBuf.length > 0, 'Master buffer must have samples');
});

test('Bus TrackNode scales buffer with its own gain stage and propagates downstream', () => {
    function createMockBuffer(length: number, sampleRate = 44100): any {
        const channels = [new Float32Array(length).fill(0.8)];
        return {
            length,
            sampleRate,
            duration: length / sampleRate,
            numberOfChannels: 1,
            getChannelData: (ch: number) => channels[ch] || channels[0]
        };
    }

    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.dispatchEvent = (globalThis as any).window.dispatchEvent || (() => true);
    (globalThis as any).CustomEvent = (globalThis as any).CustomEvent || class {
        type: string;
        detail: any;
        constructor(type: string, detail?: any) {
            this.type = type;
            this.detail = detail;
        }
    };
    (globalThis as any).window.AudioContext = class {
        createBuffer(numChannels: number, length: number, sampleRate: number) {
            const channels: Float32Array[] = [];
            for (let i = 0; i < numChannels; i++) {
                channels.push(new Float32Array(length));
            }
            return {
                length,
                sampleRate,
                duration: length / sampleRate,
                numberOfChannels: numChannels,
                getChannelData: (ch: number) => channels[ch]
            };
        }
    };

    const sourceNode: any = {
        id: 10,
        type: 'Audio/Sequence',
        audioBuffer: createMockBuffer(1000),
        getAudioBuffer: () => sourceNode.audioBuffer
    };

    const busNode = new TrackNode();
    busNode.id = 20;
    busNode.properties.node_name = 'Sub Bus';

    const downstreamMaster = new TrackNode();
    downstreamMaster.id = 30;
    downstreamMaster.properties.node_name = 'Master';
    downstreamMaster.properties.role = 'master';

    const mockGraph: any = {
        links: {
            1: { id: 1, origin_id: 10, target_id: 20 },
            2: { id: 2, origin_id: 20, target_id: 30 }
        },
        getNodeById: (id: number) => {
            if (id === 10) return sourceNode;
            if (id === 20) return busNode;
            if (id === 30) return downstreamMaster;
            return null;
        },
        sendActionToCanvas: () => {}
    };

    busNode.graph = mockGraph;
    downstreamMaster.graph = mockGraph;
    busNode.inputs[0].link = 1;
    downstreamMaster.inputs[0].link = 2;

    // 1. Initially at unity gain (1.0), bus buffer matches input (0.8)
    const initialBuf = busNode.getAudioBuffer();
    assert.ok(initialBuf);
    assert.equal(Math.round(initialBuf.getChannelData(0)[0] * 100) / 100, 0.8);

    // 2. Adjust chain gain (e.g. 0.5 linear via Pre Gain)
    busNode.updateProperty('chain', [
        { type: 'gain', enabled: true, params: { gain: 0.5, gain_db: -6.0 } }
    ]);

    const scaledBuf = busNode.getAudioBuffer();
    assert.ok(scaledBuf);
    assert.equal(Math.round(scaledBuf.getChannelData(0)[0] * 100) / 100, 0.4, 'Bus buffer must scale by 0.5');

    // 3. Verify downstream master track receives the gain-scaled audio from bus
    const masterBuf = downstreamMaster.getAudioBuffer();
    assert.ok(masterBuf);
    assert.equal(Math.round(masterBuf.getChannelData(0)[0] * 100) / 100, 0.4, 'Downstream master must inherit bus gain scaling');
});



