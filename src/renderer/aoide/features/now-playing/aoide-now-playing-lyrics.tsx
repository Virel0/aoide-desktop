import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './aoide-now-playing-column.module.css';

import {
    activeLineIndex,
    INACTIVE_LINE_OPACITY,
    scrollTopForLine,
} from '/@/renderer/aoide/features/now-playing/now-playing-column';
import { lyricsQueries } from '/@/renderer/features/lyrics/api/lyrics-api';
import { normalizeLyrics } from '/@/renderer/features/lyrics/api/lyrics-utils';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useLyricsSettings, usePlayerProgress, usePlayerSong } from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';

/**
 * The phone's lyrics view, on the desktop.
 *
 * Fetching is Feishin's — `lyricsQueries.songLyrics` already knows about
 * local, remote, override and structured lyrics and there is nothing to add
 * to that. What this file owns is the *drawing*: synced lines in the phone's
 * typography, the active line in primary colour at full opacity, every other
 * line in secondary colour dimmed to `INACTIVE_LINE_OPACITY`, scrolled so the
 * active line sits in the upper third. Feishin's own renderer is an animation
 * engine with word cues and translations, and reusing it would mean styling
 * against it rather than with it.
 */
export const AoideNowPlayingLyrics = () => {
    const { t } = useTranslation();
    const song = usePlayerSong();
    const { delayMs } = useLyricsSettings();
    const { mediaSeekToTimestamp } = usePlayer();

    const { data, isLoading } = useQuery(
        lyricsQueries.songLyrics(
            {
                options: { enabled: Boolean(song?.id && song?._serverId) },
                query: { songId: song?.id ?? '' },
                serverId: song?._serverId ?? '',
            },
            song,
        ),
    );

    const lines = useMemo(() => {
        const lyrics = data?.selected?.lyrics;
        if (!data?.selectedSynced || !Array.isArray(lyrics)) return null;
        return normalizeLyrics(lyrics);
    }, [data]);

    const plain = useMemo(() => {
        const lyrics = data?.selected?.lyrics;
        if (typeof lyrics !== 'string') return null;
        const text = lyrics.trim();
        return text.length > 0 ? text.split('\n') : null;
    }, [data]);

    if (!song) {
        return <Empty message={t('aoide.nowPlaying.nothingPlaying')} />;
    }

    if (isLoading) {
        return (
            <div className={styles.lyricsEmpty}>
                <Spinner />
            </div>
        );
    }

    if (lines && lines.length > 0) {
        return (
            <SyncedLines
                lines={lines}
                offsetMs={(data?.selectedOffsetMs ?? 0) + delayMs}
                onSeek={(ms) => mediaSeekToTimestamp(ms / 1000)}
            />
        );
    }

    if (plain) {
        return (
            <div className={styles.lyricsScroll}>
                {plain.map((line, index) => (
                    <div className={styles.lyricLine} key={index}>
                        {line}
                    </div>
                ))}
            </div>
        );
    }

    return <Empty message={t('aoide.nowPlaying.noLyrics')} />;
};

const Empty = ({ message }: { message: string }) => (
    <div className={styles.lyricsEmpty}>
        <Text isMuted>{message}</Text>
    </div>
);

interface SyncedLinesProps {
    lines: { startMs: number; text: string }[];
    offsetMs: number;
    onSeek: (ms: number) => void;
}

const SyncedLines = ({ lines, offsetMs, onSeek }: SyncedLinesProps) => {
    const timestamp = usePlayerProgress();
    const active = activeLineIndex(lines, timestamp * 1000 + offsetMs);

    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Scrolled when the active line changes, not on every tick: the active
    // line is what moves, and following the clock would fight anyone reading
    // ahead between lines.
    useEffect(() => {
        const container = scrollRef.current;
        if (!container || active < 0) return;

        const line = container.children[active] as HTMLElement | undefined;
        if (!line) return;

        container.scrollTo({
            behavior: 'smooth',
            top: scrollTopForLine(
                { height: line.offsetHeight, top: line.offsetTop },
                container.clientHeight,
            ),
        });
    }, [active]);

    return (
        <div className={styles.lyricsScroll} ref={scrollRef}>
            {lines.map((line, index) => (
                <div
                    className={clsx(styles.lyricLine, {
                        [styles.lyricLineActive]: index === active,
                    })}
                    key={`${line.startMs}-${index}`}
                    onClick={() => onSeek(line.startMs)}
                    role="button"
                    style={{ opacity: index === active ? 1 : INACTIVE_LINE_OPACITY }}
                >
                    {line.text}
                </div>
            ))}
        </div>
    );
};
