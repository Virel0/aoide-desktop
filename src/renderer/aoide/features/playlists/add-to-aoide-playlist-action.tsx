import type { TrackInput } from '/@/main/features/aoide/playlists';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openCreateAoidePlaylistModal } from '/@/renderer/aoide/features/playlists/aoide-playlist-modals';
import {
    notifyAoideError,
    useAddAoideTracks,
    useAoidePlaylistList,
} from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import {
    filterPlaylistsByName,
    PLAYLIST_SEARCH_THRESHOLD,
    resolveSongsForSelection,
    SongFetchers,
} from '/@/renderer/aoide/features/playlists/song-resolution';
import { trackInputFromSong } from '/@/renderer/aoide/features/playlists/track-input';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    getAlbumArtistSongsById,
    getAlbumSongsById,
    getGenreSongsById,
    getPlaylistSongsById,
    getSongById,
    getSongsByFolder,
} from '/@/renderer/features/player/utils';
import { useCurrentServerId } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Icon } from '/@/shared/components/icon/icon';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem, Song } from '/@/shared/types/domain-types';

/**
 * "Add to Aoide playlist", wherever Feishin's own "Add to playlist" appears.
 *
 * Separate from Feishin's `AddToPlaylistAction`, which posts to Jellyfin.
 * The two look alike and do entirely different things — one writes to the
 * server, one writes to a local op log that syncs with the phone — so they are
 * two entries rather than one submenu a person has to read carefully.
 *
 * Two ways in, matching the two shapes the menus hold. A song menu already has
 * the whole `Song` and passes `songs`: adding is the moment this device caches
 * what the track is — title, artist, album, duration all travel, and they are
 * what a later relink matches on when Jellyfin re-mints its ids. Every other
 * menu holds an album, an artist, a genre, a folder or a Jellyfin playlist and
 * passes `items` with an `itemType`, exactly as it does to the sibling; the
 * songs are then fetched **when a playlist is chosen**, never when the menu
 * opens, because right-clicking a discography must not download it.
 */
interface AddToAoidePlaylistActionProps {
    /** Ids of things that resolve to songs on selection. Paired with `itemType`. */
    items?: string[];
    itemType?: LibraryItem;
    /** Songs already in hand. Nothing is fetched. */
    songs?: Song[];
}

export const AddToAoidePlaylistAction = ({
    items,
    itemType,
    songs,
}: AddToAoidePlaylistActionProps) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();
    const playlistsQuery = useAoidePlaylistList();
    const addTracksMutation = useAddAoideTracks();
    const [searchTerm, setSearchTerm] = useState('');

    // Feishin's own lookups, the same ones its "Add to playlist" uses for the
    // same menus. They go through react-query, so an album whose songs are
    // already on screen costs no request.
    const fetchers = useMemo<SongFetchers>(
        () => ({
            byAlbum: async (id) =>
                (await getAlbumSongsById({ id: [id], queryClient, serverId })).items,
            byArtist: async (id) =>
                (await getAlbumArtistSongsById({ id: [id], queryClient, serverId })).items,
            byFolder: async (id) =>
                (await getSongsByFolder({ id: [id], queryClient, serverId })).items,
            byGenres: async (ids) =>
                (await getGenreSongsById({ id: ids, queryClient, serverId })).items,
            byPlaylist: async (id) =>
                (await getPlaylistSongsById({ id, queryClient, serverId })).items,
            bySong: async (id) => (await getSongById({ id, queryClient, serverId })).items,
        }),
        [queryClient, serverId],
    );

    // What will be added, worked out only once something has been chosen.
    const collectTracks = useCallback(async (): Promise<TrackInput[]> => {
        if (songs) return songs.map(trackInputFromSong);
        if (!items || itemType === undefined) return [];

        const resolved = await resolveSongsForSelection(itemType, items, fetchers);
        return resolved.map(trackInputFromSong);
    }, [fetchers, itemType, items, songs]);

    const handleAdd = useCallback(
        async (playlistId: string, name: string) => {
            let tracks: TrackInput[];
            try {
                tracks = await collectTracks();
            } catch (error) {
                notifyAoideError(error, t('aoide.error.add'));
                return;
            }

            if (tracks.length === 0) {
                toast.info({ message: t('aoide.toast.nothingToAdd', { name }) });
                return;
            }

            addTracksMutation.mutate(
                { playlistId, tracks },
                {
                    onError: (error) => notifyAoideError(error, t('aoide.error.add')),
                    onSuccess: (added) =>
                        toast.success({
                            message: t('aoide.toast.added', { count: added.length, name }),
                        }),
                },
            );
        },
        [addTracksMutation, collectTracks, t],
    );

    const handleCreate = useCallback(async () => {
        try {
            openCreateAoidePlaylistModal({ tracks: await collectTracks() });
        } catch (error) {
            notifyAoideError(error, t('aoide.error.add'));
        }
    }, [collectTracks, t]);

    const count = songs?.length ?? items?.length ?? 0;
    if (!isAoideAvailable() || count === 0) return null;

    const playlists = playlistsQuery.data ?? [];
    const searchable = playlists.length > PLAYLIST_SEARCH_THRESHOLD;
    const shown = searchable ? filterPlaylistsByName(playlists, searchTerm) : playlists;

    // The same sticky search box as the sibling's, for the same reason: past a
    // handful of playlists, scrolling a submenu is the slower way to find one.
    // Key and pointer events stop here so the menu does not treat typing as
    // navigation or a click in the box as a click outside it.
    const searchInput = searchable ? (
        <TextInput
            autoFocus
            leftSection={<Icon icon="search" />}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            pb="xs"
            placeholder={t('common.search')}
            size="sm"
            value={searchTerm}
        />
    ) : undefined;

    return (
        <ContextMenu.Submenu isCloseDisabled={searchable}>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item leftIcon="playlistAdd" rightIcon="arrowRightS">
                    {t('aoide.action.addToPlaylist')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent stickyContent={searchInput}>
                <ContextMenu.Item leftIcon="add" onSelect={() => void handleCreate()}>
                    {t('aoide.action.newPlaylist')}
                </ContextMenu.Item>
                {playlists.length > 0 && <ContextMenu.Divider />}
                {playlistsQuery.isLoading && (
                    <ContextMenu.Item disabled>
                        <Spinner container />
                    </ContextMenu.Item>
                )}
                {playlistsQuery.isError && (
                    <ContextMenu.Item disabled>
                        {(playlistsQuery.error as Error).message}
                    </ContextMenu.Item>
                )}
                {searchable && shown.length === 0 && (
                    <ContextMenu.Item disabled>{t('common.noResultsFromQuery')}</ContextMenu.Item>
                )}
                {shown.map((playlist) => (
                    <ContextMenu.Item
                        key={playlist.id}
                        onSelect={() => void handleAdd(playlist.id, playlist.name)}
                    >
                        {playlist.name}
                    </ContextMenu.Item>
                ))}
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
