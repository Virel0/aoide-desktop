import type { OutgoingPlayback } from '/@/renderer/aoide/features/playback/gapless-schedule';
import type { WebPlayerEngineHandle } from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import type { MixTransition } from '/@/shared/aoide/mix-transition';
import type { QueueSong } from '/@/shared/types/domain-types';
import type { WebAudio } from '/@/shared/types/types';
import type { RefObject } from 'react';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BufferDeck } from '/@/renderer/aoide/features/playback/buffer-deck';
import {
    endsAt,
    outgoingEndSec,
    planJoin,
    shouldDecode,
} from '/@/renderer/aoide/features/playback/gapless-schedule';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { convertToLogVolume } from '/@/renderer/features/player/audio-player/utils/player-utils';
import { usePlayerActions, usePlayerStoreBase } from '/@/renderer/store';
import { PlayerRepeat, PlayerStatus, PlayerStyle } from '/@/shared/types/types';

export interface BufferDeckArgs {
    /** Whether a pause is faded. The deck rides its own fader down to match. */
    audioFadeOnStatusChange: boolean;
    currentSong: QueueSong | undefined;
    isMuted: boolean;
    /** Aoide's plan for this pair, or null when its mixer is switched off. */
    mix: MixTransition | null;
    nextSong: QueueSong | undefined;
    /** Which slot is the audible one. */
    num: 1 | 2;
    /**
     * Set by the deck whenever it has this boundary — it is playing, or it has
     * a join committed. Every other handover in the player reads it and stands
     * down; the trim tracker reads it so the queue is not advanced twice.
     *
     * Passed in rather than returned, because the hooks that read it are
     * constructed before this one is.
     */
    ownsRef: RefObject<boolean>;
    player1Url: string | undefined;
    player2Url: string | undefined;
    playerRef: RefObject<null | WebPlayerEngineHandle>;
    repeat: PlayerRepeat;
    /** Feishin's own handover setting, consulted only when `mix` is null. */
    transitionType: PlayerStyle;
    trim: { end1: null | number; end2: null | number; start1: number; start2: number };
    volume: number;
    webAudio: undefined | WebAudio;
}

export interface BufferDeckHandle {
    /** True once the deck is the audible player rather than an element. */
    engaged: boolean;
    /**
     * The element's `ended`, offered to the deck first. True means the deck has
     * the handover and the player's own end-of-track path must stand down.
     */
    onElementEnded: (slot: 1 | 2) => boolean;
    /** A progress sample from the element that is currently audible. */
    onElementProgress: (slot: 1 | 2) => void;
}

/**
 * How long a hand-back to the element needs.
 *
 * When the next track has not decoded, the boundary is played the way it always
 * was — and the element has to be told a little ahead of time, with room left
 * over for a main thread that was busy.
 */
const ELEMENT_HANDBACK_SECONDS = 1.5;

/**
 * Feishin's own gapless padding, kept for the hand-back and nothing else. It is
 * the guess this module exists to replace, and it is still the right guess when
 * there is no buffer to be exact with.
 */
const ELEMENT_PRESTART_SECONDS = 0.116;

/** The play/pause fade, matched to the one the web player rides on elements. */
const PAUSE_FADE_SECONDS = 0.3;

/** How often the deck looks at its own clock while it is the player. */
const TICK_MS = 250;

/**
 * How long a pause has to last before the decoded audio is let go.
 *
 * A minute: long enough that answering the door and coming back is not a
 * hand-back, short enough that a session left paused overnight is not a hundred
 * megabytes of a record nobody is listening to.
 */
const IDLE_RELEASE_MS = 60_000;

const deckVolume = (volume: number, muted: boolean): number =>
    muted ? 0 : convertToLogVolume(Math.max(0, Math.min(100, volume)) / 100);

