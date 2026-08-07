/**
 * What a play is, and what a skip is — in one place, in both languages that need
 * them.
 *
 * Jellyfin increments its PlayCount the moment playback *starts*, so a
 * four-second skip counts there exactly as much as a full listen. Everything
 * here exists to be honest where that is not.
 *
 * Two consumers on this device must never disagree. `play-history` asks in SQL
 * for the count printed beside a track; the smart-playlist evaluator asks in SQL
 * for the membership of "played more than five times". A threshold differing
 * between them by a second makes those two answers contradict each other on
 * screen, and that does not present as a bug worth investigating — it presents
 * as the app being vaguely wrong about you.
 *
 * And it must not disagree with the **phone**, which is the harder half. This is
 * a reimplementation of `CurationKit/PlayDefinition.swift`, constant for
 * constant and boundary millisecond for boundary millisecond, because both
 * clients aggregate the same synced `play_events` rows. Two implementations of
 * this rule have already been written that differed in five cases while both
 * passed their own tests; the symptom is a smart playlist listing different
 * songs than the play count printed beside them, and nobody ever tracks that
 * down. So the classifier that *writes* the flags and the SQL that *recomputes*
 * them are built from the same named constants below, and there is a test
 * standing on the exact boundary millisecond of each.
 */

/**
 * How far short of the duration the reported elapsed time may land and still
 * count as reaching the end.
 *
 * The player's last elapsed reading routinely stops a beat before the asset
 * duration — the end-of-item notification fires while the final buffer is still
 * draining — and treating a 300 ms shortfall as "did not finish" would file most
 * complete listens under "neither". Generous on purpose: the only thing it costs
 * is calling a 98%-finished listen finished, which it was.
 */
export const COMPLETION_TOLERANCE_MS = 1_500;

/**
 * The smallest number of decided outcomes that makes a skip *rate* mean
 * anything.
 *
 * One skip out of one play is not a 100% skip rate in any useful sense; it is a
 * phone call. Five is the point where a single outcome moves the figure by 20
 * points rather than 50 or 100, and it is reached inside a couple of sessions
 * for anything the listener actually plays.
 */
export const MINIMUM_SKIP_SAMPLE = 5;

/**
 * The fractional half of the rule. Both divisors are named because the SQL below
 * interpolates them into expressions that have to reach the same verdict; a
 * literal in either place would let the two drift apart in silence.
 */
export const PLAY_DIVISOR = 2;

/**
 * The ceiling half of the rule. Four minutes of listening is a play however long
 * the track is.
 *
 * The pair — half the track, or four minutes, whichever comes first — is the
 * long-standing scrobbling convention, and it is two numbers rather than one
 * because neither survives a real library alone. A fixed threshold counts a
 * 90-second punk song after a third of it and a 12-minute krautrock track after
 * 4% of it, so identical listener behaviour scores wildly differently depending
 * only on genre. A pure fraction is no better at the long end: nobody sits
 * through six minutes of a twelve-minute track by accident, and demanding it
 * would leave the entire long-form half of a library permanently under-counted.
 */
export const SCROBBLE_CEILING_MS = 4 * 60 * 1_000;

/**
 * Below a fifth of a track, the listener rejected it. Set well under the play
 * threshold on purpose: the gap between the two is the "neither" band, and a
 * skip should mean an unambiguous one.
 */
export const SKIP_DIVISOR = 5;

/**
 * What a finished play amounted to.
 *
 * Three outcomes, not two: a play, a skip, and the middle where somebody
 * listened to a third of a track and moved on. That middle is deliberately
 * counted as neither — inflating it into a play makes play counts meaningless,
 * and calling it a skip slanders a track the listener was not rejecting.
 */
export interface PlayOutcome {
    /** The track reached its end rather than being skipped away from. */
    completed: boolean;
    /**
     * Qualifies as a play for counting purposes. Not a stored column — see the
     * SQL section below for why it is recomputed instead.
     */
    countsAsPlay: boolean;
    skipped: boolean;
}

/**
 * Classify a finished play.
 *
 * `completed` is an override for the player, which knows things the numbers do
 * not: a gapless crossfade or trimmed trailing silence ends a track for real
 * while leaving elapsed time short. Omitting it infers the answer from the
 * figures.
 */
