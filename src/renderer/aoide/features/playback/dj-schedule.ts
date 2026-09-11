import type { OutgoingPlayback } from '/@/renderer/aoide/features/playback/gapless-schedule';
import type { DJTransition } from '/@/shared/aoide/dj-planner';

import {
    endsAt,
    SCHEDULE_LEAD_SECONDS,
    SCHEDULE_WINDOW_SECONDS,
} from '/@/renderer/aoide/features/playback/gapless-schedule';
import {
    BASS_CUT_HZ,
    BASS_OPEN_HZ,
    crossfadeIncoming,
    crossfadeOutgoing,
    ENTRY_WIDTH,
    FILTER_FADE_HZ,
    incomingGain,
    outgoingGain,
    restoreRate,
    SWAP_POINT,
    SWAP_WIDTH,
} from '/@/shared/aoide/dj-automation';

/**
 * A mix as Web Audio will perform it: when each thing happens on the context
 * clock, and what every fader, filter and rate does across it.
 *
 * The phone drives its decks from a timer sixty times a second. Web Audio
 * can do better, and this is what it is for: an `AudioParam` takes a whole
 * schedule in advance and follows it on the render thread, so once a mix is
 * booked nothing on the main thread can make it late or coarse. Everything
 * here is arithmetic — numbers in, a list of `(param, time, value, shape)`
 * out — so the schedule can be tested without a listener, and the deck that
 * applies it decides nothing.
 *
 * Three clocks are reconciled here. The **audible** clock is the context
 * time at which a listener hears something; `startAtContextTime` is on it.
 * The **source** clock is where a buffer source has to be started or stopped
 * so that its sound arrives on the audible clock, which is earlier by the
 * pitch-stretch's latency for a voice that runs through one. And the
 * **record's own** clock is seconds into the file, which the incoming record
 * consumes faster than the audible clock while it is bent.
 */

/**
 * `BiquadFilterNode`'s Q for lowpass and highpass is a resonance in decibels,
 * not the Q of the textbook — `α = sin(ω₀) / (2·10^(Q/20))`. A Butterworth
 * response, the flattest second-order high-pass and the one the phone's
 * `AVAudioUnitEQ` gives at bandwidth 0.7, is Q = 1/√2, which is −3.01 dB
 * here. Zero would be Q = 1, a decibel-and-a-quarter bump at the corner, on
 * every record the deck plays.
 */
export const HIGH_PASS_Q_DB = 20 * Math.log10(Math.SQRT1_2);

/**
 * How many straight segments approximate a fader curve.
 *
 * `linearRampToValueAtTime` interpolates linearly, so the equal-power shape
 * is laid down as a run of short lines. Thirty-two across a quarter-wave of
 * cosine puts the worst error under three thousandths of a decibel where the
 * curve is above −20 dB, which is far below what anyone can hear, and costs
 * thirty-two events booked once.
 */
export const RAMP_STEPS = 32;

/**
 * How many steps the pitch correction takes while the bend eases back.
 *
 * The rate eases in one straight `linearRampToValueAtTime`; the stretch's
 * pitch shift can only be stepped, and a step is exact at its own instant and
 * a whole step behind the ramp just before the next. Sixty-four steps across
 * an eight-second restore of the widest bend (six per cent, a hundred cents)
 * is a cent and a half a step, so the pitch is never more than that from the
 * record's own — a third of what a trained ear resolves.
 */
export const SEMITONE_STEPS = 64;

/**
 * How far ahead of now a mix may be planned to start.
 *
 * The planner is asked on every tick, and a plan whose start has fallen
 * inside this lead is a plan whose decode did not arrive in time; it drops to
 * the next length, or to nothing, and the crossfade takes the boundary.
 * Longer than the booking window below, so a plan is always booked while it
 * is still the plan.
 */
export const PLAN_LEAD_SECONDS = 2.5;

/** The pitch shift that undoes a rate change: `−12·log₂(rate)` semitones. */
export const semitonesFor = (rate: number): number =>
    rate > 0 && Number.isFinite(rate) ? -12 * Math.log2(rate) + 0 : 0;

