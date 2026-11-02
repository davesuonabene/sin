import test from 'node:test';
import assert from 'node:assert/strict';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';
import {
    DEFAULT_FLOAT_STEP,
    DEFAULT_INT_STEP,
    FLOAT_LADDER_STEPS,
    INT_LADDER_STEPS,
    computeLadderPointerUpdate,
    getParameterWheelStep,
    roundStepValue,
} from '../src/ui/ParameterWheelMenu.ts';

test('SequenceNode initializes normalized sample_start, probability, gate_length, and release parameters with 0.1 default step', () => {
    const node = new SequenceNode();

    // Node-level parameters
    assert.equal(node.properties.release, 0);
    assert.equal(node.properties.play_mode, 'gate');
    assert.equal(node.properties.step_length, 0.25);

    // Step parameters (16 steps)
    assert.equal(node.properties.step_parameters.length, 16);
    for (const step of node.properties.step_parameters) {
        assert.equal(step.sample_start, 0.0);
        assert.equal(step.gate_length, 1.0);
        assert.equal(step.velocity, 1.0);
        assert.equal(step.offset, 0.0);
        assert.equal(step.probability, 1.0);
    }

    // Step parameter schemas
    const stepFields = node.getStepParameterFields();
    const sampleStartField = stepFields.find(f => f.key === 'sample_start');
    assert.ok(sampleStartField, 'sample_start field schema must be registered');
    assert.equal(sampleStartField?.type, 'float');
    assert.equal(sampleStartField?.min, 0.0);
    assert.equal(sampleStartField?.max, 1.0);
    assert.equal(sampleStartField?.step, 0.1);

    const probField = stepFields.find(f => f.key === 'probability');
    assert.ok(probField, 'probability field schema must be registered');
    assert.equal(probField?.type, 'float');
    assert.equal(probField?.min, 0.0);
    assert.equal(probField?.max, 1.0);
    assert.equal(probField?.step, 0.1);

    const gateLengthField = stepFields.find(f => f.key === 'gate_length');
    assert.ok(gateLengthField, 'gate_length field schema must be registered');
    assert.equal(gateLengthField?.min, 0.0);
    assert.equal(gateLengthField?.max, 1.0);
    assert.equal(gateLengthField?.step, 0.1);

    // Node-level release field schema
    const releaseField = SequenceNode.fields.find(f => f.key === 'release');
    assert.ok(releaseField, 'release field schema must be registered');
    assert.equal(releaseField?.type, 'float');
    assert.equal(releaseField?.min, 0.0);
    assert.equal(releaseField?.max, 1.0);
    assert.equal(releaseField?.step, 0.1);

    // Voice mode schema options
    const playModeField = SequenceNode.fields.find(f => f.key === 'play_mode');
    assert.ok(playModeField);
    assert.equal(playModeField?.label, 'Voice Mode');
    assert.deepEqual(playModeField?.options, [
        { value: 'gate', label: 'Mono' },
        { value: 'trigger', label: 'Multivoice' }
    ]);
});

test('SequenceNode toSequenceDocument and applySequenceDocument preserve normalized values and migrate legacy 0..100 values', () => {
    const node = new SequenceNode();
    node.properties.node_name = 'HiHat Pattern';
    node.properties.step_parameters[0].sample_start = 0.25;
    node.properties.step_parameters[0].gate_length = 0.5;
    node.properties.step_parameters[0].probability = 0.8;
    node.properties.step_parameters[2].sample_start = 0.75;
    node.properties.step_parameters[2].gate_length = 0.3;
    node.properties.step_parameters[2].probability = 0.5;

    const doc = node.toSequenceDocument();
    assert.equal(doc.channels[0].sample_start?.[0], 0.25);
    assert.equal(doc.channels[0].gate_length?.[0], 0.5);
    assert.equal(doc.channels[0].probability?.[0], 0.8);
    assert.equal(doc.channels[0].sample_start?.[2], 0.75);
    assert.equal(doc.channels[0].gate_length?.[2], 0.3);
    assert.equal(doc.channels[0].probability?.[2], 0.5);

    const targetNode = new SequenceNode();
    targetNode.applySequenceDocument(doc);
    assert.equal(targetNode.properties.step_parameters[0].sample_start, 0.25);
    assert.equal(targetNode.properties.step_parameters[0].gate_length, 0.5);
    assert.equal(targetNode.properties.step_parameters[0].probability, 0.8);
    assert.equal(targetNode.properties.step_parameters[2].sample_start, 0.75);
    assert.equal(targetNode.properties.step_parameters[2].gate_length, 0.3);
    assert.equal(targetNode.properties.step_parameters[2].probability, 0.5);

    // Test legacy document with 0-100 probability, sample_start, and gate_length values auto-normalizes
    const legacyDoc = {
        format: 'sin-sequence' as const,
        version: 1,
        name: 'Legacy Pattern',
        channels: [{
            on: [1, 0, 0, 0],
            probability: [100, 80, 50, 25],
            offset: [0, 0, 0, 0],
            velocity: [1, 1, 1, 1],
            subdivisions: [1, 1, 1, 1],
            sample_start: [0, 25, 50, 100],
            gate_length: [75, 100, 50, 25],
        }]
    };
    const legacyTarget = new SequenceNode();
    legacyTarget.applySequenceDocument(legacyDoc);
    assert.equal(legacyTarget.properties.step_parameters[0].probability, 1.0);
    assert.equal(legacyTarget.properties.step_parameters[1].probability, 0.8);
    assert.equal(legacyTarget.properties.step_parameters[2].probability, 0.5);
    assert.equal(legacyTarget.properties.step_parameters[3].probability, 0.25);
    assert.equal(legacyTarget.properties.step_parameters[0].sample_start, 0.0);
    assert.equal(legacyTarget.properties.step_parameters[1].sample_start, 0.25);
    assert.equal(legacyTarget.properties.step_parameters[2].sample_start, 0.5);
    assert.equal(legacyTarget.properties.step_parameters[3].sample_start, 1.0);
    assert.equal(legacyTarget.properties.step_parameters[0].gate_length, 0.75);
    assert.equal(legacyTarget.properties.step_parameters[1].gate_length, 1.0);
    assert.equal(legacyTarget.properties.step_parameters[2].gate_length, 0.5);
    assert.equal(legacyTarget.properties.step_parameters[3].gate_length, 0.25);
});

