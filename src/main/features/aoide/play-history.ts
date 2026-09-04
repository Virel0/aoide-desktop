import type { DatabaseSync } from 'node:sqlite';

import type { CurationDatabase } from './database';

import {
    countsAsPlaySql,
    countsAsSkipSql,
    MINIMUM_SKIP_SAMPLE,
} from '/@/shared/aoide/play-definition';

/**
 * Aggregating listening history.
 *
 * What a play *is* — and what a skip is — lives in `play-definition.ts`, shared
 * with the smart-playlist evaluator so that the count printed beside a track and
 * the membership of "played more than five times" cannot disagree. Nothing in
 * this file re-types a threshold; every predicate below is one of that module's
 * fragments, interpolated.
 *
 * Read-only. Events are written through `CurationStore.record`, which is what
 * puts the row and its op in the log together.
 */

/** What is known about one track's listening history. */
export interface TrackStats {
    /**
     * The first and last events that *qualified as plays* — the same figures a
     * smart rule's `first_played` and `last_played` read. A track skipped this
     * morning and last genuinely listened to in March was last played in March,
     * which is what a listener means by the phrase and what a "not played in six
     * months" rule has to agree with.
     */
    firstPlayedAt: null | number;
    jellyfinId: string;
    lastPlayedAt: null | number;
    /**
     * The last event of any kind — plays, skips and abandoned listens alike.
     * When this track was last *on*, as opposed to last played, which is what
     * "recently played" is ordered by.
     */
    lastStartedAt: null | number;
    playCount: number;
    skipCount: number;
    /**
     * Every millisecond actually listened to, including the fragments of tracks
     * that were skipped. Time spent is time spent.
     */
    totalMsPlayed: number;
}

/**
 * A track nothing is known about. Returned rather than `undefined` so callers
 * render "0 plays" instead of branching on absence — never played and never seen
 * are the same thing to every screen that shows this.
 */
export const emptyTrackStats = (jellyfinId: string): TrackStats => ({
    firstPlayedAt: null,
    jellyfinId,
    lastPlayedAt: null,
    lastStartedAt: null,
    playCount: 0,
    skipCount: 0,
    totalMsPlayed: 0,
});

/**
 * Listening over `[from, to)`, summarised. See `PlayHistory.recap` for what
 * each figure counts and why the unattributed ones are kept.
 */
export interface Recap {
    /** The local day with the most plays, or null when there were none. */
    busiestDay: null | { day: string; playCount: number };
    distinctAlbums: number;
    distinctArtists: number;
    distinctTracks: number;
    from: number;
    to: number;
    topAlbums: RecapAlbum[];
    topArtists: RecapArtist[];
    topTracks: RecapTrack[];
    /** Every millisecond of every event in the window, skips included. */
    totalMsPlayed: number;
    totalPlays: number;
    /** Plays of tracks this device has not cached — counted, not hidden. */
    unattributedPlays: number;
}

/** One line of a recap's leaderboards. */
export interface RecapAlbum {
    album: string;
    /** The album artist where the cache has one, else the track's artist. */
    artist: string;
    playCount: number;
}

export interface RecapArtist {
    artist: string;
    playCount: number;
}

export interface RecapTrack {
    jellyfinId: string;
    playCount: number;
}

export class PlayHistory {
    private readonly db: DatabaseSync;

    /**
     * Takes the curation store's own database rather than opening a second one:
     * these aggregates join `play_events` against the `tracks` cache, and both
     * only ever exist in there.
     */
    constructor(database: CurationDatabase) {
        this.db = database.db;
    }

    /**
     * When this track was last *played*, as opposed to last on.
     *
     * A skip does not move it. That distinction is the specific disagreement
     * that motivated sharing one definition at all: a rediscovery playlist for
     * "not played in six months" and the date on a track's detail sheet have to
     * survive the same two-second skip in the same way.
     */
    lastPlayedAt(jellyfinId: string): null | number {
        return this.statsFor(jellyfinId).lastPlayedAt;
    }

