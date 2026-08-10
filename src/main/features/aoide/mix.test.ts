import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { Mix } from './mix';

let database: CurationDatabase;
let store: CurationStore;
let mix: Mix;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
    mix = new Mix(database);
});

afterEach(() => database.close());

/** A finished listen. Long enough to count as a play under the shared rule. */
const played = (jellyfinId: string, at: number, msPlayed = 200_000) =>
    store.record('play_events', {
        completed: true,
        contentKey: jellyfinId,
        endedAt: at + msPlayed,
        id: `${jellyfinId}-${at}`,
        jellyfinId,
        msPlayed,
        startedAt: at,
    });

const rules = (over: Partial<Parameters<Mix['narrow']>[1]> = {}) => ({
    match: 'all' as const,
    rules: [],
    ...over,
});

describe('history rules', () => {
    it('keeps only the tracks played often enough', () => {
        const now = Date.now();
        played('a', now - DAY);
        played('a', now - 2 * DAY);
        played('b', now - DAY);

        const kept = mix.narrow(
            ['a', 'b', 'c'],
            rules({ rules: [{ field: 'play_count', op: 'greaterThan', value: 1 }] }),
        );

        expect(kept).toEqual(['a']);
    });

    // The songs never touched at all are the ones most worth surfacing in a
    // "haven't heard this in ages" mix, and they are exactly the ones a naive
    // null check drops.
    it('counts a track never played as not played in the last month', () => {
        const now = Date.now();
        played('recent', now - DAY);

        const kept = mix.narrow(
            ['recent', 'never'],
            rules({ rules: [{ field: 'last_played', op: 'notInTheLast', value: '-30d' }] }),
        );

        expect(kept).toEqual(['never']);
    });

    it('finds what was played inside a span', () => {
        const now = Date.now();
        played('recent', now - DAY);
        played('old', now - 400 * DAY);

        const kept = mix.narrow(
            ['recent', 'old', 'never'],
            rules({ rules: [{ field: 'last_played', op: 'inTheLast', value: '-30d' }] }),
        );

        expect(kept).toEqual(['recent']);
    });

    it('honours any as well as all', () => {
        const now = Date.now();
        played('loved', now - DAY);
        played('loved', now - 2 * DAY);
        played('old', now - 400 * DAY);

        const kept = mix.narrow(
            ['loved', 'old', 'never'],
            rules({
                match: 'any',
                rules: [
                    { field: 'play_count', op: 'greaterThan', value: 1 },
                    { field: 'last_played', op: 'notInTheLast', value: '-30d' },
                ],
            }),
        );

        expect(new Set(kept)).toEqual(new Set(['loved', 'never', 'old']));
    });

    // A four-second skip is not a play. That distinction is the whole reason the
    // history exists rather than reading Jellyfin's own counters.
    it('does not count a skip as a play', () => {
        const now = Date.now();
        store.record('play_events', {
            completed: false,
            contentKey: 'k',
            endedAt: now + 4_000,
            id: 'skip-1',
            jellyfinId: 'skipped',
            msPlayed: 4_000,
            skipped: true,
            startedAt: now,
        });

        const kept = mix.narrow(
            ['skipped'],
            rules({ rules: [{ field: 'play_count', op: 'greaterThan', value: 0 }] }),
        );

        expect(kept).toEqual([]);
    });
});

describe('what the library already decided', () => {
    // Rules about genre and year are Jellyfin's to answer; by the time
    // candidates arrive here they have been applied.
    it('passes every candidate through when no rule mentions history', () => {
        const kept = mix.narrow(
            ['a', 'b', 'c'],
            rules({ rules: [{ field: 'genre', op: 'is', value: 'Jazz' }] }),
        );

        expect(kept).toEqual(['a', 'b', 'c']);
    });

    it('respects the limit', () => {
        expect(mix.narrow(['a', 'b', 'c'], rules({ limit: 2, rules: [] }))).toHaveLength(2);
    });

    it('answers for more candidates than SQLite takes parameters', () => {
        const ids = Array.from({ length: 1200 }, (_, index) => `t${index}`);
        played('t900', Date.now() - DAY);

        const kept = mix.narrow(
            ids,
            rules({ rules: [{ field: 'play_count', op: 'greaterThan', value: 0 }] }),
        );

        // Chunking must not lose the tail — t900 sits past the first chunk.
        expect(kept).toEqual(['t900']);
    });
});
