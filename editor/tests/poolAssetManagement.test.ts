import test from 'node:test';
import assert from 'node:assert/strict';

import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { AssetFilterNode } from '../src/nodes/AssetFilterNode.ts';
import {
    getPoolPermutationOrder,
    isCalculatedPoolQuery,
    isFieldOperatorExpression,
    isExternalPoolItem,
    isInlinePoolItem,
} from '../../ermes/ts/slotLanguage.ts';
import {
    refreshArmedSeeds,
    setGlobalSeed,
    setGlobalSeedLocked,
} from '../../ermes/ts/randomResolver.ts';
import { resolveAssetFilterNode } from '../../ermes/ts/assetResolver.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('SampleNode and SequenceNode expose dedicated POOL tab in panel schema and tabs list', () => {
    const sample = new SampleNode();
    const seq = new SequenceNode();

    assert.ok(sample.propertiesTabs.includes('POOL'));
    assert.ok(seq.propertiesTabs.includes('POOL'));

    const samplePoolTab = sample.getPanelSchema().tabs.find(t => t.id === 'POOL');
    const seqPoolTab = seq.getPanelSchema().tabs.find(t => t.id === 'POOL');
    assert.ok(samplePoolTab, 'SampleNode schema should define a POOL tab');
    assert.ok(seqPoolTab, 'SequenceNode schema should define a POOL tab');
    assert.equal(samplePoolTab?.sections[0]?.type, 'pool_editor');
    assert.equal(seqPoolTab?.sections[0]?.type, 'pool_editor');
});

test('SampleNode auto-creates pool on single and multi-slot drops, calls by string name, and disambiguates duplicate basenames', async () => {
    const sample = new SampleNode();
    sample.id = 101;

    await sample.loadDroppedItemsIntoSlots([
        { id: 10, name: 'kick.wav', filepath: '/vault/kit_a/kick.wav', bpm: 120 },
    ]);

    assert.equal(sample.getPoolItems().length, 1);
    assert.equal(sample.properties.pool_query, 'kick.wav');
    assert.equal(isCalculatedPoolQuery(sample.properties.pool_query, sample.getPoolItems()), false);
    assert.equal(sample.findPoolItemRunIndex({ filepath: '/vault/kit_a/kick.wav', id: 10 }), 0);

    // Dropping a second file with the same basename from another folder disambiguates its callable name
    await sample.loadDroppedItemsIntoSlots([
        { id: 11, name: 'kick.wav', filepath: '/vault/kit_b/kick.wav', bpm: 128 },
    ], 'plus');

    const poolItems = sample.getPoolItems();
    assert.equal(poolItems.length, 2);
    assert.equal(poolItems[0].name, 'kick.wav');
    assert.equal(poolItems[1].name, 'kick (2).wav');
    assert.equal(sample.getSlots().length, 2);
    assert.equal(sample.getSlots()[0].pool_query, 'kick.wav');
    assert.equal(sample.getSlots()[1].pool_query, 'kick (2).wav');

    // Direct string call to the disambiguated name with spaces is NOT calculated (not blue)
    assert.equal(isCalculatedPoolQuery('kick (2).wav', poolItems), false);
    assert.equal(isFieldOperatorExpression('kick (2).wav', poolItems), false);

    sample.selectSlot(0);
    const matched = sample.applyPoolQuery('kick (2).wav');
    assert.equal(matched, true);
    assert.equal(sample.properties.filepath, '/vault/kit_b/kick.wav');
    assert.equal(sample.properties.pool_query, 'kick (2).wav');
});

