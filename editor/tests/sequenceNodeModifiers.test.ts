import test from 'node:test';
import assert from 'node:assert/strict';

export function isModifierNode(node: any): boolean {
    if (!node) return false;
    return Boolean(
        node.isModifier ||
        node.properties?.parentId != null ||
        node.type === 'Audio/Modulator' ||
        node.type === 'Audio/AssetFilter' ||
        node.type === 'Audio/Random'
    );
}

export function updateModifiersForParent(parentNode: any): void {
    if (!parentNode || !parentNode.graph) return;
    const allNodes: any[] = (parentNode.graph as any)._nodes || [];
    const modifiers = allNodes.filter(n =>
        n && isModifierNode(n) && n.properties?.parentId === parentNode.id
    );
    if (!modifiers.length) return;

    const parentWidth = parentNode.size?.[0] || 44;
    const parentHeight = parentNode.size?.[1] || 44;
    const parentCenterX = parentNode.pos[0] + parentWidth * 0.5;
    const parentBottomY = parentNode.pos[1] + parentHeight;

    const spacing = 56;
    const totalWidth = (modifiers.length - 1) * spacing + 44;
    const startX = parentCenterX - totalWidth * 0.5;
    const targetY = parentBottomY + 32;

    modifiers.forEach((mod, index) => {
        const targetX = startX + index * spacing;
        if (!mod.pos) {
            mod.pos = [targetX, targetY];
        } else {
            mod.pos[0] = targetX;
            mod.pos[1] = targetY;
        }
    });
}

test('isModifierNode correctly identifies modifier nodes', () => {
    assert.equal(isModifierNode({ type: 'Audio/Modulator' }), true);
    assert.equal(isModifierNode({ type: 'Audio/AssetFilter' }), true);
    assert.equal(isModifierNode({ type: 'Audio/Random' }), true);
    assert.equal(isModifierNode({ isModifier: true }), true);
    assert.equal(isModifierNode({ properties: { parentId: 5 } }), true);
    assert.equal(isModifierNode({ type: 'Audio/Sequence' }), false);
    assert.equal(isModifierNode({ type: 'Audio/Sample' }), false);
});

test('updateModifiersForParent centers single modifier under parent', () => {
    const parentNode: any = {
        id: 10,
        pos: [100, 200],
        size: [44, 44],
        graph: { _nodes: [] }
    };
    const mod: any = {
        id: 21,
        type: 'Audio/Random',
        properties: { parentId: 10 },
        pos: [0, 0]
    };
    parentNode.graph._nodes = [parentNode, mod];

    updateModifiersForParent(parentNode);

    // Parent center X = 122, Bottom Y = 244. Target Y = 276.
    // Single modifier: startX = 122 - 22 = 100.
    assert.equal(mod.pos[0], 100);
    assert.equal(mod.pos[1], 276);
});

test('updateModifiersForParent follows parent when moving', () => {
    const parentNode: any = {
        id: 10,
        pos: [100, 200],
        size: [44, 44],
        graph: { _nodes: [] }
    };
    const mod1: any = {
        id: 21,
        type: 'Audio/Modulator',
        properties: { parentId: 10 },
        pos: [0, 0]
    };
    const mod2: any = {
        id: 22,
        type: 'Audio/Random',
        properties: { parentId: 10 },
        pos: [0, 0]
    };
    parentNode.graph._nodes = [parentNode, mod1, mod2];

    updateModifiersForParent(parentNode);
    assert.equal(mod1.pos[0], 72);
    assert.equal(mod2.pos[0], 128);
    assert.equal(mod1.pos[1], 276);
    assert.equal(mod2.pos[1], 276);

    // Move parent to new coordinates
    parentNode.pos = [250, 350];
    updateModifiersForParent(parentNode);

    // Parent center X = 272, Bottom Y = 394, Target Y = 426.
    // startX = 272 - 50 = 222.
    assert.equal(mod1.pos[0], 222);
    assert.equal(mod2.pos[0], 278);
    assert.equal(mod1.pos[1], 426);
    assert.equal(mod2.pos[1], 426);
});
