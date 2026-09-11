import { describe, expect, it } from 'vitest';

import {
    barMsAt,
    BeatGrid,
    camelotCompatible,
    canLock,
    downbeatAtOrBefore,
    maximumResidualMs,
    parseCamelot,
    segmentAt,
} from './beat-grid';

/**
 * The grid arithmetic both apps do, on the rig's two fixtures, with the same
 * answers.
 *
 * Duplicated verbatim in `BeatGridParityTests` in Packages/PlaybackKit. A
 * downbeat a bar out on one app is a mix a bar out on that app, so the
 * downbeats are exact milliseconds and the locks are yes or no.
 */

/** The rig's steady fixture: a twenty-second pad, then 128 BPM from 19.9945 s. */
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

/** The drifting fixture: three fits, large residuals, no meter. */
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

/** Two tempi, tight fits, a meter. */
const twoSegments: BeatGrid = {
    beatsPerBar: 4,
    downbeatIndex: 0,
    key: null,
    keyConfidence: null,
    mixInMs: null,
    mixOutMs: null,
    segments: [
        { anchorMs: 0, beats: 128, bpm: 128, endMs: 60_000, residualMs: 4, startMs: 0 },
        { anchorMs: 60_000, beats: 140, bpm: 140, endMs: 120_000, residualMs: 4, startMs: 60_000 },
    ],
};

/** A waltz on the steady fixture's fit. */
const waltz: BeatGrid = { ...steady, beatsPerBar: 3 };

const GRIDS = { drifting, steady, twoSegments, waltz } as const;
type GridName = keyof typeof GRIDS;

/** `[grid, ms, segment bpm, bar ms, downbeat at or before]`. */
const LOOKUPS: Array<[GridName, number, null | number, null | number, null | number]> = [
    ['steady', 60_000, 128, 1875, 59_369.5],
    ['steady', 19_994.5, 128, 1875, 19_994.5],
    ['steady', 19_994.4, 128, 1875, 18_119.5],
    ['steady', 500, 128, 1875, -630.5],
    ['steady', 500_000, 128, 1875, 499_994.5],
    ['waltz', 61_000, 128, 1406.25, 60_775.75],
    ['drifting', 45_000, 118, null, null],
    ['drifting', 30_000, 118, null, null],
    ['drifting', 29_999.9, 105, null, null],
    ['drifting', 500_000, 138, null, null],
    ['drifting', -5, 105, null, null],
    ['twoSegments', 59_999, 128, 1875, 58_125],
    ['twoSegments', 60_000, 140, 1714.2857142857142, 60_000],
    ['twoSegments', 100_000, 140, 1714.2857142857142, 99_428.57142857143],
];

/** `[grid, ms, blend seconds, may lock]`. */
const LOCKS: Array<[GridName, number, number, boolean]> = [
    ['steady', 60_000, 30, true],
    ['steady', 60_000, 60, true],
    ['steady', 150_001, 30, false],
    ['steady', 150_000, 30, true],
    ['drifting', 5_000, 30, false],
    ['drifting', 70_000, 8, false],
    ['twoSegments', 20_000, 30, true],
    ['twoSegments', 30_000, 30, true],
    ['twoSegments', 40_000, 30, false],
    ['twoSegments', 60_000, 30, true],
];

/** `[blend seconds, maximum residual ms]`. */
const RESIDUALS: Array<[number, number]> = [
    [30, 20],
    [15, 40],
    [4, 40],
    [60, 10],
    [0, 0],
    [-1, 0],
];

/** `[key, number, minor]`, with null for a key that does not parse. */
const KEYS: Array<[null | string, null | number, boolean]> = [
    ['8A', 8, true],
    ['8B', 8, false],
    ['8b', 8, false],
    ['12A', 12, true],
    ['1B', 1, false],
    [null, null, false],
    ['', null, false],
    ['A', null, false],
    ['13A', null, false],
    ['0B', null, false],
    ['8C', null, false],
    ['Am', null, false],
    ['8.5A', null, false],
];

/** `[a, b, compatible]`. */
const MOVES: Array<[null | string, null | string, boolean]> = [
    ['8A', '8A', true],
    ['8A', '9A', true],
    ['8A', '7A', true],
    ['8A', '8B', true],
    ['8A', '10A', false],
    ['8A', '9B', false],
    ['12A', '1A', true],
    ['1B', '12B', true],
    ['1B', '11B', false],
    [null, '8A', false],
    ['8A', 'Am', false],
];

describe('beat grid parity', () => {
    it.each(LOOKUPS)('%s at %s ms', (name, ms, bpm, bar, downbeat) => {
        const grid = GRIDS[name];
        expect(segmentAt(grid, ms)?.bpm ?? null).toBe(bpm);
        const foundBar = barMsAt(grid, ms);
        if (bar === null) expect(foundBar).toBeNull();
        else expect(Math.abs(foundBar! - bar)).toBeLessThan(1e-9);
        const found = downbeatAtOrBefore(grid, ms);
        if (downbeat === null) expect(found).toBeNull();
        else expect(Math.abs(found! - downbeat)).toBeLessThan(1e-9);
    });

    it.each(LOCKS)('%s at %s ms may lock a %ss blend: %s', (name, ms, seconds, locks) => {
        expect(canLock(GRIDS[name], ms, seconds)).toBe(locks);
    });

    it.each(RESIDUALS)('a %ss blend forgives %s ms', (seconds, residual) => {
        expect(maximumResidualMs(seconds)).toBe(residual);
    });

    it.each(KEYS)('%s parses as %s', (key, number, minor) => {
        const parsed = parseCamelot(key);
        if (number === null) expect(parsed).toBeNull();
        else expect(parsed).toEqual({ isMinor: minor, number });
    });

    it.each(MOVES)('%s and %s are compatible: %s', (a, b, compatible) => {
        expect(camelotCompatible(a, b)).toBe(compatible);
    });

    it('answers every case in the tables', () => {
        expect(LOOKUPS).toHaveLength(14);
        expect(LOCKS).toHaveLength(10);
        expect(RESIDUALS).toHaveLength(6);
        expect(KEYS).toHaveLength(13);
        expect(MOVES).toHaveLength(11);
    });
});
