import type { SyncOp } from '/@/shared/aoide/sync-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { Mix } from './mix';
import { TrackFlags } from './track-flags';

/**
 * Taste flags, judged against the phone's `TrackFlagsTests` and its merge.
 *
 * Every case here is one of the phone's rules restated: the row is minted on
 * first write and reused afterwards, an empty row is a delete, two devices that
 * each minted a row for one track end on one, and "not interested" falls out of
 * every mix while "don't count" hides nothing.
 */

let database: CurationDatabase;
let store: CurationStore;
let flags: TrackFlags;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
    flags = new TrackFlags(database, store);
});

afterEach(() => database.close());

const cache = (jellyfinId: string, title = jellyfinId): void => {
    database.db
        .prepare(
            `INSERT INTO tracks (jellyfinId, contentKey, title, artist, album, lastSeenAt)
             VALUES (?, ?, ?, 'An Artist', 'An Album', 0)`,
        )
        .run(jellyfinId, `key-${jellyfinId}`, title);
};

const rowsFor = (jellyfinId: string) =>
    database.db.prepare('SELECT * FROM track_flags WHERE jellyfinId = ?').all(jellyfinId) as Array<
        Record<string, null | number | string>
    >;

const flagOps = () => store.pendingOps().filter((op) => op.entity === 'track_flags');

describe('setting a flag', () => {
    it('mints one row per track and records an op for each write', () => {
        flags.setNotInterested('t1', 'k1', true);
        flags.setDontCount('t1', 'k1', true);

        expect(flags.flags('t1')).toMatchObject({ dontCount: true, notInterested: true });
        expect(rowsFor('t1')).toHaveLength(1);

        const ops = flagOps();
        expect(ops).toHaveLength(2);
        expect(new Set(ops.map((op) => op.entityId))).toEqual(new Set([flags.flags('t1')?.id]));
    });

    it('answers nothing for a track nobody has said anything about', () => {
        expect(flags.flags('never')).toBeUndefined();
    });

    it('leaves the other flag alone', () => {
        flags.setNotInterested('t1', 'k1', true);
        flags.setDontCount('t1', 'k1', true);
        flags.setNotInterested('t1', 'k1', false);

        expect(flags.flags('t1')).toMatchObject({ dontCount: true, notInterested: false });
    });

    // A row that says nothing is not worth syncing. The phone deletes it; a
    // desktop that kept an empty row would show one more "flagged" track than
    // the phone forever.
    it('deletes the row rather than keeping an empty one when both end up off', () => {
        flags.setNotInterested('t1', 'k1', true);
        flags.setNotInterested('t1', 'k1', false);

        expect(flags.flags('t1')).toBeUndefined();
        expect(rowsFor('t1')[0].deleted).toBe(1);

        const last = flagOps().at(-1);
        expect(last?.operation).toBe('delete');
        expect(last?.payload.deleted).toBe(true);
    });

    it('reuses the row’s id when a flag is set again after deletion', () => {
        flags.setNotInterested('t1', 'k1', true);
        const first = flags.flags('t1')?.id;
        flags.setNotInterested('t1', 'k1', false);
        flags.setDontCount('t1', 'k1', true);

        expect(first).toBeDefined();
        expect(flags.flags('t1')?.id).toBe(first);
        expect(rowsFor('t1')).toHaveLength(1);
    });

    it('keeps the content key the row was minted with', () => {
        flags.setNotInterested('t1', 'original', true);
        flags.setDontCount('t1', 'recomputed', true);

        expect(flags.flags('t1')?.contentKey).toBe('original');
    });

    it('clears both flags in one write, as a delete', () => {
        flags.setNotInterested('t1', 'k1', true);
        flags.setDontCount('t1', 'k1', true);
        const before = flagOps().length;

        flags.clear('t1');

        expect(flags.flags('t1')).toBeUndefined();
        expect(flagOps()).toHaveLength(before + 1);
        expect(flagOps().at(-1)?.operation).toBe('delete');
    });

    it('clears nothing that is not there', () => {
        flags.clear('never');
        flags.setNotInterested('t1', 'k1', true);
        flags.clear('t1');
        flags.clear('t1');

        expect(flagOps()).toHaveLength(2);
    });
});

