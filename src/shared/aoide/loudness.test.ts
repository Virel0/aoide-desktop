import { describe, expect, it } from 'vitest';

import {
    AudioAnalysis,
    gainDb,
    hasReplayGain,
    linearGain,
    normalisationGainDb,
    TARGET_LUFS,
} from './loudness';

const analysis = (over: Partial<AudioAnalysis> = {}): AudioAnalysis => ({
    bpm: null,
    bpmConfidence: null,
    bpmStability: null,
    loudnessLufs: null,
    truePeakDbfs: null,
    ...over,
});

describe('the reference level', () => {
    it('is ReplayGain 2.0’s, so tagged and measured files land together', () => {
        expect(TARGET_LUFS).toBe(-18);
    });
});

describe('gainDb', () => {
    it('brings a loud master down to the reference', () => {
        // -18 − (-9.7) = -8.3, and the arithmetic that produces it in floating
        // point is -8.299999999999999.
        expect(gainDb(-9.7)).toBe(-8.3);
        expect(gainDb(-6)).toBe(-12);
    });

    // Attenuation only. Amplifying a quiet master pushes its own peak up and
    // usually undoes a decision somebody made on purpose.
    it('never boosts a track quieter than the reference', () => {
        expect(gainDb(-23)).toBeNull();
        expect(gainDb(-30.4)).toBeNull();
    });

    it('does nothing for a track already at the reference', () => {
        expect(gainDb(TARGET_LUFS)).toBeNull();
    });

    // The two sides of the clamp, a hundredth of a decibel apart.
    it('attenuates just below the reference and leaves just above it alone', () => {
        expect(gainDb(-17.99)).toBe(-0.01);
        expect(gainDb(-18.01)).toBeNull();
    });

    // Rounding is what makes "nothing worth doing" a single rule: a correction
    // under half a hundredth of a dB is inaudible, and `volume=-0dB` is a
    // filter in the chain that does nothing.
    it('treats a correction smaller than a hundredth of a decibel as none', () => {
        expect(gainDb(-17.998)).toBeNull();
        expect(gainDb(-17.994)).toBe(-0.01);
    });

    it('says nothing for a track it has no measurement for', () => {
        expect(gainDb(null)).toBeNull();
        expect(gainDb(undefined)).toBeNull();
        expect(gainDb(Number.NaN)).toBeNull();
        expect(gainDb(Number.POSITIVE_INFINITY)).toBeNull();
        expect(gainDb('-9.7' as unknown as number)).toBeNull();
    });

    describe('the true peak guard', () => {
        it('leaves the gain alone when the peak has room, which is the usual case', () => {
            expect(gainDb(-9.7, -0.3)).toBe(-8.3);
            // A file that peaks at exactly full scale, attenuated: still under.
            expect(gainDb(-17.5, 0)).toBe(-0.5);
        });

        // A lossy encode of a loud master genuinely can reconstruct above full
        // scale. The attenuation is then whatever brings the peak to 0.
        it('reduces the gain until an over-full-scale peak lands on zero', () => {
            expect(gainDb(-17.9, 1.5)).toBe(-1.5);
        });

        // The guard is about not *pushing* a peak over, and a track this
        // leaves alone has nothing pushed. A quiet master that already clips is
        // the file's own business: correcting it here would be limiting, which
        // is not what a person switching on loudness normalisation asked for.
        it('leaves a quiet track alone even when its peak is already over', () => {
            expect(gainDb(-24, 0.3)).toBeNull();
        });

        // The case rule 3 actually exists for: attenuated by less than it is
        // over full scale.
        it('reduces a small attenuation to whatever brings the peak to zero', () => {
            expect(gainDb(-17.9, 0.4)).toBe(-0.4);
        });

        it('ignores a peak it cannot read', () => {
            expect(gainDb(-9.7, null)).toBe(-8.3);
            expect(gainDb(-9.7, Number.NaN)).toBe(-8.3);
        });
    });
});

describe('hasReplayGain', () => {
    it('recognises a file that carries its own correction, either kind', () => {
        expect(hasReplayGain({ track: -7.2 })).toBe(true);
        expect(hasReplayGain({ album: -7.2 })).toBe(true);
        // Zero is a measurement, not an absence.
        expect(hasReplayGain({ track: 0 })).toBe(true);
    });

    it('reads an absent or unreadable tag as no tag at all', () => {
        expect(hasReplayGain(null)).toBe(false);
        expect(hasReplayGain(undefined)).toBe(false);
        expect(hasReplayGain({})).toBe(false);
        expect(hasReplayGain({ album: null, track: null })).toBe(false);
        expect(hasReplayGain({ track: Number.NaN })).toBe(false);
    });
});

describe('normalisationGainDb', () => {
    const measured = analysis({ loudnessLufs: -9.7, truePeakDbfs: -0.3 });

    it('corrects a measured file with no tags of its own', () => {
        expect(
            normalisationGainDb({ analysis: measured, enabled: true, hasOwnReplayGain: false }),
        ).toBe(-8.3);
    });

    // The whole point of the setting: off means every consumer applies nothing.
    it('applies nothing at all when the setting is off', () => {
        expect(
            normalisationGainDb({ analysis: measured, enabled: false, hasOwnReplayGain: false }),
        ).toBeNull();
    });

    // Both backends already honour tags. A second correction on top attenuates
    // twice, which is worse than not normalising at all.
    it('leaves a file that carries ReplayGain to its own tags', () => {
        expect(
            normalisationGainDb({ analysis: measured, enabled: true, hasOwnReplayGain: true }),
        ).toBeNull();
    });

    it('says nothing for a track not measured yet', () => {
        const asked = { enabled: true, hasOwnReplayGain: false };
        expect(normalisationGainDb({ ...asked, analysis: undefined })).toBeNull();
        expect(normalisationGainDb({ ...asked, analysis: null })).toBeNull();
        expect(normalisationGainDb({ ...asked, analysis: analysis() })).toBeNull();
    });
});

describe('linearGain', () => {
    it('is a factor of one when there is no gain, so a caller can multiply blindly', () => {
        expect(linearGain(null)).toBe(1);
        expect(linearGain(0)).toBe(1);
    });

    it('halves the amplitude at about six decibels down', () => {
        expect(linearGain(-6)).toBeCloseTo(0.501, 3);
        expect(linearGain(-20)).toBeCloseTo(0.1, 6);
    });
});
