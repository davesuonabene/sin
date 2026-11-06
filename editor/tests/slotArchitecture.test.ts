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
    isFieldOperatorExpression,
    evaluateNumericFieldOperator,
    getPoolPermutationOrder,
    permutePoolItems,
    parseFieldOperatorAST,
    resolveFieldOperatorLeaf,
} from '../../ermes/ts/slotLanguage.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { WidgetFactory } from '../src/ui/WidgetFactory.ts';
import { populateOwnerSlotsFromPool, resolveAssetFilterNode, resolveAssignedAssetFilters, resolvePoolItemByQuery } from '../../ermes/ts/assetResolver.ts';
import {
    populateOwnerSlotsFromRandom,
    refreshArmedSeeds,
    getGlobalSeed,
    setGlobalSeed,
    isGlobalSeedLocked,
    setGlobalSeedLocked,
    getEffectiveFieldSeed,
    applyRandomModulation,
} from '../../ermes/ts/randomResolver.ts';
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
        sendActionToCanvas: () => {},
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

test('reloading staged JSON when active_slot > 0 preserves distinct sequences and sample slots without overwriting slot 0', () => {
    const seq = new SequenceNode();
    seq.id = 1;
    const seqSlot0 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const seqSlot1 = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0];
    seq.updateProperty('sequence', seqSlot0);
    seq.addSlot();
    seq.updateProperty('sequence', seqSlot1);
    assert.equal(seq.activeSlotIndex, 1);
    assert.deepEqual(seq.getSlots()[0].sequence, seqSlot0);
    assert.deepEqual(seq.getSlots()[1].sequence, seqSlot1);

    // Simulate serialized stage JSON saved while active_slot === 1
    const stageData = JSON.parse(JSON.stringify({
        id: 1,
        type: 'Audio/Sequence',
        properties: seq.properties,
    }));

    // Simulate reload: probe.configure(stageData) followed by realNode.configure(stageData)
    const probe = new SequenceNode();
    probe.configure(stageData);
    probe.syncActiveSlotFromProperties();

    const restored = new SequenceNode();
    restored.configure(stageData);
    restored.syncActiveSlotFromProperties();

    assert.equal(restored.activeSlotIndex, 1);
    assert.deepEqual(restored.getSlots()[0].sequence, seqSlot0);
    assert.deepEqual(restored.getSlots()[1].sequence, seqSlot1);
    assert.deepEqual(restored.properties.sequence, seqSlot1);

    // Switching back to slot 0 restores slot 0's sequence intact
    restored.selectSlot(0);
    assert.equal(restored.activeSlotIndex, 0);
    assert.deepEqual(restored.properties.sequence, seqSlot0);
    assert.deepEqual(restored.getSlots()[1].sequence, seqSlot1);
});

test('default output mode and wildcard "*" listen to active_slot on Sample, Sequence, and Arrangement', () => {
    const sample = new SampleNode();
    sample.id = 1;
    sample.updateProperty('filepath', 's0.wav');
    sample.addSlot();
    sample.updateProperty('filepath', 's1.wav');
    assert.equal(sample.activeSlotIndex, 1);

    const seq = new SequenceNode();
    seq.id = 2;
    assert.equal(seq.properties.sample_slot, '*');
    seq.updateProperty('sequence', [1, 0, 0, 0]);
    seq.addSlot();
    seq.updateProperty('sequence', [1, 1, 1, 1]);
    assert.equal(seq.activeSlotIndex, 1);
    seq.inputs = [{ name: 'In', type: 'audio', link: 100 }];

    const arr = new ArrangementNode();
    arr.id = 3;
    assert.deepEqual(arr.properties.section_slots, ['*']);
    arr.inputs = [{ name: 'In', type: 'audio', link: 101 }];

    const mockGraph = {
        _nodes: [sample, seq, arr],
        links: {
            100: { id: 100, origin_id: 1, target_id: 2 },
            101: { id: 101, origin_id: 2, target_id: 3 },
        },
        getNodeById: (id: number) => [sample, seq, arr].find(n => n.id === id) || null,
        sendActionToCanvas: () => {},
    };
    (seq as any).graph = mockGraph;
    (arr as any).graph = mockGraph;

    // With sample on slot 1 and seq on slot 1, wildcard '*' resolves to slot 1
    let compiled = serializeNodeSubtree(mockGraph, 3);
    assert.deepEqual(compiled.section_slots, [1]);
    assert.equal(compiled.children[0].active_slot, 1);
    assert.deepEqual(compiled.children[0].step_slots.slice(0, 4), [1, 1, 1, 1]);
    assert.equal(compiled.children[0].children[0].active_slot, 1);

    // Swapping sample to slot 0 and seq to slot 0 updates '*' resolution automatically
    sample.selectSlot(0);
    seq.selectSlot(0);
    compiled = serializeNodeSubtree(mockGraph, 3);
    assert.deepEqual(compiled.section_slots, [0]);
    assert.equal(compiled.children[0].active_slot, 0);
    assert.deepEqual(compiled.children[0].step_slots.slice(0, 4), [0, 0, 0, 0]);
    assert.equal(compiled.children[0].children[0].active_slot, 0);
});

