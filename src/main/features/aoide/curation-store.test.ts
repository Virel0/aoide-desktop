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
    sort_index: 'a0',
    ...overrides,
});

describe('the schema', () => {
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

        expect(row.origin_device).toBe(database.deviceId);
        expect(Number(row.updated_at)).toBeGreaterThanOrEqual(before);
    });

    it('carries the whole row in the payload, so a receiver needs no history', () => {
        const { op } = store.record('playlists', playlist({ description: 'for the motorway' }));

        expect(op.payload).toMatchObject({
            description: 'for the motorway',
            id: 'playlist-1',
            name: 'Driving',
            sort_index: 'a0',
        });
        expect(op.payload.origin_device).toBe(database.deviceId);
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
                        content_key: 'k',
                        id: 'event-1',
                        jellyfin_id: 'track-1',
                        ms_played: 1000,
                        started_at: 1,
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
        store.record('playlists', playlist({ description: 'quotes " and \\ backslashes' }));

        expect(store.pendingOps()[0].payload.description).toBe('quotes " and \\ backslashes');
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
            device_id: 'device-a',
            device_name: 'Laptop',
            elapsed_ms: 0,
            position: 0,
            track_ids: '["t1"]',
        });
        store.record('queue_state', {
            device_id: 'device-a',
            device_name: 'Laptop',
            elapsed_ms: 5000,
            position: 1,
            track_ids: '["t1","t2"]',
        });

        const rows = store.live('queue_state');
        expect(rows).toHaveLength(1);
        expect(rows[0].elapsed_ms).toBe(5000);
    });
});
