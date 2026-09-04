import type { Recap } from '/@/main/features/aoide/play-history';
import type { ReplayPeriod } from '/@/renderer/aoide/features/replay/replay-period';
import type { Song } from '/@/shared/types/domain-types';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { periodStart } from '/@/renderer/aoide/features/replay/replay-period';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { getSongById } from '/@/renderer/features/player/utils';

/** A top song with the number of plays that put it there, in rank order. */
export interface RankedSong {
    playCount: number;
    song: Song;
}

export const replayKeys = {
    recap: (period: ReplayPeriod) => ['aoide', 'replay', 'recap', period] as const,
    songs: (serverId: string, ids: string[]) =>
        ['aoide', 'replay', 'songs', serverId, ids] as const,
};

/**
 * A period's recap, and its top songs resolved to things that can be played.
 *
 * Two queries rather than one: the recap is a few aggregates over a local
 * table and comes back at once, while the songs are a round of Jellyfin
 * lookups per id. Tying them together would leave the numbers waiting on the
 * network for no reason.
 *
 * `to` is the moment the query runs, taken inside `queryFn` — the React
 * compiler's lint refuses `Date.now()` in render, and it is right to: a page
 * that recomputed its window on every render would never settle.
 *
 * A top song Jellyfin no longer knows is dropped from the *list*, not from the
 * count: the recap's `totalPlays` and `topTracks` already include it, and the
 * screen says how many plays were of tracks it could not attribute.
 */
export const useReplay = (period: ReplayPeriod, serverId: string) => {
    const queryClient = useQueryClient();

    const recap = useQuery<Recap>({
        enabled: isAoideAvailable(),
        queryFn: () => {
            const now = Date.now();
            return window.api.aoide.history.recap(periodStart(period, new Date(now)), now);
        },
        queryKey: replayKeys.recap(period),
        staleTime: 60_000,
    });

    const topTracks = recap.data?.topTracks ?? [];
    const ids = topTracks.map((track) => track.jellyfinId);

    const songs = useQuery<RankedSong[]>({
        enabled: ids.length > 0,
        queryFn: async () => {
            const results = await Promise.allSettled(
                ids.map((id) => getSongById({ id, queryClient, serverId })),
            );

            // Rank order is the recap's order; a lookup that failed leaves a
            // gap rather than shifting the ranks.
            return results.flatMap((result, index) => {
                const song = result.status === 'fulfilled' ? result.value.items[0] : undefined;
                return song ? [{ playCount: topTracks[index].playCount, song }] : [];
            });
        },
        queryKey: replayKeys.songs(serverId, ids),
        staleTime: 60_000,
    });

    return { recap, songs: songs.data ?? [], songsLoading: songs.isLoading };
};