    /**
     * Counts only events that qualify as plays — unlike Jellyfin's own
     * PlayCount, which counts anything that started.
     */
    playCount(jellyfinId: string): number {
        return this.statsFor(jellyfinId).playCount;
    }

    /**
     * Listening over a window, as a story: how much, of what, and when.
     *
     * The window is half-open — `from` inclusive, `to` exclusive — on
     * `startedAt`, so two adjacent windows share no event and a month's recap
     * and the year's add up rather than double-counting the boundary.
     *
     * "Play" here is the shared definition and nothing else: every count of
     * plays below is `QUALIFIES_AS_PLAY`, the same predicate the count beside a
     * track uses. `totalMsPlayed` alone counts every event, as `TrackStats`
     * does — time spent is time spent, skipped fragments included.
     *
     * Artist and album come from the local `tracks` cache. A play whose track
     * is not cached still counts as a play and still takes a place in
     * `topTracks` — it is a real listen, and Jellyfin may well still know the
     * id — but it has no artist or album to be filed under, so it is counted in
     * `unattributedPlays` instead of vanishing. Hiding them would make a busy
     * month on another device look like silence here.
     */
    recap(from: number, to: number): Recap {
        const totals = this.db
            .prepare(
                `SELECT SUM(CASE WHEN ${QUALIFIES_AS_PLAY} THEN 1 ELSE 0 END) AS totalPlays,
                        COALESCE(SUM(e.msPlayed), 0) AS totalMsPlayed,
                        COUNT(DISTINCT CASE WHEN ${QUALIFIES_AS_PLAY} THEN e.jellyfinId END) AS distinctTracks,
                        COUNT(DISTINCT CASE WHEN ${QUALIFIES_AS_PLAY} THEN t.artist END) AS distinctArtists,
                        COUNT(DISTINCT CASE WHEN ${QUALIFIES_AS_PLAY}
                              THEN t.album || char(31) || ${ALBUM_ARTIST} END) AS distinctAlbums,
                        SUM(CASE WHEN ${QUALIFIES_AS_PLAY} AND t.jellyfinId IS NULL THEN 1 ELSE 0 END) AS unattributedPlays
                 ${EVENTS_WITH_TRACK}
                 WHERE ${IN_WINDOW}`,
            )
            .get(from, to) as {
            distinctAlbums: number;
            distinctArtists: number;
            distinctTracks: number;
            totalMsPlayed: number;
            totalPlays: null | number;
            unattributedPlays: null | number;
        };

        const topTracks = this.db
            .prepare(
                `SELECT e.jellyfinId AS jellyfinId, COUNT(*) AS playCount
                 ${EVENTS_WITH_TRACK}
                 WHERE ${IN_WINDOW} AND ${QUALIFIES_AS_PLAY}
                 GROUP BY e.jellyfinId
                 ORDER BY playCount DESC, e.jellyfinId
                 LIMIT ?`,
            )
            .all(from, to, RECAP_TOP_LIMIT) as Array<{ jellyfinId: string; playCount: number }>;

        const topArtists = this.db
            .prepare(
                `SELECT t.artist AS artist, COUNT(*) AS playCount
                 ${EVENTS_WITH_TRACK}
                 WHERE ${IN_WINDOW} AND ${QUALIFIES_AS_PLAY} AND t.jellyfinId IS NOT NULL
                 GROUP BY t.artist
                 ORDER BY playCount DESC, t.artist
                 LIMIT ?`,
            )
            .all(from, to, RECAP_TOP_LIMIT) as Array<{ artist: string; playCount: number }>;

        const topAlbums = this.db
            .prepare(
                `SELECT t.album AS album, ${ALBUM_ARTIST} AS artist, COUNT(*) AS playCount
                 ${EVENTS_WITH_TRACK}
                 WHERE ${IN_WINDOW} AND ${QUALIFIES_AS_PLAY} AND t.jellyfinId IS NOT NULL
                 GROUP BY t.album, ${ALBUM_ARTIST}
                 ORDER BY playCount DESC, t.album, artist
                 LIMIT ?`,
            )
            .all(from, to, RECAP_TOP_LIMIT) as Array<{
            album: string;
            artist: string;
            playCount: number;
        }>;

        // The listener's own day, not UTC's: a late-night session belongs to
        // the evening it started. Ties go to the earlier day, so the answer is
        // the same on every refresh.
        const busiestDay = this.db
            .prepare(
                `SELECT date(e.startedAt / 1000, 'unixepoch', 'localtime') AS day,
                        COUNT(*) AS playCount
                 ${EVENTS_WITH_TRACK}
                 WHERE ${IN_WINDOW} AND ${QUALIFIES_AS_PLAY}
                 GROUP BY day
                 ORDER BY playCount DESC, day
                 LIMIT 1`,
            )
            .get(from, to) as undefined | { day: string; playCount: number };

        return {
            busiestDay: busiestDay
                ? { day: busiestDay.day, playCount: Number(busiestDay.playCount) }
                : null,
            distinctAlbums: Number(totals.distinctAlbums),
            distinctArtists: Number(totals.distinctArtists),
            distinctTracks: Number(totals.distinctTracks),
            from,
            to,
            topAlbums: topAlbums.map((row) => ({ ...row, playCount: Number(row.playCount) })),
            topArtists: topArtists.map((row) => ({ ...row, playCount: Number(row.playCount) })),
            topTracks: topTracks.map((row) => ({ ...row, playCount: Number(row.playCount) })),
            totalMsPlayed: Number(totals.totalMsPlayed),
            totalPlays: Number(totals.totalPlays ?? 0),
            unattributedPlays: Number(totals.unattributedPlays ?? 0),
        };
    }

