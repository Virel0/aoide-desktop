import { describe, expect, it } from 'vitest';

import { MIN_TRIM_MS, shouldAdvance, trimFor } from './trim-plan';

describe('trimFor', () => {
    // The spec's own example: 2 s of silence, 3 s of tone, 2.5 s of silence.
    it('turns the sidecar’s milliseconds into seconds to play between', () => {
        expect(trimFor({ soundEndMs: 5200, soundStartMs: 1940 }, 7500)).toEqual({
            endSec: 5.2,
            startSec: 1.94,
        });
    });

    it('plays whole when the sidecar said there is nothing to trim', () => {
        expect(trimFor(null, 200_000)).toBeNull();
    });

    it('plays whole when nothing is known yet', () => {
        expect(trimFor(undefined, 200_000)).toBeNull();
    });

    // A seek costs a stall; under 300 ms it costs more than it saves.
    it('does not seek for a lead-in under the minimum', () => {
        expect(trimFor({ soundEndMs: 5200, soundStartMs: MIN_TRIM_MS - 1 }, 7500)).toEqual({
            endSec: 5.2,
            startSec: 0,
        });
        expect(trimFor({ soundEndMs: 5200, soundStartMs: MIN_TRIM_MS }, 7500)?.startSec).toBe(0.3);
    });

    it('does not cut a tail under the minimum', () => {
        expect(trimFor({ soundEndMs: 7500 - MIN_TRIM_MS + 1, soundStartMs: 1940 }, 7500)).toEqual({
            endSec: null,
            startSec: 1.94,
        });
        expect(trimFor({ soundEndMs: 7500 - MIN_TRIM_MS, soundStartMs: 1940 }, 7500)?.endSec).toBe(
            7.2,
        );
    });

    it('is no plan at all when neither end is worth it', () => {
        expect(trimFor({ soundEndMs: 7400, soundStartMs: 100 }, 7500)).toBeNull();
    });

    // A bound past the file is a file replaced since it was measured.
    it('refuses an end beyond the track’s length', () => {
        expect(trimFor({ soundEndMs: 8000, soundStartMs: 1940 }, 7500)).toEqual({
            endSec: null,
            startSec: 1.94,
        });
    });

    it('trusts the end when the length is not known', () => {
        expect(trimFor({ soundEndMs: 5200, soundStartMs: 1940 })?.endSec).toBe(5.2);
        expect(trimFor({ soundEndMs: 5200, soundStartMs: 1940 }, 0)?.endSec).toBe(5.2);
        expect(trimFor({ soundEndMs: 5200, soundStartMs: 1940 }, null)?.endSec).toBe(5.2);
    });

    it('refuses bounds that are not a span', () => {
        expect(trimFor({ soundEndMs: 1000, soundStartMs: 2000 }, 7500)).toBeNull();
        expect(trimFor({ soundEndMs: 2000, soundStartMs: 2000 }, 7500)).toBeNull();
        expect(trimFor({ soundEndMs: Number.NaN, soundStartMs: 2000 }, 7500)).toBeNull();
    });

    it('rounds to the millisecond, never to the second', () => {
        expect(trimFor({ soundEndMs: 5200.4, soundStartMs: 1940.6 }, 7500)).toEqual({
            endSec: 5.2,
            startSec: 1.941,
        });
    });
});

describe('shouldAdvance', () => {
    it('advances at the bound and past it, not before', () => {
        expect(shouldAdvance(5.1, 5.2)).toBe(false);
        expect(shouldAdvance(5.2, 5.2)).toBe(true);
        expect(shouldAdvance(5.3, 5.2)).toBe(true);
    });

    it('never advances a track that plays to its own end', () => {
        expect(shouldAdvance(9999, null)).toBe(false);
    });

    it('never advances on a time that is not one', () => {
        expect(shouldAdvance(Number.NaN, 5.2)).toBe(false);
    });
});
