import { describe, expect, it } from 'vitest';

import {
    ABSENT_RETRY_MS,
    applyFailure,
    applyReply,
    ASKED_TIMEOUT_MS,
    MeasurementEntry,
    needsAsking,
    PENDING_RETRY_MS,
    takeToAsk,
    valueOf,
} from './measurement-cache';

/**
 * The same four states as the two caches before it, over any row. The rows
 * here are strings, because the cache must not care what it holds.
 */
type Entry = MeasurementEntry<string>;

describe('needsAsking', () => {
    it('asks for a track it has never heard of', () => {
        expect(needsAsking(undefined, 1000)).toBe(true);
    });

    it('never asks again for an answer', () => {
        expect(needsAsking({ kind: 'value', value: 'grid' }, 1e12)).toBe(false);
        expect(needsAsking({ kind: 'none' }, 1e12)).toBe(false);
    });

    it('asks again for a pending track after a minute, not before', () => {
        const entry: Entry = { askedAt: 1000, kind: 'pending' };
        expect(needsAsking(entry, 1000 + PENDING_RETRY_MS - 1)).toBe(false);
        expect(needsAsking(entry, 1000 + PENDING_RETRY_MS)).toBe(true);
    });

    it('does not ask twice while a request is in flight, unless it is presumed lost', () => {
        const entry: Entry = { askedAt: 1000, kind: 'asked' };
        expect(needsAsking(entry, 1000 + ASKED_TIMEOUT_MS - 1)).toBe(false);
        expect(needsAsking(entry, 1000 + ASKED_TIMEOUT_MS)).toBe(true);
    });
});

describe('valueOf', () => {
    it('distinguishes "nothing to report" from "not known yet"', () => {
        expect(valueOf({ kind: 'none' })).toBeNull();
        expect(valueOf(undefined)).toBeUndefined();
        expect(valueOf({ askedAt: 0, kind: 'asked' })).toBeUndefined();
        expect(valueOf({ askedAt: 0, kind: 'pending' })).toBeUndefined();
        expect(valueOf({ kind: 'value', value: 'grid' })).toBe('grid');
    });
});

describe('takeToAsk', () => {
    it('takes what needs asking, once each, and marks it in flight', () => {
        const entries = new Map<string, Entry>([['known', { kind: 'none' }]]);
        expect(takeToAsk(entries, ['a', 'known', 'a', '', 'b'], 1000)).toEqual(['a', 'b']);
        expect(entries.get('a')).toEqual({ askedAt: 1000, kind: 'asked' });
        expect(takeToAsk(entries, ['a', 'b'], 1001)).toEqual([]);
    });
});

describe('applyReply', () => {
    it('keeps values, "nothing to report", and "ask again later" apart', () => {
        const entries = new Map<string, Entry>();
        const asked = takeToAsk(entries, ['a', 'b', 'c', 'd'], 1000);
        applyReply(entries, asked, { pending: ['c'], rows: { a: 'grid', b: null } }, 2000);

        expect(entries.get('a')).toEqual({ kind: 'value', value: 'grid' });
        expect(entries.get('b')).toEqual({ kind: 'none' });
        expect(entries.get('c')).toEqual({ askedAt: 2000, kind: 'pending' });
    });

    // The contract: unknown ids are omitted, not an error. Nothing is coming.
    it('treats an id the server named in neither list as nothing to report', () => {
        const entries = new Map<string, Entry>();
        const asked = takeToAsk(entries, ['d'], 1000);
        applyReply(entries, asked, { pending: [], rows: {} }, 2000);
        expect(entries.get('d')).toEqual({ kind: 'none' });
    });

    it('leaves tracks it did not ask about alone', () => {
        const entries = new Map<string, Entry>([['z', { kind: 'none' }]]);
        applyReply(entries, [], { pending: [], rows: { z: 'grid' } }, 2000);
        expect(entries.get('z')).toEqual({ kind: 'none' });
    });
});

describe('applyFailure', () => {
    it('lets a failed ask be asked again at once', () => {
        const entries = new Map<string, Entry>();
        const asked = takeToAsk(entries, ['a'], 1000);
        applyFailure(entries, asked);
        expect(needsAsking(entries.get('a'), 1001)).toBe(true);
    });

    it('does not forget an answer that arrived in the meantime', () => {
        const entries = new Map<string, Entry>([['a', { kind: 'none' }]]);
        applyFailure(entries, ['a']);
        expect(entries.get('a')).toEqual({ kind: 'none' });
    });
});

describe('the sidecar without the endpoint', () => {
    it('is left alone for ten minutes, not one', () => {
        expect(ABSENT_RETRY_MS).toBeGreaterThan(PENDING_RETRY_MS);
    });
});
