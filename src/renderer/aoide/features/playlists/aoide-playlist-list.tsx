import type { PlaylistSummary } from '/@/main/features/aoide/playlists';

import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './aoide-playlist-list.module.css';

import {
    openCreateAoidePlaylistModal,
    openDeleteAoidePlaylistModal,
    openEditAoidePlaylistModal,
} from '/@/renderer/aoide/features/playlists/aoide-playlist-modals';
import { useAoidePlaylistList } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { usePlaylistCover } from '/@/renderer/aoide/features/playlists/use-playlist-cover';
import { AoideSyncPanel } from '/@/renderer/aoide/features/sync/aoide-sync-panel';
import { AppRoute } from '/@/renderer/router/routes';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { DropdownMenu } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { Text } from '/@/shared/components/text/text';

/**
 * Every Aoide playlist, in the order the store keeps them.
 *
 * Deliberately not Feishin's playlist grid: that one is fed by an infinite
 * server-side query with sorting, filtering and pagination, none of which apply
 * to a local table that returns the whole list in one query. Reusing it would
 * mean adapting these rows into `Playlist` — a shape carrying `_serverId`,
 * `ownerId` and a dozen fields no local playlist has — and every one of those
 * would be a lie by the time something read it.
 */
export const AoidePlaylistList = () => {
    const { t } = useTranslation();
    const playlistsQuery = useAoidePlaylistList();

    return (
        <div className={styles.page}>
            <ScrollArea className={styles.scroll}>
                <div className={styles.content}>
                    <div className={styles.header}>
                        <Stack gap={0}>
                            <TextTitle fw={700} order={2}>
                                {t('aoide.list.title')}
                            </TextTitle>
                            <Text isMuted size="sm">
                                {t('aoide.list.subtitle')}
                            </Text>
                        </Stack>
                        <Button
                            leftSection={<Icon icon="add" />}
                            onClick={() => openCreateAoidePlaylistModal()}
                            variant="filled"
                        >
                            {t('aoide.action.createPlaylist')}
                        </Button>
                    </div>

                    <AoideSyncPanel />

                    {playlistsQuery.isLoading && <Spinner container />}

                    {playlistsQuery.isError && (
                        <Text className={styles.error}>
                            {(playlistsQuery.error as Error).message}
                        </Text>
                    )}

                    {playlistsQuery.data?.length === 0 && (
                        <div className={styles.empty}>
                            <Icon color="muted" icon="playlist" size="3xl" />
                            <Text fw={600}>{t('aoide.list.empty')}</Text>
                            <Text isMuted size="sm">
                                {t('aoide.list.emptyHint')}
                            </Text>
                        </div>
                    )}

                    {playlistsQuery.data && playlistsQuery.data.length > 0 && (
                        <div className={styles.grid}>
                            {playlistsQuery.data.map((playlist) => (
                                <AoidePlaylistCard key={playlist.id} playlist={playlist} />
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

/**
 * One playlist.
 *
 * The cover is fetched when this card mounts and not before — the hash travels
 * in the op log, the bytes never do. A grid that prefetched every cover would
 * download the library's artwork to draw a page somebody may scroll straight
 * past.
 */
const AoidePlaylistCard = ({ playlist }: { playlist: PlaylistSummary }) => {
    const { t } = useTranslation();
    const cover = usePlaylistCover(playlist.imageHash, playlist.imageMime);

    return (
        <Link
            className={styles.card}
            to={generatePath(AppRoute.AOIDE_PLAYLISTS_DETAIL, { playlistId: playlist.id })}
        >
            <div className={styles.artwork}>
                {cover ? (
                    <img alt="" className={styles.cover} src={cover} />
                ) : (
                    <Icon icon="playlist" size="2xl" />
                )}
            </div>
            <Stack gap={0}>
                <Text className={styles.cardName} fw={600} size="md">
                    {playlist.name}
                </Text>
                <Text isMuted size="sm">
                    {t('aoide.trackCount', { count: playlist.trackCount })}
                </Text>
            </Stack>
            <Group className={styles.cardMenu}>
                <DropdownMenu position="bottom-end">
                    <DropdownMenu.Target>
                        <ActionIcon
                            icon="ellipsisVertical"
                            iconProps={{ size: 'sm' }}
                            onClick={(event) => {
                                // The card is a link; without this the menu
                                // opens and the router navigates away from it.
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            size="compact-sm"
                            variant="subtle"
                        />
                    </DropdownMenu.Target>
                    <DropdownMenu.Dropdown>
                        <DropdownMenu.Item
                            leftSection={<Icon icon="edit" />}
                            onClick={() => openEditAoidePlaylistModal(playlist)}
                        >
                            {t('common.edit')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            isDanger
                            leftSection={<Icon icon="delete" />}
                            onClick={() => openDeleteAoidePlaylistModal(playlist)}
                        >
                            {t('common.delete')}
                        </DropdownMenu.Item>
                    </DropdownMenu.Dropdown>
                </DropdownMenu>
            </Group>
        </Link>
    );
};
