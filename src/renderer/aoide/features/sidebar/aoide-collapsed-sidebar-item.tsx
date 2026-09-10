import { useTranslation } from 'react-i18next';
import { generatePath, Link, useLocation } from 'react-router';

import { useAoidePlaylistList } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { showsAoidePlaylists } from '/@/renderer/aoide/features/settings/playlist-surface';
import { useAoidePlaylistSurface } from '/@/renderer/aoide/features/settings/use-playlist-surface';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { CollapsedSidebarItem } from '/@/renderer/features/sidebar/components/collapsed-sidebar-item';
import { AppRoute } from '/@/renderer/router/routes';
import { DropdownMenu } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Flex } from '/@/shared/components/flex/flex';
import { Icon } from '/@/shared/components/icon/icon';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';

/**
 * The Aoide section, for a sidebar with no room for a section.
 *
 * Collapsing the sidebar swaps `sidebar.tsx` for `collapsed-sidebar.tsx`, and
 * that file draws only the rows in `general.sidebarItems`. Mix, Import, Replay
 * and every Aoide playlist are not in that list — they are an accordion section
 * `sidebar.tsx` renders beside it — so collapsing put all of them out of reach.
 * Nothing else reaches them either: the command palette's "go to" list is
 * Feishin's routes, and there is no sidebar item pointing at `/aoide/...`.
 *
 * A dropdown rather than five more rows, because that is what the collapsed
 * sidebar already does with a list it cannot show: Collections is one icon that
 * opens the collections. This is the same shape, so the two behave alike and
 * neither has to grow a scrollbar of its own.
 *
 * The two conditions are the ones `sidebar.tsx` applies to `AoideSidebarList`,
 * and for the same reasons — no main process means no local store to list, and
 * someone who has hidden Aoide's playlists should not find them here instead.
 */
export const AoideCollapsedSidebarItem = () => {
    const { t } = useTranslation();
    const location = useLocation();
    const surface = useAoidePlaylistSurface();
    const playlistsQuery = useAoidePlaylistList();

    if (!isAoideAvailable() || !showsAoidePlaylists(surface)) return null;

    const playlists = playlistsQuery.data ?? [];

    return (
        <DropdownMenu offset={0} position="right-end">
            <DropdownMenu.Target>
                <CollapsedSidebarItem
                    activeIcon={null}
                    component={Flex}
                    icon={<Icon color="muted" icon="playlist" size="3xl" />}
                    label={t('aoide.sidebar.title')}
                    style={{
                        cursor: 'pointer',
                        padding: 'var(--theme-spacing-md) 0',
                    }}
                />
            </DropdownMenu.Target>
            <DropdownMenu.Dropdown>
                <ScrollArea style={{ maxHeight: '50vh' }}>
                    <Stack gap={0} p="xs">
                        <AoideCollapsedRow
                            icon="mediaShuffle"
                            label={t('aoide.sidebar.mix')}
                            pathname={location.pathname}
                            to={AppRoute.AOIDE_MIX}
                        />
                        <AoideCollapsedRow
                            icon="download"
                            label={t('aoide.sidebar.import')}
                            pathname={location.pathname}
                            to={AppRoute.AOIDE_IMPORT}
                        />
                        <AoideCollapsedRow
                            icon="lastPlayed"
                            label={t('aoide.sidebar.replay')}
                            pathname={location.pathname}
                            to={AppRoute.AOIDE_REPLAY}
                        />
                        <AoideCollapsedRow
                            label={t('aoide.sidebar.all')}
                            pathname={location.pathname}
                            to={AppRoute.AOIDE_PLAYLISTS}
                        />
                        {playlists.map((playlist) => (
                            <AoideCollapsedRow
                                key={playlist.id}
                                label={playlist.name}
                                pathname={location.pathname}
                                to={generatePath(AppRoute.AOIDE_PLAYLISTS_DETAIL, {
                                    playlistId: playlist.id,
                                })}
                            />
                        ))}
                    </Stack>
                </ScrollArea>
            </DropdownMenu.Dropdown>
        </DropdownMenu>
    );
};

const AoideCollapsedRow = ({
    icon = 'playlist',
    label,
    pathname,
    to,
}: {
    icon?: 'download' | 'lastPlayed' | 'mediaShuffle' | 'playlist';
    label: string;
    pathname: string;
    to: string;
}) => (
    <DropdownMenu.Item
        component={Link}
        isSelected={pathname === to}
        leftSection={<Icon icon={icon} />}
        to={to}
    >
        {label}
    </DropdownMenu.Item>
);
