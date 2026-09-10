import { describe, expect, it } from 'vitest';

import {
    countsAsFinishSql,
    countsAsStartSql,
    emptyFinishCounts,
    finishRate,
    finishRateOf,
    finishRatePercent,
    MINIMUM_FINISH_SAMPLE,
    totalFinishCounts,
} from './finish-rate';

describe('the sample floor', () => {
    // The figure's whole claim is to be honest where a server is not, and the
    // fastest way to lose that is to print "you finish 0% of this" at somebody
    // who skipped one song once.
    it('says nothing below three starts, however the few went', () => {
        expect(finishRate({ completed: 0, starts: 0 })).toBeUndefined();
        expect(finishRate({ completed: 1, starts: 1 })).toBeUndefined();
        expect(finishRate({ completed: 0, starts: 2 })).toBeUndefined();
        expect(finishRate({ completed: 2, starts: 2 })).toBeUndefined();
    });

    it('speaks at exactly three', () => {
        expect(finishRate({ completed: 2, starts: 3 })).toBeCloseTo(2 / 3);
        expect(finishRate({ completed: 0, starts: 3 })).toBe(0);
        expect(finishRate({ completed: 3, starts: 3 })).toBe(1);
    });

    // The threshold is not written anywhere else — a screen comparing against
    // its own 3 would be the second copy, and the two would part company the
    // day this changes.
    it('is the exported constant, and it is three', () => {
        expect(MINIMUM_FINISH_SAMPLE).toBe(3);
        expect(finishRate({ completed: 1, starts: MINIMUM_FINISH_SAMPLE - 1 })).toBeUndefined();
        expect(finishRate({ completed: 1, starts: MINIMUM_FINISH_SAMPLE })).toBeDefined();
    });
});

describe('aggregating a collection', () => {
    /**
     * The failure this rule exists to prevent, with the numbers spelled out.
     *
     * A hit played eighty times and finished sixty, and a closing track opened
     * three times and finished once. Summed: 61 of 83, which is 73%. Averaged:
     * the mean of 75% and 33%, which is 54% — because averaging hands the
     * track played three times the same weight as the one played eighty.
     */
    const hit = { completed: 60, starts: 80 };
    const closer = { completed: 1, starts: 3 };

    it('sums the counts and then divides', () => {
        expect(totalFinishCounts([hit, closer])).toEqual({ completed: 61, starts: 83 });
        expect(finishRateOf([hit, closer])).toBeCloseTo(61 / 83);
        expect(finishRatePercent(totalFinishCounts([hit, closer]))).toBe(73);
    });

    // Stated as an inequality rather than left implied: if these two ever
    // agreed, this test would pass while the code did the wrong thing.
    it('differs from the mean of the per-track rates', () => {
        const mean =
            [hit, closer].reduce((sum, one) => sum + one.completed / one.starts, 0) /
            [hit, closer].length;

        expect(Math.round(mean * 100)).toBe(54);
        expect(finishRateOf([hit, closer])).not.toBeCloseTo(mean);
    });

    // Ten tracks started twice each is twenty starts, and a listener who has
    // played a record ten times over has plainly formed a habit with it even
    // though no single song clears the floor on its own.
    it('applies the floor to the total, not to each track', () => {
        const thin = new Array(10).fill({ completed: 1, starts: 2 });

        for (const one of thin) expect(finishRate(one)).toBeUndefined();
        expect(finishRateOf(thin)).toBe(0.5);
    });

    it('adds up to nothing for an empty collection, and says nothing about it', () => {
        expect(totalFinishCounts([])).toEqual(emptyFinishCounts());
        expect(finishRateOf([])).toBeUndefined();
    });

    it('does not mutate what it is given', () => {
        const one = { completed: 2, starts: 4 };
        totalFinishCounts([one, one]);
        expect(one).toEqual({ completed: 2, starts: 4 });
    });
});

describe('the printed percentage', () => {
    it('rounds to a whole number', () => {
        expect(finishRatePercent({ completed: 7, starts: 9 })).toBe(78);
        expect(finishRatePercent({ completed: 1, starts: 3 })).toBe(33);
    });

    it('has nothing to print below the floor', () => {
        expect(finishRatePercent({ completed: 1, starts: 2 })).toBeUndefined();
    });
});

describe('the SQL says the same thing as the arithmetic', () => {
    // Both halves are guarded by the same open-event test, which is what makes
    // `completed <= starts` a property of the numbers rather than a promise
    // about this build's writers. A rate over 100% on a detail page is the kind
    // of thing that gets screenshotted.
    it('counts a finish only among decided events', () => {
        expect(countsAsFinishSql('e')).toContain('e.completed = 1');
        expect(countsAsFinishSql('e')).toContain('e.endedAt IS NOT NULL');
    });

    it('counts a start as a decided event and nothing else', () => {
        expect(countsAsStartSql('e')).toBe('e.endedAt IS NOT NULL');
    });

    it('takes the event alias it is given', () => {
        expect(countsAsStartSql('ev')).toBe('ev.endedAt IS NOT NULL');
        expect(countsAsFinishSql('ev')).toContain('ev.completed = 1');
    });
});
