import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import styles from './aoide-mix.module.css';

import { rememberMix } from '/@/renderer/aoide/features/home/use-recent-contexts';
import { useMix } from '/@/renderer/aoide/features/mix/use-mix';
import { aoidePlaylists, isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useGenreList } from '/@/renderer/features/genres/api/genres-api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServerId } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { Play } from '/@/shared/types/types';

/**
 * Describe a mood, get a mix.
 *
 * Nothing is stored unless you say so. That is the whole shape of the feature: a
 * mix is a queue you can throw away, and the Save button turns it into a smart
 * playlist — which is not a copy of the songs but the *rules*, so it stays fresh,
 * re-evaluates as listening changes, and syncs to the phone in a format the
 * phone already understands.
 */
export const AoideMix = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const player = usePlayer();
    // A tile on Home hands the description back, so a mix is one tap and one
    // click away rather than retyped.
    const location = useLocation();
    const [description, setDescription] = useState<string>(
        (location.state as null | { description?: string })?.description ?? '',
    );
    const mix = useMix(serverId);

    const genres = useGenreList();
    const genreNames = useMemo(
        () => genres.data?.items.map((genre) => genre.name) ?? [],
        [genres.data],
    );
    const genreIdsByName = useMemo(
        () => new Map(genres.data?.items.map((genre) => [genre.name, genre.id]) ?? []),
        [genres.data],
    );

    const build = () => void mix.build(description, genreNames, genreIdsByName);

    const play = () => {
        if (mix.songs.length === 0) return;
        player.addToQueueByData(mix.songs, Play.NOW);
        rememberMix(serverId, description);
    };

    const save = async () => {
        if (!mix.rules) return;

        const playlist = await aoidePlaylists().create(description.slice(0, 80), {
            notes: t('aoide.mix.savedFrom', { description }),
        });

        // Saved as rules rather than as the tracks it happened to pick. A mix
        // frozen to today's songs stops being the thing that was described.
        await aoidePlaylists().setSmartRules(playlist.id, JSON.stringify(mix.rules));
        toast.success({ message: t('aoide.mix.saved') });
    };

    if (!isAoideAvailable()) return null;

    return (
        <Stack className={styles.page} gap="lg">
            <Text fw={700} size="xl">
                {t('aoide.mix.title')}
            </Text>

            <Group gap="sm">
                <TextInput
                    className={styles.input}
                    onChange={(event) => setDescription(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') build();
                    }}
                    placeholder={t('aoide.mix.placeholder')}
                    size="lg"
                    value={description}
                />
                <Button disabled={mix.building || description.trim().length === 0} onClick={build}>
                    {mix.building ? <Spinner /> : t('aoide.mix.make')}
                </Button>
            </Group>

            {mix.trouble && <Text isMuted>{mix.trouble}</Text>}

            {/* Rules the model got wrong, named rather than swallowed — a mix
                missing half its definition otherwise looks merely unlucky. */}
            {mix.rejected.map((problem) => (
                <Text isMuted key={problem} size="sm">
                    {problem}
                </Text>
            ))}

            {mix.songs.length > 0 && (
                <>
                    <Group gap="sm">
                        <Button onClick={play} variant="filled">
                            {t('aoide.mix.play', { count: mix.songs.length })}
                        </Button>
                        <Button onClick={() => void save()} variant="default">
                            {t('aoide.mix.save')}
                        </Button>
                        <Button onClick={mix.clear} variant="subtle">
                            {t('aoide.mix.discard')}
                        </Button>
                    </Group>

                    <Stack gap={0}>
                        {mix.songs.map((song) => (
                            <div className={styles.row} key={song.id}>
                                <img
                                    alt=""
                                    className={styles.art}
                                    src={song.imageUrl ?? undefined}
                                />
                                <span className={styles.text}>
                                    <Text size="md">{song.name}</Text>
                                    <Text isMuted size="sm">
                                        {song.artistName}
                                    </Text>
                                </span>
                            </div>
                        ))}
                    </Stack>
                </>
            )}
        </Stack>
    );
};