test('resolvePoolItemByQuery and applyPoolQuery support index, name match, and rand on SampleNode and SequenceNode', async () => {
    const poolItems = [
        { id: 1, name: 'Deep Kick 01', filepath: '/vault/samples/deep_kick_01.wav', bpm: 124, key: 'Cmin' },
        { id: 2, name: 'Snare Snap', filepath: '/vault/samples/snare_snap.wav', bpm: 128, key: 'Fmin' },
        { id: 3, name: 'Closed Hat', filepath: '/vault/samples/closed_hat.wav', bpm: 130, key: 'Amin' },
    ];

    // Direct query resolution
    assert.equal(resolvePoolItemByQuery(poolItems as any, '0', 0, 42)?.id, 1);
    assert.equal(resolvePoolItemByQuery(poolItems as any, '1', 0, 42)?.id, 2);
    assert.equal(resolvePoolItemByQuery(poolItems as any, '4', 0, 42)?.id, 2); // 4 % 3 = 1
    assert.equal(resolvePoolItemByQuery(poolItems as any, 'snare', 0, 42)?.id, 2);
    assert.equal(resolvePoolItemByQuery(poolItems as any, 'closed_hat', 0, 42)?.id, 3);
    assert.ok(resolvePoolItemByQuery(poolItems as any, 'rand', 0, 42)?.id);

    const sample = new SampleNode();
    sample.id = 100;
    sample.properties.asset_modifier_id = 101;
    const poolNode: any = {
        id: 101,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 100,
            seed: '42',
            selected_items: poolItems,
        },
        updateProperty(key: string, value: any) {
            this.properties[key] = value;
        },
    };
    (sample as any).graph = {
        _nodes: [sample, poolNode],
        getNodeById: (id: number) => (id === 100 ? sample : id === 101 ? poolNode : null),
        sendActionToCanvas: () => {},
    };

    // Index query on SampleNode
    sample.applyPoolQuery('1');
    assert.equal(sample.properties.pool_query, '1');
    assert.equal(sample.properties.filepath, '/vault/samples/snare_snap.wav');
    assert.equal(sample.getSlots()[0].pool_query, '1');

    // String match query on SampleNode
    sample.applyPoolQuery('closed');
    assert.equal(sample.properties.pool_query, 'closed');
    assert.equal(sample.properties.filepath, '/vault/samples/closed_hat.wav');

    // Rand query on SampleNode
    sample.applyPoolQuery('rand');
    assert.equal(sample.properties.pool_query, 'rand');
    assert.ok(sample.properties.filepath);

    // SequenceNode pool query
    const seq = new SequenceNode();
    seq.id = 200;
    seq.properties.asset_modifier_id = 201;
    const seqPoolItems = [
        { id: 10, name: 'Acid Bassline', filepath: '/vault/midi/acid_bassline.mid' },
        { id: 20, name: 'Euclidean Groove', filepath: '/vault/midi/euclidean_groove.mid' },
    ];
    const seqPoolNode: any = {
        id: 201,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 200,
            seed: '99',
            selected_items: seqPoolItems,
        },
        updateProperty(key: string, value: any) {
            this.properties[key] = value;
        },
    };
    (seq as any).graph = {
        _nodes: [seq, seqPoolNode],
        getNodeById: (id: number) => (id === 200 ? seq : id === 201 ? seqPoolNode : null),
        sendActionToCanvas: () => {},
    };

    await seq.applyPoolQuery('1');
    assert.equal(seq.properties.pool_query, '1');
    assert.equal(seq.properties.filepath, '/vault/midi/euclidean_groove.mid');
    assert.equal(seq.properties.sequence_name, 'Euclidean Groove');
});

test('inline Pool view toggle replaces parameter fields below visualizer and restores them when toggled off', () => {
    const sample = new SampleNode();
    const defaultSchema = sample.getPanelSchema();
    const defaultSections = defaultSchema.tabs[0].sections.map(s => s.type);
    assert.equal(defaultSections[0], 'waveform_crop');
    assert.ok(defaultSections.includes('fields'));
    assert.ok(!defaultSections.includes('pool_editor'));

    // Toggle pool view ON -> keeps waveform_crop at top and replaces fields with pool_editor
    assert.equal(sample.togglePoolView(), true);
    const poolSchema = sample.getPanelSchema();
    assert.deepEqual(poolSchema.tabs[0].sections.map(s => s.type), ['waveform_crop', 'pool_editor']);

    // Toggle pool view OFF -> restores normal parameter fields
    assert.equal(sample.togglePoolView(), false);
    assert.deepEqual(sample.getPanelSchema().tabs[0].sections.map(s => s.type), defaultSections);

    const seq = new SequenceNode();
    const defaultSeqSections = seq.getPanelSchema().tabs[0].sections.map(s => s.type);
    assert.equal(defaultSeqSections[0], 'sequence_grid');
    assert.ok(defaultSeqSections.includes('fields'));
    assert.equal(seq.togglePoolView(true), true);
    assert.deepEqual(seq.getPanelSchema().tabs[0].sections.map(s => s.type), ['sequence_grid', 'pool_editor']);
    assert.equal(seq.togglePoolView(false), false);
    assert.deepEqual(seq.getPanelSchema().tabs[0].sections.map(s => s.type), defaultSeqSections);
});

