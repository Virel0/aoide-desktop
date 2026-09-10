import { describe, expect, it } from 'vitest';

import type { FinishCounts } from './finish-rate';
import type { TasteCandidate, TasteProfile } from './taste-ranking';

import { parseTasteProfile, rankByTaste, tasteScore } from './taste-ranking';

/**
 * The same sixteen candidates the iOS app scores, with the same sixteen scores
 * and the same one order.
 *
 * "Both apps choose the same way" is a claim, and this table is the only thing
 * that makes it one: it is duplicated verbatim in `TasteRankingParityTests` in
 * Packages/CurationKit, so either side changing a weight, the sample floor it
 * borrows from the finish rate, the lower-casing or the tie-break breaks its
 * own copy. The scores are exact numbers rather than an ordering on purpose —
 * two rankers that agree on today's library and disagree by a hundredth are
 * still two rankers, and they will part company on somebody else's.
 *
 * Rounded to six places, and both sides round: the arithmetic is IEEE doubles
 * in both languages and lands on the same bits, but a table full of
 * 0.15000000000000002 tells a reader nothing about the rule it is pinning.
 */

const PROFILE: TasteProfile = parseTasteProfile({
    artists: { perturbator: 0.4, sabaton: 1 },
    genres: { electronic: 0.5, metal: 1 },
    recent: ['heard-an-hour-ago'],
});

const TABLE: Array<{
    artist: string;
    finish?: FinishCounts;
    genres: string[];
    id: string;
    score: number;
    why: string;
}> = [
    {
        artist: 'Nobody',
        genres: ['Metal'],
        id: 'metal-stranger',
        score: 0.45,
        why: 'a favourite genre is most of what there is to earn',
    },
    {
        artist: 'Nobody',
        genres: ['Ambient'],
        id: 'ambient-stranger',
        score: 0,
        why: 'an unfamiliar genre earns nothing, and is not held against a track',
    },
    {
        artist: 'Nobody',
        genres: ['METAL'],
        id: 'shouted-genre',
        score: 0.45,
        why: 'a genre matches however it was capitalised',
    },
    {
        artist: 'SABATON',
        genres: [],
        id: 'shouted-artist',
        score: 0.3,
        why: 'so does an artist',
    },
    {
        artist: 'Nobody',
        genres: ['Electronic', 'Electronic', 'Electronic', 'Electronic'],
        id: 'four-times-electronic',
        score: 0.225,
        why: 'four genres are not four times as relevant as the right one',
    },
    {
        artist: 'Nobody',
        genres: ['Ambient', 'Metal', 'Electronic'],
        id: 'mixed-tags',
        score: 0.45,
        why: 'the best match counts wherever in the tags it sits',
    },
    {
        artist: 'Sabaton',
        finish: { completed: 10, starts: 10 },
        genres: ['Metal'],
        id: 'favourite-everything',
        score: 1.05,
        why: 'the favourite artist, the favourite genre and always finished is the top of the scale',
    },
    {
        artist: 'Nobody',
        finish: { completed: 0, starts: 10 },
        genres: ['Metal'],
        id: 'always-skipped',
        score: 0.15,
        why: 'a track you never finish sinks, but its genre still counts for it',
    },
    {
        artist: 'Nobody',
        finish: { completed: 0, starts: 1 },
        genres: ['Metal'],
        id: 'barely-judged',
        score: 0.45,
        why: 'one skip out of one says nothing, and scores as no history at all',
    },
    {
        artist: 'Nobody',
        finish: { completed: 2, starts: 2 },
        genres: [],
        id: 'two-of-two',
        score: 0,
        why: 'two finishes out of two is still under the sample floor',
    },
    {
        artist: 'Nobody',
        finish: { completed: 3, starts: 3 },
        genres: [],
        id: 'three-of-three',
        score: 0.3,
        why: 'three is the first sample either app will speak from',
    },
    {
        artist: 'Nobody',
        finish: { completed: 0, starts: 3 },
        genres: [],
        id: 'none-of-three',
        score: -0.3,
        why: 'and it counts against a track exactly as far as it counts for one',
    },
    {
        artist: 'Nobody',
        finish: { completed: 2, starts: 3 },
        genres: [],
        id: 'two-of-three',
        score: 0.1,
        why: 'two thirds finished is a third of the way up the band',
    },
    {
        artist: 'Perturbator',
        genres: ['Electronic'],
        id: 'second-favourite',
        score: 0.345,
        why: 'a second-favourite genre and artist together still lose to a favourite genre alone',
    },
    {
        artist: 'Sabaton',
        finish: { completed: 10, starts: 10 },
        genres: ['Metal'],
        id: 'heard-an-hour-ago',
        score: -0.35,
        why: 'the best song there is, heard an hour ago, falls below the worst that has not been',
    },
    {
        artist: 'Nobody',
        genres: [],
        id: 'nothing-known',
        score: 0,
        why: 'nothing familiar and nothing measured is the middle of the scale',
    },
];

/**
 * The one order the table's sixteen come out in, best first.
 *
 * Four of them score exactly 0.45 and three exactly 0, so this pins the
 * tie-break as well as the scores: equal scores go in id order, which is what
 * makes the same library and the same history produce the same queue twice.
 */
const ORDER = [
    'favourite-everything',
    'barely-judged',
    'metal-stranger',
    'mixed-tags',
    'shouted-genre',
    'second-favourite',
    'shouted-artist',
    'three-of-three',
    'four-times-electronic',
    'always-skipped',
    'two-of-three',
    'ambient-stranger',
    'nothing-known',
    'two-of-two',
    'none-of-three',
    'heard-an-hour-ago',
];

const candidates: TasteCandidate[] = TABLE.map(({ artist, genres, id }) => ({
    artist,
    genres,
    id,
}));

const finish: Record<string, FinishCounts> = {};
for (const entry of TABLE) {
    if (entry.finish !== undefined) finish[entry.id] = entry.finish;
}

/** Six places, the way the Swift copy rounds. */
const rounded = (score: number): number => Math.round(score * 1e6) / 1e6;

describe('taste ranking parity with the iOS app', () => {
    it.each(TABLE)('$why', ({ artist, finish: counts, genres, id, score }) => {
        expect(rounded(tasteScore({ artist, genres, id }, PROFILE, counts))).toBe(score);
    });

    it('puts the whole table in one order, ties broken on id', () => {
        expect(rankByTaste(candidates, PROFILE, finish, TABLE.length).map((one) => one.id)).toEqual(
            ORDER,
        );
    });

    it('takes the best five when five are asked for', () => {
        expect(rankByTaste(candidates, PROFILE, finish, 5).map((one) => one.id)).toEqual(
            ORDER.slice(0, 5),
        );
    });

    it('asking for none gets none', () => {
        expect(rankByTaste(candidates, PROFILE, finish, 0)).toEqual([]);
    });

    it('answers every case in the table', () => {
        expect(TABLE).toHaveLength(16);
        expect(ORDER).toHaveLength(TABLE.length);
    });
});
