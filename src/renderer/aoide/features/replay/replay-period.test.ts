import { describe, expect, it } from 'vitest';

import { dayToDate, hoursListened, periodStart, REPLAY_PERIODS } from './replay-period';

describe('where a period starts', () => {
    // Mid-month, mid-afternoon, so a window that opened at "now" or at
    // midnight today would be caught as well as one that opened a month off.
    const now = new Date(2026, 8, 17, 15, 42, 7, 300);

    it('opens this month at local midnight on the first', () => {
        expect(new Date(periodStart('month', now))).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    });

    it('opens this year at local midnight on 1 January', () => {
        expect(new Date(periodStart('year', now))).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0));
    });

    it('opens all time at the epoch', () => {
        expect(periodStart('all', now)).toBe(0);
    });

    it('offers the three periods in the phone’s order', () => {
        expect(REPLAY_PERIODS).toEqual(['month', 'year', 'all']);
    });
});

describe('hours listened', () => {
    it('is zero for nothing', () => {
        expect(hoursListened(0)).toBe(0);
    });

    it('rounds to one decimal', () => {
        expect(hoursListened(90 * 60 * 1_000)).toBe(1.5);
        expect(hoursListened(3_599_999)).toBe(1);
        expect(hoursListened(3_780_000)).toBe(1.1);
    });
});

describe('a recap day as a date', () => {
    // Parsed as *local* components. `new Date('2026-03-10')` would be UTC
    // midnight, which is 9 March in every zone west of Greenwich.
    it('lands on the named local day', () => {
        const date = dayToDate('2026-03-10');
        expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 2, 10]);
        expect(date.getHours()).toBe(0);
    });
});
