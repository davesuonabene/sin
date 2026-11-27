import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SectionRendererFactory } from '../src/ui/SectionRendererFactory.ts';
import { WidgetFactory } from '../src/ui/WidgetFactory.ts';
import { formatDynamicRulerTime } from '../src/ui/WaveformVisualizer.ts';

test('SampleNode fields declare Asset call, Crop tuple, orthogonal Repeat & Warp radios, and omit crop_length & start_beat', () => {
    const fields = SampleNode.fields;
    const byKey = new Map(fields.map(f => [f.key, f]));

    const assetField = byKey.get('pool_query');
    assert.equal(assetField?.type, 'asset_call');
    assert.equal(assetField?.label, 'Asset');

    const cropTuple = byKey.get('crop');
    assert.equal(cropTuple?.type, 'tuple');
    assert.equal(cropTuple?.label, 'Crop');
    assert.deepEqual(cropTuple?.subFields, ['crop_start', 'crop_end']);
    assert.equal(cropTuple?.unitConfig?.unitGroup, 'crop');

    const firstFieldsSection = SampleNode.panelSchema.tabs[0].sections[1];
    assert.equal(firstFieldsSection.type, 'fields');
    assert.deepEqual(firstFieldsSection.fields, ['pool_query', 'crop', 'repeat', 'warp']);

    const repeat = byKey.get('repeat');
    assert.equal(repeat?.type, 'radio');
    assert.equal(repeat?.options?.length, 2);

    const warp = byKey.get('warp');
    assert.equal(warp?.type, 'radio');
    assert.equal(warp?.options?.length, 2);

    const cropStart = byKey.get('crop_start');
    const cropEnd = byKey.get('crop_end');
    assert.equal(cropStart?.type, 'unit_float');
    assert.equal(cropEnd?.type, 'unit_float');
    assert.equal(cropStart?.unitConfig?.unitGroup, 'crop');
    assert.equal(cropEnd?.unitConfig?.unitGroup, 'crop');
    assert.equal(byKey.has('crop_length'), false);

    // start_beat is timeline-only and must not clutter SampleNode Inspector fields
    assert.equal(byKey.has('start_beat'), false);

    const keyMatchAlgo = byKey.get('key_match_algorithm');
    assert.equal(keyMatchAlgo?.type, 'radio');
    assert.equal(keyMatchAlgo?.options?.length, 3);

    const stretchAlgo = byKey.get('stretch_algorithm');
    assert.equal(stretchAlgo?.type, 'radio');
    assert.equal(stretchAlgo?.options?.length, 3);

    const transpose = byKey.get('transpose');
    assert.equal(transpose?.type, 'int');

    const cents = byKey.get('cents');
    assert.equal(cents?.type, 'int');
});

test('SampleNode.inferLoadDefaults follows smart defaults for loops, one-shots, long files, and BPM-tagged clips', () => {
    // Explicit GAIA loop -> Repeat ON, Warp ON
    assert.deepEqual(
        SampleNode.inferLoadDefaults({ is_loop: true, duration_seconds: 4.0, bpm: 120 }),
        { repeat: true, warp: true, sample_type: 'loop', stretch_mode: 'time_stretch' }
    );
    // Explicit one-shot -> Repeat OFF, Warp OFF
    assert.deepEqual(
        SampleNode.inferLoadDefaults({ is_loop: false, duration_seconds: 0.6, bpm: 120 }),
        { repeat: false, warp: false, sample_type: 'one_shot', stretch_mode: 'pitch_shift' }
    );
    // Long recording (>30s) without explicit loop tag -> Repeat OFF, Warp OFF
    assert.deepEqual(
        SampleNode.inferLoadDefaults({ duration_seconds: 3600, bpm: 124 }),
        { repeat: false, warp: false, sample_type: 'one_shot', stretch_mode: 'pitch_shift' }
    );
    // Short untagged file (<=30s) with detected BPM -> Repeat OFF, Warp ON
    assert.deepEqual(
        SampleNode.inferLoadDefaults({ duration_seconds: 8.0, filepath: 'vocal_phrase_128bpm.wav' }),
        { repeat: false, warp: true, sample_type: 'one_shot', stretch_mode: 'time_stretch' }
    );
    // Short untagged file with no BPM -> Repeat OFF, Warp OFF
    assert.deepEqual(
        SampleNode.inferLoadDefaults({ duration_seconds: 2.5, filepath: 'foley_click.wav' }),
        { repeat: false, warp: false, sample_type: 'one_shot', stretch_mode: 'pitch_shift' }
    );
});

