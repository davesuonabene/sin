import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assetMatchesFilters,
    getFilterableAssetItems,
    isAssetOrganizer,
} from '../src/ui/libraryFilters.ts';


test('live recording projects remain read-only organizers in SIN', () => {
    const project = {
        id: 12,
        type: 'live_recording_project',
        vault_id: 3,
        contents: [
            { id: 13, type: 'loop', filename: 'Board Mix.wav', tags: ['Live'] },
        ],
    };

    assert.equal(isAssetOrganizer(project), true);
    assert.equal(getFilterableAssetItems(project)[0].vault_id, 3);
    assert.equal(assetMatchesFilters(project, { types: ['loop'], tags: ['live'] }), true);
    assert.equal(assetMatchesFilters(project, { types: ['midi'] }), false);
});


test('legacy sample packs keep organizer behavior', () => {
    const pack = { type: 'sample_pack', contents: [{ type: 'one_shot' }] };
    assert.equal(isAssetOrganizer(pack), true);
    assert.equal(assetMatchesFilters(pack, { types: ['one_shot'] }), true);
});