test('copySlot and pasteSlot copy-paste slot contents across slots on SampleNode and SequenceNode', () => {
    const sample = new SampleNode();
    sample.updateProperty('filepath', '/vault/kick_heavy.wav');
    sample.updateProperty('crop_start', 0.15);
    sample.updateProperty('crop_end', 0.85);
    sample.updateProperty('transpose', 2);
    sample.updateProperty('pool_query', 'kick_heavy');
    sample.addSlot();
    sample.updateProperty('filepath', '/vault/other.wav');
    sample.updateProperty('crop_start', 0);

    // Copy slot 0 and paste into slot 1
    assert.ok(sample.copySlot(0));
    assert.equal(sample.pasteSlot(1), true);
    assert.equal(sample.getSlots()[1].filepath, '/vault/kick_heavy.wav');
    assert.equal(sample.getSlots()[1].crop_start, 0.15);
    assert.equal(sample.getSlots()[1].crop_end, 0.85);
    assert.equal(sample.getSlots()[1].pitch_shift, 2);
    assert.equal(sample.getSlots()[1].pool_query, 'kick_heavy');
    assert.equal(sample.properties.filepath, '/vault/kick_heavy.wav');

    const seq = new SequenceNode();
    const patternA = [1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
    seq.updateProperty('sequence', patternA);
    seq.updateProperty('sequence_name', 'Funky Pattern');
    seq.updateProperty('sample_slot', '0 1');
    seq.addSlot();
    seq.updateProperty('sequence', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    assert.ok(seq.copySlot(0));
    assert.equal(seq.pasteSlot(1), true);
    assert.deepEqual(seq.getSlots()[1].sequence, patternA);
    assert.equal(seq.getSlots()[1].sequence_name, 'Funky Pattern');
    assert.equal(seq.getSlots()[1].sample_slot, '0 1');
    assert.deepEqual(seq.properties.sequence, patternA);
});

test('multi-slot selection, mixed-value detection, broadcast editing, and multi-slot deletion on SampleNode and SequenceNode', () => {
    const sample = new SampleNode();
    sample.updateProperty('filepath', '/vault/s0.wav');
    sample.updateProperty('transpose', 2);
    sample.updateProperty('gain', 1.0);
    sample.addSlot(); // slot 1
    sample.updateProperty('filepath', '/vault/s1.wav');
    sample.updateProperty('transpose', -3);
    sample.updateProperty('gain', 1.0);
    sample.addSlot(); // slot 2
    sample.updateProperty('filepath', '/vault/s2.wav');
    sample.updateProperty('transpose', 5);
    sample.updateProperty('gain', 1.0);

    // Select slot 0, then toggle-select slot 2
    sample.selectSlot(0);
    assert.deepEqual(sample.getSelectedSlotIndices(), [0]);
    sample.selectSlot(2, { toggle: true });
    assert.deepEqual(sample.getSelectedSlotIndices(), [0, 2]);

    // transpose differs across slots 0 and 2 -> hasMixedSlotValues('transpose') is true
    assert.equal(sample.hasMixedSlotValues('transpose'), true);
    // gain is 1.0 in both -> hasMixedSlotValues('gain') is false
    assert.equal(sample.hasMixedSlotValues('gain'), false);

    // Editing transpose transfers the new value to all selected slots (0 and 2), leaving slot 1 untouched
    sample.updateProperty('transpose', 7);
    assert.equal(sample.hasMixedSlotValues('transpose'), false);
    assert.equal(sample.getSlots()[0].pitch_shift, 7);
    assert.equal(sample.getSlots()[1].pitch_shift, -3);
    assert.equal(sample.getSlots()[2].pitch_shift, 7);

    // Range selection from 0 to 2 selects [0, 1, 2]
    sample.selectSlot(0);
    sample.selectSlot(2, { range: true });
    assert.deepEqual(sample.getSelectedSlotIndices(), [0, 1, 2]);
    assert.equal(sample.hasMixedSlotValues('transpose'), true);

    // Multi-slot deletion removes selected slots while preserving at least 1 slot
    sample.selectSlot(0);
    sample.selectSlot(2, { toggle: true });
    sample.removeSlot();
    assert.equal(sample.getSlots().length, 1);
    assert.equal(sample.getSlots()[0].filepath, '/vault/s1.wav');
    assert.deepEqual(sample.getSelectedSlotIndices(), [0]);

    // SequenceNode multi-slot selection and broadcast parameter edit
    const seq = new SequenceNode();
    seq.updateProperty('step_length', 0.25);
    seq.addSlot();
    seq.updateProperty('step_length', 0.5);
    seq.selectSlot(0);
    seq.selectSlot(1, { toggle: true });
    assert.deepEqual(seq.getSelectedSlotIndices(), [0, 1]);
    assert.equal(seq.hasMixedSlotValues('step_length'), true);

    seq.updateProperty('step_length', 0.125);
    assert.equal(seq.hasMixedSlotValues('step_length'), false);
    assert.equal(seq.getSlots()[0].step_length, 0.125);
    assert.equal(seq.getSlots()[1].step_length, 0.125);
});

test('loadDroppedItemsIntoSlots: dropping on "+" creates multiple slots while dropping on slot/waveform writes a cycling text list', async () => {
    const sample = new SampleNode();
    assert.equal(sample.getSlots().length, 1);

    const droppedSamples = [
        { id: 101, name: 'Kick A', filepath: '/vault/kick_a.wav', bpm: 120, key: 'Cmin' },
        { id: 102, name: 'Kick B', filepath: '/vault/kick_b.wav', bpm: 124, key: 'Dmin' },
        { id: 103, name: 'Kick C', filepath: '/vault/kick_c.wav', bpm: 128, key: 'Emin' },
    ];

    // 1. Dropping multiple items onto "+" ('plus') creates multiple individual fixed slots
    await sample.loadDroppedItemsIntoSlots(droppedSamples, 'plus');
    assert.equal(sample.getSlots().length, 3);
    assert.equal(sample.getSlots()[0].filepath, '/vault/kick_a.wav');
    assert.equal(sample.getSlots()[0].pool_query, '');
    assert.equal(sample.getSlots()[1].filepath, '/vault/kick_b.wav');
    assert.equal(sample.getSlots()[2].filepath, '/vault/kick_c.wav');
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample.properties.filepath, '/vault/kick_a.wav');

    // 2. Dropping multiple items onto a slot pill (e.g. slot 1) does NOT create extra slots;
    //    instead it writes a cycling text list operator into pool_query for that slot.
    await sample.loadDroppedItemsIntoSlots([
        { id: 104, name: 'Snare X', filepath: '/vault/snare_x.wav' },
        { id: 105, name: 'Snare Y', filepath: '/vault/snare_y.wav' },
    ], 1);
    assert.equal(sample.getSlots().length, 3, 'slot count should remain 3 when dropping onto slot 1');
    assert.equal(sample.activeSlotIndex, 1);
    assert.equal(sample.getSlots()[1].pool_query, 'snare_x.wav snare_y.wav');
    assert.equal(sample.properties.pool_query, 'snare_x.wav snare_y.wav');
    assert.equal(sample.properties.filepath, '/vault/snare_x.wav');

    // Advancing trigger count cycles the text list operator independent of seed
    sample.advanceTriggerCount();
    assert.equal(sample.getTriggerCount(), 1);
    assert.equal(sample.properties.filepath, '/vault/snare_y.wav');
    sample.advanceTriggerCount();
    assert.equal(sample.getTriggerCount(), 2);
    assert.equal(sample.properties.filepath, '/vault/snare_x.wav');

    // Resetting trigger count (as on Refresh) returns list to index 0
    sample.resetTriggerCount();
    assert.equal(sample.getTriggerCount(), 0);
    assert.equal(sample.properties.filepath, '/vault/snare_x.wav');

    // 3. SequenceNode: dropping onto "+" creates multiple sequence slots
    const seq = new SequenceNode();
    await seq.loadDroppedItemsIntoSlots([
        { id: 201, name: 'Pattern 1', filepath: '/vault/p1.mid', sequence: [1, 0, 1, 0] },
        { id: 202, name: 'Pattern 2', filepath: '/vault/p2.mid', sequence: [0, 1, 0, 1] },
    ], 'plus');
    assert.equal(seq.getSlots().length, 2);
    assert.equal(seq.getSlots()[0].sequence_name, 'Pattern 1');
    assert.equal(seq.getSlots()[1].sequence_name, 'Pattern 2');
    assert.deepEqual(seq.getSlots()[0].sequence.slice(0, 4), [1, 0, 1, 0]);
    assert.deepEqual(seq.getSlots()[1].sequence.slice(0, 4), [0, 1, 0, 1]);
});

test('Field Operators: parameter fields evaluate rand, ranges, and trigger-count lists, and refreshArmedSeeds resets trigger_count', () => {
    // 1. Distinguish fixed values vs Field Operators
    assert.equal(isFieldOperatorExpression(''), false);
    assert.equal(isFieldOperatorExpression('0'), false);
    assert.equal(isFieldOperatorExpression('kick_a.wav'), false);
    assert.equal(isFieldOperatorExpression('*'), false);
    assert.equal(isFieldOperatorExpression('rand'), true);
    assert.equal(isFieldOperatorExpression('-5..5'), true);
    assert.equal(isFieldOperatorExpression('0 0 0 1'), true);
    assert.equal(isFieldOperatorExpression('kick_a.wav kick_b.wav'), true);

    // 2. List operators are driven by trigger_count, NOT seed
    const val0SeedA = evaluateNumericFieldOperator('0 5 -2', { seed: 10, triggerCount: 0 });
    const val0SeedB = evaluateNumericFieldOperator('0 5 -2', { seed: 9999, triggerCount: 0 });
    assert.equal(val0SeedA, 0);
    assert.equal(val0SeedB, 0);
    assert.equal(evaluateNumericFieldOperator('0 5 -2', { seed: 9999, triggerCount: 1 }), 5);
    assert.equal(evaluateNumericFieldOperator('0 5 -2', { seed: 1234, triggerCount: 2 }), -2);
    assert.equal(evaluateNumericFieldOperator('0 5 -2', { seed: 5678, triggerCount: 3 }), 0);

    // 3. Parameter field operator on SampleNode (e.g. transpose = "0 5 -3")
    const sample = new SampleNode();
    sample.id = 301;
    assert.equal(WidgetFactory.isFieldCalculated(sample, 'transpose'), false);

    const resolved0 = sample.applyFieldOperator('transpose', '0 5 -3');
    assert.equal(resolved0, 0);
    assert.equal(sample.properties.transpose, 0);
    assert.equal(sample.hasFieldOperator('transpose'), true);
    assert.equal(WidgetFactory.isFieldCalculated(sample, 'transpose'), true);

    sample.advanceTriggerCount();
    assert.equal(sample.properties.transpose, 5);
    sample.advanceTriggerCount();
    assert.equal(sample.properties.transpose, -3);

    // Refresh resets trigger_count to 0 across nodes
    const mockGraph = {
        _nodes: [sample],
        getNodeById: (id: number) => (id === 301 ? sample : null),
    };
    refreshArmedSeeds(mockGraph, false);
    assert.equal(sample.getTriggerCount(), 0);
    assert.equal(sample.properties.transpose, 0);

    // Clearing operator returns field to fixed state (not calculated/blue)
    sample.clearFieldOperator('transpose');
    sample.updateProperty('transpose', 2);
    assert.equal(WidgetFactory.isFieldCalculated(sample, 'transpose'), false);
});

test('SampleNode and SequenceNode preserve list operator expressions across refreshes, serialize selected_items for preview, and update live iteration display', async () => {
    const sample = new SampleNode();
    sample.id = 401;
    sample.properties.asset_modifier_id = 402;
    sample.addSlot(); // 2 slots (0 and 1)
    sample.selectSlot(0);

    const samplePoolItems = [
        { id: 1, name: 'Kick 01', filepath: '/vault/kick_01.wav' },
        { id: 2, name: 'Kick 02', filepath: '/vault/kick_02.wav' },
    ];
    const samplePoolNode: any = {
        id: 402,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 401,
            seed: '42',
            selected_items: samplePoolItems,
        },
        updateProperty(key: string, value: any) {
            this.properties[key] = value;
        },
    };

    const seq = new SequenceNode();
    seq.id = 403;
    seq.properties.asset_modifier_id = 404;
    seq.inputs = [{ name: 'In', type: 'audio', link: 901 }];
    const seqPoolItems = [
        { id: 10, name: 'Pattern A', filepath: '/vault/pat_a.seq', sequence: [1, 0, 0, 0] },
        { id: 20, name: 'Pattern B', filepath: '/vault/pat_b.seq', sequence: [1, 0, 1, 0] },
    ];
    const seqPoolNode: any = {
        id: 404,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 403,
            seed: '99',
            selected_items: seqPoolItems,
        },
        updateProperty(key: string, value: any) {
            this.properties[key] = value;
        },
    };

    const mockGraph = {
        _nodes: [sample, samplePoolNode, seq, seqPoolNode],
        links: { 901: { id: 901, origin_id: 401, target_id: 403 } },
        getNodeById: (id: number) => [sample, samplePoolNode, seq, seqPoolNode].find((n: any) => n.id === id) || null,
        sendActionToCanvas: () => {},
    };
    (sample as any).graph = mockGraph;
    (seq as any).graph = mockGraph;

    // Apply index cycle lists on both Sample and Sequence
    sample.applyPoolQuery('0 0 1');
    sample.applyFieldOperator('transpose', '0 0 7');
    await seq.applyPoolQuery('0 0 0 1');
    seq.applyFieldOperator('sample_slot', '0 0 0 1');

    // Verify sample_slot and pool_query expressions are NOT clobbered into single numbers
    assert.equal(sample.properties.pool_query, '0 0 1');
    assert.equal(seq.properties.pool_query, '0 0 0 1');
    assert.equal(seq.properties.sample_slot, '0 0 0 1');
    assert.equal(seq.getFieldOperator('sample_slot'), '0 0 0 1');

    // Refreshing armed seeds resets trigger_count and preserves the operator expressions
    refreshArmedSeeds(mockGraph, false);
    assert.equal(sample.properties.pool_query, '0 0 1');
    assert.equal(seq.properties.pool_query, '0 0 0 1');
    assert.equal(seq.properties.sample_slot, '0 0 0 1');

    // Preview serialization (includeDynamicPools: false) still includes selected_items and field_operators
    const serialized = serializeNodeSubtree(mockGraph, 403, undefined, { includeDynamicPools: false });
    assert.equal(serialized.pool_query, '0 0 0 1');
    assert.equal(serialized.selected_items.length, 2);
    assert.equal(serialized.field_operators.sample_slot, '0 0 0 1');
    assert.equal(serialized.children[0].pool_query, '0 0 1');
    assert.equal(serialized.children[0].selected_items.length, 2);
    assert.equal(serialized.children[0].field_operators.transpose, '0 0 7');

    // Live playback iteration telemetry updates calculated display values without mutating stored expressions
    sample._liveTriggerIteration = 2;
    sample._liveTriggeredFilepath = '/vault/kick_02.wav';
    assert.equal(sample.getTriggerCount(), 2);
    assert.equal(sample.evaluateFieldOperatorForKey('transpose', sample.getFieldOperator('transpose')), 7);
    assert.equal(sample.properties.pool_query, '0 0 1');

    seq._liveTriggerIteration = 3;
    seq._liveTriggeredSequenceName = 'Pattern B';
    seq._liveTriggeredSequence = [1, 0, 1, 0];
    assert.equal(seq.getTriggerCount(), 3);
    assert.equal(seq.evaluateFieldOperatorForKey('sample_slot', seq.getFieldOperator('sample_slot')), 1);
    assert.equal(seq.properties.sample_slot, '0 0 0 1');

    sample.resetTriggerCount();
    seq.resetTriggerCount();
    assert.equal(sample.getTriggerCount(), 0);
    assert.equal(seq.getTriggerCount(), 0);
    assert.equal(sample.evaluateFieldOperatorForKey('transpose', sample.getFieldOperator('transpose')), 0);
    assert.equal(seq.evaluateFieldOperatorForKey('sample_slot', seq.getFieldOperator('sample_slot')), 0);
});

