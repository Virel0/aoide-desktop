import { useEffect } from 'react';

import { audioAnalysisStore } from '/@/renderer/aoide/features/playback/audio-analysis-store';
import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { usePlayerData, usePlayerQueue } from '/@/renderer/store';

/**
 * Keeps loudness measurements ahead of playback.
 *
 * Renders nothing, and is the twin of `AoideTrimEffect` — same prefetch, same
 * reason. The web player reads the store itself through `useLoudnessGain`;
 * without this every track would wait on a round trip to the sidecar at the
 * moment it started, and play unlevelled while it waited.
 *
 * It also used to tell the main process the gains mpv would need, because mpv
 * decoded out of process and took its gain as an option on `loadfile`. That
 * half went with mpv.
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

    return null;
};
