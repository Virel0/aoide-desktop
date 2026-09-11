import { describe, expect, it } from 'vitest';

import {
    BASS_CUT_DB,
    BASS_CUT_HZ,
    BASS_OPEN_HZ,
    crossfadeIncoming,
    crossfadeOutgoing,
    ENTRY_WIDTH,
    FILTER_FADE_HZ,
    incomingBassCut,
    incomingBassDb,
    incomingGain,
    incomingHighPassHz,
    outgoingBassCut,
    outgoingBassDb,
    outgoingGain,
    outgoingHighPassHz,
    restoreRate,
    SWAP_POINT,
    SWAP_WIDTH,
    swapRamp,
    sweep,
} from './dj-automation';

const linear = (db: number): number => 10 ** (db / 20);

describe('what each deck does across a mix', () => {
    it('neither fader moves while the low end is still deciding', () => {
        for (let step = 0; step <= 5; step += 1) {
            expect(outgoingGain((step / 5) * SWAP_POINT)).toBe(1);
        }
        // The incoming record is raised over the first half, not shoved in.
        expect(incomingGain(0)).toBe(0);
        expect(incomingGain(ENTRY_WIDTH)).toBe(1);
        expect(incomingGain(0.75)).toBe(1);
        expect(incomingGain(ENTRY_WIDTH / 2)).toBeCloseTo(Math.SQRT1_2, 9);
        expect(incomingGain(0.1)).toBeCloseTo(Math.sin(Math.PI / 10), 9);
    });

    it('the outgoing record leaves after the bass does, not before', () => {
        expect(outgoingGain(0.5)).toBe(1);
        expect(outgoingGain(0.75)).toBeCloseTo(Math.SQRT1_2, 9);
        expect(outgoingGain(1)).toBeCloseTo(0, 9);
        let previous = 1;
        for (let step = 0; step <= 20; step += 1) {
            const gain = outgoingGain(step / 20);
            expect(gain).toBeLessThanOrEqual(previous + 1e-12);
            previous = gain;
        }
    });

    it('the bass swaps at constant power, not at constant decibels', () => {
        expect(outgoingBassDb(SWAP_POINT)).toBeCloseTo(-3.0103, 2);
        expect(incomingBassDb(SWAP_POINT)).toBeCloseTo(-3.0103, 2);
        for (let step = 0; step <= 40; step += 1) {
            const progress = step / 40;
            const out = linear(outgoingBassDb(progress));
            const into = linear(incomingBassDb(progress));
            const power = out * out + into * into;
            expect(power).toBeGreaterThan(0.99);
            expect(power).toBeLessThan(1.02);
        }
    });

    it('either side of the swap, one record has the low end and one does not', () => {
        expect(outgoingBassDb(0.1)).toBe(0);
        expect(incomingBassDb(0.1)).toBe(BASS_CUT_DB);
        expect(outgoingBassDb(0.9)).toBe(BASS_CUT_DB);
        expect(incomingBassDb(0.9)).toBe(0);
        expect(outgoingBassCut(0.1)).toBe(0);
        expect(incomingBassCut(0.1)).toBe(1);
        expect(outgoingBassCut(0.9)).toBe(1);
        expect(incomingBassCut(0.9)).toBe(0);
        // Across the swap the two cuts are complements.
        for (let step = 0; step <= 40; step += 1) {
            expect(outgoingBassCut(step / 40) + incomingBassCut(step / 40)).toBeCloseTo(1, 12);
        }
    });

    it('the swap happens in the middle, where the downbeat is', () => {
        expect(swapRamp(SWAP_POINT)).toBeCloseTo(0.5, 9);
        expect(swapRamp(SWAP_POINT - SWAP_WIDTH)).toBe(0);
        expect(swapRamp(SWAP_POINT - SWAP_WIDTH / 2)).toBe(0);
        expect(swapRamp(SWAP_POINT + SWAP_WIDTH / 2)).toBeCloseTo(1, 12);
        expect(swapRamp(SWAP_POINT + SWAP_WIDTH)).toBe(1);
        expect(swapRamp(SWAP_POINT - SWAP_WIDTH / 4)).toBeCloseTo(0.25, 9);
    });

    it('a progress outside the mix stays inside it', () => {
        expect(swapRamp(-1)).toBe(0);
        expect(swapRamp(2)).toBe(1);
        expect(swapRamp(Number.NaN)).toBe(0);
        expect(outgoingGain(Number.NaN)).toBe(1);
        expect(outgoingGain(2)).toBeCloseTo(0, 9);
        expect(incomingGain(Number.NaN)).toBe(0);
        expect(incomingGain(-1)).toBe(0);
        expect(crossfadeOutgoing(Number.POSITIVE_INFINITY)).toBe(1);
        expect(crossfadeIncoming(-1)).toBe(0);
    });

    it('a plain crossfade is equal power', () => {
        for (let step = 0; step <= 20; step += 1) {
            const out = crossfadeOutgoing(step / 20);
            const into = crossfadeIncoming(step / 20);
            expect(out * out + into * into).toBeCloseTo(1, 12);
        }
        expect(crossfadeOutgoing(0)).toBe(1);
        expect(crossfadeIncoming(1)).toBe(1);
    });

    it('the corner sweeps the octaves on a log scale', () => {
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, 0)).toBe(BASS_OPEN_HZ);
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, 1)).toBeCloseTo(BASS_CUT_HZ, 9);
        // Halfway is 66 Hz, not 120: the geometric mean.
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, 0.5)).toBeCloseTo(
            Math.sqrt(BASS_OPEN_HZ * BASS_CUT_HZ),
            9,
        );
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, -1)).toBe(BASS_OPEN_HZ);
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, 2)).toBeCloseTo(BASS_CUT_HZ, 9);
        expect(sweep(BASS_OPEN_HZ, BASS_CUT_HZ, Number.NaN)).toBe(BASS_OPEN_HZ);
    });

    it('a blend leaves the outgoing record alone until the swap, then takes its bass', () => {
        expect(outgoingHighPassHz(0, 'blend')).toBe(BASS_OPEN_HZ);
        expect(outgoingHighPassHz(0.4, 'blend')).toBe(BASS_OPEN_HZ);
        expect(outgoingHighPassHz(0.46, 'blend')).toBe(BASS_OPEN_HZ);
        expect(outgoingHighPassHz(0.5, 'blend')).toBeCloseTo(
            Math.sqrt(BASS_OPEN_HZ * BASS_CUT_HZ),
            9,
        );
        expect(outgoingHighPassHz(0.54, 'blend')).toBeCloseTo(BASS_CUT_HZ, 9);
        expect(outgoingHighPassHz(0.9, 'blend')).toBeCloseTo(BASS_CUT_HZ, 9);
        // And the incoming record comes in without its bass either way.
        expect(incomingHighPassHz(0.1)).toBeCloseTo(BASS_CUT_HZ, 9);
        expect(incomingHighPassHz(0.5)).toBeCloseTo(Math.sqrt(BASS_OPEN_HZ * BASS_CUT_HZ), 9);
        expect(incomingHighPassHz(0.9)).toBe(BASS_OPEN_HZ);
        expect(incomingHighPassHz(Number.NaN)).toBeCloseTo(BASS_CUT_HZ, 9);
    });

    it('the filter fade takes the outgoing record’s middle away before the swap', () => {
        // Open at the start; up to the fade's corner by the swap; held there.
        expect(outgoingHighPassHz(0, 'filterFade')).toBe(BASS_OPEN_HZ);
        expect(outgoingHighPassHz(0.5, 'filterFade')).toBeCloseTo(FILTER_FADE_HZ, 9);
        expect(outgoingHighPassHz(0.9, 'filterFade')).toBeCloseTo(FILTER_FADE_HZ, 9);
        expect(outgoingHighPassHz(2, 'filterFade')).toBeCloseTo(FILTER_FADE_HZ, 9);
        // Halfway there in octaves, not in hertz: 20 → 1,500 passes 173, not 760.
        expect(outgoingHighPassHz(0.25, 'filterFade')).toBeCloseTo(Math.sqrt(20 * 1_500), 9);
        expect(outgoingHighPassHz(-1, 'filterFade')).toBe(BASS_OPEN_HZ);
        expect(outgoingHighPassHz(Number.NaN, 'filterFade')).toBe(BASS_OPEN_HZ);
    });

    it('the bend eases back in a straight line', () => {
        expect(restoreRate(1.05, 0)).toBe(1.05);
        expect(restoreRate(1.05, 0.5)).toBeCloseTo(1.025, 12);
        expect(restoreRate(1.05, 1)).toBeCloseTo(1, 12);
        expect(restoreRate(0.96, 0.25)).toBeCloseTo(0.97, 12);
        expect(restoreRate(1.05, 2)).toBeCloseTo(1, 12);
        expect(restoreRate(1.05, Number.NaN)).toBe(1.05);
    });
});
