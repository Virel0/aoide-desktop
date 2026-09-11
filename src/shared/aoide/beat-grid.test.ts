import { describe, expect, it } from 'vitest';

import {
    barMsAt,
    beatAt,
    BeatGrid,
    beatIndexAt,
    camelotCompatible,
    canLock,
    downbeatAtOrBefore,
    maximumResidualMs,
    parseCamelot,
    segmentAt,
} from './beat-grid';

/**
 * The rig's own fixture, as the sidecar reported it: a twenty-second pad, then
 * 160 seconds of 128 BPM with the first beat at 20.000s, in A minor.
 */
const steady: BeatGrid = {
    beatsPerBar: 4,
    downbeatIndex: 0,
    key: '8A',
    keyConfidence: 1,
    mixInMs: 19_994.5,
    mixOutMs: 179_369.5,
    segments: [
        { anchorMs: 19_994.5, beats: 345, bpm: 128, endMs: 180_000, residualMs: 4.8, startMs: 0 },
    ],
};

/**
 * The drifting fixture: 105→145 BPM, which comes back as segments with large
 * residuals, no meter and no mix points.
 */
const drifting: BeatGrid = {
    beatsPerBar: null,
    downbeatIndex: null,
    key: null,
    keyConfidence: null,
    mixInMs: null,
    mixOutMs: null,
    segments: [
        { anchorMs: 120, beats: 52, bpm: 105, endMs: 30_000, residualMs: 261, startMs: 0 },
        { anchorMs: 30_100, beats: 59, bpm: 118, endMs: 60_000, residualMs: 57, startMs: 30_000 },
        { anchorMs: 60_050, beats: 138, bpm: 138, endMs: 120_000, residualMs: 18, startMs: 60_000 },
    ],
};

describe('beat grid', () => {
    it('beats fall where the fit says', () => {
        const segment = steady.segments[0];
        expect(beatAt(segment, 0)).toBeCloseTo(19_994.5, 3);
        // 128 BPM is 468.75ms a beat.
        expect(beatAt(segment, 1) - beatAt(segment, 0)).toBeCloseTo(468.75, 3);
        expect(beatAt(segment, 8)).toBeCloseTo(19_994.5 + 8 * 468.75, 3);
        expect(beatIndexAt(segment, 19_994.5 + 468.75 * 3 + 10)).toBe(3);
        expect(beatIndexAt(segment, 19_994.5 + 468.75 * 3 - 10)).toBe(2);
    });

    it('bars are four beats, and every downbeat is a whole number of them from the anchor', () => {
        const bar = barMsAt(steady, 60_000);
        expect(bar).toBeCloseTo(468.75 * 4, 3);
        const downbeat = downbeatAtOrBefore(steady, 60_000);
        expect(downbeat).not.toBeNull();
        const barsIn = (downbeat! - 19_994.5) / bar!;
        expect(Math.abs(barsIn - Math.round(barsIn))).toBeLessThan(1e-9);
        expect(downbeat!).toBeLessThanOrEqual(60_000);
        expect(downbeat! + bar!).toBeGreaterThan(60_000);
    });

    it('a moment before the first beat still belongs to a segment', () => {
        expect(segmentAt(steady, 500)).not.toBeNull();
        // Negative bars are bars.
        expect(downbeatAtOrBefore(steady, 500)).toBeCloseTo(19_994.5 - 1875 * 11, 6);
    });

    it('finds the segment holding a moment, or the nearest one', () => {
        expect(segmentAt(drifting, 45_000)?.bpm).toBe(118);
        expect(segmentAt(drifting, 30_000)?.bpm).toBe(118);
        expect(segmentAt(drifting, 29_999.9)?.bpm).toBe(105);
        // Past the end: the last segment that started before it.
        expect(segmentAt(drifting, 500_000)?.bpm).toBe(138);
        // Before the start: the first.
        expect(segmentAt(drifting, -5)?.bpm).toBe(105);
        expect(segmentAt({ ...steady, segments: [] }, 0)).toBeNull();
    });

    it('a tight grid may be locked to, a drifting one may not', () => {
        expect(canLock(steady, 60_000, 30)).toBe(true);
        expect(canLock(drifting, 5_000, 30)).toBe(false);
        // Even the drifting fixture's best segment is refused: its meter was
        // never established.
        expect(canLock(drifting, 70_000, 8)).toBe(false);
        // And a residual just over the line is refused, while one on it is not.
        const loose = { ...steady, segments: [{ ...steady.segments[0], residualMs: 20.01 }] };
        const onTheLine = { ...steady, segments: [{ ...steady.segments[0], residualMs: 20 }] };
        expect(canLock(loose, 60_000, 30)).toBe(false);
        expect(canLock(onTheLine, 60_000, 30)).toBe(true);
    });

    it('a shorter blend forgives a looser grid, up to a point', () => {
        expect(maximumResidualMs(30)).toBe(20);
        expect(maximumResidualMs(15)).toBe(40);
        // Capped: a two-bar blend does not accept a grid that is nonsense.
        expect(maximumResidualMs(4)).toBe(40);
        expect(maximumResidualMs(60)).toBe(10);
        expect(maximumResidualMs(0)).toBe(0);
        expect(maximumResidualMs(-1)).toBe(0);
        expect(maximumResidualMs(Number.NaN)).toBe(0);
    });

    it('a blend may not cross a tempo change', () => {
        const twoSegments: BeatGrid = {
            beatsPerBar: 4,
            downbeatIndex: 0,
            key: null,
            keyConfidence: null,
            mixInMs: null,
            mixOutMs: null,
            segments: [
                { anchorMs: 0, beats: 128, bpm: 128, endMs: 60_000, residualMs: 4, startMs: 0 },
                {
                    anchorMs: 60_000,
                    beats: 140,
                    bpm: 140,
                    endMs: 120_000,
                    residualMs: 4,
                    startMs: 60_000,
                },
            ],
        };
        expect(canLock(twoSegments, 20_000, 30)).toBe(true);
        expect(canLock(twoSegments, 30_000, 30)).toBe(true);
        // Starting 20s before the change, a 30s blend would finish on the other
        // side of it.
        expect(canLock(twoSegments, 40_000, 30)).toBe(false);
    });

    it('no meter means nothing bar-aligned is offered', () => {
        const gridless: BeatGrid = { ...steady, beatsPerBar: null, downbeatIndex: null };
        expect(barMsAt(gridless, 60_000)).toBeNull();
        expect(downbeatAtOrBefore(gridless, 60_000)).toBeNull();
        expect(canLock(gridless, 60_000, 8)).toBe(false);
    });

    it('a track with no grid at all refuses everything', () => {
        const nothing: BeatGrid = { ...steady, segments: [] };
        expect(segmentAt(nothing, 0)).toBeNull();
        expect(barMsAt(nothing, 0)).toBeNull();
        expect(downbeatAtOrBefore(nothing, 0)).toBeNull();
        expect(canLock(nothing, 0, 8)).toBe(false);
    });
});

