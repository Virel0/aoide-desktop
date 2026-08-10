import type { PlaylistSummary, PlaylistTrack } from '/@/main/features/aoide/playlists';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import formatDuration from 'format-duration';
import { memo, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './aoide-playlist-detail.module.css';

import {
    openDeleteAoidePlaylistModal,
    openEditAoidePlaylistModal,
} from '/@/renderer/aoide/features/playlists/aoide-playlist-modals';
import {
    notifyAoideError,
    useAoidePlaylist,
    useAoidePlaylistItems,
    useMoveAoideItem,
    useRemoveAoideItem,
} from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { resolvePlaylistPlayback } from '/@/renderer/aoide/features/playlists/playlist-playback';
import {
    ROW_ARTWORK_WIDTH,
    trackArtworkUrl,
} from '/@/renderer/aoide/features/playlists/track-artwork';
import { usePlaylistCover } from '/@/renderer/aoide/features/playlists/use-playlist-cover';
import { useResolveUnknownTracks } from '/@/renderer/aoide/features/playlists/use-resolve-unknown-tracks';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { getSongById } from '/@/renderer/features/player/utils';
import { useDragDrop } from '/@/renderer/hooks/use-drag-drop';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer, useCurrentServerId } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { DropdownMenu } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Image } from '/@/shared/components/image/image';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';
import { DragData, DragOperation, DragTarget } from '/@/shared/types/drag-and-drop';
import { Play } from '/@/shared/types/types';

/**
 * A playlist's tracks in fractional-index order, reorderable and removable.
 *
 * Reordering is the reason this screen is hand-built rather than an ag-grid
 * table: a drop has to name the two entries the row landed between, so the
 * store can write **one** row. A table that hands back a new array of indices
 * would have to be translated back into neighbours anyway, and the translation
 * is the only interesting part.
 */
