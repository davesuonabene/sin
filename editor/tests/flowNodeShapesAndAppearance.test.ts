import assert from 'node:assert/strict';
import test from 'node:test';

import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { DisabledNode } from '../src/nodes/DisabledNode.ts';
import { ModulatorNode } from '../src/nodes/ModulatorNode.ts';
import {
    traceNodeShape
} from '../src/nodes/NodeVisuals.ts';
import {
    CLIP_FILL_COLOR,
    CLIP_MARKER_COLOR,
    drawHeaderRmsMeter,
    drawIconRmsFill,
    drawRadialLoopProgress,
    getQuantizedRmsColor,
    getQuantizedRmsHeaderStyle,
    rmsToMeterLevel,
    sampleBufferMeterLevels
} from '../../packages/iride/src/index.ts';
import { SectionRendererFactory } from '../src/ui/SectionRendererFactory.ts';

// Minimal DOM stub for headless test environment
if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = {
        createElement: (tag: string) => {
            const children: any[] = [];
            const listeners: Record<string, Function[]> = {};
            const element: any = {
                tagName: tag.toUpperCase(),
                className: '',
                dataset: {},
                textContent: '',
                value: '',
                style: {},
                children,
                setAttribute: (name: string, val: string) => { element[name] = val; },
                appendChild: (child: any) => { children.push(child); return child; },
                addEventListener: (event: string, fn: Function) => {
                    if (!listeners[event]) listeners[event] = [];
                    listeners[event].push(fn);
                },
                dispatchEvent: (event: { type: string }) => {
                    const fns = listeners[event.type] || [];
                    for (const fn of fns) fn(event);
                },
                querySelector: (_sel: string) => null,
                querySelectorAll: (_sel: string) => []
            };
            return element;
        }
    };
}

test('Signal Flow Node Shapes: calculates source, through, sink, and isolated shapes based on logical hierarchy', () => {
    // 1. SampleNode is an audio generator/source: outputs audio, no inputs
    const sample = new SampleNode();
    assert.equal(sample.nodeShape, 'source', 'SampleNode must have "source" shape (flat left, curved right)');
    assert.equal(sample.getDefaultShape(), 'source');

    // 2. SequenceNode is an intermediate processor: inputs audio from Sample, outputs audio downstream
    const sequence = new SequenceNode();
    assert.equal(sequence.nodeShape, 'through', 'SequenceNode must have "through" shape (curved left, curved right)');
    assert.equal(sequence.getDefaultShape(), 'through');

    // 3. Regular TrackNode is an intermediate submix/bus
    const track = new TrackNode();
    assert.equal(track.nodeShape, 'through', 'Standard TrackNode must have "through" shape');

    // 4. Master TrackNode (role: "master" or name: "Master Output") is the terminal sink
    const masterTrack = new TrackNode();
    masterTrack.properties.role = 'master';
    assert.equal(masterTrack.nodeShape, 'sink', 'Master TrackNode must have "sink" shape (curved left, flat right)');

    const masterByName = new TrackNode();
    masterByName.properties.node_name = 'Master Output';
    assert.equal(masterByName.nodeShape, 'sink', 'Track named Master Output must have "sink" shape');

    // 5. ArrangementNode coordinates timeline blocks into downstream master
    const arrangement = new ArrangementNode();
    assert.equal(arrangement.nodeShape, 'through', 'ArrangementNode must have "through" shape');

    // 6. DisabledNode has no active signal flow
    const disabled = new DisabledNode();
    assert.equal(disabled.nodeShape, 'isolated', 'DisabledNode must have "isolated" shape');

    // 7. Modifiers (ModulatorNode, etc.) are attached satellite nodes
    const modulator = new ModulatorNode();
    assert.equal(modulator.nodeShape, 'isolated', 'Modifier nodes calculate "isolated" shape');
});

