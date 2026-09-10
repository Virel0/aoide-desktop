import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { MAX_PARAMETERS, PlayHistory, RECAP_TOP_LIMIT } from './play-history';
import { contentKeyFor } from './playlists';
import { TrackFlags } from './track-flags';

import { finishRateOf, MINIMUM_FINISH_SAMPLE } from '/@/shared/aoide/finish-rate';
import {
    classify,
    COMPLETION_TOLERANCE_MS,
    MINIMUM_SKIP_SAMPLE,
    playThreshold,
    SCROBBLE_CEILING_MS,
    skipThreshold,
} from '/@/shared/aoide/play-definition';

/**
 * The cross-check.
 *
 * `classify` decides what to store when a listen ends; the SQL in
 * `play-history` decides what to print beside the track afterwards. They are two
 * expressions of one rule in two languages, and the failure mode when they drift
 * is not an exception — it is a play count of 6 next to a smart playlist that
 * refuses to include the track, which nobody can report usefully.
 *
 * So the agreement itself is what is under test here, against a real
 * `node:sqlite` database rather than a stub: SQLite's integer division and its
 * NULL handling are half of what has to match, and neither survives being
 * imitated in JavaScript.
 */

let database: CurationDatabase;
let history: PlayHistory;
let store: CurationStore;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
    history = new PlayHistory(database, store);
});

afterEach(() => database.close());

let nextEventId = 0;

const now = 1_700_000_000_000;

/** A row in the local track cache, which is where the SQL reads the duration. */
const cacheTrack = (jellyfinId: string, durationMs: null | number): void => {
    database.db
        .prepare(
            `INSERT INTO tracks (jellyfinId, contentKey, title, artist, album, durationMs, lastSeenAt)
             VALUES (?, ?, ?, 'An Artist', 'An Album', ?, ?)`,
        )
        .run(jellyfinId, jellyfinId, jellyfinId, durationMs, now);
};

const insertEvent = (event: {
    completed?: boolean;
    endedAt: null | number;
    jellyfinId: string;
    msPlayed: number;
    skipped?: boolean;
    startedAt: number;
}): void => {
    nextEventId += 1;
    database.db
        .prepare(
            `INSERT INTO play_events
             (id, jellyfinId, contentKey, startedAt, endedAt, msPlayed, completed, skipped, originDevice)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-device')`,
        )
        .run(
            `event-${nextEventId}`,
            event.jellyfinId,
            event.jellyfinId,
            event.startedAt,
            event.endedAt,
            event.msPlayed,
            Number(event.completed ?? false),
            Number(event.skipped ?? false),
        );
};

/**
 * The player's path: the classifier runs and stamps its verdict onto the row.
 * What the desktop writes when a listen ends.
 */
const playedThrough = (
    jellyfinId: string,
    msPlayed: number,
    durationMs: null | number,
    startedAt = now,
): void => {
    const outcome = classify(msPlayed, durationMs);
    insertEvent({
        completed: outcome.completed,
        endedAt: startedAt + msPlayed,
        jellyfinId,
        msPlayed,
        skipped: outcome.skipped,
        startedAt,
    });
};

/**
 * The path an import or an older build takes: a finished event carrying neither
 * verdict, which the SQL has to judge from its numbers alone.
 */
const imported = (jellyfinId: string, msPlayed: number, startedAt = now): void => {
    insertEvent({ endedAt: startedAt + msPlayed, jellyfinId, msPlayed, startedAt });
};

