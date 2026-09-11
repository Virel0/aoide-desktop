import { describe, expect, it } from 'vitest';

import {
    energyFactor,
    keyFactor,
    MIX_SCORE_WEIGHTS,
    MixScore,
    scoreBars,
    scoreTotal,
    sectionsFactor,
    tempoFactor,
    vocalsFactor,
} from './mix-score';

const score = (over: Partial<MixScore> = {}): MixScore => ({
    energy: 0.5,
    key: 0.5,
    sections: 0.5,
    tempo: 1,
    vocals: 0.5,
    ...over,
});

describe('the score sets the length', () => {
    it('weights sum to one, and the total is the weighted sum', () => {
        const weights = Object.values(MIX_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(weights).toBeCloseTo(1, 12);
        expect(
            scoreTotal(score({ energy: 1, key: 1, sections: 1, tempo: 1, vocals: 1 })),
        ).toBeCloseTo(1, 12);
        expect(scoreTotal(score({ energy: 0, key: 0, sections: 0, tempo: 0, vocals: 0 }))).toBe(0);
        expect(
            scoreTotal(score({ energy: 0, key: 0, sections: 0, tempo: 1, vocals: 0 })),
        ).toBeCloseTo(0.2, 12);
        expect(
            scoreTotal(score({ energy: 0, key: 0, sections: 1, tempo: 0, vocals: 0 })),
        ).toBeCloseTo(0.25, 12);
        expect(
            scoreTotal(score({ energy: 0, key: 0, sections: 0, tempo: 0, vocals: 1 })),
        ).toBeCloseTo(0.15, 12);
    });

    it('earns thirty-two, sixteen, eight, or nothing', () => {
        expect(scoreBars(score({ energy: 1, key: 1, sections: 1, tempo: 1, vocals: 1 }))).toBe(32);
        // A pair with nothing *known* against it gets sixteen: half a minute
        // together has to be earned.
        expect(scoreBars(score())).toBe(16);
        expect(scoreBars(score({ key: 0, tempo: 0.4 }))).toBe(8);
        expect(scoreBars(score({ energy: 0, key: 0, sections: 0.2, tempo: 0 }))).toBeNull();
    });

    it('the thresholds are inclusive at the bottom', () => {
        // 0.75 exactly: tempo 1, key 1, everything else 0.5 → 0.2+0.2+0.075+0.1+0.125 = 0.7
        // so use sections 0.7 → 0.2+0.2+0.075+0.1+0.175 = 0.75.
        expect(scoreTotal(score({ key: 1, sections: 0.7 }))).toBeCloseTo(0.75, 12);
        expect(scoreBars(score({ key: 1, sections: 0.7 }))).toBe(32);
        // 0.55 exactly: tempo 1, key 0.5, vocals 0.5, energy 0.5, sections 0.5 → 0.7; drop
        // tempo to 0.25 → 0.05+0.1+0.075+0.1+0.125 = 0.45; want 0.55: tempo 0.75 → 0.15+0.4 = 0.55.
        expect(scoreBars(score({ tempo: 0.75 }))).toBe(16);
        expect(scoreBars(score({ tempo: 0.7499 }))).toBe(8);
        // 0.35: tempo 0 gives 0.4; energy 0.25 → 0.35.
        expect(scoreBars(score({ energy: 0.25, tempo: 0 }))).toBe(8);
        expect(scoreBars(score({ energy: 0.2499, tempo: 0 }))).toBeNull();
    });
});

describe('the five factors', () => {
    it('tempo is free to two per cent and gone at six', () => {
        expect(tempoFactor(1)).toBe(1);
        expect(tempoFactor(1.019)).toBe(1);
        expect(tempoFactor(1.02)).toBe(1);
        expect(tempoFactor(0.98)).toBe(1);
        expect(tempoFactor(1.04)).toBeCloseTo(0.5, 9);
        expect(tempoFactor(0.96)).toBeCloseTo(0.5, 9);
        expect(tempoFactor(1.06)).toBeCloseTo(0, 9);
        expect(tempoFactor(1.1)).toBe(0);
    });

    it('key is a preference, and unknown is neutral', () => {
        expect(keyFactor('8A', '9A')).toBe(1);
        expect(keyFactor('8A', '8B')).toBe(1);
        expect(keyFactor('3B', '10B')).toBe(0);
        expect(keyFactor(null, '8A')).toBe(0.5);
        expect(keyFactor('8A', null)).toBe(0.5);
        expect(keyFactor(null, null)).toBe(0.5);
    });

    it('vocals: neither is best, one is fine, unknown is neutral', () => {
        expect(vocalsFactor(false, false)).toBe(1);
        expect(vocalsFactor(true, false)).toBe(0.6);
        expect(vocalsFactor(false, true)).toBe(0.6);
        // Both singing is a refusal upstream, never a score; scored anyway it
        // is the same as one.
        expect(vocalsFactor(true, true)).toBe(0.6);
        expect(vocalsFactor(null, false)).toBe(0.5);
        expect(vocalsFactor(true, null)).toBe(0.5);
    });

    it('energy that matches scores; energy that does not, does not', () => {
        expect(energyFactor(0.5, 0.5)).toBe(1);
        expect(energyFactor(0.9, 0.2)).toBeCloseTo(0.3, 9);
        expect(energyFactor(0.2, 0.9)).toBeCloseTo(0.3, 9);
        expect(energyFactor(0, 1)).toBe(0);
        expect(energyFactor(null, 0.5)).toBe(0.5);
        expect(energyFactor(0.5, null)).toBe(0.5);
    });

    it('sections: out on an ending, in on a beginning, never a drop', () => {
        expect(sectionsFactor('outro', 'build')).toBe(1);
        expect(sectionsFactor('breakdown', 'intro')).toBe(1);
        expect(sectionsFactor('breakdown', 'breakdown')).toBe(1);
        expect(sectionsFactor('drop', 'drop')).toBeCloseTo(0.3, 9);
        expect(sectionsFactor('drop', 'build')).toBeCloseTo(0.7, 9);
        expect(sectionsFactor('build', 'drop')).toBeCloseTo(0.45, 9);
        expect(sectionsFactor('intro', 'outro')).toBeCloseTo(0.7, 9);
        expect(sectionsFactor('verse', 'verse')).toBeCloseTo(0.7, 9);
        expect(sectionsFactor('chorus', 'chorus')).toBeCloseTo(0.7, 9);
        expect(sectionsFactor('unknown', 'unknown')).toBeCloseTo(0.6, 9);
        expect(sectionsFactor(null, 'build')).toBe(0.5);
        expect(sectionsFactor('outro', null)).toBe(0.5);
    });
});
