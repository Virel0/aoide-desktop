import type { FinishPlayInput, PlaySource } from '/@/main/features/aoide/play-history';
import type { TrackInput } from '/@/main/features/aoide/playlists';
import type { RecentContextKind } from '/@/renderer/aoide/features/home/recent-contexts';

/**
 * When a listen starts, when it ends, and how much of it was heard — decided
 * here, and only reported to the store.
 *
 * The phone's `CurationRecorder` opens a `play_events` row the moment a track
 * starts and closes it when the track ends or is left. Until this existed the
 * desktop wrote no such rows at all: every smart playlist, both built-in mixes
 * and the Replay page saw the phone's listening and nothing of what was played
 * at the desk. This is the desk's half of that contract.
 *
 * **What it does not decide is whether a listen was a play or a skip.** That
 * verdict is `play-definition.ts`, applied in the main process by
 * `PlayHistory.finishPlay`; this module hands over milliseconds and a duration
 * and holds no threshold of its own. Two implementations of that rule have
 * already disagreed once, and the symptom was a play count that contradicted
 * the playlist beside it.
 *
 * Pure, so the transitions can be tested one at a time: every function takes
 * the state and a clock reading and returns the next state alongside the calls
 * the store should receive, in order. The effect that mounts this does nothing
 * but forward events in and calls out. The bugs in a recorder live in the
 * transitions — a pause counted as listening, a restart merged into the play
 * before it, a track begun twice — and none of those can be seen from a
 * running player.
 */

/**
 * A listen in progress. `token` is this module's own handle: the store's event
 * id comes back asynchronously over IPC, and the effect maps one to the other
 * so a finish can wait for the begin it belongs to.
 */
export interface OpenListen {
    /** Position, in seconds, of the last progress sample that was counted or rebased from. */
    lastPositionSec: null | number;
    /** Milliseconds heard so far. Fractional here; the store floors it. */
    msPlayed: number;
    source: PlaySource;
    startedAt: number;
    token: number;
    track: RecorderTrack;
}

/** One call the effect should make, in the order returned. */
export type RecorderCall =
    | { input: FinishPlayInput; kind: 'finish'; token: number }
    | { kind: 'begin'; source: PlaySource; startedAt: number; token: number; track: TrackInput };

export interface RecorderState {
    /** What the player is on, playing or not. Undefined when the queue is empty. */
    current?: RecorderTrack;
    nextToken: number;
    open?: OpenListen;
    playing: boolean;
    /** Where the current queue was started from, as best this module was told. */
    source: PlaySource;
    /**
     * When a context was last announced and not yet claimed by a queue. A page
     * that fetches its songs before queueing them announces first and queues
     * later; this is what lets the later queue take the announcement.
     */
    sourceToldAt?: number;
}

/** The player's status, as the recorder needs it. */
export type RecorderStatus = 'paused' | 'playing' | 'stopped';

export interface RecorderStep {
    calls: RecorderCall[];
    state: RecorderState;
}

/** What the player is on. `uniqueId` is the queue entry, which is what changes. */
export interface RecorderTrack {
    track: TrackInput;
    uniqueId: string;
}

/**
 * Two progress samples further apart than this are not continuous listening.
 * The player reports roughly once a second; a larger gap is a seek, a stall,
 * or the machine having been asleep, and none of those was heard. Feishin's
 * own scrobbler draws the same line at five seconds.
 */
export const MAX_LISTEN_GAP_SEC = 5;

/**
 * Positions before this count as the start of the track. A jump back to here
 * from further in is a restart — Repeat One, or the listener pressing Previous
 * on a track they wanted again — and a restart is a new listen, not the same
 * one grown longer than the track.
 */
export const TRACK_START_SEC = 5;

/** How far in the previous sample must have been for a jump to the start to be a restart. */
export const RESTART_MIN_SEC = 10;

/**
 * A context announced this soon *after* a listen began belongs to that listen.
 * Pages that hold their songs queue first and announce second, in the same
 * handler; the store's subscribers fire in between. Short, so that an
 * announcement cannot reach back to a listen from a different queue.
 */
export const SOURCE_TOLD_AFTER_MS = 1_000;

/**
 * A context announced this soon *before* a queue was replaced is that queue's.
 * The album page announces, then fetches its songs, then queues them; the fetch
 * is a round trip to Jellyfin. Generous, because an announcement that has not
 * been claimed by then is more likely a slow server than a different queue.
 */
