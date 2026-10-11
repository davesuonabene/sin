import test from 'node:test';
import assert from 'node:assert';
import { WaveformRenderer } from '../src/renderers/WaveformRenderer.ts';

test('WaveformRenderer renders buffer-fill progress without error', () => {
    const renderer = new WaveformRenderer({ theme: 'light' });
    const peaks = new Float32Array([0.0, 0.8, -0.5, 0.5, -0.2, 0.3, -0.1, 0.9]);
    
    // Partially buffered signal (50% filled)
    renderer.setSignal({
        peaks,
        duration: 4.0,
        bufferedProgress: 0.5,
        playbackProgress: 0.25,
        accentColor: '#10b981'
    });

    const calls: string[] = [];
    const mockCtx = {
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        clip: () => calls.push('clip'),
        beginPath: () => calls.push('beginPath'),
        moveTo: () => calls.push('moveTo'),
        lineTo: () => calls.push('lineTo'),
        stroke: () => calls.push('stroke'),
        fill: () => calls.push('fill'),
        fillRect: () => calls.push('fillRect'),
        arc: () => calls.push('arc'),
        fillText: () => calls.push('fillText'),
        roundRect: () => calls.push('roundRect'),
        measureText: () => ({ width: 40 }),
        set strokeStyle(_val: any) {},
        set fillStyle(_val: any) {},
        set lineWidth(_val: any) {},
        set font(_val: any) {},
        set textAlign(_val: any) {},
        set textBaseline(_val: any) {},
    } as unknown as CanvasRenderingContext2D;

    renderer.render(mockCtx, { x: 0, y: 0, width: 200, height: 60 });
    assert.ok(calls.includes('save'));
    assert.ok(calls.includes('fillRect'));
    assert.ok(calls.includes('restore'));
});
