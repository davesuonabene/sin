import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveArrangementSourceVisual } from '../src/ui/arrangementSourceVisual.ts';

test('draws an arrangement source after its attached pool resolves a duration', () => {
    const previousWindow = (globalThis as any).window;
    const pooledSample = {
        id: 12,
        type: 'Audio/Sample',
        title: 'Sample',
        properties: {
            asset_modifier_id: 99,
            sample_type: 'loop',
            crop_start: 0,
            crop_end: 1,
            stretch_factor: 1,
            stretch_mode: 'time_stretch',
            target_bpm: 120,
            original_bpm: 120
        }
    };
    const pool = {
        id: 99,
        properties: {
            output_value: 'C:/pool/loop.wav',
            output_item_id: 35,
            output_bpm: 120,
            selected_items: [{
                id: 35,
                absolute_path: 'C:/pool/loop.wav',
                name: 'Pooled loop',
                type: 'sample',
                bpm: 120,
                duration_seconds: 8
            }]
        }
    };
    const arrangement = {
        type: 'Audio/Arrangement',
        inputs: [{ link: 17 }],
        properties: { target_bpm: 120 }
    };
    const nodes = new Map([[12, pooledSample], [99, pool]]);

    try {
        (globalThis as any).window = {
            editorGraph: {
                links: { 17: { origin_id: 12 } },
                getNodeById: (id: number) => nodes.get(id)
            }
        };

        const source = resolveArrangementSourceVisual(arrangement);
        assert.equal(source?.label, 'Pooled loop');
        assert.equal(source?.kind, 'loop');
        assert.equal(source?.bars, 4);
    } finally {
        (globalThis as any).window = previousWindow;
    }
});

test('resolves sequence duration in bars correctly (16 steps * 0.25 beat = 1 bar)', () => {
    const previousWindow = (globalThis as any).window;
    const sequenceNode = {
        id: 10,
        type: 'Audio/Sequence',
        title: 'Sequence Pattern',
        properties: {
            node_name: '808 Sequence',
            sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_length: 0.25
        }
    };
    const arrangement = {
        type: 'Audio/Arrangement',
        inputs: [{ link: 25 }],
        properties: { target_bpm: 120 }
    };
    const nodes = new Map([[10, sequenceNode]]);

    try {
        (globalThis as any).window = {
            editorGraph: {
                links: { 25: { origin_id: 10 } },
                getNodeById: (id: number) => nodes.get(id),
                extra: { global_parameters: { beats_per_bar: 4 } }
            }
        };

        const source = resolveArrangementSourceVisual(arrangement);
        assert.equal(source?.label, '808 Sequence');
        assert.equal(source?.kind, 'sequence');
        assert.equal(source?.bars, 1);
    } finally {
        (globalThis as any).window = previousWindow;
    }
});

test('ArrangementNode splits section at integer bar and preserves parameters', async () => {
    const { ArrangementNode } = await import('../src/nodes/ArrangementNode.ts');
    const arr = new ArrangementNode();
    arr.properties.total_bars = 16.0;
    arr.properties.section_points = [];
    arr.properties.section_probability = [0.8];
    arr.properties.section_quant = ['bar'];
    arr.properties.section_quant_anchor = ['end'];

    // Split at bar 8 (half and half: 8 + 8 bars)
    const struct1 = arr.splitSectionAtBar(8);
    assert.deepEqual(struct1.points, [8]);
    assert.equal(struct1.probability.length, 2);
    assert.equal(struct1.probability[0], 0.8);
    assert.equal(struct1.probability[1], 0.8);
    assert.equal(struct1.quant[0], 'bar');
    assert.equal(struct1.quant[1], 'bar');
    assert.equal(struct1.quantAnchor[0], 'end');
    assert.equal(struct1.quantAnchor[1], 'end');

    // Split second section at bar 12 (8 + 4 + 4 bars: 2:1:1 proportion)
    const struct2 = arr.splitSectionAtBar(12);
    assert.deepEqual(struct2.points, [8, 12]);
    assert.equal(struct2.probability.length, 3);
    assert.equal(struct2.quant.length, 3);

    // Merge cut at 12 (remove cutIndex 1)
    const struct3 = arr.removeSectionCut(1);
    assert.deepEqual(struct3.points, [8]);
    assert.equal(struct3.probability.length, 2);
});

test('ArrangementNode adapts section cuts proportionally when total_bars changes', async () => {
    const { ArrangementNode } = await import('../src/nodes/ArrangementNode.ts');
    const arr = new ArrangementNode();
    arr.properties.total_bars = 4.0;
    arr.properties.section_points = [2.0]; // 50% / 50%

    // Changing total_bars from 4 to 16 should scale cut from 2 to 8
    arr.updateProperty('total_bars', 16.0);
    assert.equal(arr.properties.total_bars, 16.0);
    assert.deepEqual(arr.properties.section_points, [8]);
});
