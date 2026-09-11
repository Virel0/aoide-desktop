import { describe, expect, it } from 'vitest';

import type { NextMode } from './next-chooser';
import type { NextLibrary, NextRecord } from './next-ranking';

import { rankNext } from './next-ranking';
import fixture from './next-ranking-fixture.json';

/**
 * The `/aoide/next` parity fixture — `docs/infinity.md` §5 in the iOS repo.
 *
 * `next-ranking-fixture.json` is byte-for-byte the phone's copy: a
 * hand-written library, a history, a flag, and four requests with every score
 * and factor the rule gives. The sidecar reads the same file. Six decimals,
 * as the taste table.
 */
type Case = {
    expected: {
        candidates: {
            factors: {
                arc: number;
                freshness: number;
                kinship: null | number;
                mixability: null | number;
                similarity: number;
                taste: number;
            };
            id: string;
            score: number;
        }[];
        events: number;
    };
    limit: number;
    mode: NextMode;
    name: string;
    queue: string[];
    recent: string[];
    seed: string;
};

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const library: NextLibrary = {
    notInterested: new Set(fixture.notInterested),
    now: fixture.now,
    plays: fixture.plays,
    records: fixture.library.map(
        (record): NextRecord => ({
            artist: record.artist,
            bpm: record.bpm ?? null,
            bpmStability: record.bpmStability ?? null,
            genres: record.genres,
            id: record.id,
            key: record.key ?? null,
            sections: record.sections ?? null,
        }),
    ),
};

describe('what plays next, held to the fixture', () => {
    it('is the fixture the phone generated', () => {
        expect(fixture.tasteWindowDays).toBe(90);
        expect(fixture.cases).toHaveLength(8);
    });

    it.each((fixture.cases as Case[]).map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
        const table: Record<string, number> =
            (fixture as { mixability?: Record<string, number> }).mixability ?? {};
        const { events, results } = rankNext(
            {
                limit: testCase.limit,
                mode: testCase.mode,
                queue: testCase.queue,
                recent: testCase.recent,
                seed: testCase.seed,
            },
            library,
            (from, to) => table[`${from}>${to}`] ?? null,
        );

        expect(events).toBe(testCase.expected.events);
        expect(results.map((r) => r.id)).toEqual(testCase.expected.candidates.map((c) => c.id));
        for (const [i, want] of testCase.expected.candidates.entries()) {
            const got = results[i];
            expect(round6(got.score), `${want.id} score`).toBeCloseTo(want.score, 6);
            expect(round6(got.factors.taste), `${want.id} taste`).toBeCloseTo(
                want.factors.taste,
                6,
            );
            expect(got.factors.kinship, `${want.id} kinship`).toBe(want.factors.kinship);
            expect(got.factors.freshness, `${want.id} freshness`).toBe(want.factors.freshness);
            expect(round6(got.factors.similarity), `${want.id} similarity`).toBeCloseTo(
                want.factors.similarity,
                6,
            );
            expect(got.factors.mixability, `${want.id} mixability`).toBe(want.factors.mixability);
            expect(round6(got.factors.arc), `${want.id} arc`).toBeCloseTo(want.factors.arc, 6);
        }
    });
});
