import { describe, expect, it } from 'vitest';

import { MixTrack, planTransition } from './mix-transition';

/**
 * The same thirty-one pairs the iOS app plans, with the same thirty-one plans.
 *
 * "Both apps mix the same way" is a claim, and this table is the only thing
 * that makes it one: it is duplicated verbatim in `MixTransitionParityTests`
 * in Packages/PlaybackKit, so either side changing a constant, a tolerance or
 * an ordering breaks its own copy. The overlaps are exact numbers rather than
 * "about eight seconds" on purpose — two planners a tenth of a second apart
 * are still two planners.
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

const TABLE: Array<{
    albumLock: boolean;
    automix: boolean;
    incoming: MixTrack;
    kind: string;
    outgoing: MixTrack;
    overlapSeconds: number;
    why: string;
}> = [
    {
        albumLock: true,
        automix: false,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'cut',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 0,
        why: 'the mixer off leaves the handover alone',
    },
    {
        albumLock: true,
        automix: false,
        incoming: track({ album: 'Dark Side', trackNumber: 5 }),
        kind: 'gapless',
        outgoing: track({ album: 'Dark Side', trackNumber: 4 }),
        overlapSeconds: 0,
        why: 'an album run is gapless with the mixer off too',
    },
    {
        albumLock: false,
        automix: false,
        incoming: track({ album: 'Dark Side', trackNumber: 5 }),
        kind: 'cut',
        outgoing: track({ album: 'Dark Side', trackNumber: 4 }),
        overlapSeconds: 0,
        why: 'album lock is the mixer’s off-switch, never a second mixer',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Dark Side', bpm: 140, trackNumber: 5 }),
        kind: 'gapless',
        outgoing: track({ album: 'Dark Side', bpm: 90, trackNumber: 4 }),
        overlapSeconds: 0,
        why: 'a record that segues is never handed to the mixer',
    },
    {
        albumLock: false,
        automix: true,
        incoming: track({ album: 'Dark Side', bpm: 128, trackNumber: 5 }),
        kind: 'blend',
        outgoing: track({ album: 'Dark Side', bpm: 128, trackNumber: 4 }),
        overlapSeconds: 8,
        why: 'album lock off lets the mixer work across a record',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ bpm: 124 }),
        overlapSeconds: 8,
        why: 'agreeing tempi earn the long blend',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 170 }),
        kind: 'blend',
        outgoing: track({ bpm: 85 }),
        overlapSeconds: 8,
        why: 'half time is one groove counted twice',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 32 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 8,
        why: 'two octaves apart is still one groove',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ bpm: 100 }),
        overlapSeconds: 4,
        why: 'genuinely different speeds get the short blend',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 127.2 }),
        kind: 'blend',
        outgoing: track({ bpm: 120 }),
        overlapSeconds: 8,
        why: 'six per cent apart is inside the tolerance',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ bpm: 120 }),
        overlapSeconds: 4,
        why: 'just past six per cent is outside it',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other' }),
        kind: 'blend',
        outgoing: track(),
        overlapSeconds: 4,
        why: 'nothing measured is not an agreement',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other' }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 4,
        why: 'one measured tempo is not an agreement either',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ bpm: 0 }),
        overlapSeconds: 4,
        why: 'a zero tempo is not a measurement',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Dark Side', bpm: 128, trackNumber: 1 }),
        kind: 'blend',
        outgoing: track({ album: 'Dark Side', bpm: 128, trackNumber: 9 }),
        overlapSeconds: 8,
        why: 'out of order on one record is not a run',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Wish You Were Here', bpm: 128, trackNumber: 10 }),
        kind: 'blend',
        outgoing: track({ album: 'Dark Side', bpm: 128, trackNumber: 9 }),
        overlapSeconds: 8,
        why: 'the next number on another record is not a run',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: '', bpm: 128, trackNumber: 5 }),
        kind: 'blend',
        outgoing: track({ album: '', bpm: 128, trackNumber: 4 }),
        overlapSeconds: 8,
        why: 'two untitled albums are not one record',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Dark Side', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ album: 'Dark Side', bpm: 128 }),
        overlapSeconds: 8,
        why: 'one album without track numbers is not a run',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 20 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 5,
        why: 'a short track keeps three quarters of itself',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 32 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 8,
        why: 'exactly a quarter of the shorter track is allowed',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 20 }),
        kind: 'blend',
        outgoing: track({ bpm: 100 }),
        overlapSeconds: 4,
        why: 'a short blend under the share is not lengthened to it',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 8 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 2,
        why: 'two seconds of overlap is still a transition',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 7.9 }),
        kind: 'cut',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 0,
        why: 'a hair under two seconds is not',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: 6 }),
        kind: 'cut',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 0,
        why: 'a sting is too short to fade at all',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, durationSeconds: null }),
        kind: 'cut',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 0,
        why: 'an unknown length ahead is a cut, not a guess',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'cut',
        outgoing: track({ bpm: 128, durationSeconds: null }),
        overlapSeconds: 0,
        why: 'an unknown length behind is a cut too',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({
            album: 'Other',
            bpm: 128,
            durationSeconds: 120,
            sound: { soundEndSeconds: 110, soundStartSeconds: 100 },
        }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 2.5,
        why: 'measured sound, not file length, is what there is to fade',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128 }),
        kind: 'blend',
        outgoing: track({ bpm: 128, bpmStability: 0.2 }),
        overlapSeconds: 4,
        why: 'a track whose tempo does not hold is nothing to match to',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, bpmStability: 0.4 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 4,
        why: 'and neither is one coming up',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, bpmStability: 0.5 }),
        kind: 'blend',
        outgoing: track({ bpm: 128, bpmStability: 0.5 }),
        overlapSeconds: 8,
        why: 'half the windows agreeing is steady enough',
    },
    {
        albumLock: true,
        automix: true,
        incoming: track({ album: 'Other', bpm: 128, bpmStability: 0.9 }),
        kind: 'blend',
        outgoing: track({ bpm: 128 }),
        overlapSeconds: 8,
        why: 'an unmeasured stability is not held against a track',
    },
];

describe('mix transition parity with the iOS app', () => {
    it.each(TABLE)('$why', ({ albumLock, automix, incoming, kind, outgoing, overlapSeconds }) => {
        expect(planTransition({ albumLock, automix, incoming, outgoing })).toEqual({
            kind,
            overlapSeconds,
        });
    });

    it('answers every case in the table', () => {
        expect(TABLE).toHaveLength(31);
    });
});