test('Calculated pool queries (indices and operators) propagate across global_seed while direct string names stay pinned', async () => {
    const pool = new AssetFilterNode();
    pool.id = 202;

    const sample = new SampleNode();
    sample.id = 201;
    sample.properties.asset_modifier_id = pool.id;
    pool.properties.parentId = sample.id;

    const mockGraph: any = {
        extra: { global_seed: 0, global_seed_locked: false },
        _nodes: [sample, pool],
        links: {},
        getNodeById: (id: number) => [sample, pool].find(n => n.id === id) || null,
        sendActionToCanvas: () => {},
    };
    sample.graph = mockGraph;
    pool.graph = mockGraph;

    await sample.loadDroppedItemsIntoSlots([
        { id: 1, name: 'Kick 01.wav', filepath: '/vault/Kick 01.wav' },
        { id: 2, name: 'Snare 02.wav', filepath: '/vault/Snare 02.wav' },
        { id: 3, name: 'Hat 03.wav', filepath: '/vault/Hat 03.wav' },
    ], 'plus');

    const poolItems = sample.getPoolItems();
    assert.equal(poolItems.length, 3);

    // Slot 0: direct name call (with space) -> fixed (NOT calculated / NOT blue)
    assert.equal(isCalculatedPoolQuery('Kick 01.wav', poolItems), false);
    assert.equal(sample.getSlots()[0].pool_query, 'Kick 01.wav');

    // Slot 1: integer run index "0" -> calculated (BLUE)
    sample.selectSlot(1);
    assert.equal(sample.applyPoolQuery('0'), true);
    assert.equal(isCalculatedPoolQuery('0', poolItems), true);
    assert.equal(isFieldOperatorExpression('0', poolItems), false);

    // Slot 2: dynamic field operator "rand" -> calculated (BLUE)
    sample.selectSlot(2);
    assert.equal(sample.applyPoolQuery('rand'), true);
    assert.equal(isCalculatedPoolQuery('rand', poolItems), true);
    assert.equal(isFieldOperatorExpression('rand', poolItems), true);

    assert.equal(isCalculatedPoolQuery('[0 1]', poolItems), true);
    assert.equal(isCalculatedPoolQuery('<0 1>', poolItems), true);

    // Advance global_seed multiple times via refreshArmedSeeds and verify exact propagation
    let sawSlot1Change = false;
    const initialSlot1Path = sample.getSlots()[1].filepath;
    for (let step = 0; step < 6; step++) {
        refreshArmedSeeds(mockGraph, false);
        const curSeed = mockGraph.extra.global_seed;
        const expectedOrder = getPoolPermutationOrder(poolItems.length, curSeed, sample.getPoolSalt());
        const expectedRun0Item = poolItems[expectedOrder[0]];

        // Slot 0 (direct string name) stays pinned to Kick 01.wav regardless of global_seed
        assert.equal(sample.getSlots()[0].filepath, '/vault/Kick 01.wav');
        assert.equal(sample.getSlots()[0].pool_query, 'Kick 01.wav');

        // Slot 1 (index "0") propagates to current-run index 0 under global_seed
        assert.equal(sample.getSlots()[1].filepath, expectedRun0Item.filepath);
        assert.equal(sample.getSlots()[1].pool_query, '0');
        if (sample.getSlots()[1].filepath !== initialSlot1Path) {
            sawSlot1Change = true;
        }
    }
    assert.equal(sawSlot1Change, true, 'Index query "0" should track permuted run order across global_seed changes');

    // Verify serializer emits pool_node_id matching getPoolSalt()
    const serialized = serializeNodeSubtree(mockGraph, sample.id);
    assert.equal(serialized.pool_node_id, sample.getPoolSalt());
    assert.equal(serialized.global_seed, mockGraph.extra.global_seed);

    // When global_seed_locked is ON, refreshing must NOT move index "0"
    setGlobalSeed(mockGraph, 3);
    sample.evaluateAllFieldOperators(0);
    const lockedPath = sample.getSlots()[1].filepath;
    setGlobalSeedLocked(mockGraph, true);
    refreshArmedSeeds(mockGraph, false);
    assert.equal(sample.getSlots()[1].filepath, lockedPath);
});

