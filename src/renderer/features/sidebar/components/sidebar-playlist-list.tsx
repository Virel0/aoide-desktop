import { openContextModal } from '@mantine/modals';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { motion } from 'motion/react';
import { createContext, memo, MouseEvent, useCallback, useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './sidebar-playlist-list.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { playlistsQueries } from '/@/renderer/features/playlists/api/playlists-api';
import { openCreatePlaylistModal } from '/@/renderer/features/playlists/components/create-playlist-form';
import { ItemRowPlayControls } from '/@/renderer/features/shared/components/item-row-play-controls';
import { useDragDrop } from '/@/renderer/hooks/use-drag-drop';
import { useDragMonitor } from '/@/renderer/hooks/use-drag-monitor';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useCurrentPlaylistContextId,
    useCurrentServer,
    useCurrentServerId,
    usePermissions,
} from '/@/renderer/store';
import { formatDurationString } from '/@/renderer/utils';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { animationProps } from '/@/shared/components/animations/animation-props';
import { animationVariants } from '/@/shared/components/animations/animation-variants';
import { ButtonProps } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Image } from '/@/shared/components/image/image';
import { Text } from '/@/shared/components/text/text';
import {
    LibraryItem,
    Playlist,
    PlaylistListSort,
    Song,
    SortOrder,
} from '/@/shared/types/domain-types';
import { DragData, DragOperation, DragTarget } from '/@/shared/types/drag-and-drop';
import { Play } from '/@/shared/types/types';

const MotionLink = motion.create(Link);

const playlistRowDimVariants = animationVariants.combine(animationVariants.fadeIn, {
    hidden: { opacity: 0.5 },
});

export const SidebarPlaylistAddDragContext = createContext(false);

const isAddToPlaylistDragSource = (source: DragData) => {
    return (
        source.itemType !== undefined &&
        source.type !== DragTarget.PLAYLIST &&
        (source.operation?.includes(DragOperation.ADD) ?? false)
    );
};

export const useSidebarPlaylistAddDragMonitor = () => {
    const [isAddDragActive, setIsAddDragActive] = useState(false);

    const handleAddDragStart = useCallback(() => {
        setIsAddDragActive(true);
    }, []);

    const handleAddDragDrop = useCallback(() => {
        setIsAddDragActive(false);
    }, []);

    useDragMonitor({
        canMonitor: isAddToPlaylistDragSource,
        onDragStart: handleAddDragStart,
        onDrop: handleAddDragDrop,
    });

    return isAddDragActive;
};

export interface PlaylistRowButtonProps extends Omit<ButtonProps, 'onContextMenu' | 'onPlay'> {
    item: Playlist;
    name: string;
    onContextMenu: (e: MouseEvent<HTMLAnchorElement>, item: Playlist) => void;
    to: string;
}

