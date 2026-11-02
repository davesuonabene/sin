import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendServerRuntimeLog,
    clearRuntimeLog,
    runtimeLog,
    subscribeRuntimeLog,
    type RuntimeLogEntry
} from '../src/runtimeLog.ts';
import { RuntimeLogPanel } from '../src/ui/RuntimeLogPanel.ts';

function createMockElement(tag: string): any {
    const classListSet = new Set<string>();
    const listeners: Record<string, Function[]> = {};
    const children: any[] = [];
    const el: any = {
        tagName: tag.toUpperCase(),
        className: '',
        hidden: false,
        textContent: '',
        title: '',
        dataset: {},
        style: {},
        innerHTML: '',
        classList: {
            add: (c: string) => classListSet.add(c),
            remove: (c: string) => classListSet.delete(c),
            toggle: (c: string, force?: boolean) => {
                if (force === true) classListSet.add(c);
                else if (force === false) classListSet.delete(c);
                else if (classListSet.has(c)) classListSet.delete(c);
                else classListSet.add(c);
                return classListSet.has(c);
            },
            contains: (c: string) => classListSet.has(c)
        },
        setAttribute: () => {},
        getAttribute: () => null,
        append: (...items: any[]) => children.push(...items),
        appendChild: (item: any) => children.push(item),
        replaceChildren: (...items: any[]) => { children.length = 0; children.push(...items); },
        remove: () => {},
        querySelector: () => createMockElement('div'),
        querySelectorAll: () => [],
        addEventListener: (event: string, fn: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
        },
        dispatchEvent: (event: { type: string }) => {
            listeners[event.type]?.forEach(fn => fn(event));
        },
        _listeners: listeners,
        _trigger: (event: string) => {
            listeners[event]?.forEach(fn => fn({ type: event }));
        }
    };
    return el;
}

if (typeof document === 'undefined') {
    (globalThis as any).document = {
        createElement: (tag: string) => createMockElement(tag),
        createDocumentFragment: () => createMockElement('fragment')
    };
}


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

test('RuntimeLogPanel displays error echo as text, decays it, and resets on user interactions', async () => {
    clearRuntimeLog();
    const parent = createMockElement('div');
    const panel = new RuntimeLogPanel(parent);
    const echo = panel.getErrorEcho();

    // Initially hidden
    assert.equal(echo.hidden, true);

    // Logging an error surfaces the error echo text
    runtimeLog('Saving current stage failed: connection refused', 'error');
    assert.equal(echo.hidden, false);
    assert.equal(echo.textContent, 'Saving current stage failed: connection refused');
    assert.equal(echo.classList.contains('is-decaying'), false);

    // Logging a second error updates the count suffix
    runtimeLog('HTTP failed PUT /api/stage', 'error');
    assert.equal(echo.hidden, false);
    assert.equal(echo.textContent, 'HTTP failed PUT /api/stage (+1)');

    // Hovering error echo pauses decay and clears decaying class
    echo._trigger('pointerenter');
    assert.equal(echo.classList.contains('is-decaying'), false);

    // Clicking the echo opens the panel and dismisses the echo
    echo._trigger('click');
    assert.equal(echo.hidden, true);

    // Closing the panel and logging another error makes the echo visible again
    panel.setOpen(false);
    runtimeLog('Another disk error', 'error');
    assert.equal(echo.hidden, false);
    assert.equal(echo.textContent, 'Another disk error');

    // Clean up
    panel.dispose();
});
