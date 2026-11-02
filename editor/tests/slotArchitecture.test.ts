import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hashSeed,
    mulberry32,
    wrapSlotIndex,
    resolveStepSlots,
    resolveCycleSeeds,
    resolveModifierSlotSeeds,
    rollSeedExpression,
} from '../../ermes/ts/slotLanguage.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { populateOwnerSlotsFromPool, resolveAssetFilterNode, resolveAssignedAssetFilters } from '../../ermes/ts/assetResolver.ts';
import { populateOwnerSlotsFromRandom, refreshArmedSeeds } from '../../ermes/ts/randomResolver.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('slotLanguage evaluates step_slots, cycle_seeds, and modulo wrapping deterministically', () => {
    assert.equal(wrapSlotIndex(0, 3), 0);
    assert.equal(wrapSlotIndex(3, 3), 0);
    assert.equal(wrapSlotIndex(4, 3), 1);
    assert.equal(wrapSlotIndex(-1, 3), 2);
    assert.equal(wrapSlotIndex(99, 1), 0);

    // Repeating pattern "0 1" across 8 steps with 2 upstream slots
    assert.deepEqual(resolveStepSlots('0 1', 8, 2, 42), [0, 1, 0, 1, 0, 1, 0, 1]);

    // Overflowing pattern "0 2 5" against 2 upstream slots wraps via k % 2
    assert.deepEqual(resolveStepSlots('0 2 5', 6, 2, 42), [0, 0, 1, 0, 0, 1]);

    // Deterministic "rand" token
    const randA = resolveStepSlots('rand', 16, 4, 42);
    const randB = resolveStepSlots('rand', 16, 4, 42);
    assert.deepEqual(randA, randB);
    assert.ok(randA.every(idx => idx >= 0 && idx < 4));

    // Multi-cycle seed expressions
    assert.deepEqual(resolveCycleSeeds('42 108', 4, 1), [42, 108, 42, 108]);
    assert.deepEqual(resolveModifierSlotSeeds('10 20', 4, 1), [10, 20, 10, 20]);

    // Seed rolling preserves rand tokens and advances integers
    assert.equal(rollSeedExpression('rand'), 'rand');
    const rolled = rollSeedExpression('42 108');
    assert.notEqual(rolled, '42 108');
    assert.equal(rolled.split(' ').length, 2);
});

test('SampleNode and SequenceNode manage dynamic slots and active selection', () => {
    const sample = new SampleNode();
    assert.equal(sample.getSlots().length, 1);
    assert.equal(sample.activeSlotIndex, 0);

    sample.updateProperty('filepath', 'kick_0.wav');
    const newIdx = sample.addSlot();
    assert.equal(newIdx, 1);
    assert.equal(sample.getSlots().length, 2);
    assert.equal(sample.activeSlotIndex, 1);

    sample.updateProperty('filepath', 'kick_1.wav');
    assert.equal(sample.getSlots()[0].filepath, 'kick_0.wav');
    assert.equal(sample.getSlots()[1].filepath, 'kick_1.wav');

    sample.selectSlot(0);
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample.properties.filepath, 'kick_0.wav');

    sample.removeSlot(1);
    assert.equal(sample.getSlots().length, 1);

    const seq = new SequenceNode();
    assert.equal(seq.getSlots().length, 1);
    seq.updateProperty('sample_slot', '0 1');
    const seqSlot1 = seq.addSlot();
    assert.equal(seqSlot1, 1);
    seq.updateProperty('sample_slot', 'rand');
    assert.equal(seq.getSlots()[0].sample_slot, '0 1');
    assert.equal(seq.getSlots()[1].sample_slot, 'rand');
});

test('populateOwnerSlotsFromPool and populateOwnerSlotsFromRandom populate multi-slot nodes deterministically', () => {
    const sample = new SampleNode();
    sample.id = 1;
    sample.addSlot();
    sample.addSlot();
    assert.equal(sample.getSlots().length, 3);

    const poolNode: any = {
        id: 2,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 1,
            seed: '42 108 303',
            selected_items: [
                { id: 10, filepath: 'a.wav', bpm: 120, key: 'C' },
                { id: 20, filepath: 'b.wav', bpm: 128, key: 'Am' },
                { id: 30, filepath: 'c.wav', bpm: 140, key: 'Fm' },
            ],
        },
    };

    populateOwnerSlotsFromPool(poolNode, sample);
    const slots = sample.getSlots();
    assert.equal(slots.length, 3);
    assert.ok(slots.every(s => Boolean(s.filepath)));

    const seq = new SequenceNode();
    seq.id = 10;
    seq.addSlot();
    assert.equal(seq.getSlots().length, 2);

    const randomNode: any = {
        id: 11,
        type: 'Audio/Random',
        properties: {
            parentId: 10,
            seed: '100 200',
            destinations: [
                {
                    id: 'd1',
                    paramKey: 'step:0:velocity',
                    paramLabel: 'Step 1 Velocity',
                    minPercent: -50,
                    maxPercent: 0,
                    baseValue: 1.0,
                    enabled: true,
                },
            ],
        },
    };

    populateOwnerSlotsFromRandom(randomNode, seq);
    const seqSlots = seq.getSlots();
    const vel0 = seqSlots[0].step_parameters?.[0]?.velocity;
    const vel1 = seqSlots[1].step_parameters?.[0]?.velocity;
    assert.equal(typeof vel0, 'number');
    assert.equal(typeof vel1, 'number');
    assert.notEqual(vel0, vel1);
});