test('SampleNode.onConfigure migrates legacy sample_type and stretch_mode into orthogonal repeat and warp', () => {
    const legacyLoop = new SampleNode();
    legacyLoop.onConfigure({
        properties: { sample_type: 'loop', stretch_mode: 'time_stretch', original_bpm: 125 },
    });
    assert.equal(legacyLoop.properties.repeat, true);
    assert.equal(legacyLoop.properties.warp, true);

    const legacyTapeLoop = new SampleNode();
    legacyTapeLoop.onConfigure({
        properties: { sample_type: 'loop', stretch_mode: 'pitch_shift', original_bpm: 120 },
    });
    assert.equal(legacyTapeLoop.properties.repeat, true);
    assert.equal(legacyTapeLoop.properties.warp, false);

    const legacyOneShot = new SampleNode();
    legacyOneShot.onConfigure({
        properties: { sample_type: 'one_shot', stretch_mode: 'time_stretch' },
    });
    assert.equal(legacyOneShot.properties.repeat, false);
    assert.equal(legacyOneShot.properties.warp, false);
});

test('SampleNode prepareSerializedModel sets original_bpm to null for unwarped one_shot with default 120 bpm', () => {
    const node = new SampleNode();
    node.updateProperty('repeat', false);
    node.updateProperty('warp', false);
    node.properties.original_bpm = 120;

    const serialized = node.prepareSerializedModel({ ...node.properties });
    assert.equal(serialized.repeat, false);
    assert.equal(serialized.warp, false);
    assert.equal(serialized.sample_type, 'one_shot');
    assert.equal(serialized.stretch_mode, 'pitch_shift');
    assert.equal(serialized.original_bpm, null);
});

test('SampleNode syncMetadataFromLibrary adopts one_shot and clears default BPM', async () => {
    const node = new SampleNode();
    node.properties.filepath = '/mock/kick.wav';
    node.properties.original_bpm = 120;

    await node.syncMetadataFromLibrary([{
        absolute_path: '/mock/kick.wav',
        name: 'kick.wav',
        is_loop: false,
        bpm: null
    }]);

    assert.equal(node.properties.repeat, false);
    assert.equal(node.properties.sample_type, 'one_shot');
    assert.equal(node.properties.original_bpm, null);
});

test('SectionRendererFactory.updateNodeFieldStates greys out target_bpm and stretch_algorithm when Warp is OFF while keeping Key Match active', () => {
    const makeRow = () => ({
        style: { display: 'none', opacity: '', pointerEvents: '', filter: '' },
        attrs: {} as Record<string, string>,
        setAttribute(a: string, v: string) { this.attrs[a] = v; },
        querySelectorAll: () => []
    });

    const tgtRow = makeRow();
    const stretchAlgoRow = makeRow();
    const keyMatchModeRow = makeRow();
    const keyMatchAlgoRow = makeRow();

    const mockContainer: any = {
        querySelector: (sel: string) => {
            if (sel.includes('target_bpm')) return tgtRow;
            if (sel.includes('stretch_algorithm')) return stretchAlgoRow;
            if (sel.includes('key_match_mode')) return keyMatchModeRow;
            if (sel.includes('key_match_algorithm')) return keyMatchAlgoRow;
            return null;
        }
    };

    const node = new SampleNode();
    node.updateProperty('warp', false);
    node.updateProperty('key_match_mode', 'follow');

    (SectionRendererFactory as any).updateNodeFieldStates(mockContainer, node);

    assert.equal(tgtRow.style.display, '');
    assert.equal(tgtRow.attrs['aria-disabled'], 'true');
    assert.equal(tgtRow.style.pointerEvents, 'none');

    assert.equal(stretchAlgoRow.style.display, '');
    assert.equal(stretchAlgoRow.attrs['aria-disabled'], 'true');

    // Key Match remains ACTIVE even when Warp is OFF (Tape repitch!)
    assert.equal(keyMatchAlgoRow.style.display, '');
    assert.equal(keyMatchAlgoRow.attrs['aria-disabled'], 'false');

    // Enabling Warp re-enables target_bpm and stretch_algorithm
    node.updateProperty('warp', true);
    node.updateProperty('key_match_mode', 'off');
    (SectionRendererFactory as any).updateNodeFieldStates(mockContainer, node);

    assert.equal(tgtRow.attrs['aria-disabled'], 'false');
    assert.equal(stretchAlgoRow.attrs['aria-disabled'], 'false');
    assert.equal(keyMatchAlgoRow.attrs['aria-disabled'], 'true');
});

