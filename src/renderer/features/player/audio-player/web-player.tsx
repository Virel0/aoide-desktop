import type { Dispatch } from 'react';
import type ReactPlayer from 'react-player';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useArrangement } from '/@/renderer/aoide/features/playback/arrangement-store';
import { useBeatGrid } from '/@/renderer/aoide/features/playback/beat-grid-store';
import { useAoideAutoDjEnabled } from '/@/renderer/aoide/features/playback/use-auto-dj';
import { useBufferDeck } from '/@/renderer/aoide/features/playback/use-buffer-deck';
import { useAoideExactJoinsEnabled } from '/@/renderer/aoide/features/playback/use-crossfade';
import { useDjPrefetch } from '/@/renderer/aoide/features/playback/use-dj-prefetch';
import { useLoudnessGain } from '/@/renderer/aoide/features/playback/use-loudness-gain';
import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { useMixTransition } from '/@/renderer/aoide/features/playback/use-mix-transition';
import { useTrimPlayers } from '/@/renderer/aoide/features/playback/use-trim-players';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    WebPlayerEngine,
    WebPlayerEngineHandle,
} from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { PlayerOnProgressProps } from '/@/renderer/features/player/audio-player/types';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import {
    usePlaybackSettings,
    usePlayerActions,
    usePlayerData,
    usePlayerMuted,
    usePlayerRepeat,
    usePlayerStoreBase,
    usePlayerVolume,
} from '/@/renderer/store';
import { MixTransition } from '/@/shared/aoide/mix-transition';
import { toast } from '/@/shared/components/toast/toast';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerStatus } from '/@/shared/types/types';

const PLAY_PAUSE_FADE_DURATION = 300;
const PLAY_PAUSE_FADE_INTERVAL = 10;