/**
 * One instruction for one `AudioParam`. `set` is `setValueAtTime`; `linear`
 * and `exponential` are ramps *to* this value ending at this time, from
 * whatever the previous event left. Times are on the audible clock, except
 * `incomingRate`, which is on the incoming voice's source clock because the
 * param it drives sits before the stretch.
 */
export interface AutomationEvent {
    shape: 'exponential' | 'linear' | 'set';
    target: AutomationTarget;
    time: number;
    value: number;
}

/** The six things a mix moves: two faders, two filter corners, and the bend. */
export type AutomationTarget =
    | 'incomingGain'
    | 'incomingHz'
    | 'incomingRate'
    | 'incomingSemitones'
    | 'outgoingGain'
    | 'outgoingHz';

/** How a mix is booked on the context clock. */
export interface MixBooking {
    /** When the mix ends and the outgoing record stops. */
    endAtContextTime: number;
    /** The events the deck applies, in time order per target. */
    events: AutomationEvent[];
    /** Where the incoming buffer starts from, on its own clock. */
    offsetSec: number;
    plan: DJTransition;
    /** When the incoming record's bend has finished easing back. */
    restoreEndsAt: number;
    /** When the incoming *source* is started: early by the stretch's latency. */
    sourceStartAtContextTime: number;
    /** When the incoming record becomes audible and the outgoing starts to leave. */
    startAtContextTime: number;
    /** What the deck's stretch adds between source and sound. */
    stretchLatencySec: number;
}

export interface MixBookingRequest {
    /** The decoded length of the incoming buffer. */
    incomingDurationSec: number;
    leadSec?: number;
    now: number;
    outgoing: OutgoingPlayback;
    plan: DJTransition;
    stretchLatencySec: number;
    windowSec?: number;
}

export type MixBookingResult =
    | { booking: MixBooking; kind: 'mix' }
    | { kind: 'no-mix'; reason: 'early' | 'late' | 'unusable' };

/**
 * The context time the mix starts, or why it cannot be booked yet.
 *
 * The same shape as `planJoin`: `early` means ask again next tick, the other
 * two mean this pair will not be mixed. The lead has the stretch's latency
 * added, because the incoming source has to be started that much before the
 * mix and a `when` behind `currentTime` plays immediately.
 */
export const planMixBooking = (request: MixBookingRequest): MixBookingResult => {
    const {
        incomingDurationSec,
        leadSec = SCHEDULE_LEAD_SECONDS,
        now,
        outgoing,
        plan,
        stretchLatencySec,
        windowSec = SCHEDULE_WINDOW_SECONDS,
    } = request;

    if (!Number.isFinite(now)) return UNUSABLE;
    if (!Number.isFinite(stretchLatencySec) || stretchLatencySec < 0) return UNUSABLE;
    if (!Number.isFinite(incomingDurationSec) || incomingDurationSec <= 0) return UNUSABLE;
    if (!Number.isFinite(leadSec) || leadSec < 0) return UNUSABLE;
    if (!Number.isFinite(windowSec) || windowSec < leadSec + stretchLatencySec) return UNUSABLE;
    if (!(plan.seconds > 0) || !(plan.incomingRate > 0)) return UNUSABLE;

    const offsetSec = plan.incomingStartMs / 1000;
    // The planner checked the entry against the segment the server fitted;
    // the decoded buffer is the truth, and a bent record is eaten faster than
    // the clock.
    if (!(offsetSec >= 0) || offsetSec + plan.seconds * plan.incomingRate > incomingDurationSec) {
        return UNUSABLE;
    }

    const startAtContextTime = endsAt(outgoing, plan.outgoingStartMs / 1000);
    if (startAtContextTime === null) return UNUSABLE;

    const sourceStartAtContextTime = startAtContextTime - stretchLatencySec;
    const until = sourceStartAtContextTime - now;
    if (until < leadSec) return LATE;
    if (until > windowSec) return EARLY;

    const endAtContextTime = startAtContextTime + plan.seconds;
    const booking: MixBooking = {
        endAtContextTime,
        events: [],
        offsetSec,
        plan,
        restoreEndsAt: endAtContextTime + plan.restoreSeconds,
        sourceStartAtContextTime,
        startAtContextTime,
        stretchLatencySec,
    };
    booking.events = mixAutomation(booking);
    return { booking, kind: 'mix' };
};