test('Global Seed (0, 1, 2...) permutes Asset Pools at seed > 0 while preserving identity order at seed 0, and Global Seed Lock freezes pools/random mods while rolling field operators', () => {
    const items = [
        { id: 1, name: 'kick_0.wav', filepath: 'kick_0.wav' },
        { id: 2, name: 'kick_1.wav', filepath: 'kick_1.wav' },
        { id: 3, name: 'kick_2.wav', filepath: 'kick_2.wav' },
        { id: 4, name: 'kick_3.wav', filepath: 'kick_3.wav' },
        { id: 5, name: 'kick_4.wav', filepath: 'kick_4.wav' },
    ];

    // Seed 0 -> identity permutation [0, 1, 2, 3, 4]
    assert.deepEqual(getPoolPermutationOrder(5, 0, 10), [0, 1, 2, 3, 4]);
    assert.deepEqual(permutePoolItems(items, 0, 10).map(i => i.id), [1, 2, 3, 4, 5]);

    // Seed > 0 -> deterministic non-identity permutation
    const permSeed1 = getPoolPermutationOrder(5, 1, 10);
    assert.equal(permSeed1.length, 5);
    assert.deepEqual([...permSeed1].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
    assert.deepEqual(getPoolPermutationOrder(5, 1, 10), permSeed1);

    // Setup graph with SampleNode + AssetPool + RandomNode + Field Operator
    const sample = new SampleNode();
    sample.id = 501;
    sample.properties.asset_modifier_id = 502;

    const poolNode: any = {
        id: 502,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 501,
            selected_items: items,
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        },
    };

    const randomNode: any = {
        id: 503,
        type: 'Audio/Random',
        properties: {
            parentId: 501,
            destinations: [
                {
                    id: 'd1',
                    paramKey: 'gain',
                    paramLabel: 'Gain',
                    minPercent: -50,
                    maxPercent: 50,
                    baseValue: 0,
                    enabled: true,
                },
            ],
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        },
    };

    const mockGraph: any = {
        extra: { global_seed: 0, global_seed_locked: false },
        _nodes: [sample, poolNode, randomNode],
        getNodeById: (id: number) => [sample, poolNode, randomNode].find((n: any) => n.id === id) || null,
        sendActionToCanvas: () => {},
    };
    (sample as any).graph = mockGraph;
    (poolNode as any).graph = mockGraph;
    (randomNode as any).graph = mockGraph;

    populateOwnerSlotsFromPool(poolNode, sample);
    applyRandomModulation(randomNode, sample);
    sample.applyFieldOperator('transpose', '-12..12');

    // At global_seed = 0, slot 0 gets item 0 ('kick_0.wav')
    assert.equal(getGlobalSeed(mockGraph), 0);
    assert.equal(sample.properties.filepath, 'kick_0.wav');
    const gainAtSeed0 = sample.properties.gain;

    // Unlocked Refresh -> advances global_seed from 0 to 1
    refreshArmedSeeds(mockGraph, false);
    assert.equal(getGlobalSeed(mockGraph), 1);

    const expectedSeed1FirstItem = permutePoolItems(items, 1, 502)[0];
    assert.equal(sample.properties.filepath, expectedSeed1FirstItem.filepath);
    const gainAtSeed1 = sample.properties.gain;
    assert.notEqual(gainAtSeed1, gainAtSeed0);

    // Lock Global Seed -> Refresh keeps global_seed == 1 (pool order & random mod unchanged),
    // while advancing field_refresh_epoch so field operators re-roll!
    setGlobalSeedLocked(mockGraph, true);
    assert.equal(isGlobalSeedLocked(mockGraph), true);
    const fieldSeedBeforeLockedRefresh = getEffectiveFieldSeed(mockGraph, sample);

    refreshArmedSeeds(mockGraph, false);
    assert.equal(getGlobalSeed(mockGraph), 1);
    assert.equal(sample.properties.filepath, expectedSeed1FirstItem.filepath);
    assert.equal(sample.properties.gain, gainAtSeed1);
    const fieldSeedAfterLockedRefresh = getEffectiveFieldSeed(mockGraph, sample);
    assert.notEqual(fieldSeedAfterLockedRefresh, fieldSeedBeforeLockedRefresh);
});