export const SOURCE_TOLD_BEFORE_MS = 15_000;

export const initialState = (): RecorderState => ({
    nextToken: 1,
    playing: false,
    source: 'unknown',
});

/**
 * The player moved to another queue entry, or to none.
 *
 * The listen in progress — if any — is finished with what it had, and a new one
 * begins only if the player is actually playing: a queue restored at launch
 * arrives paused, and a listen opened for a track nobody pressed play on would
 * be a zero-millisecond skip of it.
 */
export const onTrackChanged = (
    state: RecorderState,
    track: RecorderTrack | undefined,
    now: number,
): RecorderStep => {
    if (track?.uniqueId === state.current?.uniqueId) return { calls: [], state };

    const finished = finishOpen(state, now);
    let next: RecorderState = { ...finished.state, current: track };
    const calls = finished.calls;

    if (track && next.playing) {
        const begun = beginListen(next, track, now);
        next = begun.state;
        calls.push(...begun.calls);
    }

    return { calls, state: next };
};

/**
 * Play, pause or stop.
 *
 * Playing opens a listen for the current track when none is open. A pause
 * changes nothing here — the ticks stop counting on their own — because a
 * pause is not the end of a listen. A stop is: pressing Stop, or the queue
 * being cleared, closes the listen, and pressing Play again on the same track
 * opens a new one.
 */
export const onStatusChanged = (
    state: RecorderState,
    status: RecorderStatus,
    now: number,
): RecorderStep => {
    const playing = status === 'playing';
    let next: RecorderState = { ...state, playing };
    const calls: RecorderCall[] = [];

    if (status === 'stopped') {
        const finished = finishOpen(next, now);
        next = finished.state;
        calls.push(...finished.calls);
    } else if (playing && next.current && !next.open) {
        const begun = beginListen(next, next.current, now);
        next = begun.state;
        calls.push(...begun.calls);
    }

    return { calls, state: next };
};

/**
 * A progress sample from the player's own clock: the position in seconds, and
 * whether it was playing when the sample was taken.
 *
 * Listening is the sum of small forward steps between consecutive samples while
 * playing, which is exactly how Feishin's scrobbler measures it. A step that is
 * backwards, or longer than `MAX_LISTEN_GAP_SEC`, is a seek or a stall and
 * counts nothing — the next sample is measured from where it landed. A sample
 * taken while paused counts nothing either, but still moves the baseline, so a
 * seek made while paused is not later counted as listening.
 *
 * A jump back to the start of the track from well inside it is a restart, and
 * a restart finishes the listen and begins another. Without this, Repeat One
 * would record one listen whose `msPlayed` grew past the track's duration —
 * one play, however many times the track went round.
 */
export const onTick = (
    state: RecorderState,
    sample: { playing: boolean; positionSec: number },
    now: number,
): RecorderStep => {
    const { playing, positionSec } = sample;

    if (!state.open) {
        // A tick while playing with nothing open: the status change that should
        // have opened the listen was missed, or the player was already playing
        // when this mounted. Begin now rather than record nothing all track.
        if (playing && state.current) {
            const begun = beginListen({ ...state, playing: true }, state.current, now);
            return {
                calls: begun.calls,
                state: withOpen(begun.state, { lastPositionSec: positionSec }),
            };
        }
        return { calls: [], state };
    }

    const open = state.open;

    if (!playing) {
        return { calls: [], state: withOpen(state, { lastPositionSec: positionSec }) };
    }

    const last = open.lastPositionSec;

    if (last !== null && positionSec < TRACK_START_SEC && last >= RESTART_MIN_SEC) {
        const finished = finishOpen(state, now);
        const begun = beginListen(finished.state, open.track, now);
        return {
            calls: [...finished.calls, ...begun.calls],
            state: withOpen(begun.state, { lastPositionSec: positionSec }),
        };
    }

    if (last === null) {
        return { calls: [], state: withOpen(state, { lastPositionSec: positionSec }) };
    }

    const deltaSec = positionSec - last;
    const heard = deltaSec > 0 && deltaSec <= MAX_LISTEN_GAP_SEC ? deltaSec * 1000 : 0;

    return {
        calls: [],
        state: withOpen(state, {
            lastPositionSec: positionSec,
            msPlayed: open.msPlayed + heard,
        }),
    };
};

