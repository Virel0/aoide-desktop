import { describe, expect, it } from 'vitest';

import {
    incomingBassCut,
    incomingBassDb,
    incomingGain,
    incomingHighPassHz,
    outgoingBassCut,
    outgoingBassDb,
    outgoingGain,
    outgoingHighPassHz,
    restoreRate,
} from './dj-automation';
import { RESTORE_SECONDS } from './dj-planner';

/**
 * The same sixteen instants of a mix on both apps, and what each fader and
 * filter is doing at each.
 *
 * Duplicated verbatim in `DJAutomationParityTests` in Packages/PlaybackKit.
 * Both sides read `[progress, outgoing gain, incoming gain, outgoing cut,
 * incoming cut, outgoing bass dB, incoming bass dB, outgoing corner Hz for a
 * blend, outgoing corner Hz for a filter fade, incoming corner Hz]`. The
 * phone's corners are read back off its mixer's high-pass, in the mixer's own
 * precision, so the sweep is the sweep a listener gets.
 */
const TABLE: Array<
    [number, number, number, number, number, number, number, number, number, number]
> = [
    [-1, 1, 0, 0, 1, 0, -24, 20, 20, 220],
    [0, 1, 0, 0, 1, 0, -24, 20, 20, 220],
    [0.05, 1, 0.15643446504023087, 0, 1, 0, -24, 20, 30.79896498117631, 220],
    [0.1, 1, 0.3090169943749474, 0, 1, 0, -24, 20, 47.42881219558623, 220],
    [0.25, 1, 0.7071067811865475, 0, 1, 0, -24, 20, 173.20508075688775, 220],
    [0.46, 1, 0.9921147013144779, 0, 1, 0, -24, 20, 1061.906692749479, 220],
    [
        0.48, 1, 0.9980267284282716, 0.25, 0.75, -0.6876930815810842, -8.343206788338364,
        36.423205736757396, 1262.085591045321, 120.80210709074485,
    ],
    [
        0.5, 1, 1, 0.5, 0.5, -3.0102999566398085, -3.010299956639815, 66.33249580710795, 1500,
        66.33249580710803,
    ],
    [
        0.52, 0.9980267284282716, 1, 0.75, 0.25, -8.343206788338346, -0.6876930815810872,
        120.80210709074473, 1500, 36.42320573675744,
    ],
    [0.54, 0.9921147013144778, 1, 1, 0, -24, 0, 220, 1500, 20],
    [0.6, 0.9510565162951536, 1, 1, 0, -24, 0, 220, 1500, 20],
    [0.75, 0.7071067811865476, 1, 1, 0, -24, 0, 220, 1500, 20],
    [0.9, 0.30901699437494745, 1, 1, 0, -24, 0, 220, 1500, 20],
    [1, 0, 1, 1, 0, -24, 0, 220, 1500, 20],
    [2, 0, 1, 1, 0, -24, 0, 220, 1500, 20],
    [Number.NaN, 1, 0, 0, 1, 0, -24, 20, 20, 220],
];

/**
 * `[outgoing BPM, incoming BPM, seconds after the mix ends, incoming rate]`
 * for the ease back to the record's own tempo. The phone's side renders the
 * pair through its decks and reads the rate off the deck, so the ease is the
 * one a listener gets rather than the one the arithmetic describes.
 */
const RESTORE: Array<[number, number, number, number]> = [
    [128, 124, 0, 1.032258064516129],
    [128, 124, 2, 1.0241935483870968],
    [128, 124, 4, 1.0161290322580645],
    [128, 124, 8, 1],
    [128, 132, 0, 0.9696969696969697],
    [128, 132, 4, 0.9848484848484849],
    [128, 132, 8, 1],
];

describe('DJ automation parity', () => {
    it.each(TABLE)(
        'at progress %s',
        (progress, out, into, outCut, inCut, outDb, inDb, blendHz, fadeHz, inHz) => {
            expect(Math.abs(outgoingGain(progress) - out)).toBeLessThan(1e-9);
            expect(Math.abs(incomingGain(progress) - into)).toBeLessThan(1e-9);
            expect(Math.abs(outgoingBassCut(progress) - outCut)).toBeLessThan(1e-9);
            expect(Math.abs(incomingBassCut(progress) - inCut)).toBeLessThan(1e-9);
            expect(Math.abs(outgoingBassDb(progress) - outDb)).toBeLessThan(1e-9);
            expect(Math.abs(incomingBassDb(progress) - inDb)).toBeLessThan(1e-9);
            expect(Math.abs(outgoingHighPassHz(progress, 'blend') - blendHz)).toBeLessThan(0.01);
            expect(Math.abs(outgoingHighPassHz(progress, 'filterFade') - fadeHz)).toBeLessThan(
                0.01,
            );
            expect(Math.abs(incomingHighPassHz(progress) - inHz)).toBeLessThan(0.01);
        },
    );

    it.each(RESTORE)(
        '%s over %s: %ss after the mix the bend is %s',
        (outgoingBpm, incomingBpm, secondsAfter, rate) => {
            const from = outgoingBpm / incomingBpm;
            expect(Math.abs(restoreRate(from, secondsAfter / RESTORE_SECONDS) - rate)).toBeLessThan(
                1e-12,
            );
        },
    );

    it('answers every case in the tables', () => {
        expect(TABLE).toHaveLength(16);
        expect(RESTORE).toHaveLength(7);
    });
});
