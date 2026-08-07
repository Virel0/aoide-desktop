/**
 * The wire types for the Aoide sidecar, and the one translation that has to
 * happen at its boundary.
 *
 * `docs/sync-design.md` is the contract. Where this disagrees with the phone,
 * the phone is right — it has been running against this server for longer.
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
 * `tracks` is deliberately absent. It is a per-device cache rebuilt from each
 * device's own Jellyfin connection, and keeping it out of the payload is what
 * keeps a full history sync small. Absent from the type — not merely unused —
 * so a track op is a compile error rather than a request the server refuses.
 */
export const isSyncEntity = (value: string): value is SyncEntity =>
    (SYNC_ENTITIES as readonly string[]).includes(value);

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
     * A refused op will never be accepted, so it is quarantined rather than
     * retried — otherwise one malformed op wedges the queue forever.
     */
    rejected?: RejectedOp[];
}

export interface RejectedOp {
    opId: string;
    reason?: string;
}

/** What the server said, kept whole. */
export interface ServerReply {
    body: string;
    status: number;
}

export interface SyncOp {
    createdAt: number;
    entity: SyncEntity;
    entityId: string;
    operation: SyncOperation;
    /** The idempotency key. Re-pushing one the server has seen is accepted and ignored. */
    opId: string;
    /** Stored verbatim by the server, which never parses it. */
    payload: Record<string, unknown>;
}

export type SyncOperation = 'delete' | 'upsert';