test('Unified Icon Dimensions: all node types have identical 44x44 icon dimensions and bodySize', () => {
    const nodes = [
        new SampleNode(),
        new SequenceNode(),
        new TrackNode(),
        new ArrangementNode(),
        new DisabledNode(),
        new ModulatorNode()
    ];

    for (const node of nodes) {
        assert.equal(node.nodeBodySize, 44, `${node.constructor.name} must have nodeBodySize === 44`);
        assert.equal(node.getBodySize(), 44, `${node.constructor.name} must have getBodySize() === 44`);
        node.properties.visualization_enabled = false;
        assert.deepEqual(Array.from(node.computeSize()), [44, 44], `${node.constructor.name} icon computeSize() must be [44, 44]`);
    }
});

test('NodeVisuals: traceNodeShape draws flow curves for iconed and expanded borders', () => {
    const mockCtx = () => {
        const commands: string[] = [];
        return {
            commands,
            beginPath: () => commands.push('beginPath'),
            closePath: () => commands.push('closePath'),
            moveTo: (x: number, y: number) => commands.push(`moveTo(${x},${y})`),
            lineTo: (x: number, y: number) => commands.push(`lineTo(${x},${y})`),
            arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => commands.push(`arcTo(${x1},${y1},${x2},${y2},${r})`),
            arc: (cx: number, cy: number, r: number, sa: number, ea: number) => commands.push(`arc(${cx},${cy},${r},${sa},${ea})`),
            rect: (x: number, y: number, w: number, h: number) => commands.push(`rect(${x},${y},${w},${h})`)
        } as any;
    };

    // Icon mode (square 44x44) - Source: curved left (r=22), straight right (r=4)
    const ctxIcon = mockCtx();
    traceNodeShape(ctxIcon, 'source', 0, 0, 44, 44);
    assert.ok(ctxIcon.commands.includes('beginPath'));
    assert.ok(ctxIcon.commands.includes('closePath'));
    const sourceArcs = ctxIcon.commands.filter((c: string) => c.startsWith('arcTo'));
    assert.equal(sourceArcs.length, 4);
    assert.ok(sourceArcs[0].endsWith(',4)'), 'Top-right corner of source must be straight (r=4)');
    assert.ok(sourceArcs[1].endsWith(',4)'), 'Bottom-right corner of source must be straight (r=4)');
    assert.ok(sourceArcs[2].endsWith(',22)'), 'Bottom-left corner of source must be curved (r=22)');
    assert.ok(sourceArcs[3].endsWith(',22)'), 'Top-left corner of source must be curved (r=22)');

    // Expanded mode (220x76) - Sink: straight left (r=4), curved right (r=22)
    const ctxExpanded = mockCtx();
    traceNodeShape(ctxExpanded, 'sink', 0, 0, 220, 76);
    assert.ok(ctxExpanded.commands.includes('beginPath'));
    assert.ok(ctxExpanded.commands.includes('closePath'));
    const sinkArcs = ctxExpanded.commands.filter((c: string) => c.startsWith('arcTo'));
    assert.equal(sinkArcs.length, 4);
    assert.ok(sinkArcs[0].endsWith(',22)'), 'Top-right corner of sink must be curved (r=22)');
    assert.ok(sinkArcs[1].endsWith(',22)'), 'Bottom-right corner of sink must be curved (r=22)');
    assert.ok(sinkArcs[2].endsWith(',4)'), 'Bottom-left corner of sink must be straight (r=4)');
    assert.ok(sinkArcs[3].endsWith(',4)'), 'Top-left corner of sink must be straight (r=4)');

    // Through mode: both sides straight (r=4) as signal flows through both ends
    const ctxThrough = mockCtx();
    traceNodeShape(ctxThrough, 'through', 0, 0, 220, 76);
    const throughArcTos = ctxThrough.commands.filter((c: string) => c.startsWith('arcTo'));
    assert.equal(throughArcTos.length, 4);
    for (const cmd of throughArcTos) {
        assert.ok(cmd.endsWith(',4)'), 'Through mode must keep all 4 corners straight (r=4)');
    }

    // Isolated mode: both sides curved (r=22)
    const ctxIsolated = mockCtx();
    traceNodeShape(ctxIsolated, 'isolated', 0, 0, 44, 44);
    const isolatedArcTos = ctxIsolated.commands.filter((c: string) => c.startsWith('arcTo'));
    assert.equal(isolatedArcTos.length, 4);
    for (const cmd of isolatedArcTos) {
        assert.ok(cmd.endsWith(',22)'), 'Isolated mode curves all 4 corners');
    }
});

