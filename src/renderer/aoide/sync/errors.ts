import { ServerReply } from '/@/shared/aoide/sync-types';

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
