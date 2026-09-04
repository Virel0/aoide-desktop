import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';

let database: CurationDatabase;
let store: CurationStore;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
});

afterEach(() => database.close());

const playlist = (overrides: Record<string, unknown> = {}) => ({
    id: 'playlist-1',
    name: 'Driving',
    sortIndex: 'a0',
    ...overrides,
});

/**
 * Every column of every table that ever appears in a payload, transcribed from
 * `CurationKit/Schema.swift` migrations v1 through v8.
 *
 * A payload is the row on both clients, so these names are the wire and this is
 * the contract with the phone rather than a restatement of the migration. The
 * end-to-end proof lives in `apply-remote.test.ts`, which drives a real phone
 * payload through `applyRemote` — but that exercises `playlists` alone, and a
 * column mis-spelled in `playlist_items` or `queue_state` would surface as a
 * device that syncs playlists and silently loses their contents.
 *
 * `ops`, `quarantined_ops`, `image_blobs` and `sync_state` are absent on
 * purpose: their rows never travel, so they answer to nobody's spelling.
 */
const PHONE_COLUMNS: Record<string, string[]> = {
    folders: [
        'id',
        'name',
        'parentId',
        'sortIndex',
        'updatedAt',
        'deleted',
        'originDevice',
        'fieldUpdatedAt',
    ],
    likes: ['id', 'jellyfinId', 'contentKey', 'liked', 'updatedAt', 'deleted', 'originDevice'],
    play_events: [
        'id',
        'jellyfinId',
        'contentKey',
        'startedAt',
        'endedAt',
        'msPlayed',
        'completed',
        'skipped',
        'source',
        'originDevice',
    ],
    playlist_items: [
        'id',
        'playlistId',
        'jellyfinId',
        'contentKey',
        'position',
        'updatedAt',
        'deleted',
        'originDevice',
    ],
    playlists: [
        'id',
        'name',
        'notes',
        'folderId',
        'isSmart',
        'smartRules',
        'sortIndex',
        'updatedAt',
        'deleted',
        'originDevice',
        'fieldUpdatedAt',
        'sourceJellyfinId',
        'artworkItemId',
        'imageHash',
        'imageMime',
    ],
    queue_state: [
        'deviceId',
        'deviceName',
        'trackIds',
        'position',
        'elapsedMs',
        'updatedAt',
        'originDevice',
    ],
    // Schema.swift v8.
    track_flags: [
        'id',
        'jellyfinId',
        'contentKey',
        'notInterested',
        'dontCount',
        'updatedAt',
        'deleted',
        'originDevice',
        'fieldUpdatedAt',
    ],
    // Local, and matching the phone anyway: the shared play/skip SQL is
    // interpolated against these names on both clients.
    tracks: [
        'jellyfinId',
        'contentKey',
        'musicbrainzId',
        'title',
        'artist',
        'album',
        'albumArtist',
        'durationMs',
        'year',
        'genres',
        'lastSeenAt',
        'albumId',
    ],
};

describe('the schema', () => {
    it('spells every travelling column the way the phone does', () => {
        for (const [table, expected] of Object.entries(PHONE_COLUMNS)) {
            const actual = (
                database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
            ).map((column) => column.name);

            // Sorted, and labelled with the table: declaration order is a local
            // matter, and an unlabelled diff of two long string arrays says
            // nothing about which table it came from.
            expect([table, [...actual].sort()]).toEqual([table, [...expected].sort()]);
        }
    });

    it('keeps the tables that never travel under their own names', () => {
        // Plural snake_case tables, matching the sidecar's allow-list, with
        // snake_case columns nobody else ever reads. Only the columns above are
        // the phone's; nothing here is.
        const columns = (
            database.db.prepare('PRAGMA table_info(image_blobs)').all() as Array<{ name: string }>
        ).map((column) => column.name);

        expect(columns).toContain('sha256');
        expect(columns).toContain('created_at');
    });

    it('mints a stable device id and keeps it across opens', () => {
        expect(database.deviceId).toMatch(/^[0-9a-f-]{36}$/);
        // Reopening the same file must not re-mint it — a device that changes
        // its id can lose a conflict to its own past self.
        expect(new CurationStore(database).device).toBe(database.deviceId);
    });

    it('starts a fresh device at cursor zero rather than undefined', () => {
        expect(store.cursor).toBe(0);
    });
});

