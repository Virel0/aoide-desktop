import type { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';

import { useEffect, useSyncExternalStore } from 'react';

import {
    ABSENT_RETRY_MS,
    applyFailure,
    applyReply,
    MeasurementEntry,
    MeasurementReply,
    PENDING_RETRY_MS,
    takeToAsk,
    valueOf,
} from './measurement-cache';

import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { logger } from '/@/renderer/utils/logger';

/** How a store asks the sidecar: one call, `absent` for a 404. */
export type MeasurementFetch<T> = (
    ids: readonly string[],
    client: SidecarClient,
) => Promise<MeasurementReply<T> & { absent: boolean }>;

/**
 * This session's memory of one measurement for every track, and the one place
 * that asks the sidecar for it.
 *
 * Policy is in `measurement-cache.ts`; this owns the map, the fetch and the
 * subscribers. Never a toast: a sidecar that is down, or one without the
 * endpoint yet, means the feature that wanted the measurement stands down —
 * a track without a grid crossfades, which is what it did before this existed
 * and not something a person needs interrupting for.
 */
export class MeasurementStore<T> {
    private absentUntil = 0;

    private entries = new Map<string, MeasurementEntry<T>>();

    private readonly fetch: MeasurementFetch<T>;

    private listeners = new Set<() => void>();

    private readonly whenFailing: string;

    constructor(fetch: MeasurementFetch<T>, whenFailing: string) {
        this.fetch = fetch;
        this.whenFailing = whenFailing;
    }

    /**
     * Ask for whatever among `ids` is worth asking for. Cheap to call often:
     * nothing worth asking means no request. Resolves once the cache has
     * changed, or at once when it will not.
     */
    async ensure(ids: readonly string[], client: SidecarClient, now = Date.now()): Promise<void> {
        if (now < this.absentUntil) return;

        const asking = takeToAsk(this.entries, ids, now);
        if (asking.length === 0) return;

        try {
            const answer = await this.fetch(asking, client);
            if (answer.absent) {
                this.absentUntil = Date.now() + ABSENT_RETRY_MS;
                applyFailure(this.entries, asking);
            } else {
                applyReply(this.entries, asking, answer, Date.now());
            }
        } catch (error) {
            applyFailure(this.entries, asking);
            logger.warn(this.whenFailing, { error });
        }

        this.notify();
    }

    /** The value, null for "nothing to report", undefined for "not known yet". */
    get(id: string | undefined): null | T | undefined {
        return id ? valueOf(this.entries.get(id)) : undefined;
    }

    /** For tests. */
    reset(): void {
        this.absentUntil = 0;
        this.entries.clear();
        this.notify();
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private notify(): void {
        for (const listener of this.listeners) listener();
    }
}

/**
 * A track's measurement while `enabled`, asked for if need be, kept fresh
 * while it is on screen.
 *
 * Undefined until known, and always undefined while the gate is shut — a
 * consumer reading undefined does nothing, so one switch turns off everything
 * downstream of it. The interval re-asks a `pending` track after a minute;
 * `ensure` is a no-op for anything already answered, so the tick costs a map
 * lookup for everything else.
 */
export const useMeasurement = <T>(
    store: MeasurementStore<T>,
    trackId: string | undefined,
    enabled: boolean,
): null | T | undefined => {
    const client = useSidecarTransport();
    const wanted = enabled ? trackId : undefined;

    const value = useSyncExternalStore(store.subscribe, () => store.get(wanted));

    useEffect(() => {
        if (!wanted || !client) return;

        const ask = () => void store.ensure([wanted], client);
        ask();
        const timer = setInterval(ask, PENDING_RETRY_MS);
        return () => clearInterval(timer);
    }, [client, store, wanted]);

    return value;
};

/**
 * Ask ahead for a run of tracks — the next few in the queue — so a lazily
 * measuring server has decoded them by the time they come up. Nothing is
 * returned: whoever needs an answer reads it through `useMeasurement`, and
 * finds it already there.
 */
export const useMeasurementPrefetch = <T>(
    store: MeasurementStore<T>,
    trackIds: readonly string[],
    enabled: boolean,
): void => {
    const client = useSidecarTransport();
    // The list is rebuilt every render; its content is what matters.
    const key = enabled ? trackIds.join('\n') : '';

    useEffect(() => {
        if (!key || !client) return;
        const ids = key.split('\n');
        const ask = () => void store.ensure(ids, client);
        ask();
        const timer = setInterval(ask, PENDING_RETRY_MS);
        return () => clearInterval(timer);
    }, [client, key, store]);
};