export function WebPlayer() {
    const playerRef = useRef<null | WebPlayerEngineHandle>(null);
    const { t } = useTranslation();
    const { currentSong, nextSong, num, player1, player2, status } = usePlayerData();
    const repeat = usePlayerRepeat();
    const repeatOneProgressRef = useRef({ player1: 0, player2: 0 });
    const { mediaAutoNext, mediaPause, setTimestamp } = usePlayerActions();
    const { webAudio } = useWebAudio();

    const isMuted = usePlayerMuted();
    const volume = usePlayerVolume();
    const { transcode } = usePlaybackSettings();
    // Set while the buffer deck has the boundary in front of it. Read by the
    // trim tracker and by the transition handlers below, all of which have to
    // stand down when a join has been committed to the audio clock.
    const deckOwnsBoundary = useRef(false);
    // Filled in below, once the ended handlers exist: ending a track early
    // runs the same path the element's own `ended` would.
    const trimEnd = useRef<((slot: 1 | 2) => void) | null>(null);
    const trim = useTrimPlayers({
        holdEndRef: deckOwnsBoundary,
        num,
        onEnded: trimEnd,
        player1,
        player2,
        playerRef,
    });
    // Aoide's loudness normalisation, as a factor into each slot's existing
    // gain node — the same node ReplayGain uses, so the two multiply.
    const loudness1 = useLoudnessGain(player1);
    const loudness2 = useLoudnessGain(player2);
    const levelVolume = useAoideLoudnessNormalisationEnabled();
    // Aoide's Crossfade: one plan for the handover in front of us, or null when
    // the mixer is off and Feishin's own transition settings still decide.
    const mix = useMixTransition(currentSong, nextSong);
    // Aoide's Auto DJ: what the server knows about the pair, for the deck to
    // plan a mix from. Every hook here is gated by the setting and reads a
    // cache; the tracks after the next are asked for ahead of time.
    const autoDj = useAoideAutoDjEnabled();
    const outgoingGrid = useBeatGrid(currentSong?.id);
    const outgoingArrangement = useArrangement(currentSong?.id);
    const incomingGrid = useBeatGrid(nextSong?.id);
    const incomingArrangement = useArrangement(nextSong?.id);
    useDjPrefetch();

    const player1Url = useSongUrl(player1, num === 1, transcode);
    const player2Url = useSongUrl(player2, num === 2, transcode);

    // Aoide's exact join. It only takes a boundary it can be sample-accurate
    // about; everything below is what happens when it does not. Without the
    // graph the deck is never built, and every path through it is a no-op —
    // which is how it is switched off. Auto DJ is the deck too: a mix cannot
    // be performed on an element, so turning it on builds the deck whether or
    // not exact joins were asked for.
    const exactJoins = useAoideExactJoinsEnabled();
    const deckWanted = exactJoins || autoDj;
    const deck = useBufferDeck({
        currentSong,
        dj: {
            enabled: autoDj,
            incoming: { arrangement: incomingArrangement, grid: incomingGrid },
            outgoing: { arrangement: outgoingArrangement, grid: outgoingGrid },
        },
        isMuted,
        mix,
        nextSong,
        num,
        ownsRef: deckOwnsBoundary,
        player1Url,
        player2Url,
        playerRef,
        repeat,
        trim,
        volume,
        webAudio: deckWanted ? webAudio : undefined,
    });

    const [localPlayerStatus, setLocalPlayerStatus] = useState<PlayerStatus>(status);
    const [isTransitioning, setIsTransitioning] = useState<boolean | string>(false);
    const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const [player1Source, setPlayer1Source] = useState<MediaElementAudioSourceNode | null>(null);
    const [player2Source, setPlayer2Source] = useState<MediaElementAudioSourceNode | null>(null);

    const fadeAndSetStatus = useCallback(
        async (startVolume: number, endVolume: number, duration: number, status: PlayerStatus) => {
            // Cancel any in-progress fade
            if (fadeIntervalRef.current) {
                clearInterval(fadeIntervalRef.current);
                fadeIntervalRef.current = null;
            }

            // Set initial volume immediately to ensure we start from the correct position
            // This is especially important when cancelling a previous fade
            playerRef.current?.setVolume(startVolume);

            const steps = duration / PLAY_PAUSE_FADE_INTERVAL;
            const volumeStep = (endVolume - startVolume) / steps;
            let currentStep = 0;

            const promise = new Promise<void>((resolve) => {
                fadeIntervalRef.current = setInterval(() => {
                    currentStep++;
                    const newVolume = startVolume + volumeStep * currentStep;

                    playerRef.current?.setVolume(newVolume);

                    if (currentStep >= steps) {
                        if (fadeIntervalRef.current) {
                            clearInterval(fadeIntervalRef.current);
                            fadeIntervalRef.current = null;
                        }
                        // Ensure final volume is exactly the target
                        playerRef.current?.setVolume(endVolume);
                        resolve();
                    }
                }, PLAY_PAUSE_FADE_INTERVAL);
            });

            if (status === PlayerStatus.PLAYING) {
                setLocalPlayerStatus(status);
                await promise;
            } else {
                await promise;
                setLocalPlayerStatus(status);
                playerRef.current?.setVolume(startVolume);
            }
        },
        [],
    );

    const handleRepeatOne = useCallback(
        (playerId: 1 | 2, playedSeconds: number, duration: number) => {
            if (repeat !== PlayerRepeat.ONE || duration <= 0 || num !== playerId) {
                return;
            }

            const key = playerId === 1 ? 'player1' : 'player2';
            const last = repeatOneProgressRef.current[key];
            repeatOneProgressRef.current[key] = playedSeconds;

            if (last > duration * 0.85 && playedSeconds < duration * 0.15) {
                setTimestamp(0);
                eventEmitter.emit('PLAYER_REPEATED', {
                    index: usePlayerStoreBase.getState().player.index,
                });
            }
        },
        [num, repeat, setTimestamp],
    );

    const onProgressPlayer1 = useCallback(
        (e: PlayerOnProgressProps) => {
            if (!playerRef.current?.player1()) {
                return;
            }

            if (num === 1 && !deck.engaged) {
                setTimestamp(e.playedSeconds);
            }
            // Before the trim tracker, so a committed join has already claimed
            // the boundary by the time the tracker would end the track itself.
            deck.onElementProgress(1);
            trim.onProgress1(e.playedSeconds);

            if (repeat === PlayerRepeat.ONE) {
                handleRepeatOne(1, e.playedSeconds, getDuration(playerRef.current.player1().ref));
                return;
            }

            if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
                return;
            }

            // The deck has the handover, to the sample. Nothing here may
            // pre-start an element on top of it.
            if (deckOwnsBoundary.current) {
                if (isTransitioning) {
                    setIsTransitioning(false);
                }
                return;
            }

            if (mix) {
                plannedTransitionHandler({
                    currentPlayer: playerRef.current.player1(),
                    currentPlayerNum: num,
                    currentTime: e.playedSeconds,
                    duration: trim.end1 ?? getDuration(playerRef.current.player1().ref),
                    hasNextSong: Boolean(player2),
                    isTransitioning,
                    mix,
                    nextPlayer: playerRef.current.player2(),
                    playerNum: 1,
                    setIsTransitioning,
                    volume,
                });
                return;
            }

            gaplessHandler({
                currentTime: e.playedSeconds,
                duration: getDuration(playerRef.current.player1().ref),
                hasNextSong: Boolean(player2),
                isFlac: false,
                isTransitioning,
                nextPlayer: playerRef.current.player2(),
                setIsTransitioning,
            });
        },
        [
            deck,
            handleRepeatOne,
            isTransitioning,
            mix,
            num,
            player2,
            repeat,
            setTimestamp,
            trim,
            volume,
        ],
    );

    const onProgressPlayer2 = useCallback(
        (e: PlayerOnProgressProps) => {
            if (!playerRef.current?.player2()) {
                return;
            }

            if (num === 2 && !deck.engaged) {
                setTimestamp(e.playedSeconds);
            }
            // Before the trim tracker, so a committed join has already claimed
            // the boundary by the time the tracker would end the track itself.
            deck.onElementProgress(2);
            trim.onProgress2(e.playedSeconds);

            if (repeat === PlayerRepeat.ONE) {
                handleRepeatOne(2, e.playedSeconds, getDuration(playerRef.current.player2().ref));
                return;
            }

            if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
                return;
            }

            // The deck has the handover, to the sample. Nothing here may
            // pre-start an element on top of it.
            if (deckOwnsBoundary.current) {
                if (isTransitioning) {
                    setIsTransitioning(false);
                }
                return;
            }

            if (mix) {
                plannedTransitionHandler({
                    currentPlayer: playerRef.current.player2(),
                    currentPlayerNum: num,
                    currentTime: e.playedSeconds,
                    duration: trim.end2 ?? getDuration(playerRef.current.player2().ref),
                    hasNextSong: Boolean(player1),
                    isTransitioning,
                    mix,
                    nextPlayer: playerRef.current.player1(),
                    playerNum: 2,
                    setIsTransitioning,
                    volume,
                });
                return;
            }

            gaplessHandler({
                currentTime: e.playedSeconds,
                duration: getDuration(playerRef.current.player2().ref),
                hasNextSong: Boolean(player1),
                isFlac: false,
                isTransitioning,
                nextPlayer: playerRef.current.player1(),
                setIsTransitioning,
            });
        },
        [
            deck,
            handleRepeatOne,
            isTransitioning,
            mix,
            num,
            player1,
            repeat,
            setTimestamp,
            trim,
            volume,
        ],
    );

    const handleOnEndedPlayer1 = useCallback(() => {
        // A committed join advances the queue itself, on the audio clock. The
        // element reaching its own end is the same handover arriving by a
        // slower route, and doing it twice is a track skipped.
        if (deck.onElementEnded(1)) {
            return;
        }

        const promise = new Promise((resolve) => {
            mediaAutoNext();
            resolve(true);
        });

        promise.then(() => {
            playerRef.current?.player1()?.ref?.getInternalPlayer().pause();

            // If mediaAutoNext resulted in a stopped/paused state (e.g. end of queue,
            // or pauseOnNextSongEnd flag), stop all audio instead of restoring volume.
            const currentStatus = usePlayerStoreBase.getState().player.status;
            if (currentStatus !== PlayerStatus.PLAYING) {
                playerRef.current?.pause();
            } else {
                playerRef.current?.setVolume(volume);
            }
            setIsTransitioning(false);
        });
    }, [deck, mediaAutoNext, volume]);

    const handleOnEndedPlayer2 = useCallback(() => {
        // A committed join advances the queue itself, on the audio clock. The
        // element reaching its own end is the same handover arriving by a
        // slower route, and doing it twice is a track skipped.
        if (deck.onElementEnded(2)) {
            return;
        }

        const promise = new Promise((resolve) => {
            mediaAutoNext();
            resolve(true);
        });

        promise.then(() => {
            playerRef.current?.player2()?.ref?.getInternalPlayer().pause();

            const currentStatus = usePlayerStoreBase.getState().player.status;
            if (currentStatus !== PlayerStatus.PLAYING) {
                playerRef.current?.pause();
            } else {
                playerRef.current?.setVolume(volume);
            }
            setIsTransitioning(false);
        });
    }, [deck, mediaAutoNext, volume]);

    trimEnd.current = (slot) => (slot === 1 ? handleOnEndedPlayer1() : handleOnEndedPlayer2());

    const player = usePlayer();

    usePlayerEvents(
        {
            onCurrentSongChange: () => {
                setIsTransitioning(false);
            },
            onPlayerQueueChange: () => {
                if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
                    setIsTransitioning(false);
                }
            },
            onPlayerSeekToTimestamp: (properties) => {
                setIsTransitioning(false);

                const timestamp = properties.timestamp;

                // A fade in flight has the next element already playing under
                // the current one. `isTransitioning` carries the fading
                // player's name while a blend is running and `true` while a
                // gapless pre-start is, so the string is what says there is a
                // volume ramp to undo.
                if (typeof isTransitioning === 'string') {
                    setIsTransitioning(false);

                    if (num === 1) {
                        playerRef.current?.player1()?.setVolume(volume);
                        playerRef.current?.player2()?.setVolume(0);
                        playerRef.current?.player2()?.ref?.getInternalPlayer()?.pause();
                    } else {
                        playerRef.current?.player2()?.setVolume(volume);
                        playerRef.current?.player1()?.setVolume(0);
                        playerRef.current?.player1()?.ref?.getInternalPlayer()?.pause();
                    }
                }

                let type: 'fraction' | 'seconds' | undefined = undefined;

                if (timestamp < 1) {
                    type = 'seconds';
                }

                if (num === 1) {
                    playerRef.current?.player1()?.ref?.seekTo(timestamp, type);
                } else {
                    playerRef.current?.player2()?.ref?.seekTo(timestamp, type);
                }
            },
            onPlayerStatus: async (properties) => {
                setIsTransitioning(false);

                const status = properties.status;

                // Same tidy-up on a pause or a stop: put the fading pair back
                // where they were before the ramp started.
                if (status !== PlayerStatus.PLAYING && typeof isTransitioning === 'string') {
                    if (num === 1) {
                        playerRef.current?.player1()?.setVolume(volume);
                        playerRef.current?.player2()?.setVolume(0);
                        playerRef.current?.player2()?.ref?.getInternalPlayer()?.pause();
                    } else {
                        playerRef.current?.player2()?.setVolume(volume);
                        playerRef.current?.player1()?.setVolume(0);
                        playerRef.current?.player1()?.ref?.getInternalPlayer()?.pause();
                    }
                }

                if (status === PlayerStatus.PLAYING) {
                    fadeAndSetStatus(0, volume, PLAY_PAUSE_FADE_DURATION, PlayerStatus.PLAYING);
                } else {
                    fadeAndSetStatus(volume, 0, PLAY_PAUSE_FADE_DURATION, status);
                }
            },
            onPlayerVolume: (properties) => {
                const volume = properties.volume;
                playerRef.current?.setVolume(volume);
            },
            onQueueCleared: () => {
                player.mediaStop();
            },
        },
        [volume, num, isTransitioning],
    );

    // Cleanup fade interval on unmount
    useEffect(() => {
        return () => {
            if (fadeIntervalRef.current) {
                clearInterval(fadeIntervalRef.current);
                fadeIntervalRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        // While the deck is playing there is no element to read a timestamp
        // off — it is paused, and the deck posts its own on the audio clock.
        if (localPlayerStatus !== PlayerStatus.PLAYING || deck.engaged) {
            return;
        }

        const interval = setInterval(() => {
            const activePlayer =
                num === 1 ? playerRef.current?.player1() : playerRef.current?.player2();
            const internalPlayer =
                activePlayer?.ref?.getInternalPlayer() as HTMLAudioElement | null;

            if (!internalPlayer) {
                return;
            }

            setTimestamp(internalPlayer.currentTime);
        }, 500);

        return () => clearInterval(interval);
    }, [deck.engaged, localPlayerStatus, num, setTimestamp]);

    /**
     * The half of levelling a file brought with it.
     *
     * Level Volume is one switch over two sources: the ReplayGain tags a file
     * already carries, and the measurement the server made of one that carries
     * none. `useLoudnessGain` stands down for a tagged file precisely so this
     * can have it, and the two multiply into the same gain node — so the switch
     * governs both or neither, and there is nothing left to configure between
     * them.
     *
     * Album gain in preference to track gain, because an album is the unit
     * somebody sat down to listen to and track gain flattens the quiet song
     * that was meant to be quiet. Peak-limited always: a positive gain that
     * clips is worse than no gain at all.
     */
    const calculateReplayGain = useCallback(
        (song: QueueSong): number => {
            if (!levelVolume) {
                return 1;
            }

            const gain = song.gain?.album ?? song.gain?.track;

            if (gain === undefined) {
                return 1;
            }

            const peak = song.peak?.album ?? song.peak?.track ?? 1;

            // https://wiki.hydrogenaud.io/index.php?title=ReplayGain_1.0_specification&section=19
            const expectedGain = 10 ** (gain / 20);

            if (isNaN(expectedGain)) {
                return 1;
            }

            return Math.min(expectedGain, 1 / peak);
        },
        [levelVolume],
    );

    useEffect(() => {
        if (!webAudio || !player1 || !player1Source) return;

        const newGain = calculateReplayGain(player1) * loudness1;

        // Apply per player slot whenever its song/source is ready so pre-started
        // inactive players have correct gain before gapless/crossfade transitions.
        try {
            webAudio.gains[0].gain.setValueAtTime(
                Math.max(0, newGain),
                webAudio.context.currentTime,
            );
        } catch (error) {
            console.error('Error setting gain', error);
        }
    }, [calculateReplayGain, loudness1, player1, player1Source, webAudio]);

    useEffect(() => {
        if (!webAudio || !player2 || !player2Source) return;

        const newGain = calculateReplayGain(player2) * loudness2;

        try {
            webAudio.gains[1].gain.setValueAtTime(
                Math.max(0, newGain),
                webAudio.context.currentTime,
            );
        } catch (error) {
            console.error('Error setting gain', error);
        }
    }, [calculateReplayGain, loudness2, player2, player2Source, webAudio]);

    const handlePlayer1Start = useCallback(
        async (player: ReactPlayer) => {
            if (!webAudio || player1Source) return;
            if (player1Url) {
                // This should fire once, only if the source is real (meaning we
                // saw the dummy source) and the context is not ready
                if (webAudio.context.state !== 'running') {
                    await webAudio.context.resume();
                }
            }

            const internal = player.getInternalPlayer() as HTMLMediaElement | undefined;
            if (internal) {
                const { context, gains } = webAudio;
                const source = context.createMediaElementSource(internal);
                source.connect(gains[0]);
                setPlayer1Source(source);
            }
        },
        [player1Source, player1Url, webAudio],
    );

    const handlePlayer2Start = useCallback(
        async (player: ReactPlayer) => {
            if (!webAudio || player2Source) return;
            if (player2Url) {
                if (webAudio.context.state !== 'running') {
                    await webAudio.context.resume();
                }
            }

            const internal = player.getInternalPlayer() as HTMLMediaElement | undefined;
            if (internal) {
                const { context, gains } = webAudio;
                const source = context.createMediaElementSource(internal);
                source.connect(gains[1]);
                setPlayer2Source(source);
            }
        },
        [player2Source, player2Url, webAudio],
    );

    const handleOnErrorPause = useCallback(() => {
        mediaPause();
        toast.error({
            message: t('error.playbackPausedDueToError'),
        });
    }, [mediaPause, t]);

    const loopPlayer1 = repeat === PlayerRepeat.ONE && num === 1;
    const loopPlayer2 = repeat === PlayerRepeat.ONE && num === 2;

    return (
        <WebPlayerEngine
            isMuted={isMuted}
            isTransitioning={Boolean(isTransitioning)}
            loopPlayer1={loopPlayer1}
            loopPlayer2={loopPlayer2}
            onEndedPlayer1={handleOnEndedPlayer1}
            onEndedPlayer2={handleOnEndedPlayer2}
            onErrorPause={handleOnErrorPause}
            onProgressPlayer1={onProgressPlayer1}
            onProgressPlayer2={onProgressPlayer2}
            onStartedPlayer1={handlePlayer1Start}
            onStartedPlayer2={handlePlayer2Start}
            playerNum={num}
            playerRef={playerRef}
            playerStatus={localPlayerStatus}
            src1={player1Url}
            src2={player2Url}
            volume={volume}
        />
    );
}

function crossfadeHandler(args: {
    crossfadeDuration: number;
    currentPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    currentPlayerNum: number;
    currentTime: number;
    duration: number;
    hasNextSong: boolean;
    isTransitioning: boolean | string;
    nextPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    playerNum: number;
    setIsTransitioning: Dispatch<boolean | string>;
    volume: number;
}) {
    const {
        crossfadeDuration,
        currentPlayer,
        currentPlayerNum,
        currentTime,
        duration,
        hasNextSong,
        isTransitioning,
        nextPlayer,
        playerNum,
        setIsTransitioning,
        volume,
    } = args;
    const player = `player${playerNum}`;

    if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return;
    }

    // If there is no next song to transition to, ensure we don't enter or stay in a transition
    if (!hasNextSong) {
        currentPlayer.setVolume(volume);
        nextPlayer.setVolume(0);
        nextPlayer.ref?.getInternalPlayer()?.pause();

        if (isTransitioning) {
            setIsTransitioning(false);
        }

        return;
    }

    if (!isTransitioning) {
        if (duration > 0 && currentTime > duration - crossfadeDuration) {
            // Skip pre-starting next player if pauseOnNextSongEnd is set
            if (usePlayerStoreBase.getState().player.pauseOnNextSongEnd) {
                return;
            }

            nextPlayer.setVolume(0);
            nextPlayer.ref?.getInternalPlayer().play();
            return setIsTransitioning(player);
        }

        return;
    }

    if (isTransitioning !== player && currentPlayerNum !== playerNum) {
        return;
    }

    const timeLeft = duration - currentTime;

    const progress = (crossfadeDuration - timeLeft) / crossfadeDuration;

    const easedProgressOut = equalPowerEaseOut(progress);
    const easedProgressIn = equalPowerEaseIn(progress);

    const currentPlayerVolume = (1 - easedProgressOut) * volume;
    const nextPlayerVolume = easedProgressIn * volume;

    // Set volumes for both players
    currentPlayer.setVolume(currentPlayerVolume);
    nextPlayer.setVolume(nextPlayerVolume);
}

