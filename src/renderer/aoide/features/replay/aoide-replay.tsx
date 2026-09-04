import type { ReplayPeriod } from '/@/renderer/aoide/features/replay/replay-period';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './aoide-replay.module.css';

import {
    dayToDate,
    hoursListened,
    REPLAY_PERIODS,
} from '/@/renderer/aoide/features/replay/replay-period';
import { useReplay } from '/@/renderer/aoide/features/replay/use-replay';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServerId } from '/@/renderer/store';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { Play } from '/@/shared/types/types';

/**
 * Listening as a story: this month, this year, or all of it.
 *
 * The phone's Replay screen, on a wide window. Every number comes from
 * `aoide.history.recap`, which counts plays by the one shared definition —
 * so a song's rank here and the play count beside it in a playlist cannot
 * disagree. The page only decides where a period *starts*; the counting is
 * the main process's.
 *
 * Plays of tracks this device does not know are said out loud as a count
 * rather than dropped: a month spent listening on the phone to songs this
 * machine has never cached is still a month of listening.
 */
export const AoideReplay = () => {
    const { i18n, t } = useTranslation();
    const serverId = useCurrentServerId();
    const player = usePlayer();
    const [period, setPeriod] = useState<ReplayPeriod>('month');
    const { recap, songs, songsLoading } = useReplay(period, serverId);

    if (!isAoideAvailable()) return null;

    const data = recap.data;

    const play = (index: number) => {
        player.addToQueueByData(
            songs.map((ranked) => ranked.song),
            Play.NOW,
            songs[index].song.id,
        );
    };

    const busiestDay = data?.busiestDay
        ? dayToDate(data.busiestDay.day).toLocaleDateString(i18n.language, {
              day: 'numeric',
              month: 'long',
              weekday: 'long',
              year: period === 'month' ? undefined : 'numeric',
          })
        : null;

    return (
        <Stack className={styles.page} gap="lg">
            <Text fw={700} size="xl">
                {t('aoide.replay.title')}
            </Text>

            <SegmentedControl
                data={REPLAY_PERIODS.map((value) => ({
                    label: t(`aoide.replay.period_${value}`),
                    value,
                }))}
                onChange={(value) => setPeriod(value as ReplayPeriod)}
                value={period}
            />

            {recap.isLoading && <Spinner />}

            {recap.error && <Text isMuted>{String(recap.error)}</Text>}

            {data && data.totalPlays === 0 && (
                <Stack gap="xs">
                    <Text size="md">{t('aoide.replay.empty')}</Text>
                    <Text isMuted size="sm">
                        {t('aoide.replay.emptyHint')}
                    </Text>
                </Stack>
            )}

            {data && data.totalPlays > 0 && (
                <>
                    <div className={styles.tiles}>
                        <StatTile label={t('aoide.replay.plays')} value={data.totalPlays} />
                        <StatTile
                            label={t('aoide.replay.hours')}
                            value={hoursListened(data.totalMsPlayed)}
                        />
                        <StatTile label={t('aoide.replay.songs')} value={data.distinctTracks} />
                        <StatTile label={t('aoide.replay.artists')} value={data.distinctArtists} />
                    </div>

                    {busiestDay && data.busiestDay && (
                        <Text size="md">
                            {t('aoide.replay.busiestDay', {
                                count: data.busiestDay.playCount,
                                day: busiestDay,
                            })}
                        </Text>
                    )}

                    {data.unattributedPlays > 0 && (
                        <Text isMuted size="sm">
                            {t('aoide.replay.unattributed', { count: data.unattributedPlays })}
                        </Text>
                    )}

                    <section>
                        <Text className={styles.heading} fw={600} size="lg">
                            {t('aoide.replay.topSongs')}
                        </Text>
                        {songsLoading && <Spinner />}
                        <Stack gap={0}>
                            {songs.map((ranked, index) => (
                                <button
                                    className={styles.row}
                                    key={ranked.song.id}
                                    onClick={() => play(index)}
                                    type="button"
                                >
                                    <Text className={styles.rank} isMuted size="sm">
                                        {index + 1}
                                    </Text>
                                    <img
                                        alt=""
                                        className={styles.art}
                                        src={ranked.song.imageUrl ?? undefined}
                                    />
                                    <span className={styles.text}>
                                        <Text size="md">{ranked.song.name}</Text>
                                        <Text isMuted size="sm">
                                            {ranked.song.artistName}
                                        </Text>
                                    </span>
                                    <Text className={styles.count} isMuted size="sm">
                                        {t('aoide.replay.playCount', { count: ranked.playCount })}
                                    </Text>
                                </button>
                            ))}
                        </Stack>
                    </section>

                    <section>
                        <Text className={styles.heading} fw={600} size="lg">
                            {t('aoide.replay.topArtists')}
                        </Text>
                        <ol className={styles.list}>
                            {data.topArtists.map((entry) => (
                                <li className={styles.item} key={entry.artist}>
                                    <Text className={styles.text} size="md">
                                        {entry.artist}
                                    </Text>
                                    <Text className={styles.count} isMuted size="sm">
                                        {t('aoide.replay.playCount', { count: entry.playCount })}
                                    </Text>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section>
                        <Text className={styles.heading} fw={600} size="lg">
                            {t('aoide.replay.topAlbums')}
                        </Text>
                        <ol className={styles.list}>
                            {data.topAlbums.map((entry) => (
                                <li className={styles.item} key={`${entry.album}${entry.artist}`}>
                                    <span className={styles.text}>
                                        <Text size="md">{entry.album}</Text>
                                        <Text isMuted size="sm">
                                            {entry.artist}
                                        </Text>
                                    </span>
                                    <Text className={styles.count} isMuted size="sm">
                                        {t('aoide.replay.playCount', { count: entry.playCount })}
                                    </Text>
                                </li>
                            ))}
                        </ol>
                    </section>
                </>
            )}
        </Stack>
    );
};

/** One big number and what it counts. Tabular digits, so four of them line up. */
const StatTile = ({ label, value }: { label: string; value: number }) => (
    <div className={styles.tile}>
        <Text className={styles.value} fw={700} size="xl">
            {value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
        </Text>
        <Text isMuted size="sm">
            {label}
        </Text>
    </div>
);
