import { useCallback, useEffect, useRef } from 'react';

import type { RecorderCall, RecorderStep } from './play-recorder';

import {
    initialState,
    onContextStarted,
    onQueueReplaced,
    onStatusChanged,
    onStop,
    onTick,
    onTrackChanged,
    queueWasReplaced,
} from './play-recorder';

import { useRecentContextsStore } from '/@/renderer/aoide/features/home/use-recent-contexts';
import { trackInputFromSong } from '/@/renderer/aoide/features/playlists/track-input';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayerStore } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { PlayerStatus } from '/@/shared/types/types';

/**
 * Records what is played at this desk as `play_events`, the way the phone
 * records what is played in a pocket.
 *
 * Renders nothing. Every rule is in `play-recorder.ts`; this forwards the
 * player's events in — Feishin's own `usePlayerEvents`, the same progress
 * samples its scrobbler measures listening from — and the recorder's calls out
 * over the bridge. The one piece of state kept here is the map from the
 * recorder's tokens to the event ids the store handed back, so a finish can
 * wait for the begin it belongs to.
 *
 * The window going away finishes the listen in progress with what it has. That
 * is best effort — `invoke` is sent before the page is torn down, and the reply
 * is not waited for — and the open row is the fallback: `play-definition`'s SQL
 * counts an event with no `endedAt` as neither a play nor a skip, so a listen
 * cut short by a crash records that the track was on and nothing it cannot know.
 */
export const AoidePlayRecorderEffect = () => (isAoideAvailable() ? <Recorder /> : null);

const Recorder = () => {
    const state = useRef(initialState());
    const eventIds = useRef(new Map<number, Promise<string | undefined>>());

    const perform = useCallback((call: RecorderCall) => {
        const { history } = window.api.aoide;

        if (call.kind === 'begin') {
            eventIds.current.set(
                call.token,
                history.beginPlay(call.track, call.source, call.startedAt).catch((error) => {
                    logger.warn('Aoide could not open a play event', { error });
                    return undefined;
                }),
            );
            return;
        }

        const pending = eventIds.current.get(call.token);
        eventIds.current.delete(call.token);
        if (!pending) return;

        void pending.then((eventId) => {
            if (!eventId) return;
            return history.finishPlay(eventId, call.input).then(
                () => undefined,
                (error) => logger.warn('Aoide could not finish a play event', { error }),
            );
        });
    }, []);

    const apply = useCallback(
        (step: RecorderStep) => {
            state.current = step.state;
            for (const call of step.calls) perform(call);
        },
        [perform],
    );

    usePlayerEvents(
        {
            onCurrentSongChange: ({ song }) => {
                apply(
                    onTrackChanged(
                        state.current,
                        song
                            ? { track: trackInputFromSong(song), uniqueId: song._uniqueId }
                            : undefined,
                        Date.now(),
                    ),
                );
            },
            onPlayerProgress: ({ timestamp }) => {
                // The status at the moment of the sample, read the way the
                // scrobbler reads it, so a sample that arrives between a pause
                // and its status event is not counted as listening.
                const playing = usePlayerStore.getState().player.status === PlayerStatus.PLAYING;
                apply(onTick(state.current, { playing, positionSec: timestamp }, Date.now()));
            },
            onPlayerQueueChange: (queue, previous) => {
                if (!queueWasReplaced(previous.default, queue.default)) return;
                apply(onQueueReplaced(state.current, Date.now()));
            },
            onPlayerStatus: ({ status }) => {
                apply(onStatusChanged(state.current, recorderStatus(status), Date.now()));
            },
        },
        [apply],
    );

    useEffect(() => {
        // A page announcing what it started playback from — the same one-line
        // calls that feed the resume grid. The newest entry of whichever server
        // changed is the one just announced.
        const unsubscribe = useRecentContextsStore.subscribe((next, previous) => {
            for (const [serverId, contexts] of Object.entries(next.byServer)) {
                if (contexts === previous.byServer[serverId]) continue;
                const newest = contexts[0];
                if (!newest) continue;
                apply(
                    onContextStarted(
                        state.current,
                        { kind: newest.kind, smart: newest.smart },
                        Date.now(),
                    ),
                );
            }
        });

        const finish = () => apply(onStop(state.current, Date.now()));
        window.addEventListener('beforeunload', finish);

        return () => {
            unsubscribe();
            window.removeEventListener('beforeunload', finish);
            finish();
        };
    }, [apply]);

    return null;
};

const recorderStatus = (status: PlayerStatus): 'paused' | 'playing' | 'stopped' => {
    switch (status) {
        case PlayerStatus.PLAYING:
            return 'playing';
        case PlayerStatus.STOPPED:
            return 'stopped';
        default:
            return 'paused';
    }
};
