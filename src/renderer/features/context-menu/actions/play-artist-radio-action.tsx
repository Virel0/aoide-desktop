import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { PLAY_BUTTON_BEHAVIOR, RADIO_TRACK_COUNT, useCurrentServerId } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { AlbumArtist, Artist } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface PlayArtistRadioActionProps {
    artist: AlbumArtist | Artist;
    disabled?: boolean;
}

export const PlayArtistRadioAction = ({ artist, disabled }: PlayArtistRadioActionProps) => {
    const { t } = useTranslation();
    const player = usePlayer();
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();

    const handlePlayArtistRadio = useCallback(
        async (playType: Play) => {
            if (!serverId || !artist) return;

            try {
                const artistRadioSongs = await queryClient.fetchQuery({
                    ...songsQueries.artistRadio({
                        query: {
                            artistId: artist.id,
                            count: RADIO_TRACK_COUNT,
                        },
                        serverId: serverId,
                    }),
                    queryKey: queryKeys.player.fetch({ artistId: artist.id }),
                });
                if (artistRadioSongs && artistRadioSongs.length > 0) {
                    player.addToQueueByData(artistRadioSongs, playType);
                }
            } catch (error) {
                console.error('Failed to load track radio:', error);
            }
        },
        [artist, player, queryClient, serverId],
    );

    const handlePlayArtistRadioNow = useCallback(() => {
        handlePlayArtistRadio(Play.NOW);
    }, [handlePlayArtistRadio]);

    const handlePlayArtistRadioNext = useCallback(() => {
        handlePlayArtistRadio(Play.NEXT);
    }, [handlePlayArtistRadio]);

    const handlePlayArtistRadioLast = useCallback(() => {
        handlePlayArtistRadio(Play.LAST);
    }, [handlePlayArtistRadio]);

    const defaultPlayArtistRadioAction = useCallback(() => {
        handlePlayArtistRadio(PLAY_BUTTON_BEHAVIOR);
    }, [handlePlayArtistRadio]);

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    disabled={disabled}
                    leftIcon="radio"
                    onSelect={defaultPlayArtistRadioAction}
                    rightIcon="arrowRightS"
                >
                    {t('player.artistRadio')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="mediaPlay" onSelect={handlePlayArtistRadioNow}>
                    {t('player.play')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayNext" onSelect={handlePlayArtistRadioNext}>
                    {t('player.addNext')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayLast" onSelect={handlePlayArtistRadioLast}>
                    {t('player.addLast')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