export const classify = (
    msPlayed: number,
    trackDurationMs: null | number | undefined,
    completed?: boolean,
): PlayOutcome => {
    const duration = trackDurationMs ?? 0;

    // `??` rather than `||`: an explicit `false` from the player is a verdict —
    // it saw the asset end early and says this listen did not finish — and `||`
    // would throw it away and re-derive the answer from the elapsed time.
    //
    // With no duration and no word from the player there is nothing to have
    // reached the end *of*. Guessing here would invent plays out of silence.
    const reachedEnd =
        completed ?? (duration > 0 ? msPlayed >= duration - COMPLETION_TOLERANCE_MS : false);

    return {
        completed: reachedEnd,
        countsAsPlay: reachedEnd || msPlayed >= playThreshold(trackDurationMs),
        skipped: !reachedEnd && msPlayed < skipThreshold(trackDurationMs),
    };
};

/**
 * A play needs at least this much listening, in milliseconds.
 *
 * `Math.floor`, not plain division: Swift and SQLite both divide integers by
 * truncating, JavaScript does not, and half of an odd duration is exactly the
 * sort of half-millisecond that decides a boundary case one way on the phone and
 * the other way here. The duration is positive on this branch, so flooring and
 * truncating are the same operation.
 *
 * An unknown duration falls back to the ceiling alone — the only half of the
 * rule that does not need one. It errs towards under-counting rather than
 * inventing a duration, and it is rare: the duration comes from the same track
 * metadata the player needed in order to start.
 */
export const playThreshold = (trackDurationMs: null | number | undefined): number => {
    if (trackDurationMs === null || trackDurationMs === undefined || trackDurationMs <= 0) {
        return SCROBBLE_CEILING_MS;
    }
    return Math.min(Math.floor(trackDurationMs / PLAY_DIVISOR), SCROBBLE_CEILING_MS);
};

/**
 * Below this much listening the track was skipped. With no duration, the same
 * fifth is taken of the ceiling instead — 48 seconds — so the fallback stays
 * derived from the rule rather than being a third invented number.
 *
 * A duration of zero routes here too, and that is the whole reason this is a
 * branch rather than arithmetic. Taken literally, zero would make `msPlayed >= 0`
 * a play, so every zero-length or unparsed file in a library would score a play
 * apiece merely for having been looked at.
 */
export const skipThreshold = (trackDurationMs: null | number | undefined): number => {
    if (trackDurationMs === null || trackDurationMs === undefined || trackDurationMs <= 0) {
        return Math.floor(SCROBBLE_CEILING_MS / SKIP_DIVISOR);
    }
    return Math.floor(trackDurationMs / SKIP_DIVISOR);
};

/*
 * The SQL side.
 *
 * **Why recompute at all, when the classifier already ran?** Because a
 * `play_events` row has room for two booleans and there are three outcomes.
 * `completed` and `skipped` can say "finished" and "rejected", but the pair
 * `(0, 0)` cannot distinguish "played enough to count" from the neither-band
 * from an event that was never finished at all. Adding a third column would
 * change the synced payload of an append-only table to store something already
 * derivable from what is in it.
 *
 * **Why consult the stored flags at all, when the thresholds can be
 * recomputed?** Because the classifier ran with the duration the *player* had,
 * and this SQL runs with the duration the *local track cache* has, and those can
 * disagree — a stale cache row, a different encode, a rescan in flight. When
 * they disagree the player was right: it had the actual asset open. So a stored
 * verdict is honoured where it is decisive, and the thresholds only decide the
 * cases the flags leave open.
 *
 * That is also what makes these fragments correct for events the classifier
 * never touched — imported history, and rows synced from a device running an
 * older build — which carry `(0, 0)` and must still be judged on their numbers.
 *
 * The duration is read through a LEFT join to the `tracks` cache, so a missing
 * row falls back to the duration-free half of the rule rather than dropping the
 * event: an uncached track listened to for four minutes still counts, instead of
 * vanishing because the library scan had not run yet.
 */

/**
 * Counts towards a play count.
 *
 * `skipped = 1` vetoes the threshold arm: that flag is the player's verdict,
 * made with the real duration, and it is the whole reason a stale cache entry
 * cannot inflate a rejected track into a played one. A stored `completed = 1`
 * needs no such guarding and no `endedAt` — it is already an explicit verdict,
 * and the only thing that could overturn it is arithmetic on a duration this
 * side trusts less.
 */
export const countsAsPlaySql = (track: string, event = 'e'): string =>
    `(${event}.completed = 1
      OR (${event}.skipped = 0 AND ${hasOutcomeSql(event)}
          AND ${event}.msPlayed >= ${playThresholdSql(track)}))`;

