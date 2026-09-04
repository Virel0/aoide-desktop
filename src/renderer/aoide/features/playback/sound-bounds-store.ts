import type { SoundBounds } from '/@/shared/aoide/trim-plan';

import { useEffect, useSyncExternalStore } from 'react';

import {
    ABSENT_RETRY_MS,
    applyFailure,
    applyReply,
    boundsOf,
    CacheEntry,
    PENDING_RETRY_MS,
    takeToAsk,
} from './sound-bounds-cache';

import { useAoideTrimSilenceEnabled } from '/@/renderer/aoide/features/playback/use-trim-silence';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';
import { logger } from '/@/renderer/utils/logger';

/**
 * This session's memory of every track's bounds, and the one place that asks
 * the sidecar for them.
 *
 * Policy is in `sound-bounds-cache.ts`; this owns the map, the fetch and the
 * subscribers. Never a toast: a sidecar that is down, or one without the
 * endpoint yet, means tracks play whole, which is what they did before this
 * existed and not something a person needs interrupting for.
 */
export class SoundBoundsStore {
    private absentUntil = 0;

    private entries = new Map<string, CacheEntry>();

    private listeners = new Set<() => void>();

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
            const answer = await client.soundBounds(asking);
            if (answer.absent) {
                this.absentUntil = Date.now() + ABSENT_RETRY_MS;
                applyFailure(this.entries, asking);
            } else {
                applyReply(this.entries, asking, answer, Date.now());
            }
        } catch (error) {
            applyFailure(this.entries, asking);
            logger.warn('Aoide could not fetch sound bounds; tracks play whole', { error });
        }

        this.notify();
    }

    /** Bounds, null for "nothing to trim", undefined for "not known yet". */
    get(id: string | undefined): null | SoundBounds | undefined {
        return id ? boundsOf(this.entries.get(id)) : undefined;
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

export const soundBoundsStore = new SoundBoundsStore();

/**
 * A track's bounds, asked for if need be, kept fresh while it is on screen.
 *
 * Undefined until known, and always undefined with trimming switched off —
 * a player reading undefined does nothing, so the setting gates every
 * consumer at once. The interval re-asks a `pending` track after a minute;
 * `ensure` is a no-op for anything already answered, so the tick costs a map
 * lookup for everything else.
 */
export const useSoundBounds = (trackId: string | undefined): null | SoundBounds | undefined => {
    const enabled = useAoideTrimSilenceEnabled();
    const client = useSidecarTransport();
    const wanted = enabled ? trackId : undefined;

    const bounds = useSyncExternalStore(soundBoundsStore.subscribe, () =>
        soundBoundsStore.get(wanted),
    );

    useEffect(() => {
        if (!wanted || !client) return;

        const ask = () => void soundBoundsStore.ensure([wanted], client);
        ask();
        const timer = setInterval(ask, PENDING_RETRY_MS);
        return () => clearInterval(timer);
    }, [client, wanted]);

    return bounds;
};
