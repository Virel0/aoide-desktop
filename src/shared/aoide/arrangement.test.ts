import { describe, expect, it } from 'vitest';

import {
    Arrangement,
    ArrangementSection,
    maySing,
    phraseStartAtOrBefore,
    sectionAt,
    SectionKind,
} from './arrangement';

const bar = (60_000 / 128) * 4;

/** Sections in bars, laid end to end. */
const arrangement = (
    parts: Array<[SectionKind, number, number]>,
    options: { phraseBars?: null | number; vocals?: Arrangement['vocals'] } = {},
): Arrangement => {
    const sections: ArrangementSection[] = [];
    let at = 0;
    for (const [kind, bars, energy] of parts) {
        sections.push({ endMs: at + bar * bars, energy, kind, startMs: at });
        at += bar * bars;
    }
    const phraseBars = options.phraseBars === undefined ? 16 : options.phraseBars;
    return {
        phraseAnchorMs: phraseBars === null ? null : 0,
        phraseBars,
        sections,
        vocals: options.vocals === undefined ? [] : options.vocals,
    };
};

describe('reading the arrangement', () => {
    const a = arrangement(
        [
            ['intro', 16, 0.1],
            ['drop', 96, 1],
            ['outro', 16, 0.2],
        ],
        {
            vocals: [{ endMs: 2_000, startMs: 1_000 }],
        },
    );

    it('finds the section holding a moment', () => {
        expect(sectionAt(a, 0)?.kind).toBe('intro');
        expect(sectionAt(a, bar * 16 - 0.001)?.kind).toBe('intro');
        expect(sectionAt(a, bar * 16)?.kind).toBe('drop');
        // Past the end: the last section that started before it.
        expect(sectionAt(a, bar * 200)?.kind).toBe('outro');
        // Before the start: nothing.
        expect(sectionAt(a, -1)).toBeNull();
        expect(sectionAt({ ...a, sections: [] }, 0)).toBeNull();
    });

    it('says whether anybody might be singing in a stretch', () => {
        expect(maySing(a, 500, 1_500)).toBe(true);
        expect(maySing(a, 1_500, 1_600)).toBe(true);
        expect(maySing(a, 2_000, 3_000)).toBe(false);
        expect(maySing(a, 0, 1_000)).toBe(false);
        expect(maySing(a, 0, 1_000.001)).toBe(true);
    });

    // The three states of `vocals`, and the one that trips people up.
    it('not being able to tell counts as singing throughout', () => {
        expect(maySing({ ...a, vocals: null }, 100_000, 100_001)).toBe(true);
        expect(maySing({ ...a, vocals: [] }, 0, 1_000_000)).toBe(false);
    });

    it('finds the phrase line at or before a moment', () => {
        expect(phraseStartAtOrBefore(a, bar * 21, bar)).toBeCloseTo(bar * 16, 6);
        expect(phraseStartAtOrBefore(a, bar * 16, bar)).toBeCloseTo(bar * 16, 6);
        expect(phraseStartAtOrBefore(a, bar * 15.999, bar)).toBeCloseTo(0, 6);
        // Anchored off zero.
        const shifted = { ...a, phraseAnchorMs: 100 };
        expect(phraseStartAtOrBefore(shifted, 100 + bar * 17, bar)).toBeCloseTo(100 + bar * 16, 6);
        // Behind the anchor, negative phrases are phrases.
        expect(phraseStartAtOrBefore(shifted, 50, bar)).toBeCloseTo(100 - bar * 16, 6);
    });

    it('has no phrase line without a phrase grid, or without a bar', () => {
        expect(phraseStartAtOrBefore(arrangement([], { phraseBars: null }), 10, bar)).toBeNull();
        expect(phraseStartAtOrBefore({ ...a, phraseAnchorMs: null }, 10, bar)).toBeNull();
        expect(phraseStartAtOrBefore(a, 10, 0)).toBeNull();
        expect(phraseStartAtOrBefore(a, 10, -1)).toBeNull();
    });
});