export const AoidePlaylistDetail = ({ playlistId }: { playlistId: string }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const serverId = useCurrentServerId();
    const player = usePlayer();
    const queryClient = useQueryClient();

    const playlistQuery = useAoidePlaylist(playlistId);
    const itemsQuery = useAoidePlaylistItems(playlistId);

    // A playlist that arrived from the phone is a list of ids until this device
    // has looked them up. Without this the rows read "Track not known to this
    // device" and stay that way.
    useResolveUnknownTracks(playlistId, itemsQuery.data ?? []);
    const { mutate: moveItem } = useMoveAoideItem();
    const { mutate: removeItem } = useRemoveAoideItem();

    const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);

    /*
     * The current order, readable from a callback that must not be rebuilt.
     *
     * `useDragDrop` re-registers its listeners whenever the objects handed to it
     * change identity, so the drop handler has to be stable across renders — and
     * a stable handler closing over `items` would reorder against whatever the
     * list looked like when the row first mounted.
     */
    const itemsRef = useRef<PlaylistTrack[]>(items);
    itemsRef.current = items;

    /*
     * Play, by data rather than by fetch.
     *
     * `addToQueueByFetch` looks like the right call and is not: its
     * `fetchSongsByItemType` switches on ALBUM, ARTIST, FOLDER, GENRE and
     * PLAYLIST with no `SONG` arm and no default, so a list of song ids comes
     * back empty — and `Play.NOW` then replaces the queue with nothing. Songs
     * are resolved here instead and handed over whole.
     */
    const queueFrom = useCallback(
        async (fromItemId?: string) => {
            const tracks = itemsRef.current;
            if (tracks.length === 0) return;

            const playback = await resolvePlaylistPlayback(
                tracks,
                fromItemId,
                async (jellyfinId) =>
                    (await getSongById({ id: jellyfinId, queryClient, serverId })).items[0],
            );

            if (playback.songs.length === 0) {
                toast.error({
                    message: t('aoide.error.playNoneResolved'),
                    title: t('aoide.error.play'),
                });
                return;
            }

            // Said out loud, because a queue quietly shorter than the list on
            // screen is the kind of wrong nobody attributes to the right cause.
            if (playback.missing > 0) {
                toast.warn({
                    message: t('aoide.detail.playMissing', { count: playback.missing }),
                    title: t('aoide.error.play'),
                });
            }

            player.addToQueueByData(playback.songs, Play.NOW, playback.playSongId);
        },
        [player, queryClient, serverId, t],
    );

    // The player's callbacks are synchronous, and a rejected promise nobody
    // awaits is an unhandled rejection rather than a message. `queueFrom`
    // already reports what it can, so anything left is genuinely unexpected.
    const handlePlay = useCallback(
        (fromItemId?: string) => {
            queueFrom(fromItemId).catch((error: unknown) =>
                notifyAoideError(error, t('aoide.error.play')),
            );
        },
        [queueFrom, t],
    );

    const handleRemove = useCallback(
        (itemId: string) => {
            removeItem(
                { itemId, playlistId },
                { onError: (error) => notifyAoideError(error, t('aoide.error.remove')) },
            );
        },
        [playlistId, removeItem, t],
    );

    /**
     * Turn a drop into the pair of neighbours the store asks for.
     *
     * The dragged row is taken out of the list first. Without that, dropping a
     * row onto the one directly below it names the dragged row as its own
     * neighbour, and the store refuses with "An item cannot be moved relative to
     * itself" — correctly, and for a gesture that looks perfectly ordinary.
     *
     * A drop that resolves to where the row already is still goes through: the
     * store detects it and writes nothing, which is a better place for that
     * decision than here, where it would be a second opinion about ordering.
     */
    const handleReorder = useCallback(
        (sourceId: string, targetId: string, edge: Edge | null) => {
            if (sourceId === targetId) return;

            const ordered = itemsRef.current.filter((item) => item.id !== sourceId);
            const targetIndex = ordered.findIndex((item) => item.id === targetId);
            if (targetIndex === -1) return;

            const insertAt = edge === 'bottom' ? targetIndex + 1 : targetIndex;

            moveItem(
                {
                    itemId: sourceId,
                    playlistId,
                    target: {
                        afterId: ordered[insertAt - 1]?.id ?? null,
                        beforeId: ordered[insertAt]?.id ?? null,
                    },
                },
                { onError: (error) => notifyAoideError(error, t('aoide.error.move')) },
            );
        },
        [moveItem, playlistId, t],
    );

    if (playlistQuery.isLoading) return <Spinner container />;

    if (playlistQuery.isError) {
        return (
            <Text className={styles.error} p="lg">
                {(playlistQuery.error as Error).message}
            </Text>
        );
    }

    const playlist = playlistQuery.data;

    if (!playlist) {
        return (
            <Text isMuted p="lg">
                {t('aoide.detail.missing')}
            </Text>
        );
    }

    return (
        <div className={styles.page}>
            <ScrollArea className={styles.scroll}>
                <div className={styles.content}>
                    <AoidePlaylistHero
                        onDeleted={() => void navigate(AppRoute.AOIDE_PLAYLISTS, { replace: true })}
                        onPlay={() => handlePlay()}
                        playlist={playlist}
                    />

                    {itemsQuery.isLoading && <Spinner container />}

                    {itemsQuery.isError && (
                        <Text className={styles.error}>{(itemsQuery.error as Error).message}</Text>
                    )}

                    {itemsQuery.data?.length === 0 && (
                        <div className={styles.empty}>
                            <Icon color="muted" icon="playlistAdd" size="3xl" />
                            <Text fw={600}>{t('aoide.detail.empty')}</Text>
                            <Text isMuted size="sm">
                                {t('aoide.detail.emptyHint')}
                            </Text>
                        </div>
                    )}

                    {items.length > 0 && (
                        <div className={styles.rows}>
                            {items.map((item, index) => (
                                <AoideTrackRow
                                    index={index + 1}
                                    item={item}
                                    key={item.id}
                                    onPlay={handlePlay}
                                    onRemove={handleRemove}
                                    onReorder={handleReorder}
                                    playlistId={playlistId}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

interface AoideTrackRowProps {
    index: number;
    item: PlaylistTrack;
    onPlay: (fromItemId: string) => void;
    onRemove: (itemId: string) => void;
    onReorder: (sourceId: string, targetId: string, edge: Edge | null) => void;
    playlistId: string;
}

const AoidePlaylistHero = ({
    onDeleted,
    onPlay,
    playlist,
}: {
    onDeleted: () => void;
    onPlay: () => void;
    playlist: PlaylistSummary;
}) => {
    const { t } = useTranslation();

    const cover = usePlaylistCover(playlist);

    return (
        <div className={styles.hero}>
            <div className={styles.heroArtwork}>
                {cover ? (
                    <img alt="" className={styles.heroCover} src={cover} />
                ) : (
                    <Icon icon="playlist" size="4xl" />
                )}
            </div>
            <div className={styles.heroText}>
                <Text isMuted size="sm">
                    {t('aoide.detail.eyebrow')}
                </Text>
                <TextTitle fw={700} order={1}>
                    {playlist.name}
                </TextTitle>
                <Text isMuted size="sm">
                    {t('aoide.trackCount', { count: playlist.trackCount })}
                </Text>
                {playlist.notes && (
                    <Text className={styles.notes} isMuted size="sm">
                        {playlist.notes}
                    </Text>
                )}
                <Group gap="sm" pt="sm">
                    <Button
                        disabled={playlist.trackCount === 0}
                        leftSection={<Icon icon="mediaPlay" />}
                        onClick={onPlay}
                        variant="filled"
                    >
                        {t('player.play')}
                    </Button>
                    <DropdownMenu position="bottom-start">
                        <DropdownMenu.Target>
                            <ActionIcon icon="ellipsisVertical" variant="default" />
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
                                onClick={() => openDeleteAoidePlaylistModal(playlist, onDeleted)}
                            >
                                {t('common.delete')}
                            </DropdownMenu.Item>
                        </DropdownMenu.Dropdown>
                    </DropdownMenu>
                </Group>
            </div>
        </div>
    );
};

/**
 * One entry.
 *
 * `title` and the rest are null when this device has never indexed the track —
 * the store's join is a LEFT one, so an entry synced from the phone arrives
 * without any metadata. The row is drawn anyway, saying so: dropping it would
 * make a synced playlist look shorter than it is, which is the failure that
 * cannot be noticed.
 */
const AoideTrackRow = memo(
    ({ index, item, onPlay, onRemove, onReorder, playlistId }: AoideTrackRowProps) => {
        const { t } = useTranslation();
        const server = useCurrentServer();

        const drag = useMemo(
            () => ({
                getId: () => [item.id],
                getItem: () => [item],
                itemType: LibraryItem.SONG,
                // Scoped to this playlist, so a row cannot be dragged from one
                // playlist's screen onto another's and reordered against a list
                // it is not in.
                metadata: { aoidePlaylistId: playlistId },
                operation: [DragOperation.REORDER],
                target: DragTarget.GENERIC,
            }),
            [item, playlistId],
        );

        const drop = useMemo(
            () => ({
                canDrop: ({ source }: { source: DragData }) =>
                    source.metadata?.aoidePlaylistId === playlistId,
                getData: (): DragData => ({ id: [item.id], type: DragTarget.GENERIC }),
                onDrag: () => undefined,
                onDragLeave: () => undefined,
                onDrop: ({ edge, source }: { edge: Edge | null; source: DragData }) => {
                    const sourceId = source.id[0];
                    if (sourceId) onReorder(sourceId, item.id, edge);
                },
            }),
            [item.id, onReorder, playlistId],
        );

        const { isDraggedOver, isDragging, ref } = useDragDrop<HTMLDivElement>({
            drag,
            drop,
            isEnabled: true,
        });

        const isUnresolved = item.title === null;

        const artwork = trackArtworkUrl(item, server, ROW_ARTWORK_WIDTH);

        return (
            <div
                className={clsx(styles.row, {
                    [styles.rowDragging]: isDragging,
                    [styles.rowDropBottom]: isDraggedOver === 'bottom',
                    [styles.rowDropTop]: isDraggedOver === 'top',
                })}
                onDoubleClick={() => onPlay(item.id)}
                ref={ref}
            >
                <div className={styles.handle}>
                    <Icon icon="dragVertical" size="sm" />
                </div>
                <Text className={styles.index} isMuted size="sm">
                    {index}
                </Text>
                <Image
                    className={styles.artwork}
                    src={artwork ?? undefined}
                    // A row without a resolved album has nothing to draw, and an
                    // empty box reads better than a broken-image glyph.
                    style={{ visibility: artwork ? 'visible' : 'hidden' }}
                />
                <div className={styles.cell}>
                    <Text
                        className={clsx(styles.cell, { [styles.unresolved]: isUnresolved })}
                        size="md"
                    >
                        {item.title ?? t('aoide.detail.unresolved')}
                    </Text>
                    <Text className={styles.cell} isMuted size="sm">
                        {item.artist ?? t('aoide.detail.unresolvedHint')}
                    </Text>
                </div>
                <Text className={clsx(styles.cell, styles.album)} isMuted size="sm">
                    {item.album ?? ''}
                </Text>
                <Text className={styles.duration} isMuted size="sm">
                    {item.durationMs === null ? '' : formatDuration(item.durationMs)}
                </Text>
                <DropdownMenu position="bottom-end">
                    <DropdownMenu.Target>
                        <ActionIcon
                            className={styles.rowMenu}
                            icon="ellipsisVertical"
                            iconProps={{ size: 'sm' }}
                            size="compact-sm"
                            variant="subtle"
                        />
                    </DropdownMenu.Target>
                    <DropdownMenu.Dropdown>
                        <DropdownMenu.Item
                            leftSection={<Icon icon="mediaPlay" />}
                            onClick={() => onPlay(item.id)}
                        >
                            {t('player.play')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            isDanger
                            leftSection={<Icon icon="remove" />}
                            onClick={() => onRemove(item.id)}
                        >
                            {t('aoide.action.removeFromPlaylist')}
                        </DropdownMenu.Item>
                    </DropdownMenu.Dropdown>
                </DropdownMenu>
            </div>
        );
    },
);