/**
 * Equal power easing - maintains constant power during crossfade
 * Fade in: sin(π/2 * t)
 * Fade out: 1 - cos(π/2 * t) so that (1 - result) = cos(π/2 * t)
 */
function equalPowerEaseIn(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    return Math.sin((Math.PI / 2) * clampedT);
}

function equalPowerEaseOut(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.cos((Math.PI / 2) * clampedT);
}

function gaplessHandler(args: {
    currentTime: number;
    duration: number;
    hasNextSong: boolean;
    isFlac: boolean;
    isTransitioning: boolean | string;
    nextPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    setIsTransitioning: Dispatch<boolean | string>;
}) {
    const {
        currentTime,
        duration,
        hasNextSong,
        isFlac,
        isTransitioning,
        nextPlayer,
        setIsTransitioning,
    } = args;

    if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return null;
    }

    if (!hasNextSong) {
        return null;
    }

    // Ignore invalid durations (e.g. during URL load or empty source placeholder)
    if (!Number.isFinite(duration) || duration < 2) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return null;
    }

    if (!isTransitioning) {
        if (currentTime > duration - 2) {
            return setIsTransitioning(true);
        }

        return null;
    }

    const durationPadding = getDurationPadding(isFlac);

    if (currentTime + durationPadding >= duration) {
        // Skip pre-starting next player if pauseOnNextSongEnd is set
        if (usePlayerStoreBase.getState().player.pauseOnNextSongEnd) {
            return null;
        }

        return nextPlayer.ref
            ?.getInternalPlayer()
            ?.play()
            .catch(() => {});
    }

    return null;
}

