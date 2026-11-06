import assert from 'node:assert/strict';
import test from 'node:test';

import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { DisabledNode } from '../src/nodes/DisabledNode.ts';
import { ModulatorNode } from '../src/nodes/ModulatorNode.ts';
import {
    traceNodeShape,
    getNodeShapePerimeter,
    drawPerimeterProgressAccent
} from '../src/nodes/NodeVisuals.ts';
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
        assert.ok(getNodeShapePerimeter(node.nodeShape, 44) > 0, `${node.constructor.name} must have positive shape perimeter`);
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

