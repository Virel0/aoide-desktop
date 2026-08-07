import type { SyncOp } from '/@/shared/aoide/sync-types';

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { IMAGE_GRACE_DAYS, ImageBlobStore, imageHash } from './image-blobs';

const DAY = 24 * 60 * 60 * 1000;

let blobs: ImageBlobStore;
let curation: CurationStore;
let database: CurationDatabase;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    blobs = new ImageBlobStore(database);
    curation = new CurationStore(database);
});

afterEach(() => database.close());

/** Distinct bytes per label, so two "pictures" are genuinely two pictures. */
const picture = (label: string): Uint8Array => new Uint8Array(Buffer.from(`jpeg-ish:${label}`));

const playlist = (overrides: Record<string, unknown> = {}) => ({
    id: 'playlist-1',
    name: 'Driving',
    sortIndex: 'a0',
    ...overrides,
});

/** An op as it would arrive from the log, for the cases the log cannot produce. */
const op = (payload: Record<string, unknown>): SyncOp => ({
    createdAt: 1,
    entity: 'playlists',
    entityId: 'playlist-1',
    operation: 'upsert',
    opId: 'op-1',
    payload,
});

describe('store', () => {
    it('addresses bytes by their own SHA-256, lower-case hex', () => {
        const bytes = picture('a');
        const hash = blobs.store(bytes, 'image/jpeg');

        expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(imageHash(bytes)).toBe(hash);
    });

    // The whole point of content addressing: the same cover chosen twice, or
    // shared by a second playlist, is one blob rather than a conflict.
    it('keeps one row when the same bytes are stored twice', () => {
        const first = blobs.store(picture('a'), 'image/jpeg');
        const second = blobs.store(picture('a'), 'image/jpeg');

        expect(second).toBe(first);
        expect(database.db.prepare('SELECT * FROM image_blobs').all()).toHaveLength(1);
    });

    it('keeps two different pictures apart', () => {
        blobs.store(picture('a'), 'image/jpeg');
        blobs.store(picture('b'), 'image/png');

        expect(database.db.prepare('SELECT * FROM image_blobs').all()).toHaveLength(2);
    });

    // Re-storing must not make the server look as though it has forgotten
    // bytes it holds — that blocks the next push behind an upload of something
    // already there, and blocks it again on every failure of that upload.
    it('does not forget that the server already holds bytes stored again', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        blobs.markUploaded(hash);

        blobs.store(picture('a'), 'image/jpeg');

        expect(blobs.pendingUploads()).toHaveLength(0);
    });
});

describe('get and has', () => {
    it('round-trips the bytes and the mime unchanged', () => {
        const bytes = picture('a');
        const hash = blobs.store(bytes, 'image/webp');

        const held = blobs.get(hash);
        expect(held?.mime).toBe('image/webp');
        expect(Array.from(held?.bytes ?? [])).toEqual(Array.from(bytes));
    });

    // A cover this device has not fetched yet is the ordinary case, not a
    // fault: inbound covers are fetched lazily, when something is about to draw
    // one, never during sync.
    it('reports a hash it does not hold rather than throwing', () => {
        expect(blobs.get('f'.repeat(64))).toBeUndefined();
        expect(blobs.has('f'.repeat(64))).toBe(false);
    });

    it('answers for a hash that arrives in upper case', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');

        expect(blobs.has(hash.toUpperCase())).toBe(true);
        expect(blobs.get(hash.toUpperCase())).toBeDefined();
    });
});

