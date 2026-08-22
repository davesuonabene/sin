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
