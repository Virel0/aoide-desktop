import { describe, expect, it } from 'vitest';

import { isAlbumRun, MixTrack, planTransition, tempiAgree, tempoHolds } from './mix-transition';

/**
 * The parity table in `mix-transition-parity.test.ts` covers the rules the two
 * apps share. What is left here is what only the desktop can be handed: an
 * `<audio>` element whose duration is `Infinity` or `NaN`, and a tempo field
 * that arrived as `undefined` rather than a measured `null`. Swift's types
 * cannot express any of those, so they have no twin to agree with.
 */

const track = (fields: Partial<MixTrack> = {}): MixTrack => ({
    album: 'Album',
    bpm: null,
    bpmStability: null,
    durationSeconds: 240,
    sound: null,
    trackNumber: null,
    ...fields,
});

const plan = (outgoing: MixTrack, incoming: MixTrack) =>
    planTransition({ albumLock: true, automix: true, incoming, outgoing });

describe('a length that is not a number', () => {
    it('a stream of unknown length is a cut rather than a share of infinity', () => {
        expect(plan(track(), track({ album: 'Other', durationSeconds: Infinity }))).toEqual({
            kind: 'cut',
            overlapSeconds: 0,
        });
    });

    it('a duration read before metadata arrived is a cut too', () => {
        expect(plan(track({ durationSeconds: NaN }), track({ album: 'Other' }))).toEqual({
            kind: 'cut',
            overlapSeconds: 0,
        });
    });

    it('measured bounds that are not numbers are no measurement', () => {
        const nonsense = track({
            album: 'Other',
            sound: { soundEndSeconds: Infinity, soundStartSeconds: 0 },
        });
        expect(plan(track(), nonsense)).toEqual({ kind: 'cut', overlapSeconds: 0 });
    });

    it('bounds that end before they start leave nothing to fade', () => {
        // The phone clamps this to zero and the desktop copies the clamp, but
        // neither is observable from out here: a negative share and a zero
        // share are both under the two-second floor, so both are cuts. The
        // clamp is kept for the parity, the outcome is what is pinned.
        const backwards = track({
            album: 'Other',
            sound: { soundEndSeconds: 10, soundStartSeconds: 40 },
        });
        expect(plan(track(), backwards)).toEqual({ kind: 'cut', overlapSeconds: 0 });
    });
});

describe('a tempo that was never set', () => {
    it('undefined is not an agreement', () => {
        expect(tempiAgree(undefined, 128)).toBe(false);
        expect(tempiAgree(128, undefined)).toBe(false);
    });

    it('and neither is a tempo that is not a number', () => {
        expect(tempiAgree(NaN, 128)).toBe(false);
        expect(tempiAgree(Infinity, 128)).toBe(false);
        expect(tempiAgree(-128, -128)).toBe(false);
    });
});

describe('a stability that was never set', () => {
    it('undefined is a server that never measured it, not an unsteady track', () => {
        expect(tempoHolds(undefined)).toBe(true);
        expect(tempoHolds(null)).toBe(true);
    });

    it('a number that is not a number is not a measurement that holds', () => {
        // The absent case is generous on purpose; this one is not, and Swift
        // agrees by arithmetic — a comparison against NaN is false there too.
        expect(tempoHolds(NaN)).toBe(false);
    });
});

describe('an album run', () => {
    it('needs the same non-empty album and the next number', () => {
        const four = track({ album: 'Dark Side', trackNumber: 4 });
        expect(isAlbumRun(four, track({ album: 'Dark Side', trackNumber: 5 }))).toBe(true);
        expect(isAlbumRun(four, track({ album: 'Dark Side', trackNumber: 6 }))).toBe(false);
        expect(isAlbumRun(four, track({ album: 'Dark Side', trackNumber: 4 }))).toBe(false);
    });
});