test('External local samples load into pool without GAIA DB or metadata proposal prompts', async () => {
    const sample = new SampleNode();
    sample.id = 301;

    const extItem = {
        id: 'ext:C:\\External\\drum_hit.wav',
        filepath: 'C:\\External\\drum_hit.wav',
        name: 'drum_hit.wav',
        itemType: 'one_shot',
        is_external: true,
        source: 'external' as const,
        duration_seconds: 0.42,
    };
    assert.equal(isExternalPoolItem(extItem), true);

    await sample.loadDroppedItemsIntoSlots([extItem]);
    assert.equal(sample.isActiveAssetExternal(), true);
    assert.equal(sample.properties.pool_query, 'drum_hit.wav');
    assert.equal(sample.getPoolItems().length, 1);
    assert.equal(sample.getPoolItems()[0].is_external, true);

    // Editing metadata on an external sample must never trigger GAIA confirmation/proposals
    let confirmCalled = false;
    const prevWindow = (globalThis as any).window;
    try {
        (globalThis as any).window = {
            confirm: () => { confirmCalled = true; return false; },
            dispatchEvent: () => {},
        };
        const ok = await sample.preparePropertyEdit('key', 'Am');
        assert.equal(ok, true);
        assert.equal(confirmCalled, false);
    } finally {
        (globalThis as any).window = prevWindow;
    }

    // resolveAssetFilterNode handles external-only pool cleanly without calling GAIA /api/library/resolve
    const pool = new AssetFilterNode();
    pool.id = 302;
    pool.properties.parentId = sample.id;
    pool.properties.selected_items = [...sample.getPoolItems()];
    sample.properties.asset_modifier_id = pool.id;

    const prevFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    let poolResolvePayload: any = null;
    try {
        (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
            requestedUrls.push(String(url));
            if (String(url) === '/api/pool/resolve') {
                poolResolvePayload = JSON.parse(String(init?.body || '{}'));
                return {
                    ok: true,
                    json: async () => ({
                        sample: 'C:\\External\\drum_hit.wav',
                        items: poolResolvePayload.selected_items,
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };
        const resolved = await resolveAssetFilterNode(pool, sample, {
            kind: 'preview',
            libraryFiles: [],
        });
        assert.equal(resolved, 'C:\\External\\drum_hit.wav');
        assert.deepEqual(requestedUrls, ['/api/pool/resolve']);
        assert.equal(poolResolvePayload.selected_items[0].is_external, true);
    } finally {
        globalThis.fetch = prevFetch;
    }
});

test('SequenceNode written from scratch creates inline pool item, updates in place, forks file-backed edits, and supports rename + index queries', async () => {
    const seq = new SequenceNode();
    seq.id = 401;

    // 1. Written from scratch ("written by zero"): editing steps creates inline pool item at index 0
    seq.updateProperty('sequence', [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const inline0 = seq.ensureCurrentSequenceInPool({ forkIfFileBacked: true, forkIfSharedByOtherSlot: true });
    assert.ok(inline0);
    assert.equal(isInlinePoolItem(inline0), true);
    assert.equal(seq.getPoolItems().length, 1);
    assert.equal(seq.findPoolItemRunIndex({ id: inline0.id }), 0);

    // 2. Subsequent edit updates the same inline pool item in place (no duplicate pool items)
    seq.updateProperty('sequence', [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const updatedInline0 = seq.ensureCurrentSequenceInPool({ forkIfFileBacked: true, forkIfSharedByOtherSlot: true });
    assert.equal(updatedInline0.id, inline0.id);
    assert.equal(seq.getPoolItems().length, 1);
    assert.deepEqual(seq.getPoolItems()[0].sequence.slice(0, 4), [1, 1, 0, 0]);

    // 3. Adding Slot 1 and editing forks a separate inline pool item so Slot 0 remains intact
    seq.addSlot();
    assert.equal(seq.activeSlotIndex, 1);
    seq.updateProperty('sequence', [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const inline1 = seq.ensureCurrentSequenceInPool({ forkIfFileBacked: true, forkIfSharedByOtherSlot: true });
    assert.notEqual(inline1.id, inline0.id);
    assert.equal(seq.getPoolItems().length, 2);
    assert.deepEqual(seq.getSlots()[0].sequence.slice(0, 4), [1, 1, 0, 0]);
    assert.deepEqual(seq.getSlots()[1].sequence.slice(0, 4), [0, 0, 1, 1]);

    // 4. Editing a loaded file-backed sequence forks into "<Name> (edit)" while preserving the original file in pool
    const [fileItem] = seq.ensureItemsInPool([{
        id: 88,
        name: 'House Groove.seq',
        filepath: '/vault/House Groove.seq',
        type: 'sequence',
        sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    }]);
    assert.equal(seq.getPoolItems().length, 3);
    const calledFile = await seq.applyPoolQuery(fileItem.name);
    assert.equal(calledFile, true);
    assert.equal(seq.properties.filepath, '/vault/House Groove.seq');

    seq.updateProperty('sequence', [1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const forked = seq.ensureCurrentSequenceInPool({ forkIfFileBacked: true, forkIfSharedByOtherSlot: true });
    assert.equal(isInlinePoolItem(forked), true);
    assert.match(forked.name, /\(edit\)/);
    assert.equal(seq.getPoolItems().length, 4);
    assert.ok(seq.getPoolItems().some(it => it.filepath === '/vault/House Groove.seq'), 'Original file-backed item must stay intact in pool');

    // 5. Creating a new blank inline sequence & renaming updates slot queries
    const acid = seq.createNewInlineSequence('Acid Line');
    assert.ok(acid);
    assert.equal(seq.properties.pool_query, 'Acid Line');
    assert.equal(seq.renamePoolItem(String(acid.id), 'Acid Line v2'), true);
    assert.equal(seq.properties.pool_query, 'Acid Line v2');

    // 6. Index call "0" resolves inline item at run index 0 synchronously without HTTP fetch
    const indexMatched = await seq.applyPoolQuery('0');
    assert.equal(indexMatched, true);
    assert.equal(seq.properties.pool_query, '0');
    assert.equal(isCalculatedPoolQuery('0', seq.getPoolItems()), true);
    assert.deepEqual(seq.properties.sequence.slice(0, 4), [1, 1, 0, 0]);
});
