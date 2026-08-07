import { describe, expect, it } from 'vitest';

import {
    classify,
    COMPLETION_TOLERANCE_MS,
    MINIMUM_SKIP_SAMPLE,
    playThreshold,
    SCROBBLE_CEILING_MS,
    skipThreshold,
    THRESHOLD_CROSSOVER_MS,
} from './play-definition';

/**
 * The boundaries, walked one millisecond at a time.
 *
 * These numbers are the contract with the phone, not an implementation detail:
 * both clients aggregate the same synced events, so a threshold that is one
 * millisecond out here shows a different play count on the desktop than on the
 * phone for the same listening. Every case below therefore asserts the *number*
 * as well as the verdict — a test that only checked "45 s counts as a play"
 * would pass just as happily against a threshold of 44 s.
 */

/** Durations chosen to exercise both halves of the rule and both fallbacks. */
const boundaries = [
    {
        // Half of it binds: 45 s is well under the four-minute ceiling.
        duration: 90_000,
        play: 45_000,
        skip: 18_000,
        what: 'a short track, where half of it is the binding threshold',
    },
    {
        // The ceiling binds: half of ten minutes is five, and four is less.
        duration: 600_000,
        play: 240_000,
        skip: 120_000,
        what: 'a long track, where the four-minute ceiling binds',
    },
    {
        // Taken literally, "half of nothing" would make `msPlayed >= 0` a play,
        // and every unparsed file in a library would score one for having been
        // looked at. It routes to the ceiling instead.
        duration: 0,
        play: 240_000,
        skip: 48_000,
        what: 'a zero-length track, which must not be a play for being looked at',
    },
    {
        duration: null,
        play: 240_000,
        skip: 48_000,
        what: 'a track with no duration at all',
    },
];

describe('the thresholds', () => {
    for (const { duration, play, skip, what } of boundaries) {
        describe(what, () => {
            it('sits exactly where the phone puts it', () => {
                expect(playThreshold(duration)).toBe(play);
                expect(skipThreshold(duration)).toBe(skip);
            });

            it('does not count a play one millisecond short of the play threshold', () => {
                expect(classify(play - 1, duration).countsAsPlay).toBe(false);
            });

            it('counts a play on the exact millisecond', () => {
                expect(classify(play, duration).countsAsPlay).toBe(true);
            });

            it('counts a skip one millisecond short of the skip threshold', () => {
                expect(classify(skip - 1, duration).skipped).toBe(true);
            });

            it('stops counting a skip on the exact millisecond', () => {
                expect(classify(skip, duration).skipped).toBe(false);
            });

            it('leaves a neither-band between the two', () => {
                const between = classify(skip, duration);
                expect(between.countsAsPlay).toBe(false);
                expect(between.skipped).toBe(false);
            });
        });
    }

    it('treats an undefined duration exactly as a null one', () => {
        expect(playThreshold(undefined)).toBe(playThreshold(null));
        expect(skipThreshold(undefined)).toBe(skipThreshold(null));
    });

    // Swift and SQLite both truncate integer division; JavaScript's `/` does
    // not. Half of an odd duration is exactly the half-millisecond that would
    // decide a boundary case one way on the phone and the other way here, and
    // nothing downstream would ever show that it had.
    it('truncates rather than dividing, so half of an odd duration is an integer', () => {
        expect(playThreshold(45_001)).toBe(22_500);
        expect(skipThreshold(45_001)).toBe(9_000);
        expect(playThreshold(90_001)).toBe(45_000);
        expect(skipThreshold(90_003)).toBe(18_000);
    });

    it('takes the truncated half as a play, not the rounded-up one', () => {
        expect(classify(22_500, 45_001).countsAsPlay).toBe(true);
    });

    it('hands over to the ceiling at exactly eight minutes', () => {
        // One millisecond either side of the duration at which half the track
        // and four minutes are the same number.
        expect(playThreshold(479_999)).toBe(239_999);
        expect(playThreshold(480_000)).toBe(SCROBBLE_CEILING_MS);
        expect(playThreshold(480_001)).toBe(SCROBBLE_CEILING_MS);
    });
});

