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
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });

        expect(b.applyRemote(op)).toBe('applied');
        expect(only(b).name).toBe('Driving');
        expect(b.pendingOps()).toHaveLength(0);
    });

    it('is a no-op the second time, which is what makes retrying safe', () => {
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });

        expect(b.applyRemote(op)).toBe('applied');
        expect(b.applyRemote(op)).toBe('ignored');
        expect(b.live('playlists')).toHaveLength(1);
    });

    it('carries a soft delete across', () => {
        const created = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });
        b.applyRemote(created.op);

        const deleted = a.record(
            'playlists',
            { id: 'p1', name: 'Driving', sort_index: 'a0' },
            'delete',
        );
        b.applyRemote(deleted.op);

        expect(b.live('playlists')).toHaveLength(0);
    });

    // Found by two tests failing at once: a create and a delete issued in the
    // same millisecond carried the same `updated_at`, so every other device saw
    // a tie, kept what it had, and dropped the delete without a trace.
    it('distinguishes two edits to one row inside the same millisecond', () => {
        const first = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });
        const second = a.record('playlists', { id: 'p1', name: 'Road Trip', sort_index: 'a0' });

        expect(Number(second.op.payload.updated_at)).toBeGreaterThan(
            Number(first.op.payload.updated_at),
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
            a.record('playlists', { id: `p${index}`, name: 'x', sort_index: 'a0' });
        }
        const rows = a.live('playlists');
        const latest = Math.max(...rows.map((r) => Number(r.updated_at)));

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
            content_key: 'k',
            id,
            jellyfin_id: 'track-1',
            ms_played: 200_000,
            started_at: 1,
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

            const tampered: SyncOp = { ...op, payload: { ...op.payload, ms_played: 1 } };
            b.applyRemote(tampered);

            expect(b.live('play_events')[0].ms_played).toBe(200_000);
        });
    });
});

describe('two devices editing one playlist', () => {
    // The motivating case for per-field merging, run end to end through two
    // real stores rather than asserted against the merge function directly.
    it('both win the field they edited, and agree afterwards', () => {
        const created = a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Driving',
            sort_index: 'a0',
        });
        b.applyRemote(created.op);

        // Device A renames. Device B writes a description. Neither has seen the
        // other's edit.
        const renamed = a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Road Trip',
            sort_index: 'a0',
        });
        const described = b.record('playlists', {
            description: 'for the motorway',
            id: 'p1',
            name: 'Driving',
            sort_index: 'a0',
        });

        a.applyRemote(described.op);
        b.applyRemote(renamed.op);

        expect(only(a).name).toBe('Road Trip');
        expect(only(a).description).toBe('for the motorway');
        expect(only(b).name).toBe(only(a).name);
        expect(only(b).description).toBe(only(a).description);
    });

    it('converges regardless of the order the ops arrive in', () => {
        const created = a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Driving',
            sort_index: 'a0',
        });
        b.applyRemote(created.op);

        const renamed = a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Road Trip',
            sort_index: 'a0',
        });
        const described = b.record('playlists', {
            description: 'for the motorway',
            id: 'p1',
            name: 'Driving',
            sort_index: 'a0',
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
        expect(only(c).description).toBe(only(a).description);
        third.close();
    });

    it('leaves the local row alone when the inbound op is older', () => {
        const created = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });
        b.applyRemote(created.op);

        // B edits after A's write, then A's original op arrives again.
        b.record('playlists', { id: 'p1', name: 'Newer', sort_index: 'a0' });
        expect(b.applyRemote(created.op)).toBe('ignored');
        expect(only(b).name).toBe('Newer');
    });
});

describe('field stamps on local writes', () => {
    it('stamps only the field that changed', () => {
        a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Driving',
            sort_index: 'a0',
        });
        const renamed = a.record('playlists', {
            description: 'placeholder',
            id: 'p1',
            name: 'Road Trip',
            sort_index: 'a0',
        });

        const stamps = renamed.op.payload.fieldUpdatedAt as Record<string, number>;
        expect(stamps).toBeDefined();
        expect(stamps.name).toBeGreaterThan(stamps.description);
    });

    it('writes no stamp map for a brand new row', () => {
        const { op } = a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });
        expect(op.payload.fieldUpdatedAt).toBeUndefined();
    });

    it('keeps the local column out of the payload', () => {
        a.record('playlists', { id: 'p1', name: 'Driving', sort_index: 'a0' });
        const { op } = a.record('playlists', { id: 'p1', name: 'Road Trip', sort_index: 'a0' });

        expect(op.payload.field_updated_at).toBeUndefined();
    });

    it('does not stamp entities that merge per row', () => {
        const { op } = a.record('likes', {
            content_key: 'k',
            id: 'l1',
            jellyfin_id: 'track-1',
            liked: 1,
        });

        expect(op.payload.fieldUpdatedAt).toBeUndefined();
    });
});