describe('the SQL and the classifier agree', () => {
    // The matrix the phone walks, plus one: both halves of the rule, both
    // fallbacks, and listens sitting on and either side of every boundary either
    // can produce — halves, fifths, the 240 s ceiling and the 48 s fallback
    // fifth of it. It stops at twenty minutes for the reason recorded on
    // `THRESHOLD_CROSSOVER_MS`, and the case beyond it is pinned separately
    // below rather than left out.
    //
    // The odd 89_999 is the addition, and it is the one duration here that can
    // catch a JavaScript `/` where SQLite and Swift truncate: its thresholds
    // land on 44_999 and 17_999, both of which are listens below, so a
    // half-millisecond of float division moves a verdict rather than
    // disappearing. Every duration the phone's own matrix uses is even, which is
    // exactly how that mistake would go unnoticed on both sides.
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

    const cellId = (duration: null | number, played: number): string =>
        `d${duration ?? -1}-p${played}`;

    /** One track per cell, with exactly one event, so a count is 1 or 0. */
    const matrix = (write: (id: string, played: number, duration: null | number) => void): void => {
        for (const duration of durations) {
            for (const played of listens) {
                const id = cellId(duration, played);
                cacheTrack(id, duration);
                write(id, played, duration);
            }
        }
    };

    /**
     * Both ways an event can reach the table. The stored verdict is decisive
     * where it exists and absent where it does not, so the two paths exercise
     * different arms of the same SQL and both have to land on the classifier's
     * answer.
     */
    const paths: Record<string, (id: string, played: number, duration: null | number) => void> = {
        'as an import left them, with no stored verdict': (id, played) => imported(id, played),
        'as the player wrote them': playedThrough,
    };

    for (const [what, write] of Object.entries(paths)) {
        it(`on every boundary, ${what}`, () => {
            matrix(write);

            const ids = durations.flatMap((duration) =>
                listens.map((played) => cellId(duration, played)),
            );
            const stats = history.stats(ids);

            for (const duration of durations) {
                for (const played of listens) {
                    const id = cellId(duration, played);
                    const expected = classify(played, duration);
                    const actual = stats.get(id);

                    expect(actual?.playCount, `play: ${id}`).toBe(expected.countsAsPlay ? 1 : 0);
                    expect(actual?.skipCount, `skip: ${id}`).toBe(expected.skipped ? 1 : 0);
                }
            }
        });
    }

    it('never counts one event as both a play and a skip, and keeps the middle band', () => {
        matrix(playedThrough);

        const stats = history.stats(
            durations.flatMap((duration) => listens.map((played) => cellId(duration, played))),
        );
        let neither = 0;

        for (const [id, stat] of stats) {
            expect(stat.playCount + stat.skipCount, id).toBeLessThanOrEqual(1);
            if (stat.playCount + stat.skipCount === 0) neither += 1;
        }

        expect(neither, 'the neither band collapsed; the two thresholds have met').toBeGreaterThan(
            0,
        );
    });

    /**
     * Past the twenty-minute crossover the two representations part company, and
     * this is where it shows. The classifier calls five minutes of a half-hour
     * set both a play and a skip; the SQL honours the stored `skipped` flag,
     * which vetoes the threshold arm, and counts it once — as a skip.
     *
     * Pinned rather than fixed: the phone does exactly this, and a desktop that
     * scored long-form listening differently would be the silent divergence the
     * shared definition exists to prevent.
     */
    it('resolves the post-crossover overlap the way the stored flags do', () => {
        cacheTrack('long-set', 1_800_000);
        playedThrough('long-set', 300_000, 1_800_000);

        const outcome = classify(300_000, 1_800_000);
        expect(outcome.countsAsPlay && outcome.skipped).toBe(true);

        const stats = history.statsFor('long-set');
        expect(stats.playCount).toBe(0);
        expect(stats.skipCount).toBe(1);
    });
});

describe('what the stored flags decide', () => {
    it('lets a stored skip veto a threshold the cached duration would have met', () => {
        // The classifier ran with the duration the player had; this query runs
        // with the duration the cache has. A stale cache row saying the track is
        // four seconds long would otherwise turn a three-second rejection into a
        // play, and the player was the one holding the real asset.
        cacheTrack('stale', 4_000);
        insertEvent({
            endedAt: now + 3_000,
            jellyfinId: 'stale',
            msPlayed: 3_000,
            skipped: true,
            startedAt: now,
        });

        expect(history.playCount('stale')).toBe(0);
        expect(history.statsFor('stale').skipCount).toBe(1);
    });

    it('honours a stored completion even for an event that was never closed', () => {
        cacheTrack('gapless', 600_000);
        insertEvent({
            completed: true,
            endedAt: null,
            jellyfinId: 'gapless',
            msPlayed: 0,
            startedAt: now,
        });

        expect(history.playCount('gapless')).toBe(1);
    });

    it('counts an event that was opened and never closed as neither', () => {
        // The app was killed mid-track. `msPlayed = 0, completed = 0,
        // skipped = 0` describes nothing that happened, and judging it by its
        // numbers would file every killed listen as a zero-millisecond skip —
        // of the long tracks, which are the ones it happens to.
        cacheTrack('interrupted', 600_000);
        insertEvent({ endedAt: null, jellyfinId: 'interrupted', msPlayed: 0, startedAt: now });

        const stats = history.statsFor('interrupted');
        expect(stats.playCount).toBe(0);
        expect(stats.skipCount).toBe(0);
        // It was still on, and that stays knowable.
        expect(stats.lastStartedAt).toBe(now);
    });
});

describe('a track the library scan has not reached', () => {
    // The join is a LEFT join precisely so these do not vanish. An uncached
    // track has no duration, so the duration-free half of the rule applies.
    it('counts four minutes of it as a play rather than dropping the event', () => {
        imported('uncached', 240_000);
        expect(history.playCount('uncached')).toBe(1);
    });

    it('counts a listen under the fallback fifth as a skip', () => {
        imported('uncached', 47_999);

        const stats = history.statsFor('uncached');
        expect(stats.playCount).toBe(0);
        expect(stats.skipCount).toBe(1);
    });
});