// The rule everything depends on. An op naming a hash the server does not hold
// leaves every other device with a playlist whose cover can never be fetched,
// and nothing afterwards notices — the row is perfectly valid, the image simply
// is not there.
describe('the upload-before-push ordering rule', () => {
    it('reports the blob a pending op names as needed before push', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        curation.record('playlists', playlist({ imageHash: hash, imageMime: 'image/jpeg' }));

        const needed = blobs.imagesNeededBeforePush(curation.pendingOps());

        expect(needed.map((blob) => blob.sha256)).toEqual([hash]);
        expect(needed[0].uploaded).toBe(false);
        expect(needed[0].mime).toBe('image/jpeg');
    });

    it('stops reporting it once the server has the bytes', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        curation.record('playlists', playlist({ imageHash: hash, imageMime: 'image/jpeg' }));

        blobs.markUploaded(hash);

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(0);
    });

    // The hash lives in the payload the op will be pushed with, so a rename
    // that carries the cover forward carries its requirement with it. Nothing
    // tracked alongside could stay in step through this.
    it('follows the hash into a later edit of the same playlist', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        const created = curation.record(
            'playlists',
            playlist({ imageHash: hash, imageMime: 'image/jpeg' }),
        );
        curation.markSynced([created.op.opId]);

        curation.record(
            'playlists',
            playlist({ imageHash: hash, imageMime: 'image/jpeg', name: 'Driving II' }),
        );

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(1);
    });

    it('says nothing once the op naming it has been accepted', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        const { op: recorded } = curation.record(
            'playlists',
            playlist({ imageHash: hash, imageMime: 'image/jpeg' }),
        );

        curation.markSynced([recorded.opId]);

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(0);
    });

    // An inbound cover another device already uploaded, on a playlist this one
    // has since re-edited. There is nothing here to send, and waiting for it
    // would wedge the push forever.
    it('does not demand a hash this device does not hold', () => {
        curation.record(
            'playlists',
            playlist({ imageHash: 'a'.repeat(64), imageMime: 'image/jpeg' }),
        );

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(0);
    });

    it('lets a playlist with no cover push immediately', () => {
        blobs.store(picture('a'), 'image/jpeg');
        curation.record('playlists', playlist());

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(0);
    });

    // `imageHash` is what both clients write, because a payload is the row and
    // the column is `imageHash` on each of them. This is the spelling that has
    // to work; it is exercised through the real store above and again against
    // the sweep below, so the two ends cannot drift apart.
    it('reads a hand-built payload under the spelling both clients write', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');

        expect(
            blobs.imagesNeededBeforePush([op({ id: 'playlist-1', imageHash: hash })]),
        ).toHaveLength(1);
    });

    // Insurance, not a live path. Failing to recognise a hash costs an op
    // pushed before its bytes — a cover no other device can ever fetch, with
    // nothing anywhere reporting it — while recognising a spelling nothing
    // writes costs one property read.
    it('still reads a snake_case hash, which nothing writes but anything could', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');

        expect(
            blobs.imagesNeededBeforePush([op({ id: 'playlist-1', image_hash: hash })]),
        ).toHaveLength(1);
    });

    // A delete's payload carries the whole row, cover and all, and nothing will
    // ever draw that row. Holding the delete back until a picture for a
    // playlist being thrown away has uploaded blocks the queue on work with no
    // reader — and if the upload is what is broken, the delete never leaves.
    it('does not hold a delete back for the cover of the playlist being deleted', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        const created = curation.record('playlists', playlist({ imageHash: hash }));
        curation.markSynced([created.op.opId]);

        curation.record('playlists', playlist({ imageHash: hash }), 'delete');

        expect(curation.pendingOps().map((pending) => pending.operation)).toEqual(['delete']);
        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(0);
    });

    // The other half of the same decision: an upsert queued beside that delete
    // still names its cover, so one delete in the batch must not excuse it.
    it('still demands the cover of an upsert sitting beside a delete', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        curation.record('playlists', playlist({ id: 'doomed', imageHash: hash }), 'delete');
        curation.record('playlists', playlist({ id: 'kept', imageHash: hash }));

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(1);
    });

    it('names each blob once however many ops share it', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');
        curation.record('playlists', playlist({ imageHash: hash }));
        curation.record('playlists', playlist({ id: 'playlist-2', imageHash: hash }));

        expect(blobs.imagesNeededBeforePush(curation.pendingOps())).toHaveLength(1);
    });

    it('has nothing to say about an empty queue', () => {
        blobs.store(picture('a'), 'image/jpeg');

        expect(blobs.imagesNeededBeforePush([])).toHaveLength(0);
    });
});

describe('pendingUploads', () => {
    it('lists what the server has not been given, oldest first', () => {
        const now = Date.now();
        const second = blobs.store(picture('b'), 'image/png', now);
        const first = blobs.store(picture('a'), 'image/jpeg', now - 1000);

        expect(blobs.pendingUploads().map((blob) => blob.sha256)).toEqual([first, second]);
    });

    // A cover that will not upload does not fail the sync: everything else
    // pushes and the op naming it waits. The retry has to be able to find the
    // blob again afterwards, with no op to lead it there.
    it('still finds a failed upload after its op is gone', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg');

        expect(blobs.imagesNeededBeforePush([])).toHaveLength(0);
        expect(blobs.pendingUploads().map((blob) => blob.sha256)).toEqual([hash]);
    });

    // A blob is held throughout, so this says something: marking a hash that is
    // not here must leave the one that is alone. With nothing stored, the
    // assertion held even against a `markUploaded` that marked every row.
    it('ignores a hash it was told to mark but never held', () => {
        const held = blobs.store(picture('a'), 'image/jpeg');

        expect(() => blobs.markUploaded('b'.repeat(64))).not.toThrow();

        expect(blobs.pendingUploads().map((blob) => blob.sha256)).toEqual([held]);
    });
});

