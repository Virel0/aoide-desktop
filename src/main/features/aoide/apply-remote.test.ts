import type { SyncOp } from '/@/shared/aoide/sync-types';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';

let alpha: CurationDatabase;
let beta: CurationDatabase;
let a: CurationStore;
let b: CurationStore;

beforeEach(() => {
    alpha = openCurationDatabase(':memory:');
    beta = openCurationDatabase(':memory:');
    a = new CurationStore(alpha);
    b = new CurationStore(beta);
});

afterEach(() => {
    alpha.close();
    beta.close();
});

const only = (store: CurationStore) => store.live('playlists')[0];

describe('applying an op from another device', () => {
    // Without this, an inbound change produces an outbound op, which reaches
    // every other device, which produces another. The log is for changes this
    // device made.
    it('writes the row and appends nothing to the op log', () => {
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });

        expect(b.applyRemote(op)).toBe('applied');
        expect(only(b).name).toBe('Driving');
        expect(b.pendingOps()).toHaveLength(0);
    });

    it('is a no-op the second time, which is what makes retrying safe', () => {
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });

        expect(b.applyRemote(op)).toBe('applied');
        expect(b.applyRemote(op)).toBe('ignored');
        expect(b.live('playlists')).toHaveLength(1);
    });

    it('carries a soft delete across', () => {
        const created = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        b.applyRemote(created.op);

        const deleted = a.record(
            'playlists',
            { id: 'p1', name: 'Driving', sortIndex: 'a0' },
            'delete',
        );
        b.applyRemote(deleted.op);

        expect(b.live('playlists')).toHaveLength(0);
    });

    // Found by two tests failing at once: a create and a delete issued in the
    // same millisecond carried the same `updatedAt`, so every other device saw
    // a tie, kept what it had, and dropped the delete without a trace.
    it('distinguishes two edits to one row inside the same millisecond', () => {
        const first = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        const second = a.record('playlists', { id: 'p1', name: 'Road Trip', sortIndex: 'a0' });

        expect(Number(second.op.payload.updatedAt)).toBeGreaterThan(
            Number(first.op.payload.updatedAt),
        );

        b.applyRemote(first.op);
        expect(b.applyRemote(second.op)).toBe('applied');
        expect(only(b).name).toBe('Road Trip');
    });

    // The counterpart: the fix must not run ahead of the wall clock across
    // *different* rows, or a bulk import leaves the device believing it is in
    // the future and skew-correcting its own writes.
    it('does not run ahead of the clock across different rows', () => {
        const before = Date.now();
        for (let index = 0; index < 200; index += 1) {
            a.record('playlists', { id: `p${index}`, name: 'x', sortIndex: 'a0' });
        }
        const rows = a.live('playlists');
        const latest = Math.max(...rows.map((r) => Number(r.updatedAt)));

        expect(latest).toBeLessThanOrEqual(Date.now());
        expect(latest - before).toBeLessThan(200);
    });

    it('ignores an op whose payload has no identifier', () => {
        const op: SyncOp = {
            createdAt: 1,
            entity: 'playlists',
            entityId: 'p1',
            operation: 'upsert',
            opId: 'op-1',
            payload: { name: 'Nameless' },
        };

        expect(b.applyRemote(op)).toBe('ignored');
        expect(b.live('playlists')).toHaveLength(0);
    });

    describe('play events', () => {
        const event = (id: string) => ({
            contentKey: 'k',
            id,
            jellyfinId: 'track-1',
            msPlayed: 200_000,
            startedAt: 1,
        });

        it('does not double-count a replayed event', () => {
            const { op } = a.record('play_events', event('e1'));

            expect(b.applyRemote(op)).toBe('applied');
            expect(b.applyRemote(op)).toBe('ignored');
            expect(b.live('play_events')).toHaveLength(1);
        });

        it('keeps the original event rather than overwriting it', () => {
            const { op } = a.record('play_events', event('e1'));
            b.applyRemote(op);

            const tampered: SyncOp = { ...op, payload: { ...op.payload, msPlayed: 1 } };
            b.applyRemote(tampered);

            expect(b.live('play_events')[0].msPlayed).toBe(200_000);
        });
    });
});

