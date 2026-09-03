import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './aoide-import.module.css';

import { usePlaylistImport } from '/@/renderer/aoide/features/import/use-playlist-import';
import {
    useAddAoideTracks,
    useCreateAoidePlaylist,
} from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { trackInputFromSong } from '/@/renderer/aoide/features/playlists/track-input';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useCurrentServerId } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { FileButton } from '/@/shared/components/file-button/file-button';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

/**
 * Paste a Spotify playlist link, see what your server has and what it doesn't.
 *
 * The result is two lists rather than a playlist: what matched can be saved as
 * an Aoide playlist in one click, and what didn't is the shopping list — copied
 * out as text, since acquiring music is not this app's business.
 */
export const AoideImport = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const [link, setLink] = useState('');
    const importer = usePlaylistImport(serverId);
    const createPlaylist = useCreateAoidePlaylist();
    const addTracks = useAddAoideTracks();

    const busy = importer.phase.kind === 'reading' || importer.phase.kind === 'matching';

    const save = async () => {
        const name = (importer.playlist?.name ?? 'Imported playlist').slice(0, 80);
        const created = await createPlaylist.mutateAsync({ name });
        const added = await addTracks.mutateAsync({
            playlistId: created.id,
            tracks: importer.found.map(trackInputFromSong),
        });
        toast.success({ message: t('aoide.import.saved', { count: added.length, name }) });
    };

    const copyMissing = async () => {
        const text = importer.missing
            .map((track) => `${track.title} — ${track.artists.join(', ')}`)
            .join('\n');
        await navigator.clipboard.writeText(text);
        toast.success({ message: t('aoide.import.copied', { count: importer.missing.length }) });
    };

    if (!isAoideAvailable()) return null;

    return (
        <Stack className={styles.page} gap="lg">
            <Text fw={700} size="xl">
                {t('aoide.import.title')}
            </Text>

            <Group gap="sm">
                <TextInput
                    className={styles.input}
                    onChange={(event) => setLink(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') void importer.importSpotify(link);
                    }}
                    placeholder={t('aoide.import.placeholder')}
                    size="lg"
                    value={link}
                />
                <Button
                    disabled={busy || link.trim().length === 0}
                    onClick={() => void importer.importSpotify(link)}
                >
                    {busy ? <Spinner /> : t('aoide.import.lookUp')}
                </Button>
                <FileButton
                    accept=".csv,text/csv,text/plain"
                    onChange={(file) => file && void importer.importCSV(file)}
                >
                    {(props) => (
                        <Button {...props} disabled={busy} variant="default">
                            {t('aoide.import.chooseCsv')}
                        </Button>
                    )}
                </FileButton>
            </Group>

            <Text isMuted size="sm">
                {t('aoide.import.hint')}
            </Text>

            {importer.phase.kind === 'matching' && (
                <Text isMuted>
                    {t('aoide.import.matching', {
                        done: importer.phase.done,
                        total: importer.phase.total,
                    })}
                </Text>
            )}

            {importer.phase.kind === 'failed' && (
                <Text isMuted>{t(importer.phase.key, importer.phase.values)}</Text>
            )}

            {importer.phase.kind === 'finished' && (
                <>
                    <Text>
                        {t('aoide.import.found', {
                            found: importer.found.length,
                            total: importer.matches.length,
                        })}
                    </Text>
                    {importer.playlist?.isTruncated && (
                        <Text isMuted size="sm">
                            {t('aoide.import.truncated')}
                        </Text>
                    )}

                    <Group gap="sm">
                        {importer.found.length > 0 && (
                            <Button onClick={() => void save()} variant="filled">
                                {t('aoide.import.save', { count: importer.found.length })}
                            </Button>
                        )}
                        {importer.missing.length > 0 && (
                            <Button onClick={() => void copyMissing()} variant="default">
                                {t('aoide.import.copyMissing')}
                            </Button>
                        )}
                    </Group>

                    {importer.missing.length > 0 && (
                        <Stack gap={0}>
                            <Text fw={600}>
                                {t('aoide.import.missingHeading', {
                                    count: importer.missing.length,
                                })}
                            </Text>
                            {importer.missing.map((track) => (
                                <div
                                    className={styles.row}
                                    key={`${track.title}|${track.artists.join(',')}`}
                                >
                                    <span className={styles.text}>
                                        <Text size="md">{track.title}</Text>
                                        <Text isMuted size="sm">
                                            {track.artists.join(', ')}
                                        </Text>
                                    </span>
                                </div>
                            ))}
                        </Stack>
                    )}

                    {importer.found.length > 0 && (
                        <Stack gap={0}>
                            <Text fw={600}>
                                {t('aoide.import.foundHeading', { count: importer.found.length })}
                            </Text>
                            {importer.found.map((song) => (
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
                    )}
                </>
            )}
        </Stack>
    );
};
