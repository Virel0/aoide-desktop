import type { SyncOp } from '/@/shared/aoide/sync-types';
import type { DatabaseSync } from 'node:sqlite';

import { createHash } from 'node:crypto';

import type { CurationDatabase } from './database';

/**
 * Cover art, addressed by the SHA-256 of its own bytes.
 *
 * **Bytes are not in the op log.** Payloads cap at 256 KB and every device
 * replays the whole log, so an image carried inside an op would make a full
 * history sync grow without bound — the one property the whole design rests on.
 * The playlist row carries `imageHash` and `imageMime`, a few dozen bytes
 * travelling through the ordinary log; the bytes move through
 * `PUT/GET/HEAD /aoide/images/{sha256}` on their own.
 *
 * Content addressing earns three things: re-uploading is a no-op rather than a
 * conflict, two playlists sharing a cover store one copy, and clients cache
 * forever — bytes behind a hash cannot change, so there is no invalidation
 * problem to have.
 *
 * This is the local half only. Uploading and fetching belong to the sync
 * engine, which owns the `SidecarClient`; what lives here is the record of what
 * this device holds and whether the server has it, which is the thing the
 * ordering rule below is answered against.
 *
 * `image_blobs` is one of the four purely local tables and keeps snake_case
 * columns: none of its rows is ever encoded into a payload, so no other client
 * ever sees these names. The hash it stores is nonetheless the same string
 * `playlists.imageHash` holds, and every query joining the two has to say so —
 * see `orphaned`.
 */

/**
 * How long a blob nothing references is kept before it is even considered for
 * removal, matching the sidecar's own sweep.
 *
 * The period exists because "nothing references this" is only ever true *here*.
 * A cover dropped on this device may still be named by a playlist another
 * device has not synced yet, and that device may be a phone in a drawer. Thirty
 * days is long enough that a device out of contact for a month is a device that
 * has been replaced.
 */
export const IMAGE_GRACE_DAYS = 30;

/**
 * Where a hash sits inside an op payload.
 *
 * `imageHash` is the answer, from both clients: a payload is the row, and the
 * playlist column both of them write is `imageHash`. It is the only spelling
 * that can reach `playlists.imageHash`, so it is the only one the sweep in
 * `orphaned` consults.
 *
 * `image_hash` is still read here, and the reason is the asymmetry of being
 * wrong. Recognising a spelling nothing writes costs one property read per op.
 * *Failing* to recognise one costs an op pushed before its bytes — a playlist
 * every other device can see and whose cover none of them can ever fetch, with
 * nothing anywhere reporting it, because the row is perfectly valid. Cheap
 * insurance against a payload assembled by hand, by a script, or by a client
 * that has not been brought across yet.
 */
export const IMAGE_HASH_KEYS = ['imageHash', 'image_hash'] as const;

/** A blob and its bytes, as something about to draw a cover needs it. */
export interface HeldImage {
    bytes: Uint8Array;
    mime: string;
}

/** What this device holds, without the bytes. */
export interface ImageBlob {
    createdAt: number;
    mime: string;
    sha256: string;
    /**
     * False until the server has these bytes. An op naming this hash must not
     * be pushed while this is false.
     */
    uploaded: boolean;
}

/**
 * The address the server will know these bytes by.
 *
 * Lower-case hex, and that matters: the sidecar rejects a hash that does not
 * match the bytes it is given, and case is part of matching.
 */
export const imageHash = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

/**
 * A row as SQLite hands it back, snake_case and with no booleans.
 *
 * A type alias rather than an interface on purpose: `node:sqlite` returns
 * `Record<string, SQLOutputValue>`, and only an alias picks up the implicit
 * index signature that makes the assertion legal. As an interface this needs a
 * cast through `unknown`, which would also stop checking the shape.
 */
type BlobRow = {
    created_at: number;
    mime: string;
    sha256: string;
    uploaded: number;
};

export class ImageBlobStore {
    private readonly db: DatabaseSync;

    constructor(database: CurationDatabase) {
        this.db = database.db;
    }