function getDuration(ref: null | ReactPlayer | undefined) {
    return ref?.getInternalPlayer()?.duration || 0;
}

function getDurationPadding(isFlac: boolean) {
    switch (isFlac) {
        case false:
            return 0.116;
        case true:
            return 0.065;
    }
}

/**
 * The handover Crossfade planned, carried out with the machinery Feishin already
 * has.
 *
 * Nothing here decides anything: `planTransition` did, on numbers that can move
 * under it — a tempo arriving from the sidecar, a queue edited mid-song — and
 * this is re-consulted on every progress sample, so it cannot go stale.
 *
 * A blend is the existing crossfade over the planned length. A gapless
 * handover is the existing pre-start, which is what an album run gets so a
 * record that segues still does. A cut is the player doing nothing at all: the
 * element reaches its end, `onEnded` advances the queue, and the next track
 * starts — which is the behaviour every other part of this player already
 * falls back to, so a plan that gives up is never worse than not having the
 * feature.
 */
function plannedTransitionHandler(args: {
    currentPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    currentPlayerNum: number;
    currentTime: number;
    duration: number;
    hasNextSong: boolean;
    isTransitioning: boolean | string;
    mix: MixTransition;
    nextPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    playerNum: number;
    setIsTransitioning: Dispatch<boolean | string>;
    volume: number;
}) {
    const {
        currentPlayer,
        currentPlayerNum,
        currentTime,
        duration,
        hasNextSong,
        isTransitioning,
        mix,
        nextPlayer,
        playerNum,
        setIsTransitioning,
        volume,
    } = args;

    switch (mix.kind) {
        case 'blend':
            crossfadeHandler({
                crossfadeDuration: mix.overlapSeconds,
                currentPlayer,
                currentPlayerNum,
                currentTime,
                duration,
                hasNextSong,
                isTransitioning,
                nextPlayer,
                playerNum,
                setIsTransitioning,
                volume,
            });
            return;
        case 'cut':
            // The only work a cut has is undoing a blend the queue moved out
            // from under — the same tidy-up the crossfade does when it runs out
            // of songs to fade into. Left alone otherwise, so a cut never
            // touches a volume the play/pause fade is in the middle of riding.
            if (isTransitioning) {
                currentPlayer.setVolume(volume);
                nextPlayer.setVolume(0);
                nextPlayer.ref?.getInternalPlayer()?.pause();
                setIsTransitioning(false);
            }
            return;
        case 'gapless':
            gaplessHandler({
                currentTime,
                duration,
                hasNextSong,
                isFlac: false,
                isTransitioning,
                nextPlayer,
                setIsTransitioning,
            });
            return;
    }
}
