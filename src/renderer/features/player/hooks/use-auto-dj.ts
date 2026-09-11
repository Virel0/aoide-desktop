import type { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';
import type { QueryClient } from '@tanstack/react-query';

import { useQueryClient } from '@tanstack/react-query';
import React, { useEffect } from 'react';

import { useAoideAutoDjEnabled } from '/@/renderer/aoide/features/playback/use-auto-dj';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import {
    chooseAlbumsByTaste,
    chooseSongsByTaste,
    infinityPoolCount,
} from '/@/renderer/aoide/features/taste/infinity-taste';
import { nextReasons } from '/@/renderer/aoide/features/taste/next-reasons';
import {
    readFinishCounts,
    readRecentlyPlayed,
    readTasteProfile,
} from '/@/renderer/aoide/features/taste/taste-profile-api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { runAutoDjAlbumIds } from '/@/renderer/features/player/auto-dj/auto-dj-albums';
import { runAutoDjSongs } from '/@/renderer/features/player/auto-dj/auto-dj-songs';
import { useIsPlayerFetching, usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import {
    AUTO_DJ_STRATEGY,
    isShuffleEnabled,
    mapShuffledToQueueIndex,
    useAutoDJSettings,
    useCurrentServer,
    useCurrentServerId,
    usePlayerStore,
    usePlayerStoreBase,
    useSettingsStore,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { buildNextRequest } from '/@/shared/aoide/next-chooser';
import { hasFeature } from '/@/shared/api/utils';
import { LibraryItem, type Song, SongListSort, SortOrder } from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';
import { Play } from '/@/shared/types/types';

export const useAutoDJ = () => {
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();
    const server = useCurrentServer();
    const player = usePlayer();
    const settings = useAutoDJSettings();
    const isFetching = useIsPlayerFetching();
    const sidecar = useSidecarTransport();
    const autoDj = useAoideAutoDjEnabled();

    const hasSimilarSongsMusicFolder = hasFeature(server, ServerFeature.SIMILAR_SONGS_MUSIC_FOLDER);

    useEffect(() => {
        const albumStrategy = settings.albumStrategy ?? AUTO_DJ_STRATEGY.SIMILAR;
        const songStrategy = settings.songStrategy ?? AUTO_DJ_STRATEGY.SIMILAR;

        const unsubscribe = usePlayerStoreBase.subscribe(
            (state) => {
                const queue = state.getQueue();
                let index = state.player.index;
                let remaining: number;

                if (isShuffleEnabled(state)) {
                    remaining = state.queue.shuffled.length - index - 1;
                    index = mapShuffledToQueueIndex(index, state.queue.shuffled);
                } else {
                    remaining = queue.items.slice(index + 1).length;
                }

                return { index, remaining, song: queue.items[index] };
            },
            async (properties) => {
                if (!settings.enabled) {
                    return;
                }

                if (!properties.song?.id) {
                    return;
                }

                if (properties.remaining >= settings.timing) {
                    return;
                }

                logger.info('Auto DJ triggered', {
                    remaining: properties.remaining,
                    songId: properties.song?.id,
                    songName: properties.song?.name,
                });

                try {
                    const queue = usePlayerStore.getState().getQueue();

                    // Read before collecting: the profile decides how the pool
                    // is picked from, and a pool collected against a profile
                    // that arrived late would be Feishin's behaviour wearing
                    // Infinity's name.
                    const profile = await readTasteProfile();

                    const hasMusicFolder = server?.musicFolderId && server.musicFolderId.length > 0;
                    const musicFolderId =
                        hasMusicFolder && server?.musicFolderId ? server.musicFolderId : undefined;
                    const trySimilarSongs =
                        !hasMusicFolder || (hasMusicFolder && hasSimilarSongsMusicFolder);

                    const runnerDepsBase = {
                        allowDuplicates: settings.allowDuplicates,
                        musicFolderId,
                        onlySimilar: settings.onlySimilar,
                        // Several times the item count: what the strategies
                        // bring back is the pool, and the ranking below is what
                        // turns it into the handful the listener asked for.
                        poolCount: infinityPoolCount(settings.itemCount),
                        queryClient,
                        server,
                        serverId,
                        trySimilarSongs,
                    };

                    if (settings.mode === 'albums') {
                        if (!serverId) {
                            return;
                        }

                        const queueAlbumIdSet = new Set(
                            queue.items
                                .map((item) => item.albumId)
                                .filter((id): id is string => Boolean(id)),
                        );

                        const albumPool = await runAutoDjAlbumIds({
                            ...runnerDepsBase,
                            albumStrategy,
                            currentSong: properties.song,
                            queueAlbumIdSet,
                        });

                        const poolTracks = await albumPoolTracks(queryClient, serverId, albumPool);
                        const albumsToAdd = chooseAlbumsByTaste(
                            albumPool,
                            poolTracks,
                            profile,
                            await readFinishCounts(poolTracks.map((track) => track.id)),
                            settings.itemCount,
                        );

                        if (albumsToAdd.length > 0) {
                            await player.addToQueueByFetch(
                                serverId,
                                albumsToAdd,
                                LibraryItem.ALBUM,
                                Play.LAST,
                            );

                            eventEmitter.emit('AUTODJ_QUEUE_ADDED', {
                                songCount: albumsToAdd.length,
                            });
                        }

                        return;
                    }

                    if (!serverId) {
                        return;
                    }

                    const queueSongIdSet = new Set(queue.items.map((item) => item.id));

                    // The server first: it scores the whole library against
                    // the record playing, from every device's history. See
                    // `docs/infinity.md` in the iOS repo. An older sidecar
                    // answers 404 once and the pool below is used for the
                    // session; any other failure falls back for this top-up.
                    if (sidecar && nextReasons.sidecarChooses) {
                        const chosen = await askServerForNext({
                            autoDj,
                            client: sidecar,
                            limit: settings.itemCount,
                            queryClient,
                            queueSongIdSet,
                            seed: properties.song,
                            serverId,
                            upcoming: queue.items
                                .slice(properties.index + 1)
                                .map((item) => item.id),
                        });

                        if (chosen) {
                            if (chosen.length > 0) {
                                player.addToQueueByData(chosen, Play.LAST);
                                eventEmitter.emit('AUTODJ_QUEUE_ADDED', {
                                    songCount: chosen.length,
                                });
                            }
                            return;
                        }
                    }

                    const songPool = await runAutoDjSongs({
                        ...runnerDepsBase,
                        currentSong: properties.song,
                        queueSongIdSet,
                        songStrategy,
                    });

                    const songsToAdd = chooseSongsByTaste(
                        songPool,
                        profile,
                        await readFinishCounts(songPool.map((song) => song.id)),
                        settings.itemCount,
                    );

                    if (songsToAdd.length > 0) {
                        player.addToQueueByData(songsToAdd, Play.LAST);

                        eventEmitter.emit('AUTODJ_QUEUE_ADDED', {
                            songCount: songsToAdd.length,
                        });
                    }
                } catch (error) {
                    logger.error('Auto DJ failed', {
                        error: (error as Error).message,
                        songId: properties.song?.id,
                    });
                }
            },
            {
                equalityFn: (a, b) => {
                    return a.song?._uniqueId === b.song?._uniqueId && a.remaining === b.remaining;
                },
            },
        );

        return () => unsubscribe();
    }, [
        autoDj,
        hasSimilarSongsMusicFolder,
        isFetching,
        player,
        queryClient,
        server,
        serverId,
        sidecar,
        settings.enabled,
        settings.albumStrategy,
        settings.allowDuplicates,
        settings.itemCount,
        settings.mode,
        settings.onlySimilar,
        settings.songStrategy,
        settings.timing,
    ]);
};

/**
 * The sidecar's choice of what follows `seed`, as songs, in its order.
 *
 * `undefined` when the server did not choose — an older sidecar (remembered
 * for the session), or any failure, which is logged — so the caller can
 * collect a pool the old way. An empty list is an answer: the server looked
 * and found nothing new, and the queue simply ends.
 */
const askServerForNext = async (args: {
    autoDj: boolean;
    client: SidecarClient;
    limit: number;
    queryClient: QueryClient;
    queueSongIdSet: Set<string>;
    seed: Song;
    serverId: string;
    upcoming: string[];
}): Promise<Song[] | undefined> => {
    try {
        const request = buildNextRequest({
            limit: args.limit,
            mode: args.autoDj ? 'autodj' : 'infinity',
            queue: args.upcoming,
            recent: await readRecentlyPlayed(),
            seed: args.seed.id,
        });
        const { absent, answer } = await args.client.next(request);

        if (absent || !answer) {
            nextReasons.markAbsent();
            logger.info(
                'This server has no /aoide/next; Infinity is using Instant Mix for the session',
            );
            return undefined;
        }

        if (answer.profile.events === 0) {
            logger.info(
                'Infinity is still learning what this listener likes: no finished plays yet',
            );
        }

        const chosen = answer.candidates.filter(
            (candidate) => !args.queueSongIdSet.has(candidate.id),
        );
        nextReasons.remember(chosen);
        if (chosen.length === 0) return [];

        // Items come back in the server's own order; the order asked for is
        // the sidecar's, so they are put back into it.
        const list = await args.queryClient.fetchQuery({
            ...songsQueries.list({
                query: {
                    _custom: { Ids: chosen.map((candidate) => candidate.id).join(',') },
                    limit: -1,
                    sortBy: SongListSort.NAME,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
                serverId: args.serverId,
            }),
            queryKey: queryKeys.player.fetch({ aoideNext: args.seed.id }),
        });
        const byId = new Map(list.items.map((song) => [song.id, song]));
        return chosen
            .map((candidate) => byId.get(candidate.id))
            .filter((song): song is Song => !!song);
    } catch (error) {
        logger.warn('The server could not choose what plays next', {
            error: (error as Error).message,
        });
        return undefined;
    }
};

/**
 * The tracklists of the albums in the pool, in one request.
 *
 * A record is ranked on what is actually on it — see `chooseAlbumsByTaste` —
 * and an album id carries none of that, so the pool's tracks have to be fetched
 * before anything can be chosen. One query for the whole pool: a request per
 * album would be twenty-five round trips to decide what plays after the current
 * song.
 *
 * The limit is per album rather than a flat ceiling, because the list comes
 * back grouped by record: too low a total would not shorten every album's
 * tracklist evenly, it would leave the last few albums with none at all and
 * sink them for having been asked about last.
 *
 * A failure here is not a failure of the top-up. Nothing coming back leaves the
 * pool in the order the strategy produced it, which is what Auto DJ always did.
 */
const albumPoolTracks = async (
    queryClient: QueryClient,
    serverId: string,
    albumIds: string[],
): Promise<Song[]> => {
    if (albumIds.length === 0) {
        return [];
    }

    try {
        const page = await queryClient.fetchQuery({
            ...songsQueries.list({
                query: {
                    albumIds,
                    limit: albumIds.length * POOL_TRACKS_PER_ALBUM,
                    sortBy: SongListSort.ALBUM,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
                serverId,
            }),
            queryKey: queryKeys.player.fetch({ infinityAlbumPool: albumIds }),
        });

        return page.items;
    } catch (error) {
        logger.warn('Infinity could not read the album pool\u2019s tracks', {
            error: (error as Error).message,
        });
        return [];
    }
};

/** Generous: a record longer than this is characterised by the first forty. */
const POOL_TRACKS_PER_ALBUM = 40;

const AutoDJHookInner = () => {
    useAutoDJ();
    return null;
};

export const AutoDJHook = () => {
    const isAutoDJEnabled = useSettingsStore((state) => state.autoDJ.enabled);

    if (!isAutoDJEnabled) {
        return null;
    }

    return React.createElement(AutoDJHookInner);
};