test('refreshArmedSeeds rolls only armed seeds and respects globalFreeze', () => {
    const seq = new SequenceNode();
    seq.id = 1;
    seq.properties.seed = '42';
    seq.properties.seed_refresh = true;

    const arr = new ArrangementNode();
    arr.id = 2;
    arr.properties.seed = '108';
    arr.properties.seed_refresh = false; // Disarmed

    const mockGraph = {
        _nodes: [seq, arr],
        getNodeById: (id: number) => (id === 1 ? seq : id === 2 ? arr : null),
    };

    // Frozen -> nothing rolls
    assert.equal(refreshArmedSeeds(mockGraph, true), false);
    assert.equal(seq.properties.seed, '42');
    assert.equal(arr.properties.seed, '108');

    // Unfrozen -> only armed seed rolls
    assert.equal(refreshArmedSeeds(mockGraph, false), true);
    assert.notEqual(seq.properties.seed, '42');
    assert.equal(arr.properties.seed, '108');
});

test('serializeNodeSubtree resolves connected-path step_slots and section_slots with modulo wrapping', () => {
    const sample = new SampleNode();
    sample.id = 1;
    sample.properties.filepath = 'kick0.wav';
    sample.addSlot();
    sample.updateProperty('filepath', 'kick1.wav');
    sample.selectSlot(0);

    const seq = new SequenceNode();
    seq.id = 2;
    // Simulate UI calling getSlots() first (which initializes slots[0] with default sample_slot '0')
    seq.getSlots();
    seq.updateProperty('sample_slot', '0 1 3'); // 3 wraps to 3 % 2 = 1
    seq.updateProperty('seed', '42 108');
    seq.inputs = [{ name: 'In', type: 'audio', link: 100 }];

    const arr = new ArrangementNode();
    arr.id = 3;
    arr.properties.section_points = [2.0];
    arr.properties.section_slots = [0, 5]; // 5 wraps to 5 % 1 = 0 (since seq has 1 slot)
    arr.inputs = [{ name: 'In', type: 'audio', link: 101 }];

    const mockGraph = {
        _nodes: [sample, seq, arr],
        links: {
            100: { id: 100, origin_id: 1, target_id: 2 },
            101: { id: 101, origin_id: 2, target_id: 3 },
        },
        getNodeById: (id: number) => [sample, seq, arr].find(n => n.id === id) || null,
    };

    const compiled = serializeNodeSubtree(mockGraph, 3);
    assert.deepEqual(compiled.section_slots, [0, 0]);
    const compiledSeq = compiled.children[0];
    assert.deepEqual(compiledSeq.step_slots.slice(0, 6), [0, 1, 1, 0, 1, 1]);
    assert.deepEqual(compiledSeq.slots[0].step_slots.slice(0, 6), [0, 1, 1, 0, 1, 1]);
    assert.equal(compiledSeq.slots[0].sample_slot, '0 1 3');
    assert.equal(compiledSeq.cycle_seeds[0], 42);
    assert.equal(compiledSeq.cycle_seeds[1], 108);

    const compiledSample = compiledSeq.children[0];
    assert.equal(compiledSample.slots.length, 2);
    assert.equal(compiledSample.slots[0].filepath, 'kick0.wav');
    assert.equal(compiledSample.slots[1].filepath, 'kick1.wav');
});

test('refreshArmedSeeds advances "rand" seeds via seed_salt across refreshes', () => {
    const sample = new SampleNode();
    sample.id = 1;
    sample.addSlot();

    const poolNode: any = {
        id: 2,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 1,
            seed: 'rand',
            seed_refresh: true,
            selected_items: [
                { id: 1, filepath: 's0.wav' },
                { id: 2, filepath: 's1.wav' },
                { id: 3, filepath: 's2.wav' },
                { id: 4, filepath: 's3.wav' },
            ],
        },
    };

    const seq = new SequenceNode();
    seq.id = 3;
    seq.getSlots();
    seq.updateProperty('sample_slot', 'rand');
    seq.updateProperty('seed', 'rand');
    seq.properties.seed_refresh = true;
    seq.inputs = [{ name: 'In', type: 'audio', link: 200 }];

    const mockGraph = {
        _nodes: [sample, poolNode, seq],
        links: { 200: { id: 200, origin_id: 1, target_id: 3 } },
        getNodeById: (id: number) => [sample, poolNode, seq].find((n: any) => n.id === id) || null,
    };

    populateOwnerSlotsFromPool(poolNode, sample);
    const beforeSeq = serializeNodeSubtree(mockGraph, 3);
    const beforeCycleSeeds = [...beforeSeq.cycle_seeds];

    refreshArmedSeeds(mockGraph, false);
    const afterSeq = serializeNodeSubtree(mockGraph, 3);
    assert.equal(seq.properties.seed, 'rand');
    assert.notDeepEqual(afterSeq.cycle_seeds, beforeCycleSeeds);
});

