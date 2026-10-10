import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assetMatchesFilters,
    getFilterableAssetItems,
    isAssetOrganizer,
} from '../src/ui/libraryFilters.ts';


test('projects remain read-only organizers in SIN', () => {
    const project = {
        id: 12,
        type: 'project',
        vault_id: 3,
        contents: [
            { id: 13, type: 'sample', filename: 'Board Mix.wav', tags: ['Live'] },
        ],
    };

    assert.equal(isAssetOrganizer(project), true);
    assert.equal(getFilterableAssetItems(project)[0].vault_id, 3);
    assert.equal(assetMatchesFilters(project, { types: ['sample'], tags: ['live'] }), true);
    assert.equal(assetMatchesFilters(project, { types: ['midi'] }), false);
});


test('sample packs keep organizer behavior', () => {
    const pack = { type: 'sample_pack', contents: [{ type: 'sample' }] };
    assert.equal(isAssetOrganizer(pack), true);
    assert.equal(assetMatchesFilters(pack, { types: ['sample'] }), true);
});

test('folder items and is_container objects act as organizers', () => {
    const folder = {
        id: 50,
        type: 'folder',
        vault_id: 1,
        contents: [
            { id: 51, type: 'sample', filename: 'snare.wav', tags: ['Drums'] },
        ],
    };
    assert.equal(isAssetOrganizer(folder), true);
    assert.equal(assetMatchesFilters(folder, { types: ['sample'], tags: ['drums'] }), true);

    const genericContainer = {
        type: 'custom',
        is_container: true,
        contents: [{ id: 52, type: 'midi', filename: 'lead.mid' }],
    };
    assert.equal(isAssetOrganizer(genericContainer), true);
    assert.equal(assetMatchesFilters(genericContainer, { types: ['midi'] }), true);
});

test('getFilterableAssetItems recursively extracts leaf items from subfolders', () => {
    const rootContainer = {
        id: 100,
        type: 'project',
        vault_id: 2,
        contents: [
            {
                id: 101,
                type: 'folder',
                contents: [
                    { id: 102, type: 'sample', filename: 'kick.wav', tags: ['Kick'] },
                    { id: 103, type: 'sample', filename: 'hat.wav', tags: ['HiHat'], is_external: true },
                ],
            },
            { id: 104, type: 'track', filename: 'master.wav', tags: ['Master'] },
        ],
    };

    const filterable = getFilterableAssetItems(rootContainer);
    assert.equal(filterable.length, 3);
    assert.deepEqual(filterable.map(f => f.filename), ['kick.wav', 'hat.wav', 'master.wav']);
    assert.equal(filterable[0].vault_id, 2);
    assert.equal(filterable[1].is_external, true);
    assert.equal(assetMatchesFilters(rootContainer, { tags: ['hihat'] }), true);
});

