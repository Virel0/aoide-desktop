import { ASKED_TIMEOUT_MS, PENDING_RETRY_MS } from './lazy-measurement';

/**
 * What this device remembers about a lazily measured fact per track, and when
 * to ask again — for any measurement the sidecar serves in the shape every
 * `/aoide/*` measurement shares.
 *
 * The third and fourth measurements in the family (the beat grid and the
 * arrangement) would have been the third and fourth copies of
 * `sound-bounds-cache.ts`; this is that cache with the row type as a
 * parameter, and the same four states. *Unknown* (no entry) asks. *Asked* is a
 * request in flight, and asks again only after a timeout in case the request
 * was lost. *Pending* is the sidecar's "not measured yet" and asks again after
 * a minute. *Value* and *none* are answers and are kept for the session.
 */

export type MeasurementEntry<T> =
    | { askedAt: number; kind: 'asked' }
    | { askedAt: number; kind: 'pending' }
    | { kind: 'none' }
    | { kind: 'value'; value: T };

/** The shape every measurement endpoint answers in, keyed by track id. */
export interface MeasurementReply<T> {
    pending: string[];
    rows: Record<string, null | T>;
}

export { ABSENT_RETRY_MS, ASKED_TIMEOUT_MS, PENDING_RETRY_MS } from './lazy-measurement';

/** Whether an entry (or its absence) is worth a request now. */
export const needsAsking = <T>(entry: MeasurementEntry<T> | undefined, now: number): boolean => {
    if (!entry) return true;
    switch (entry.kind) {
        case 'asked':
            return now - entry.askedAt >= ASKED_TIMEOUT_MS;
        case 'none':
        case 'value':
            return false;
        case 'pending':
            return now - entry.askedAt >= PENDING_RETRY_MS;
    }
};

/**
 * What a caller gets: the value, null for "measured, nothing to report",
 * undefined for "not known yet". Null is settled and never asked about again;
 * undefined is asked about again.
 */
export const valueOf = <T>(entry: MeasurementEntry<T> | undefined): null | T | undefined => {
    if (!entry) return undefined;
    if (entry.kind === 'value') return entry.value;
    if (entry.kind === 'none') return null;
    return undefined;
};

/** The subset of `ids` worth asking for, each once, marked as in flight. */
export const takeToAsk = <T>(
    entries: Map<string, MeasurementEntry<T>>,
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
 * Every id that was asked gets an entry: measured ones their value or `none`,
 * pending ones `pending`, and ids the server named in neither — unknown to it,
 * per the contract — `none`, since nothing is coming for them.
 */
export const applyReply = <T>(
    entries: Map<string, MeasurementEntry<T>>,
    asked: readonly string[],
    reply: MeasurementReply<T>,
    now: number,
): void => {
    const pending = new Set(reply.pending);
    for (const id of asked) {
        if (id in reply.rows) {
            const value = reply.rows[id];
            entries.set(id, value === null ? { kind: 'none' } : { kind: 'value', value });
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
export const applyFailure = <T>(
    entries: Map<string, MeasurementEntry<T>>,
    asked: readonly string[],
): void => {
    for (const id of asked) {
        if (entries.get(id)?.kind === 'asked') entries.delete(id);
    }
};