/**
 * The claim the whole schema rename rests on, tested against a payload shaped
 * the way the phone actually writes one.
 *
 * iOS builds every payload as the encoded record — `CurationStore.recordRow`
 * calls `Self.json(row)` — so the payload's keys *are* its column names, and
 * `applyRemote` writes them straight back into columns of the same name. Every
 * key below is a property of `CurationKit`'s `Playlist`, in its declared order,
 * with Swift's booleans as JSON booleans and its optionals omitted when nil.
 *
 * Against the snake_case schema this replaced, almost none of it landed: `name`
 * and `id` matched, `notes` had no column at all because that schema called it
 * `description`, and the insert died on the NOT NULL `sort_index` it could not
 * find. Sync with the phone did not work, and the failure was a constraint
 * error rather than anything that pointed at the cause.
 */
describe('an op the phone wrote', () => {
    const PHONE = '11111111-2222-4333-8444-555555555555';
    const COVER = 'f'.repeat(64);

    const stamps = { name: 1_754_500_000_500, notes: 1_754_500_000_100 };

    const phonePayload: Record<string, unknown> = {
        artworkItemId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        deleted: false,
        fieldUpdatedAt: stamps,
        folderId: 'B2E7C1D0-1111-4A2B-9C3D-4E5F60718293',
        id: 'C0FFEE00-2222-4B3C-8D4E-5F6071829304',
        imageHash: COVER,
        imageMime: 'image/jpeg',
        isSmart: true,
        name: 'Long Drives',
        notes: 'for the motorway',
        originDevice: PHONE,
        smartRules: '{"match":"all","rules":[{"field":"genre","op":"is","value":"Jazz"}]}',
        sortIndex: 'a0',
        sourceJellyfinId: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
        updatedAt: 1_754_500_000_500,
    };

    const phoneOp = (payload: Record<string, unknown> = phonePayload): SyncOp => ({
        createdAt: Number(payload.updatedAt),
        entity: 'playlists',
        entityId: String(payload.id),
        operation: 'upsert',
        opId: '11111111-2222-3333-4444-555555555555',
        payload,
    });

    it('lands every field of it in a column of the same name', () => {
        expect(b.applyRemote(phoneOp())).toBe('applied');

        const stored = beta.db
            .prepare('SELECT * FROM playlists WHERE id = ?')
            .get(phonePayload.id as string) as Record<string, unknown>;

        const { fieldUpdatedAt, ...columns } = stored;

        // Every column of the table, spelled out rather than sampled: a
        // `toMatchObject` here would pass while a column silently arrived null,
        // which is exactly the shape of the failure being ruled out.
        expect(columns).toEqual({
            artworkItemId: phonePayload.artworkItemId,
            // Swift encodes its booleans as JSON booleans; SQLite has none, so
            // they arrive as the integers the schema declares.
            deleted: 0,
            folderId: phonePayload.folderId,
            id: phonePayload.id,
            imageHash: COVER,
            imageMime: 'image/jpeg',
            isSmart: 1,
            name: 'Long Drives',
            notes: 'for the motorway',
            originDevice: PHONE,
            smartRules: phonePayload.smartRules,
            sortIndex: 'a0',
            sourceJellyfinId: phonePayload.sourceJellyfinId,
            updatedAt: 1_754_500_000_500,
        });

        // The stamps are the one key that changes shape crossing the boundary:
        // an object on the wire, JSON text in the column.
        expect(JSON.parse(String(fieldUpdatedAt))).toEqual(stamps);
    });

    it('shows it as a live playlist rather than merely storing it', () => {
        b.applyRemote(phoneOp());

        expect(b.live('playlists')).toHaveLength(1);
        expect(only(b).notes).toBe('for the motorway');
    });

    // The stamps have to be kept on a first sighting, not only on a merge.
    // Dropped, every field of the new row falls back to its `updatedAt`, and
    // the next op to arrive — an older edit to a field the map says it should
    // still win — loses against a timestamp that was never about that field.
    it('lets a later edit to one field win on the stamp it arrived with', () => {
        b.applyRemote(phoneOp());

        // Written before the rename above, and after the notes were last
        // touched. Older row, newer field.
        const editedNotes = b.applyRemote(
            phoneOp({
                ...phonePayload,
                fieldUpdatedAt: { notes: 1_754_500_000_400 },
                notes: 'and the long way home',
                originDevice: 'a-third-device',
                updatedAt: 1_754_500_000_300,
            }),
        );

        expect(editedNotes).toBe('applied');
        expect(only(b).notes).toBe('and the long way home');
        // The rename is newer than that edit and must survive it.
        expect(only(b).name).toBe('Long Drives');
    });
});

