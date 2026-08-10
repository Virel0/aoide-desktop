import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './aoide-search.module.css';

import { useSmartSearch } from '/@/renderer/aoide/features/search/use-smart-search';
import { api } from '/@/renderer/api';
import { useGenreList } from '/@/renderer/features/genres/api/genres-api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId } from '/@/renderer/store';
import { looksLikeAPhrase, MINIMUM_PHRASE_WORDS } from '/@/shared/aoide/smart-search';
import { Badge } from '/@/shared/components/badge/badge';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { AlbumListSort, SongListSort, SortOrder } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * One field, and results underneath.
 *
 * Feishin's search is a tab per item type behind a filter bar, which asks you to
 * decide what kind of thing you are looking for before you have found it. This
 * asks for words and shows songs.
 *
 * The description path sits on top of the plain one rather than replacing it:
 * typing always searches, and a phrase of three words or more additionally
 * offers to be *interpreted*. That ordering matters — a paid, occasionally wrong
 * translation should never be the only way to find a song you can name.
 */
export const AoideSearch = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const player = usePlayer();

    const [text, setText] = useState('');
    const [submitted, setSubmitted] = useState('');
    const smart = useSmartSearch();

    const genres = useGenreList();
    const genreNames = useMemo(
        () => genres.data?.items.map((genre) => genre.name) ?? [],
        [genres.data],
    );

    // Names go to the model because they are what a person says; ids come back
    // here because they are what the server matches. The model never sees an id.
    const genreIdsByName = useMemo(
        () => new Map(genres.data?.items.map((genre) => [genre.name, genre.id]) ?? []),
        [genres.data],
    );

    const interpreted = smart.query;

    const results = useQuery({
        ...songsQueries.list(
            {
                query: {
                    favorite: interpreted?.favoritesOnly || undefined,
                    genreIds: interpreted?.genres
                        .map((name) => genreIdsByName.get(name))
                        .filter((id): id is string => Boolean(id)),
                    limit: 100,
                    maxYear: interpreted?.toYear ?? undefined,
                    minYear: interpreted?.fromYear ?? undefined,
                    // The interpretation may name a title or artist of its own;
                    // when it does not, the words typed are still the best guess.
                    searchTerm: interpreted?.searchTerm ?? submitted,
                    sortBy: SONG_SORTS[interpreted?.ordering ?? 'byName'],
                    sortOrder: interpreted?.ordering === 'byName' ? SortOrder.ASC : SortOrder.DESC,
                    startIndex: 0,
                },
                serverId,
            },
            300,
        ),
        enabled: submitted.length > 0,
    });

    const albums = useQuery({
        enabled: submitted.length > 0,
        queryFn: ({ signal }) =>
            api.controller.getAlbumList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: 24,
                    maxYear: interpreted?.toYear ?? undefined,
                    minYear: interpreted?.fromYear ?? undefined,
                    searchTerm: interpreted?.searchTerm ?? submitted,
                    sortBy: AlbumListSort.NAME,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            }),
        queryKey: ['aoide', 'search', 'albums', serverId, submitted, interpreted],
    });

    const songs = results.data?.items ?? [];
    const albumResults = albums.data?.items ?? [];

    const search = () => {
        setSubmitted(text);
        smart.clear();
    };

    const interpret = () => {
        setSubmitted(text);
        void smart.interpret(text, genreNames);
    };

    return (
        <Stack className={styles.page} gap="lg">
            <TextInput
                autoFocus
                className={styles.input}
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') search();
                }}
                placeholder={t('aoide.search.placeholder')}
                size="lg"
                value={text}
            />

            {/*
             * Always here once a key is set, disabled rather than hidden when
             * the phrase is too short. Hiding it meant the feature was
             * indistinguishable from a broken one: nothing on screen said it
             * existed, or what it wanted.
             */}
            <Group gap="sm">
                <Button
                    disabled={!smart.canInterpret || !looksLikeAPhrase(text) || smart.interpreting}
                    onClick={interpret}
                    variant="filled"
                >
                    {smart.interpreting ? <Spinner /> : t('aoide.search.interpret')}
                </Button>
                <Text isMuted size="sm">
                    {!smart.canInterpret
                        ? t('aoide.search.needsKey')
                        : looksLikeAPhrase(text)
                          ? t('aoide.search.interpretHint')
                          : t('aoide.search.needsPhrase', { count: MINIMUM_PHRASE_WORDS })}
                </Text>
            </Group>

            {interpreted && (
                <Group gap="xs">
                    {/* What it understood, shown rather than assumed. A wrong
                        reading is obvious here and invisible in a result list. */}
                    <Text isMuted size="sm">
                        {t('aoide.search.understood')}
                    </Text>
                    {interpreted.genres.map((genre) => (
                        <Badge key={genre}>{genre}</Badge>
                    ))}
                    {interpreted.fromYear && (
                        <Badge>
                            {interpreted.fromYear}
                            {interpreted.toYear && interpreted.toYear !== interpreted.fromYear
                                ? `–${interpreted.toYear}`
                                : ''}
                        </Badge>
                    )}
                    {interpreted.favoritesOnly && <Badge>{t('aoide.search.favourites')}</Badge>}
                    <Button onClick={smart.clear} size="compact-sm" variant="subtle">
                        {t('aoide.search.clearInterpretation')}
                    </Button>
                </Group>
            )}

            {smart.reason && (
                <Text isMuted size="sm">
                    {smart.reason}
                </Text>
            )}

            {submitted && results.isLoading && <Spinner />}

            {submitted && !results.isLoading && songs.length === 0 && (
                <Text isMuted>{t('aoide.search.noResults')}</Text>
            )}

            {albumResults.length > 0 && (
                <Stack gap="xs">
                    <Text fw={600} size="lg">
                        {t('aoide.search.albums')}
                    </Text>
                    <div className={styles.albums}>
                        {albumResults.map((album) => (
                            <Link
                                className={styles.album}
                                key={album.id}
                                to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, {
                                    albumId: album.id,
                                })}
                            >
                                <img
                                    alt=""
                                    className={styles.albumArt}
                                    src={album.imageUrl ?? undefined}
                                />
                                <Text lineClamp={1} size="sm">
                                    {album.name}
                                </Text>
                                <Text isMuted lineClamp={1} size="xs">
                                    {album.albumArtists?.[0]?.name ?? ''}
                                </Text>
                            </Link>
                        ))}
                    </div>
                </Stack>
            )}

            {songs.length > 0 && (
                <Text fw={600} size="lg">
                    {t('aoide.search.songs')}
                </Text>
            )}

            <Stack gap={0}>
                {songs.map((song) => (
                    <button
                        className={styles.result}
                        key={song.id}
                        onClick={() => player.addToQueueByData([song], Play.NOW)}
                        type="button"
                    >
                        <img alt="" className={styles.resultArt} src={song.imageUrl ?? undefined} />
                        <span className={styles.resultText}>
                            <Text size="md">{song.name}</Text>
                            <Text isMuted size="sm">
                                {song.artistName}
                            </Text>
                        </span>
                    </button>
                ))}
            </Stack>
        </Stack>
    );
};

/** The model's vocabulary, mapped onto the server's. */
const SONG_SORTS = {
    byName: SongListSort.NAME,
    mostPlayed: SongListSort.PLAY_COUNT,
    newestFirst: SongListSort.RECENTLY_ADDED,
    random: SongListSort.RANDOM,
    recentlyPlayed: SongListSort.RECENTLY_PLAYED,
} as const;
