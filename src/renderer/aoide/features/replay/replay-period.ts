/**
 * The Replay screen's periods, and the arithmetic behind its numbers.
 *
 * Kept out of the component so it can be tested in node: the page is markup
 * over these results, and a window that started a day late would be a page
 * that quietly reported the wrong month with nothing to fail.
 */

export type ReplayPeriod = 'all' | 'month' | 'year';

/** In the order the segmented control shows them — the phone's order. */
export const REPLAY_PERIODS: readonly ReplayPeriod[] = ['month', 'year', 'all'];

/**
 * Where a period's window opens, in the listener's own calendar.
 *
 * Local time, not UTC: "this month" means the month on the wall, and a
 * listener in Sydney whose month began ten hours before UTC's would otherwise
 * see the first evening of it filed under last month. `all` is the epoch —
 * every event there has ever been.
 */
export const periodStart = (period: ReplayPeriod, now: Date): number => {
    switch (period) {
        case 'all':
            return 0;
        case 'month':
            return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        case 'year':
            return new Date(now.getFullYear(), 0, 1).getTime();
    }
};

/**
 * Milliseconds as hours, to one decimal. A tile reads "12.5", not
 * "12.4999", and rounding here rather than in the markup means the number on
 * screen is the number that was tested.
 */
export const hoursListened = (totalMsPlayed: number): number =>
    Math.round((totalMsPlayed / MS_PER_HOUR) * 10) / 10;

/**
 * A recap's `YYYY-MM-DD` day as a local date, for formatting.
 *
 * Not `new Date('2026-03-10')`: that string form is parsed as UTC midnight,
 * which west of Greenwich is the evening *before* — so the busiest day would
 * print one day early for anyone in the Americas.
 */
export const dayToDate = (day: string): Date => {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date);
};

const MS_PER_HOUR = 60 * 60 * 1_000;