test('SectionRendererFactory: Appearance section drops icon and shape editability, keeping only color', async () => {
    const sample = new SampleNode();
    sample.properties.color = '#3b82f6';

    const container = (globalThis as any).document.createElement('div');
    const result = await SectionRendererFactory.renderSection(
        { type: 'appearance', title: 'Appearance' },
        sample,
        {}
    );
    assert.ok(result);

    // Look for controls inside result
    const allSelects: any[] = [];
    const collectSelects = (el: any) => {
        if (el.tagName === 'SELECT') allSelects.push(el);
        for (const child of el.children || []) collectSelects(child);
    };
    collectSelects(result);

    // Assert that ONLY 1 select exists: Color (no icon select, no shape select)
    assert.equal(allSelects.length, 1, 'Only color should be available in Appearance');
    assert.equal(allSelects[0].dataset.appearanceKey, 'color', 'The only appearance key must be "color"');
    assert.equal(allSelects[0].getAttribute ? allSelects[0].getAttribute('aria-label') : allSelects[0]['aria-label'], 'Color');

    // Triggering color select updates node color
    allSelects[0].value = '#10b981';
    allSelects[0].dispatchEvent({ type: 'change' });
    assert.equal(sample.nodeColor, '#10b981', 'Selecting color updates node.nodeColor');
    assert.equal(sample.properties.user_color, true, 'User color flag is armed');
});