test('Bracketed Field Operator grammar evaluates Global (unbracketed), Cycle ([...]), and Sequential Event (<...>) scopes', () => {
    // 1. Unbracketed "0 1" or "[0][1]" subdivides Ancestor Global Length (globalProgress)
    const astGlobal = parseFieldOperatorAST('0 1');
    assert.equal(resolveFieldOperatorLeaf(astGlobal, { globalProgress: 0.1 }).expr, '0');
    assert.equal(resolveFieldOperatorLeaf(astGlobal, { globalProgress: 0.49 }).expr, '0');
    assert.equal(resolveFieldOperatorLeaf(astGlobal, { globalProgress: 0.5 }).expr, '1');
    assert.equal(resolveFieldOperatorLeaf(astGlobal, { globalProgress: 0.9 }).expr, '1');

    const astConcat = parseFieldOperatorAST('[0][1]');
    assert.equal(resolveFieldOperatorLeaf(astConcat, { globalProgress: 0.25 }).expr, '0');
    assert.equal(resolveFieldOperatorLeaf(astConcat, { globalProgress: 0.75 }).expr, '1');

    // 2. "[0 1]" subdivides Cycle Length (cycleProgress)
    const astCycle = parseFieldOperatorAST('[0 1]');
    assert.equal(resolveFieldOperatorLeaf(astCycle, { globalProgress: 0.9, cycleProgress: 0.2 }).expr, '0');
    assert.equal(resolveFieldOperatorLeaf(astCycle, { globalProgress: 0.1, cycleProgress: 0.8 }).expr, '1');

    // 3. "<0 random>" alternates fixed '0' and 'random' on every sequential event_idx
    const astSeq = parseFieldOperatorAST('<0 random>');
    const leaf0 = resolveFieldOperatorLeaf(astSeq, { eventIdx: 0 });
    const leaf1 = resolveFieldOperatorLeaf(astSeq, { eventIdx: 1 });
    const leaf2 = resolveFieldOperatorLeaf(astSeq, { eventIdx: 2 });
    const leaf3 = resolveFieldOperatorLeaf(astSeq, { eventIdx: 3 });
    assert.equal(leaf0.expr, '0');
    assert.equal(leaf1.expr, 'random');
    assert.equal(leaf2.expr, '0');
    assert.equal(leaf3.expr, 'random');

    // 4. "random" vs "[random]" vs "<random>" PRNG seed sensitivity
    const valGlobalA = evaluateNumericFieldOperator('0..1000', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 0, eventIdx: 0
    });
    const valGlobalSameGlobalDiffCycle = evaluateNumericFieldOperator('0..1000', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 3, eventIdx: 7
    });
    // Unbracketed random stays constant across all cycles and events within the same globalIdx
    assert.equal(valGlobalA, valGlobalSameGlobalDiffCycle);

    // "[0..1000]" changes on cycleIdx but stays constant across events within the same cycleIdx
    const valCycle0Evt0 = evaluateNumericFieldOperator('[0..1000]', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 0, eventIdx: 0
    });
    const valCycle0Evt5 = evaluateNumericFieldOperator('[0..1000]', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 0, eventIdx: 5
    });
    const valCycle1Evt0 = evaluateNumericFieldOperator('[0..1000]', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 1, eventIdx: 0
    });
    assert.equal(valCycle0Evt0, valCycle0Evt5);
    assert.notEqual(valCycle0Evt0, valCycle1Evt0);

    // "<0..1000>" changes on every eventIdx
    const valEvt0 = evaluateNumericFieldOperator('<0..1000>', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 0, eventIdx: 0
    });
    const valEvt1 = evaluateNumericFieldOperator('<0..1000>', {
        min: 0, max: 1000, step: 1, seed: 42, salt: 1, globalIdx: 0, cycleIdx: 0, eventIdx: 1
    });
    assert.notEqual(valEvt0, valEvt1);

    // 5. Windowed sequential "[0 <1 2>]" uses windowEventIdx in the second half of the cycle
    assert.equal(
        evaluateNumericFieldOperator('[0 <1 2>]', {
            min: 0, max: 10, step: 1, seed: 42, salt: 1, cycleProgress: 0.25, eventIdx: 5, windowEventIdx: 0
        }),
        0
    );
    assert.equal(
        evaluateNumericFieldOperator('[0 <1 2>]', {
            min: 0, max: 10, step: 1, seed: 42, salt: 1, cycleProgress: 0.75, eventIdx: 5, windowEventIdx: 0
        }),
        1
    );
    assert.equal(
        evaluateNumericFieldOperator('[0 <1 2>]', {
            min: 0, max: 10, step: 1, seed: 42, salt: 1, cycleProgress: 0.75, eventIdx: 6, windowEventIdx: 1
        }),
        2
    );
});

