import { describe, expect, it } from 'vitest';

import {
    initialState,
    MAX_LISTEN_GAP_SEC,
    onContextStarted,
    onQueueReplaced,
    onStatusChanged,
    onStop,
    onTick,
    onTrackChanged,
    queueWasReplaced,
    RecorderCall,
    RecorderState,
    RecorderTrack,
    RESTART_MIN_SEC,
    SOURCE_TOLD_AFTER_MS,
    SOURCE_TOLD_BEFORE_MS,
    sourceOf,
    TRACK_START_SEC,
} from './play-recorder';

/**
 * Every transition, one at a time. The recorder cannot be watched in a
 * running player — a pause counted as listening or a restart folded into the
 * play before it shows up weeks later as a Replay page that is slightly wrong
 * about you — so each rule is pinned here, on its own, with the clock in hand.
 */

const t0 = 1_700_000_000_000;

const song = (uniqueId: string, durationMs: null | number = 200_000): RecorderTrack => ({
    track: {
        album: 'An Album',
        artist: 'An Artist',
        durationMs,
        jellyfinId: `jf-${uniqueId}`,
        title: uniqueId,
    },
    uniqueId,
});

/** A recorder that is already playing `track`, with the begin call consumed. */
const playing = (track: RecorderTrack = song('a'), at = t0) => {
    const state = onStatusChanged(initialState(), 'playing', at).state;
    const step = onTrackChanged(state, track, at);
    expect(step.calls.map((call) => call.kind)).toEqual(['begin']);
    return step.state;
};

const kinds = (calls: RecorderCall[]) => calls.map((call) => call.kind);

const finishOf = (calls: RecorderCall[]) => {
    const finish = calls.find((call) => call.kind === 'finish');
    if (!finish || finish.kind !== 'finish') throw new Error('no finish call');
    return finish;
};

const beginOf = (calls: RecorderCall[]) => {
    const begin = calls.find((call) => call.kind === 'begin');
    if (!begin || begin.kind !== 'begin') throw new Error('no begin call');
    return begin;
};

/** Ticks once a second from `fromSec` for `seconds` seconds, playing. */
const listen = (state: RecorderState, fromSec: number, seconds: number, at = t0) => {
    let next = state;
    for (let second = 0; second <= seconds; second += 1) {
        next = onTick(
            next,
            { playing: true, positionSec: fromSec + second },
            at + (fromSec + second) * 1000,
        ).state;
    }
    return next;
};

describe('starting', () => {
    it('does nothing until something plays', () => {
        expect(initialState().open).toBeUndefined();
        const step = onStatusChanged(initialState(), 'playing', t0);
        expect(step.calls).toEqual([]);
    });

    // A queue restored at launch arrives paused. Opening a listen for a track
    // nobody pressed play on would file a zero-millisecond skip of it.
    it('does not open a listen for a track that arrives paused', () => {
        const step = onTrackChanged(initialState(), song('a'), t0);
        expect(step.calls).toEqual([]);
        expect(step.state.current?.uniqueId).toBe('a');
        expect(step.state.open).toBeUndefined();
    });

    it('opens it when play is pressed', () => {
        const paused = onTrackChanged(initialState(), song('a'), t0).state;
        const step = onStatusChanged(paused, 'playing', t0 + 5_000);

        expect(step.calls).toEqual([
            {
                kind: 'begin',
                source: 'unknown',
                startedAt: t0 + 5_000,
                token: 1,
                track: song('a').track,
            },
        ]);
        expect(step.state.open).toMatchObject({ msPlayed: 0, startedAt: t0 + 5_000, token: 1 });
    });

    it('opens it at once when the track changes while playing', () => {
        const state = playing();
        expect(state.open?.token).toBe(1);
    });

    it('is not fooled by the same entry being reported twice', () => {
        const state = playing();
        expect(onTrackChanged(state, song('a'), t0 + 1).calls).toEqual([]);
    });

    // The status event can be missed: the player was already playing when the
    // recorder mounted, or the two stores notified in the other order.
    it('recovers from a missed status change on the first tick', () => {
        const paused = onTrackChanged(initialState(), song('a'), t0).state;
        const step = onTick(paused, { playing: true, positionSec: 3 }, t0 + 3_000);

        expect(kinds(step.calls)).toEqual(['begin']);
        expect(step.state.playing).toBe(true);
        expect(step.state.open?.lastPositionSec).toBe(3);
    });

    it('does not begin on a tick while paused', () => {
        const paused = onTrackChanged(initialState(), song('a'), t0).state;
        expect(onTick(paused, { playing: false, positionSec: 3 }, t0).calls).toEqual([]);
    });

    it('does not begin on a tick with no track', () => {
        expect(onTick(initialState(), { playing: true, positionSec: 3 }, t0).calls).toEqual([]);
    });
});