describe('last played', () => {
    const day = 86_400_000;

    // A skip on **either** side of the only real play, and the earlier one is
    // what makes this fixture worth having. With the play first, the earliest
    // event and the earliest qualifying play were the same row, so
    // `firstPlayedAt` could be computed as a plain `MIN(startedAt)` over
    // everything — dropping the filter that makes it mean "played" — and every
    // assertion here still passed.
    beforeEach(() => {
        cacheTrack('t1', 200_000);
        playedThrough('t1', 3_000, 200_000, now - 300 * day);
        playedThrough('t1', 200_000, 200_000, now - 200 * day);
        playedThrough('t1', 3_000, 200_000, now - day);
    });

    // The specific disagreement that motivated one shared definition. A track
    // played properly in March and skipped this morning was *last played* in
    // March, and a rediscovery playlist and the track's detail sheet have to say
    // so in the same breath.
    it('is not moved by a skip', () => {
        expect(history.lastPlayedAt('t1')).toBe(now - 200 * day);
    });

    it('is separate from when the track was last on', () => {
        expect(history.statsFor('t1').lastStartedAt).toBe(now - day);
    });

    it('brackets the qualifying plays only', () => {
        const stats = history.statsFor('t1');
        // A hundred days earlier than the first event, which was a skip.
        expect(stats.firstPlayedAt).toBe(now - 200 * day);
        expect(stats.lastPlayedAt).toBe(now - 200 * day);
        expect(stats.playCount).toBe(1);
        expect(stats.skipCount).toBe(2);
    });

    it('counts every millisecond listened to, including the skipped fragments', () => {
        expect(history.statsFor('t1').totalMsPlayed).toBe(206_000);
    });
});

describe('the skip rate', () => {
    const skipEvery = (jellyfinId: string, count: number): void => {
        for (let index = 0; index < count; index += 1) {
            playedThrough(jellyfinId, 1_000, 200_000, now + index);
        }
    };

    it('says nothing until there are enough decided outcomes to mean anything', () => {
        cacheTrack('thin', 200_000);
        skipEvery('thin', MINIMUM_SKIP_SAMPLE - 1);

        // One skip out of one is not a 100% skip rate; it is a phone call.
        expect(history.skipRate('thin')).toBeNull();
    });

    it('reports the share of decided outcomes on the sample it needs', () => {
        cacheTrack('decided', 200_000);
        skipEvery('decided', 4);
        playedThrough('decided', 200_000, 200_000, now + 10);

        expect(history.skipRate('decided')).toBeCloseTo(0.8, 10);
    });

    it('leaves the neither band out of the denominator', () => {
        // Four skips, one full play and one listen in the middle band. The
        // middle one dilutes nothing: it is not evidence either way.
        cacheTrack('middling', 200_000);
        skipEvery('middling', 4);
        playedThrough('middling', 200_000, 200_000, now + 10);
        playedThrough('middling', 60_000, 200_000, now + 11);

        expect(history.skipRate('middling')).toBeCloseTo(0.8, 10);
    });

    it('says nothing at all about a track with no history', () => {
        expect(history.skipRate('never-heard')).toBeNull();
    });
});

describe('recently played', () => {
    it('lists distinct tracks, most recently started first', () => {
        cacheTrack('a', 200_000);
        cacheTrack('b', 200_000);
        playedThrough('a', 200_000, 200_000, now - 1_000);
        playedThrough('b', 200_000, 200_000, now - 2_000);
        playedThrough('a', 200_000, 200_000, now);

        expect(history.recentlyPlayed()).toEqual(['a', 'b']);
    });

    it('includes what was skipped, because it is a history of what was on', () => {
        cacheTrack('rejected', 200_000);
        playedThrough('rejected', 1_000, 200_000, now);

        expect(history.recentlyPlayed()).toEqual(['rejected']);
    });

    it('respects its limit', () => {
        for (let index = 0; index < 5; index += 1) {
            cacheTrack(`track-${index}`, 200_000);
            playedThrough(`track-${index}`, 200_000, 200_000, now + index);
        }

        expect(history.recentlyPlayed(2)).toEqual(['track-4', 'track-3']);
    });
});

describe('stats', () => {
    it('returns a zeroed row for every id it has no history for', () => {
        const stats = history.stats(['never-heard', 'also-never-heard']);

        expect(stats.size).toBe(2);
        expect(stats.get('never-heard')).toMatchObject({ lastStartedAt: null, playCount: 0 });
    });

    it('asks nothing of the database for an empty list', () => {
        expect(history.stats([]).size).toBe(0);
    });

    // Pinned against the phone's `HistorySQL.maxParameters`. Both clients page
    // the same way, and a chunk size nothing asserts against can drift up to
    // the cap with every test still green.
    it('pages at the same size the phone does', () => {
        expect(MAX_PARAMETERS).toBe(400);
    });

    it('answers for more ids than one statement can carry parameters for', () => {
        // Genuinely more: SQLite caps host parameters at 32766, so this list is
        // one no single statement can ask about. The previous version of this
        // test used a thousand ids, which fit comfortably into one statement —
        // deleting the chunking left it passing, which is the whole thing it
        // was there to catch.
        const count = 40_000;
        expect(count).toBeGreaterThan(32_766);

        const ids = Array.from({ length: count }, (_, index) => `bulk-${index}`);
        cacheTrack('bulk-500', 200_000);
        playedThrough('bulk-500', 200_000, 200_000);

        const stats = history.stats(ids);
        expect(stats.size).toBe(count);
        expect(stats.get('bulk-500')?.playCount).toBe(1);
        expect(stats.get('bulk-0')?.playCount).toBe(0);
        expect(stats.get(`bulk-${count - 1}`)?.playCount).toBe(0);
    });

    // The query reads columns the store writes. Nothing else checks that those
    // two spellings agree, and a mismatch reads as "this device has no history".
    it('counts a play written through the store itself', () => {
        const store = new CurationStore(database);
        cacheTrack('stored', 200_000);
        store.record('play_events', {
            completed: 1,
            contentKey: 'stored',
            endedAt: now + 200_000,
            id: 'event-from-store',
            jellyfinId: 'stored',
            msPlayed: 200_000,
            startedAt: now,
        });

        expect(history.playCount('stored')).toBe(1);
    });
});