test('single-slot SampleNode with active pool keeps slot[0] stable across populateOwnerSlotsFromPool, resolveAssetFilterNode, and resolveAssignedAssetFilters', async () => {
    const sample = new SampleNode();
    sample.id = 10;
    sample.properties.asset_modifier_id = 11;

    const poolItems = [
        { id: 101, filepath: 'alpha.wav', absolute_path: 'alpha.wav', bpm: 120, key: 'Cmin', duration_seconds: 2.4 },
        { id: 102, filepath: 'beta.wav', absolute_path: 'beta.wav', bpm: 128, key: 'Fmin', duration_seconds: 3.1 },
        { id: 103, filepath: 'gamma.wav', absolute_path: 'gamma.wav', bpm: 140, key: 'Gmin', duration_seconds: 1.8 },
    ];

    const poolNode: any = {
        id: 11,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 10,
            playbackMode: 'Random',
            refresh_mode: 'global',
            seed: '777',
            seed_refresh: true,
            selected_items: poolItems,
        },
        updateProperty(key: string, value: any) {
            this.properties[key] = value;
        },
    };

    const mockGraph = {
        _nodes: [sample, poolNode],
        links: {},
        getNodeById: (id: number) => [sample, poolNode].find((n: any) => n.id === id) || null,
        sendActionToCanvas: () => {},
    };
    (sample as any).graph = mockGraph;

    // 1. Ensure pool slots populate on selection / initial fill
    sample.ensurePoolSlotsPopulated();
    const initialPath = sample.properties.filepath;
    assert.ok(initialPath, 'slot[0] filepath should be populated');
    assert.equal(sample.getSlots()[0].filepath, initialPath);
    assert.equal(poolNode.properties.output_value, initialPath);

    // 2. resolveAssetFilterNode (single-slot) must pick the exact same slot[0] sample
    await resolveAssetFilterNode(poolNode, sample, poolItems as any);
    assert.equal(sample.properties.filepath, initialPath);
    assert.equal(sample.getSlots()[0].filepath, initialPath);
    assert.equal(poolNode.properties.output_value, initialPath);

    // 3. resolveAssignedAssetFilters with refreshModifiers=false must not flip slot[0] or fire redundant updates
    const prevWindow = (globalThis as any).window;
    let refreshEvents = 0;
    const listener = () => { refreshEvents++; };
    if (prevWindow && typeof prevWindow.addEventListener === 'function') {
        prevWindow.addEventListener('node-properties-refreshed', listener);
    }
    try {
        await resolveAssignedAssetFilters(mockGraph, 10, false, false, poolItems as any);
        assert.equal(sample.properties.filepath, initialPath);
        assert.equal(sample.getSlots()[0].filepath, initialPath);
        assert.equal(refreshEvents, 0, 'should not fire node-properties-refreshed when nothing changed');
    } finally {
        if (prevWindow && typeof prevWindow.removeEventListener === 'function') {
            prevWindow.removeEventListener('node-properties-refreshed', listener);
        }
    }
});

test('SampleNode.syncMetadataFromLibrary ignores sub-50ms duration jitter and unchanged metadata', async () => {
    const sample = new SampleNode();
    sample.id = 20;
    sample.updateProperty('filepath', 'loop_a.wav');
    sample.updateProperty('library_item_id', 55);
    sample.updateProperty('sample_type', 'loop');
    sample.updateProperty('original_bpm', 124);
    sample.updateProperty('key', 'Amin');
    // Simulate WebAudio decoded duration with slight float discrepancy vs GAIA DB
    sample.updateProperty('duration_seconds', 2.4000226757369615);

    const libraryFiles: any[] = [{
        id: 55,
        name: 'loop_a.wav',
        filepath: 'loop_a.wav',
        absolute_path: 'loop_a.wav',
        sample_type: 'loop',
        is_loop: true,
        bpm: 124,
        key: 'Amin',
        duration_seconds: 2.4,
    }];

    let updateCount = 0;
    const origUpdate = sample.updateProperty.bind(sample);
    sample.updateProperty = (k: string, v: any) => {
        updateCount++;
        return origUpdate(k, v);
    };

    await sample.syncMetadataFromLibrary(libraryFiles, 55);
    assert.equal(updateCount, 0, 'syncMetadataFromLibrary should not call updateProperty when metadata matches within tolerance');
});