describe('moving on', () => {
    it('finishes the previous listen before beginning the next, on the same clock reading', () => {
        const state = listen(playing(), 0, 30);
        const step = onTrackChanged(state, song('b'), t0 + 31_000);

        expect(kinds(step.calls)).toEqual(['finish', 'begin']);
        expect(finishOf(step.calls)).toEqual({
            input: {
                durationMs: 200_000,
                endedAt: t0 + 31_000,
                msPlayed: 30_000,
                source: 'unknown',
            },
            kind: 'finish',
            token: 1,
        });
        expect(beginOf(step.calls)).toMatchObject({ startedAt: t0 + 31_000, token: 2 });
        expect(step.state.open?.token).toBe(2);
    });

    it('finishes without beginning when the queue empties', () => {
        const step = onTrackChanged(playing(), undefined, t0 + 1_000);
        expect(kinds(step.calls)).toEqual(['finish']);
        expect(step.state.current).toBeUndefined();
        expect(step.state.open).toBeUndefined();
    });

    it('hands over the duration the player had, including none', () => {
        const state = playing(song('a', null));
        const step = onTrackChanged(state, song('b'), t0 + 1_000);
        expect(finishOf(step.calls).input.durationMs).toBeNull();
    });

    it('never hands over a fractional millisecond', () => {
        let state = playing();
        state = onTick(state, { playing: true, positionSec: 0 }, t0).state;
        state = onTick(state, { playing: true, positionSec: 1.2345 }, t0).state;
        const step = onTrackChanged(state, song('b'), t0 + 2_000);
        expect(finishOf(step.calls).input.msPlayed).toBe(1234);
    });
});