describe('record', () => {
    it('writes the row and its op together', () => {
        const { op } = store.record('playlists', playlist());

        expect(store.live('playlists')).toHaveLength(1);
        expect(store.pendingOps()).toHaveLength(1);
        expect(op.entity).toBe('playlists');
        expect(op.entityId).toBe('playlist-1');
    });

    // The single most important property in the store. A row that changed
    // without an op is a change that silently never syncs, and no later
    // reconciliation finds it — nothing recorded that it happened.
    it('leaves no row behind when the op cannot be written', () => {
        store.record('playlists', playlist());

        // Make every subsequent op insert fail, from inside SQLite, so the
        // failure lands where a real one would: after the row is written and
        // before the transaction commits.
        database.db.exec(
            `CREATE TRIGGER refuse_ops BEFORE INSERT ON ops
             BEGIN SELECT RAISE(ABORT, 'op log unavailable'); END`,
        );

        expect(() => store.record('playlists', playlist({ name: 'Renamed' }))).toThrow(
            /op log unavailable/,
        );

        database.db.exec('DROP TRIGGER refuse_ops');

        // The rename must not have survived, and no orphan op either.
        expect(store.live('playlists')[0].name).toBe('Driving');
        expect(store.pendingOps()).toHaveLength(1);
    });

    it('leaves no op behind when the row cannot be written', () => {
        database.db.exec(
            `CREATE TRIGGER refuse_playlists BEFORE INSERT ON playlists
             BEGIN SELECT RAISE(ABORT, 'playlists unavailable'); END`,
        );

        expect(() => store.record('playlists', playlist())).toThrow(/playlists unavailable/);

        database.db.exec('DROP TRIGGER refuse_playlists');
        expect(store.pendingOps()).toHaveLength(0);
        expect(store.live('playlists')).toHaveLength(0);
    });

    it('stamps the writing device and its clock', () => {
        const before = Date.now();
        const { row } = store.record('playlists', playlist());

        expect(row.originDevice).toBe(database.deviceId);
        expect(Number(row.updatedAt)).toBeGreaterThanOrEqual(before);
    });

    it('carries the whole row in the payload, so a receiver needs no history', () => {
        const { op } = store.record('playlists', playlist({ notes: 'for the motorway' }));

        expect(op.payload).toMatchObject({
            id: 'playlist-1',
            name: 'Driving',
            notes: 'for the motorway',
            sortIndex: 'a0',
        });
        expect(op.payload.originDevice).toBe(database.deviceId);
    });

    it('gives every op a distinct idempotency key', () => {
        const a = store.record('playlists', playlist());
        const b = store.record('playlists', playlist({ name: 'Driving II' }));

        expect(a.op.opId).not.toBe(b.op.opId);
        expect(store.pendingOps()).toHaveLength(2);
    });

    it('updates in place rather than duplicating on a second write', () => {
        store.record('playlists', playlist());
        store.record('playlists', playlist({ name: 'Driving II' }));

        const rows = store.live('playlists');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Driving II');
    });

    it('refuses a row with no identifier instead of writing a nameless one', () => {
        expect(() => store.record('playlists', { name: 'Nameless' })).toThrow(/needs a id/);
    });

    describe('deletes', () => {
        it('soft-deletes, because the absence of a row cannot be synced', () => {
            store.record('playlists', playlist());
            store.record('playlists', playlist(), 'delete');

            expect(store.live('playlists')).toHaveLength(0);
            // The row is still there, which is what lets the delete travel.
            const all = database.db.prepare('SELECT * FROM playlists').all();
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({ deleted: 1 });
        });

        it('records the delete as its own op', () => {
            store.record('playlists', playlist());
            store.record('playlists', playlist(), 'delete');

            const ops = store.pendingOps();
            expect(ops.map((op) => op.operation)).toEqual(['upsert', 'delete']);
        });

        it('refuses to delete from an append-only table', () => {
            expect(() =>
                store.record(
                    'play_events',
                    {
                        contentKey: 'k',
                        id: 'event-1',
                        jellyfinId: 'track-1',
                        msPlayed: 1000,
                        startedAt: 1,
                    },
                    'delete',
                ),
            ).toThrow(/append-only/);
        });
    });
});

