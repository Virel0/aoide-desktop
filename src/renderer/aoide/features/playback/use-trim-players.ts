import type { WebPlayerEngineHandle } from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import type { QueueSong } from '/@/shared/types/domain-types';

import { RefObject, useCallback, useEffect, useMemo, useRef } from 'react';

import { useSoundBounds } from '/@/renderer/aoide/features/playback/sound-bounds-store';
import { initialTracker, step, TrimAction } from '/@/renderer/aoide/features/playback/trim-tracker';
import { trimFor } from '/@/shared/aoide/trim-plan';

interface TrimPlayersArgs {
    /**
     * The buffer deck has the boundary in front of it and will advance the
     * queue itself, on the audio clock. Ending the track here as well would
     * advance it twice, which is a track skipped.
     */
    holdEndRef?: RefObject<boolean>;
    /** Which slot is the audible one. Only it may end a track. */
    num: 1 | 2;
    player1: QueueSong | undefined;
    player2: QueueSong | undefined;
    playerRef: RefObject<null | WebPlayerEngineHandle>;
}

/**
 * Silence trimming for Feishin's web player, which is two `<audio>` slots.
 *
 * Each slot gets a tracker over its song's plan. The web player calls the
 * slot's `onProgress` from its own progress callback — the same samples it
 * scrobbles and crossfades from — and this seeks past a lead-in or ends the
 * track early, once each, as `trim-tracker.ts` decides.
 *
 * Ending early is done by seeking the element to its own end. That fires the
 * element's `ended`, which is the event Feishin's `onEnded` is wired to, so
 * the same path runs — `mediaAutoNext`, the pause, the volume, the
 * transition flag — with nothing of it restated here. Under Repeat One the
 * element loops instead, exactly as it does at the natural end, and the
 * tracker sees the restart and seeks past the lead-in again. An element
 * whose duration is not known (some transcoded streams) cannot be ended this
 * way and plays to its own end.
 *
 * A seek is only ever from before the sound; the inactive slot, pre-started
 * for a gapless handover, is seeked too, so it is sitting on the first note
 * when it becomes audible.
 */
export const useTrimPlayers = ({
    holdEndRef,
    num,
    player1,
    player2,
    playerRef,
}: TrimPlayersArgs) => {
    const bounds1 = useSoundBounds(player1?.id);
    const bounds2 = useSoundBounds(player2?.id);

    const plan1 = useMemo(() => trimFor(bounds1, player1?.duration), [bounds1, player1?.duration]);
    const plan2 = useMemo(() => trimFor(bounds2, player2?.duration), [bounds2, player2?.duration]);

    const tracker1 = useRef(initialTracker());
    const tracker2 = useRef(initialTracker());

    // A new song in a slot is a new run: the seek and the end are owed again.
    const song1 = player1?._uniqueId;
    const song2 = player2?._uniqueId;
    useEffect(() => {
        tracker1.current = initialTracker();
    }, [song1]);
    useEffect(() => {
        tracker2.current = initialTracker();
    }, [song2]);

    const act = useCallback(
        (slot: 1 | 2, action: TrimAction) => {
            const player = slot === 1 ? playerRef.current?.player1() : playerRef.current?.player2();
            const ref = player?.ref;
            if (!action || !ref) return;

            if (action.kind === 'seek') {
                ref.seekTo(action.toSec, 'seconds');
                return;
            }

            if (slot !== num || holdEndRef?.current) return;
            const element = ref.getInternalPlayer() as HTMLMediaElement | null | undefined;
            if (element && Number.isFinite(element.duration)) {
                element.currentTime = element.duration;
            }
        },
        [holdEndRef, num, playerRef],
    );

    const onProgress1 = useCallback(
        (playedSeconds: number) => {
            const result = step(tracker1.current, plan1, playedSeconds);
            tracker1.current = result.state;
            act(1, result.action);
        },
        [act, plan1],
    );

    const onProgress2 = useCallback(
        (playedSeconds: number) => {
            const result = step(tracker2.current, plan2, playedSeconds);
            tracker2.current = result.state;
            act(2, result.action);
        },
        [act, plan2],
    );

    // Where each slot's sound actually is, for whoever has to line something up
    // with either end of it. A null end is a track that plays to its own end,
    // which is every track with trimming switched off — the caller then has the
    // element's own duration and nothing to correct. A start of zero is a track
    // with nothing to skip, so a caller can use it unconditionally.
    return {
        end1: plan1?.endSec ?? null,
        end2: plan2?.endSec ?? null,
        onProgress1,
        onProgress2,
        start1: plan1?.startSec ?? 0,
        start2: plan2?.startSec ?? 0,
    };
};