describe('the skip-rate sample', () => {
    // Every other use of this constant is relative — `MINIMUM_SKIP_SAMPLE - 1`
    // is "one short of enough" whatever the number is — so it could fall to two
    // with nothing failing anywhere, and two decided outcomes is exactly the
    // phone call this threshold exists to refuse to call a habit. Pinned to the
    // literal the phone uses, like every other number in this file.
    it('is the five outcomes the phone asks for', () => {
        expect(MINIMUM_SKIP_SAMPLE).toBe(5);
    });
});

describe('reaching the end', () => {
    it('allows the elapsed time to fall short by the tolerance, and no further', () => {
        const duration = 200_000;
        const short = duration - COMPLETION_TOLERANCE_MS;

        expect(classify(short - 1, duration).completed).toBe(false);
        expect(classify(short, duration).completed).toBe(true);
    });

    it('counts a completed track as a play however little of it was reported', () => {
        // A gapless crossfade or trimmed trailing silence ends a track for real
        // while leaving the elapsed figure short, so the player gets to say so.
        const outcome = classify(0, 600_000, true);

        expect(outcome.completed).toBe(true);
        expect(outcome.countsAsPlay).toBe(true);
        expect(outcome.skipped).toBe(false);
    });

    it('believes an explicit false from the player over the arithmetic', () => {
        // `??`, not `||`. A player saying "this did not finish" about a listen
        // whose elapsed time reached the duration is reporting something it
        // knows and the numbers do not.
        expect(classify(600_000, 600_000, false).completed).toBe(false);
    });

    it('cannot reach the end of a track whose length is unknown', () => {
        expect(classify(10_000_000, null).completed).toBe(false);
        expect(classify(10_000_000, 0).completed).toBe(false);
    });

    it('still counts a long listen to an unknown-length track as a play', () => {
        // The fallback under-counts rather than inventing a duration, but four
        // minutes is a play whatever the track turns out to be.
        expect(classify(SCROBBLE_CEILING_MS, null).countsAsPlay).toBe(true);
    });
});

describe('the three outcomes', () => {
    const durations: Array<null | number> = [
        null,
        0,
        89_999,
        90_000,
        180_000,
        200_000,
        600_000,
        1_200_000,
    ];
    const listens = [
        0, 1, 17_999, 18_000, 29_999, 30_000, 44_999, 45_000, 47_999, 48_000, 89_999, 90_000,
        99_999, 100_000, 119_999, 120_000, 239_999, 240_000, 300_000, 600_000, 1_200_000,
    ];

    it('never calls one listen both a play and a skip, up to the crossover', () => {
        for (const duration of durations) {
            for (const played of listens) {
                const outcome = classify(played, duration);
                expect(
                    outcome.countsAsPlay && outcome.skipped,
                    `duration ${duration}, played ${played}`,
                ).toBe(false);
            }
        }
    });

    it('keeps the middle band reachable', () => {
        // If the two thresholds ever met, every listen would be a play or a
        // skip, and a third of a track would start slandering the track.
        const neither = listens.filter((played) => {
            const outcome = classify(played, 200_000);
            return !outcome.countsAsPlay && !outcome.skipped;
        });

        expect(neither.length).toBeGreaterThan(0);
    });

    /**
     * Past twenty minutes the thresholds cross: the play threshold is pinned at
     * the four-minute ceiling while the skip threshold keeps growing with the
     * duration, so five minutes of a half-hour set is over one and under the
     * other. This pins that as reproduced-from-the-phone behaviour rather than
     * leaving it to be discovered — `PlayDefinition.swift` documents the two as
     * disjoint and its own boundary tests stop at exactly the crossover, so
     * nothing on either platform has ever exercised it.
     *
     * `countsAsPlay` is advisory and never stored; what a screen shows comes
     * from the SQL, which honours the stored `skipped` flag and therefore counts
     * this once, as a skip. `play-history.test.ts` pins that half.
     */
    it('reproduces the phone, overlap and all, past the twenty-minute crossover', () => {
        expect(THRESHOLD_CROSSOVER_MS).toBe(1_200_000);
        expect(playThreshold(THRESHOLD_CROSSOVER_MS)).toBe(skipThreshold(THRESHOLD_CROSSOVER_MS));

        const halfHour = 1_800_000;
        const outcome = classify(300_000, halfHour);

        expect(playThreshold(halfHour)).toBe(240_000);
        expect(skipThreshold(halfHour)).toBe(360_000);
        expect(outcome.countsAsPlay).toBe(true);
        expect(outcome.skipped).toBe(true);
    });
});