test('Multi-Master hierarchy resolves global_bars from first downstream TrackNode during serialization', () => {
    const sample = new SampleNode();
    sample.id = 601;
    sample.outputs = [{ name: 'Out', type: 'audio', links: [1001] }];

    const seq = new SequenceNode();
    seq.id = 602;
    seq.inputs = [{ name: 'In', type: 'audio', link: 1001 }];
    seq.outputs = [{ name: 'Out', type: 'audio', links: [1002] }];

    const subMaster = new TrackNode();
    subMaster.id = 603;
    subMaster.properties.total_bars = 4;
    subMaster.inputs = [{ name: 'In', type: 'audio', link: 1002 }];
    subMaster.outputs = [{ name: 'Out', type: 'audio', links: [1003] }];

    const mainMaster = new TrackNode();
    mainMaster.id = 604;
    mainMaster.properties.total_bars = 16;
    mainMaster.inputs = [{ name: 'In', type: 'audio', link: 1003 }];

    const mockGraph: any = {
        extra: { global_seed: 3, global_parameters: { bpm: 120, total_bars: 8, key: 'C' } },
        _nodes: [sample, seq, subMaster, mainMaster],
        links: {
            1001: { id: 1001, origin_id: 601, target_id: 602 },
            1002: { id: 1002, origin_id: 602, target_id: 603 },
            1003: { id: 1003, origin_id: 603, target_id: 604 },
        },
        getNodeById: (id: number) => [sample, seq, subMaster, mainMaster].find(n => n.id === id) || null,
        sendActionToCanvas: () => {},
    };

    const compiledMain = serializeNodeSubtree(mockGraph, 604);
    assert.equal(compiledMain.total_bars, 16);
    assert.equal(compiledMain.global_seed, 3);

    const compiledSubMaster = compiledMain.children[0];
    assert.equal(compiledSubMaster.total_bars, 4);
    assert.equal(compiledSubMaster.global_bars, 16); // First downstream Master of subMaster is mainMaster (16 bars)

    const compiledSeq = compiledSubMaster.children[0];
    assert.equal(compiledSeq.total_bars, 4); // Inherited from subMaster (4 bars)
    assert.equal(compiledSeq.global_bars, 4); // First downstream Master of seq is subMaster (4 bars)
});

