import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationRow, CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';

/**
 * What this device puts on the wire, judged as the phone will judge it.
 *
 * Everything here failed silently before it was written: the push succeeds, the
 * local row is perfectly valid, and the change simply never appears on the
 * phone — because the phone quarantines an op it cannot decode, and a
 * quarantined op is never retried.
 */

let database: CurationDatabase;
let store: CurationStore;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
});

afterEach(() => database.close());

const columnsOf = (table: string): string[] =>
    (database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );

describe('the payload is the whole row', () => {
    // The caller passed three fields; the table has fifteen, several with
    // DEFAULTs. The phone's `Playlist` declares `isSmart` non-optional, so a
    // payload without it does not decode.
    it('carries columns the caller never mentioned', () => {
        const { op } = store.record('playlists', {
            id: 'p1',
            name: 'Driving',
            sortIndex: 'a0',
        });

        // fieldUpdatedAt is the one column deliberately absent — it travels
        // under the wire's own key, and only when it has something to say.
        const expected = columnsOf('playlists').filter((column) => column !== 'fieldUpdatedAt');

        expect(Object.keys(op.payload).sort()).toEqual(expected.sort());
        expect(op.payload.isSmart).toBeDefined();
    });

    it('carries every column for every entity, not just playlists', () => {
        const rows: Array<[Parameters<CurationStore['record']>[0], CurationRow]> = [
            ['folders', { id: 'f1', name: 'Rock', sortIndex: 'a0' }],
            [
                'playlist_items',
                { contentKey: 'k', id: 'i1', jellyfinId: 't1', playlistId: 'p1', position: 'a0' },
            ],
            ['likes', { contentKey: 'k', id: 'l1', jellyfinId: 't1', liked: true }],
            [
                'play_events',
                { contentKey: 'k', id: 'e1', jellyfinId: 't1', msPlayed: 1, startedAt: 1 },
            ],
            [
                'queue_state',
                { deviceId: 'd1', deviceName: 'Laptop', elapsedMs: 0, position: 0, trackIds: '[]' },
            ],
        ];

        for (const [entity, values] of rows) {
            const { op } = store.record(entity, values);
            const expected = columnsOf(entity).filter((column) => column !== 'fieldUpdatedAt');

            expect([entity, Object.keys(op.payload).sort()]).toEqual([entity, expected.sort()]);
        }
    });
});

describe('booleans on the wire', () => {
    // Swift encodes Bool as JSON true/false and JSONDecoder refuses a number
    // where it wants one. SQLite only ever hands back 0 and 1.
    it('sends true and false, never 0 and 1', () => {
        const { op } = store.record('playlists', {
            id: 'p1',
            isSmart: true,
            name: 'Recently Added',
            sortIndex: 'a0',
        });

        expect(op.payload.isSmart).toBe(true);
        expect(op.payload.deleted).toBe(false);
    });

    it('survives the round trip through JSON, which is what actually travels', () => {
        const { op } = store.record('likes', {
            contentKey: 'k',
            id: 'l1',
            jellyfinId: 't1',
            liked: true,
        });

        const overTheWire = JSON.parse(JSON.stringify(op.payload)) as Record<string, unknown>;
        expect(overTheWire.liked).toBe(true);
        expect(overTheWire.deleted).toBe(false);
    });

    it('marks a delete with a real boolean too', () => {
        store.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        const { op } = store.record(
            'playlists',
            { id: 'p1', name: 'Driving', sortIndex: 'a0' },
            'delete',
        );

        expect(op.payload.deleted).toBe(true);
    });

    it('leaves a null optional null rather than making it false', () => {
        const { op } = store.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });

        // The phone's optionals decode null as nil. Coercing to false would
        // claim a cover exists and is empty.
        expect(op.payload.imageHash).toBeNull();
        expect(op.payload.notes).toBeNull();
    });
});

