import type { AudioAnalysis } from '/@/shared/aoide/loudness';

import { useEffect, useSyncExternalStore } from 'react';

import {
    ABSENT_RETRY_MS,
    analysisOf,
    applyFailure,
    applyReply,
    CacheEntry,
    PENDING_RETRY_MS,
    takeToAsk,
} from './audio-analysis-cache';

import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';
import { logger } from '/@/renderer/utils/logger';

/**
 * This session's memory of every track's loudness and tempo, and the one place
 * that asks the sidecar for them.
 *
 * Policy is in `audio-analysis-cache.ts`; this owns the map, the fetch and the
 * subscribers. Never a toast: a sidecar that is down, or one without the
 * endpoint — which is every sidecar today — means tracks play at whatever
 * level they were mastered at, which is what they did before this existed and
 * not something a person needs interrupting for.
 */
export class AudioAnalysisStore {
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
            const answer = await client.audioAnalysis(asking);
            if (answer.absent) {
                this.absentUntil = Date.now() + ABSENT_RETRY_MS;
                applyFailure(this.entries, asking);
            } else {
                applyReply(this.entries, asking, answer, Date.now());
            }
        } catch (error) {
            applyFailure(this.entries, asking);
            logger.warn('Aoide could not fetch audio analysis; tracks play unmodified', { error });
        }

        this.notify();
    }

    /** The measurements, null for "nothing to report", undefined for "not known yet". */
    get(id: string | undefined): AudioAnalysis | null | undefined {
        return id ? analysisOf(this.entries.get(id)) : undefined;
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

export const audioAnalysisStore = new AudioAnalysisStore();

/**
 * A track's measurements, asked for if need be, kept fresh while it is on
 * screen.
 *
 * Undefined until known, and always undefined with normalisation switched
 * off — a player reading undefined applies no gain, so the setting gates every
 * consumer at once. The interval re-asks a `pending` track after a minute;
 * `ensure` is a no-op for anything already answered, so the tick costs a map
 * lookup for everything else.
 */
export const useAudioAnalysis = (trackId: string | undefined): AudioAnalysis | null | undefined => {
    const enabled = useAoideLoudnessNormalisationEnabled();
    const client = useSidecarTransport();
    const wanted = enabled ? trackId : undefined;

    const analysis = useSyncExternalStore(audioAnalysisStore.subscribe, () =>
        audioAnalysisStore.get(wanted),
    );

    useEffect(() => {
        if (!wanted || !client) return;

        const ask = () => void audioAnalysisStore.ensure([wanted], client);
        ask();
        const timer = setInterval(ask, PENDING_RETRY_MS);
        return () => clearInterval(timer);
    }, [client, wanted]);

    return analysis;
};