describe('a recap of a window', () => {
    /** A cached track with a name worth grouping on. */
    const cacheTrackAs = (
        jellyfinId: string,
        names: { album: string; albumArtist?: string; artist: string },
    ): void => {
        database.db
            .prepare(
                `INSERT INTO tracks (jellyfinId, contentKey, title, artist, album, albumArtist, durationMs, lastSeenAt)
                 VALUES (?, ?, ?, ?, ?, ?, 200000, ?)`,
            )
            .run(
                jellyfinId,
                jellyfinId,
                jellyfinId,
                names.artist,
                names.album,
                names.albumArtist ?? null,
                now,
            );
    };

    /** The local calendar day of a timestamp, as `date(..., 'localtime')` spells it. */
    const localDay = (timestamp: number): string => {
        const date = new Date(timestamp);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };

    // Noon UTC, so the local day is the same for every zone between UTC-12
    // and UTC+11 — the test must not depend on where the machine is.
    const noon = Date.UTC(2026, 2, 10, 12);
    const day = 24 * 60 * 60 * 1000;

    const from = noon - 30 * day;
    const to = noon + 30 * day;

    it('counts plays by the shared definition, and time by every event', () => {
        cacheTrackAs('a', { album: 'Blue', artist: 'Ann' });
        cacheTrackAs('b', { album: 'Blue', artist: 'Ann' });
        cacheTrackAs('c', { album: 'Red', artist: 'Bob' });

        playedThrough('a', 200_000, 200_000, noon);
        playedThrough('a', 200_000, 200_000, noon + 1);
        playedThrough('b', 200_000, 200_000, noon + 2);
        // A skip: time spent, but not a play.
        playedThrough('c', 5_000, 200_000, noon + 3);

        const recap = history.recap(from, to);

        expect(recap.totalPlays).toBe(3);
        expect(recap.totalMsPlayed).toBe(605_000);
        expect(recap.distinctTracks).toBe(2);
        expect(recap.distinctArtists).toBe(1);
        expect(recap.distinctAlbums).toBe(1);
        expect(recap.topTracks).toEqual([
            { jellyfinId: 'a', playCount: 2 },
            { jellyfinId: 'b', playCount: 1 },
        ]);
        expect(recap.topArtists).toEqual([{ artist: 'Ann', playCount: 3 }]);
        expect(recap.topAlbums).toEqual([{ album: 'Blue', artist: 'Ann', playCount: 3 }]);
        expect(recap.unattributedPlays).toBe(0);
        expect(recap.from).toBe(from);
        expect(recap.to).toBe(to);
    });

    it('includes an event at from and excludes one at to', () => {
        cacheTrack('a', 200_000);
        playedThrough('a', 200_000, 200_000, from - 1);
        playedThrough('a', 200_000, 200_000, from);
        playedThrough('a', 200_000, 200_000, to - 1);
        playedThrough('a', 200_000, 200_000, to);

        const recap = history.recap(from, to);

        expect(recap.totalPlays).toBe(2);
        expect(recap.totalMsPlayed).toBe(400_000);
        expect(recap.topTracks).toEqual([{ jellyfinId: 'a', playCount: 2 }]);
    });

    it('names the local day with the most plays, earliest on a tie', () => {
        cacheTrack('a', 200_000);
        playedThrough('a', 200_000, 200_000, noon + 2 * day);
        playedThrough('a', 200_000, 200_000, noon + 2 * day + 1);
        playedThrough('a', 200_000, 200_000, noon + 5 * day);
        playedThrough('a', 200_000, 200_000, noon + 5 * day + 1);
        playedThrough('a', 200_000, 200_000, noon);
        // Skips do not make a day busy.
        playedThrough('a', 1_000, 200_000, noon + 7 * day);
        playedThrough('a', 1_000, 200_000, noon + 7 * day + 1);
        playedThrough('a', 1_000, 200_000, noon + 7 * day + 2);

        expect(history.recap(from, to).busiestDay).toEqual({
            day: localDay(noon + 2 * day),
            playCount: 2,
        });
    });

    it('counts plays of tracks this device has not cached rather than hiding them', () => {
        cacheTrackAs('known', { album: 'Blue', artist: 'Ann' });
        playedThrough('known', 200_000, 200_000, noon);
        // Four minutes of an uncached track is a play by the fallback half of
        // the rule; there is no artist or album to file it under.
        playedThrough('ghost', 240_000, null, noon + 1);
        playedThrough('ghost', 240_000, null, noon + 2);

        const recap = history.recap(from, to);

        expect(recap.totalPlays).toBe(3);
        expect(recap.unattributedPlays).toBe(2);
        expect(recap.distinctTracks).toBe(2);
        expect(recap.distinctArtists).toBe(1);
        expect(recap.topTracks).toEqual([
            { jellyfinId: 'ghost', playCount: 2 },
            { jellyfinId: 'known', playCount: 1 },
        ]);
        expect(recap.topArtists).toEqual([{ artist: 'Ann', playCount: 1 }]);
        expect(recap.topAlbums).toEqual([{ album: 'Blue', artist: 'Ann', playCount: 1 }]);
    });

    it('files a compilation under its album artist rather than splitting it', () => {
        cacheTrackAs('a', { album: 'Now 1', albumArtist: 'Various', artist: 'Ann' });
        cacheTrackAs('b', { album: 'Now 1', albumArtist: 'Various', artist: 'Bob' });
        playedThrough('a', 200_000, 200_000, noon);
        playedThrough('b', 200_000, 200_000, noon + 1);

        const recap = history.recap(from, to);

        expect(recap.distinctAlbums).toBe(1);
        expect(recap.topAlbums).toEqual([{ album: 'Now 1', artist: 'Various', playCount: 2 }]);
        expect(recap.distinctArtists).toBe(2);
    });

    it('caps each leaderboard at the shared limit', () => {
        for (let n = 0; n < RECAP_TOP_LIMIT + 3; n += 1) {
            cacheTrackAs(`t${n}`, { album: `Album ${n}`, artist: `Artist ${n}` });
            playedThrough(`t${n}`, 200_000, 200_000, noon + n);
        }

        const recap = history.recap(from, to);

        expect(recap.topTracks).toHaveLength(RECAP_TOP_LIMIT);
        expect(recap.topArtists).toHaveLength(RECAP_TOP_LIMIT);
        expect(recap.topAlbums).toHaveLength(RECAP_TOP_LIMIT);
        expect(recap.distinctTracks).toBe(RECAP_TOP_LIMIT + 3);
    });

    it('is all zeros and no busiest day when nothing was played', () => {
        expect(history.recap(from, to)).toEqual({
            busiestDay: null,
            distinctAlbums: 0,
            distinctArtists: 0,
            distinctTracks: 0,
            from,
            to,
            topAlbums: [],
            topArtists: [],
            topTracks: [],
            totalMsPlayed: 0,
            totalPlays: 0,
            unattributedPlays: 0,
        });
    });
});

