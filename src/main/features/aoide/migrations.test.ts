import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations';

import { ACTIVITIES } from '/@/shared/aoide/activity';

/**
 * Migrations, run the way they will actually run: onto a database that already
 * has somebody's listening in it.
 *
 * A migration tested only against a fresh database is tested against the one
 * case that cannot lose anything. Every real device runs these against a store
 * with years of play events, playlists and likes already in it, and the failures
 * that matter — a rebuilt table that drops its rows, a NOT NULL column added to
 * a populated table, a version bumped past a step that threw — are all invisible
 * from `:memory:` with nothing in it.
 */

let database: DatabaseSync | undefined;

afterEach(() => {
    database?.close();
    database = undefined;
});

/** A database at exactly `version`, as an older build would have left it. */
const openAt = (version: number): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    for (let index = 0; index < version; index += 1) MIGRATIONS[index](db);
    db.exec(`PRAGMA user_version = ${version}`);
    database = db;
    return db;
};

const userVersion = (db: DatabaseSync): number =>
    Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

const columnsOf = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );

/** One listen, written by the build that shipped `version`. */
const insertEvent = (db: DatabaseSync, id: string, startedAt: number): void => {
    db.prepare(
        `INSERT INTO play_events
         (id, jellyfinId, contentKey, startedAt, endedAt, msPlayed, completed, skipped, source, originDevice)
         VALUES (?, 't1', 'k1', ?, ?, 200000, 1, 0, 'album', 'an-old-device')`,
    ).run(id, startedAt, startedAt + 200_000);
};

describe('a fresh database', () => {
    it('lands on the current version with every table the store needs', () => {
        const db = openAt(0);
        expect(migrate(db)).toBe(SCHEMA_VERSION);
        expect(userVersion(db)).toBe(SCHEMA_VERSION);

        const tables = (
            db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
                name: string;
            }>
        ).map((row) => row.name);

        expect(tables).toEqual(
            expect.arrayContaining([
                'folders',
                'likes',
                'ops',
                'play_events',
                'playlist_items',
                'playlists',
                'queue_state',
                'sync_state',
                'track_flags',
                'tracks',
            ]),
        );
    });

    it('carries the activity column', () => {
        const db = openAt(0);
        migrate(db);
        expect(columnsOf(db, 'play_events')).toContain('activity');
    });
});

describe('an existing database with history in it', () => {
    // The whole reason this file exists. The rows below were written by a build
    // that had never heard of `activity`, and they have to come out the other
    // side unchanged and untagged.
    it('keeps every play event it already had, and calls them untagged', () => {
        const db = openAt(SCHEMA_VERSION - 1);
        insertEvent(db, 'e1', 1_700_000_000_000);
        insertEvent(db, 'e2', 1_700_000_300_000);

        expect(migrate(db)).toBe(SCHEMA_VERSION);

        const rows = db
            .prepare(
                'SELECT id, activity, msPlayed, source, startedAt FROM play_events ORDER BY id',
            )
            .all() as Array<{
            activity: null | string;
            id: string;
            msPlayed: number;
            source: string;
            startedAt: number;
        }>;

        expect(rows).toEqual([
            {
                activity: null,
                id: 'e1',
                msPlayed: 200_000,
                source: 'album',
                startedAt: 1_700_000_000_000,
            },
            {
                activity: null,
                id: 'e2',
                msPlayed: 200_000,
                source: 'album',
                startedAt: 1_700_000_300_000,
            },
        ]);
    });

    // Every earlier version, not merely the one before this: a device left on
    // v1 for a year upgrades in one run, and a chain that only ever ran from
    // the last step would not be exercised by that device until it was too late.
    it('brings every earlier version up without losing rows', () => {
        for (let from = 1; from < SCHEMA_VERSION; from += 1) {
            const db = openAt(from);
            insertEvent(db, 'e1', 1_700_000_000_000);
            db.prepare(
                `INSERT INTO playlists (id, name, sortIndex, updatedAt, originDevice)
                 VALUES ('p1', 'Driving', 'a0', 1, 'an-old-device')`,
            ).run();
            db.prepare(
                `INSERT INTO likes (id, jellyfinId, contentKey, liked, updatedAt, originDevice)
                 VALUES ('l1', 't1', 'k1', 1, 1, 'an-old-device')`,
            ).run();

            migrate(db);

            expect(userVersion(db)).toBe(SCHEMA_VERSION);
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM play_events').get() as { n: number }).n,
            ).toBe(1);
            expect(
                (
                    db.prepare('SELECT name FROM playlists WHERE id = ?').get('p1') as {
                        name: string;
                    }
                ).name,
            ).toBe('Driving');
            expect((db.prepare('SELECT COUNT(*) AS n FROM likes').get() as { n: number }).n).toBe(
                1,
            );

            db.close();
            database = undefined;
        }
    });

    it('runs nothing at all when it is already current', () => {
        const db = openAt(SCHEMA_VERSION);
        insertEvent(db, 'e1', 1_700_000_000_000);
        db.prepare('UPDATE play_events SET activity = ? WHERE id = ?').run(ACTIVITIES[0], 'e1');

        expect(migrate(db)).toBe(SCHEMA_VERSION);

        // A tag already written is not disturbed by a migration run that had
        // nothing to do — a re-run of the ALTER would have thrown, and one that
        // rebuilt the table would have dropped this.
        expect(
            (
                db.prepare('SELECT activity FROM play_events WHERE id = ?').get('e1') as {
                    activity: null | string;
                }
            ).activity,
        ).toBe(ACTIVITIES[0]);
    });
});

describe('a store from a newer build', () => {
    // Writing to a schema this build does not understand corrupts data the
    // newer build owns, and it would do so silently.
    it('is refused rather than written to', () => {
        const db = openAt(SCHEMA_VERSION);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

        expect(() => migrate(db)).toThrow(/newer version of Aoide/);
    });
});
