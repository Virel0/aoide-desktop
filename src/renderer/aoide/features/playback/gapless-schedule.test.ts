import { describe, expect, it } from 'vitest';

import {
    BufferPlayback,
    DECODE_LEAD_SECONDS,
    ElementPlayback,
    endsAt,
    estimateDecodedBytes,
    fitsInMemory,
    JoinRequest,
    MAX_TRACK_BYTES,
    outgoingEndSec,
    planJoin,
    SCHEDULE_LEAD_SECONDS,
    SCHEDULE_WINDOW_SECONDS,
    shouldDecode,
} from './gapless-schedule';

const element = (positionSec: number, sampledAtContextTime = 500): ElementPlayback => ({
    kind: 'element',
    positionSec,
    sampledAtContextTime,
});

const buffer = (offsetSec: number, startedAtContextTime: number): BufferPlayback => ({
    kind: 'buffer',
    offsetSec,
    startedAtContextTime,
});

/**
 * A 240-second track whose element was at 238 s when the clock read 500, asked
 * about at 501 — one second before the boundary, inside the window and well
 * clear of the lead.
 */
const request = (overrides: Partial<JoinRequest> = {}): JoinRequest => ({
    endSec: 240,
    incomingDurationSec: 200,
    incomingStartSec: 0,
    now: 501,
    outgoing: element(238),
    ...overrides,
});

describe('where the outgoing track ends, on the context clock', () => {
    it('carries an element sample forward by the time it has left', () => {
        // 240 − 238 = two seconds of track left, so the boundary is at 502.
        expect(endsAt(element(238), 240)).toBe(502);
    });

    it('does not confuse the element position with the boundary', () => {
        expect(endsAt(element(100, 500), 240)).toBe(640);
        expect(endsAt(element(200, 500), 240)).toBe(540);
    });

    it('reads a buffer source off the numbers start() was given', () => {
        // Started at context 500 from the top; a 240 s track ends at 740.
        expect(endsAt(buffer(0, 500), 240)).toBe(740);
    });

    it('subtracts the offset a buffer was started at', () => {
        // Started at 500 but three seconds in, so only 237 seconds are left.
        expect(endsAt(buffer(3, 500), 240)).toBe(737);
    });

    it('puts a boundary already gone past in the past', () => {
        expect(endsAt(element(250, 500), 240)).toBe(490);
    });

    it('has no answer without a usable end', () => {
        expect(endsAt(element(238), Number.POSITIVE_INFINITY)).toBeNull();
        expect(endsAt(element(238), Number.NaN)).toBeNull();
        expect(endsAt(element(238), 0)).toBeNull();
        expect(endsAt(element(238), -1)).toBeNull();
    });

    it('has no answer without a usable reading', () => {
        expect(endsAt(element(Number.NaN), 240)).toBeNull();
        expect(endsAt(element(-1), 240)).toBeNull();
        expect(endsAt(element(238, Number.NaN), 240)).toBeNull();
        expect(endsAt(buffer(Number.NaN, 500), 240)).toBeNull();
        expect(endsAt(buffer(0, Number.POSITIVE_INFINITY), 240)).toBeNull();
    });
});

describe('resolving where a track stops', () => {
    it('plays to its own end when nothing was measured', () => {
        expect(outgoingEndSec(null, 240)).toBe(240);
    });

    it('stops at the measured end of the sound', () => {
        expect(outgoingEndSec(238.5, 240)).toBe(238.5);
    });

    it('refuses an end past the end of the file', () => {
        expect(outgoingEndSec(241, 240)).toBe(240);
        expect(outgoingEndSec(240, 240)).toBe(240);
    });

    it('refuses an end at or before the beginning of it', () => {
        expect(outgoingEndSec(0, 240)).toBe(240);
        expect(outgoingEndSec(-5, 240)).toBe(240);
        expect(outgoingEndSec(Number.NaN, 240)).toBe(240);
    });

    // The web player reports Infinity for a stream whose length the server
    // never sent, and a join planned against infinity is not a join.
    it('has no answer for a length that is not one', () => {
        expect(outgoingEndSec(238.5, Number.POSITIVE_INFINITY)).toBeNull();
        expect(outgoingEndSec(null, Number.NaN)).toBeNull();
        expect(outgoingEndSec(null, 0)).toBeNull();
        expect(outgoingEndSec(null, -1)).toBeNull();
    });
});

