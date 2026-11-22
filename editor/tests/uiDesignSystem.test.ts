import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseNode } from '../src/nodes/BaseNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { ModulatorNode } from '../src/nodes/ModulatorNode.ts';
import { ICONS } from '../../packages/ui/src/icons.js';
import {
    clampSliderValue,
    normalizeSliderRatio,
    snapSliderValue,
    computeSliderFillGeometry
} from '../../packages/ui/src/slider.js';
import {
    downsamplePeakPairs,
    downsampleInterleavedPeaks,
    formatTransportTime
} from '../../packages/ui/src/waveform-scrub.js';
import * as uiBarrel from '../../packages/ui/src/index.js';

test('packages/ui barrel exports every runtime primitive required by GAIA and SIN', () => {
    const expectedKeys = [
        'ICONS',
        'renderIcon',
        'enhanceSelect',
        'enhanceAllSelects',
        'enhanceRangeSlider',
        'createAbletonSlider',
        'WaveformScrubCanvas',
        'formatTransportTime',
        'createTransportBar'
    ];
    for (const key of expectedKeys) {
        assert.ok(key in uiBarrel && (uiBarrel as Record<string, unknown>)[key] !== undefined, `Expected ${key} in packages/ui barrel export`);
    }
});

function assertValidIcons(controls: ReturnType<BaseNode['getToolbarControls']>) {
    for (const ctrl of controls) {
        if ('icon' in ctrl && ctrl.icon) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(ICONS, ctrl.icon),
                `Control "${ctrl.id}" icon "${ctrl.icon}" must exist in packages/ui/src/icons.js`
            );
        }
    }
}

test('BaseNode and node subclasses expose polymorphic toolbar controls cleanly', () => {
    const base = new BaseNode('Base');
    assert.deepEqual(base.getToolbarControls(), []);

    const sample = new SampleNode();
    const sampleCtrls = sample.getToolbarControls();
    assertValidIcons(sampleCtrls);
    assert.deepEqual(sampleCtrls.map(c => c.id), ['slots', 'sample_type', 'pool']);

    const slotCtrl = sampleCtrls.find(c => c.id === 'slots');
    assert.equal(slotCtrl?.kind, 'slot-strip');
    if (slotCtrl?.kind === 'slot-strip') {
        assert.equal(slotCtrl.count, 1);
        slotCtrl.onAdd();
        const afterAdd = sample.getToolbarControls().find(c => c.id === 'slots');
        assert.equal(afterAdd?.kind === 'slot-strip' && afterAdd.count, 2);
        if (afterAdd?.kind === 'slot-strip') {
            afterAdd.onRemove?.();
        }
        const afterRemove = sample.getToolbarControls().find(c => c.id === 'slots');
        assert.equal(afterRemove?.kind === 'slot-strip' && afterRemove.count, 1);
    }

    const sampleMode = sample.getToolbarControls().find(c => c.id === 'sample_type');
    assert.equal(sampleMode?.kind, 'segmented');
    if (sampleMode?.kind === 'segmented') {
        sampleMode.onChange('one_shot');
        assert.equal(sample.properties.sample_type, 'one_shot');
    }

    const seq = new SequenceNode();
    const seqCtrls = seq.getToolbarControls();
    assertValidIcons(seqCtrls);
    assert.deepEqual(seqCtrls.map(c => c.id), ['slots', 'play_mode', 'pool', 'save_sequence']);
    const playMode = seqCtrls.find(c => c.id === 'play_mode');
    if (playMode?.kind === 'segmented') {
        playMode.onChange('trigger');
        assert.equal(seq.properties.play_mode, 'trigger');
    }

    const arr = new ArrangementNode();
    const arrCtrls = arr.getToolbarControls();
    assertValidIcons(arrCtrls);
    assert.equal(arrCtrls[0]?.id, 'arrangement_edit');
    if (arrCtrls[0]?.kind === 'toggle') {
        assert.equal(arrCtrls[0].active, false);
        arrCtrls[0].onToggle();
        const afterToggle = arr.getToolbarControls()[0];
        assert.equal(afterToggle?.kind === 'toggle' && afterToggle.active, true);
    }

    const track = new TrackNode();
    const trackCtrls = track.getToolbarControls();
    assertValidIcons(trackCtrls);
    assert.equal(trackCtrls[0]?.id, 'mix_mode');
    if (trackCtrls[0]?.kind === 'select') {
        trackCtrls[0].onChange('first');
        assert.equal(track.properties.mix_mode, 'first');
    }

    const mod = new ModulatorNode();
    mod.properties.parentId = 42;
    const modCtrls = mod.getToolbarControls();
    assertValidIcons(modCtrls);
    assert.deepEqual(modCtrls.map(c => c.id), ['parent_node', 'delete_mod']);
});

test('shared Ableton slider math clamps, snaps, and computes unipolar/bipolar geometry', () => {
    assert.equal(clampSliderValue(15, 0, 10), 10);
    assert.equal(clampSliderValue(-5, 0, 10), 0);
    assert.equal(normalizeSliderRatio(5, 0, 10), 0.5);
    assert.equal(snapSliderValue(0.37, 0, 1, 0.25), 0.25);
    assert.equal(snapSliderValue(0.38, 0, 1, 0.25), 0.5);

    const uni = computeSliderFillGeometry(25, 0, 100, false);
    assert.equal(uni.isBipolar, false);
    assert.equal(uni.leftPct, 0);
    assert.equal(uni.widthPct, 25);
    assert.equal(uni.headPct, 25);

    const biPos = computeSliderFillGeometry(6, -12, 12, true);
    assert.equal(biPos.isBipolar, true);
    assert.equal(biPos.zeroRatio, 0.5);
    assert.equal(biPos.leftPct, 50);
    assert.equal(biPos.widthPct, 25);
    assert.equal(biPos.headPct, 75);

    const biNeg = computeSliderFillGeometry(-6, -12, 12, true);
    assert.equal(biNeg.leftPct, 25);
    assert.equal(biNeg.widthPct, 25);
    assert.equal(biNeg.headPct, 25);
});

test('shared waveform scrub downsamples peak pairs and interleaved buffers deterministically', () => {
    const pairs = downsamplePeakPairs([[-0.2, 0.8], [-0.5, 0.1], [0.4, 0.9], [-1.2, 0.3]], 2);
    assert.equal(pairs.length, 2);
    assert.ok(Math.abs(pairs[0] - 0.8) < 1e-6);
    assert.equal(pairs[1], 1);

    const flat = downsampleInterleavedPeaks([-0.2, 0.4, 0.9, -0.1], 1);
    assert.equal(flat.length, 1);
    assert.ok(Math.abs(flat[0] - 0.9) < 1e-6);

    assert.equal(formatTransportTime(0), '0:00');
    assert.equal(formatTransportTime(65), '1:05');
    assert.equal(formatTransportTime(-3), '0:00');
});