describe('two devices editing one playlist', () => {
    // The motivating case for per-field merging, run end to end through two
    // real stores rather than asserted against the merge function directly.
    it('both win the field they edited, and agree afterwards', () => {
        const created = a.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        b.applyRemote(created.op);

        // Device A renames. Device B writes the notes. Neither has seen the
        // other's edit.
        const renamed = a.record('playlists', {
            id: 'p1',
            name: 'Road Trip',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        const described = b.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'for the motorway',
            sortIndex: 'a0',
        });

        a.applyRemote(described.op);
        b.applyRemote(renamed.op);

        expect(only(a).name).toBe('Road Trip');
        expect(only(a).notes).toBe('for the motorway');
        expect(only(b).name).toBe(only(a).name);
        expect(only(b).notes).toBe(only(a).notes);
    });

    it('converges regardless of the order the ops arrive in', () => {
        const created = a.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        b.applyRemote(created.op);

        const renamed = a.record('playlists', {
            id: 'p1',
            name: 'Road Trip',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        const described = b.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'for the motorway',
            sortIndex: 'a0',
        });

        // A third device sees them in the opposite order to everyone else.
        const third = openCurationDatabase(':memory:');
        const c = new CurationStore(third);
        c.applyRemote(created.op);
        c.applyRemote(described.op);
        c.applyRemote(renamed.op);

        a.applyRemote(described.op);
        b.applyRemote(renamed.op);

        expect(only(c).name).toBe(only(a).name);
        expect(only(c).notes).toBe(only(a).notes);
        third.close();
    });

    it('leaves the local row alone when the inbound op is older', () => {
        const created = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        b.applyRemote(created.op);

        // B edits after A's write, then A's original op arrives again.
        b.record('playlists', { id: 'p1', name: 'Newer', sortIndex: 'a0' });
        expect(b.applyRemote(created.op)).toBe('ignored');
        expect(only(b).name).toBe('Newer');
    });
});

describe('field stamps on local writes', () => {
    it('stamps only the field that changed', () => {
        a.record('playlists', {
            id: 'p1',
            name: 'Driving',
            notes: 'placeholder',
            sortIndex: 'a0',
        });
        const renamed = a.record('playlists', {
            id: 'p1',
            name: 'Road Trip',
            notes: 'placeholder',
            sortIndex: 'a0',
        });

        const stamps = renamed.op.payload.fieldUpdatedAt as Record<string, number>;
        expect(stamps).toBeDefined();
        expect(stamps.name).toBeGreaterThan(stamps.notes);
    });

    it('writes no stamp map for a brand new row', () => {
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        expect(op.payload.fieldUpdatedAt).toBeUndefined();
    });

    // The column and the wire key are the same name now that the schema is the
    // phone's, so what is left to check is the *shape*: SQLite holds the map as
    // text and the payload carries the object. Sending the text would give
    // every receiver a string where it parses a map, and it would compare
    // against `undefined` for every field — silently, since a row with no
    // stamps is a legitimate state that falls back to `updatedAt`.
    it('sends the stamp map as an object, not as the column its text is stored in', () => {
        a.record('playlists', { id: 'p1', name: 'Driving', sortIndex: 'a0' });
        const { op } = a.record('playlists', { id: 'p1', name: 'Road Trip', sortIndex: 'a0' });

        expect(typeof op.payload.fieldUpdatedAt).toBe('object');

        const stored = alpha.db
            .prepare('SELECT fieldUpdatedAt FROM playlists WHERE id = ?')
            .get('p1') as { fieldUpdatedAt: string };
        expect(typeof stored.fieldUpdatedAt).toBe('string');
        expect(JSON.parse(stored.fieldUpdatedAt)).toEqual(op.payload.fieldUpdatedAt);
    });

    it('does not stamp entities that merge per row', () => {
        const { op } = a.record('likes', {
            contentKey: 'k',
            id: 'l1',
            jellyfinId: 'track-1',
            liked: 1,
        });

        expect(op.payload.fieldUpdatedAt).toBeUndefined();
    });
});
