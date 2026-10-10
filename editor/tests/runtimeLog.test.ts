import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendServerRuntimeLog,
    clearRuntimeLog,
    subscribeRuntimeLog,
    type RuntimeLogEntry
} from '../src/runtimeLog.ts';


test('server render events are appended in order with one subscriber update', () => {
    clearRuntimeLog();
    let notifications = 0;
    let latest: RuntimeLogEntry[] = [];
    const unsubscribe = subscribeRuntimeLog(entries => {
        notifications += 1;
        latest = entries;
    });

    appendServerRuntimeLog([
        { level: 'common', message: 'request accepted', offset_ms: 0 },
        { level: 'debug', message: 'file loaded', offset_ms: 4.25 },
    ]);

    unsubscribe();
    assert.equal(notifications, 2);
    assert.deepEqual(latest.map(entry => entry.level), ['common', 'debug']);
    assert.match(latest[1].message, /^SERVER \+4\.3 ms file loaded$/);
});
