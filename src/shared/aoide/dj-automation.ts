import type { DJStyle } from './dj-planner';

/**
 * What each deck does across the length of a mix, as numbers an engine applies.
 *
 * A port of `PlaybackKit/DJTransition.swift`'s `DJAutomation`, pinned by
 * `dj-automation-parity.test.ts` and `DJAutomationParityTests.swift`.
 * Progress runs 0 → 1 across the mix.
 *
 * **The faders barely move.** A DJ mixing on EQ does not ride the crossfader,
 * and the record holding the low end is the record in front, so turning it
 * down before it hands the bass over is turning the mix down. The outgoing
 * record holds its level until the swap and then goes; the incoming comes up
 * over the first half — a fader raised rather than shoved — and holds there.
 *
 * **The bass swaps, it does not fade.** The low end belongs to the outgoing
 * record until the halfway bar and to the incoming one after it, handing over
 * in about a bar. Two kick drums at once is the muddiest sound in recorded
 * music and no volume curve fixes it. The swap drives a high-pass corner swept
 * on a log scale from 20 Hz to 220 Hz — halfway is 66 Hz, not 120, because
 * that is how frequency is heard. A pair with something to hide gets the
 * filter fade instead: the outgoing corner goes on up to 1.5 kHz across the
 * first half, so its melody is gone before the incoming record's bass arrives.
 */

/**
 * Where the bass hands over: the middle of the mix, which is a downbeat
 * because the mix is a whole number of bars.
 */
export const SWAP_POINT = 0.5;

/**
 * How much of the mix the swap takes — about a bar. Not shorter: stepping a
 * filter across its whole travel in two ticks is a click. Not longer: while it
 * happens both records have some low end, which is the mud the swap exists to
 * avoid.
 */
export const SWAP_WIDTH = 0.08;

/**
 * How far the low end was taken down when the swap was a shelf. Kept because
 * the decibel form of the swap is still described in it.
 */
export const BASS_CUT_DB = -24;

/**
 * The incoming record comes up over the first half of the mix — eight bars of
 * a sixteen-bar one — and holds there. The bass arrives at the swap point
 * whatever this says, so this only governs how the hats and the air get there.
 */
export const ENTRY_WIDTH = 0.5;

/**
 * Where the filter fade takes the outgoing record's corner to: above the body
 * of a voice and the chords under it, below the hats and the snare's crack.
 * What is left is rhythm and air.
 */
export const FILTER_FADE_HZ = 1_500;

/** The most a deck's high-pass is ever asked for. */
export const MAXIMUM_HIGH_PASS_HZ = 4_000;

/**
 * Where the high-pass sits when a record's low end is out: kick drums and bass
 * lines live below this, the body of a vocal does not.
 */
export const BASS_CUT_HZ = 220;

/**
 * And where it sits when the record is untouched — below anything a speaker
 * reproduces, so the filter is in the chain but not in the sound.
 */
export const BASS_OPEN_HZ = 20;

const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
};

/** Level for the track on its way out of a plain crossfade, equal power. */
export const crossfadeOutgoing = (progress: number): number =>
    Math.cos((clamp(progress) * Math.PI) / 2);

/** Level for the track on its way into a plain crossfade, equal power. */
export const crossfadeIncoming = (progress: number): number =>
    Math.sin((clamp(progress) * Math.PI) / 2);

/**
 * The outgoing record holds its level until the bass leaves it, then goes.
 * Before that point it is the record carrying the low end, and turning it down
 * is turning the mix down.
 */
export const outgoingGain = (progress: number): number => {
    const p = clamp(progress);
    if (!(p > SWAP_POINT)) return 1;
    return crossfadeOutgoing((p - SWAP_POINT) / (1 - SWAP_POINT));
};

export const incomingGain = (progress: number): number => {
    const p = clamp(progress);
    if (!(p < ENTRY_WIDTH)) return 1;
    return crossfadeIncoming(p / ENTRY_WIDTH);
};

/** 0 before the swap, 1 after it, and a short straight line between. */
export const swapRamp = (progress: number): number => {
    const start = SWAP_POINT - SWAP_WIDTH / 2;
    return clamp((clamp(progress) - start) / SWAP_WIDTH);
};

/**
 * How far out the outgoing record's low end is, 0…1: in until the swap, out
 * after it. What the decks' filters are driven by.
 */
export const outgoingBassCut = (progress: number): number => swapRamp(progress);

/** And the incoming record's, the other way round. */
export const incomingBassCut = (progress: number): number => 1 - swapRamp(progress);

/**
 * A linear gain as decibels on the shelf the swap used to be, floored at the
 * cut rather than running away to silence.
 */
const db = (gain: number): number => {
    if (!(gain > 0)) return BASS_CUT_DB;
    return Math.max(BASS_CUT_DB, 20 * Math.log10(gain));
};

/**
 * The outgoing record keeps its bass until the swap, then loses it — in the
 * decibels of the shelf, kept for the arithmetic that describes the swap: the
 * two are complementary in power across the crossing, which is why the level
 * holds.
 */
export const outgoingBassDb = (progress: number): number =>
    db(crossfadeOutgoing(swapRamp(progress)));

/** And the incoming record has none until the swap, then takes it. */
export const incomingBassDb = (progress: number): number =>
    db(crossfadeIncoming(swapRamp(progress)));

/**
 * Between two corners on a log scale, because that is how frequency is heard:
 * halfway from 20 Hz to 220 is 66, not 120.
 */
export const sweep = (from: number, to: number, fraction: number): number =>
    from * (to / from) ** clamp(fraction);

/**
 * The outgoing record's high-pass corner, in hertz, across the mix.
 *
 * A blend leaves it open until the swap and takes the bass afterwards. A
 * filter fade sweeps it up to `FILTER_FADE_HZ` across the first half, so the
 * melody has gone before the incoming record's bass arrives, and holds it
 * there while the record fades.
 */
export const outgoingHighPassHz = (progress: number, style: DJStyle): number => {
    if (style === 'filterFade') {
        return sweep(BASS_OPEN_HZ, FILTER_FADE_HZ, Math.min(1, clamp(progress) / SWAP_POINT));
    }
    return sweep(BASS_OPEN_HZ, BASS_CUT_HZ, swapRamp(progress));
};

/**
 * The incoming record's, the same either way: its bass is out until the swap
 * and in after it.
 */
export const incomingHighPassHz = (progress: number): number =>
    sweep(BASS_OPEN_HZ, BASS_CUT_HZ, 1 - swapRamp(progress));

/**
 * The bend easing back to the record's own tempo after the mix, linear in
 * rate over the whole restore — a per cent spread across eight seconds is
 * slower than the drift of a record deck warming up.
 */
export const restoreRate = (from: number, progress: number): number =>
    from + (1 - from) * clamp(progress);