describe('measuring', () => {
    it('counts the steps between consecutive samples while playing', () => {
        const state = listen(playing(), 0, 10);
        expect(state.open?.msPlayed).toBe(10_000);
    });

    it('counts nothing on the first sample, which has nothing to step from', () => {
        const step = onTick(playing(), { playing: true, positionSec: 42 }, t0);
        expect(step.state.open?.msPlayed).toBe(0);
        expect(step.state.open?.lastPositionSec).toBe(42);
    });

    it('counts nothing while paused, but moves the baseline', () => {
        let state = listen(playing(), 0, 5);
        state = onStatusChanged(state, 'paused', t0 + 6_000).state;
        // Nudged a second at a time while paused — arrow keys on the seek bar.
        // Each step is small enough to look like listening, and is not.
        state = onTick(state, { playing: false, positionSec: 6 }, t0 + 7_000).state;
        state = onTick(state, { playing: false, positionSec: 7 }, t0 + 8_000).state;
        expect(state.open?.msPlayed).toBe(5_000);
        // A seek made while paused lands here; it must not be counted later.
        state = onTick(state, { playing: false, positionSec: 100 }, t0 + 7_000).state;
        expect(state.open?.msPlayed).toBe(5_000);
        expect(state.open?.lastPositionSec).toBe(100);

        state = onStatusChanged(state, 'playing', t0 + 8_000).state;
        state = onTick(state, { playing: true, positionSec: 101 }, t0 + 9_000).state;
        expect(state.open?.msPlayed).toBe(6_000);
    });

    it('keeps the same listen open across a pause', () => {
        let state = listen(playing(), 0, 5);
        const pause = onStatusChanged(state, 'paused', t0 + 6_000);
        expect(pause.calls).toEqual([]);
        state = pause.state;
        const resume = onStatusChanged(state, 'playing', t0 + 9_000);
        expect(resume.calls).toEqual([]);
        expect(resume.state.open?.token).toBe(1);
    });

    it('does not count a forward seek as listening', () => {
        let state = listen(playing(), 0, 5);
        state = onTick(
            state,
            { playing: true, positionSec: 5 + MAX_LISTEN_GAP_SEC + 1 },
            t0 + 6_000,
        ).state;
        expect(state.open?.msPlayed).toBe(5_000);
        // ...but measures from where it landed.
        state = onTick(
            state,
            { playing: true, positionSec: 5 + MAX_LISTEN_GAP_SEC + 2 },
            t0 + 7_000,
        ).state;
        expect(state.open?.msPlayed).toBe(6_000);
    });

    it('counts a step exactly at the gap, and not one beyond it', () => {
        let state = onTick(playing(), { playing: true, positionSec: 10 }, t0).state;
        state = onTick(state, { playing: true, positionSec: 10 + MAX_LISTEN_GAP_SEC }, t0).state;
        expect(state.open?.msPlayed).toBe(MAX_LISTEN_GAP_SEC * 1000);
        state = onTick(
            state,
            { playing: true, positionSec: 10 + 2 * MAX_LISTEN_GAP_SEC + 0.001 },
            t0,
        ).state;
        expect(state.open?.msPlayed).toBe(MAX_LISTEN_GAP_SEC * 1000);
    });

    it('does not count a seek backwards, short of the start', () => {
        let state = listen(playing(), 0, 60);
        state = onTick(state, { playing: true, positionSec: 30 }, t0 + 61_000).state;
        expect(state.open?.msPlayed).toBe(60_000);
        expect(state.open?.token).toBe(1);
        state = onTick(state, { playing: true, positionSec: 31 }, t0 + 62_000).state;
        expect(state.open?.msPlayed).toBe(61_000);
    });

    it('does not count a sample that did not move', () => {
        let state = listen(playing(), 0, 3);
        state = onTick(state, { playing: true, positionSec: 3 }, t0 + 4_000).state;
        expect(state.open?.msPlayed).toBe(3_000);
    });
});

describe('going round again', () => {
    // Repeat One, or Previous pressed on a track wanted again. One listen that
    // grows past the track's duration would be one play however many times
    // the track went round.
    it('treats a jump back to the start as a new listen', () => {
        const state = listen(playing(), 0, RESTART_MIN_SEC);
        const step = onTick(
            state,
            { playing: true, positionSec: TRACK_START_SEC - 1 },
            t0 + 12_000,
        );

        expect(kinds(step.calls)).toEqual(['finish', 'begin']);
        expect(finishOf(step.calls).input).toMatchObject({
            endedAt: t0 + 12_000,
            msPlayed: RESTART_MIN_SEC * 1000,
        });
        expect(beginOf(step.calls)).toMatchObject({
            startedAt: t0 + 12_000,
            token: 2,
            track: song('a').track,
        });
        expect(step.state.open).toMatchObject({
            lastPositionSec: TRACK_START_SEC - 1,
            msPlayed: 0,
            token: 2,
        });
    });

    it('does not restart from just inside the intro', () => {
        const state = listen(playing(), 0, RESTART_MIN_SEC - 1);
        const step = onTick(state, { playing: true, positionSec: 0 }, t0 + 11_000);
        expect(step.calls).toEqual([]);
        expect(step.state.open?.token).toBe(1);
    });

    it('does not restart on a jump that lands past the start', () => {
        const state = listen(playing(), 0, 60);
        const step = onTick(state, { playing: true, positionSec: TRACK_START_SEC }, t0 + 61_000);
        expect(step.calls).toEqual([]);
    });

    it('does not restart while paused', () => {
        const state = listen(playing(), 0, 60);
        const step = onTick(state, { playing: false, positionSec: 0 }, t0 + 61_000);
        expect(step.calls).toEqual([]);
        expect(step.state.open?.lastPositionSec).toBe(0);
    });
});