describe('the wire', () => {
    // The phone decodes `notInterested` and `dontCount` into Swift Bools. A 0 or
    // 1 on the wire is quarantined there, silently, forever.
    it('carries both flags and the delete as real booleans', () => {
        flags.setNotInterested('t1', 'k1', true);
        const [op] = flagOps();
        const overTheWire = JSON.parse(JSON.stringify(op.payload)) as Record<string, unknown>;

        expect(overTheWire.notInterested).toBe(true);
        expect(overTheWire.dontCount).toBe(false);
        expect(overTheWire.deleted).toBe(false);
    });

    it('stamps only the flag that changed, like a playlist field', () => {
        flags.setNotInterested('t1', 'k1', true);
        flags.setDontCount('t1', 'k1', true);
        const [, second] = flagOps();
        const stamps = second.payload.fieldUpdatedAt as Record<string, number>;

        expect(stamps.dontCount).toBe(second.createdAt);
        expect(stamps.notInterested).toBeLessThan(second.createdAt);
    });
});

describe('answering for a list', () => {
    it('finds the hidden ones in chunks, and nothing for an empty list', () => {
        const ids = Array.from({ length: 900 }, (_, index) => `t${index}`);
        flags.setNotInterested('t5', 'k', true);
        flags.setNotInterested('t850', 'k', true);
        flags.setDontCount('t7', 'k', true);

        expect(flags.notInterestedAmong(ids)).toEqual(new Set(['t5', 't850']));
        expect(flags.notInterestedAmong([])).toEqual(new Set());
    });

    it('lists flagged tracks newest first with what the cache knows', () => {
        cache('a', 'A Song');
        // Two rows written in one millisecond would tie on updatedAt — the
        // clock is only monotonic per row — so the second write is an hour on.
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_700_000_000_000);
            flags.setDontCount('a', 'key-a', true);
            vi.setSystemTime(1_700_003_600_000);
            flags.setNotInterested('zz', 'key-zz', true);
        } finally {
            vi.useRealTimers();
        }

        const listed = flags.flagged();

        expect(listed.map((entry) => entry.jellyfinId)).toEqual(['zz', 'a']);
        expect(listed[1]).toMatchObject({ artist: 'An Artist', dontCount: true, title: 'A Song' });
        expect(listed[0]).toMatchObject({ artist: null, notInterested: true, title: null });
    });

    it('lists nothing once a flag is cleared', () => {
        flags.setNotInterested('a', 'k', true);
        flags.clear('a');

        expect(flags.flagged()).toEqual([]);
    });
});

describe('mixes', () => {
    it('drop a not-interested track before any rule or limit sees it', () => {
        const mix = new Mix(database);
        flags.setNotInterested('b', 'k', true);
        flags.setDontCount('c', 'k', true);

        // No history rules: every candidate qualifies, except the hidden one.
        expect(mix.narrow(['a', 'b', 'c'], { match: 'all', rules: [] })).toEqual(['a', 'c']);
        // The limit counts offered tracks, so a hidden one never costs a slot.
        expect(mix.narrow(['b', 'a', 'c'], { limit: 2, match: 'all', rules: [] })).toEqual([
            'a',
            'c',
        ]);
        // With a history rule the hidden track is out before the rule runs.
        expect(
            mix.narrow(['a', 'b'], {
                match: 'all',
                rules: [{ field: 'play_count', op: 'is', value: 0 }],
            }),
        ).toEqual(['a']);
    });
});

