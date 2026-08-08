import { RejectedOp, ServerReply, SyncOp } from '/@/shared/aoide/sync-types';

/**
 * How a failed request should be treated, which is a different question from
 * what went wrong.
 *
 * - `transient` — try again later. Nothing is wrong with the data.
 * - `auth` — the token is no longer good. Retrying cannot help; the user must
 *   sign in again.
 * - `permanent` — the server understood and refused. Retrying is an infinite
 *   loop, so whatever caused it gets quarantined.
 * - `serverFault` — a 5xx. The contract has no place for one, but an unhandled
 *   exception on the server fails the whole request, so the client would retry
 *   the same bytes forever and every innocent change would queue behind the one
 *   op the server cannot swallow. A push that lands here is bisected.
 */
export type SyncFailureKind = 'auth' | 'permanent' | 'serverFault' | 'transient';

export class SyncError extends Error {
    readonly kind: SyncFailureKind;

    /**
     * What the server actually said, kept whole and unsummarised.
     *
     * Three separate faults in this system were diagnosed only after reading
     * this, each time because the client had the evidence and discarded it on
     * the way to a tidier message. Do not summarise an error before it has been
     * useful.
     */
    readonly reply?: ServerReply;

    /** A line worth showing a person, with the server's own words when it gave any. */
    get displayMessage(): string {
        const detail = this.reply?.body?.trim();
        if (!detail) return this.message;
        // Bounded, because a server that returns an HTML error page returns a
        // lot of it, and a dialog is not a log viewer.
        const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
        return `${this.message} — ${trimmed}`;
    }

    /** True when trying the same request again could plausibly work. */
    get isRetryable(): boolean {
        return this.kind === 'transient' || this.kind === 'serverFault';
    }

    constructor(kind: SyncFailureKind, message: string, reply?: ServerReply) {
        super(message);
        this.name = 'SyncError';
        this.kind = kind;
        this.reply = reply;
    }
}

/**
 * The one refusal that a later sync could see accepted.
 *
 * The server says, in full:
 *
 *     Playlist 'p1' belongs to another user and is not shared with you for editing.
 *
 * Only the clause below is matched, and the omissions are the point. The quoted
 * id and the trailing full stop are formatting; requiring them would mean a
 * cosmetic change to the server's wording quietly turns a recoverable refusal
 * back into a permanent one, and the symptom of that is a user's edit vanishing.
 * The clause itself is specific enough that nothing else the sidecar says could
 * contain it.
 *
 * **Matching on prose is fragile in both directions and neither is cheap.**
 * A miss quarantines an edit that was only ever waiting on a share being
 * restored; a false positive leaves an op pending that will be refused again
 * every sync. The engine limits the second by blocking a revoked op for the rest
 * of its run rather than re-pushing it, and by surfacing it either way. If the
 * sidecar ever grows a machine-readable code for this, use that instead and
 * delete this constant — prose is the worst available discriminator and is used
 * here only because it is the one the server offers.
 */
export const REVOKED_SHARE_CLAUSE =
    'belongs to another user and is not shared with you for editing';

/** A refusal that will never become an acceptance. Quarantined, never retried. */
export interface QuarantineOutcome {
    kind: 'quarantine';
    opId: string;
    reason: string;
}

/**
 * How a refused op must be handled.
 *
 * A discriminated union rather than a boolean, and there is no default arm: the
 * quarantine path destroys the user's edit, so reaching it has to be a decision
 * the compiler saw somebody make. `partitionRejections` exists for the same
 * reason — a caller cannot get the list to quarantine without the revoked ones
 * having already been taken out of it.
 */
export type RejectionOutcome = QuarantineOutcome | ShareRevokedOutcome;

/**
 * A refusal that a restored share would turn into an acceptance.
 *
 * It usually means the UI let someone edit a playlist whose share was revoked
 * while their change sat queued. Neither retrying blindly nor discarding is
 * acceptable: the first refuses forever, the second throws away work the person
 * did without telling them it is gone.
 */
export interface ShareRevokedOutcome {
    kind: 'shareRevoked';
    opId: string;
    /**
     * Which playlist, taken from the op when there is one and from the message
     * only as a fallback. The op is the better source by a long way — it is
     * structured, and it does not stop working when somebody rewords an error.
     */
    playlistId: null | string;
    reason: string;
}

export const classifyStatus = (status: number): SyncFailureKind => {
    if (status === 401 || status === 403) return 'auth';
    // 408 and 429 are the two 4xx that mean "later", not "never".
    if (status === 408 || status === 429) return 'transient';
    if (status >= 500) return 'serverFault';
    return 'permanent';
};

export const syncErrorFromReply = (context: string, reply: ServerReply): SyncError =>
    new SyncError(
        classifyStatus(reply.status),
        `${context} returned an error (HTTP ${reply.status})`,
        reply,
    );

/**
 * Decide what a single refusal means.
 *
 * `op` is optional only because a caller may have lost track of which op an id
 * referred to; pass it whenever it is to hand, because it is where the playlist
 * id comes from without reading prose.
 */
export const classifyRejection = (rejected: RejectedOp, op?: SyncOp): RejectionOutcome => {
    const reason = rejected.reason ?? '';

    if (!reason.toLowerCase().includes(REVOKED_SHARE_CLAUSE)) {
        return { kind: 'quarantine', opId: rejected.opId, reason };
    }

    return {
        kind: 'shareRevoked',
        opId: rejected.opId,
        playlistId: playlistIdOf(op) ?? playlistIdFromReason(reason),
        reason,
    };
};

/**
 * Split a push's refusals into the two piles, which is the only supported way
 * to get at the quarantine one.
 *
 * Written as a partition rather than a filter so that the obvious loop — take
 * `rejected`, quarantine every entry — cannot be written by accident. That loop
 * was correct until 1.7.0.0 and is now the way a collaborator's edit disappears.
 */
export const partitionRejections = (
    rejected: RejectedOp[],
    opsById: Map<string, SyncOp> = new Map(),
): { quarantine: QuarantineOutcome[]; shareRevoked: ShareRevokedOutcome[] } => {
    const quarantine: QuarantineOutcome[] = [];
    const shareRevoked: ShareRevokedOutcome[] = [];

    for (const entry of rejected) {
        const outcome = classifyRejection(entry, opsById.get(entry.opId));
        if (outcome.kind === 'quarantine') quarantine.push(outcome);
        else shareRevoked.push(outcome);
    }

    return { quarantine, shareRevoked };
};

/**
 * The quoted playlist id in the server's message, when it is there.
 *
 * A fallback for the fallback: used only when the op itself was not available.
 * Returning null is fine — a revoked edit with an unknown playlist is still
 * surfaced, merely without being able to re-check that one share.
 */
const playlistIdFromReason = (reason: string): null | string =>
    /playlist '([^']+)'/i.exec(reason)?.[1] ?? null;

/**
 * Which playlist an op concerns.
 *
 * A `playlists` op is identified by its own entity id; everything shareable
 * else — playlist items — carries `playlistId` in the payload, because a payload
 * is the row. Nothing else can be refused this way: `play_events`, `likes` and
 * `queue_state` carry no playlist id, so the server has nothing to route them
 * across and cannot refuse them for a share.
 */
const playlistIdOf = (op: SyncOp | undefined): null | string => {
    if (!op) return null;
    if (op.entity === 'playlists') return op.entityId;

    const fromPayload = op.payload.playlistId;
    return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null;
};