    /**
     * Distinct tracks, most recently started first. Includes listens that were
     * skipped or abandoned: "recently played" is a history of what was on, not a
     * leaderboard.
     *
     * The id breaks ties in the ordering. SQLite promises no row order for equal
     * keys, and a list that permutes between two identical refreshes reads as a
     * bug — and would differ from the phone's for no reason anyone could see.
     */
    recentlyPlayed(limit = 50): string[] {
        const rows = this.db
            .prepare(
                `SELECT e.jellyfinId AS jellyfinId
                 FROM play_events e
                 GROUP BY e.jellyfinId
                 ORDER BY MAX(e.startedAt) DESC, e.jellyfinId
                 LIMIT ?`,
            )
            .all(limit) as Array<{ jellyfinId: string }>;

        return rows.map((row) => row.jellyfinId);
    }

    /**
     * The share of decided outcomes that were skips, or `null` when there is not
     * enough evidence to say.
     *
     * The denominator counts plays and skips only: the "neither" band is
     * neither, and folding it in would dilute a genuine skip habit into nothing.
     * `null` rather than `0` for a thin sample, so a caller has to decide what to
     * show for "not enough listening yet" instead of printing a confident 0%.
     */
    skipRate(jellyfinId: string): null | number {
        const stats = this.statsFor(jellyfinId);
        const decided = stats.playCount + stats.skipCount;

        if (decided < MINIMUM_SKIP_SAMPLE) return null;
        return stats.skipCount / decided;
    }

