/**
 * Of the times you started this, how often you actually finished it.
 *
 * A number no server can produce. Jellyfin counts a play the moment playback
 * begins, so on its books every start is a finish and the figure is always
 * 100%. Aoide keeps honest events — `play-definition.ts` says what a play and a
 * skip are, and `play-history.ts` writes an explicit `completed` verdict when a
 * listen ends — so the ratio between the two is available here and nowhere
 * else.
 *
 * Everything the figure depends on lives in this file, for the same reason
 * `play-definition.ts` exists: the phone will mirror it. A threshold or an
 * aggregation rule spelled out twice drifts, and the symptom is an album that
 * says 78% on the desktop and 71% on the phone from the very same synced
 * events, which reads as the app being vaguely wrong about you rather than as a
 * bug anybody can report.
 *
 * Three rules, and they are the whole of it:
 *
 * 1. **A start is a decided listen.** An event with no `endedAt` was opened and
 *    never closed — the app was killed mid-track — and its outcome is unknown.
 *    Counting it as a start would make it a failure to finish, and the tracks it
 *    happens to are the long ones, so the app would record the listener
 *    abandoning exactly the albums they sat through.
 * 2. **Below three starts there is no figure.** One skipped listen out of one is
 *    not "you finish 0% of this"; it is one skipped listen. See
 *    `MINIMUM_FINISH_SAMPLE`.
 * 3. **An album's rate is its tracks' counts summed, then divided** — never the
 *    mean of their rates. See `totalFinishCounts`.
 */

import { hasOutcomeSql } from './play-definition';

/**
 * One thing's listening record, reduced to the two numbers the figure needs.
 *
 * Raw counts rather than a ratio, deliberately, and they travel over IPC as
 * such: an album is the sum of its tracks and an artist the sum of their
 * albums, and neither sum can be recovered from ratios that have already been
 * divided. See `totalFinishCounts` for what that would cost.
 */
export interface FinishCounts {
    /** Of those starts, the ones that reached the end. Never more than `starts`. */
    completed: number;
    /** Listens that were opened *and closed*. Events still open count for nothing. */
    starts: number;
}

/**
 * How few starts is too few to say anything.
 *
 * Two listens can only ever produce 0%, 50% or 100%, and all three read as
 * confident statements about a habit that has not happened yet. Three is the
 * first sample that can say something other than never/always/half, and it is
 * low enough that the figure appears on the records somebody actually listens
 * to rather than only on the famous ones.
 *
 * Exported because it is the only copy. Every caller asks `finishRate` rather
 * than comparing against this itself — a screen that did its own comparison
 * would be the second copy, and the two would part company on the day this
 * number changes.
 */
export const MINIMUM_FINISH_SAMPLE = 3;

/** A thing nothing is known about, which is the same as a thing never started. */
export const emptyFinishCounts = (): FinishCounts => ({ completed: 0, starts: 0 });

/**
 * Counts as a finish, for SQLite, against `play-history`'s aliases.
 *
 * Read straight off the stored column: `completed` is the classifier's explicit
 * verdict, made by `classify` with the duration the *player* had, and there is
 * nothing better to recompute it from. Note that this is not `countsAsPlaySql`
 * — a four-minute listen to a twelve-minute track is a play, and it is not a
 * finish. That difference is the entire point of the figure.
 *
 * Guarded by `hasOutcomeSql` even though every path that sets `completed` also
 * sets `endedAt`, because that guard is what makes `completed <= starts` true
 * of the numbers rather than merely true of this build's writers. A row synced
 * from another client with a verdict and no end time would otherwise push a
 * rate above 100%, and a percentage over 100 on a detail page is the kind of
 * thing that gets screenshotted.
 */
export const countsAsFinishSql = (event = 'e'): string =>
    `(${event}.completed = 1 AND ${hasOutcomeSql(event)})`;

/**
 * Counts as a start, for SQLite. An event that has been decided, whichever way
 * it was decided — which is exactly `hasOutcomeSql`, named for what it means
 * here so a reader of the query does not have to translate.
 */
export const countsAsStartSql = (event = 'e'): string => hasOutcomeSql(event);

/**
 * The share of starts that reached the end, or `undefined` when there is not
 * enough listening to say.
 *
 * `undefined` rather than `0`, and every caller has to handle it: the two
 * things a thin sample could be printed as are a confident 0% and a confident
 * 100%, and both are lies about a track played twice. The screens answer it by
 * rendering nothing at all — no dash, no empty state — because "we have not
 * watched you long enough" is not information a listener wants a slot on the
 * page for.
 */
export const finishRate = (counts: FinishCounts): number | undefined => {
    if (counts.starts < MINIMUM_FINISH_SAMPLE) return undefined;
    return counts.completed / counts.starts;
};

/**
 * The finish rate of a collection: its counts summed, then divided.
 *
 * **Not the mean of the per-track rates**, which is the same arithmetic only by
 * coincidence and is wrong in the ordinary case. An album with a hit played
 * eighty times and finished sixty, beside a closing track opened three times
 * and finished once, is a record the listener finishes 61 times out of 83 —
 * 73%. The mean of 75% and 33% is 54%, because it gives the track played three
 * times the same weight as the one played eighty. Summing first is what makes
 * the figure mean "of the times you pressed play on this record".
 *
 * The threshold then applies to the *total*, not per track, so an album of ten
 * tracks each started twice has twenty starts and does have a figure — which is
 * right: the listener has plainly formed a habit with the record even if not
 * with any one song on it.
 */
export const finishRateOf = (counts: Iterable<FinishCounts>): number | undefined =>
    finishRate(totalFinishCounts(counts));

/**
 * The whole-number percentage a screen prints, or `undefined` for a thin
 * sample.
 *
 * Rounded here rather than at each call site so the album page and the artist
 * page cannot round differently, and returned as a number so the i18n string
 * owns the "%".
 */
export const finishRatePercent = (counts: FinishCounts): number | undefined => {
    const rate = finishRate(counts);
    return rate === undefined ? undefined : Math.round(rate * 100);
};

/** Several things' records added up, as rule 3 requires. */
export const totalFinishCounts = (counts: Iterable<FinishCounts>): FinishCounts => {
    const total = emptyFinishCounts();

    for (const one of counts) {
        total.completed += one.completed;
        total.starts += one.starts;
    }

    return total;
};