/**
 * A curve as straight segments: the value at each of `steps + 1` evenly
 * spaced fractions of `[0, 1]`, for `set` at the first and `linear` at the
 * rest.
 */
const rampEvents = (
    target: AutomationTarget,
    startTime: number,
    seconds: number,
    curve: (fraction: number) => number,
    steps: number = RAMP_STEPS,
): AutomationEvent[] => {
    const events: AutomationEvent[] = [{ shape: 'set', target, time: startTime, value: curve(0) }];
    for (let step = 1; step <= steps; step += 1) {
        const fraction = step / steps;
        events.push({
            shape: 'linear',
            target,
            time: startTime + fraction * seconds,
            value: curve(fraction),
        });
    }
    return events;
};

/**
 * Everything a mix does, as `AudioParam` events.
 *
 * The faders follow the phone's curves as straight segments. The filter
 * corners are exponential ramps, which is exactly the log sweep the phone
 * steps through — halfway from 20 Hz to 220 is 66 Hz on both. The rate is
 * one straight ramp back to 1 after the mix, and the pitch correction
 * follows it in steps. Each target's events are in time order, which is what
 * `AudioParam` requires of them.
 */
export const mixAutomation = (booking: MixBooking): AutomationEvent[] => {
    const { endAtContextTime: end, plan, startAtContextTime: start, stretchLatencySec } = booking;
    const seconds = plan.seconds;
    const at = (progress: number) => start + progress * seconds;
    const events: AutomationEvent[] = [];

    // The outgoing record holds until the swap, then leaves on the equal-power
    // curve over the second half.
    events.push({ shape: 'set', target: 'outgoingGain', time: start, value: 1 });
    events.push(
        ...rampEvents('outgoingGain', at(SWAP_POINT), (1 - SWAP_POINT) * seconds, (fraction) =>
            outgoingGain(SWAP_POINT + fraction * (1 - SWAP_POINT)),
        ),
    );

    // The incoming record is raised over the first half and holds there.
    events.push(
        ...rampEvents('incomingGain', start, ENTRY_WIDTH * seconds, (fraction) =>
            incomingGain(fraction * ENTRY_WIDTH),
        ),
    );

    // The outgoing record's low end: open until the swap, then gone — or, for
    // a pair with something to hide, its middle swept away across the first
    // half and held there.
    const swapStart = at(SWAP_POINT - SWAP_WIDTH / 2);
    const swapEnd = at(SWAP_POINT + SWAP_WIDTH / 2);
    events.push({ shape: 'set', target: 'outgoingHz', time: start, value: BASS_OPEN_HZ });
    if (plan.style === 'filterFade') {
        events.push({
            shape: 'exponential',
            target: 'outgoingHz',
            time: at(SWAP_POINT),
            value: FILTER_FADE_HZ,
        });
    } else {
        events.push({ shape: 'set', target: 'outgoingHz', time: swapStart, value: BASS_OPEN_HZ });
        events.push({
            shape: 'exponential',
            target: 'outgoingHz',
            time: swapEnd,
            value: BASS_CUT_HZ,
        });
    }

    // The incoming record's bass is out until the swap and in after it.
    events.push({ shape: 'set', target: 'incomingHz', time: start, value: BASS_CUT_HZ });
    events.push({ shape: 'set', target: 'incomingHz', time: swapStart, value: BASS_CUT_HZ });
    events.push({ shape: 'exponential', target: 'incomingHz', time: swapEnd, value: BASS_OPEN_HZ });

    // The bend: on from before the record is audible, eased back over the
    // restore once the mix is over. The rate lives on the source, ahead of
    // the stretch, so its clock is the source clock.
    const rate = plan.incomingRate;
    const sourceEnd = end - stretchLatencySec;
    events.push({ shape: 'set', target: 'incomingRate', time: 0, value: rate });
    events.push({ shape: 'set', target: 'incomingRate', time: sourceEnd, value: rate });
    events.push({
        shape: 'linear',
        target: 'incomingRate',
        time: sourceEnd + plan.restoreSeconds,
        value: 1,
    });

    // And the correction that holds the pitch while it happens.
    events.push({
        shape: 'set',
        target: 'incomingSemitones',
        time: start,
        value: semitonesFor(rate),
    });
    for (let step = 1; step <= SEMITONE_STEPS; step += 1) {
        const fraction = step / SEMITONE_STEPS;
        events.push({
            shape: 'set',
            target: 'incomingSemitones',
            time: end + fraction * plan.restoreSeconds,
            value: semitonesFor(restoreRate(rate, fraction)),
        });
    }

    return events;
};

