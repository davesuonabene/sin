import assert from 'node:assert/strict';
import test from 'node:test';

import { EngineSyncManager, type EngineSyncState } from '../src/ui/EngineSyncManager.ts';
import { updateEngineTelemetry, subscribeEngineTelemetry, type EngineTelemetrySummary } from '../src/runtimeLog.ts';

// Provide minimal document stub for headless node environment
if (typeof document === 'undefined') {
    (globalThis as any).document = {
        createElement: (tag: string) => ({
            tagName: tag,
            className: '',
            dataset: {},
            textContent: '',
            style: {},
            setAttribute: () => {},
            append: () => {},
            addEventListener: () => {},
            appendChild: () => {}
        })
    };
}

test('EngineSyncManager manages state transitions and metrics correctly', () => {
    const manager = EngineSyncManager.getInstance();
    
    // Initial state
    assert.equal(manager.getState(), 'idle_synced');

    // Transitions
    manager.setState('dirty_pending');
    assert.equal(manager.getState(), 'dirty_pending');

    manager.setState('dsp_rendering', { nodeId: 10, nodeName: 'Kick Track' });
    assert.equal(manager.getState(), 'dsp_rendering');
    assert.equal(manager.getMetrics().nodeName, 'Kick Track');
    assert.equal(manager.getMetrics().nodeId, 10);

    manager.setState('streaming_chunks', { barsReceived: 2, totalBars: 4 });
    assert.equal(manager.getState(), 'streaming_chunks');
    assert.equal(manager.getMetrics().barsReceived, 2);
    assert.equal(manager.getMetrics().totalBars, 4);

    manager.setState('idle_synced', { lastRenderDurationMs: 42 });
    assert.equal(manager.getState(), 'idle_synced');
    assert.equal(manager.getMetrics().lastRenderDurationMs, 42);

    manager.setState('error', { errorMessage: 'DSP render timeout' });
    assert.equal(manager.getState(), 'error');
    assert.equal(manager.getMetrics().errorMessage, 'DSP render timeout');
});

test('Engine telemetry updates and notifies subscribers', () => {
    let captured: EngineTelemetrySummary = {};
    const unsub = subscribeEngineTelemetry(t => {
        captured = { ...t };
    });

    updateEngineTelemetry({
        renderMs: 14.5,
        streamMs: 8.2,
        totalMs: 22.7,
        bufferedPercent: 100
    });

    unsub();
    assert.equal(captured.renderMs, 14.5);
    assert.equal(captured.streamMs, 8.2);
    assert.equal(captured.totalMs, 22.7);
    assert.equal(captured.bufferedPercent, 100);
});
