/**
 * The wire types for the Aoide sidecar, and the one translation that has to
 * happen at its boundary.
 *
 * `docs/sync-design.md` is the contract. Where this disagrees with the phone,
 * the phone is right — it has been running against this server for longer.
 *
 * Sidecar release 1.7.0.0 added `receivedAt` and `authorUserId` to every pulled
 * op and five endpoints beside the sync pair. The fields that release names are
 * required below; the ones inferred from the shape of the rows it serves are
 * optional. That asymmetry is deliberate — an informational endpoint that omits
 * a field this client guessed at must not be able to fail a sync, because none
 * of these five is in the path of a user's edit.
 */

/**
 * Tables that sync, spelled the way the *server* spells them.
 *
 * The sidecar matches this allow-list strictly and rejects anything else, so a
 * misspelling here is not a warning — it is every op of that kind refused
 * forever. On iOS the store's own tables are singular camelCase and this
 * translation happens at the wire boundary for the same reason it does here:
 * rewriting stored rows to spell it the server's way would be a schema
 * migration in service of a formatting preference.
 */
export const SYNC_ENTITIES = [
    'playlists',
    'playlist_items',
    'folders',
    'likes',
    'play_events',
    'queue_state',
] as const;

export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Where a cover's hash sits inside an op payload.
 *
 * `imageHash` is the answer from both clients: a payload is the row, and the
 * playlist column both of them write is `imageHash`. `image_hash` is read too,
 * and the reason is the asymmetry of being wrong — recognising a spelling
 * nothing writes costs one property read, while failing to recognise one costs
 * an op pushed before its bytes, which is a playlist every other device can see
 * and whose cover none of them can ever fetch, with nothing reporting it.
 *
 * This lives in the wire types because it is a fact about payloads rather than
 * about storage: the main process's `image-blobs.ts` currently carries its own
 * copy, written before there was a shared home for it, and the two must be
 * brought together — two sets that must agree will drift, and this pair drifting
 * means an op pushed ahead of its cover.
 */
export const IMAGE_HASH_KEYS = ['imageHash', 'image_hash'] as const;

/**
 * `tracks` is deliberately absent. It is a per-device cache rebuilt from each
 * device's own Jellyfin connection, and keeping it out of the payload is what
 * keeps a full history sync small. Absent from the type — not merely unused —
 * so a track op is a compile error rather than a request the server refuses.
 */
export const isSyncEntity = (value: string): value is SyncEntity =>
    (SYNC_ENTITIES as readonly string[]).includes(value);

/**
 * The cover hashes that must already be on the server before this op is pushed.
 *
 * **A delete names no cover.** Its payload carries the whole row, hash and all,
 * but nothing will ever draw that row: the receiving device marks it deleted and
 * stops showing it. Holding a delete back until a picture for a playlist being
 * thrown away finishes uploading is a queue blocked on work with no reader — and
 * if the upload is what is broken, the delete never leaves at all. Mirrors the
 * same exclusion in `ImageBlobStore.imagesNeededBeforePush`, which decides which
 * blobs to upload; the two answers have to describe the same set of ops.
 */
export const imageHashesInOp = (op: SyncOp): string[] => {
    if (op.operation === 'delete') return [];

    const hashes: string[] = [];
    for (const key of IMAGE_HASH_KEYS) {
        const value = op.payload[key];
        // Lower-cased because the sidecar addresses blobs by lower-case hex and
        // a hash that arrives shouting still names the same bytes.
        if (typeof value === 'string' && value.length > 0) hashes.push(value.toLowerCase());
    }
    return hashes;
};

/**
 * `GET /aoide/images/orphans` — blobs the server holds that no playlist names.
 *
 * Doubles as "did my upload arrive?": a blob pushed moments ago appears here
 * with `ageDays` 0, because nothing references it until the op naming it lands.
 */
export interface OrphanImage {
    /** Age on the **server's** clock. The grace period is measured against this. */
    ageDays: number;
    sha256: string;
    sizeBytes?: number;
}

/**
 * A playlist shared with another Jellyfin user.
 *
 * Only playlists travel. `play_events`, `likes` and `queue_state` carry no
 * playlist id, so there is nothing to route them across and no way to share
 * them by accident.
 */
export interface PlaylistShare {
    canEdit: boolean;
    granteeUserId: string;
    /** Absent when the server does not name an owner, which means this user. */
    ownerUserId?: string;
    playlistId: string;
}

/** `POST /aoide/retention/prune` — only `play_events` is prunable. */
export interface PruneResult {
    pruned: number;
}

export interface PullResponse {
    cursor: number;
    hasMore: boolean;
    ops: SyncOp[];
}

export interface PushRequest {
    deviceId: string;
    ops: SyncOp[];
}