/**
 * The exact join, wired into a player built out of two `<audio>` elements.
 *
 * While an element is playing, the deck watches the boundary come up, decodes
 * the next track when it is thirty seconds off and — once it is inside a
 * two-second window — commits `AudioBufferSourceNode.start(when)` to the exact
 * context time the outgoing track stops. At that moment the queue advances, the
 * element that would have played the next track is paused and silenced before
 * it plays a note, and the deck is the player. From then on both sides of every
 * boundary are buffers, and the arithmetic joining them has no sampled number
 * left in it.
 *
 * It takes only the boundaries it can be exact about: a `gapless` or `cut` plan
 * from Aoide's mixer, or Feishin's own gapless setting when that mixer is off.
 * A planned blend is a crossfade and goes to the crossfade machinery untouched;
 * Repeat One is an element looping on itself and is left alone.
 *
 * Anything that is not playing straight forwards hands the track back: a pause,
 * a seek, a skip, a queue that moved. The element is put where the buffer had
 * got to and goes back to being the player, which is the state every neighbour
 * of this file already understands. A hand-back is only ever taken at a moment
 * that was a discontinuity anyway, so there is nothing to hear.
 */
export const useBufferDeck = (args: BufferDeckArgs): BufferDeckHandle => {
    const { mediaAutoNext, setTimestamp } = usePlayerActions();
    const [engaged, setEngaged] = useState(false);

    const deckRef = useRef<BufferDeck | null>(null);
    const ownsRef = args.ownsRef;
    const engagedRef = useRef(false);
    /** A join that has been committed to the audio clock and not yet arrived. */
    const planned = useRef<null | string>(null);
    /** The boundary is being given back to the element; leave it to the timers. */
    const handingBack = useRef(false);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

    // Timers and the deck's own tick run outside React's render, and each of
    // them needs the queue as it is now rather than as it was when the callback
    // was made.
    const latest = useRef(args);
    latest.current = args;

    const clearTimers = useCallback(() => {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current = [];
        handingBack.current = false;
    }, []);

    const after = useCallback((seconds: number, run: () => void) => {
        timers.current.push(setTimeout(run, Math.max(0, seconds) * 1000));
    }, []);

    const elementFor = useCallback((slot: 1 | 2) => {
        const handle = latest.current.playerRef.current;
        return slot === 1 ? handle?.player1() : handle?.player2();
    }, []);

    const mediaElementFor = useCallback(
        (slot: 1 | 2) =>
            elementFor(slot)?.ref?.getInternalPlayer() as HTMLMediaElement | null | undefined,
        [elementFor],
    );

    /**
     * Give the track back to its element, wherever the buffer had got to.
     *
     * The fade runs on the deck's own gain while the element is already parked
     * and paused, so a pause sounds like a pause rather than like a cut.
     */
    const relinquish = useCallback(
        (options: { fadeSeconds?: number; resume?: boolean; seek?: boolean } = {}) => {
            const { fadeSeconds = 0, resume = false, seek = true } = options;
            const deck = deckRef.current;
            clearTimers();
            planned.current = null;
            ownsRef.current = false;
            if (!deck) return;

            const wasEngaged = engagedRef.current;
            const position = deck.positionSec(latest.current.webAudio?.context.currentTime ?? NaN);
            // A skip lands here with the queue already moved on, so the slot
            // the deck was playing is not the slot that is current any more.
            // Putting the buffer's position into it would drop the new track
            // in at the old one's timestamp.
            const sameTrack = deck.currentId() === latest.current.currentSong?._uniqueId;
            deck.release(fadeSeconds);

            engagedRef.current = false;
            setEngaged(false);
            if (!wasEngaged) return;

            const { num, playerRef, volume } = latest.current;
            // Both slots: the one the deck took over was muted at the handover,
            // and it is silent for as long as nobody gives it its volume back.
            playerRef.current?.setVolume(volume);
            if (seek && sameTrack && position !== null) {
                elementFor(num)?.ref?.seekTo(position, 'seconds');
            }
            if (resume && usePlayerStoreBase.getState().player.status === PlayerStatus.PLAYING) {
                void mediaElementFor(num)
                    ?.play()
                    ?.catch(() => {});
            }
        },
        [clearTimers, elementFor, mediaElementFor, ownsRef],
    );

    /**
     * The moment the buffer becomes the player: the queue moves on, and the
     * element that was going to play this track is stopped and muted before it
     * plays a note of it.
     *
     * Called from the timer armed at the join and from the outgoing element's
     * own `ended`, whichever notices first. It runs once either way, because a
     * queue advanced twice is a track skipped.
     */
    const takeOver = useCallback(() => {
        if (!planned.current) return;
        planned.current = null;
        clearTimers();

        const outgoingSlot = latest.current.num;
        const incomingSlot: 1 | 2 = outgoingSlot === 1 ? 2 : 1;
        mediaElementFor(outgoingSlot)?.pause();

        mediaAutoNext();

        // The queue ran out, or a pause was armed for exactly this boundary.
        // The join is already committed to the audio clock, so take it back
        // rather than engage on top of a player that has stopped.
        if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
            latest.current.playerRef.current?.setVolume(latest.current.volume);
            deckRef.current?.release();
            ownsRef.current = false;
            return;
        }

        elementFor(incomingSlot)?.setVolume(0);
        mediaElementFor(incomingSlot)?.pause();

        engagedRef.current = true;
        ownsRef.current = true;
        setEngaged(true);
    }, [clearTimers, elementFor, mediaAutoNext, mediaElementFor, ownsRef]);

    /**
     * The boundary is coming and nothing is decoded. The element takes the
     * track, started early by the padding the web player has always used —
     * which is exactly the handover this deck replaces when it can, and the
     * right one when it cannot.
     */
    const handBackAtBoundary = useCallback(
        (boundary: number) => {
            const context = latest.current.webAudio?.context;
            if (!context || handingBack.current) return;
            handingBack.current = true;

            const incomingSlot: 1 | 2 = latest.current.num === 1 ? 2 : 1;

            after(boundary - ELEMENT_PRESTART_SECONDS - context.currentTime, () => {
                if (!latest.current.nextSong) return;
                if (usePlayerStoreBase.getState().player.pauseOnNextSongEnd) return;
                elementFor(incomingSlot)?.setVolume(latest.current.volume);
                void mediaElementFor(incomingSlot)
                    ?.play()
                    ?.catch(() => {});
            });

            after(boundary - context.currentTime, () => {
                relinquish({ seek: false });
                mediaAutoNext();
            });
        },
        [after, elementFor, mediaAutoNext, mediaElementFor, relinquish],
    );

    /**
     * One pass at the boundary in front of whatever is playing: decode when it
     * is close, commit when it is closer, and give it back when the decode did
     * not arrive.
     */
    const advanceBoundary = useCallback(
        (outgoing: OutgoingPlayback, outgoingEnd: null | number) => {
            const state = latest.current;
            const context = state.webAudio?.context;
            const deck = deckRef.current;
            if (!context || !deck) return;
            if (planned.current || handingBack.current) return;

            const boundary = outgoingEnd === null ? null : endsAt(outgoing, outgoingEnd);
            if (boundary === null || outgoingEnd === null) return;
            const now = context.currentTime;

            const exact = state.mix
                ? state.mix.kind === 'gapless' || state.mix.kind === 'cut'
                : state.transitionType === PlayerStyle.GAPLESS;
            const next = state.nextSong;
            const usable =
                exact &&
                Boolean(next) &&
                state.repeat !== PlayerRepeat.ONE &&
                !usePlayerStoreBase.getState().player.pauseOnNextSongEnd;

            if (!usable || !next) {
                if (engagedRef.current && boundary - now <= ELEMENT_HANDBACK_SECONDS) {
                    handBackAtBoundary(boundary);
                }
                return;
            }

            const incomingSlot: 1 | 2 = state.num === 1 ? 2 : 1;

            if (!deck.ready(next._uniqueId)) {
                const url = incomingSlot === 1 ? state.player1Url : state.player2Url;
                if (url && shouldDecode(boundary - now) && !deck.isPreparing(next._uniqueId)) {
                    void deck.prepare(next._uniqueId, url, next.duration / 1000);
                }
                if (engagedRef.current && boundary - now <= ELEMENT_HANDBACK_SECONDS) {
                    handBackAtBoundary(boundary);
                }
                return;
            }

            const join = planJoin({
                endSec: outgoingEnd,
                incomingDurationSec: deck.decodedDurationSec() ?? Number.NaN,
                incomingStartSec: incomingSlot === 1 ? state.trim.start1 : state.trim.start2,
                now,
                outgoing,
            });

            if (join.kind !== 'join') {
                if (
                    join.reason !== 'early' &&
                    engagedRef.current &&
                    boundary - now <= ELEMENT_HANDBACK_SECONDS
                ) {
                    handBackAtBoundary(boundary);
                }
                return;
            }

            const voice = deck.schedule({
                gainIndex: incomingSlot - 1,
                id: next._uniqueId,
                offsetSec: join.offsetSec,
                startAtContextTime: join.startAtContextTime,
            });
            if (!voice) return;

            planned.current = next._uniqueId;
            ownsRef.current = true;
            after(join.startAtContextTime - context.currentTime, takeOver);
        },
        [after, handBackAtBoundary, ownsRef, takeOver],
    );

    const onElementProgress = useCallback(
        (slot: 1 | 2) => {
            const state = latest.current;
            const context = state.webAudio?.context;
            if (!context || !deckRef.current || engagedRef.current || state.num !== slot) return;

            const element = mediaElementFor(slot);
            if (!element) return;

            // Read the two clocks one after the other: work between them is an
            // error in the join of exactly that length.
            const positionSec = element.currentTime;
            const sampledAtContextTime = context.currentTime;

            const trimmedEnd = slot === 1 ? state.trim.end1 : state.trim.end2;
            advanceBoundary(
                { kind: 'element', positionSec, sampledAtContextTime },
                outgoingEndSec(trimmedEnd, element.duration),
            );
        },
        [advanceBoundary, mediaElementFor],
    );

    const onElementEnded = useCallback(
        (slot: 1 | 2) => {
            if (!planned.current || latest.current.num !== slot) return false;
            takeOver();
            return true;
        },
        [takeOver],
    );

    const webAudio = args.webAudio;
    useEffect(() => {
        if (!webAudio) return undefined;
        const deck = new BufferDeck(webAudio.context, webAudio.gains);
        deck.setVolume(deckVolume(latest.current.volume, latest.current.isMuted), 0);
        deckRef.current = deck;
        return () => {
            deckRef.current = null;
            ownsRef.current = false;
            engagedRef.current = false;
            deck.stop();
        };
    }, [ownsRef, webAudio]);

    // The person's slider and their mute, mirrored onto the deck's own fader —
    // the element's `volume` property by another name, in front of the gain node
    // the levelling uses so the two never fight.
    useEffect(() => {
        deckRef.current?.setVolume(deckVolume(args.volume, args.isMuted));
    }, [args.isMuted, args.volume]);

    // `mediaAutoNext` flips which slot is the audible one, and react-player
    // calls `play()` on that slot's element in the commit that follows. The
    // element is handed a volume of nothing in that same commit, so nothing is
    // heard — but a track allowed to run on would reach its own `ended` and
    // advance the queue a second time. A layout effect runs after the child's
    // update and before the browser paints, which is the first moment that
    // `play()` can be undone.
    useLayoutEffect(() => {
        if (!engaged) return;
        const element = mediaElementFor(args.num);
        if (element && !element.paused) element.pause();
    });

    // The deck's clock while the deck is the player: the progress bar, the
    // boundary in front of it, and an element held quiet behind it.
    useEffect(() => {
        if (!engaged) return undefined;

        const tick = () => {
            const state = latest.current;
            const context = state.webAudio?.context;
            const deck = deckRef.current;
            if (!context || !deck) return;

            const outgoing = deck.outgoing();
            const position = deck.positionSec(context.currentTime);
            if (!outgoing || position === null) {
                relinquish({ resume: true, seek: false });
                return;
            }
            setTimestamp(position);

            const element = mediaElementFor(state.num);
            if (element && !element.paused) element.pause();

            const trimmedEnd = state.num === 1 ? state.trim.end1 : state.trim.end2;
            advanceBoundary(
                outgoing,
                outgoingEndSec(trimmedEnd, deck.currentDurationSec() ?? Number.NaN),
            );
        };

        tick();
        const interval = setInterval(tick, TICK_MS);
        return () => clearInterval(interval);
    }, [advanceBoundary, engaged, mediaElementFor, relinquish, setTimestamp]);

    // A hundred megabytes of decoded audio is worth holding for a record that
    // is playing and worth nothing at all for one that is paused. After a
    // minute of pause the record goes back to the element and the buffer is
    // let go: the element is parked at the same position, nothing is sounding
    // while it happens, and pressing play afterwards simply plays. The join
    // after that one is taken the ordinary way, which is inaudible — the cost
    // of this is a boundary somewhere later being approximate rather than
    // exact, and the return is the process not sitting on the memory all
    // evening.
    useEffect(() => {
        if (!engaged) return undefined;

        let idle: ReturnType<typeof setTimeout> | undefined;
        const clear = () => {
            if (idle) clearTimeout(idle);
            idle = undefined;
        };

        const check = (status: PlayerStatus) => {
            if (status === PlayerStatus.PLAYING) {
                clear();
            } else if (!idle) {
                idle = setTimeout(() => relinquish({ resume: false }), IDLE_RELEASE_MS);
            }
        };

        check(usePlayerStoreBase.getState().player.status);
        const unsubscribe = usePlayerStoreBase.subscribe((state) => check(state.player.status));
        return () => {
            unsubscribe();
            clear();
        };
    }, [engaged, relinquish]);

    // A current track that is not the one the deck is playing means the queue
    // moved under it: a skip, a jump, a track dragged to the front.
    const currentId = args.currentSong?._uniqueId;
    useEffect(() => {
        if (!engaged) return;
        if (deckRef.current?.currentId() !== currentId) relinquish({ resume: true });
    }, [currentId, engaged, relinquish]);

    // Repeat One is an element looping on itself, and a blend is the
    // crossfade's to make. Either takes the boundary back.
    const blending = args.mix?.kind === 'blend';
    const repeatingOne = args.repeat === PlayerRepeat.ONE;
    useEffect(() => {
        if ((blending || repeatingOne) && (engagedRef.current || planned.current)) {
            relinquish({ resume: true });
        }
    }, [blending, relinquish, repeatingOne]);

    const fadeOnPause = args.audioFadeOnStatusChange;
    usePlayerEvents(
        {
            onPlayerSeekToTimestamp: () => {
                if (engagedRef.current || planned.current) {
                    relinquish({ resume: true, seek: false });
                }
            },
            onPlayerStatus: (properties) => {
                if (properties.status === PlayerStatus.PLAYING) return;
                if (!engagedRef.current && !planned.current) return;
                relinquish({ fadeSeconds: fadeOnPause ? PAUSE_FADE_SECONDS : 0 });
            },
            onQueueCleared: () => relinquish(),
        },
        [fadeOnPause, relinquish],
    );

    useEffect(() => clearTimers, [clearTimers]);

    return { engaged, onElementEnded, onElementProgress };
};
