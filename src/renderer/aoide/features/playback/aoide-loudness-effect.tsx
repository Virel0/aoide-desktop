import { useEffect } from 'react';

import { audioAnalysisStore } from '/@/renderer/aoide/features/playback/audio-analysis-store';
import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { usePlayerData, usePlayerQueue } from '/@/renderer/store';
import { hasReplayGain, normalisationGainDb } from '/@/shared/aoide/loudness';

/**
 * Keeps loudness measurements ahead of playback, and tells the main process
 * the gains mpv will need.
 *
 * Renders nothing, and is the twin of `AoideTrimEffect` — same prefetch, same
 * two slots, same reason. The web player reads the store itself through
 * `useLoudnessGain`; this exists for mpv, which loads files in another process
 * and takes its gain as an option on `loadfile` and nothing else. A gain that
 * arrives after the load is a gain for next time: the first track of a fresh
 * session, and the one after it, tend to play unmodified once.
 *
 * Switching the setting off tells main to forget every gain, so the next load
 * is unmodified even for a track it already knew.
 */
export const AoideLoudnessEffect = () => (isAoideAvailable() ? <Leveller /> : null);

/** How far down the queue to ask ahead. One request, well under the server's 200. */
export const PREFETCH_COUNT = 50;

const Leveller = () => {
    const enabled = useAoideLoudnessNormalisationEnabled();
    const client = useSidecarTransport();
    const { currentSong, nextSong } = usePlayerData();
    const queue = usePlayerQueue();

    const currentId = currentSong?._uniqueId;
    const upcoming = (() => {
        const at = queue.findIndex((song) => song._uniqueId === currentId);
        return queue.slice(Math.max(0, at), Math.max(0, at) + PREFETCH_COUNT).map((s) => s.id);
    })();
    const ids = [currentSong?.id, nextSong?.id, ...upcoming].filter((id): id is string =>
        Boolean(id),
    );
    // A string key, so the effect below runs when the set changes and not on
    // every render that rebuilt the same array.
    const key = ids.join(',');

    useEffect(() => {
        if (!enabled || !client || key.length === 0) return;
        void audioAnalysisStore.ensure(key.split(','), client);
    }, [client, enabled, key]);

    // Main hears about the two tracks mpv can hold, whenever their loudness is
    // known. `null` for "nothing to correct" so a stale gain is dropped.
    //
    // The tag check is reduced to a boolean here rather than passed as the
    // song's `gain` object: the object is a fresh one on every render and would
    // re-run this effect forever.
    const currentTrackId = currentSong?.id;
    const currentTagged = hasReplayGain(currentSong?.gain);
    const nextTrackId = nextSong?.id;
    const nextTagged = hasReplayGain(nextSong?.gain);

    useEffect(() => {
        if (!enabled) {
            window.api.aoide.gain.forget();
            return;
        }

        const tell = () => {
            const update: Parameters<typeof window.api.aoide.gain.remember>[0] = {};
            for (const [id, tagged] of [
                [currentTrackId, currentTagged],
                [nextTrackId, nextTagged],
            ] as const) {
                if (!id) continue;
                const analysis = audioAnalysisStore.get(id);
                if (analysis === undefined) continue;
                update[id] = normalisationGainDb({
                    analysis,
                    enabled: true,
                    hasOwnReplayGain: tagged,
                });
            }
            if (Object.keys(update).length > 0) window.api.aoide.gain.remember(update);
        };

        tell();
        return audioAnalysisStore.subscribe(tell);
    }, [currentTagged, currentTrackId, enabled, nextTagged, nextTrackId]);

    return null;
};