describe('recording a listen at this desk', () => {
    const duration = 200_000;
    const tryBegin = (over: Partial<Parameters<PlayHistory['beginPlay']>[0]> = {}) =>
        history.beginPlay({
            album: 'An Album',
            artist: 'An Artist',
            durationMs: duration,
            jellyfinId: 'desk-track',
            source: 'unknown',
            startedAt: now,
            title: 'A Song',
            ...over,
        });

    /** A begin that must open something — every case below but the flagged one. */
    const begin = (over: Partial<Parameters<PlayHistory['beginPlay']>[0]> = {}): string => {
        const id = tryBegin(over);
        if (id === null) throw new Error('beginPlay opened nothing for an unflagged track');
        return id;
    };

    // "Don't count this" means exactly that: no event is opened, so nothing is
    // there to count later — and nothing is in the op log to reach the phone.
    describe('a track flagged "don’t count"', () => {
        const flag = (jellyfinId: string, dontCount: boolean) =>
            new TrackFlags(database, store).setDontCount(jellyfinId, 'key', dontCount);

        it('opens no event and writes no op', () => {
            flag('desk-track', true);

            expect(tryBegin()).toBeNull();
            expect(database.db.prepare('SELECT COUNT(*) AS n FROM play_events').get()).toEqual({
                n: 0,
            });
            expect(store.pendingOps().filter((op) => op.entity === 'play_events')).toEqual([]);
        });

        it('leaves history already recorded exactly as it was', () => {
            const earlier = begin({ startedAt: now - 10_000 });
            history.finishPlay(earlier, { durationMs: duration, endedAt: now, msPlayed: duration });
            flag('desk-track', true);

            expect(tryBegin()).toBeNull();
            expect(history.statsFor('desk-track').playCount).toBe(1);
        });

        it('records again once the flag is taken off', () => {
            flag('desk-track', true);
            flag('desk-track', false);

            expect(tryBegin()).not.toBeNull();
        });

        it('is the one flag that matters here: "not interested" still records', () => {
            new TrackFlags(database, store).setNotInterested('desk-track', 'key', true);

            expect(tryBegin()).not.toBeNull();
        });
    });

    const row = (id: string) =>
        database.db.prepare('SELECT * FROM play_events WHERE id = ?').get(id) as Record<
            string,
            null | number | string
        >;

    const eventOps = () =>
        database.db
            .prepare(`SELECT * FROM ops WHERE entity = 'play_events' ORDER BY rowid`)
            .all() as Array<{ entity_id: string; payload: string }>;

    it('opens the row as the phone would: no outcome, nothing heard yet', () => {
        const id = begin();
        const stored = row(id);

        expect(stored).toMatchObject({
            completed: 0,
            contentKey: contentKeyFor({
                album: 'An Album',
                artist: 'An Artist',
                durationMs: duration,
                title: 'A Song',
            }),
            endedAt: null,
            jellyfinId: 'desk-track',
            msPlayed: 0,
            originDevice: store.device,
            skipped: 0,
            source: 'unknown',
            startedAt: now,
        });
        // Open, so it is neither — the SQL side of the same rule.
        expect(history.statsFor('desk-track')).toMatchObject({
            lastStartedAt: now,
            playCount: 0,
            skipCount: 0,
        });
    });

    // The IPC handler caches the track before opening the listen, which is
    // what gives the SQL a duration to judge the threshold arm against; the
    // tests do the same by hand.
    it('begin then finish is one row and two ops on the same id', () => {
        cacheTrack('desk-track', duration);
        const id = begin();
        const outcome = history.finishPlay(id, {
            durationMs: duration,
            endedAt: now + 150_000,
            msPlayed: 150_000,
        });

        expect(outcome).toBe('finished');
        expect(database.db.prepare('SELECT COUNT(*) AS n FROM play_events').get()).toEqual({
            n: 1,
        });

        const ops = eventOps();
        expect(ops).toHaveLength(2);
        expect(ops.map((op) => op.entity_id)).toEqual([id, id]);

        // The wire: the finished payload is the whole row, booleans as
        // booleans, so the phone's `isMoreFinished` applies it over its open copy.
        const finished = JSON.parse(ops[1].payload) as Record<string, unknown>;
        expect(finished).toMatchObject({
            completed: false,
            endedAt: now + 150_000,
            id,
            msPlayed: 150_000,
            skipped: false,
        });
        expect(history.playCount('desk-track')).toBe(1);
    });

    it('takes the verdict from the shared definition, on its exact boundaries', () => {
        // The constants are the phone's; pinned so a drift in the shared file
        // is a failure here and not a quiet disagreement between devices.
        expect(SCROBBLE_CEILING_MS).toBe(240_000);
        expect(playThreshold(duration)).toBe(100_000);
        expect(skipThreshold(duration)).toBe(40_000);

        const cases: Array<[number, { completed: number; play: number; skipped: number }]> = [
            [skipThreshold(duration) - 1, { completed: 0, play: 0, skipped: 1 }],
            [skipThreshold(duration), { completed: 0, play: 0, skipped: 0 }],
            [playThreshold(duration) - 1, { completed: 0, play: 0, skipped: 0 }],
            [playThreshold(duration), { completed: 0, play: 1, skipped: 0 }],
            [duration - COMPLETION_TOLERANCE_MS - 1, { completed: 0, play: 1, skipped: 0 }],
            [duration - COMPLETION_TOLERANCE_MS, { completed: 1, play: 1, skipped: 0 }],
        ];

        for (const [msPlayed, expected] of cases) {
            const jellyfinId = `boundary-${msPlayed}`;
            cacheTrack(jellyfinId, duration);
            const id = begin({ jellyfinId });
            history.finishPlay(id, { durationMs: duration, endedAt: now + msPlayed, msPlayed });

            const stored = row(id);
            expect(stored.completed, `completed at ${msPlayed}`).toBe(expected.completed);
            expect(stored.skipped, `skipped at ${msPlayed}`).toBe(expected.skipped);
            expect(history.playCount(jellyfinId), `play at ${msPlayed}`).toBe(expected.play);
        }
    });

    it('judges by the duration the player had, not the cache', () => {
        // The cache says the track is four seconds long; the player, which had
        // the asset open, says two hundred. The classifier believes the player,
        // and the stored `skipped` then vetoes what the stale cache would count.
        cacheTrack('desk-track', 4_000);
        const id = begin();
        history.finishPlay(id, { durationMs: duration, endedAt: now + 3_000, msPlayed: 3_000 });

        expect(row(id).skipped).toBe(1);
        expect(history.playCount('desk-track')).toBe(0);
    });

    it('finishing twice writes nothing more', () => {
        const id = begin();
        history.finishPlay(id, { durationMs: duration, endedAt: now + 150_000, msPlayed: 150_000 });
        const before = row(id);

        const again = history.finishPlay(id, {
            durationMs: duration,
            endedAt: now + 900_000,
            msPlayed: 1_000,
        });

        expect(again).toBe('already');
        expect(row(id)).toEqual(before);
        expect(eventOps()).toHaveLength(2);
    });

    it('ignores a finish for an id it never opened', () => {
        expect(
            history.finishPlay('never-opened', { durationMs: duration, endedAt: now, msPlayed: 1 }),
        ).toBe('unknown');
        expect(eventOps()).toHaveLength(0);
        expect(database.db.prepare('SELECT COUNT(*) AS n FROM play_events').get()).toEqual({
            n: 0,
        });
    });

    it('stores what was heard as a non-negative integer', () => {
        const negative = begin({ jellyfinId: 'negative' });
        history.finishPlay(negative, { durationMs: duration, endedAt: now, msPlayed: -5.7 });
        expect(row(negative).msPlayed).toBe(0);

        const fractional = begin({ jellyfinId: 'fractional' });
        history.finishPlay(fractional, { durationMs: duration, endedAt: now, msPlayed: 1234.9 });
        expect(row(fractional).msPlayed).toBe(1234);
    });

    it('lets the finish say where the listen came from, and otherwise keeps the beginning’s answer', () => {
        const amended = begin({ jellyfinId: 'amended' });
        history.finishPlay(amended, {
            durationMs: duration,
            endedAt: now + 1,
            msPlayed: 1,
            source: 'playlist',
        });
        expect(row(amended).source).toBe('playlist');

        const kept = begin({ jellyfinId: 'kept', source: 'album' });
        history.finishPlay(kept, { durationMs: duration, endedAt: now + 1, msPlayed: 1 });
        expect(row(kept).source).toBe('album');
    });
});

