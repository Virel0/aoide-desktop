import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './lyrics.module.css';

import { queryKeys } from '/@/renderer/api/query-keys';
import {
    computeSelectedFromResult,
    getDisplayOffset,
    lyricsQueries,
    type LyricsQueryResult,
} from '/@/renderer/features/lyrics/api/lyrics-api';
import {
    formatStructuredLyricLabel,
    getLyricsLayers,
    getOverlayLayerKey,
    lyricsHasWordCues,
} from '/@/renderer/features/lyrics/api/lyrics-utils';
import { openLyricsExportModal } from '/@/renderer/features/lyrics/components/lyrics-export-form';
import {
    useFuriganaLyrics,
    useRomajiLyrics,
    useSyncedRomajiLyrics,
} from '/@/renderer/features/lyrics/hooks/use-furigana-lyrics';
import { LyricsActions } from '/@/renderer/features/lyrics/lyrics-actions';
import { SynchronizedKaraokeLyrics } from '/@/renderer/features/lyrics/synchronized-karaoke-lyrics';
import {
    SynchronizedLyrics,
    SynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/synchronized-lyrics';
import {
    UnsynchronizedLyrics,
    UnsynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/unsynchronized-lyrics';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { queryClient } from '/@/renderer/lib/react-query';
import { useLyricsSettings, usePlayerSong, useSettingsStoreActions } from '/@/renderer/store';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';
import { useLocalStorage } from '/@/shared/hooks/use-local-storage';
import { LyricsOverride } from '/@/shared/types/domain-types';

type LyricsProps = {
    fadeOutNoLyricsMessage?: boolean;
    settingsKey?: string;
};

export const Lyrics = ({ fadeOutNoLyricsMessage = true, settingsKey = 'default' }: LyricsProps) => {
    const currentSong = usePlayerSong();

    const { enableFurigana, enableRomaji } = useLyricsSettings();
    const { setSettings } = useSettingsStoreActions();
    const { t } = useTranslation();
    const [index, setIndexState] = useState(0);
    const [visibleOverlayLayerKeys, setVisibleOverlayLayerKeys] = useLocalStorage<string[]>({
        defaultValue: [],
        key: `lyrics:visible-overlay-layers:${settingsKey}`,
    });
    const [pendingSongId, setPendingSongId] = useState<string | undefined>(currentSong?.id);
    const lyricsFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const previousSongIdRef = useRef<string | undefined>(currentSong?.id);

    useEffect(() => {
        const currentSongId = currentSong?.id;
        const previousSongId = previousSongIdRef.current;

        if (currentSongId === previousSongId) {
            return;
        }

        previousSongIdRef.current = currentSongId;
        setPendingSongId(undefined);

        if (!currentSongId) {
            return;
        }

        clearTimeout(lyricsFetchTimeoutRef.current);
        lyricsFetchTimeoutRef.current = setTimeout(() => {
            setPendingSongId(currentSongId);
        }, 500);

        return () => {
            clearTimeout(lyricsFetchTimeoutRef.current);
        };
    }, [currentSong?.id]);

    const lyricsKey = useMemo(() => {
        if (!currentSong?._serverId || !currentSong?.id) return null;
        return queryKeys.songs.lyrics(currentSong._serverId, { songId: currentSong.id });
    }, [currentSong]);

    const shouldFetchLyrics = !!currentSong?._serverId && !!currentSong?.id;
    const isWaitingToFetchLyrics = shouldFetchLyrics && pendingSongId !== currentSong?.id;

    const { data, isLoading, isRefetching } = useQuery(
        lyricsQueries.songLyrics(
            {
                options: {
                    enabled: !!pendingSongId && pendingSongId === currentSong?.id,
                },
                query: { songId: currentSong?.id || '' },
                serverId: currentSong?._serverId || '',
            },
            currentSong,
        ),
    );

    const indexToUse = data?.selectedStructuredIndex ?? index;
    useEffect(() => {
        if (data != null) setIndexState(data.selectedStructuredIndex);
    }, [data]);

    const { selected: lyrics, selectedSynced: synced } = useMemo(() => {
        if (!data) return { selected: null, selectedSynced: false };
        return computeSelectedFromResult(data, indexToUse);
    }, [data, indexToUse]);

    const { data: furiganaConvertedLyrics } = useFuriganaLyrics(lyrics?.lyrics, !!enableFurigana);
    const { data: romajiConvertedLyrics, isFetching: isFetchingRomaji } = useRomajiLyrics(
        lyrics?.lyrics,
        !!enableRomaji,
    );

    const rawSyncedLyrics = useMemo(() => {
        if (!synced || !lyrics || !('lyrics' in lyrics) || !Array.isArray(lyrics.lyrics)) {
            return null;
        }

        return lyrics.lyrics;
    }, [lyrics, synced]);

    const displayLyrics = useMemo(() => {
        if (!lyrics) return null;
        if (enableFurigana && furiganaConvertedLyrics) {
            return { ...lyrics, lyrics: furiganaConvertedLyrics };
        }
        return lyrics;
    }, [enableFurigana, lyrics, furiganaConvertedLyrics]);

    const currentOffsetMs = useMemo(() => {
        if (!data) return 0;
        return getDisplayOffset(lyrics, data.selectedOffsetMs, indexToUse, data.local);
    }, [data, indexToUse, lyrics]);

    const layers = useMemo(() => {
        if (!Array.isArray(data?.local)) {
            return null;
        }

        return getLyricsLayers(data.local);
    }, [data]);

    const overlayLayerToggles = useMemo(() => {
        if (!layers?.overlayLayers.length) {
            return [];
        }

        return layers.overlayLayers.map((layer) => ({
            key: getOverlayLayerKey(layer),
            kind: layer.synced ? (layer.kind ?? 'main') : 'main',
            label: formatStructuredLyricLabel(layer),
        }));
    }, [layers]);

    const visibleOverlayKeys = useMemo(
        () => new Set(visibleOverlayLayerKeys),
        [visibleOverlayLayerKeys],
    );

    const visibleOverlayLayers = useMemo(() => {
        if (!layers?.overlayLayers.length || !visibleOverlayKeys.size) {
            return [];
        }

        return layers.overlayLayers.filter((layer) =>
            visibleOverlayKeys.has(getOverlayLayerKey(layer)),
        );
    }, [layers, visibleOverlayKeys]);

    const pronunciationLyricsOverlay = useMemo(() => {
        const layer = visibleOverlayLayers.find(
            (entry) => entry.synced && entry.kind === 'pronunciation',
        );

        return layer?.synced ? layer.lyrics : null;
    }, [visibleOverlayLayers]);

    const translationLyricsOverlay = useMemo(() => {
        const layer = visibleOverlayLayers.find(
            (entry) => entry.synced && entry.kind === 'translation',
        );

        return layer?.synced ? layer.lyrics : null;
    }, [visibleOverlayLayers]);

    const extraOverlayLyrics = useMemo(() => {
        return visibleOverlayLayers
            .filter(
                (entry) =>
                    entry.synced && entry.kind !== 'pronunciation' && entry.kind !== 'translation',
            )
            .map((entry) => (entry.synced ? entry.lyrics : null))
            .filter((entry): entry is NonNullable<typeof entry> => entry != null);
    }, [visibleOverlayLayers]);

    const selectedAgents = useMemo(() => {
        if (!lyrics || !('synced' in lyrics) || !lyrics.synced) {
            return undefined;
        }

        return lyrics.agents;
    }, [lyrics]);

    const useServerPronunciation = !!pronunciationLyricsOverlay;

    const shouldGenerateSyncedRomaji =
        !!enableRomaji &&
        !!rawSyncedLyrics &&
        lyricsHasWordCues(rawSyncedLyrics) &&
        !useServerPronunciation;

    const { data: syncedRomajiLyrics, isFetching: isFetchingSyncedRomaji } = useSyncedRomajiLyrics(
        rawSyncedLyrics,
        shouldGenerateSyncedRomaji,
    );

    const isKaraoke = useMemo(() => {
        if (!synced || !displayLyrics || !('lyrics' in displayLyrics)) {
            return false;
        }

        return Array.isArray(displayLyrics.lyrics) && lyricsHasWordCues(displayLyrics.lyrics);
    }, [displayLyrics, synced]);

    const syncedLyricsProps = useMemo(() => {
        if (!displayLyrics) {
            return null;
        }

        return {
            ...(displayLyrics as SynchronizedLyricsProps),
            extraOverlayLyrics: isKaraoke ? extraOverlayLyrics : undefined,
            offsetMs: currentOffsetMs,
            pronunciationLyrics: pronunciationLyricsOverlay,
            romajiLyrics:
                enableRomaji && !useServerPronunciation && !shouldGenerateSyncedRomaji
                    ? (romajiConvertedLyrics as SynchronizedLyricsProps['romajiLyrics'])
                    : null,
            settingsKey,
            syncedRomajiLyrics: shouldGenerateSyncedRomaji ? (syncedRomajiLyrics ?? null) : null,
            translationLyrics: translationLyricsOverlay,
        };
    }, [
        displayLyrics,
        currentOffsetMs,
        enableRomaji,
        extraOverlayLyrics,
        isKaraoke,
        pronunciationLyricsOverlay,
        romajiConvertedLyrics,
        shouldGenerateSyncedRomaji,
        syncedRomajiLyrics,
        settingsKey,
        translationLyricsOverlay,
        useServerPronunciation,
    ]);

    const handleOnSearchOverride = useCallback(
        (params: LyricsOverride) => {
            if (!lyricsKey) return;
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev ? { ...prev, overrideSelection: params } : prev,
            );
            queryClient.invalidateQueries({ queryKey: lyricsKey });
        },
        [lyricsKey],
    );

    const handleUpdateOffset = useCallback(
        (offsetMs: number) => {
            if (!currentSong || !lyricsKey) return;

            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) => {
                if (!prev) return prev;
                const updated = { ...prev, selectedOffsetMs: offsetMs };
                if (Array.isArray(prev.local) && prev.local.length > 0) {
                    const idx = Math.min(indexToUse, prev.local.length - 1);
                    updated.local = [...prev.local];
                    updated.local[idx] = {
                        ...updated.local[idx],
                        offsetMs,
                    };
                }
                return updated;
            });
        },
        [currentSong, indexToUse, lyricsKey],
    );

    const setIndex = useCallback(
        (newIndex: number) => {
            setIndexState(newIndex);
            if (!lyricsKey || !data) return;
            const { selected: nextSelected, selectedSynced: nextSynced } =
                computeSelectedFromResult(data, newIndex);
            const nextOffset = getDisplayOffset(
                nextSelected,
                data.selectedOffsetMs,
                newIndex,
                data.local,
            );
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev
                    ? {
                          ...prev,
                          selected: nextSelected,
                          selectedOffsetMs: nextOffset,
                          selectedStructuredIndex: newIndex,
                          selectedSynced: nextSynced,
                      }
                    : prev,
            );
        },
        [data, lyricsKey],
    );

    const handleOnRemoveLyric = useCallback(async () => {
        if (!currentSong || !lyricsKey) return;

        queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
            prev
                ? {
                      ...prev,
                      overrideData: null,
                      overrideSelection: null,
                      remoteAuto: null,
                      suppressRemoteAuto: true,
                  }
                : prev,
        );
        await queryClient.invalidateQueries({ queryKey: lyricsKey });
    }, [currentSong, lyricsKey]);

    const handleToggleOverlayLayer = useCallback(
        (key: string) => {
            setVisibleOverlayLayerKeys((current) => {
                const next = new Set(current);
                if (next.has(key)) {
                    next.delete(key);
                } else {
                    next.add(key);
                }
                return Array.from(next);
            });
        },
        [setVisibleOverlayLayerKeys],
    );

    usePlayerEvents(
        {
            onCurrentSongChange: () => {
                setIndexState(0);
            },
        },
        [],
    );

    const languages = useMemo(() => {
        const local = data?.local;
        if (Array.isArray(local)) {
            return local.map((lyric, idx) => ({
                label: formatStructuredLyricLabel(lyric),
                value: idx.toString(),
            }));
        }
        if (local && !Array.isArray(local) && 'lyrics' in local) {
            return [{ label: 'xxx', value: '0' }];
        }
        return [];
    }, [data?.local]);

    const isWaitingForRomaji =
        !!enableRomaji &&
        !!lyrics &&
        (isFetchingRomaji || (shouldGenerateSyncedRomaji && isFetchingSyncedRomaji));

    const isLoadingLyrics =
        shouldFetchLyrics &&
        (isWaitingToFetchLyrics || isLoading || isRefetching || isWaitingForRomaji);
    const hasNoLyrics = !displayLyrics;
    const [shouldFadeOut, setShouldFadeOut] = useState(false);

    useEffect(() => {
        if (!fadeOutNoLyricsMessage) {
            setShouldFadeOut(false);
            return undefined;
        }

        if (!isLoadingLyrics && hasNoLyrics) {
            const timer = setTimeout(() => {
                setShouldFadeOut(true);
            }, 3000);
            return () => clearTimeout(timer);
        }

        if (!hasNoLyrics) {
            setShouldFadeOut(false);
        }

        return undefined;
    }, [isLoadingLyrics, hasNoLyrics, fadeOutNoLyricsMessage]);

    const handleExportLyrics = useCallback(() => {
        if (lyrics) {
            openLyricsExportModal({ lyrics, offsetMs: currentOffsetMs, synced });
        }
    }, [currentOffsetMs, lyrics, synced]);

    return (
        <ComponentErrorBoundary>
            <div className={styles.lyricsContainer}>
                {isLoadingLyrics ? (
                    <Spinner container />
                ) : (
                    <AnimatePresence mode="sync">
                        {hasNoLyrics ? (
                            <Center flex={1} w="100%">
                                <motion.div
                                    animate={{ opacity: shouldFadeOut ? 0 : 1 }}
                                    initial={{ opacity: 1 }}
                                    transition={{ duration: 0.5 }}
                                >
                                    <Group>
                                        <Text fw={500} isMuted isNoSelect>
                                            {t('page.fullscreenPlayer.noLyrics')}
                                        </Text>
                                    </Group>
                                </motion.div>
                            </Center>
                        ) : (
                            <motion.div
                                animate={{ opacity: 1 }}
                                className={styles.scrollContainer}
                                initial={{ opacity: 0 }}
                                transition={{ duration: 0.5 }}
                            >
                                {synced && syncedLyricsProps ? (
                                    isKaraoke ? (
                                        <SynchronizedKaraokeLyrics
                                            {...syncedLyricsProps}
                                            agents={selectedAgents}
                                        />
                                    ) : (
                                        <SynchronizedLyrics {...syncedLyricsProps} />
                                    )
                                ) : (
                                    <UnsynchronizedLyrics
                                        {...(displayLyrics as UnsynchronizedLyricsProps)}
                                        romajiLyrics={
                                            enableRomaji
                                                ? (romajiConvertedLyrics as UnsynchronizedLyricsProps['romajiLyrics'])
                                                : null
                                        }
                                        settingsKey={settingsKey}
                                    />
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>
                )}
                <div className={styles.actionsContainer}>
                    <LyricsActions
                        furiganaOn={enableFurigana}
                        hasLyrics={!!displayLyrics}
                        index={indexToUse}
                        languages={languages}
                        offsetMs={currentOffsetMs}
                        onExportLyrics={handleExportLyrics}
                        onRemoveLyric={handleOnRemoveLyric}
                        onSearchOverride={handleOnSearchOverride}
                        onToggleFurigana={() =>
                            setSettings({ lyrics: { enableFurigana: !enableFurigana } })
                        }
                        onToggleOverlayLayer={handleToggleOverlayLayer}
                        onToggleRomaji={() =>
                            setSettings({ lyrics: { enableRomaji: !enableRomaji } })
                        }
                        onUpdateOffset={handleUpdateOffset}
                        overlayLayers={overlayLayerToggles}
                        romajiOn={enableRomaji}
                        setIndex={setIndex}
                        settingsKey={settingsKey}
                        visibleOverlayKeys={visibleOverlayKeys}
                    />
                </div>
            </div>
        </ComponentErrorBoundary>
    );
};