describe('two devices that each minted a row for one track', () => {
    const remote = (
        over: Partial<SyncOp['payload']> & { id: string; updatedAt: number },
        operation: SyncOp['operation'] = 'upsert',
    ): SyncOp => ({
        createdAt: over.updatedAt,
        entity: 'track_flags',
        entityId: over.id,
        operation,
        opId: `op-${over.id}-${over.updatedAt}`,
        payload: {
            contentKey: 'k',
            deleted: false,
            dontCount: false,
            jellyfinId: 't1',
            notInterested: false,
            originDevice: 'phone',
            ...over,
        },
    });

    it('keeps the newer row and forgets the other, whichever arrived first', () => {
        flags.setNotInterested('t1', 'k', true);
        const local = flags.flags('t1');
        expect(local).toBeDefined();

        // The phone's row is newer than ours, so it wins and ours goes.
        const newer = remote({
            dontCount: true,
            id: 'phone-row',
            updatedAt: (local?.updatedAt ?? 0) + 1,
        });
        expect(store.applyRemote(newer)).toBe('applied');

        expect(rowsFor('t1').map((row) => row.id)).toEqual(['phone-row']);
        expect(flags.flags('t1')).toMatchObject({ dontCount: true, id: 'phone-row' });
    });

    it('ignores the older row whole and keeps ours', () => {
        flags.setNotInterested('t1', 'k', true);
        const local = flags.flags('t1');

        const older = remote({
            dontCount: true,
            id: 'phone-row',
            updatedAt: (local?.updatedAt ?? 0) - 1,
        });
        expect(store.applyRemote(older)).toBe('ignored');

        expect(rowsFor('t1').map((row) => row.id)).toEqual([local?.id]);
        expect(flags.flags('t1')).toMatchObject({ dontCount: false, notInterested: true });
    });

    it('breaks a tie on the device id, the same way on every device', () => {
        // Row ids and stamps equal on both sides; only the device differs, and
        // the greater one wins — arbitrary, and identical everywhere.
        store.applyRemote(remote({ id: 'row-a', originDevice: 'aaa', updatedAt: 100 }));
        expect(
            store.applyRemote(remote({ id: 'row-b', originDevice: 'zzz', updatedAt: 100 })),
        ).toBe('applied');
        expect(rowsFor('t1').map((row) => row.id)).toEqual(['row-b']);

        expect(
            store.applyRemote(remote({ id: 'row-c', originDevice: 'mmm', updatedAt: 100 })),
        ).toBe('ignored');
        expect(rowsFor('t1').map((row) => row.id)).toEqual(['row-b']);
    });

    it('does the same for likes, which hold one row per track too', () => {
        const like = (id: string, updatedAt: number, liked: boolean): SyncOp => ({
            createdAt: updatedAt,
            entity: 'likes',
            entityId: id,
            operation: 'upsert',
            opId: `like-${id}`,
            payload: {
                contentKey: 'k',
                deleted: false,
                id,
                jellyfinId: 't1',
                liked,
                originDevice: 'phone',
                updatedAt,
            },
        });

        expect(store.applyRemote(like('old', 10, true))).toBe('applied');
        // Without the dedupe this second row trips the unique index on
        // jellyfinId and the sync dies on a constraint error.
        expect(store.applyRemote(like('new', 20, false))).toBe('applied');
        expect(store.live('likes').map((row) => row.id)).toEqual(['new']);
        expect(store.applyRemote(like('older', 5, true))).toBe('ignored');
    });
});

describe('the same row from another device', () => {
    it('merges each flag on its own stamp rather than taking the whole row', () => {
        flags.setNotInterested('t1', 'k', true);
        const local = flags.flags('t1');
        if (!local) throw new Error('no row');

        // The phone set dontCount at the same instant our notInterested was
        // set, on an older copy of the row where notInterested was still off.
        const op: SyncOp = {
            createdAt: local.updatedAt,
            entity: 'track_flags',
            entityId: local.id,
            operation: 'upsert',
            opId: 'phone-edit',
            payload: {
                contentKey: 'k',
                deleted: false,
                dontCount: true,
                fieldUpdatedAt: { dontCount: local.updatedAt + 5, notInterested: 1 },
                id: local.id,
                jellyfinId: 't1',
                notInterested: false,
                originDevice: 'phone',
                updatedAt: local.updatedAt + 5,
            },
        };

        expect(store.applyRemote(op)).toBe('applied');
        expect(flags.flags('t1')).toMatchObject({ dontCount: true, notInterested: true });
    });
});