describe('planning the join', () => {
    it('starts the incoming track the moment the outgoing one stops', () => {
        expect(planJoin(request())).toEqual({
            kind: 'join',
            offsetSec: 0,
            startAtContextTime: 502,
        });
    });

    it('joins at the trimmed end rather than the end of the file', () => {
        // The same element sample, but the sound stops 1.5 s before the file
        // does, so the join comes 1.5 s sooner.
        expect(planJoin(request({ endSec: 238.5, now: 499 }))).toEqual({
            kind: 'join',
            offsetSec: 0,
            startAtContextTime: 500.5,
        });
    });

    it('starts the incoming track past its lead-in', () => {
        expect(planJoin(request({ incomingStartSec: 1.94 }))).toEqual({
            kind: 'join',
            offsetSec: 1.94,
            startAtContextTime: 502,
        });
    });

    it('trims both ends at once', () => {
        expect(planJoin(request({ endSec: 238.5, incomingStartSec: 1.94, now: 499 }))).toEqual({
            kind: 'join',
            offsetSec: 1.94,
            startAtContextTime: 500.5,
        });
    });

    it('is exact when the outgoing track is itself a buffer', () => {
        expect(planJoin(request({ endSec: 180, now: 497, outgoing: buffer(1.5, 320) }))).toEqual({
            kind: 'join',
            offsetSec: 0,
            startAtContextTime: 498.5,
        });
    });

    it('accounts for a buffer that was started past its own lead-in', () => {
        // Both started at 320; the one that began 1.5 s in has 1.5 s less to run.
        const withOffset = request({
            endSec: 181.5,
            now: 499,
            outgoing: buffer(1.5, 320),
            windowSec: 5,
        });
        const withoutOffset = request({ ...withOffset, outgoing: buffer(0, 320) });
        expect(planJoin(withOffset)).toMatchObject({ startAtContextTime: 500 });
        expect(planJoin(withoutOffset)).toMatchObject({ startAtContextTime: 501.5 });
    });

    it('will not commit to a boundary further off than the window', () => {
        expect(planJoin(request({ now: 499.9 }))).toEqual({ kind: 'no-join', reason: 'early' });
    });

    it('commits at exactly the edge of the window', () => {
        expect(planJoin(request({ now: 502 - SCHEDULE_WINDOW_SECONDS }))).toMatchObject({
            kind: 'join',
            startAtContextTime: 502,
        });
    });

    it('gives up on a sample taken too late to schedule', () => {
        expect(planJoin(request({ now: 502 - SCHEDULE_LEAD_SECONDS / 2 }))).toEqual({
            kind: 'no-join',
            reason: 'late',
        });
    });

    // A lead that is exact in binary, so the edge really is the edge: the
    // default 0.05 does not subtract cleanly and would leave the comparison
    // free to be either of < and <=.
    it('schedules with exactly the lead it asks for, and not a sample less', () => {
        expect(planJoin(request({ leadSec: 0.5, now: 501.5 }))).toMatchObject({
            kind: 'join',
            startAtContextTime: 502,
        });
        expect(planJoin(request({ leadSec: 0.5, now: 501.75 }))).toEqual({
            kind: 'no-join',
            reason: 'late',
        });
    });

    it('gives up on a boundary that has already gone past', () => {
        expect(planJoin(request({ now: 510 }))).toEqual({ kind: 'no-join', reason: 'late' });
    });

    it('honours a lead and a window of its own', () => {
        expect(planJoin(request({ now: 490, windowSec: 12 }))).toMatchObject({ kind: 'join' });
        expect(planJoin(request({ leadSec: 5, windowSec: 10 }))).toEqual({
            kind: 'no-join',
            reason: 'late',
        });
    });

    // A start that does not fit inside the decoded buffer describes some other
    // file. Playing this one whole loses a fraction of a second; refusing the
    // join loses the join.
    it('treats a lead-in outside the buffer as no lead-in at all', () => {
        expect(planJoin(request({ incomingStartSec: 200 }))).toEqual({
            kind: 'join',
            offsetSec: 0,
            startAtContextTime: 502,
        });
        expect(planJoin(request({ incomingStartSec: 400 }))).toMatchObject({ offsetSec: 0 });
        expect(planJoin(request({ incomingStartSec: -3 }))).toMatchObject({ offsetSec: 0 });
        expect(planJoin(request({ incomingStartSec: Number.NaN }))).toMatchObject({ offsetSec: 0 });
    });

    it('refuses a boundary it cannot locate', () => {
        expect(planJoin(request({ endSec: Number.POSITIVE_INFINITY }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
        expect(planJoin(request({ outgoing: element(Number.NaN) }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
        expect(planJoin(request({ now: Number.NaN }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
    });

    it('refuses an incoming buffer that is not one', () => {
        expect(planJoin(request({ incomingDurationSec: 0 }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
        expect(planJoin(request({ incomingDurationSec: Number.NaN }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
    });

    it('refuses a lead and a window that make no sense together', () => {
        expect(planJoin(request({ leadSec: -1 }))).toEqual({ kind: 'no-join', reason: 'unusable' });
        expect(planJoin(request({ leadSec: 3, windowSec: 2 }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
        expect(planJoin(request({ windowSec: Number.POSITIVE_INFINITY }))).toEqual({
            kind: 'no-join',
            reason: 'unusable',
        });
    });
});

describe('deciding when to decode', () => {
    it('waits until the boundary is inside the lead', () => {
        expect(shouldDecode(DECODE_LEAD_SECONDS + 0.5)).toBe(false);
        expect(shouldDecode(DECODE_LEAD_SECONDS)).toBe(true);
        expect(shouldDecode(4)).toBe(true);
    });

    it('takes a lead of its own', () => {
        expect(shouldDecode(20, 10)).toBe(false);
        expect(shouldDecode(9, 10)).toBe(true);
    });

    it('does not decode for a boundary nothing can locate', () => {
        expect(shouldDecode(Number.POSITIVE_INFINITY)).toBe(false);
        expect(shouldDecode(Number.NaN)).toBe(false);
    });
});

describe('what a decoded track costs', () => {
    it('charges four bytes a sample a channel', () => {
        // Four minutes of 44.1 kHz stereo: 240 × 44100 × 2 × 4.
        expect(estimateDecodedBytes(240, 44100)).toBe(84_672_000);
        expect(estimateDecodedBytes(240, 44100, 1)).toBe(42_336_000);
    });

    it('charges the rate of the context rather than that of the file', () => {
        expect(estimateDecodedBytes(240, 96000)).toBe(184_320_000);
    });

    it('rounds a part sample up', () => {
        expect(estimateDecodedBytes(0.5, 44101)).toBe(176_408);
    });

    it('costs everything when the question is malformed', () => {
        expect(estimateDecodedBytes(Number.POSITIVE_INFINITY, 44100)).toBe(
            Number.POSITIVE_INFINITY,
        );
        expect(estimateDecodedBytes(240, Number.NaN)).toBe(Number.POSITIVE_INFINITY);
        expect(estimateDecodedBytes(0, 44100)).toBe(Number.POSITIVE_INFINITY);
    });

    it('fits an ordinary track and refuses a very long one', () => {
        expect(fitsInMemory(240, 44100)).toBe(true);
        // Twenty minutes of 44.1 kHz stereo is over four hundred megabytes.
        expect(fitsInMemory(1200, 44100)).toBe(false);
        expect(fitsInMemory(240, Number.NaN)).toBe(false);
    });

    it('fits a track sitting exactly on the cap and refuses one sample more', () => {
        const samplesPerChannel = MAX_TRACK_BYTES / 8;
        expect(fitsInMemory(1, samplesPerChannel)).toBe(true);
        expect(fitsInMemory(1, samplesPerChannel + 1)).toBe(false);
    });
});