/**
 * A track cached under names of its own, for the artist aggregate. The general
 * `cacheTrack` above files everything under one artist on purpose — the play
 * and skip tests do not care — and these tests care about nothing else.
 */
const cacheTrackBy = (
    jellyfinId: string,
    artist: string,
    albumArtist: null | string,
    durationMs: null | number = 200_000,
): void => {
    database.db
        .prepare(
            `INSERT INTO tracks (jellyfinId, contentKey, title, artist, album, albumArtist, durationMs, lastSeenAt)
             VALUES (?, ?, ?, ?, 'An Album', ?, ?, ?)`,
        )
        .run(jellyfinId, jellyfinId, jellyfinId, artist, albumArtist, durationMs, now);
};

/** A listen that reached the end, which is what a finish is. */
const finished = (jellyfinId: string, durationMs = 200_000, startedAt = now): void =>
    playedThrough(jellyfinId, durationMs, durationMs, startedAt);

/** A listen that was decided and did not reach the end. */
const abandoned = (jellyfinId: string, msPlayed: number, durationMs = 200_000): void =>
    playedThrough(jellyfinId, msPlayed, durationMs);

describe('finish rates', () => {
    it('counts a decided listen as a start and a completed one as a finish', () => {
        cacheTrack('t1', 200_000);
        finished('t1');
        abandoned('t1', 10_000);
        abandoned('t1', 150_000);

        expect(history.finishRates(['t1']).t1).toEqual({ completed: 1, starts: 3 });
    });

    // The figure this feature exists for is not the play count wearing a
    // different hat. Four minutes of a twelve-minute track is a play by the
    // shared definition — and it is not a finish, which is the entire point.
    it('is not the play count: a play that stopped short is a start, not a finish', () => {
        const twelveMinutes = 12 * 60 * 1_000;
        cacheTrack('long', twelveMinutes);
        abandoned('long', 4 * 60 * 1_000, twelveMinutes);
        abandoned('long', 5 * 60 * 1_000, twelveMinutes);
        abandoned('long', 6 * 60 * 1_000, twelveMinutes);

        expect(history.playCount('long')).toBe(3);
        expect(history.finishRates(['long']).long).toEqual({ completed: 0, starts: 3 });
        expect(finishRateOf([history.finishRates(['long']).long])).toBe(0);
    });

    // An event opened and never closed describes nothing that happened. Counting
    // it as a start would file every app crash as a track the listener walked
    // out on, and it is the long records that get walked out on that way.
    it('ignores a listen that was never finished', () => {
        cacheTrack('open', 200_000);
        finished('open');
        finished('open');
        finished('open');
        insertEvent({ endedAt: null, jellyfinId: 'open', msPlayed: 120_000, startedAt: now });

        expect(history.finishRates(['open']).open).toEqual({ completed: 3, starts: 3 });
    });

    // A row synced from a client that stamped a verdict without an end time
    // would otherwise count as a finish and not as a start, and the page would
    // print a percentage above 100.
    it('never counts more finishes than starts', () => {
        cacheTrack('impossible', 200_000);
        for (let index = 0; index < 3; index += 1) {
            insertEvent({
                completed: true,
                endedAt: null,
                jellyfinId: 'impossible',
                msPlayed: 200_000,
                startedAt: now + index,
            });
        }

        const counts = history.finishRates(['impossible']).impossible;
        expect(counts).toEqual({ completed: 0, starts: 0 });
        expect(counts.completed).toBeLessThanOrEqual(counts.starts);
    });

    it('returns zeroed counts for every id it has never seen', () => {
        expect(history.finishRates(['never', 'also-never'])).toEqual({
            'also-never': { completed: 0, starts: 0 },
            never: { completed: 0, starts: 0 },
        });
    });

    it('asks nothing of the database for an empty list', () => {
        expect(history.finishRates([])).toEqual({});
    });

    it('answers for more ids than one statement can carry parameters for', () => {
        // Past SQLite's 32,766-parameter cap, so a single un-chunked statement
        // could not ask this at all. A list that merely fit would leave the
        // chunking deletable with the test still green.
        const count = 40_000;
        expect(count).toBeGreaterThan(32_766);
        expect(count).toBeGreaterThan(MAX_PARAMETERS);

        const ids = Array.from({ length: count }, (_, index) => `bulk-${index}`);
        cacheTrack('bulk-39000', 200_000);
        finished('bulk-39000');

        const counts = history.finishRates(ids);
        expect(Object.keys(counts)).toHaveLength(count);
        expect(counts['bulk-39000']).toEqual({ completed: 1, starts: 1 });
    });

    /**
     * The rule that makes an album's figure mean what it says.
     *
     * A hit started eighty times and finished sixty, beside a closing track
     * started three times and finished once: 61 of 83, or 73%. The mean of the
     * two tracks' rates is 54%, because it weighs three listens as heavily as
     * eighty. The database has to hand back counts, not rates, for the right
     * answer to be reachable at all.
     */
    it('hands back counts an album can sum, which is not the mean of its tracks’ rates', () => {
        cacheTrack('hit', 200_000);
        cacheTrack('closer', 200_000);

        for (let index = 0; index < 60; index += 1) finished('hit', 200_000, now + index);
        for (let index = 0; index < 20; index += 1) abandoned('hit', 10_000);
        finished('closer');
        abandoned('closer', 10_000);
        abandoned('closer', 20_000);

        const counts = history.finishRates(['hit', 'closer']);
        expect(counts.hit).toEqual({ completed: 60, starts: 80 });
        expect(counts.closer).toEqual({ completed: 1, starts: 3 });

        const album = finishRateOf([counts.hit, counts.closer]);
        const meanOfRates = (60 / 80 + 1 / 3) / 2;

        expect(Math.round((album ?? 0) * 100)).toBe(73);
        expect(Math.round(meanOfRates * 100)).toBe(54);
        expect(album).not.toBeCloseTo(meanOfRates);
    });

    // Below the floor the store still reports the counts honestly; it is the
    // shared rule that declines to turn them into a figure. Keeping the refusal
    // out of SQL is what lets an album of thinly played tracks still have one.
    it('reports thin counts and lets the shared rule refuse them', () => {
        cacheTrack('thin', 200_000);
        finished('thin');
        abandoned('thin', 10_000);

        const counts = history.finishRates(['thin']).thin;
        expect(counts).toEqual({ completed: 1, starts: 2 });
        expect(counts.starts).toBeLessThan(MINIMUM_FINISH_SAMPLE);
        expect(finishRateOf([counts])).toBeUndefined();
    });
});