export interface PushResponse {
    accepted: string[];
    /**
     * The server's head sequence — **not** a pull cursor.
     *
     * Ops from other devices may sit below it that this device has never seen,
     * so storing this as the pull cursor skips them permanently. It is only
     * useful as evidence that the push was durable.
     */
    cursor: number;
    /**
     * Per-op refusals. Not in the original contract; the running server has it.
     *
     * A refused op is quarantined rather than retried — otherwise one malformed
     * op wedges the queue forever. **Exactly one refusal is an exception**, and
     * `classifyRejection` in `sync/errors.ts` is the only thing allowed to tell
     * them apart.
     */
    rejected?: RejectedOp[];
}

/**
 * One device's queue, as `GET /aoide/queue` reports it. Most recently updated
 * first, one entry per device.
 *
 * **Freshness is judged on `ageSeconds` or `receivedAt`, never on `updatedAt`.**
 * Both of the first two come from the server's clock; `updatedAt` comes from the
 * writing device's. A device with a clock set to next year would otherwise claim
 * to be the most recent one forever and win every handover, and the user would
 * be offered a queue from whichever of their machines is most wrong about the
 * time rather than the one they were last listening on.
 */
export interface QueueEntry {
    /** Seconds since the server received this row, on the server's clock. */
    ageSeconds: number;
    deviceId: string;
    deviceName?: string;
    elapsedMs?: number;
    /** True for this device's own row. Handover offers the first entry that is not. */
    isCurrentDevice: boolean;
    position?: number;
    /** When the server received this row, on the server's clock. */
    receivedAt: number;
    trackIds?: string[];
    /** The **writing** device's clock. Never judge freshness on it — see above. */
    updatedAt?: number;
}

/** `POST /aoide/images/orphans/reclaim`. */
export interface ReclaimResult {
    reclaimed: number;
    /** The hashes that went, when the server names them. */
    sha256?: string[];
}

export interface RejectedOp {
    opId: string;
    reason?: string;
}

/** `GET /aoide/retention` — what the server holds and how far back. */
export interface RetentionReport {
    /** How many `play_events` rows the server is storing. */
    eventCount?: number;
    /** The server's own default cutoff, in days, when it names one. */
    olderThanDays?: number;
    /** The oldest event's timestamp, ms since epoch. */
    oldestAt?: number;
}

/** What the server said, kept whole. */
export interface ServerReply {
    body: string;
    status: number;
}

/** `POST /aoide/shares`. Revoking is not retroactive; see `DELETE`. */
export interface ShareRequest {
    canEdit: boolean;
    granteeUserId: string;
    playlistId: string;
}

export interface SyncOp {
    /**
     * The Jellyfin user who wrote this op. On every pulled op since 1.7.0.0,
     * and absent on an op this device is about to push — the server fills it in
     * from the token.
     *
     * It differs from this user only on a shared playlist, which is exactly why
     * it cannot be ignored: a foreign op is another person's edit arriving, not
     * evidence that anything this device queued was accepted.
     */
    authorUserId?: string;
    createdAt: number;
    entity: SyncEntity;
    entityId: string;
    operation: SyncOperation;
    /** The idempotency key. Re-pushing one the server has seen is accepted and ignored. */
    opId: string;
    /** Stored verbatim by the server, which never parses it. */
    payload: Record<string, unknown>;
    /**
     * The server's own clock, stamped as the op arrived. `createdAt` is the
     * writing device's clock, and the pair is the only thing that makes skew
     * detectable: one reference alone cannot tell a fast writer from a slow
     * server.
     *
     * **Ops pushed in one batch share a receipt time.** This therefore says when
     * that device's push landed, not when any single op in it was written — so
     * skew is judged per push and never per op. It is also why a receipt must
     * never be borrowed from a neighbouring op: one pulled page routinely
     * carries several devices' pushes, and lending device A's receipt to device
     * B's ops invents evidence about a clock nobody measured.
     */
    receivedAt?: number;
    /** The server's sequence number, assigned on accept. Present on pulled ops. */
    seq?: number;
}

export type SyncOperation = 'delete' | 'upsert';

/**
 * `GET /aoide/sync/status`.
 *
 * Worth reading for one reason above the rest: since 1.7.0.0 the server's
 * pruning is bounded by the lowest cursor among devices seen recently, and a
 * device that pushes but never pulls is invisible to that guard. This is where
 * a device that has fallen behind becomes visible before its history is gone.
 */
export interface SyncStatus {
    /** The server's head sequence. Still not a pull cursor. */
    cursor: number;
    devices?: SyncStatusDevice[];
    /** The lowest cursor among recently seen devices; retention is bounded by it. */
    lowestCursor?: number;
}

export interface SyncStatusDevice {
    /** Seconds since the server last heard from this device, on the server's clock. */
    ageSeconds?: number;
    /** How far this device has pulled to. Recorded by the server from `GET /pull`. */
    cursor: number;
    deviceId: string;
    isCurrentDevice?: boolean;
}
