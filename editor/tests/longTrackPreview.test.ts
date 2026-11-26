import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTransportTime, WaveformScrubCanvas } from '../../packages/ui/src/waveform-scrub.js';
import { WaveformRenderer } from '../../packages/iride/src/renderers/WaveformRenderer.ts';
import { PreampDenoiseNode } from '../src/nodes/PreampDenoiseNode.ts';
import { VoiceIsolatorNode } from '../src/nodes/VoiceIsolatorNode.ts';

test('formatTransportTime formats hours cleanly for 1h+ timelines while keeping M:SS under 1h', () => {
    assert.equal(formatTransportTime(0), '0:00');
    assert.equal(formatTransportTime(65), '1:05');
    assert.equal(formatTransportTime(3599), '59:59');
    assert.equal(formatTransportTime(3600), '1:00:00');
    assert.equal(formatTransportTime(3912), '1:05:12');
});

test('PreampDenoiseNode and VoiceIsolatorNode expose per-node precook_window_sec, ML full-cook control, and Free (-1) bar passthrough', () => {
    const preamp = new PreampDenoiseNode();
    const voice = new VoiceIsolatorNode();

    assert.equal(preamp.properties.precook_window_sec, 24.0);
    assert.equal(voice.properties.precook_window_sec, 24.0);
    assert.ok(PreampDenoiseNode.processorParamKeys.includes('precook_window_sec'));
    assert.ok(VoiceIsolatorNode.processorParamKeys.includes('precook_window_sec'));

    assert.equal(preamp.isComplexMl(), false);
    assert.equal(voice.isComplexMl(), true);
    assert.ok(voice.getToolbarControls().some((c) => c.id === 'cook_full_track'));

    voice.properties.backend = 'dsp_lite';
    assert.equal(voice.isComplexMl(), false);
    assert.ok(!voice.getToolbarControls().some((c) => c.id === 'cook_full_track'));

    // Simulate Global Bars = -1 (Free): prepareSerializedModel must strip default 4-bar truncation
    const prevGlobal = (globalThis as any).window;
    (globalThis as any).window = {
        getGlobalParameter: (k: string) => (k === 'total_bars' ? -1 : 120),
    };
    try {
        const serialized = preamp.prepareSerializedModel({ node_id: 1, total_bars: 4 });
        assert.equal(serialized.total_bars, undefined);
    } finally {
        (globalThis as any).window = prevGlobal;
    }
});

test('WaveformScrubCanvas tracks dual-color tile tiers, stale-hold, and zoom/pan viewports', () => {
    // Minimal DOM mock for headless Node test
    const listeners = new Map<string, Function>();
    const fakeCanvas: any = {
        className: '',
        tabIndex: 0,
        width: 0,
        height: 0,
        setAttribute() {},
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 32 }),
        addEventListener: (ev: string, fn: Function) => listeners.set(ev, fn),
        removeEventListener: (ev: string) => listeners.delete(ev),
        remove() {},
    };
    const prevDoc = (globalThis as any).document;
    (globalThis as any).document = { createElement: () => fakeCanvas };
    try {
        const container: any = { appendChild() {} };
        const scrub = new WaveformScrubCanvas(container, { enableZoom: true });
        const rawPeaks = new Array(200).fill(0).map((_, i) => (i % 2 === 0 ? -0.2 : 0.2));
        scrub.setInterleavedPeaks(rawPeaks, 3600, { tiers: new Array(100).fill(0) });

        // Apply Fast DSP tile (0..360s) and Complex ML tile (360..720s)
        scrub.applyTileDelta({ startSec: 0, endSec: 360, tier: 1, peaks: [-0.5, 0.5] });
        scrub.applyTileDelta({ startSec: 360, endSec: 720, tier: 2, peaks: [-0.8, 0.8] });

        assert.equal(scrub.tierStates[2], 1);
        assert.equal(scrub.tierStates[12], 2);
        assert.equal(scrub.tierStates[50], 0);
        assert.ok(Math.abs(scrub.interleavedPeaks[2 * 2 + 1] - 0.5) < 1e-4);

        // Mark stale -> cooked columns flip to 3 (amber), raw stays 0
        scrub.markAllTiersStale();
        assert.equal(scrub.tierStates[2], 3);
        assert.equal(scrub.tierStates[12], 3);
        assert.equal(scrub.tierStates[50], 0);

        // Zoom viewport clamping and reset
        scrub._setViewport(1200, 60);
        const vp = scrub.getViewport();
        assert.equal(vp.startSec, 1200);
        assert.equal(vp.endSec, 1260);
        assert.ok(vp.zoom > 50);

        scrub.resetZoom();
        assert.equal(scrub.getViewport().zoom, 1);
        scrub.destroy();
    } finally {
        (globalThis as any).document = prevDoc;
    }
});

