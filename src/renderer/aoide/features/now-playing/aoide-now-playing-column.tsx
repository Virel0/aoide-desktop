import { forwardRef, Ref, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './aoide-now-playing-column.module.css';
import { parseNowPlayingTab, useNowPlayingTab, useNowPlayingTabStore } from './use-now-playing-tab';

import { AoideNowPlayingLyrics } from '/@/renderer/aoide/features/now-playing/aoide-now-playing-lyrics';
import { ItemImage, useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ItemListHandle } from '/@/renderer/components/item-list/types';
import { JoinedArtists } from '/@/renderer/features/albums/components/joined-artists';
import { PlayQueue } from '/@/renderer/features/now-playing/components/play-queue';
import { PlayQueueListControls } from '/@/renderer/features/now-playing/components/play-queue-list-controls';
import { CenterControls } from '/@/renderer/features/player/components/center-controls';
import { ResizeHandle } from '/@/renderer/features/shared/components/resize-handle';
import { usePlayerSong } from '/@/renderer/store';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface AoideNowPlayingColumnProps {
    isResizing: boolean;
    startResizing: (direction: 'left' | 'right' | 'top', mouseEvent?: MouseEvent) => void;
}

/**
 * The phone's Now Playing as a column that stays open beside the page.
 *
 * Top to bottom, the phone's hierarchy: artwork with the wash behind it,
 * title, artist in the accent, one row of controls with the scrub bar, then
 * lyrics or the queue. Nothing here plays audio or seeks — the controls are
 * Feishin's own `CenterControls`, the queue is Feishin's side-queue list, and
 * the lyrics are fetched by Feishin's query. This file is the arrangement.
 *
 * Takes over the right-sidebar slot of the default layout, with the same
 * resize handle, so the width the person already dragged the queue to is the
 * width the column gets.
 */
export const AoideNowPlayingColumn = forwardRef(
    ({ isResizing, startResizing }: AoideNowPlayingColumnProps, ref: Ref<HTMLDivElement>) => {
        const { t } = useTranslation();
        const song = usePlayerSong();
        const tab = useNowPlayingTab();
        const setTab = useNowPlayingTabStore((state) => state.setTab);

        const tableRef = useRef<ItemListHandle | null>(null);
        const [search, setSearch] = useState<string | undefined>(undefined);

        // A small copy for the wash: it is blurred to nothing, and a 600px
        // JPEG behind a blur is bandwidth spent on pixels nobody can see.
        const washUrl = useItemImageUrl({
            id: song?.imageId,
            itemType: LibraryItem.SONG,
            serverId: song?._serverId,
            size: 120,
        });

        return (
            <aside className={styles.column} id="aoide-now-playing-column">
                <ResizeHandle
                    isResizing={isResizing}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        startResizing('right', e.nativeEvent);
                    }}
                    placement="left"
                    ref={ref}
                />
                {washUrl && (
                    <div
                        aria-hidden
                        className={styles.wash}
                        style={{ backgroundImage: `url("${washUrl}")` }}
                    />
                )}
                <div className={styles.head}>
                    <div className={styles.artwork}>
                        <ItemImage
                            className={styles.artworkImage}
                            enableDebounce={false}
                            enableViewport={false}
                            explicitStatus={song?.explicitStatus}
                            fetchPriority="high"
                            id={song?.imageId}
                            itemType={LibraryItem.SONG}
                            serverId={song?._serverId}
                            type="fullScreenPlayer"
                        />
                    </div>
                    <div className={styles.titles}>
                        <Text className={styles.title} fw={600} overflow="hidden" size="lg">
                            {song?.name ?? t('aoide.nowPlaying.nothingPlaying')}
                        </Text>
                        {song && (
                            <div className={styles.artist}>
                                <JoinedArtists
                                    artistName={song.artistName || ''}
                                    artists={song.artists || []}
                                    linkProps={{ className: styles.artistLink, size: 'lg' }}
                                    rootTextProps={{ className: styles.artistLink, size: 'lg' }}
                                />
                            </div>
                        )}
                    </div>
                    <div className={styles.controls}>
                        <CenterControls />
                    </div>
                </div>
                <div className={styles.tabs}>
                    <SegmentedControl
                        data={[
                            { label: t('aoide.nowPlaying.lyrics'), value: 'lyrics' },
                            { label: t('aoide.nowPlaying.queue'), value: 'queue' },
                        ]}
                        fullWidth
                        onChange={(value) => setTab(parseNowPlayingTab(value))}
                        value={tab}
                    />
                </div>
                <div className={styles.body}>
                    {tab === 'lyrics' ? (
                        <AoideNowPlayingLyrics />
                    ) : (
                        <div className={styles.queue}>
                            <PlayQueueListControls
                                handleSearch={setSearch}
                                searchTerm={search}
                                tableRef={tableRef}
                                type={ItemListKey.SIDE_QUEUE}
                            />
                            <div className={styles.queueList}>
                                <PlayQueue
                                    listKey={ItemListKey.SIDE_QUEUE}
                                    ref={tableRef}
                                    searchTerm={search}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </aside>
        );
    },
);