/**
 * A plain crossfade on the deck: equal power, over `seconds` from `start`.
 * The outgoing side is only automated when the outgoing record is on the
 * deck; from an element its fader is ridden by hand.
 */
export const blendAutomation = (
    start: number,
    seconds: number,
    outgoingOnDeck: boolean,
): AutomationEvent[] => {
    if (!(seconds > 0) || !Number.isFinite(start)) return [];
    const events = rampEvents('incomingGain', start, seconds, crossfadeIncoming);
    if (outgoingOnDeck) {
        events.push(...rampEvents('outgoingGain', start, seconds, crossfadeOutgoing));
    }
    return events;
};

/**
 * How a voice's rate moves after it was started: constant `rate` until
 * `mixEndAt`, easing linearly to 1 over `restoreSeconds`, then 1.
 */
export interface RatePlan {
    mixEndAt: number;
    rate: number;
    restoreSeconds: number;
}

/**
 * Where a voice has got to in its record at audible time `now`, given where
 * and when it started and how its rate moved. The integral of the rate: a
 * straight line while bent, a parabola through the restore, a straight line
 * again after. For a voice that was never bent this is the plain
 * `offset + elapsed`.
 */
export const voicePositionAt = (
    offsetSec: number,
    startedAt: number,
    plan: null | RatePlan,
    now: number,
): number => {
    if (!plan || plan.rate === 1) return offsetSec + (now - startedAt);
    const { mixEndAt, rate, restoreSeconds } = plan;
    if (now <= mixEndAt) return offsetSec + rate * (now - startedAt);
    const bent = offsetSec + rate * (mixEndAt - startedAt);
    const restore = Math.max(0, restoreSeconds);
    const tau = now - mixEndAt;
    if (restore > 0 && tau < restore) {
        return bent + rate * tau + ((1 - rate) * tau * tau) / (2 * restore);
    }
    return bent + ((rate + 1) / 2) * restore + (tau - restore);
};

/**
 * The voice as a `(when, offset)` pair that advances in real time, which is
 * what a join can be planned against — or null while the rate is still
 * moving, because until the restore is done there is no such pair.
 */
export const settledPlayback = (
    offsetSec: number,
    startedAt: number,
    plan: null | RatePlan,
    now: number,
): null | { offsetSec: number; startedAtContextTime: number } => {
    if (!plan || plan.rate === 1) return { offsetSec, startedAtContextTime: startedAt };
    const settledAt = plan.mixEndAt + Math.max(0, plan.restoreSeconds);
    if (now < settledAt) return null;
    return {
        offsetSec: voicePositionAt(offsetSec, startedAt, plan, settledAt),
        startedAtContextTime: settledAt,
    };
};

/**
 * How far through its booking a mix is at `now`, 0…1, for the indicator: the
 * wait before it starts, or the mix itself. Null once it is over.
 */
export const mixProgress = (
    booking: { bookedAt: number; endAtContextTime: number; startAtContextTime: number },
    now: number,
): null | { phase: 'mixing' | 'ready'; progress: number } => {
    const { bookedAt, endAtContextTime: end, startAtContextTime: start } = booking;
    if (!Number.isFinite(now) || now >= end) return null;
    if (now < start) {
        const wait = start - bookedAt;
        const progress = wait > 0 ? Math.min(1, Math.max(0, (now - bookedAt) / wait)) : 1;
        return { phase: 'ready', progress };
    }
    const length = end - start;
    return { phase: 'mixing', progress: length > 0 ? Math.min(1, (now - start) / length) : 1 };
};

const EARLY: MixBookingResult = { kind: 'no-mix', reason: 'early' };
const LATE: MixBookingResult = { kind: 'no-mix', reason: 'late' };
const UNUSABLE: MixBookingResult = { kind: 'no-mix', reason: 'unusable' };
