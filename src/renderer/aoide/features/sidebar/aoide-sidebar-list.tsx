import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { generatePath, Link, useLocation } from 'react-router';

import styles from './aoide-sidebar-list.module.css';

import { openCreateAoidePlaylistModal } from '/@/renderer/aoide/features/playlists/aoide-playlist-modals';
import { useAoidePlaylistList } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import {
    CoverSource,
    usePlaylistCover,
} from '/@/renderer/aoide/features/playlists/use-playlist-cover';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { AppRoute } from '/@/renderer/router/routes';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';

/**
 * Aoide's own playlists, beside Jellyfin's rather than mixed into them.
 *
 * Kept a separate section on purpose. These rows are not Jellyfin playlists:
 * they live in a local database, they sync with the phone rather than with the
 * server, and deleting one does nothing to the server's copy. Listing them
 * together would make every one of those differences a surprise.
 *
 * Rendered as an `Accordion.Item`, so it has to be a child of the sidebar's own
 * `Accordion` — that is the whole of the edit made to `sidebar.tsx`.
 */
export const AoideSidebarList = () => {
    const { t } = useTranslation();
    const location = useLocation();
    const playlistsQuery = useAoidePlaylistList();

    // The web and remote builds have no main process, so there is no store to
    // list. An empty section that can never fill is worse than no section.
    if (!isAoideAvailable()) return null;

    const playlists = playlistsQuery.data ?? [];

    return (
        <Accordion.Item value="aoide">
            <Accordion.Control component="div" role="button" style={{ userSelect: 'none' }}>
                <Group gap="xs" justify="space-between" pr="var(--theme-spacing-md)" wrap="nowrap">
                    <Text fw={500}>{t('aoide.sidebar.title')}</Text>
                    <ActionIcon
                        icon="add"
                        iconProps={{ size: 'sm' }}
                        onClick={(event) => {
                            // The control toggles the section; without this the
                            // "new playlist" click collapses it on the way past.
                            event.preventDefault();
                            event.stopPropagation();
                            openCreateAoidePlaylistModal();
                        }}
                        size="xs"
                        tooltip={{ label: t('aoide.action.createPlaylist') }}
                        variant="subtle"
                    />
                </Group>
            </Accordion.Control>
            <Accordion.Panel>
                <AoideSidebarRow
                    icon="search"
                    isActive={location.pathname === AppRoute.AOIDE_SEARCH}
                    label={t('aoide.sidebar.search')}
                    to={AppRoute.AOIDE_SEARCH}
                />
                <AoideSidebarRow
                    isActive={location.pathname === AppRoute.AOIDE_PLAYLISTS}
                    label={t('aoide.sidebar.all')}
                    to={AppRoute.AOIDE_PLAYLISTS}
                />
                {playlists.map((playlist) => {
                    const to = generatePath(AppRoute.AOIDE_PLAYLISTS_DETAIL, {
                        playlistId: playlist.id,
                    });

                    return (
                        <AoideSidebarRow
                            count={playlist.trackCount}
                            cover={playlist}
                            isActive={location.pathname === to}
                            key={playlist.id}
                            label={playlist.name}
                            to={to}
                        />
                    );
                })}
                {playlists.length === 0 && !playlistsQuery.isLoading && (
                    <Text className={styles.empty} isMuted size="sm">
                        {t('aoide.list.empty')}
                    </Text>
                )}
            </Accordion.Panel>
        </Accordion.Item>
    );
};

const AoideSidebarRow = ({
    count,
    cover,
    icon = 'playlist',
    isActive,
    label,
    to,
}: {
    count?: number;
    cover?: CoverSource;
    icon?: 'playlist' | 'search';
    isActive: boolean;
    label: string;
    to: string;
}) => {
    const coverUrl = usePlaylistCover(cover ?? EMPTY_COVER);

    return (
        <div className={clsx(styles.row, { [styles.rowActive]: isActive })}>
            <Link className={styles.rowLink} to={to}>
                <Group className={styles.rowContent} gap="sm" wrap="nowrap">
                    {coverUrl ? (
                        <img alt="" className={styles.rowCover} src={coverUrl} />
                    ) : (
                        <Icon color={isActive ? 'primary' : 'muted'} icon={icon} size="sm" />
                    )}
                    <Text className={styles.name} fw={500} size="md">
                        {label}
                    </Text>
                </Group>
                {count !== undefined && (
                    <Text className={styles.count} isMuted size="sm">
                        {count}
                    </Text>
                )}
            </Link>
        </div>
    );
};

/** The "all playlists" row has no cover of its own, and hooks cannot be skipped. */
const EMPTY_COVER: CoverSource = {
    artworkItemId: null,
    imageHash: null,
    imageMime: null,
    sourceJellyfinId: null,
};