describe('stopping', () => {
    it('finishes on stop and begins again on play', () => {
        const state = listen(playing(), 0, 20);
        const stop = onStatusChanged(state, 'stopped', t0 + 21_000);

        expect(kinds(stop.calls)).toEqual(['finish']);
        expect(finishOf(stop.calls).input.msPlayed).toBe(20_000);
        expect(stop.state.open).toBeUndefined();
        expect(stop.state.playing).toBe(false);
        expect(stop.state.current?.uniqueId).toBe('a');

        const play = onStatusChanged(stop.state, 'playing', t0 + 30_000);
        expect(kinds(play.calls)).toEqual(['begin']);
        expect(beginOf(play.calls)).toMatchObject({ startedAt: t0 + 30_000, token: 2 });
    });

    it('stop with nothing open changes nothing', () => {
        const step = onStatusChanged(initialState(), 'stopped', t0);
        expect(step.calls).toEqual([]);
    });

    it('finishes on the way out, once', () => {
        const state = listen(playing(), 0, 20);
        const out = onStop(state, t0 + 21_000);
        expect(kinds(out.calls)).toEqual(['finish']);
        expect(finishOf(out.calls).input).toEqual({
            durationMs: 200_000,
            endedAt: t0 + 21_000,
            msPlayed: 20_000,
            source: 'unknown',
        });
        expect(onStop(out.state, t0 + 22_000).calls).toEqual([]);
    });
});

