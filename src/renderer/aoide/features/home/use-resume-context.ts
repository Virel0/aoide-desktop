import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import { RecentContext } from '/@/renderer/aoide/features/home/recent-contexts';
import { resolvePlaylistPlayback } from '/@/renderer/aoide/features/playlists/playlist-playback';
import { pickUp } from '/@/renderer/aoide/features/queue/pick-up';
import { Handoff } from '/@/renderer/aoide/features/queue/use-queue-handoff';
import { aoidePlaylists } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { dropNotInterested } from '/@/renderer/aoide/features/taste/not-interested';
import { queryKeys } from '/@/renderer/api/query-keys';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { getSongById } from '/@/renderer/features/player/utils';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId } from '/@/renderer/store';
import { useArtistRadioCount } from '/@/renderer/store/settings.store';
import { LibraryItem } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * One tap resumes a context's queue, through the same helpers the pages use.
 *
 * Albums and Jellyfin playlists go by fetch, as their own headers do. Aoide
 * playlists resolve through `resolvePlaylistPlayback`, as their detail does.
 * Stations re-seed Jellyfin's instant mix. A mix reopens its page with the
 * description filled in, because a mix is rules the model wrote and re-running
 * them is a request somebody should choose to make.
 */
export const useResumeContext = () => {
    const player = usePlayer();
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();
    const navigate = useNavigate();
    // One count for both seeds, as the album header itself uses.
    const radioCount = useArtistRadioCount();

    const resume = useCallback(
        async (context: RecentContext): Promise<void> => {
            switch (context.kind) {
                case 'album':
                    player.addToQueueByFetch(serverId, [context.id], LibraryItem.ALBUM, Play.NOW);
                    return;

                case 'aoidePlaylist': {
                    const tracks = await aoidePlaylists().items(context.id);
                    const playback = await resolvePlaylistPlayback(
                        tracks,
                        undefined,
                        async (jellyfinId) =>
                            (await getSongById({ id: jellyfinId, queryClient, serverId })).items[0],
                    );
                    if (playback.songs.length > 0) {
                        player.addToQueueByData(playback.songs, Play.NOW);
                    }
                    return;
                }

                case 'jellyfinPlaylist':
                    player.addToQueueByFetch(
                        serverId,
                        [context.id],
                        LibraryItem.PLAYLIST,
                        Play.NOW,
                    );
                    return;

                case 'mix':
                    navigate(AppRoute.AOIDE_MIX, { state: { description: context.name } });
                    return;

                case 'station': {
                    // Jellyfin seeds the station and knows nothing of the
                    // flags, so the hidden tracks are dropped here, before
                    // the queue — the phone's `withoutNotInterested`.
                    const seeded =
                        context.seed === 'artist'
                            ? await queryClient.fetchQuery({
                                  ...songsQueries.artistRadio({
                                      query: { artistId: context.id, count: radioCount },
                                      serverId,
                                  }),
                                  queryKey: queryKeys.player.fetch({ artistId: context.id }),
                              })
                            : await queryClient.fetchQuery({
                                  ...songsQueries.albumRadio({
                                      query: { albumId: context.id, count: radioCount },
                                      serverId,
                                  }),
                                  queryKey: queryKeys.player.fetch({ albumId: context.id }),
                              });
                    const songs = await dropNotInterested(seeded ?? []);
                    if (songs.length > 0) {
                        player.addToQueueByData(songs, Play.NOW);
                    }
                    return;
                }
            }
        },
        [navigate, player, queryClient, radioCount, serverId],
    );

    const resumeHandoff = useCallback(
        (handoff: Handoff) => pickUp(handoff, { player, queryClient, serverId }),
        [player, queryClient, serverId],
    );

    return { resume, resumeHandoff };
};
