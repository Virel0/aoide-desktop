import { describe, expect, it } from 'vitest';

import { QueueShape, UPCOMING_COUNT, upcomingTrackIds } from './upcoming-tracks';

const queue = (over: Partial<QueueShape> = {}): QueueShape => ({
    index: 1,
    shuffle: false,
    shuffled: [],
    songs: {
        u0: { id: 'a' },
        u1: { id: 'b' },
        u2: { id: 'c' },
        u3: { id: 'd' },
        u4: { id: 'e' },
    },
    unique: ['u0', 'u1', 'u2', 'u3', 'u4'],
    ...over,
});

describe('the tracks about to play', () => {
    it('are the ones after the current, in queue order, as library ids', () => {
        expect(upcomingTrackIds(queue())).toEqual(['c', 'd', 'e']);
        expect(upcomingTrackIds(queue(), 2)).toEqual(['c', 'd']);
    });

    it('follow the shuffled order when shuffle is on', () => {
        // Playing position 1 is queue index 3; then 0, then 4.
        expect(upcomingTrackIds(queue({ shuffle: true, shuffled: [2, 3, 0, 4, 1] }))).toEqual([
            'a',
            'e',
            'b',
        ]);
        // Shuffle on with nothing shuffled is queue order.
        expect(upcomingTrackIds(queue({ shuffle: true, shuffled: [] }))).toEqual(['c', 'd', 'e']);
    });

    it('stop at the end of the queue and skip what it cannot name', () => {
        expect(upcomingTrackIds(queue({ index: 4 }))).toEqual([]);
        expect(upcomingTrackIds(queue({ index: 3 }))).toEqual(['e']);
        expect(upcomingTrackIds(queue({ songs: { ...queue().songs, u2: undefined } }))).toEqual([
            'd',
            'e',
        ]);
        expect(upcomingTrackIds(queue({ songs: { ...queue().songs, u3: { id: 'c' } } }))).toEqual([
            'c',
            'e',
        ]);
    });

    it('are nothing for a position that is not one', () => {
        expect(upcomingTrackIds(queue({ index: -1 }))).toEqual([]);
        expect(upcomingTrackIds(queue({ index: 1.5 }))).toEqual([]);
        expect(upcomingTrackIds(queue(), 0)).toEqual([]);
    });

    it('look a few tracks ahead, not the whole queue', () => {
        expect(UPCOMING_COUNT).toBe(8);
    });
});
