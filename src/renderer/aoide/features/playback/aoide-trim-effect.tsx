import { useEffect } from 'react';

import { soundBoundsStore } from '/@/renderer/aoide/features/playback/sound-bounds-store';
import { useAoideTrimSilenceEnabled } from '/@/renderer/aoide/features/playback/use-trim-silence';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { usePlayerData, usePlayerQueue } from '/@/renderer/store';
import { trimFor } from '/@/shared/aoide/trim-plan';

/**
 * Keeps bounds ahead of playback, and tells the main process the plans mpv
 * will need.
 *
 * Renders nothing. The web player asks for its own two slots through
 * `useTrimPlayers`; this asks for the current track, the next, and the run
 * of the queue after them, so by the time a track is appended to mpv's
 * playlist its bounds are usually here. mpv takes its trim as options on
 * `loadfile` and nothing else, so a plan that arrives after the load is a
 * plan for next time — the first track of a fresh session, and the one after
 * it, tend to play whole once. Every later track is told before it is loaded.
 *
 * Switching the setting off tells main to forget every plan, so the next
 * load is untrimmed even for a track it already knew.
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

    // Main hears about the two tracks mpv can hold, whenever their bounds are
    // known. `null` for "measured, nothing to trim" so a stale plan is dropped.
    const currentTrackId = currentSong?.id;
    const currentDuration = currentSong?.duration;
    const nextTrackId = nextSong?.id;
    const nextDuration = nextSong?.duration;

    useEffect(() => {
        if (!enabled) {
            window.api.aoide.trim.forget();
            return;
        }

        const tell = () => {
            const update: Parameters<typeof window.api.aoide.trim.remember>[0] = {};
            for (const [id, duration] of [
                [currentTrackId, currentDuration],
                [nextTrackId, nextDuration],
            ] as const) {
                if (!id) continue;
                const bounds = soundBoundsStore.get(id);
                if (bounds === undefined) continue;
                update[id] = trimFor(bounds, duration);
            }
            if (Object.keys(update).length > 0) window.api.aoide.trim.remember(update);
        };

        tell();
        return soundBoundsStore.subscribe(tell);
    }, [currentDuration, currentTrackId, enabled, nextDuration, nextTrackId]);

    return null;
};
