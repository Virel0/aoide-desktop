import { describe, expect, it } from 'vitest';

import {
    contextKey,
    list,
    RECENT_CONTEXT_CAP,
    RecentContext,
    remember,
    RESUME_GRID_LIMIT,
    resumeTiles,
} from './recent-contexts';

const album = (id: string, lastOpened: number): RecentContext => ({
    id,
    kind: 'album',
    lastOpened,
    name: `Album ${id}`,
});

describe('remember', () => {
    it('puts the newest first', () => {
        const contexts = remember(remember([], album('a', 1)), album('b', 2));
        expect(contexts.map((c) => c.id)).toEqual(['b', 'a']);
    });

    // The same album played every evening is one tile, not six.
    it('keeps one entry per kind and id, moving it to the front', () => {
        const contexts = remember(
            remember(remember([], album('a', 1)), album('b', 2)),
            album('a', 3),
        );
        expect(contexts.map((c) => c.id)).toEqual(['a', 'b']);
        expect(contexts[0].lastOpened).toBe(3);
    });

    // A Jellyfin playlist and an Aoide playlist can share an id by accident of
    // import; they are different things and resume differently.
    it('tells kinds apart even when the ids collide', () => {
        const contexts = remember(
            [{ id: 'x', kind: 'jellyfinPlaylist', lastOpened: 1, name: 'J' }],
            { id: 'x', kind: 'aoidePlaylist', lastOpened: 2, name: 'A' },
        );
        expect(contexts).toHaveLength(2);
        expect(contextKey(contexts[0])).toBe('aoidePlaylist:x');
        expect(contextKey(contexts[1])).toBe('jellyfinPlaylist:x');
    });

    it('caps the list, dropping the oldest', () => {
        let contexts: RecentContext[] = [];
        for (let i = 0; i < RECENT_CONTEXT_CAP + 5; i += 1) {
            contexts = remember(contexts, album(String(i), i));
        }
        expect(contexts).toHaveLength(RECENT_CONTEXT_CAP);
        expect(contexts[0].id).toBe(String(RECENT_CONTEXT_CAP + 4));
        expect(contexts[contexts.length - 1].id).toBe('5');
    });

    it('keeps enough for the grid to have replacements', () => {
        expect(RECENT_CONTEXT_CAP).toBeGreaterThan(RESUME_GRID_LIMIT);
    });

    it('does not mutate what it was given', () => {
        const before = [album('a', 1)];
        remember(before, album('b', 2));
        expect(before).toEqual([album('a', 1)]);
    });
});

describe('list', () => {
    const contexts = [album('old', 1), album('new', 3), album('mid', 2)];

    it('returns the newest first, however they were stored', () => {
        expect(list(contexts, 10).map((c) => c.id)).toEqual(['new', 'mid', 'old']);
    });

    it('stops at the limit', () => {
        expect(list(contexts, 2).map((c) => c.id)).toEqual(['new', 'mid']);
    });

    it('is empty for a limit of nothing', () => {
        expect(list(contexts, 0)).toEqual([]);
    });
});

describe('resumeTiles', () => {
    const NOW = 1_000_000;
    const contexts = [album('a', NOW - 60_000), album('b', NOW - 120_000)];

    it('shows six at most', () => {
        expect(RESUME_GRID_LIMIT).toBe(6);
        const many = Array.from({ length: 10 }, (_, i) => album(String(i), i));
        expect(resumeTiles(many, null, NOW)).toHaveLength(6);
    });

    it('renders nothing for nothing', () => {
        expect(resumeTiles([], null, NOW)).toEqual([]);
    });

    it('is the contexts alone without a handoff', () => {
        const tiles = resumeTiles(contexts, null, NOW);
        expect(tiles.map((t) => t.kind)).toEqual(['context', 'context']);
    });

    // Another device that played thirty seconds ago beats an album played a
    // minute ago here: it goes first.
    it('leads with another device when it played more recently than anything here', () => {
        const tiles = resumeTiles(contexts, { ageSeconds: 30, deviceName: 'Phone' }, NOW);
        expect(tiles[0]).toEqual({ deviceName: 'Phone', kind: 'handoff' });
        expect(tiles).toHaveLength(3);
    });

    it('leaves the other device out when this one played since', () => {
        const tiles = resumeTiles(contexts, { ageSeconds: 90, deviceName: 'Phone' }, NOW);
        expect(tiles.every((t) => t.kind === 'context')).toBe(true);
    });

    // A tie goes to this device: the tile it already had is one tap, and a
    // handover for a queue this machine just wrote is a handover to itself.
    it('leaves it out on a tie', () => {
        const tiles = resumeTiles(contexts, { ageSeconds: 60, deviceName: 'Phone' }, NOW);
        expect(tiles[0].kind).toBe('context');
    });

    it('leads with the other device when nothing was played here at all', () => {
        const tiles = resumeTiles([], { ageSeconds: 3_600, deviceName: 'Phone' }, NOW);
        expect(tiles).toEqual([{ deviceName: 'Phone', kind: 'handoff' }]);
    });

    it('still shows six at most with a handoff in front', () => {
        const many = Array.from({ length: 10 }, (_, i) => album(String(i), i));
        const tiles = resumeTiles(many, { ageSeconds: 0, deviceName: 'Phone' }, NOW);
        expect(tiles).toHaveLength(6);
        expect(tiles[0].kind).toBe('handoff');
    });
});