test('IRIDE iconVisuals: quantized RMS color modulation, clip warning color, and radial loop drawing', () => {
    assert.equal(rmsToMeterLevel(0), 0);
    assert.equal(rmsToMeterLevel(1e-5), 0);
    assert.ok(rmsToMeterLevel(0.25) > 0.6 && rmsToMeterLevel(0.25) < 0.85);
    assert.equal(rmsToMeterLevel(1.0), 1);

    // Silence preserves exact baseColor; active RMS brightens within the node's own hue; clip turns vivid red
    const baseDark = '#0f172a';
    assert.equal(getQuantizedRmsColor(baseDark, 0, false), baseDark);
    const midDark = getQuantizedRmsColor(baseDark, 0.5, false);
    const hotDark = getQuantizedRmsColor(baseDark, 1.0, false);
    assert.notEqual(midDark, baseDark);
    assert.notEqual(hotDark, midDark);
    assert.equal(getQuantizedRmsColor(baseDark, 0.8, true), CLIP_FILL_COLOR);

    const baseEmerald = '#10b981';
    assert.equal(getQuantizedRmsColor(baseEmerald, 0, false), baseEmerald);
    assert.notEqual(getQuantizedRmsColor(baseEmerald, 0.9, false), baseEmerald);

    const idleHeader = getQuantizedRmsHeaderStyle(baseDark, 0, false);
    assert.equal(idleHeader.bg, '');
    assert.equal(idleHeader.fg, '#0f172a');

    const activeHeader = getQuantizedRmsHeaderStyle(baseDark, 0.6, false);
    assert.ok(activeHeader.bg.startsWith('rgba('));
    assert.equal(activeHeader.fg, '#0f172a');
    assert.ok(activeHeader.border.length > 0);

    const clipHeader = getQuantizedRmsHeaderStyle(baseDark, 0.6, true);
    assert.equal(clipHeader.bg, CLIP_FILL_COLOR);
    assert.equal(clipHeader.fg, '#ffffff');
    assert.equal(clipHeader.border, CLIP_FILL_COLOR);

    const arcs: Array<{ cx: number; cy: number; r: number; sa: number; ea: number }> = [];
    const lines: Array<{ x: number; y: number }> = [];
    const mockCtx = {
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: (x: number, y: number) => lines.push({ x, y }),
        lineTo: (x: number, y: number) => lines.push({ x, y }),
        arc: (cx: number, cy: number, r: number, sa: number, ea: number) => arcs.push({ cx, cy, r, sa, ea }),
        fill: () => {},
        stroke: () => {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1
    } as unknown as CanvasRenderingContext2D;

    drawRadialLoopProgress(mockCtx, 22, 22, 14, 0.5, { dividerFractions: [0.5] });
    assert.equal(arcs.length, 2); // Track circle + 50% wedge arc
    assert.equal(arcs[0].r, 14);
    assert.ok(Math.abs(arcs[1].ea - Math.PI * 0.5) < 1e-6);
    assert.ok(lines.length >= 3, 'Should draw wedge center vertex plus section divider line');

    // Mid-luminance indigo (#4f46e5) modulates monotonically without dark step-1 discontinuity
    const baseIndigo = '#4f46e5';
    assert.equal(getQuantizedRmsColor(baseIndigo, 0, false), baseIndigo);
    const step1Indigo = getQuantizedRmsColor(baseIndigo, 1 / 15, false);
    const hotIndigo = getQuantizedRmsColor(baseIndigo, 1.0, false);
    assert.notEqual(step1Indigo, baseIndigo);
    assert.notEqual(hotIndigo, step1Indigo);

    // drawIconRmsFill & drawHeaderRmsMeter render bottom-up / horizontal RMS curves and peak markers
    const fillRects: Array<{ x: number; y: number; w: number; h: number; fillStyle: string }> = [];
    const meterCtx = {
        fillRect: function (x: number, y: number, w: number, h: number) {
            fillRects.push({ x, y, w, h, fillStyle: this.fillStyle });
        },
        fillStyle: ''
    } as unknown as CanvasRenderingContext2D;

    drawIconRmsFill(meterCtx, 44, 0.6, 0.85, baseIndigo, false);
    assert.ok(fillRects.length >= 3, 'Icon RMS fill should draw body wash, crest line, and peak-hold line');
    assert.ok(fillRects.some(r => r.y < 22 && r.h < 4), 'Icon RMS fill should draw upper crest/peak line');

    fillRects.length = 0;
    const hdrStyle = drawHeaderRmsMeter(meterCtx, 220, 22, 0.7, 0.98, baseIndigo, false);
    assert.equal(hdrStyle.fg, '#0f172a');
    assert.ok(fillRects.some(r => r.h === 22 && r.w > 100), 'Header RMS meter draws horizontal wash');
    assert.ok(fillRects.some(r => r.h === 2.5 && r.y === 19.5), 'Header RMS meter draws bottom RMS ribbon');
    assert.ok(fillRects.some(r => r.fillStyle === CLIP_MARKER_COLOR && r.w === 2), 'Header RMS meter draws near-clip peak pip');

    // sampleBufferMeterLevels reports un-clamped RMS and peak above 1.0 for clipping detection
    const sr = 48000;
    const hotSamples = new Float32Array(sr);
    hotSamples.fill(1.25);
    const hotBuf = {
        sampleRate: sr,
        length: hotSamples.length,
        duration: 1.0,
        numberOfChannels: 1,
        getChannelData: () => hotSamples
    } as unknown as AudioBuffer;
    const levels = sampleBufferMeterLevels(hotBuf, 0.5, 1.0, 0.04);
    assert.equal(levels.active, true);
    assert.ok(Math.abs(levels.rms - 1.25) < 1e-4);
    assert.ok(Math.abs(levels.peak - 1.25) < 1e-4);
});


