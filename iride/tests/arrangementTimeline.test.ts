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