describe('where the listen came from', () => {
    it('is unknown until a page says otherwise', () => {
        expect(
            beginOf(
                onStatusChanged(onTrackChanged(initialState(), song('a'), t0).state, 'playing', t0)
                    .calls,
            ).source,
        ).toBe('unknown');
    });

    // The page that holds its songs queues first and announces second, in the
    // same handler. The store's subscribers fire in between, so the listen has
    // already begun with the previous queue's answer.
    it('a context told just after a listen began names that listen, at the finish', () => {
        let state = playing();
        state = onContextStarted(state, { kind: 'aoidePlaylist' }, t0 + SOURCE_TOLD_AFTER_MS).state;
        expect(state.open?.source).toBe('playlist');
        expect(state.source).toBe('playlist');

        const step = onTrackChanged(state, song('b'), t0 + 60_000);
        expect(finishOf(step.calls).input.source).toBe('playlist');
        // The queue's source carries to its later tracks.
        expect(beginOf(step.calls).source).toBe('playlist');
    });

    it('a context told later than that does not reach back', () => {
        let state = playing();
        state = onContextStarted(
            state,
            { kind: 'aoidePlaylist' },
            t0 + SOURCE_TOLD_AFTER_MS + 1,
        ).state;
        expect(state.open?.source).toBe('unknown');
        expect(state.source).toBe('playlist');
    });

    // The album page announces, fetches its songs, then queues them.
    it('a context told before the queue was replaced is that queue’s', () => {
        let state = onContextStarted(initialState(), { kind: 'album' }, t0).state;
        state = onStatusChanged(state, 'playing', t0 + 3_000).state;
        const first = onTrackChanged(state, song('a'), t0 + 3_000);
        expect(beginOf(first.calls).source).toBe('album');

        state = onQueueReplaced(first.state, t0 + 3_000).state;
        expect(state.open?.source).toBe('album');
        expect(state.source).toBe('album');
    });

    it('a context told too long before is not', () => {
        let state = onContextStarted(initialState(), { kind: 'album' }, t0).state;
        state = onStatusChanged(state, 'playing', t0).state;
        const later = t0 + SOURCE_TOLD_BEFORE_MS + 1;
        const first = onTrackChanged(state, song('a'), later);
        state = onQueueReplaced(first.state, later).state;

        expect(state.open?.source).toBe('unknown');
        expect(state.source).toBe('unknown');
    });

    it('an announcement is claimed once', () => {
        let state = onContextStarted(initialState(), { kind: 'album' }, t0).state;
        state = onQueueReplaced(state, t0 + 1_000).state;
        expect(state.source).toBe('album');
        state = onQueueReplaced(state, t0 + 2_000).state;
        expect(state.source).toBe('unknown');
    });

    it('an announcement that named a listen is not also held for the next queue', () => {
        let state = playing();
        state = onContextStarted(state, { kind: 'mix' }, t0 + 10).state;
        expect(state.sourceToldAt).toBeUndefined();
        state = onQueueReplaced(state, t0 + 5_000).state;
        expect(state.source).toBe('unknown');
    });

    // The track change fires before the queue change, so the first track of
    // a new queue begins with the old queue's answer. The replacement corrects
    // it in the same instant.
    it('replacing the queue resets a stale source, on the listen that just began too', () => {
        let state = playing();
        state = onContextStarted(state, { kind: 'jellyfinPlaylist' }, t0 + 10).state;
        expect(state.source).toBe('playlist');

        const change = onTrackChanged(state, song('b'), t0 + 60_000);
        expect(beginOf(change.calls).source).toBe('playlist');
        state = onQueueReplaced(change.state, t0 + 60_000).state;
        expect(state.open?.source).toBe('unknown');
        expect(state.source).toBe('unknown');

        const end = onTrackChanged(state, song('c'), t0 + 120_000);
        expect(finishOf(end.calls).input.source).toBe('unknown');
    });

    it('replacing the queue does not touch a listen well under way', () => {
        let state = playing();
        state = onContextStarted(state, { kind: 'mix' }, t0 + 10).state;
        state = onQueueReplaced(state, t0 + SOURCE_TOLD_AFTER_MS + 1).state;
        expect(state.open?.source).toBe('smart');
        expect(state.source).toBe('unknown');
    });

    it('maps each kind to the phone’s name for it', () => {
        expect(sourceOf({ kind: 'album' })).toBe('album');
        expect(sourceOf({ kind: 'aoidePlaylist' })).toBe('playlist');
        expect(sourceOf({ kind: 'aoidePlaylist', smart: true })).toBe('smart');
        expect(sourceOf({ kind: 'jellyfinPlaylist' })).toBe('playlist');
        expect(sourceOf({ kind: 'mix' })).toBe('smart');
        expect(sourceOf({ kind: 'station' })).toBe('unknown');
    });
});

describe('telling a replaced queue from an added-to one', () => {
    it('is a replacement when the first entry changes', () => {
        expect(queueWasReplaced(['a', 'b'], ['c', 'd'])).toBe(true);
    });

    it('is not when tracks were added next or last', () => {
        expect(queueWasReplaced(['a', 'b'], ['a', 'x', 'b'])).toBe(false);
        expect(queueWasReplaced(['a', 'b'], ['a', 'b', 'x'])).toBe(false);
    });

    it('is when an empty queue is filled, or a full one emptied', () => {
        expect(queueWasReplaced([], ['a'])).toBe(true);
        expect(queueWasReplaced(['a'], [])).toBe(true);
    });

    it('is not when nothing changed', () => {
        expect(queueWasReplaced(['a'], ['a'])).toBe(false);
        expect(queueWasReplaced([], [])).toBe(false);
    });
});
