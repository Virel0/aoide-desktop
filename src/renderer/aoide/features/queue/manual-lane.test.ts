import { describe, expect, it } from 'vitest';

import {
    currentIndexInOrder,
    laneAfterCurrent,
    laneEnd,
    laneItems,
    laneLength,
    playbackOrderKeepingLane,
    playLast,
    playNext,
    QueueOrder,
    queueSections,
    sectionHeaderRowsBefore,
    shuffleAfterLane,
} from './manual-lane';

/**
 * The phone's "The manual lane" suite, ported case for case, because the two
 * apps are supposed to behave identically and the only way to know they do is
 * to ask them the same questions.
 *
 * The store holds `queue.default` and `queue.shuffled`; these tests hold the
 * same two arrays. Manual entries are named `q*` here and the predicate says
 * so, which is exactly what the store's predicate does by reading `_manual`
 * off the entry.
 */
const manual = (id: string) => id.startsWith('q');

const queue = (order: string[], shuffled: number[] = []): QueueOrder => ({ order, shuffled });

/** A shuffle that reverses, so a test can say what "shuffled" looks like. */
const reverse = <T>(items: T[]): T[] => [...items].reverse();

describe('the lane', () => {
    it('is the run of manual entries immediately after the current track', () => {
        const order = ['a1', 'q1', 'q2', 'a2', 'q3'];
        expect(laneItems(order, 0, manual)).toEqual(['q1', 'q2']);
        // `q3` is manual and still ahead, but the album track breaks the run.
        expect(laneLength(order, 0, manual)).toBe(2);
    });

    it('empties itself as its tracks play, with nothing having to tidy up', () => {
        const order = ['a1', 'q1', 'q2', 'a2'];
        expect(laneItems(order, 0, manual)).toEqual(['q1', 'q2']);
        // Only the one still ahead of the playhead.
        expect(laneItems(order, 1, manual)).toEqual(['q2']);
        expect(laneItems(order, 2, manual)).toEqual([]);
    });

    it('is empty for a context, so nothing is mistaken for a choice', () => {
        expect(laneItems(['a1', 'a2', 'a3'], 0, manual)).toEqual([]);
    });

    it('is empty when nothing is playing', () => {
        expect(laneItems(['q1', 'q2'], -1, manual)).toEqual([]);
    });
});

describe('Play Last', () => {
    it('lands after the current track, not at the end of the album', () => {
        const next = playLast(queue(['a1', 'a2', 'a3', 'a4']), ['wanted'], 0, manual);
        // The whole point: an hour of album no longer sits in front of it.
        expect(next.order).toEqual(['a1', 'wanted', 'a2', 'a3', 'a4']);
    });

    it('goes to the back of the lane, where Play Next goes to the front', () => {
        let state = queue(['a1', 'a2']);
        state = playLast(state, ['qsecond'], 0, manual);
        state = playLast(state, ['qthird'], 0, manual);
        state = playNext(state, ['qfirst'], 0);

        expect(state.order).toEqual(['a1', 'qfirst', 'qsecond', 'qthird', 'a2']);
        expect(laneItems(state.order, 0, manual)).toEqual(['qfirst', 'qsecond', 'qthird']);
    });

    it('appends when nothing is playing, exactly as it did before', () => {
        expect(playLast(queue([]), ['qonly'], -1, manual).order).toEqual(['qonly']);
        expect(playLast(queue(['a1', 'a2']), ['qlate'], -1, manual).order).toEqual([
            'a1',
            'a2',
            'qlate',
        ]);
    });

    it('keeps the queued songs in the order they were asked for', () => {
        const next = playLast(queue(['a1', 'a2']), ['qx', 'qy', 'qz'], 0, manual);
        expect(next.order).toEqual(['a1', 'qx', 'qy', 'qz', 'a2']);
    });
});

describe('Play Last with shuffle on', () => {
    // Playback runs a1, a3, a2: `shuffled` holds indexes into `order`.
    const shuffledQueue = (): QueueOrder => queue(['a1', 'a2', 'a3'], [0, 2, 1]);

    it('lands after the lane in the playback order as well as the display order', () => {
        let state = playLast(shuffledQueue(), ['q1'], 0, manual);
        state = playLast(state, ['q2'], 0, manual);

        // Display order: the lane sits behind the current track.
        expect(state.order).toEqual(['a1', 'q1', 'q2', 'a2', 'a3']);
        // Playback order: the same two, in the same order, then the album.
        expect(state.shuffled.map((index) => state.order[index])).toEqual([
            'a1',
            'q1',
            'q2',
            'a3',
            'a2',
        ]);
    });

    it('leaves the permutation pointing at the entries it pointed at before', () => {
        const state = playLast(shuffledQueue(), ['q1'], 0, manual);
        expect(state.shuffled.every((index) => index >= 0 && index < state.order.length)).toBe(
            true,
        );
        expect(new Set(state.shuffled).size).toBe(state.order.length);
    });

    it('reads the current track through the permutation', () => {
        expect(currentIndexInOrder(shuffledQueue(), 1)).toBe(2);
        expect(currentIndexInOrder(queue(['a1', 'a2']), 1)).toBe(1);
    });
});

