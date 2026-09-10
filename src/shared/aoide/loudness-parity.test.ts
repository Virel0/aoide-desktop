import { describe, expect, it } from 'vitest';

import { gainDb } from './loudness';

/**
 * The same nine inputs the iOS app answers, with the same nine answers.
 *
 * "Both apps agree" is a claim, and this is the only thing that makes it one:
 * the table below is duplicated verbatim in `LoudnessNormalisationTests` in
 * Packages/PlaybackKit, and either side changing its arithmetic breaks its own
 * copy. Rounding is included on purpose — two implementations landing a
 * hundredth of a decibel apart is still two implementations.
 */
const TABLE: Array<{ expected: null | number; lufs: number; truePeak?: number; why: string }> = [
    { expected: -9, lufs: -9, why: 'a loud master comes down to the reference' },
    { expected: -4, lufs: -14, why: 'a milder master comes down less' },
    { expected: null, lufs: -24, why: 'quieter than the reference is left alone' },
    { expected: null, lufs: -18, why: 'exactly the reference is nothing to do' },
    { expected: null, lufs: -20, truePeak: 1.5, why: 'quiet and clipped is still left alone' },
    { expected: -9, lufs: -9, truePeak: -0.3, why: 'a peak under full scale changes nothing' },
    { expected: -12, lufs: -6, truePeak: 2, why: 'a loud master is turned down by its loudness' },
    { expected: null, lufs: -30, truePeak: 0.5, why: 'very quiet and clipped is left alone' },
    { expected: -9.67, lufs: -8.333, why: 'rounded to a hundredth, as both sides round' },
];

describe('loudness parity with the iOS app', () => {
    it.each(TABLE)('$why', ({ expected, lufs, truePeak }) => {
        expect(gainDb(lufs, truePeak)).toBe(expected);
    });
});
