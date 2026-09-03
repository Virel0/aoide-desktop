import { describe, expect, it } from 'vitest';

import { CoverlessCandidate, isCoverless, planCoverRepairs } from './cover-repair';

const aoide = (
    id: string,
    name: string,
    over: Partial<CoverlessCandidate> = {},
): CoverlessCandidate => ({
    artworkItemId: null,
    id,
    imageHash: null,
    name,
    sourceJellyfinId: null,
    ...over,
});

const jellyfin = (id: string, name: string) => ({ id, name });

describe('planCoverRepairs', () => {
    it('borrows the picture when exactly one Jellyfin playlist has the name', () => {
        const plan = planCoverRepairs([aoide('a1', 'Driving')], [jellyfin('j1', 'Driving')]);

        expect(plan).toEqual([{ artworkItemId: 'j1', playlistId: 'a1' }]);
    });

    it('skips a name nothing on Jellyfin carries', () => {
        expect(planCoverRepairs([aoide('a1', 'Driving')], [jellyfin('j1', 'Cooking')])).toEqual([]);
    });

    // Two candidates is a guess, and a wrong guess syncs to the phone.
    it('skips a name two Jellyfin playlists carry', () => {
        const plan = planCoverRepairs(
            [aoide('a1', 'Driving')],
            [jellyfin('j1', 'Driving'), jellyfin('j2', 'Driving')],
        );

        expect(plan).toEqual([]);
    });

    it('trims both sides before comparing', () => {
        const plan = planCoverRepairs([aoide('a1', '  Driving ')], [jellyfin('j1', 'Driving  ')]);

        expect(plan).toEqual([{ artworkItemId: 'j1', playlistId: 'a1' }]);
    });

    it('is case-sensitive: "driving" is not "Driving"', () => {
        expect(planCoverRepairs([aoide('a1', 'driving')], [jellyfin('j1', 'Driving')])).toEqual([]);
    });

    it('leaves a playlist alone that has any cover already', () => {
        const withHash = aoide('a1', 'Driving', { imageHash: 'abc' });
        const withItem = aoide('a2', 'Driving', { artworkItemId: 'x' });
        const withSource = aoide('a3', 'Driving', { sourceJellyfinId: 'j1' });

        expect(isCoverless(withHash)).toBe(false);
        expect(isCoverless(withItem)).toBe(false);
        expect(isCoverless(withSource)).toBe(false);
        expect(
            planCoverRepairs([withHash, withItem, withSource], [jellyfin('j1', 'Driving')]),
        ).toEqual([]);
    });

    // The rule the whole file exists for. A name cannot prove provenance, and
    // `sourceJellyfinId` is what a re-import dedupes on: written on a guess, the
    // next import silently merges two unrelated playlists.
    it('never writes sourceJellyfinId, only artworkItemId', () => {
        const plan = planCoverRepairs([aoide('a1', 'Driving')], [jellyfin('j1', 'Driving')]);

        expect(plan).toHaveLength(1);
        expect(Object.keys(plan[0]).sort()).toEqual(['artworkItemId', 'playlistId']);
        expect(plan[0]).not.toHaveProperty('sourceJellyfinId');
    });

    it('plans several playlists independently', () => {
        const plan = planCoverRepairs(
            [aoide('a1', 'Driving'), aoide('a2', 'Cooking'), aoide('a3', 'Sleeping')],
            [jellyfin('j1', 'Driving'), jellyfin('j3', 'Sleeping'), jellyfin('j4', 'Sleeping')],
        );

        expect(plan).toEqual([{ artworkItemId: 'j1', playlistId: 'a1' }]);
    });
});