/**
 * Counts towards a skip count.
 *
 * Disjoint from `countsAsPlaySql` for every track up to twenty minutes, which is
 * the property that makes the two counts safe to display side by side: a play
 * arrives either through `completed = 1`, which this excludes outright, or
 * through a threshold at or above the skip threshold. Beyond twenty minutes the
 * two thresholds cross — a fifth of half an hour is six minutes, above the
 * four-minute ceiling — and a listen can satisfy both. `classify` has the same
 * crossover, deliberately, because the phone does; see the note on
 * `THRESHOLD_CROSSOVER_MS`.
 */
export const countsAsSkipSql = (track: string, event = 'e'): string =>
    `(${event}.completed = 0
      AND (${event}.skipped = 1
           OR (${hasOutcomeSql(event)} AND ${event}.msPlayed < ${skipThresholdSql(track)})))`;

/**
 * An event that was opened and never closed: playback started, the row was
 * written, and nothing ever finished it because the app was killed mid-track. It
 * carries `msPlayed = 0`, `completed = 0`, `skipped = 0` — figures that describe
 * nothing that happened.
 *
 * Judging one by its numbers would read every killed listen as a zero-millisecond
 * skip, and the tracks it happens to are the *long* ones, so the app would
 * systematically record the listener rejecting exactly the albums they sat
 * through. Its outcome is unknown, and unknown is neither. `endedAt` is what
 * says so: every path that finishes an event sets it, and only the one that
 * opens an event leaves it null.
 */
export const hasOutcomeSql = (event = 'e'): string => `${event}.endedAt IS NOT NULL`;

/**
 * `playThreshold`, for SQLite.
 *
 * `MIN` here is SQLite's two-argument *scalar* minimum, not the aggregate — the
 * two are told apart by arity alone, and these fragments are routinely nested
 * inside a real `SUM(...)` or `MAX(...)`. `tracks.durationMs` is an INTEGER
 * column, so SQLite's `/` truncates there exactly as `Math.floor` does above,
 * and interpolating the same constants reproduces the threshold to the
 * millisecond rather than merely close to it.
 *
 * The `CASE` is what keeps NULL out of the arithmetic. Spelling the rule as
 * `msPlayed * 2 >= durationMs OR msPlayed >= ceiling` is algebraically the
 * same thing and looks tidier, but it quietly changes the answer for a cached
 * duration of exactly `0`: `msPlayed * 2 >= 0` is true for every event, so a
 * library of zero-length or unparsed files would score a play apiece for having
 * been looked at.
 */
export const playThresholdSql = (track: string): string =>
    `CASE WHEN ${track}.durationMs IS NULL OR ${track}.durationMs <= 0
          THEN ${SCROBBLE_CEILING_MS}
          ELSE MIN(${track}.durationMs / ${PLAY_DIVISOR}, ${SCROBBLE_CEILING_MS}) END`;

/**
 * `skipThreshold`, for SQLite. The fallback is computed from the same two
 * constants rather than written out, so the number cannot be edited in one
 * language only.
 */
export const skipThresholdSql = (track: string): string =>
    `CASE WHEN ${track}.durationMs IS NULL OR ${track}.durationMs <= 0
          THEN ${Math.floor(SCROBBLE_CEILING_MS / SKIP_DIVISOR)}
          ELSE ${track}.durationMs / ${SKIP_DIVISOR} END`;

/**
 * The duration at which the play and skip thresholds meet: twenty minutes, where
 * a fifth of the track and the four-minute ceiling are both 240 s.
 *
 * Not used by the rule — recorded because it is the edge of the rule's tidy
 * behaviour, and finding it by surprise is expensive. Below it the two outcomes
 * are mutually exclusive. Above it the skip threshold keeps growing while the
 * play threshold is pinned at the ceiling, so a 30-minute DJ set listened to for
 * five minutes is over the play threshold *and* under the skip threshold, and
 * `classify` reports both. The stored flags then settle it: the classifier
 * writes `skipped = 1, completed = 0`, and `countsAsPlaySql` lets `skipped = 1`
 * veto the threshold arm, so such an event counts once as a skip. An event that
 * never met the classifier — imported, or from an older build — carries `(0, 0)`
 * and is counted as both, exactly as `classify` describes it.
 *
 * That is faithful to `PlayDefinition.swift`, whose own boundary tests stop at
 * exactly twenty minutes and so never reach it. Changing it here alone would
 * make a long-form library score differently on the two devices, which is the
 * one failure this file exists to prevent — it is a change for both clients or
 * neither.
 */
export const THRESHOLD_CROSSOVER_MS = SCROBBLE_CEILING_MS * SKIP_DIVISOR;
