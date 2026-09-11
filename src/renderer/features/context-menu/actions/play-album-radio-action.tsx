import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { PLAY_BUTTON_BEHAVIOR, RADIO_TRACK_COUNT, useCurrentServerId } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Album } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface PlayAlbumRadioActionProps {
    album: Album;
    disabled?: boolean;
}

export const PlayAlbumRadioAction = ({ album, disabled }: PlayAlbumRadioActionProps) => {
    const { t } = useTranslation();
    const player = usePlayer();
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();

    const handlePlayAlbumRadio = useCallback(
        async (playType: Play) => {
            if (!serverId || !album) return;

            try {
                const albumRadioSongs = await queryClient.fetchQuery({
                    ...songsQueries.albumRadio({
                        query: {
                            albumId: album.id,
                            count: RADIO_TRACK_COUNT,
                        },
                        serverId: serverId,
                    }),
                    queryKey: queryKeys.player.fetch({ albumId: album.id }),
                });
                if (albumRadioSongs && albumRadioSongs.length > 0) {
                    player.addToQueueByData(albumRadioSongs, playType);
                }
            } catch (error) {
                console.error('Failed to load album radio:', error);
            }
        },
        [album, player, queryClient, serverId],
    );

    const handlePlayAlbumRadioNow = useCallback(() => {
        handlePlayAlbumRadio(Play.NOW);
    }, [handlePlayAlbumRadio]);

    const handlePlayAlbumRadioNext = useCallback(() => {
        handlePlayAlbumRadio(Play.NEXT);
    }, [handlePlayAlbumRadio]);

    const handlePlayAlbumRadioLast = useCallback(() => {
        handlePlayAlbumRadio(Play.LAST);
    }, [handlePlayAlbumRadio]);

    const defaultPlayAlbumRadioAction = useCallback(() => {
        handlePlayAlbumRadio(PLAY_BUTTON_BEHAVIOR);
    }, [handlePlayAlbumRadio]);

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    disabled={disabled}
                    leftIcon="radio"
                    onSelect={defaultPlayAlbumRadioAction}
                    rightIcon="arrowRightS"
                >
                    {t('player.albumRadio')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="mediaPlay" onSelect={handlePlayAlbumRadioNow}>
                    {t('player.play')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayNext" onSelect={handlePlayAlbumRadioNext}>
                    {t('player.addNext')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayLast" onSelect={handlePlayAlbumRadioLast}>
                    {t('player.addLast')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
