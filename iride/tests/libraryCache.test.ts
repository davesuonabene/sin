import assert from 'node:assert/strict';
import test from 'node:test';

import { clearLibraryCache, fetchLibrary } from '../src/api.ts';

test('fetchLibrary uses cache on consecutive calls, and clears cache on clearLibraryCache or forceRefresh', async () => {
    let fetchCount = 0;
    let mockFiles = [{ id: 1, filename: 'one.wav' }];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
        fetchCount++;
        return {
            ok: true,
            json: async () => ({ files: mockFiles }),
        } as any;
    };

    try {
        clearLibraryCache();
        fetchCount = 0;

        // Initial fetch
        const res1 = await fetchLibrary(false, true);
        assert.equal(res1.length, 1);
        assert.equal(fetchCount, 1);

        // Second fetch without forceRefresh -> should use cache
        mockFiles = [{ id: 1, filename: 'one.wav' }, { id: 2, filename: 'two.wav' }];
        const res2 = await fetchLibrary(false, true);
        assert.equal(res2.length, 1);
        assert.equal(fetchCount, 1);

        // Third fetch with forceRefresh -> should bypass cache and fetch new files
        const res3 = await fetchLibrary(true, true);
        assert.equal(res3.length, 2);
        assert.equal(fetchCount, 2);

        // Fourth fetch after clearLibraryCache -> should also fetch fresh
        mockFiles = [
            { id: 1, filename: 'one.wav' },
            { id: 2, filename: 'two.wav' },
            { id: 3, filename: 'three.wav' },
        ];
        clearLibraryCache();
        const res4 = await fetchLibrary(false, true);
        assert.equal(res4.length, 3);
        assert.equal(fetchCount, 3);
    } finally {
        globalThis.fetch = originalFetch;
        clearLibraryCache();
    }
});
