import type { WebPlayerEngineHandle } from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import type { QueueSong } from '/@/shared/types/domain-types';

import { RefObject, useCallback, useEffect, useMemo, useRef } from 'react';

import { useSoundBounds } from '/@/renderer/aoide/features/playback/sound-bounds-store';
import { initialTracker, step, TrimAction } from '/@/renderer/aoide/features/playback/trim-tracker';
import { usePlayerStoreBase } from '/@/renderer/store';
import { trimFor } from '/@/shared/aoide/trim-plan';
import { PlayerRepeat } from '/@/shared/types/types';

interface TrimPlayersArgs {
    /**
     * The buffer deck has the boundary in front of it and will advance the
     * queue itself, on the audio clock. Ending the track here as well would
     * advance it twice, which is a track skipped.
     */
    holdEndRef?: RefObject<boolean>;
    /** Which slot is the audible one. Only it may end a track. */
    num: 1 | 2;
    /** The slot's `onEnded` handler, filled in once the player has one; ending a track early runs it. */
    onEnded: RefObject<((slot: 1 | 2) => void) | null>;
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
 * Ending early used to be done by seeking the element to its own end, so
 * that the element's `ended` fired and Feishin's own path ran. That seek is a
 * request for the last bytes of the file, and on a stream the server is
 * transcoding it is a request the server cannot serve: the element raised a
 * network error, the engine's retry paused both players and reloaded the
 * outgoing one from the start, and a listener heard a crossfade complete and
 * then the old song begin again. So the end is now delivered as a call —
 * pause the element and run the same `onEnded` handler the element would
 * have — with nothing asked of the network. Under Repeat One the element is
 * left to loop at its natural end, as before.
 *
 * A seek is only ever from before the sound; the inactive slot, pre-started
 * for a gapless handover, is seeked too, so it is sitting on the first note
 * when it becomes audible.
 */
export const useTrimPlayers = ({
    holdEndRef,
    num,
    onEnded,
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
            // Repeat One is the element looping on itself at its natural end;
            // ending it by hand would skip the loop.
            if (usePlayerStoreBase.getState().player.repeat === PlayerRepeat.ONE) return;
            if (element && !element.paused) element.pause();
            onEnded.current?.(slot);
        },
        [holdEndRef, num, onEnded, playerRef],
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