describe('shuffle', () => {
    it('leaves the lane in place and shuffles only what follows it', () => {
        const order = ['a1', 'q1', 'q2', 'a2', 'a3', 'a4'];
        const shuffled = playbackOrderKeepingLane(order, 0, manual, reverse);

        // Chosen by hand, so not scattered.
        expect(shuffled.slice(0, 3)).toEqual(['a1', 'q1', 'q2']);
        expect(new Set(shuffled.slice(3))).toEqual(new Set(['a2', 'a3', 'a4']));
    });

    it('re-shuffles what follows the lane and leaves the rest alone', () => {
        const order = ['a1', 'a2', 'q1', 'a3', 'a4', 'a5'];
        // Playing `a2`, with `q1` queued behind it.
        expect(shuffleAfterLane(order, 1, manual, reverse)).toEqual([
            'a1',
            'a2',
            'q1',
            'a5',
            'a4',
            'a3',
        ]);
    });

    it('shuffles everything when nothing is playing', () => {
        expect(playbackOrderKeepingLane(['a1', 'a2'], -1, manual, reverse)).toEqual(['a2', 'a1']);
    });
});

describe('starting something else', () => {
    it('keeps what was queued by hand', () => {
        const kept = laneAfterCurrent(queue(['a1', 'qkept', 'a2']), 0, manual);
        expect(kept).toEqual(['qkept']);

        // The new album, with the still-wanted song put back after its first track.
        const started = playNext(queue(['b1', 'b2', 'b3']), kept, 0);
        expect(started.order).toEqual(['b1', 'qkept', 'b2', 'b3']);
    });

    it('does not carry over a queued track that has already played', () => {
        // `q1` is playing, so it is behind the playhead and out of the lane.
        expect(laneAfterCurrent(queue(['a1', 'q1', 'a2']), 1, manual)).toEqual([]);
    });

    it('reads the lane through the playback order when shuffle is on', () => {
        // Playback runs a1, q1, a2 while the display order is a1, a2, q1.
        const state = queue(['a1', 'a2', 'q1'], [0, 2, 1]);
        expect(laneAfterCurrent(state, 0, manual)).toEqual(['q1']);
    });
});

describe('the queue view’s sections', () => {
    it('labels the lane and what follows it', () => {
        const sections = queueSections(['a1', 'a2', 'q1', 'q2', 'a3'], 1, manual);
        expect(sections).toEqual([
            { count: 1, kind: 'played', labelKey: 'aoide.queue.played', start: 0 },
            { count: 1, kind: 'playing', labelKey: 'aoide.queue.nowPlaying', start: 1 },
            { count: 2, kind: 'lane', labelKey: 'aoide.queue.nextUp', start: 2 },
            { count: 1, kind: 'context', labelKey: 'aoide.queue.then', start: 4 },
        ]);
    });

    it('calls the rest “Up Next” when there is no lane to distinguish it from', () => {
        const sections = queueSections(['a1', 'a2', 'a3'], 0, manual);
        expect(sections.map((section) => section.labelKey)).toEqual([
            'aoide.queue.nowPlaying',
            'aoide.queue.upNext',
        ]);
    });

    it('leaves out sections that hold nothing', () => {
        // Nothing played, nothing queued by hand, nothing left after the last track.
        expect(queueSections(['a1'], 0, manual).map((section) => section.kind)).toEqual([
            'playing',
        ]);
        expect(queueSections([], 0, manual)).toEqual([]);
    });

    it('accounts for every row, because the table builds itself by walking them', () => {
        const items = ['a1', 'a2', 'q1', 'a3', 'a4'];
        for (const position of [-1, 0, 1, 2, 3, 4]) {
            const sections = queueSections(items, position, manual);
            const counted = sections.reduce((sum, section) => sum + section.count, 0);
            expect(counted).toBe(items.length);
        }
    });

    it('shows a queue with nothing playing as one plain list', () => {
        expect(queueSections(['a1', 'a2'], -1, manual)).toEqual([
            { count: 2, kind: 'context', labelKey: 'aoide.queue.upNext', start: 0 },
        ]);
    });
});

describe('scrolling to a track once the sections are there', () => {
    // Rows: [Played] a1 a2 a3 a4 [Now Playing] a5 [Next Up] q1 q2 [Then] a6 a7 a8
    const counts = [4, 1, 2, 3];

    it('counts the headings above a row, so the right row is scrolled to', () => {
        expect(sectionHeaderRowsBefore(0, counts)).toBe(1);
        expect(sectionHeaderRowsBefore(3, counts)).toBe(1);
        expect(sectionHeaderRowsBefore(4, counts)).toBe(2);
        expect(sectionHeaderRowsBefore(5, counts)).toBe(3);
        expect(sectionHeaderRowsBefore(6, counts)).toBe(3);
        expect(sectionHeaderRowsBefore(7, counts)).toBe(4);
        expect(sectionHeaderRowsBefore(9, counts)).toBe(4);
    });

    it('is the identity when there are no sections', () => {
        expect(sectionHeaderRowsBefore(5, [])).toBe(0);
    });

    it('agrees with the row model the table actually builds', () => {
        const rows: (null | number)[] = [];
        let dataIndex = 0;
        for (const count of counts) {
            rows.push(null);
            for (let taken = 0; taken < count; taken++) rows.push(dataIndex++);
        }

        for (let index = 0; index < dataIndex; index++) {
            expect(rows[index + sectionHeaderRowsBefore(index, counts)]).toBe(index);
        }
    });
});

describe('laneEnd', () => {
    it('is just past the lane', () => {
        expect(laneEnd(['a1', 'q1', 'q2', 'a2'], 0, manual)).toBe(3);
    });

    it('is the end of the queue when nothing is playing', () => {
        expect(laneEnd(['a1', 'a2'], -1, manual)).toBe(2);
        expect(laneEnd([], -1, manual)).toBe(0);
    });
});
