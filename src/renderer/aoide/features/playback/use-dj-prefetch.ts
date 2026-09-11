import { useArrangementPrefetch } from '/@/renderer/aoide/features/playback/arrangement-store';
import { useBeatGridPrefetch } from '/@/renderer/aoide/features/playback/beat-grid-store';
import { upcomingTrackIds } from '/@/renderer/aoide/features/playback/upcoming-tracks';
import { usePlayerStore } from '/@/renderer/store';
import { PlayerShuffle } from '/@/shared/types/types';

/**
 * Ask for the grids and arrangements of the next few tracks in the queue,
 * while Auto DJ is on.
 *
 * The server measures lazily — a track nobody has asked about is `pending`
 * until it has been decoded — and a grid that arrives after the boundary is
 * a crossfade. Asking for the tracks coming up, rather than only the next
 * one, gives it minutes rather than seconds. Both stores are no-ops for
 * anything already answered, so this costs a map lookup a minute once the
 * queue is known.
 */
export const useDjPrefetch = (): void => {
    const ids = usePlayerStore((state) =>
        upcomingTrackIds({
            index: state.player.index,
            shuffle: state.player.shuffle === PlayerShuffle.TRACK,
            shuffled: state.queue.shuffled,
            songs: state.queue.songs,
            unique: state.queue.default,
        }).join('\n'),
    );
    const list = ids ? ids.split('\n') : [];
    useBeatGridPrefetch(list);
    useArrangementPrefetch(list);
};
