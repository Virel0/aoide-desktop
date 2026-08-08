import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { openCreateAoidePlaylistModal } from '/@/renderer/aoide/features/playlists/aoide-playlist-modals';
import {
    notifyAoideError,
    useAddAoideTracks,
    useAoidePlaylistList,
} from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { trackInputFromSong } from '/@/renderer/aoide/features/playlists/track-input';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { toast } from '/@/shared/components/toast/toast';
import { Song } from '/@/shared/types/domain-types';

/**
 * "Add to Aoide playlist" in the track context menu.
 *
 * Separate from Feishin's own `AddToPlaylistAction`, which posts to Jellyfin.
 * The two look alike and do entirely different things — one writes to the
 * server, one writes to a local op log that syncs with the phone — so they are
 * two entries rather than one submenu a person has to read carefully.
 *
 * The whole `Song` is taken rather than its id, because adding is the moment
 * this device caches what the track is: title, artist, album and duration all
 * travel, and they are what a later relink matches on when Jellyfin re-mints
 * its ids. Passing ids would mean fetching them back one call later, for data
 * the caller already had in its hands.
 */
export const AddToAoidePlaylistAction = ({ songs }: { songs: Song[] }) => {
    const { t } = useTranslation();
    const playlistsQuery = useAoidePlaylistList();
    const addTracksMutation = useAddAoideTracks();

    const tracks = useMemo(() => songs.map(trackInputFromSong), [songs]);

    const handleAdd = useCallback(
        (playlistId: string, name: string) => {
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
        [addTracksMutation, t, tracks],
    );

    if (!isAoideAvailable() || songs.length === 0) return null;

    const playlists = playlistsQuery.data ?? [];

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item leftIcon="playlistAdd" rightIcon="arrowRightS">
                    {t('aoide.action.addToPlaylist')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item
                    leftIcon="add"
                    onSelect={() => openCreateAoidePlaylistModal({ tracks })}
                >
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
                {playlists.map((playlist) => (
                    <ContextMenu.Item
                        key={playlist.id}
                        onSelect={() => handleAdd(playlist.id, playlist.name)}
                    >
                        {playlist.name}
                    </ContextMenu.Item>
                ))}
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
