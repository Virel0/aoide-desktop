import { describe, expect, it } from 'vitest';

import {
    buildNextRequest,
    NEXT_MAX_QUEUE,
    NEXT_MAX_RECENT,
    parseNextResponse,
    summariseNextFactors,
} from './next-chooser';

describe('asking the server what plays next', () => {
    it('sends the contract shape with the mode spelled as the server expects', () => {
        const request = buildNextRequest({
            limit: 20,
            mode: 'autodj',
            queue: ['q1', 'q2'],
            recent: ['r1'],
            seed: 's',
        });
        expect(JSON.parse(JSON.stringify(request))).toEqual({
            limit: 20,
            mode: 'autodj',
            queue: ['q1', 'q2'],
            recent: ['r1'],
            seed: 's',
        });
    });

    it('cuts a long queue and a long history from the far end rather than refusing', () => {
        const queue = Array.from({ length: 1200 }, (_, i) => `q${i}`);
        const recent = Array.from({ length: 60 }, (_, i) => `r${i}`);
        const request = buildNextRequest({ limit: 20, mode: 'infinity', queue, recent, seed: 's' });
        expect(request.queue).toHaveLength(NEXT_MAX_QUEUE);
        expect(request.queue[0]).toBe('q0');
        expect(request.queue[NEXT_MAX_QUEUE - 1]).toBe('q999');
        expect(request.recent).toHaveLength(NEXT_MAX_RECENT);
        expect(request.recent[0]).toBe('r0');
    });

    it('reads the answer with mixability absent outside Auto DJ, in the server order', () => {
        const response = parseNextResponse({
            candidates: [
                {
                    factors: {
                        arc: 0.9,
                        freshness: 1,
                        kinship: 1,
                        mixability: 0.79,
                        similarity: 0.62,
                        taste: 0.71,
                    },
                    id: 'a',
                    score: 0.83,
                },
                {
                    factors: {
                        arc: 0.5,
                        freshness: 0.5,
                        mixability: null,
                        similarity: 0.5,
                        taste: 0.2,
                    },
                    id: 'b',
                    score: 0.4,
                },
            ],
            profile: { events: 184, since: 1749600000000 },
        });
        expect(response?.candidates.map((c) => c.id)).toEqual(['a', 'b']);
        expect(response?.candidates[0].factors.mixability).toBe(0.79);
        expect(response?.candidates[1].factors.mixability).toBeNull();
        expect(response?.candidates[0].factors.kinship).toBe(1);
        expect(response?.candidates[1].factors.kinship).toBeNull();
        expect(response?.profile).toEqual({ events: 184, since: 1749600000000 });
    });

    it('drops a candidate missing a figure and refuses a body without the shape', () => {
        const response = parseNextResponse({
            candidates: [
                { factors: { arc: 0.5, freshness: 1, similarity: 0.5 }, id: 'broken', score: 0.1 },
                {
                    factors: { arc: 0.5, freshness: 1, similarity: 0.5, taste: 0.1 },
                    id: 'ok',
                    score: 0.2,
                },
            ],
        });
        expect(response?.candidates.map((c) => c.id)).toEqual(['ok']);
        expect(response?.profile.events).toBe(0);
        expect(parseNextResponse({ nope: true })).toBeUndefined();
        expect(parseNextResponse('html')).toBeUndefined();
    });

    it('summarises as percentages, names a mix only when there is one, and says what freshness cost', () => {
        expect(
            summariseNextFactors({
                arc: 0.9,
                freshness: 1,
                kinship: null,
                mixability: 0.79,
                similarity: 0.62,
                taste: 0.714,
            }),
        ).toBe('Taste 71% · Fits 62% · Mixes 79% · Arc 90%');
        expect(
            summariseNextFactors({
                arc: 0.9,
                freshness: 1,
                kinship: 1,
                mixability: 0.79,
                similarity: 0.62,
                taste: 0.714,
            }),
        ).toBe('Taste 71% · Kin 100% · Fits 62% · Mixes 79% · Arc 90%');
        expect(
            summariseNextFactors({
                arc: 0.5,
                freshness: 1,
                kinship: 1,
                mixability: 0.15,
                similarity: 0.5,
                taste: 0.2,
            }),
        ).toBe('Taste 20% · Kin 100% · Fits 50% · Crossfade · Arc 50%');
        expect(
            summariseNextFactors({
                arc: 0.5,
                freshness: 1,
                kinship: null,
                mixability: null,
                similarity: 0.5,
                taste: 0.2,
            }),
        ).toBe('Taste 20% · Fits 50% · Arc 50%');
        expect(
            summariseNextFactors({
                arc: 0.5,
                freshness: 0.5,
                kinship: null,
                mixability: null,
                similarity: 0.5,
                taste: 0.2,
            }),
        ).toMatch(/· same artist lately$/);
        expect(
            summariseNextFactors({
                arc: 0.5,
                freshness: 0,
                kinship: null,
                mixability: null,
                similarity: 0.5,
                taste: 0.2,
            }),
        ).toMatch(/· heard lately$/);
    });
});
