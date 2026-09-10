import type { FinishCounts } from '/@/shared/aoide/finish-rate';

import { useQuery } from '@tanstack/react-query';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { finishRatePercent, totalFinishCounts } from '/@/shared/aoide/finish-rate';

/**
 * "Of the times you started this, how often you actually finished it", for a
 * screen.
 *
 * Both hooks return a whole-number percentage or `undefined`, and `undefined`
 * means *say nothing* — not "still loading", not "zero". The three ways to get
 * it are the same as far as the page is concerned: this build has no curation
 * store, the answer has not arrived yet, or there is not enough listening for
 * the shared rule to speak. A page that told those apart would be inventing
 * three empty states for a line of quiet metadata.
 *
 * The arithmetic is `finish-rate.ts`'s and only ever `finish-rate.ts`'s. What is
 * here is the round trip and the caching: the counts come back raw from the main
 * process, and the summing, the floor and the rounding all happen in the shared
 * module so that the phone can be given the same three rules verbatim.
 */

export const finishRateKeys = {
    album: (jellyfinIds: readonly string[]) =>
        ['aoide', 'finish-rate', 'album', jellyfinIds] as const,
    artist: (artist: string) => ['aoide', 'finish-rate', 'artist', artist] as const,
};

/**
 * A record's figure: every track's counts in one call, summed here.
 *
 * One query for the whole tracklist rather than one per row — the bridge is a
 * process boundary, and the batched call in the main process exists precisely so
 * a detail page crosses it once.
 *
 * Summed with `totalFinishCounts`, which is the rule that keeps this honest: an
 * album is what happened when you pressed play on it, not the average of what
 * happened to its songs, and a closing track played twice must not weigh as much
 * as the single played eighty times.
 */
export const useAlbumFinishRate = (jellyfinIds: readonly string[]): number | undefined => {
    const query = useQuery({
        enabled: isAoideAvailable() && jellyfinIds.length > 0,
        queryFn: () => window.api.aoide.history.finishRates([...jellyfinIds]),
        queryKey: finishRateKeys.album(jellyfinIds),
        staleTime: FINISH_RATE_STALE_MS,
    });

    if (!query.data) return undefined;
    return finishRatePercent(totalFinishCounts(Object.values(query.data)));
};

/**
 * An artist's figure, summed in SQL over everything the local cache files under
 * their name.
 *
 * By name rather than by ids because an artist page holds albums, and turning
 * those into a tracklist would be a Jellyfin round trip per album before a
 * single number could be printed. The name is the one the page is already
 * showing, matched against both the track artist and the album artist, so a
 * compilation appearance counts.
 */
export const useArtistFinishRate = (artist: string | undefined): number | undefined => {
    const query = useQuery<FinishCounts>({
        enabled: isAoideAvailable() && Boolean(artist),
        queryFn: () => window.api.aoide.history.finishRateForArtist(artist ?? ''),
        queryKey: finishRateKeys.artist(artist ?? ''),
        staleTime: FINISH_RATE_STALE_MS,
    });

    if (!query.data) return undefined;
    return finishRatePercent(query.data);
};

/**
 * A minute, matching the Replay screen's recap.
 *
 * The figure moves only when a listen ends, and it is a ratio over a listener's
 * whole history — one more play changes it in the second decimal place. Refetching
 * it faster would cost a query per navigation to change nothing on screen.
 */
const FINISH_RATE_STALE_MS = 60_000;