describe('a play event arriving twice', () => {
    const openEvent = {
        contentKey: 'k',
        endedAt: null,
        id: 'e1',
        jellyfinId: 't1',
        msPlayed: 0,
        startedAt: 1_000,
    };

    // The phone writes a long listen twice under one id: an open row when
    // playback starts, then the finished row. Ignoring the second copy keeps
    // the 0 ms version forever — a listening history that says nothing was
    // ever listened to.
    it('accepts the finished copy over the open one', () => {
        const opened = store.record('play_events', openEvent);
        const other = new CurationStore(openCurationDatabase(':memory:'));

        expect(other.applyRemote(opened.op)).toBe('applied');
        expect(
            other.applyRemote({
                ...opened.op,
                payload: {
                    ...opened.op.payload,
                    completed: true,
                    endedAt: 236_000,
                    msPlayed: 235_000,
                },
            }),
        ).toBe('applied');

        const stored = other.live('play_events')[0];
        expect(stored.msPlayed).toBe(235_000);
        expect(stored.completed).toBe(1);
    });

    it('ignores a copy that ended at the same instant, so a replay reports no work', () => {
        const finished = store.record('play_events', {
            ...openEvent,
            endedAt: 5_000,
            msPlayed: 4_000,
        });
        const other = new CurationStore(openCurationDatabase(':memory:'));

        expect(other.applyRemote(finished.op)).toBe('applied');
        expect(other.applyRemote(finished.op)).toBe('ignored');
    });

    it('never lets an unfinished copy overwrite a finished one', () => {
        const finished = store.record('play_events', {
            ...openEvent,
            endedAt: 5_000,
            msPlayed: 4_000,
        });
        const other = new CurationStore(openCurationDatabase(':memory:'));
        other.applyRemote(finished.op);

        expect(
            other.applyRemote({
                ...finished.op,
                payload: { ...finished.op.payload, endedAt: null, msPlayed: 0 },
            }),
        ).toBe('ignored');
        expect(other.live('play_events')[0].msPlayed).toBe(4_000);
    });
});

describe('deleted is metadata, not a merged field', () => {
    /**
     * `deleted` sits in the phone's `FieldStamped.metadataColumns`, so the
     * row-level winner decides it and no field stamp can override it.
     *
     * Driven by a hand-built op rather than by two live stores: two stores
     * writing in the same millisecond tie on `updatedAt` and fall to the device
     * tiebreak, which makes the answer depend on two random UUIDs. That is a
     * fine property for convergence and a useless one for a test.
     */
    it('ignores a deleted stamp that would otherwise win the field', () => {
        const created = store.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        const createdAt = Number(created.op.payload.updatedAt);

        // This device deletes.
        store.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' }, 'delete');
        const deletedAt = Number(
            (
                database.db.prepare('SELECT updatedAt FROM playlists WHERE id = ?').get('p1') as {
                    updatedAt: number;
                }
            ).updatedAt,
        );

        // An op arrives that is OLDER at the row level but carries a `deleted`
        // stamp newer than this device's delete. Only a client that merges
        // `deleted` per field would resurrect the playlist here — and a client
        // that did would disagree with the phone forever.
        expect(
            store.applyRemote({
                ...created.op,
                opId: 'from-an-older-build',
                payload: {
                    ...created.op.payload,
                    deleted: false,
                    fieldUpdatedAt: { deleted: deletedAt + 5_000, name: createdAt },
                    updatedAt: createdAt,
                },
            }),
        ).toBe('ignored');

        const row = database.db.prepare('SELECT * FROM playlists WHERE id = ?').get('p1') as {
            deleted: number;
        };
        expect(row.deleted).toBe(1);
    });

    it('does not stamp deleted on the way out either', () => {
        store.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        const renamed = store.record('playlists', {
            id: 'p1',
            name: 'Road Trip',
            sortIndex: 'a0',
        });

        // The phone never emits a stamp for it, so neither may this — an op
        // carrying one is an op that teaches the receiving client to merge
        // `deleted` per field.
        const stamps = renamed.op.payload.fieldUpdatedAt as Record<string, number>;
        expect(stamps).toBeDefined();
        expect(stamps.deleted).toBeUndefined();
        expect(stamps.name).toBeDefined();
    });
});
