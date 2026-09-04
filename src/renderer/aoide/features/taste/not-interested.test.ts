import { describe, expect, it } from 'vitest';

import { withoutNotInterested } from './not-interested';

describe('withoutNotInterested', () => {
    const songs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('drops the hidden ones and keeps the order', () => {
        expect(withoutNotInterested(songs, new Set(['b']))).toEqual([{ id: 'a' }, { id: 'c' }]);
    });

    it('returns everything, as a copy, when nothing is hidden', () => {
        const kept = withoutNotInterested(songs, new Set());

        expect(kept).toEqual(songs);
        expect(kept).not.toBe(songs);
    });

    it('can drop everything', () => {
        expect(withoutNotInterested(songs, new Set(['a', 'b', 'c']))).toEqual([]);
    });

    it('ignores hidden ids that are not in the list', () => {
        expect(withoutNotInterested(songs, new Set(['zz']))).toEqual(songs);
    });
});
