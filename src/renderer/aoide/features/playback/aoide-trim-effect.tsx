import { useEffect } from 'react';

import { soundBoundsStore } from '/@/renderer/aoide/features/playback/sound-bounds-store';
import { useAoideTrimSilenceEnabled } from '/@/renderer/aoide/features/playback/use-trim-silence';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { usePlayerData, usePlayerQueue } from '/@/renderer/store';

/**
 * Keeps bounds ahead of playback.
 *
 * Renders nothing. The web player asks for its own two slots through
 * `useTrimPlayers`, which is what actually trims; this asks for the current
 * track, the next, and the run of the queue after them, so a bound is usually
 * already here by the time its track reaches a slot. Without it every track
 * would wait on a round trip to the sidecar at the moment it started, and play
 * whole while it waited.
 *
 * It also used to tell the main process the plans mpv would need, because mpv
 * decoded out of process and took its trim as an option on `loadfile`. That
 * half went with mpv; the prefetch is the web player's own.
 */
export const AoideTrimEffect = () => (isAoideAvailable() ? <Trimmer /> : null);

/** How far down the queue to ask ahead. One request, well under the server's 200. */
export const PREFETCH_COUNT = 50;

const Trimmer = () => {
    const enabled = useAoideTrimSilenceEnabled();
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
        void soundBoundsStore.ensure(key.split(','), client);
    }, [client, enabled, key]);

    return null;
};
