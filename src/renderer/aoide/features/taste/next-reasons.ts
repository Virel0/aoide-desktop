import type { NextFactors } from '/@/shared/aoide/next-chooser';

import { useSyncExternalStore } from 'react';

/**
 * This session's memory of why Infinity queued what it queued, and whether
 * the sidecar is the one choosing.
 *
 * Two things, one store, because they change together: a 404 from
 * `/aoide/next` turns the server off for the session and no more reasons
 * arrive. Kept for records still queued; nothing is ever removed, and a
 * session's worth of these is a few kilobytes.
 */
type State = {
    reasons: ReadonlyMap<string, NextFactors>;
    sidecarChooses: boolean;
};

let state: State = { reasons: new Map(), sidecarChooses: true };
const listeners = new Set<() => void>();

const set = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
};

export const nextReasons = {
    /** The sidecar answered 404: an older server, remembered for the session. */
    markAbsent(): void {
        if (state.sidecarChooses) set({ ...state, sidecarChooses: false });
    },
    remember(chosen: ReadonlyArray<{ factors: NextFactors; id: string }>): void {
        if (chosen.length === 0) return;
        const reasons = new Map(state.reasons);
        for (const candidate of chosen) reasons.set(candidate.id, candidate.factors);
        set({ ...state, reasons });
    },
    /** For tests: back to a fresh session. */
    reset(): void {
        set({ reasons: new Map(), sidecarChooses: true });
    },
    get sidecarChooses(): boolean {
        return state.sidecarChooses;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};

/** Why Infinity put this track here, if it did. */
export const useNextReasons = (trackId: string | undefined): NextFactors | undefined =>
    useSyncExternalStore(
        nextReasons.subscribe,
        () => (trackId ? state.reasons.get(trackId) : undefined),
        () => undefined,
    );
