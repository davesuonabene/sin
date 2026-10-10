import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeAssetRefreshMode,
    shouldRefreshAssetPool
} from '../../ermes/ts/assetResolver.ts';

const hierarchy = new Map([
    [1, { parentId: 2 }],
    [2, { parentId: 3 }],
    [3, { parentId: null }]
]);

test('normalizes saved refresh-mode aliases', () => {
    assert.equal(normalizeAssetRefreshMode('local_refresh'), 'local');
    assert.equal(normalizeAssetRefreshMode('parent_refresh'), 'parent');
    assert.equal(normalizeAssetRefreshMode('global_refresh'), 'global');
    assert.equal(normalizeAssetRefreshMode('fixed'), 'off');
});

test('refresh scopes match the explicitly previewed graph level', () => {
    const preview = { kind: 'preview' as const, globalPreview: false };
    assert.equal(shouldRefreshAssetPool('local', 1, 1, hierarchy, preview), true);
    assert.equal(shouldRefreshAssetPool('local', 1, 3, hierarchy, preview), true);
    assert.equal(shouldRefreshAssetPool('local', 1, 3, hierarchy, { kind: 'render' }), true);
    assert.equal(shouldRefreshAssetPool('parent', 1, 1, hierarchy, preview), false);
    assert.equal(shouldRefreshAssetPool('parent', 1, 2, hierarchy, preview), true);
    assert.equal(shouldRefreshAssetPool('ancestor', 1, 3, hierarchy, preview), true);
    assert.equal(shouldRefreshAssetPool('off', 1, 1, hierarchy, preview), false);
});

test('global preview only triggers global-mode pools', () => {
    const globalPreview = { kind: 'preview' as const, globalPreview: true };
    assert.equal(shouldRefreshAssetPool('global', 1, 3, hierarchy, globalPreview), true);
    assert.equal(shouldRefreshAssetPool('local', 1, 3, hierarchy, globalPreview), true);
    assert.equal(shouldRefreshAssetPool('ancestor', 1, 3, hierarchy, globalPreview), false);
    assert.equal(shouldRefreshAssetPool('global', 1, 3, hierarchy, { kind: 'render' }), false);
});
