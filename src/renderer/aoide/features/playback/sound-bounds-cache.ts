import type { SoundBounds, SoundBoundsReply } from '/@/shared/aoide/trim-plan';

/**
 * What this device remembers about each track's bounds, and when to ask again.
 *
 * Pure: a map of entries and the rules that read and update it. The store
 * around it owns the fetching and the subscribers; this owns the policy, so
 * the policy has tests.
 *
 * Four states. *Unknown* (no entry) asks. *Asked* is a request in flight, and
 * asks again only after a timeout, in case the request was lost. *Pending* is
 * the sidecar's "not measured yet" and asks again after a minute — the server
 * queues a measurement on the first ask, so the second usually finds it done.
 * *Bounds* and *none* are answers and are kept for the session; a file
 * replaced on the server is the one case that would change them, and the
 * next launch asks afresh.
 */

export type CacheEntry =
    | { askedAt: number; kind: 'asked' }
    | { askedAt: number; kind: 'pending' }
    | { bounds: SoundBounds; kind: 'bounds' }
    | { kind: 'none' };

/** The sidecar measures lazily; a minute is long enough for a track and short enough to notice. */
export const PENDING_RETRY_MS = 60_000;

/** A request that has not answered in this long is presumed lost. */
export const ASKED_TIMEOUT_MS = 30_000;

/**
 * How long to leave a sidecar alone after it answered 404.
 *
 * The endpoint does not exist yet on most installs. Asking once per track
 * change would be a 404 every few minutes forever; asking once per ten
 * minutes notices an upgrade the same day and costs nothing anyone sees.
 */
export const ABSENT_RETRY_MS = 10 * 60_000;

/** Whether an entry (or its absence) is worth a request now. */
export const needsAsking = (entry: CacheEntry | undefined, now: number): boolean => {
    if (!entry) return true;
    switch (entry.kind) {
        case 'asked':
            return now - entry.askedAt >= ASKED_TIMEOUT_MS;
        case 'bounds':
        case 'none':
            return false;
        case 'pending':
            return now - entry.askedAt >= PENDING_RETRY_MS;
    }
};

/** What a caller gets: bounds, null for "nothing to trim", undefined for "not known yet". */
export const boundsOf = (entry: CacheEntry | undefined): null | SoundBounds | undefined => {
    if (!entry) return undefined;
    if (entry.kind === 'bounds') return entry.bounds;
    if (entry.kind === 'none') return null;
    return undefined;
};

/** The subset of `ids` worth asking for, each once, marked as in flight. */
export const takeToAsk = (
    entries: Map<string, CacheEntry>,
    ids: readonly string[],
    now: number,
): string[] => {
    const asking: string[] = [];
    for (const id of ids) {
        if (!id || asking.includes(id) || !needsAsking(entries.get(id), now)) continue;
        entries.set(id, { askedAt: now, kind: 'asked' });
        asking.push(id);
    }
    return asking;
};

/**
 * Fold a reply into the map.
 *
 * Every id that was asked gets an entry: measured ones their bounds or
 * `none`, pending ones `pending`, and ids the server named in neither —
 * unknown to it, per the spec — `none`, since nothing is coming for them.
 */
export const applyReply = (
    entries: Map<string, CacheEntry>,
    asked: readonly string[],
    reply: SoundBoundsReply,
    now: number,
): void => {
    const pending = new Set(reply.pending);
    for (const id of asked) {
        if (id in reply.bounds) {
            const bounds = reply.bounds[id];
            entries.set(id, bounds ? { bounds, kind: 'bounds' } : { kind: 'none' });
        } else if (pending.has(id)) {
            entries.set(id, { askedAt: now, kind: 'pending' });
        } else {
            entries.set(id, { kind: 'none' });
        }
    }
};

/**
 * A request that failed: forget that it was asked, so the next ask is not
 * held for the in-flight timeout. Nothing is learned from a failure.
 */
export const applyFailure = (entries: Map<string, CacheEntry>, asked: readonly string[]): void => {
    for (const id of asked) {
        if (entries.get(id)?.kind === 'asked') entries.delete(id);
    }
};