    /**
     * Stats for many tracks in one query.
     *
     * Every requested id comes back, zeroed if it has no history. That is what
     * makes the per-track form below safe: a list view has no reason to fall
     * back to it for its misses, which is how one query per row happens by
     * accident.
     */
    stats(jellyfinIds: string[]): Map<string, TrackStats> {
        const found = new Map<string, TrackStats>();

        for (let start = 0; start < jellyfinIds.length; start += MAX_PARAMETERS) {
            const ids = jellyfinIds.slice(start, start + MAX_PARAMETERS);
            const rows = this.db
                .prepare(
                    `SELECT e.jellyfinId AS jellyfinId,
                            SUM(CASE WHEN ${QUALIFIES_AS_PLAY} THEN 1 ELSE 0 END) AS playCount,
                            SUM(CASE WHEN ${QUALIFIES_AS_SKIP} THEN 1 ELSE 0 END) AS skipCount,
                            COALESCE(SUM(e.msPlayed), 0) AS totalMsPlayed,
                            MIN(CASE WHEN ${QUALIFIES_AS_PLAY} THEN e.startedAt END) AS firstPlayedAt,
                            MAX(CASE WHEN ${QUALIFIES_AS_PLAY} THEN e.startedAt END) AS lastPlayedAt,
                            MAX(e.startedAt) AS lastStartedAt
                     ${EVENTS_WITH_TRACK}
                     WHERE e.jellyfinId IN (${placeholders(ids.length)})
                     GROUP BY e.jellyfinId`,
                )
                .all(...ids) as Array<{
                firstPlayedAt: null | number;
                jellyfinId: string;
                lastPlayedAt: null | number;
                lastStartedAt: null | number;
                playCount: number;
                skipCount: number;
                totalMsPlayed: number;
            }>;

            for (const row of rows) {
                found.set(row.jellyfinId, {
                    firstPlayedAt: row.firstPlayedAt,
                    jellyfinId: row.jellyfinId,
                    lastPlayedAt: row.lastPlayedAt,
                    lastStartedAt: row.lastStartedAt,
                    playCount: Number(row.playCount),
                    skipCount: Number(row.skipCount),
                    totalMsPlayed: Number(row.totalMsPlayed),
                });
            }
        }

        const stats = new Map<string, TrackStats>();
        for (const id of jellyfinIds) stats.set(id, found.get(id) ?? emptyTrackStats(id));
        return stats;
    }

    /**
     * Deliberately the batched query with one id, so a count shown on a row and
     * the stats sheet behind it cannot disagree.
     */
    statsFor(jellyfinId: string): TrackStats {
        return this.stats([jellyfinId]).get(jellyfinId) ?? emptyTrackStats(jellyfinId);
    }
}

/**
 * Every aggregate reads the track cache through this one join, so the shared
 * fragments always have a `t` to take the duration from — and a LEFT join, so an
 * event whose track has not been cached yet is judged on the duration-free half
 * of the rule instead of disappearing.
 */
const EVENTS_WITH_TRACK = 'FROM play_events e LEFT JOIN tracks t ON t.jellyfinId = e.jellyfinId';

/**
 * The album's artist for a recap: the album artist when the cache knows it,
 * otherwise the track's. Grouping on the track artist alone splits a
 * compilation into one album per contributor.
 */
const ALBUM_ARTIST = 'COALESCE(t.albumArtist, t.artist)';

/**
 * A recap's window, bound as `(from, to)` in that order. Half-open on
 * `startedAt`: an event exactly at `to` belongs to the next window.
 */
const IN_WINDOW = 'e.startedAt >= ? AND e.startedAt < ?';

/**
 * How many entries each of a recap's leaderboards carries. Ten is what fits a
 * screen without scrolling and what the phone's Replay shows.
 */
export const RECAP_TOP_LIMIT = 10;

/**
 * How many ids go into one `IN (...)` list.
 *
 * The SQLite that Node ships caps host parameters at 32766, and a "stats for
 * everything on screen" call is nowhere near it — but a whole-library call is,
 * and the failure would appear only on somebody else's larger library. 400 is
 * `HistorySQL.maxParameters` on the phone, so both clients page the same way.
 *
 * Exported so a test can stand a list past the cap against it and prove the
 * chunking is load-bearing. A number nothing asserts against drifts, and this
 * one drifts silently until it is somebody else's library that fails.
 */
export const MAX_PARAMETERS = 400;

/** Qualifies as a play, against `EVENTS_WITH_TRACK`'s aliases. */
const QUALIFIES_AS_PLAY = countsAsPlaySql('t', 'e');

/**
 * Qualifies as a skip, against the same aliases.
 *
 * Recomputed rather than read straight off `e.skipped`, for the reason spelled
 * out in `play-definition.ts`: the flag is authoritative when it is set, but an
 * event the classifier never saw — imported history, or a row synced from an
 * older build — carries `0` and still has to be judged on its numbers. Reading
 * the column alone would report those as never skipped while the play count
 * judged them properly, and the two figures sit next to each other on screen.
 */
const QUALIFIES_AS_SKIP = countsAsSkipSql('t', 'e');

const placeholders = (count: number): string => new Array(count).fill('?').join(', ');