describe('Camelot keys', () => {
    it('reads the wheel', () => {
        expect(parseCamelot('8A')).toEqual({ isMinor: true, number: 8 });
        expect(parseCamelot('8B')).toEqual({ isMinor: false, number: 8 });
        expect(parseCamelot('8b')).toEqual({ isMinor: false, number: 8 });
        expect(parseCamelot('12A')?.number).toBe(12);
        expect(parseCamelot(null)).toBeNull();
        expect(parseCamelot(undefined)).toBeNull();
        expect(parseCamelot('')).toBeNull();
        expect(parseCamelot('A')).toBeNull();
        expect(parseCamelot('13A')).toBeNull();
        expect(parseCamelot('0B')).toBeNull();
        expect(parseCamelot('8C')).toBeNull();
        expect(parseCamelot('Am')).toBeNull();
        expect(parseCamelot('8.5A')).toBeNull();
        expect(parseCamelot(' 8A')).toBeNull();
    });

    it('the compatible moves are the neighbours and the relative', () => {
        expect(camelotCompatible('8A', '8A')).toBe(true);
        expect(camelotCompatible('8A', '9A')).toBe(true);
        expect(camelotCompatible('8A', '7A')).toBe(true);
        // The same number in the other letter — A minor and C major.
        expect(camelotCompatible('8A', '8B')).toBe(true);
        // Two steps is not a move.
        expect(camelotCompatible('8A', '10A')).toBe(false);
        // Neighbouring numbers in different letters are not either.
        expect(camelotCompatible('8A', '9B')).toBe(false);
        // The wheel wraps.
        expect(camelotCompatible('12A', '1A')).toBe(true);
        expect(camelotCompatible('1B', '12B')).toBe(true);
        expect(camelotCompatible('1B', '11B')).toBe(false);
        expect(camelotCompatible(null, '8A')).toBe(false);
        expect(camelotCompatible('8A', null)).toBe(false);
        expect(camelotCompatible('8A', 'Am')).toBe(false);
    });
});