describe('orphaned', () => {
    const now = Date.now();

    // A caller asking to sweep more aggressively is asking to defeat the reason
    // the period exists — a phone in a drawer still holds playlists naming
    // these hashes. The floor was an explicit fix on iOS.
    it('raises a grace shorter than thirty days rather than honouring it', () => {
        const recent = blobs.store(picture('a'), 'image/jpeg', now - 10 * DAY);
        const old = blobs.store(picture('b'), 'image/jpeg', now - 40 * DAY);

        const swept = blobs.orphaned(1, now).map((blob) => blob.sha256);

        // Ten days old, asked for with a one-day grace, and still kept.
        expect(swept).not.toContain(recent);
        // And the floor has not simply disabled the sweep.
        expect(swept).toContain(old);
    });

    it('treats a zero or negative grace the same way', () => {
        blobs.store(picture('a'), 'image/jpeg', now - 10 * DAY);

        expect(blobs.orphaned(0, now)).toHaveLength(0);
        expect(blobs.orphaned(-365, now)).toHaveLength(0);
    });

    it('honours a grace longer than thirty days', () => {
        blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);

        expect(blobs.orphaned(60, now)).toHaveLength(0);
        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now)).toHaveLength(1);
    });

    it('keeps a blob a live playlist still names', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        curation.record('playlists', playlist({ imageHash: hash }));

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now)).toHaveLength(0);
    });

    // `sha256` is normalised on write and always lower-case; `imageHash` is
    // whatever a payload said, written verbatim. SQLite compares TEXT
    // case-sensitively, so without folding both sides a live cover would be
    // reported reclaimable purely for having arrived shouting — and unlike
    // every other mistake here, that one costs an image nobody can get back.
    it('keeps a blob whose playlist named it in upper case', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        curation.record('playlists', playlist({ imageHash: hash.toUpperCase() }));

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now)).toHaveLength(0);
    });

    // End to end, through the store rather than an INSERT: the column the sweep
    // consults has to be the one `applyRemote` actually writes. If those two
    // spellings ever part company the sweep sees no playlist naming anything
    // and quietly reports every cover on the device as reclaimable.
    it('keeps a blob named by a playlist that arrived from another device', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        const phone = openCurationDatabase(':memory:');
        const theirs = new CurationStore(phone);

        const { op: theirOp } = theirs.record(
            'playlists',
            playlist({ id: 'from-the-phone', imageHash: hash }),
        );
        expect(curation.applyRemote(theirOp)).toBe('applied');
        expect(curation.live('playlists')[0].imageHash).toBe(hash);

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now)).toHaveLength(0);
        phone.close();
    });

    it('reclaims one only a deleted playlist named', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        curation.record('playlists', playlist({ imageHash: hash }));
        curation.record('playlists', playlist({ imageHash: hash }), 'delete');

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now).map((blob) => blob.sha256)).toEqual([hash]);
    });

    // `NOT IN` against a set containing NULL is never true for any row, so one
    // coverless playlist — which every account has — would otherwise make the
    // sweep quietly return nothing forever.
    it('is not silenced by a playlist that has no cover', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        curation.record('playlists', playlist({ id: 'coverless' }));

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now).map((blob) => blob.sha256)).toEqual([hash]);
    });

    it('keeps a shared blob while either playlist lives', () => {
        const hash = blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);
        curation.record('playlists', playlist({ imageHash: hash }));
        curation.record('playlists', playlist({ id: 'playlist-2', imageHash: hash }));

        curation.record('playlists', playlist({ imageHash: hash }), 'delete');

        expect(blobs.orphaned(IMAGE_GRACE_DAYS, now)).toHaveLength(0);
    });

    it('reports rather than reclaims, so the caller decides', () => {
        blobs.store(picture('a'), 'image/jpeg', now - 40 * DAY);

        blobs.orphaned(IMAGE_GRACE_DAYS, now);

        expect(database.db.prepare('SELECT * FROM image_blobs').all()).toHaveLength(1);
    });
});

describe('forget', () => {
    it('removes only the hashes it was given', () => {
        const doomed = blobs.store(picture('a'), 'image/jpeg');
        const kept = blobs.store(picture('b'), 'image/jpeg');

        expect(blobs.forget([doomed])).toBe(1);
        expect(blobs.has(doomed)).toBe(false);
        expect(blobs.has(kept)).toBe(true);
    });

    it('counts nothing for a hash it never held', () => {
        expect(blobs.forget(['c'.repeat(64)])).toBe(0);
        expect(blobs.forget([])).toBe(0);
    });
});