test('WaveformScrubCanvas preserves early tile_update coverage before master_peaks arrives and draws dual-color rail', () => {
    const fillRectCalls: Array<{ style: string; x: number; y: number; w: number; h: number }> = [];
    const mockCtx: any = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        save() {},
        restore() {},
        scale() {},
        fillRect(x: number, y: number, w: number, h: number) {
            fillRectCalls.push({ style: String(this.fillStyle), x, y, w, h });
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        setLineDash() {},
        closePath() {},
        fill() {},
        strokeRect() {},
        fillText() {},
        measureText: () => ({ width: 24 }),
    };
    const fakeCanvas: any = {
        className: '',
        tabIndex: 0,
        width: 0,
        height: 0,
        setAttribute() {},
        getContext: () => mockCtx,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 32 }),
        addEventListener() {},
        removeEventListener() {},
        remove() {},
    };
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    (globalThis as any).document = { createElement: () => fakeCanvas };
    (globalThis as any).window = { devicePixelRatio: 1 };
    try {
        const scrub = new WaveformScrubCanvas({ appendChild() {} }, { enableZoom: true });

        // 1. Tile update arrives BEFORE master_peaks (common on RAM/disk tile cache hits!)
        scrub.applyTileDelta({ startSec: 0, endSec: 16, durationSec: 64, tier: 2, peaks: [-0.02, 0.02] });
        assert.equal(scrub.duration, 64);
        assert.equal(scrub.hasCoverage, true);
        assert.equal(scrub.coverageSlots[0], 2);
        assert.equal(scrub.coverageSlots[200], 0);
        // Must draw violet dual-color rail immediately in progress mode even before master_peaks!
        assert.ok(fillRectCalls.some((c) => c.style === '#8b5cf6' && c.h === 4));

        // 2. Stage-1 master_peaks arrives later WITHOUT explicit tiers -> must reconstruct tierStates from coverageSlots!
        fillRectCalls.length = 0;
        const rawPeaks = new Array(200).fill(0).map((_, i) => (i % 2 === 0 ? -0.3 : 0.3));
        scrub.setInterleavedPeaks(rawPeaks, 64);
        assert.ok(scrub.tierStates !== null);
        assert.equal(scrub.tierStates[0], 2);
        assert.equal(scrub.tierStates[80], 0);
        // Must paint violet translucent band + crisp 4px violet rail + slate uncooked rail!
        assert.ok(fillRectCalls.some((c) => c.style === '#8b5cf6' && c.h === 4));
        assert.ok(fillRectCalls.some((c) => c.style.includes('139, 92, 246')));

        // 3. Bypass clearAll resets coverage cleanly
        scrub.applyTileDelta({ startSec: 0, endSec: 0, clearAll: true });
        assert.equal(scrub.hasCoverage, false);
        assert.equal(scrub.tierStates, null);
        scrub.destroy();
    } finally {
        (globalThis as any).document = prevDoc;
        (globalThis as any).window = prevWin;
    }
});

test('WaveformRenderer downsamples 1h+ waveforms cleanly and draws loading/cooking spinner overlays', () => {
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    const arcs: Array<{ cx: number; cy: number; r: number }> = [];
    const texts: string[] = [];
    const ctx: any = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        font: '',
        textAlign: '',
        textBaseline: '',
        save() {},
        restore() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        closePath() {},
        clip() {},
        stroke() {},
        fill() {},
        fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }); },
        arc(cx: number, cy: number, r: number) { arcs.push({ cx, cy, r }); },
        fillText(t: string) { texts.push(String(t)); },
        measureText: (t: string) => ({ width: String(t).length * 5 }),
    };

    const renderer = new WaveformRenderer();
    const bounds = { x: 0, y: 0, width: 180, height: 48 };

    // 1. Unloaded node with isLoading -> centered spinner + label, zero waveform bars
    renderer.setSignal({ duration: 3600, isLoading: true, loadingLabel: 'Cooking · Dry' });
    renderer.render(ctx, bounds, { time: 0, duration: 3600, beat: 0, bar: 0, step: 0, isPlaying: true });
    assert.ok(arcs.length >= 2);
    assert.ok(texts.includes('Cooking · Dry'));

    // 2. Full 1h track (512 peaks on 180px box) -> cleanly downsampled to <= 180 crisp ~1px columns (NOT 6 giant blocks!)
    rects.length = 0;
    arcs.length = 0;
    texts.length = 0;
    const peaks512 = new Float32Array(1024);
    for (let i = 0; i < 512; i++) {
        peaks512[i * 2] = -0.35;
        peaks512[i * 2 + 1] = 0.35;
    }
    renderer.setSignal({ peaks: peaks512, duration: 3600, isLoading: true, loadingLabel: 'Precook 45%' });
    renderer.render(ctx, bounds, { time: 100, duration: 3600, beat: 0, bar: 0, step: 0, isPlaying: true });
    // 180 crisp 1px waveform bars (+ 1 frosted backdrop rect) — never fat 30px blocks!
    const waveBars = rects.filter((r) => r.w <= 2 && r.h > 4);
    assert.equal(waveBars.length, 180);
    assert.ok(arcs.length >= 2);
    assert.ok(texts.includes('Precook 45%'));

    // 3. AudioProcessorNode exposes loading state during cooking_bypassed and clears on ready/bypass
    const voice = new VoiceIsolatorNode();
    voice.applyProcessorStatus({ state: 'cooking_bypassed', progress: 0.3, phase: 'precooking window' });
    const sigCooking = voice.resolveVisualizationSignal();
    assert.equal(sigCooking.isLoading, true);
    assert.ok(String(sigCooking.loadingLabel || '').includes('30%'));

    voice.applyProcessorStatus({ state: 'ready', progress: 1.0, phase: 'ready' });
    assert.equal(voice.resolveVisualizationSignal().isLoading, false);

    voice.applyProcessorStatus({ state: 'cooking_bypassed', progress: 0.2 });
    voice.properties.bypass = true;
    assert.equal(voice.resolveVisualizationSignal().isLoading, false);
});
