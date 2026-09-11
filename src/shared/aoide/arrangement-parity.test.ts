import { describe, expect, it } from 'vitest';

import { Arrangement, maySing, phraseStartAtOrBefore, sectionAt, SectionKind } from './arrangement';
import {
    energyFactor,
    keyFactor,
    MixScore,
    scoreBars,
    scoreTotal,
    sectionsFactor,
    tempoFactor,
    vocalsFactor,
} from './mix-score';

/**
 * What both apps read off an arrangement, and how both score a pair, with the
 * same answers.
 *
 * Duplicated verbatim in `ArrangementParityTests` in Packages/PlaybackKit.
 * The score totals are exact doubles because the bar thresholds are
 * inclusive, and a total a rounding error under one on one app is a shorter
 * mix on that app.
 */

const bar = (60_000 / 128) * 4;

/** Intro, drop, outro in bars, sung in the first two seconds. */
const record: Arrangement = {
    phraseAnchorMs: 0,
    phraseBars: 16,
    sections: [
        { endMs: bar * 16, energy: 0.1, kind: 'intro', startMs: 0 },
        { endMs: bar * 112, energy: 1, kind: 'drop', startMs: bar * 16 },
        { endMs: bar * 128, energy: 0.2, kind: 'outro', startMs: bar * 112 },
    ],
    vocals: [{ endMs: 2_000, startMs: 1_000 }],
};

/** `[ms, kind]`. */
const SECTIONS: Array<[number, null | SectionKind]> = [
    [0, 'intro'],
    [bar * 16 - 0.001, 'intro'],
    [bar * 16, 'drop'],
    [bar * 112, 'outro'],
    [bar * 200, 'outro'],
    [-1, null],
];

/** `[vocals state, from, to, may sing]`. */
const SINGING: Array<['found' | 'none' | 'unknown', number, number, boolean]> = [
    ['found', 500, 1_500, true],
    ['found', 1_500, 1_600, true],
    ['found', 2_000, 3_000, false],
    ['found', 0, 1_000, false],
    ['found', 0, 1_000.001, true],
    ['none', 0, 1_000_000, false],
    ['unknown', 100_000, 100_001, true],
];

/** `[phrase bars, anchor ms, ms, bar ms, phrase start]`. */
const PHRASES: Array<[null | number, null | number, number, number, null | number]> = [
    [16, 0, bar * 21, bar, bar * 16],
    [16, 0, bar * 16, bar, bar * 16],
    [16, 0, bar * 15.999, bar, 0],
    [16, 100, 100 + bar * 17, bar, 100 + bar * 16],
    [16, 100, 50, bar, 100 - bar * 16],
    [8, 0, bar * 21, bar, bar * 16],
    [32, 0, bar * 21, bar, 0],
    [null, null, 10, bar, null],
    [16, null, 10, bar, null],
    [16, 0, 10, 0, null],
];

/** `[rate, tempo factor]`. */
const TEMPI: Array<[number, number]> = [
    [1, 1],
    [1.019, 1],
    [1.02, 1],
    [0.98, 1],
    [1.04, 0.5],
    [0.96, 0.5],
    [1.06, 0],
    [1.1, 0],
];

/** `[exit kind, entry kind, sections factor]`. */
const SECTION_PAIRS: Array<[null | SectionKind, null | SectionKind, number]> = [
    ['outro', 'build', 1],
    ['breakdown', 'intro', 1],
    ['drop', 'drop', 0.3],
    ['drop', 'build', 0.7],
    ['build', 'drop', 0.45],
    ['intro', 'outro', 0.7],
    ['verse', 'verse', 0.7],
    ['chorus', 'chorus', 0.7],
    ['unknown', 'unknown', 0.6],
    [null, 'build', 0.5],
    ['outro', null, 0.5],
];

/** `[tempo, key, vocals, energy, sections, total, bars]`. */
const TOTALS: Array<[number, number, number, number, number, number, null | number]> = [
    [1, 1, 1, 1, 1, 1, 32],
    [1, 0.5, 0.5, 0.5, 0.5, 0.6000000000000001, 16],
    [0.4, 0, 0.5, 0.5, 0.5, 0.38, 8],
    [0, 0, 0.5, 0, 0.2, 0.125, null],
    [1, 1, 0.5, 0.5, 0.7, 0.75, 32],
    [0.75, 0.5, 0.5, 0.5, 0.5, 0.55, 16],
    [0.7499, 0.5, 0.5, 0.5, 0.5, 0.54998, 8],
    [0, 0.5, 0.5, 0.25, 0.5, 0.35, 8],
    [0, 0.5, 0.5, 0.2499, 0.5, 0.34997999999999996, null],
];

const arrangementWith = (state: 'found' | 'none' | 'unknown'): Arrangement => ({
    ...record,
    vocals: state === 'found' ? record.vocals : state === 'none' ? [] : null,
});

describe('arrangement parity', () => {
    it.each(SECTIONS)('at %s ms the section is %s', (ms, kind) => {
        expect(sectionAt(record, ms)?.kind ?? null).toBe(kind);
    });

    it.each(SINGING)('vocals %s, %s–%s ms: may sing %s', (state, from, to, sings) => {
        expect(maySing(arrangementWith(state), from, to)).toBe(sings);
    });

    it.each(PHRASES)(
        'phrases of %s from %s: at %s ms the phrase starts at %s',
        (phraseBars, anchor, ms, barMs, start) => {
            const found = phraseStartAtOrBefore(
                { ...record, phraseAnchorMs: anchor, phraseBars },
                ms,
                barMs,
            );
            if (start === null) expect(found).toBeNull();
            else expect(Math.abs(found! - start)).toBeLessThan(1e-9);
        },
    );

    it.each(TEMPI)('a rate of %s scores %s', (rate, factor) => {
        expect(Math.abs(tempoFactor(rate) - factor)).toBeLessThan(1e-12);
    });

    it.each(SECTION_PAIRS)('out of %s into %s scores %s', (exit, entry, factor) => {
        expect(Math.abs(sectionsFactor(exit, entry) - factor)).toBeLessThan(1e-12);
    });

    it('the remaining factors', () => {
        expect(keyFactor('8A', '9A')).toBe(1);
        expect(keyFactor('3B', '10B')).toBe(0);
        expect(keyFactor(null, '8A')).toBe(0.5);
        expect(vocalsFactor(false, false)).toBe(1);
        expect(vocalsFactor(true, false)).toBe(0.6);
        expect(vocalsFactor(null, false)).toBe(0.5);
        expect(energyFactor(0.5, 0.5)).toBe(1);
        expect(Math.abs(energyFactor(0.9, 0.2) - 0.3)).toBeLessThan(1e-12);
        expect(energyFactor(null, 0.5)).toBe(0.5);
    });

    it.each(TOTALS)(
        '%s %s %s %s %s totals %s and earns %s bars',
        (tempo, key, vocals, energy, sections, total, bars) => {
            const score: MixScore = { energy, key, sections, tempo, vocals };
            expect(Math.abs(scoreTotal(score) - total)).toBeLessThan(1e-15);
            expect(scoreBars(score)).toBe(bars);
        },
    );

    it('answers every case in the tables', () => {
        expect(SECTIONS).toHaveLength(6);
        expect(SINGING).toHaveLength(7);
        expect(PHRASES).toHaveLength(10);
        expect(TEMPI).toHaveLength(8);
        expect(SECTION_PAIRS).toHaveLength(11);
        expect(TOTALS).toHaveLength(9);
    });
});
