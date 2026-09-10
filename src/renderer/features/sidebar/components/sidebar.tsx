import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { MouseEvent, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './sidebar.module.css';

import {
    showsAoidePlaylists,
    showsJellyfinPlaylists,
} from '/@/renderer/aoide/features/settings/playlist-surface';
import { useAoidePlaylistSurface } from '/@/renderer/aoide/features/settings/use-playlist-surface';
import { AoideSidebarList } from '/@/renderer/aoide/features/sidebar/aoide-sidebar-list';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { ActionBar } from '/@/renderer/features/sidebar/components/action-bar';
import { SidebarCollectionList } from '/@/renderer/features/sidebar/components/sidebar-collection-list';
import { SidebarIcon } from '/@/renderer/features/sidebar/components/sidebar-icon';
import { SidebarItem } from '/@/renderer/features/sidebar/components/sidebar-item';
import {
    SidebarPlaylistAddDragContext,
    SidebarPlaylistList,
    SidebarSharedPlaylistList,
    useSidebarPlaylistAddDragMonitor,
} from '/@/renderer/features/sidebar/components/sidebar-playlist-list';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useAppStore,
    useAppStoreActions,
    useFullScreenPlayerStore,
    useGeneralSettings,
    usePlayerSong,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import {
    SidebarItemType,
    useSidebarItems,
    useSidebarPlaylistList,
    useWindowSettings,
} from '/@/renderer/store/settings.store';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { ImageUnloader } from '/@/shared/components/image/image';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { ExplicitStatus, LibraryItem } from '/@/shared/types/domain-types';
import { Platform } from '/@/shared/types/types';

const SidebarPlaylistSection = () => {
    const isAddDragActive = useSidebarPlaylistAddDragMonitor();

    return (
        <SidebarPlaylistAddDragContext.Provider value={isAddDragActive}>
            <SidebarPlaylistList />
            <SidebarSharedPlaylistList />
        </SidebarPlaylistAddDragContext.Provider>
    );
};

export const Sidebar = () => {
    const { t } = useTranslation();

    const sidebarPlaylistList = useSidebarPlaylistList();

    // Aoide's preference for which playlists the sidebar carries. Jellyfin's
    // own toggle above still applies on top; this can only hide, never show.
    const playlistSurface = useAoidePlaylistSurface();
    const showAoidePlaylists = showsAoidePlaylists(playlistSurface);
    const showJellyfinPlaylists = showsJellyfinPlaylists(playlistSurface);

    const translatedSidebarItemMap = useMemo(
        () => ({
            Albums: t('page.sidebar.albums'),
            Artists: t('page.sidebar.albumArtists'),
            'Artists-all': t('page.sidebar.artists'),
            Collections: t('page.sidebar.collections'),
            Favorites: t('page.sidebar.favorites'),
            Genres: t('page.sidebar.genres'),
            Home: t('page.sidebar.home'),
            'Now Playing': t('page.sidebar.nowPlaying'),
            Playlists: t('page.sidebar.playlists'),
            Search: t('page.sidebar.search'),
            Settings: t('page.sidebar.settings'),
            Tracks: t('page.sidebar.tracks'),
        }),
        [t],
    );

    const sidebarItems = useSidebarItems();
    const { windowBarStyle } = useWindowSettings();
    const sidebarImageEnabled = useAppStore((state) => state.sidebar.image);
    const showImage = sidebarImageEnabled;

    const sidebarItemsWithRoute: SidebarItemType[] = useMemo(() => {
        if (!sidebarItems) return [];

        const items = sidebarItems
            .filter((item) => !item.disabled)
            .map((item) => ({
                ...item,
                label:
                    translatedSidebarItemMap[item.id as keyof typeof translatedSidebarItemMap] ??
                    item.label,
            }));

        return items;
    }, [sidebarItems, translatedSidebarItemMap]);

    /* Library accordion: only items with a route (exclude Collections section) */
    const libraryItemsWithRoute = useMemo(
        () =>
            sidebarItemsWithRoute.filter(
                (item) =>
                    item.id !== 'Collections' &&
                    item.route &&
                    // The route stays; only the entry goes. Hidden is not gone.
                    (showJellyfinPlaylists || item.route !== AppRoute.PLAYLISTS),
            ),
        [showJellyfinPlaylists, sidebarItemsWithRoute],
    );

    const isCustomWindowBar =
        windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS;

    return (
        <div
            className={clsx(styles.container, {
                [styles.customBar]: isCustomWindowBar,
            })}
            id="left-sidebar"
        >
            <Group grow id="global-search-container" style={{ flexShrink: 0 }}>
                <ActionBar />
            </Group>
            <ScrollArea allowDragScroll className={styles.scrollArea}>
                <Accordion
                    classNames={{
                        content: styles.accordionContent,
                        control: styles.accordionControl,
                        item: styles.accordionItem,
                        root: styles.accordionRoot,
                    }}
                    defaultValue={['library', 'collections', 'aoide', 'playlists']}
                    multiple
                >
                    <Accordion.Item value="library">
                        <Accordion.Control>
                            <Text fw={500} variant="secondary">
                                {t('page.sidebar.myLibrary')}
                            </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                            {libraryItemsWithRoute.map((item) => {
                                return (
                                    <SidebarItem key={`sidebar-${item.route}`} to={item.route}>
                                        <Group gap="md">
                                            <SidebarIcon route={item.route} />
                                            {item.label}
                                        </Group>
                                    </SidebarItem>
                                );
                            })}
                        </Accordion.Panel>
                    </Accordion.Item>
                    <SidebarCollectionList />
                    {showAoidePlaylists && <AoideSidebarList />}
                    {sidebarPlaylistList && showJellyfinPlaylists && <SidebarPlaylistSection />}
                </Accordion>
            </ScrollArea>
            <AnimatePresence initial={false} mode="popLayout">
                {showImage && <SidebarImage />}
            </AnimatePresence>
        </div>
    );
};

const SidebarImage = () => {
    const { t } = useTranslation();
    const { setSideBar } = useAppStoreActions();
    const currentSong = usePlayerSong();
    const { blurExplicitImages } = useGeneralSettings();

    const imageUrl = useItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        serverId: currentSong?._serverId,
        type: 'sidebar',
    });

    const isSongDefined = Boolean(currentSong?.id);

    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { expanded: isFullScreenPlayerExpanded } = useFullScreenPlayerStore();
    const expandFullScreenPlayer = () => {
        setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
    };

    const handleToggleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (!currentSong) {
            return;
        }

        if (isSongDefined && !isFullScreenPlayerExpanded) {
            ContextMenuController.call({
                cmd: { items: [currentSong!], type: LibraryItem.SONG },
                event: e,
            });
        }
    };

    return (
        <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={styles.imageContainer}
            exit={{ opacity: 0, y: 200 }}
            initial={{ opacity: 0, y: 200 }}
            key="sidebar-image"
            onClick={expandFullScreenPlayer}
            onContextMenu={handleToggleContextMenu}
            role="button"
            style={{ aspectRatio: 1 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
            <Tooltip label={t('player.toggleFullscreenPlayer')}>
                {imageUrl ? (
                    <img
                        className={clsx(styles.sidebarImage, {
                            [styles.censored]:
                                currentSong?.explicitStatus === ExplicitStatus.EXPLICIT &&
                                blurExplicitImages,
                        })}
                        loading="eager"
                        src={imageUrl}
                    />
                ) : (
                    <ImageUnloader icon="emptySongImage" />
                )}
            </Tooltip>
            <ActionIcon
                icon="arrowDownS"
                iconProps={{
                    size: 'lg',
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    setSideBar({ image: false });
                }}
                opacity={0.8}
                radius="md"
                style={{
                    cursor: 'default',
                    position: 'absolute',
                    right: '1rem',
                    top: '1rem',
                }}
                tooltip={{
                    label: t('common.collapse'),
                    openDelay: 500,
                }}
            />
        </motion.div>
    );
};