test('serializeNodeSubtree includes release and normalized step parameters in compiled model', () => {
    const node = new SequenceNode();
    node.id = 42;
    node.properties.node_name = 'Snare Pattern';
    node.properties.release = 0.15;
    node.properties.play_mode = 'trigger';
    node.properties.step_parameters[0].sample_start = 0.1;
    node.properties.step_parameters[0].gate_length = 0.8;
    node.properties.step_parameters[0].probability = 0.7;

    const mockGraph = {
        getNodeById: (id: number) => (id === 42 ? node : null),
        extra: { global_parameters: { bpm: 120 } }
    };

    const model = serializeNodeSubtree(mockGraph, 42);
    assert.ok(model);
    assert.equal(model.release, 0.15);
    assert.equal(model.play_mode, 'trigger');
    assert.equal(model.step_parameters?.[0].sample_start, 0.1);
    assert.equal(model.step_parameters?.[0].gate_length, 0.8);
    assert.equal(model.step_parameters?.[0].probability, 0.7);
});

test('TouchDesigner Value Ladder defaults to 0.1 step and computes vertical rung selection + horizontal value scrubbing', () => {
    assert.equal(DEFAULT_FLOAT_STEP, 0.1);
    assert.equal(DEFAULT_INT_STEP, 1);
    assert.equal(getParameterWheelStep(false), 0.1);
    assert.equal(getParameterWheelStep(true), 1);

    // Vertical movement selects ladder rungs (rungs: [10, 1, 0.1, 0.01, 0.001], index 2 = 0.1)
    const moveUpOneRung = computeLadderPointerUpdate({
        originY: 100,
        lastScrubX: 100,
        clientX: 100,
        clientY: 76, // -24px -> index 2 - 1 = index 1 (step = 1)
        initialRungIndex: 2,
        activeRungIndex: 2,
        isScrubbing: false,
        steps: FLOAT_LADDER_STEPS,
    });
    assert.equal(moveUpOneRung.activeRungIndex, 1);
    assert.equal(moveUpOneRung.step, 1);
    assert.equal(moveUpOneRung.isScrubbing, false);
    assert.equal(moveUpOneRung.valueDelta, 0);

    // Horizontal movement locks rung and scrubs value by step per 12px
    const scrubRight = computeLadderPointerUpdate({
        originY: 100,
        lastScrubX: 100,
        clientX: 126, // +26px (> 10px threshold, 2 ticks of 12px at step 0.1 -> +0.2)
        clientY: 100,
        initialRungIndex: 2,
        activeRungIndex: 2,
        isScrubbing: false,
        steps: FLOAT_LADDER_STEPS,
    });
    assert.equal(scrubRight.isScrubbing, true);
    assert.equal(scrubRight.activeRungIndex, 2);
    assert.equal(roundStepValue(0.5 + scrubRight.valueDelta, scrubRight.step), 0.7);

    // Integer ladder steps and rounding
    assert.deepEqual(INT_LADDER_STEPS, [100, 10, 1]);
    assert.equal(roundStepValue(0.30000000000000004, 0.1), 0.3);
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