describe('the op log', () => {
    it('returns pending ops oldest first', () => {
        const first = store.record('playlists', playlist());
        const second = store.record('playlists', playlist({ id: 'playlist-2' }));

        expect(store.pendingOps().map((op) => op.opId)).toEqual([first.op.opId, second.op.opId]);
    });

    it('stops returning ops the server accepted', () => {
        const { op } = store.record('playlists', playlist());
        store.record('playlists', playlist({ id: 'playlist-2' }));

        store.markSynced([op.opId]);

        expect(store.pendingOps().map((o) => o.entityId)).toEqual(['playlist-2']);
    });

    it('ignores an accepted id it never sent, rather than losing an op', () => {
        store.record('playlists', playlist());
        store.markSynced(['an-id-from-nowhere']);

        expect(store.pendingOps()).toHaveLength(1);
    });

    it('round-trips the payload through JSON unchanged', () => {
        store.record('playlists', playlist({ notes: 'quotes " and \\ backslashes' }));

        expect(store.pendingOps()[0].payload.notes).toBe('quotes " and \\ backslashes');
    });
});

describe('holding an entity back from a page', () => {
    // The engine holds `track_flags` while the server does not accept it. The
    // exclusion has to happen in the query: a page whose LIMIT is filled by
    // held rows, then filtered, hands back nothing forever.
    it('leaves held entities out of the page rather than at its head', () => {
        store.record('track_flags', {
            contentKey: 'k',
            id: 'tf-1',
            jellyfinId: 't1',
            notInterested: true,
        });
        store.record('playlists', playlist({ id: 'playlist-2' }));

        expect(store.pendingOps(1, ['track_flags']).map((op) => op.entityId)).toEqual([
            'playlist-2',
        ]);
        expect(store.pendingOps(1).map((op) => op.entityId)).toEqual(['tf-1']);
        expect(store.pendingOps(undefined, []).map((op) => op.entityId)).toEqual([
            'tf-1',
            'playlist-2',
        ]);
    });

    it('keeps a held op pending, so it goes once the hold lifts', () => {
        store.record('track_flags', {
            contentKey: 'k',
            id: 'tf-1',
            jellyfinId: 't1',
            notInterested: true,
        });

        expect(store.pendingOps(500, ['track_flags'])).toEqual([]);
        expect(store.pendingOps(500, [])).toHaveLength(1);
    });
});

describe('quarantine', () => {
    it('takes a refused op out of the queue so it cannot wedge it', () => {
        const { op } = store.record('playlists', playlist());
        store.record('playlists', playlist({ id: 'playlist-2' }));

        store.quarantine(op.opId, 'rejected: unknown entity');

        expect(store.pendingOps().map((o) => o.entityId)).toEqual(['playlist-2']);
    });

    it('keeps the op and the reason, because it is the only evidence left', () => {
        const { op } = store.record('playlists', playlist());
        store.quarantine(op.opId, 'rejected: unknown entity');

        const held = database.db.prepare('SELECT * FROM quarantined_ops').all();
        expect(held).toHaveLength(1);
        expect(held[0]).toMatchObject({
            entity: 'playlists',
            op_id: op.opId,
            reason: 'rejected: unknown entity',
        });
    });

    it('leaves the local row alone — the change happened, it just cannot travel', () => {
        const { op } = store.record('playlists', playlist());
        store.quarantine(op.opId, 'whatever');

        expect(store.live('playlists')).toHaveLength(1);
    });

    it('does nothing for an op it does not hold', () => {
        expect(() => store.quarantine('never-existed', 'reason')).not.toThrow();
        expect(database.db.prepare('SELECT * FROM quarantined_ops').all()).toHaveLength(0);
    });
});

describe('the cursor', () => {
    it('persists across store instances', () => {
        store.setCursor(12400);
        expect(new CurationStore(database).cursor).toBe(12400);
    });

    it('overwrites rather than accumulating rows', () => {
        store.setCursor(1);
        store.setCursor(2);

        expect(store.cursor).toBe(2);
        const rows = database.db
            .prepare("SELECT * FROM sync_state WHERE key = 'server_cursor'")
            .all();
        expect(rows).toHaveLength(1);
    });
});

describe('queue_state', () => {
    it('is keyed by device, so each device has exactly one', () => {
        store.record('queue_state', {
            deviceId: 'device-a',
            deviceName: 'Laptop',
            elapsedMs: 0,
            position: 0,
            trackIds: '["t1"]',
        });
        store.record('queue_state', {
            deviceId: 'device-a',
            deviceName: 'Laptop',
            elapsedMs: 5000,
            position: 1,
            trackIds: '["t1","t2"]',
        });

        const rows = store.live('queue_state');
        expect(rows).toHaveLength(1);
        expect(rows[0].elapsedMs).toBe(5000);
    });
});
