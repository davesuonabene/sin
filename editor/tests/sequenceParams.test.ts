import test from 'node:test';
import assert from 'node:assert/strict';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('SequenceNode initializes sample_start, gate_length, and release parameters', () => {
    const node = new SequenceNode();

    // Node-level parameters
    assert.equal(node.properties.release, 0);
    assert.equal(node.properties.play_mode, 'gate');
    assert.equal(node.properties.step_length, 0.25);

    // Step parameters (16 steps)
    assert.equal(node.properties.step_parameters.length, 16);
    for (const step of node.properties.step_parameters) {
        assert.equal(step.sample_start, 0);
        assert.equal(step.gate_length, 1.0);
        assert.equal(step.velocity, 1);
        assert.equal(step.offset, 0);
        assert.equal(step.probability, 100);
    }

    // Step parameter schemas
    const stepFields = node.getStepParameterFields();
    const sampleStartField = stepFields.find(f => f.key === 'sample_start');
    assert.ok(sampleStartField, 'sample_start field schema must be registered');
    assert.equal(sampleStartField?.unit, '%');
    assert.equal(sampleStartField?.min, 0);
    assert.equal(sampleStartField?.max, 100);

    const gateLengthField = stepFields.find(f => f.key === 'gate_length');
    assert.ok(gateLengthField, 'gate_length field schema must be registered');
    assert.equal(gateLengthField?.min, 0.0);
    assert.equal(gateLengthField?.max, 1.0);

    // Node-level release field schema
    const releaseField = SequenceNode.fields.find(f => f.key === 'release');
    assert.ok(releaseField, 'release field schema must be registered');
    assert.equal(releaseField?.type, 'float');
    assert.equal(releaseField?.min, 0.0);
    assert.equal(releaseField?.max, 1.0);

    // Voice mode schema options
    const playModeField = SequenceNode.fields.find(f => f.key === 'play_mode');
    assert.ok(playModeField);
    assert.equal(playModeField?.label, 'Voice Mode');
    assert.deepEqual(playModeField?.options, [
        { value: 'gate', label: 'Mono' },
        { value: 'trigger', label: 'Multivoice' }
    ]);
});

test('SequenceNode toSequenceDocument and applySequenceDocument preserve sample_start and gate_length', () => {
    const node = new SequenceNode();
    node.properties.node_name = 'HiHat Pattern';
    node.properties.step_parameters[0].sample_start = 25;
    node.properties.step_parameters[0].gate_length = 0.5;
    node.properties.step_parameters[2].sample_start = 75;
    node.properties.step_parameters[2].gate_length = 0.3;

    const doc = node.toSequenceDocument();
    assert.equal(doc.channels[0].sample_start?.[0], 25);
    assert.equal(doc.channels[0].gate_length?.[0], 0.5);
    assert.equal(doc.channels[0].sample_start?.[2], 75);
    assert.equal(doc.channels[0].gate_length?.[2], 0.3);

    const targetNode = new SequenceNode();
    targetNode.applySequenceDocument(doc);
    assert.equal(targetNode.properties.step_parameters[0].sample_start, 25);
    assert.equal(targetNode.properties.step_parameters[0].gate_length, 0.5);
    assert.equal(targetNode.properties.step_parameters[2].sample_start, 75);
    assert.equal(targetNode.properties.step_parameters[2].gate_length, 0.3);

    // Test legacy document with 0-100 gate_length values auto-normalizes
    const legacyDoc = {
        format: 'sin-sequence' as const,
        version: 1,
        name: 'Legacy Pattern',
        channels: [{
            on: [1, 0, 0, 0],
            probability: [100, 100, 100, 100],
            offset: [0, 0, 0, 0],
            velocity: [1, 1, 1, 1],
            subdivisions: [1, 1, 1, 1],
            gate_length: [75, 100, 50, 25],
        }]
    };
    const legacyTarget = new SequenceNode();
    legacyTarget.applySequenceDocument(legacyDoc);
    assert.equal(legacyTarget.properties.step_parameters[0].gate_length, 0.75);
    assert.equal(legacyTarget.properties.step_parameters[1].gate_length, 1.0);
    assert.equal(legacyTarget.properties.step_parameters[2].gate_length, 0.5);
    assert.equal(legacyTarget.properties.step_parameters[3].gate_length, 0.25);
});

test('serializeNodeSubtree includes release and step parameters in compiled model', () => {
    const node = new SequenceNode();
    node.id = 42;
    node.properties.node_name = 'Snare Pattern';
    node.properties.release = 0.15;
    node.properties.play_mode = 'trigger';
    node.properties.step_parameters[0].sample_start = 10;
    node.properties.step_parameters[0].gate_length = 0.8;

    const mockGraph = {
        getNodeById: (id: number) => (id === 42 ? node : null),
        extra: { global_parameters: { bpm: 120 } }
    };

    const model = serializeNodeSubtree(mockGraph, 42);
    assert.ok(model);
    assert.equal(model.release, 0.15);
    assert.equal(model.play_mode, 'trigger');
    assert.equal(model.step_parameters?.[0].sample_start, 10);
    assert.equal(model.step_parameters?.[0].gate_length, 0.8);
});

test('Modifiers unify on deep purple #7e22ce and SequenceNode defaults to Mono (gate)', async () => {
    const { RandomNode } = await import('../src/nodes/RandomNode.ts');
    const { ModulatorNode } = await import('../src/nodes/ModulatorNode.ts');
    const { AssetFilterNode } = await import('../src/nodes/AssetFilterNode.ts');
    const { ArrangementNode } = await import('../src/nodes/ArrangementNode.ts');

    // Modifier classes default color
    assert.equal(RandomNode.defaultColor, '#7e22ce');
    assert.equal(ModulatorNode.defaultColor, '#7e22ce');
    assert.equal(AssetFilterNode.defaultColor, '#7e22ce');

    // Modifier instances
    const rnd = new RandomNode();
    const mod = new ModulatorNode();
    const flt = new AssetFilterNode();
    assert.equal(rnd.color, '#7e22ce');
    assert.equal(mod.color, '#7e22ce');
    assert.equal(flt.color, '#7e22ce');

    // Sequence mono default
    const seq = new SequenceNode();
    assert.equal(seq.properties.play_mode, 'gate');

    // Arrangement section structure
    const arr = new ArrangementNode();
    arr.properties.total_bars = 4.0;
    arr.properties.section_points = [1.0, 2.0];
    const struct = arr.getSectionStructure();
    assert.deepEqual(struct.points, [1.0, 2.0]);
    assert.equal(struct.probability.length, 3);
});