describe('finish rates for an artist', () => {
    it('sums every track filed under the name, however it is credited', () => {
        // One track credits her as its artist; another is a compilation cut
        // where she is only the track artist; a third is somebody else's.
        cacheTrackBy('own-1', 'Her', 'Her');
        cacheTrackBy('own-2', 'Her', 'Her');
        cacheTrackBy('compilation', 'Her', 'Various Artists');
        cacheTrackBy('someone-else', 'Him', 'Him');

        finished('own-1');
        finished('own-2');
        abandoned('own-2', 10_000);
        finished('compilation');
        abandoned('someone-else', 10_000);

        expect(history.finishRateForArtist('Her')).toEqual({ completed: 3, starts: 4 });
    });

    it('finds a track by its album artist when the track artist differs', () => {
        cacheTrackBy('guest', 'Her feat. Him', 'Her');
        finished('guest');
        abandoned('guest', 10_000);
        abandoned('guest', 20_000);

        expect(history.finishRateForArtist('Her')).toEqual({ completed: 1, starts: 3 });
    });

    it('ignores listens that were never finished, exactly as the per-track form does', () => {
        cacheTrackBy('theirs', 'Them', 'Them');
        finished('theirs');
        insertEvent({ endedAt: null, jellyfinId: 'theirs', msPlayed: 120_000, startedAt: now });

        expect(history.finishRateForArtist('Them')).toEqual({ completed: 1, starts: 1 });
    });

    // The aggregate is over the artist's whole catalogue, so it is the sum, not
    // an average of albums or of songs — the same rule the album page applies by
    // hand, done here by SUM.
    it('weighs a listen the same wherever it happened', () => {
        cacheTrackBy('a', 'One', 'One');
        cacheTrackBy('b', 'One', 'One');

        for (let index = 0; index < 9; index += 1) finished('a', 200_000, now + index);
        abandoned('a', 10_000);
        abandoned('b', 10_000);

        expect(history.finishRateForArtist('One')).toEqual({ completed: 9, starts: 11 });
        expect(finishRateOf([history.finishRateForArtist('One')])).toBeCloseTo(9 / 11);
    });

    it('says nothing was started for an artist this device has never cached', () => {
        expect(history.finishRateForArtist('Nobody')).toEqual({ completed: 0, starts: 0 });
    });

    // The events are real; the track they belong to has never been indexed here,
    // so nothing can say whose it is. Counting it under the artist being looked
    // at would be inventing an attribution.
    it('does not attribute events whose track is not in the cache', () => {
        finished('uncached-track');
        finished('uncached-track');
        finished('uncached-track');

        expect(history.finishRateForArtist('Her')).toEqual({ completed: 0, starts: 0 });
        expect(history.finishRates(['uncached-track'])['uncached-track']).toEqual({
            completed: 3,
            starts: 3,
        });
    });
});
