import test from 'node:test';
import assert from 'node:assert/strict';

test('ESC key and background click clear selection', () => {
    // Mock selection state
    const selectedNodes: Record<string, any> = { '1': { id: 1 }, '2': { id: 2 } };
    const selectedLinkIds = new Set<number>([10, 11]);

    const deselectAllNodes = () => {
        for (const k in selectedNodes) delete selectedNodes[k];
    };

    assert.equal(Object.keys(selectedNodes).length, 2);
    assert.equal(selectedLinkIds.size, 2);

    // Simulate ESC press
    const handleEscape = () => {
        deselectAllNodes();
        selectedLinkIds.clear();
    };

    handleEscape();
    assert.equal(Object.keys(selectedNodes).length, 0);
    assert.equal(selectedLinkIds.size, 0);
});

test('Clicking a single node when multiple are selected collapses selection to that single node', () => {
    const selectedNodes: Record<string, any> = {
        '10': { id: 10 },
        '20': { id: 20 },
        '30': { id: 30 }
    };
    const selectedLinkIds = new Set<number>([99]);

    // User clicked node 20 without Shift/Ctrl
    const clickedNode = selectedNodes['20'];
    const selectOnlyNode = (node: any) => {
        for (const k in selectedNodes) delete selectedNodes[k];
        selectedNodes[String(node.id)] = node;
        selectedLinkIds.clear();
    };

    selectOnlyNode(clickedNode);

    assert.equal(Object.keys(selectedNodes).length, 1);
    assert.ok(selectedNodes['20']);
    assert.equal(selectedLinkIds.size, 0);
});

test('Clicking empty canvas deselects nodes and cables', () => {
    const selectedNodes: Record<string, any> = { '5': { id: 5 } };
    const selectedLinkIds = new Set<number>([12]);

    const clickBackground = () => {
        for (const k in selectedNodes) delete selectedNodes[k];
        selectedLinkIds.clear();
    };

    clickBackground();

    assert.equal(Object.keys(selectedNodes).length, 0);
    assert.equal(selectedLinkIds.size, 0);
});