test('Inspector panel never switches slots during playback: IRIDE canvas stays reactive across slots while Inspector only updates when the active slot has a Field Operator', async () => {
    const sample = new SampleNode();
    sample.id = 701;
    await sample.loadDroppedItemsIntoSlots([
        { id: 1, name: 'kick.wav', filepath: '/vault/kick.wav' },
        { id: 2, name: 'snare.wav', filepath: '/vault/snare.wav' },
    ], 'plus');
    assert.equal(sample.getSlots().length, 2);
    sample.selectSlot(0);
    assert.equal(sample.activeSlotIndex, 0);

    (sample as any).manifestEvents = [
        { time: 0.0, duration: 0.25, slot: 0, filepath: '/vault/kick.wav', iteration: 0 },
        { time: 0.5, duration: 0.25, slot: 1, filepath: '/vault/snare.wav', iteration: 1 },
    ];

    // 1. Both slots are fixed (no Field Operator in pool_query):
    // IRIDE signal reacts to slot 1 at t=0.6s, but Inspector activeSlotIndex stays 0 and _liveTriggeredFilepath stays null
    const sigAtSlot0 = sample.resolveVisualizationSignal({ isPlaying: true, time: 0.1, duration: 2.0, beat: 0.2 } as any);
    assert.equal(sigAtSlot0.activeSlot, 0);
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample._liveTriggeredFilepath, null);

    const sigAtSlot1 = sample.resolveVisualizationSignal({ isPlaying: true, time: 0.6, duration: 2.0, beat: 1.2 } as any);
    assert.equal(sigAtSlot1.activeSlot, 1); // IRIDE canvas is reactive to slot 1
    assert.equal(sample.activeSlotIndex, 0); // Inspector stays on slot 0
    assert.equal(sample._liveTriggeredFilepath, null); // Fixed slot 0 does not switch filepath in Inspector

    // 2. Now give Slot 0 a Field Operator in pool_query ("[random]"), while Slot 1 remains fixed
    sample.selectSlot(0);
    sample.properties.pool_query = '[random]';
    sample.getSlots()[0].pool_query = '[random]';
    (sample as any).manifestEvents = [
        { time: 0.0, duration: 0.25, slot: 0, filepath: '/vault/kick_varA.wav', iteration: 0 },
        { time: 0.5, duration: 0.25, slot: 1, filepath: '/vault/snare.wav', iteration: 1 },
        { time: 1.0, duration: 0.25, slot: 0, filepath: '/vault/kick_varB.wav', iteration: 2 },
    ];

    // At t=0.1s (Slot 0 event): Inspector updates _liveTriggeredFilepath for Slot 0's "[random]" operator
    sample.resolveVisualizationSignal({ isPlaying: true, time: 0.1, duration: 2.0, beat: 0.2 } as any);
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample._liveTriggeredFilepath, '/vault/kick_varA.wav');

    // At t=0.6s (Slot 1 event): IRIDE shows Slot 1, but Inspector (on Slot 0) ignores Slot 1's event and keeps kick_varA.wav
    const sig2 = sample.resolveVisualizationSignal({ isPlaying: true, time: 0.6, duration: 2.0, beat: 1.2 } as any);
    assert.equal(sig2.activeSlot, 1);
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample._liveTriggeredFilepath, '/vault/kick_varA.wav');

    // At t=1.1s (Slot 0 event with new sample kick_varB.wav): Inspector updates to kick_varB.wav
    const sig3 = sample.resolveVisualizationSignal({ isPlaying: true, time: 1.1, duration: 2.0, beat: 2.2 } as any);
    assert.equal(sig3.activeSlot, 0);
    assert.equal(sample.activeSlotIndex, 0);
    assert.equal(sample._liveTriggeredFilepath, '/vault/kick_varB.wav');

    // User switches to Slot 1 during playback: _liveTriggeredFilepath clears and stays null since Slot 1 is fixed
    sample.selectSlot(1);
    assert.equal(sample.activeSlotIndex, 1);
    assert.equal(sample._liveTriggeredFilepath, null);
    sample.resolveVisualizationSignal({ isPlaying: true, time: 1.1, duration: 2.0, beat: 2.2 } as any);
    assert.equal(sample.activeSlotIndex, 1);
    assert.equal(sample._liveTriggeredFilepath, null);
});
