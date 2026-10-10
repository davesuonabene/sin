import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fileVersionInfo,
    groupFileVersions,
} from '../src/libraryVersioning.ts';

test('groups GAIA-style sibling file revisions and chooses the newest by default', () => {
    const files = [
        { id: 1, path: 'C:/vaults/drums/loop.wav' },
        { id: 2, path: 'C:/vaults/drums/loop.2.wav' },
        { id: 3, path: 'C:/vaults/drums/loop.10.wav' },
        { id: 4, path: 'C:/vaults/drums/clap.wav' },
    ];

    const grouped = groupFileVersions(files, {
        pathFor: file => file.path,
        idFor: file => file.id,
        scope: 'root',
    });

    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].fileVersionDisplayName, 'loop');
    assert.equal(grouped[0].record.id, 3);
    assert.deepEqual(grouped[0].fileVersions?.map(version => version.label), ['Original', '.2', '.10']);
    assert.equal(grouped[1].record.id, 4);
});

test('does not treat an isolated dotted filename as a file revision', () => {
    const files = [{ id: 1, path: 'C:/vaults/drums/MZ 808 [D.O.T.S.].wav' }];
    const grouped = groupFileVersions(files, {
        pathFor: file => file.path,
        idFor: file => file.id,
        scope: 'root',
    });
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].fileVersions, undefined);
});

test('keeps a selected file revision when the group is re-rendered', () => {
    const files = [
        { id: 1, path: 'C:/vaults/drums/loop.wav' },
        { id: 2, path: 'C:/vaults/drums/loop.2.wav' },
    ];
    const groupKey = `root:${fileVersionInfo(files[0].path)!.key}`;
    const grouped = groupFileVersions(files, {
        pathFor: file => file.path,
        idFor: file => file.id,
        scope: 'root',
        selections: new Map([[groupKey, '1']]),
    });

    assert.equal(grouped[0].record.id, 1);
});