    /**
     * Drop blobs this device is done with.
     *
     * Takes hashes rather than deciding for itself, so the decision and the
     * deletion stay separable — and so no caller can sweep by accident by
     * passing a short grace to `orphaned`.
     */
    forget(hashes: string[]): number {
        if (hashes.length === 0) return 0;

        const statement = this.db.prepare('DELETE FROM image_blobs WHERE sha256 = ?');
        let removed = 0;

        this.db.exec('BEGIN');
        try {
            for (const hash of hashes) {
                removed += Number(statement.run(normalise(hash)).changes);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        return removed;
    }

    /**
     * The bytes, for something that is about to draw them.
     *
     * A miss is not an error and not a reason to sync: an inbound cover is
     * fetched lazily, when a view asks for it, **never during sync**. A device
     * joining an account would otherwise download every cover in the library
     * before it finished syncing, most of which it will never show.
     */
    get(sha256: string): HeldImage | undefined {
        const row = this.db
            .prepare('SELECT bytes, mime FROM image_blobs WHERE sha256 = ?')
            .get(normalise(sha256)) as undefined | { bytes: Uint8Array; mime: string };

        return row ? { bytes: row.bytes, mime: row.mime } : undefined;
    }

    /**
     * Whether this device holds these bytes, without reading them.
     *
     * Separate from `get` because the draw path asks this once per cover on
     * screen, and answering a yes/no by pulling a few hundred kilobytes through
     * SQLite for each one is a stutter somebody will blame on playback.
     */
    has(sha256: string): boolean {
        return (
            this.db
                .prepare('SELECT 1 AS held FROM image_blobs WHERE sha256 = ?')
                .get(normalise(sha256)) !== undefined
        );
    }

    /**
     * Blobs named by ops still waiting to be pushed, that the server has not
     * been given yet. Oldest first.
     *
     * **This is the ordering rule made answerable, and everything depends on
     * it: upload the blob before pushing the op that names it.** An op naming a
     * hash the server does not hold leaves every other device with a playlist
     * whose cover can never be fetched, and nothing afterwards notices — the
     * row is perfectly valid, the image simply is not there.
     *
     * The hashes are read out of the pending ops themselves rather than tracked
     * beside them, so an op and its blob requirement cannot drift apart: an op
     * that names a cover carries its own requirement in the payload it will be
     * pushed with.
     *
     * A hash this device does *not* hold is not reported, because there is
     * nothing here to upload — that is an inbound cover whose bytes some other
     * device already gave the server, arriving back on an op this one has since
     * re-edited. Waiting on it would wedge the push forever.
     *
     * **A delete names no cover.** Its payload carries the whole row, hash and
     * all, but nothing will ever draw that row: the receiving device marks it
     * deleted and stops showing it. Holding the delete back until a picture for
     * a playlist being thrown away finishes uploading is a queue blocked on
     * work with no reader — and if the upload is what is broken, the delete
     * never leaves at all. iOS cannot make this distinction, because it matches
     * hashes with a `LIKE` over the payload text rather than reading the ops;
     * the difference is local scheduling only and reaches no other device.
     */
    imagesNeededBeforePush(pendingOps: SyncOp[]): ImageBlob[] {
        const named = new Set<string>();
        for (const op of pendingOps) {
            if (op.operation === 'delete') continue;
            for (const key of IMAGE_HASH_KEYS) {
                const value = op.payload[key];
                if (typeof value === 'string' && value.length > 0) named.add(normalise(value));
            }
        }

        if (named.size === 0) return [];

        const hashes = [...named];
        const placeholders = hashes.map(() => '?').join(', ');
        const rows = this.db
            .prepare(
                `SELECT sha256, mime, uploaded, created_at FROM image_blobs
                 WHERE uploaded = 0 AND sha256 IN (${placeholders})
                 ORDER BY created_at, sha256`,
            )
            .all(...hashes) as BlobRow[];

        return rows.map(toBlob);
    }

    /**
     * Record that the server now holds these bytes.
     *
     * Only ever called after a successful `PUT`. Marking optimistically would
     * unblock the push of an op naming a cover that never arrived, which is the
     * one failure this table exists to make impossible.
     */
    markUploaded(sha256: string): void {
        this.db
            .prepare('UPDATE image_blobs SET uploaded = 1 WHERE sha256 = ?')
            .run(normalise(sha256));
    }

    /**
     * Blobs no live playlist names, older than the grace period, oldest first.
     *
     * Reports rather than reclaims. Deleting is `forget`'s job and the caller's
     * decision, because it is the one action here that cannot be undone by
     * syncing again — content addressing means keeping a stray blob costs a few
     * kilobytes, while dropping a live one costs an image nobody can get back.
     *
     * A grace shorter than `IMAGE_GRACE_DAYS` is **raised** to it, never
     * honoured. A caller asking to sweep more aggressively is asking to defeat
     * the reason the period exists, and the code that deletes data is the wrong
     * place to take instructions about how careful to be.
     */
    orphaned(olderThanDays: number = IMAGE_GRACE_DAYS, now: number = Date.now()): ImageBlob[] {
        const grace = Math.max(olderThanDays, IMAGE_GRACE_DAYS);
        const cutoff = now - grace * 24 * 60 * 60 * 1000;

        const rows = this.db
            .prepare(
                // Every playlist that still names a hash, not one playlist at a
                // time: a blob shared by two playlists stays alive while either
                // does, and content addressing makes sharing the normal case.
                //
                // `imageHash IS NOT NULL` inside the subquery is load-bearing.
                // `NOT IN` against a set containing NULL is never true for any
                // row, so one coverless playlist — which every account has —
                // would make this quietly return nothing forever.
                //
                // `LOWER` on both sides is the other half, and it protects the
                // unrecoverable direction. `sha256` is normalised on write and
                // is always lower-case hex; `imageHash` is whatever arrived in
                // a payload, written verbatim by `applyRemote`. SQLite compares
                // TEXT case-sensitively, so an upper-case hash from another
                // client would match nothing here and a cover a live playlist
                // still names would be reported reclaimable. Every other
                // mistake this file can make costs a few kilobytes; that one
                // costs an image nobody can get back.
                `SELECT sha256, mime, uploaded, created_at FROM image_blobs
                 WHERE created_at < ?
                   AND LOWER(sha256) NOT IN (
                       SELECT LOWER(imageHash) FROM playlists
                       WHERE imageHash IS NOT NULL AND deleted = 0
                   )
                 ORDER BY created_at, sha256`,
            )
            .all(cutoff) as BlobRow[];

        return rows.map(toBlob);
    }

    /**
     * Everything held that the server has not been given, oldest first.
     *
     * Wider than `imagesNeededBeforePush`: this includes blobs whose op has
     * already gone, which happens when a cover is chosen and the upload fails.
     * A cover that will not upload does not fail the sync — everything else
     * still pushes and the op naming it waits — so the retry has to be able to
     * find it again later, on its own.
     */
    pendingUploads(): ImageBlob[] {
        const rows = this.db
            .prepare(
                `SELECT sha256, mime, uploaded, created_at FROM image_blobs
                 WHERE uploaded = 0 ORDER BY created_at, sha256`,
            )
            .all() as BlobRow[];

        return rows.map(toBlob);
    }

    /**
     * Keep these bytes and return the hash a playlist row should name.
     *
     * Local only, and deliberately no op: the blob is not itself synced state,
     * the playlist row that names it is. Storing the same picture twice — the
     * same cover chosen again, or shared by a second playlist — is one row,
     * which is the whole point of addressing bytes by their content.
     *
     * Downscale before calling this. Five megabytes is the server's ceiling,
     * not a target, and roughly 1000x1000 JPEG is plenty for a cover.
     */
    store(bytes: Uint8Array, mime: string, now: number = Date.now()): string {
        const sha256 = imageHash(bytes);

        this.db
            .prepare(
                // DO NOTHING, not DO UPDATE. An existing row may already be
                // marked uploaded, and re-storing identical bytes must not make
                // the server look as though it has forgotten them: that would
                // block the next push behind an upload of bytes the server
                // already holds, and block it again on every failure of it.
                `INSERT INTO image_blobs (sha256, mime, bytes, uploaded, created_at)
                 VALUES (?, ?, ?, 0, ?)
                 ON CONFLICT(sha256) DO NOTHING`,
            )
            .run(sha256, mime, bytes, now);

        return sha256;
    }
}

/**
 * Hashes are lower-case hex on the wire, so every lookup here folds case first.
 * A hash that arrives shouting still has to find the row it names, rather than
 * reporting the bytes as absent and sending a device off to fetch what it
 * already has.
 */
const normalise = (sha256: string): string => sha256.toLowerCase();

const toBlob = (row: BlobRow): ImageBlob => ({
    createdAt: Number(row.created_at),
    mime: row.mime,
    sha256: row.sha256,
    uploaded: row.uploaded !== 0,
});