test('SampleNode renders lightweight peaks directly for 1h+ samples without needing decoded AudioBuffer', () => {
    const sample = new SampleNode();
    sample.properties.filepath = '/vault/long_live_set_60min.wav';
    sample.properties.duration_seconds = 3600;
    sample.loadedFilepath = sample.properties.filepath;
    const peaks = new Float32Array([-0.3, 0.35, -0.5, 0.55, -0.2, 0.25]);
    sample.audioPeaks = peaks;
    sample.loadedPeaksFilepath = sample.properties.filepath;

    const sig = sample.resolveVisualizationSignal();
    assert.equal(sig.buffer, undefined);
    assert.ok(sig.peaks instanceof Float32Array);
    assert.equal(sig.peaks?.length, 6);
    assert.equal(sig.duration, 3600);
    assert.equal(sig.isLoading, false);
});

test('BaseNode dual static/dynamic storage preserves dynamic expression and restores static fallback on toggle', () => {
    const sample = new SampleNode();
    const transposeField = SampleNode.fields.find(f => f.key === 'transpose')!;

    // Start static at 5
    sample.updateProperty('transpose', 5);
    assert.equal(sample.isFieldDynamicActive('transpose'), false);

    // Toggle ON -> captures static fallback (5)
    const onEmpty = sample.toggleFieldDynamic('transpose', true, transposeField);
    assert.equal(onEmpty.active, true);
    assert.equal(sample.getStaticFieldValue('transpose'), 5);

    // Apply dynamic expression "7 12" -> evaluates to 7 (trigger 0)
    sample.applyFieldOperator('transpose', '7 12', transposeField);
    assert.equal(sample.properties.transpose, 7);
    assert.equal(sample.getSavedDynamicExpression('transpose'), '7 12');
    assert.equal(sample.hasFieldOperator('transpose'), true);

    // Toggle OFF -> restores static fallback (5), keeps "7 12" stored for display (greyed out)
    const offRes = sample.toggleFieldDynamic('transpose', false, transposeField);
    assert.equal(offRes.active, false);
    assert.equal(sample.properties.transpose, 5);
    assert.equal(sample.hasFieldOperator('transpose'), false);
    assert.equal(sample.getSavedDynamicExpression('transpose'), '7 12');

    // Toggle ON again -> re-applies saved "7 12" expression
    const onAgain = sample.toggleFieldDynamic('transpose', true, transposeField);
    assert.equal(onAgain.active, true);
    assert.equal(sample.properties.transpose, 7);
    assert.equal(sample.hasFieldOperator('transpose'), true);

    // When no static value was previously set, toggling OFF inherits last dynamic value
    const fresh = new SampleNode();
    fresh.properties.field_operators = { transpose: '3 9' };
    fresh.properties.transpose = 3;
    fresh.toggleFieldDynamic('transpose', false, transposeField);
    assert.equal(fresh.properties.transpose, 3);
    assert.equal(fresh.getStaticFieldValue('transpose'), 3);
    assert.equal(fresh.getSavedDynamicExpression('transpose'), '3 9');
});