export const PlaylistRowButton = memo(
    ({ item, name, onContextMenu, to }: PlaylistRowButtonProps) => {
        const url = {
            pathname: generatePath(AppRoute.PLAYLISTS_DETAIL_SONGS, { playlistId: to }),
            state: { item },
        };
        const { t } = useTranslation();
        const activePlaylistId = useCurrentPlaylistContextId();
        const isActive = activePlaylistId === item.id;

        const [isHovered, setIsHovered] = useState(false);
        const isSmartPlaylist = Boolean(item.rules);
        const isAddDragActive = useContext(SidebarPlaylistAddDragContext);

        const { isDraggedOver, isDragging, ref } = useDragDrop<HTMLAnchorElement>({
            drag: {
                getId: () => {
                    return item && item.id ? [item.id] : [];
                },
                getItem: () => {
                    return item ? [item] : [];
                },
                itemType: LibraryItem.PLAYLIST,
                operation: [DragOperation.ADD],
                target: DragTarget.PLAYLIST,
            },
            drop: {
                canDrop: (args) =>
                    !isSmartPlaylist &&
                    args.source.itemType !== undefined &&
                    args.source.type !== DragTarget.PLAYLIST &&
                    (args.source.operation?.includes(DragOperation.ADD) ?? false),
                getData: () => {
                    return {
                        id: [to],
                        item: [],
                        itemType: LibraryItem.PLAYLIST,
                        type: DragTarget.PLAYLIST,
                    };
                },
                onDrag: () => {
                    return;
                },
                onDragLeave: () => {
                    return;
                },
                onDrop: (args) => {
                    const sourceItemType = args.source.itemType as LibraryItem;
                    const sourceIds = args.source.id;

                    if (isSmartPlaylist) {
                        return;
                    }

                    const modalProps: {
                        albumId?: string[];
                        artistId?: string[];
                        folderId?: string[];
                        genreId?: string[];
                        initialSelectedIds?: string[];
                        playlistId?: string[];
                        songId?: string[];
                    } = {
                        initialSelectedIds: [to],
                    };

                    switch (sourceItemType) {
                        case LibraryItem.ALBUM:
                            modalProps.albumId = sourceIds;
                            break;
                        case LibraryItem.ALBUM_ARTIST:
                        case LibraryItem.ARTIST:
                            modalProps.artistId = sourceIds;
                            break;
                        case LibraryItem.FOLDER:
                            modalProps.folderId = sourceIds;
                            break;
                        case LibraryItem.GENRE:
                            modalProps.genreId = sourceIds;
                            break;
                        case LibraryItem.PLAYLIST:
                            modalProps.playlistId = sourceIds;
                            break;
                        case LibraryItem.PLAYLIST_SONG:
                        case LibraryItem.QUEUE_SONG:
                        case LibraryItem.SONG:
                            if (args.source.item && Array.isArray(args.source.item)) {
                                const songs = args.source.item as Song[];
                                modalProps.songId = songs.map((song) => song.id);
                            } else {
                                modalProps.songId = sourceIds;
                            }
                            break;
                        default:
                            return;
                    }

                    openContextModal({
                        innerProps: modalProps,
                        modal: 'addToPlaylist',
                        size: 'lg',
                        title: t('form.addToPlaylist.title'),
                    });
                },
            },
            isEnabled: true,
        });

        const player = usePlayer();
        const serverId = useCurrentServerId();

        const permissions = usePermissions();

        const handlePlay = useCallback(
            (id: string, type: Play) => {
                player.addToQueueByFetch(serverId, [id], LibraryItem.PLAYLIST, type);
            },
            [player, serverId],
        );

        const imageUrl = useItemImageUrl({
            id: item.imageId || undefined,
            itemType: LibraryItem.PLAYLIST,
            type: 'table',
        });

        const isDimmed = isDragging || (isSmartPlaylist && isAddDragActive);

        return (
            <MotionLink
                {...animationProps.fadeIn}
                animate={isDimmed ? 'hidden' : 'show'}
                className={clsx(styles.row, {
                    [styles.rowDraggedOver]: isDraggedOver && !isSmartPlaylist,
                    [styles.rowHover]: isHovered,
                })}
                initial={false}
                onContextMenu={(e: MouseEvent<HTMLAnchorElement>) => {
                    e.preventDefault();
                    onContextMenu(e, item);
                }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                ref={ref}
                to={url}
                variants={playlistRowDimVariants}
            >
                <div className={styles.rowGroup}>
                    <Image containerClassName={styles.imageContainer} src={imageUrl} />
                    <div className={styles.metadata}>
                        <Text
                            className={clsx(styles.name, {
                                [styles.nameActive]: isActive,
                            })}
                            fw={500}
                            size="md"
                        >
                            {name}
                        </Text>
                        <div className={styles.metadataGroup}>
                            <div
                                className={clsx(
                                    styles.metadataGroupItem,
                                    styles.metadataGroupItemNoShrink,
                                )}
                            >
                                <Icon color="muted" icon="itemSong" size="sm" />
                                <Text isMuted size="sm">
                                    {item.songCount || 0}
                                </Text>
                            </div>
                            <div className={styles.metadataGroupItem}>
                                <Icon color="muted" icon="duration" size="sm" />
                                <Text isMuted size="sm">
                                    {formatDurationString(item.duration ?? 0)}
                                </Text>
                            </div>
                            {item.ownerId === permissions.userId && Boolean(item.public) && (
                                <div className={styles.metadataGroupItem}>
                                    <Text isMuted size="sm">
                                        {t('common.public')}
                                    </Text>
                                </div>
                            )}
                            {item.ownerId !== permissions.userId && (
                                <div className={styles.metadataGroupItem}>
                                    <Icon color="muted" icon="user" size="sm" />
                                    <Text isMuted size="sm">
                                        {item.owner}
                                    </Text>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {isHovered && (
                    <ItemRowPlayControls
                        className={styles.controls}
                        onPlay={(playType) => handlePlay(to, playType)}
                    />
                )}
            </MotionLink>
        );
    },
);

export const SidebarPlaylistList = () => {
    const player = usePlayer();
    const { t } = useTranslation();
    const server = useCurrentServer();

    const playlistsQuery = useQuery(
        playlistsQueries.list({
            query: {
                sortBy: PlaylistListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId: server?.id,
        }),
    );

    const handlePlayPlaylist = useCallback(
        (id: string, playType: Play) => {
            player.addToQueueByFetch(server.id, [id], LibraryItem.PLAYLIST, playType);
        },
        [player, server.id],
    );

    const handleContextMenu = useCallback(
        (e: MouseEvent<HTMLAnchorElement>, playlist: Playlist) => {
            e.preventDefault();
            e.stopPropagation();
            ContextMenuController.call({
                cmd: { items: [playlist], type: LibraryItem.PLAYLIST },
                event: e,
            });
        },
        [],
    );

    const playlistItems = useMemo(() => {
        const base = { handlePlay: handlePlayPlaylist };

        if (!server?.type || !server?.username || !playlistsQuery.data?.items) {
            return { ...base, items: playlistsQuery.data?.items };
        }

        const ownedPlaylistItems = (playlistsQuery.data?.items ?? []).filter(
            (playlist) => !playlist.owner || playlist.owner === server.username,
        );

        return { ...base, items: ownedPlaylistItems };
    }, [handlePlayPlaylist, playlistsQuery.data?.items, server.type, server.username]);

    const handleCreatePlaylistModal = (e: MouseEvent<HTMLButtonElement>) => {
        openCreatePlaylistModal(server, e);
    };

    return (
        <Accordion.Item value="playlists">
            <Accordion.Control component="div" role="button" style={{ userSelect: 'none' }}>
                <Group gap="xs" justify="space-between" pr="var(--theme-spacing-md)" wrap="nowrap">
                    <Group gap="xs" style={{ minWidth: 0 }} wrap="nowrap">
                        <Text className={styles.name} fw={500}>
                            {t('page.sidebar.playlists')}
                        </Text>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                        <ActionIcon
                            icon="add"
                            iconProps={{
                                size: 'lg',
                            }}
                            onClick={handleCreatePlaylistModal}
                            size="xs"
                            tooltip={{
                                label: t('action.createPlaylist'),
                            }}
                            variant="subtle"
                        />
                        <ActionIcon
                            component={Link}
                            icon="list"
                            iconProps={{
                                size: 'lg',
                            }}
                            onClick={(e) => e.stopPropagation()}
                            size="xs"
                            to={AppRoute.PLAYLISTS}
                            tooltip={{
                                label: t('action.viewPlaylists'),
                            }}
                            variant="subtle"
                        />
                    </Group>
                </Group>
            </Accordion.Control>
            <Accordion.Panel className={styles.panel}>
                {playlistItems?.items?.map((item) => (
                    <PlaylistRowButton
                        item={item}
                        key={item.id}
                        name={item.name}
                        onContextMenu={handleContextMenu}
                        to={item.id}
                    />
                ))}
            </Accordion.Panel>
        </Accordion.Item>
    );
};

export const SidebarSharedPlaylistList = () => {
    const player = usePlayer();
    const { t } = useTranslation();
    const server = useCurrentServer();

    const playlistsQuery = useQuery(
        playlistsQueries.list({
            query: {
                sortBy: PlaylistListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId: server?.id,
        }),
    );

    const handlePlayPlaylist = useCallback(
        (id: string, playType: Play) => {
            if (!server?.id) return;
            player.addToQueueByFetch(server.id, [id], LibraryItem.PLAYLIST, playType);
        },
        [player, server.id],
    );

    const handleContextMenu = useCallback(
        (e: MouseEvent<HTMLAnchorElement>, playlist: Playlist) => {
            e.preventDefault();
            e.stopPropagation();
            ContextMenuController.call({
                cmd: {
                    items: [playlist],
                    type: LibraryItem.PLAYLIST,
                },
                event: e,
            });
        },
        [],
    );

    const playlistItems = useMemo(() => {
        const base = { handlePlay: handlePlayPlaylist };

        if (!server?.type || !server?.username || !playlistsQuery.data?.items) {
            return { ...base, items: playlistsQuery.data?.items };
        }

        const sharedPlaylistItems = (playlistsQuery.data?.items ?? []).filter(
            (playlist) => playlist.owner && playlist.owner !== server.username,
        );

        return { ...base, items: sharedPlaylistItems };
    }, [handlePlayPlaylist, playlistsQuery.data?.items, server.type, server.username]);

    if (playlistItems?.items?.length === 0) {
        return null;
    }

    return (
        <Accordion.Item value="shared-playlists">
            <Accordion.Control component="motion.div" role="button" style={{ userSelect: 'none' }}>
                <Group gap="xs" style={{ minWidth: 0 }} wrap="nowrap">
                    <Text className={styles.name} fw={500} variant="secondary">
                        {t('page.sidebar.shared')}
                    </Text>
                </Group>
            </Accordion.Control>
            <Accordion.Panel className={styles.panel}>
                {playlistItems?.items?.map((item) => (
                    <PlaylistRowButton
                        item={item}
                        key={item.id}
                        name={item.name}
                        onContextMenu={handleContextMenu}
                        to={item.id}
                    />
                ))}
            </Accordion.Panel>
        </Accordion.Item>
    );
};
