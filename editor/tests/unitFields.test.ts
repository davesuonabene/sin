import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUDIO_POSITION_UNITS,
    canonicalToUnit,
    formatTimecode,
    formatUnitValue,
    parseUnitInput,
    resolveFieldUnit,
    resolveNodeUnitContext,
    setFieldUnit,
    unitToCanonical,
    type UnitConversionContext,
} from '../src/fields/UnitConverter.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';

const ctx120Bpm: UnitConversionContext = {
    durationSec: 3600, // 1 hour
    bpm: 120,
    sampleRate: 48000,
    beatsPerBar: 4,
    warpEnabled: false,
};

test('formatTimecode handles sub-hour M:SS.cc and 1h+ H:MM:SS.cc cleanly', () => {
    assert.equal(formatTimecode(0), '0:00.00');
    assert.equal(formatTimecode(5.5), '0:05.50');
    assert.equal(formatTimecode(125.75), '2:05.75');
    assert.equal(formatTimecode(3600), '1:00:00.00');
    assert.equal(formatTimecode(3661.25), '1:01:01.25');
});

test('canonicalToUnit and unitToCanonical round-trip accurately across all 8 audio units at 1e-6 precision', () => {
    // 1 hour file, 120 BPM (2 beats/sec, 0.5 bars/sec), 48 kHz
    const canonical = 0.004167; // ~15.0012 seconds on 3600s file (impossible with old 0.01 rounding!)

    const sec = canonicalToUnit(canonical, 'fraction', 's', ctx120Bpm);
    assert.ok(Math.abs(sec - 15.0012) < 1e-3);
    assert.ok(Math.abs(unitToCanonical(sec, 's', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    const ms = canonicalToUnit(canonical, 'fraction', 'ms', ctx120Bpm);
    assert.ok(Math.abs(ms - 15001.2) < 1e-1);
    assert.ok(Math.abs(unitToCanonical(ms, 'ms', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    const beats = canonicalToUnit(canonical, 'fraction', 'beats', ctx120Bpm);
    assert.ok(Math.abs(beats - 30.0024) < 1e-3);
    assert.ok(Math.abs(unitToCanonical(beats, 'beats', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    const bars = canonicalToUnit(canonical, 'fraction', 'bars', ctx120Bpm);
    assert.ok(Math.abs(bars - 7.5006) < 1e-3);
    assert.ok(Math.abs(unitToCanonical(bars, 'bars', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    const pct = canonicalToUnit(canonical, 'fraction', 'percent', ctx120Bpm);
    assert.ok(Math.abs(pct - 0.4167) < 1e-4);
    assert.ok(Math.abs(unitToCanonical(pct, 'percent', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    const frac = canonicalToUnit(canonical, 'fraction', 'fraction', ctx120Bpm);
    assert.equal(frac, canonical);
    assert.equal(unitToCanonical(frac, 'fraction', 'fraction', ctx120Bpm), canonical);

    const smp = canonicalToUnit(canonical, 'fraction', 'samples', ctx120Bpm);
    assert.equal(smp, Math.round(canonical * 3600 * 48000));
    assert.ok(Math.abs(unitToCanonical(smp, 'samples', 'fraction', ctx120Bpm) - canonical) < 1e-6);

    assert.equal(AUDIO_POSITION_UNITS.length, 8);
});

test('parseUnitInput parses timecodes, explicit unit suffixes, and plain numbers cleanly', () => {
    const shortCtx: UnitConversionContext = {
        durationSec: 10.0,
        bpm: 120,
        sampleRate: 44100,
        beatsPerBar: 4,
        warpEnabled: false,
    };

    // Timecode M:SS.cc and H:MM:SS.cc
    const p1 = parseUnitInput('0:02.50', 'time');
    assert.ok(p1);
    assert.equal(p1.unit, 'time');
    assert.ok(Math.abs(unitToCanonical(p1.value, p1.unit, 'fraction', shortCtx) - 0.25) < 1e-6);

    const pHr = parseUnitInput('0:30:00', 'time');
    assert.ok(pHr);
    assert.equal(pHr.unit, 'time');
    assert.ok(Math.abs(unitToCanonical(pHr.value, pHr.unit, 'fraction', ctx120Bpm) - 0.5) < 1e-6);

    // Inline suffix override while current unit is 's'
    const pMs = parseUnitInput('500ms', 's');
    assert.ok(pMs);
    assert.equal(pMs.unit, 'ms');
    assert.ok(Math.abs(unitToCanonical(pMs.value, pMs.unit, 'fraction', shortCtx) - 0.05) < 1e-6);

    const pBeats = parseUnitInput('4bt', 's');
    assert.ok(pBeats);
    assert.equal(pBeats.unit, 'beats');
    assert.ok(Math.abs(unitToCanonical(pBeats.value, pBeats.unit, 'fraction', shortCtx) - 0.2) < 1e-6);

    const pBars = parseUnitInput('2bars', 's');
    assert.ok(pBars);
    assert.equal(pBars.unit, 'bars');
    assert.ok(Math.abs(unitToCanonical(pBars.value, pBars.unit, 'fraction', shortCtx) - 0.4) < 1e-6);

    const pPct = parseUnitInput('75%', 's');
    assert.ok(pPct);
    assert.equal(pPct.unit, 'percent');
    assert.ok(Math.abs(unitToCanonical(pPct.value, pPct.unit, 'fraction', shortCtx) - 0.75) < 1e-6);

    const pSmp = parseUnitInput('44100smp', 's');
    assert.ok(pSmp);
    assert.equal(pSmp.unit, 'samples');
    assert.ok(Math.abs(unitToCanonical(pSmp.value, pSmp.unit, 'fraction', shortCtx) - 0.1) < 1e-6);

    // Formatted time display matches expectations
    assert.equal(formatUnitValue(2.5, 'time'), '0:02.50');
});

test('resolveFieldUnit auto-defaults to time/beats based on Warp state and setFieldUnit syncs unitGroup', () => {
    const sample = new SampleNode();
    sample.properties.duration_seconds = 8.0;
    sample.updateProperty('warp', false);

    const cropStartField = SampleNode.fields.find(f => f.key === 'crop_start')!;
    const cropEndField = SampleNode.fields.find(f => f.key === 'crop_end')!;

    // Warp OFF auto-defaults to 'time'
    const ctxOff = resolveNodeUnitContext(sample);
    assert.equal(ctxOff.warpEnabled, false);
    assert.equal(resolveFieldUnit(sample, cropStartField.key, cropStartField.unitConfig!, ctxOff), 'time');
    assert.equal(resolveFieldUnit(sample, cropEndField.key, cropEndField.unitConfig!, ctxOff), 'time');

    // Warp ON auto-defaults to 'beats' until manually overridden
    sample.updateProperty('warp', true);
    const ctxOn = resolveNodeUnitContext(sample);
    assert.equal(resolveFieldUnit(sample, cropStartField.key, cropStartField.unitConfig!, ctxOn), 'beats');
    assert.equal(resolveFieldUnit(sample, cropEndField.key, cropEndField.unitConfig!, ctxOn), 'beats');

    // Manual override on one crop field syncs the entire 'crop' unitGroup and persists across Warp flips
    setFieldUnit(sample, cropStartField.key, cropStartField.unitConfig!, 'ms');
    assert.equal(resolveFieldUnit(sample, cropStartField.key, cropStartField.unitConfig!, ctxOn), 'ms');
    assert.equal(resolveFieldUnit(sample, cropEndField.key, cropEndField.unitConfig!, ctxOn), 'ms');

    sample.updateProperty('warp', false);
    const ctxOffAgain = resolveNodeUnitContext(sample);
    assert.equal(resolveFieldUnit(sample, cropEndField.key, cropEndField.unitConfig!, ctxOffAgain), 'ms');
});
