import type { FinishCounts } from '/@/shared/aoide/finish-rate';
import type { TasteProfile } from '/@/shared/aoide/taste-ranking';
import type { Song } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import {
    chooseAlbumsByTaste,
    chooseSongsByTaste,
    INFINITY_POOL_MULTIPLIER,
    infinityPoolCount,
    songTasteCandidate,
} from './infinity-taste';

import { emptyTasteProfile, parseTasteProfile } from '/@/shared/aoide/taste-ranking';

/**
 * What Infinity does with a pool, as opposed to how a candidate is scored.
 *
 * The scoring is `taste-ranking.ts`'s and is pinned against the phone in
 * `taste-ranking-parity.test.ts`; nothing here re-asserts a weight. What is
 * under test is the part that is this app's own: that a pool is picked from
 * rather than taken, that an album is judged by the record and not by its id,
 * and — the one that matters most — that a listener with no history gets
 * exactly what Auto DJ always gave them.
 */

const song = (fields: Partial<Song> & { id: string }): Song =>
    ({
        albumArtistName: '',
        albumId: 'album',
        artistName: '',
        genres: [],
        ...fields,
    }) as Song;

const genres = (...names: string[]) => names.map((name) => ({ name }) as Song['genres'][number]);

const profile: TasteProfile = parseTasteProfile({
    artists: { sabaton: 1 },
    genres: { ambient: 0.5, metal: 1 },
    recent: ['heard-already'],
});

describe('choosing songs out of the pool', () => {
    // Three orders, all different, so that a test which passes can only be
    // passing for the reason it names: the pool's own order is c, a, b; the id
    // order a ranking would fall back on is a, b, c; and what this listener
    // wants is b, c, a.
    const pool = [
        song({ albumArtistName: 'Sabaton', id: 'c-sabaton' }),
        song({ genres: genres('Ambient'), id: 'a-ambient' }),
        song({ genres: genres('Metal'), id: 'b-metal' }),
    ];

    it('picks the best of the pool rather than the first of it', () => {
        expect(chooseSongsByTaste(pool, profile, {}, 3).map((one) => one.id)).toEqual([
            'b-metal',
            'c-sabaton',
            'a-ambient',
        ]);
    });

    // The whole of the "a new install must not get worse" promise. With no
    // history there is nothing to rank by, and the strategy's own order — which
    // it shuffled — is a better answer than any order this could invent.
    it('leaves the pool alone when there is no history to read', () => {
        expect(chooseSongsByTaste(pool, emptyTasteProfile(), {}, 3).map((one) => one.id)).toEqual([
            'c-sabaton',
            'a-ambient',
            'b-metal',
        ]);
    });

    it('never returns more than was asked for', () => {
        expect(chooseSongsByTaste(pool, profile, {}, 1)).toHaveLength(1);
        expect(chooseSongsByTaste(pool, emptyTasteProfile(), {}, 1)).toHaveLength(1);
    });

    // Allow duplicates is a setting, and with it on the strategies can gather
    // one track twice. Both copies are ranked, so five asked for is five given.
    it('keeps a song the pool holds twice', () => {
        const twice = [song({ genres: genres('Metal'), id: 'b-metal' }), ...pool];

        expect(chooseSongsByTaste(twice, profile, {}, 2).map((one) => one.id)).toEqual([
            'b-metal',
            'b-metal',
        ]);
    });

    it('takes the album artist as the name the history is keyed on', () => {
        const guest = song({
            albumArtistName: 'Sabaton',
            artistName: 'A Guest',
            genres: genres('Metal'),
            id: 'guest',
        });

        expect(songTasteCandidate(guest).artist).toBe('Sabaton');
    });
});

describe('choosing albums out of the pool', () => {
    // Three records and three different orders again: the pool arrives as c, a,
    // b, ids run a, b, c, and the listener wants b, a, c.
    const tracks = [
        song({ albumId: 'a-ambient-record', genres: genres('Ambient'), id: 'a1' }),
        song({ albumId: 'a-ambient-record', genres: genres('Ambient'), id: 'a2' }),
        song({ albumId: 'b-metal-record', genres: genres('Metal'), id: 'm1' }),
        song({ albumId: 'b-metal-record', genres: genres('Metal'), id: 'm2' }),
        song({ albumId: 'c-unknown-record', genres: genres('Unheard Of'), id: 'u1' }),
    ];
    const pool = ['c-unknown-record', 'a-ambient-record', 'b-metal-record'];

    it('judges a record by the tracks on it', () => {
        expect(chooseAlbumsByTaste(pool, tracks, profile, {}, 3)).toEqual([
            'b-metal-record',
            'a-ambient-record',
            'c-unknown-record',
        ]);
    });

    // Rule 3 of `finish-rate.ts`, applied to a record: the counts are summed
    // and then divided. Neither of these two tracks has been started often
    // enough to say anything on its own, and together they are four abandoned
    // listens — a record this listener plainly does not sit through, which is
    // exactly what a per-track rule would have called "not enough to say".
    it('sums the record’s tracks rather than judging each of them alone', () => {
        const finish: Record<string, FinishCounts> = {
            m1: { completed: 0, starts: 2 },
            m2: { completed: 0, starts: 2 },
        };

        expect(chooseAlbumsByTaste(pool, tracks, profile, finish, 3)).toEqual([
            'a-ambient-record',
            'b-metal-record',
            'c-unknown-record',
        ]);
    });

    // The recency penalty is about tracks, and a record is what was on. An
    // album with one just-heard song on it is an album you had on.
    it('counts a record as heard when any of its tracks was', () => {
        const heardTracks = [
            ...tracks,
            song({ albumId: 'b-metal-record', genres: genres('Metal'), id: 'heard-already' }),
        ];

        expect(chooseAlbumsByTaste(pool, heardTracks, profile, {}, 3)).toEqual([
            'a-ambient-record',
            'c-unknown-record',
            'b-metal-record',
        ]);
    });

    it('leaves the pool alone when there is no history to read', () => {
        expect(chooseAlbumsByTaste(pool, tracks, emptyTasteProfile(), {}, 3)).toEqual(pool);
    });

    // Ranking records nothing came back for would order the queue by album id,
    // which is not an order anybody chose.
    it('leaves the pool alone when no tracklist could be fetched', () => {
        expect(chooseAlbumsByTaste(pool, [], profile, {}, 3)).toEqual(pool);
    });

    // A gap in the fetch must not shorten the queue: the record still gets a
    // place, at the back, where a record nothing is known about belongs.
    it('keeps a record whose tracklist is missing from the fetch', () => {
        expect(
            chooseAlbumsByTaste(['missing-record', 'b-metal-record'], tracks, profile, {}, 2),
        ).toEqual(['b-metal-record', 'missing-record']);
    });
});

describe('how wide the pool is', () => {
    it('collects several times what was asked for', () => {
        expect(infinityPoolCount(5)).toBe(5 * INFINITY_POOL_MULTIPLIER);
    });

    // The item count is a number typed into a settings field. Zero would
    // otherwise ask every strategy for nothing and collect nothing.
    it('still collects something when nothing was asked for', () => {
        expect(infinityPoolCount(0)).toBe(INFINITY_POOL_MULTIPLIER);
    });
});