/**
 * The window is going away, or the recorder is being unmounted. Finishes the
 * listen in progress with whatever it has; nothing else changes, because
 * nothing else is going to happen.
 */
export const onStop = (state: RecorderState, now: number): RecorderStep => finishOpen(state, now);

/**
 * Playback was started from a page that knows what it is: an album, a
 * playlist of either kind, a mix. Recorded by the same one-line calls that
 * feed the resume grid, so no page had to learn a second thing.
 *
 * Applies to the listen that has *just* begun, if one has — that is the page
 * that queues first and announces second — and otherwise waits for the queue
 * that is about to be replaced. Either way it is claimed once: an announcement
 * that stayed armed would name the next unrelated queue after it.
 */
export const onContextStarted = (
    state: RecorderState,
    context: { kind: RecentContextKind; smart?: boolean },
    now: number,
): RecorderStep => {
    const source = sourceOf(context);
    const open = state.open;

    if (open && now - open.startedAt <= SOURCE_TOLD_AFTER_MS) {
        return {
            calls: [],
            state: { ...withOpen(state, { source }), source, sourceToldAt: undefined },
        };
    }

    return { calls: [], state: { ...state, source, sourceToldAt: now } };
};

/**
 * The queue was replaced wholesale, rather than added to.
 *
 * Whatever the last queue was started from, this one was not — unless a page
 * announced itself within `SOURCE_TOLD_BEFORE_MS` and has not been claimed,
 * in which case this is the queue it was announcing. A listen that began in
 * the same instant (the track change fires before the queue change) takes the
 * same answer, so a stale source cannot ride into the new queue's first track.
 */
export const onQueueReplaced = (state: RecorderState, now: number): RecorderStep => {
    const told =
        state.sourceToldAt !== undefined && now - state.sourceToldAt <= SOURCE_TOLD_BEFORE_MS;
    const source: PlaySource = told ? state.source : 'unknown';
    const open = state.open;

    const next: RecorderState =
        open && now - open.startedAt <= SOURCE_TOLD_AFTER_MS ? withOpen(state, { source }) : state;

    return { calls: [], state: { ...next, source, sourceToldAt: undefined } };
};

/**
 * Whether a queue change was a replacement rather than an append or an
 * insertion. Adding tracks — next or last — keeps the first entry where it was;
 * starting something new does not. Emptying the queue is a replacement too,
 * and so is filling an empty one.
 */
export const queueWasReplaced = (previous: readonly string[], next: readonly string[]): boolean =>
    previous[0] !== next[0];

/**
 * The phone's `source` for a context kind. A station has no name in that list,
 * so it stays `unknown` rather than borrowing a wrong one.
 */
export const sourceOf = (context: { kind: RecentContextKind; smart?: boolean }): PlaySource => {
    switch (context.kind) {
        case 'album':
            return 'album';
        case 'aoidePlaylist':
            return context.smart ? 'smart' : 'playlist';
        case 'jellyfinPlaylist':
            return 'playlist';
        case 'mix':
            return 'smart';
        case 'station':
            return 'unknown';
    }
};

const beginListen = (state: RecorderState, track: RecorderTrack, now: number): RecorderStep => {
    const token = state.nextToken;
    const open: OpenListen = {
        lastPositionSec: null,
        msPlayed: 0,
        source: state.source,
        startedAt: now,
        token,
        track,
    };

    return {
        calls: [{ kind: 'begin', source: state.source, startedAt: now, token, track: track.track }],
        state: { ...state, nextToken: token + 1, open },
    };
};

const finishOpen = (state: RecorderState, now: number): RecorderStep => {
    const open = state.open;
    if (!open) return { calls: [], state };

    return {
        calls: [
            {
                input: {
                    durationMs: open.track.track.durationMs ?? null,
                    endedAt: now,
                    msPlayed: Math.floor(open.msPlayed),
                    source: open.source,
                },
                kind: 'finish',
                token: open.token,
            },
        ],
        state: { ...state, open: undefined },
    };
};

const withOpen = (state: RecorderState, patch: Partial<OpenListen>): RecorderState =>
    state.open ? { ...state, open: { ...state.open, ...patch } } : state;
