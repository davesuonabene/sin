import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WidgetFactory } from '../src/ui/WidgetFactory.ts';
import { normalizeTrackTotalBars, parseTrackKeyParts } from '../src/ui/TrackPropertiesWindow.ts';

test('parseTrackKeyParts distinguishes sharps/flats and major/minor without prefix collision', () => {
    assert.deepEqual(parseTrackKeyParts('C'), { root: 'C', isMinor: false });
    assert.deepEqual(parseTrackKeyParts('C#'), { root: 'C#', isMinor: false });
    assert.deepEqual(parseTrackKeyParts('C#m'), { root: 'C#', isMinor: true });
    assert.deepEqual(parseTrackKeyParts('Cmaj'), { root: 'C', isMinor: false });
    assert.deepEqual(parseTrackKeyParts('Dbm'), { root: 'C#', isMinor: true });
    assert.deepEqual(parseTrackKeyParts('F#min'), { root: 'F#', isMinor: true });
    assert.deepEqual(parseTrackKeyParts('Bb'), { root: 'Bb', isMinor: false });
    assert.deepEqual(parseTrackKeyParts(''), { root: 'C', isMinor: false });
});

test('normalizeTrackTotalBars handles Free (-1) transitions and positive clamping', () => {
    assert.equal(normalizeTrackTotalBars(-1, 4), -1);
    assert.equal(normalizeTrackTotalBars(0, 4), -1);
    assert.equal(normalizeTrackTotalBars(-0.5, -1), 1);
    assert.equal(normalizeTrackTotalBars(0, -1), 1);
    assert.equal(normalizeTrackTotalBars(-1, -1), -1);
    assert.equal(normalizeTrackTotalBars(0.1, 4), 0.25);
    assert.equal(normalizeTrackTotalBars(8, 4), 8);
    assert.equal(normalizeTrackTotalBars(256, 4), 128);
});

test('WidgetFactory honors explicit dynamic: false for standard non-dynamic fields', () => {
    assert.equal(WidgetFactory.isFieldDynamicAllowed({
        key: 'bpm',
        label: 'Tempo',
        type: 'float',
        default: 120,
        dynamic: false,
    }), false);
    assert.equal(WidgetFactory.isFieldDynamicAllowed({
        key: 'wait_for_fx',
        label: 'Wait for FX',
        type: 'boolean',
        default: false,
        dynamic: false,
    }), false);
    assert.equal(WidgetFactory.isFieldDynamicAllowed({
        key: 'key_mode',
        label: 'Scale',
        type: 'radio',
        default: 'maj',
        dynamic: false,
    }), false);
});

test('Graph canvas pan keeps current node panel open and only simple background click switches to Track Parameters', () => {
    const mainSrc = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');

    // Regression guard: unconditional canvas click listener that hijacked pans into Track Parameters must not exist
    assert.equal(
        /canvas\.addEventListener\('click',\s*\(\)\s*=>\s*\{[\s\S]*?openTrackParamWindow\(\)/.test(mainSrc),
        false,
        'Canvas must not attach an unconditional click listener calling openTrackParamWindow after drag/pan gestures'
    );

    // Drag movement is tracked during mousemove so pan gestures never count as simple clicks
    assert.ok(mainSrc.includes('lastMouseDownMoved'), 'main.ts should track drag motion across mousemove');
    assert.ok(
        mainSrc.includes('const suppressPanDeselect = isLeftButton && !isSimpleClick && !isBoxSelectRelease;'),
        'main.ts should suppress LiteGraph deselectAllNodes during any left-button drag'
    );

    // Simple click on empty background switches docked panel to Track Parameters
    const simpleClickBlockMatch = mainSrc.match(/if \(wasEmptyBg && isSimpleClick\) \{([\s\S]*?)\} else if \(isSimpleClick && mouseDownHitNode\)/);
    assert.ok(simpleClickBlockMatch, 'main.ts should handle simple clicks on empty canvas background');
    assert.ok(
        simpleClickBlockMatch[1].includes('openTrackParamWindow()'),
        'Simple click on empty background should open Track Parameters when a docked property panel is open'
    );
});

test('TrackPropertiesWindow renders standard inspector chrome and non-dynamic WidgetFactory rows', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/ui/TrackPropertiesWindow.ts'), 'utf8');
    assert.ok(src.includes('WidgetFactory.createRow'), 'TrackPropertiesWindow should render fields via WidgetFactory.createRow');
    assert.ok(src.includes('td-param-tabs'), 'TrackPropertiesWindow should include standard .td-param-tabs chrome');
    assert.ok(src.includes('td-info-table'), 'TrackPropertiesWindow should render graph overview using standard .td-info-table');
    assert.equal(src.includes('td-number-stepper'), false, 'Legacy bespoke number stepper should be removed');
    assert.equal(src.includes('background: #4f46e5'), false, 'Loud inline purple badge override should be removed');
});
