import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SectionRendererFactory } from '../src/ui/SectionRendererFactory.ts';

test('SampleNode fields define radio buttons for options < 4 and numeric types without sliders', () => {
    const fields = SampleNode.fields;
    const byKey = new Map(fields.map(f => [f.key, f]));

    const sampleType = byKey.get('sample_type');
    assert.equal(sampleType?.type, 'radio');
    assert.equal(sampleType?.options?.length, 2);

    const keyMatchAlgo = byKey.get('key_match_algorithm');
    assert.equal(keyMatchAlgo?.type, 'radio');
    assert.equal(keyMatchAlgo?.options?.length, 3);

    const stretchMode = byKey.get('stretch_mode');
    assert.equal(stretchMode?.type, 'radio');
    assert.equal(stretchMode?.options?.length, 2);

    const stretchAlgo = byKey.get('stretch_algorithm');
    assert.equal(stretchAlgo?.type, 'radio');
    assert.equal(stretchAlgo?.options?.length, 3);

    const transpose = byKey.get('transpose');
    assert.equal(transpose?.type, 'int');

    const cents = byKey.get('cents');
    assert.equal(cents?.type, 'int');
});

test('SampleNode prepareSerializedModel sets original_bpm to null for one_shot with default 120 bpm', () => {
    const node = new SampleNode();
    node.properties.sample_type = 'one_shot';
    node.properties.original_bpm = 120;

    const serialized = node.prepareSerializedModel({ ...node.properties });
    assert.equal(serialized.sample_type, 'one_shot');
    assert.equal(serialized.original_bpm, null);
});

test('SampleNode syncMetadataFromLibrary adopts one_shot and clears default BPM', async () => {
    const node = new SampleNode();
    node.properties.filepath = '/mock/kick.wav';

    await node.syncMetadataFromLibrary([{
        absolute_path: '/mock/kick.wav',
        name: 'kick.wav',
        is_loop: false,
        bpm: null
    }]);

    assert.equal(node.properties.sample_type, 'one_shot');
    assert.equal(node.properties.original_bpm, null);
});

test('SectionRendererFactory.updateNodeFieldStates greys out BPM fields for one_shot without hiding them', () => {
    const makeRow = (fieldKey: string) => ({
        style: { display: '', opacity: '', pointerEvents: '', filter: '' },
        getAttribute: (attr: string) => (attr === 'aria-disabled' ? this_disabled : null),
        setAttribute: (attr: string, val: string) => { if (attr === 'aria-disabled') this_disabled = val; },
        querySelectorAll: () => []
    });
    let this_disabled = 'false';

    const origRow: any = { style: { display: 'none' }, setAttribute(a: string, v: string) { this[a] = v; }, querySelectorAll: () => [] };
    const tgtRow: any = { style: { display: 'none' }, setAttribute(a: string, v: string) { this[a] = v; }, querySelectorAll: () => [] };
    const algoRow: any = { style: { display: 'none' }, setAttribute(a: string, v: string) { this[a] = v; }, querySelectorAll: () => [] };

    const mockContainer: any = {
        querySelector: (sel: string) => {
            if (sel.includes('original_bpm')) return origRow;
            if (sel.includes('target_bpm')) return tgtRow;
            if (sel.includes('key_match_algorithm')) return algoRow;
            return null;
        }
    };

    const node = new SampleNode();
    node.properties.sample_type = 'one_shot';
    node.properties.key_match_mode = 'off';

    // In a test without real DOM Element, call setRowDisabled directly or via mock
    (SectionRendererFactory as any).updateNodeFieldStates(mockContainer, node);

    assert.equal(origRow.style.display, '');
    assert.equal(origRow['aria-disabled'], 'true');
    assert.equal(origRow.style.pointerEvents, 'none');

    assert.equal(tgtRow.style.display, '');
    assert.equal(tgtRow['aria-disabled'], 'true');

    assert.equal(algoRow.style.display, '');
    assert.equal(algoRow['aria-disabled'], 'true');
});

