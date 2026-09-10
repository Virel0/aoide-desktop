import type { AudioAnalysis, AudioAnalysisReply } from '/@/shared/aoide/loudness';

import { ASKED_TIMEOUT_MS, PENDING_RETRY_MS } from './lazy-measurement';

/**
 * What this device remembers about each track's loudness and tempo, and when
 * to ask again.
 *
 * Pure, and the twin of `sound-bounds-cache.ts` — the same four states over a
 * different measurement, because the sidecar serves both from the same decode
 * and answers about both in the same shape. *Unknown* (no entry) asks. *Asked*
 * is a request in flight, and asks again only after a timeout in case the
 * request was lost. *Pending* is the sidecar's "not measured yet" and asks
 * again after a minute. *Analysis* and *none* are answers and are kept for the
 * session; a file replaced on the server is the one case that would change
 * them, and the next launch asks afresh.
 */

export type CacheEntry =
    | { analysis: AudioAnalysis; kind: 'analysis' }
    | { askedAt: number; kind: 'asked' }
    | { askedAt: number; kind: 'pending' }
    | { kind: 'none' };

export { ABSENT_RETRY_MS, ASKED_TIMEOUT_MS, PENDING_RETRY_MS } from './lazy-measurement';

/** Whether an entry (or its absence) is worth a request now. */
export const needsAsking = (entry: CacheEntry | undefined, now: number): boolean => {
    if (!entry) return true;
    switch (entry.kind) {
        case 'analysis':
        case 'none':
            return false;
        case 'asked':
            return now - entry.askedAt >= ASKED_TIMEOUT_MS;
        case 'pending':
            return now - entry.askedAt >= PENDING_RETRY_MS;
    }
};

/**
 * What a caller gets: the measurements, null for "measured, nothing to
 * report", undefined for "not known yet".
 *
 * The three are kept apart because they lead to different behaviour later:
 * null is settled and never asked about again, undefined is asked about again.
 * Both play the track unmodified, which is why a bug that confused them would
 * be inaudible.
 */
export const analysisOf = (entry: CacheEntry | undefined): AudioAnalysis | null | undefined => {
    if (!entry) return undefined;
    if (entry.kind === 'analysis') return entry.analysis;
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
 * Every id that was asked gets an entry: measured ones their numbers or
 * `none`, pending ones `pending`, and ids the server named in neither —
 * unknown to it, per the spec — `none`, since nothing is coming for them.
 */
export const applyReply = (
    entries: Map<string, CacheEntry>,
    asked: readonly string[],
    reply: AudioAnalysisReply,
    now: number,
): void => {
    const pending = new Set(reply.pending);
    for (const id of asked) {
        if (id in reply.analysis) {
            const analysis = reply.analysis[id];
            entries.set(id, analysis ? { analysis, kind: 'analysis' } : { kind: 'none' });
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