test('SampleNode pool_query dual static/dynamic toggle restores static asset call and preserves dynamic expression', () => {
    const sample = new SampleNode();
    sample.properties.selected_items = [
        { id: 1, name: 'kick', filepath: '/vault/kick.wav', absolute_path: '/vault/kick.wav' },
        { id: 2, name: 'snare', filepath: '/vault/snare.wav', absolute_path: '/vault/snare.wav' },
    ];

    // Static asset call
    sample.applyPoolQuery('kick', false);
    assert.equal(sample.properties.filepath, '/vault/kick.wav');
    assert.equal(sample.isFieldDynamicActive('pool_query'), false);
    assert.equal(sample.getStaticFieldValue('pool_query'), 'kick');

    // Apply dynamic expression "snare kick"
    sample.applyPoolQuery('snare kick', false);
    assert.equal(sample.properties.filepath, '/vault/snare.wav');
    assert.equal(sample.isFieldDynamicActive('pool_query'), true);
    assert.equal(sample.getSavedDynamicExpression('pool_query'), 'snare kick');

    // Toggle OFF -> falls back to previous static "kick", retains "snare kick" greyed out
    sample.toggleFieldDynamic('pool_query', false);
    assert.equal(sample.isFieldDynamicActive('pool_query'), false);
    assert.equal(sample.properties.pool_query, 'kick');
    assert.equal(sample.properties.filepath, '/vault/kick.wav');
    assert.equal(sample.getSavedDynamicExpression('pool_query'), 'snare kick');

    // Toggle ON -> restores "snare kick"
    sample.toggleFieldDynamic('pool_query', true);
    assert.equal(sample.isFieldDynamicActive('pool_query'), true);
    assert.equal(sample.properties.pool_query, 'snare kick');
    assert.equal(sample.properties.filepath, '/vault/snare.wav');

    // Filenames containing spaces are NOT misclassified as dynamic when toggling off
    const spaced = new SampleNode();
    spaced.properties.filepath = '/vault/My Live Recording 01.wav';
    spaced.properties.pool_query = 'My Live Recording 01';
    assert.equal(spaced.isFieldDynamicActive('pool_query'), false);
    spaced.toggleFieldDynamic('pool_query', true, undefined, { currentStaticFallback: 'My Live Recording 01', currentResolvedValue: 'My Live Recording 01' });
    assert.equal(spaced.isFieldDynamicActive('pool_query'), true);
    spaced.toggleFieldDynamic('pool_query', false, undefined, { currentResolvedValue: 'My Live Recording 01' });
    assert.equal(spaced.isFieldDynamicActive('pool_query'), false);
    assert.equal(spaced.properties.pool_query, 'My Live Recording 01');
});

test('WidgetFactory.isFieldDynamicAllowed enables dynamic drawers for dynamic-capable fields and excludes metadata/export fields', () => {
    const byKey = new Map(SampleNode.fields.map(f => [f.key, f]));
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('pool_query')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('crop')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('crop_start')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('crop_end')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('repeat')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('warp')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('transpose')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('target_bpm')!), true);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('stretch_algorithm')!), true);

    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('node_name')!), false);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('filepath')!), false);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('original_bpm')!), false);
    assert.equal(WidgetFactory.isFieldDynamicAllowed(byKey.get('key')!), false);
});

test('formatDynamicRulerTime formats adaptive ms, seconds, minutes, and hours cleanly without bar counts', () => {
    assert.equal(formatDynamicRulerTime(0.25, 0.05, 0.5, 0.5), '250ms');
    assert.equal(formatDynamicRulerTime(2.5, 0.5, 10, 10), '2.5s');
    assert.equal(formatDynamicRulerTime(15, 5, 45, 45), '15s');
    assert.equal(formatDynamicRulerTime(125, 30, 300, 300), '2:05');
    assert.equal(formatDynamicRulerTime(3665, 300, 7200, 7200), '1:01:05');
    assert.equal(formatDynamicRulerTime(3600, 3600, 7200, 7200), '1h');
});
