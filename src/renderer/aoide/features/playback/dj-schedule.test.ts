import { describe, expect, it } from 'vitest';

import {
    AutomationEvent,
    AutomationTarget,
    blendAutomation,
    HIGH_PASS_Q_DB,
    mixAutomation,
    MixBooking,
    mixProgress,
    PLAN_LEAD_SECONDS,
    planMixBooking,
    RAMP_STEPS,
    SEMITONE_STEPS,
    semitonesFor,
    settledPlayback,
    voicePositionAt,
} from './dj-schedule';
import { SCHEDULE_LEAD_SECONDS, SCHEDULE_WINDOW_SECONDS } from './gapless-schedule';

import {
    BASS_CUT_HZ,
    BASS_OPEN_HZ,
    FILTER_FADE_HZ,
    incomingGain,
    outgoingGain,
    restoreRate,
} from '/@/shared/aoide/dj-automation';
import { DJTransition } from '/@/shared/aoide/dj-planner';

/**
 * Sixteen bars at 128 from 150 s of the outgoing record, the incoming coming
 * in at 15 s of itself, bent up by two per cent. A style of `blend` unless a
 * test says otherwise.
 */
const plan = (over: Partial<DJTransition> = {}): DJTransition => ({
    bars: 16,
    incomingRate: 1.02,
    incomingStartMs: 15_000,
    isKeyCompatible: false,
    outgoingRate: 1,
    outgoingStartMs: 150_000,
    restoreSeconds: 8,
    score: { energy: 0.5, key: 0.5, sections: 0.5, tempo: 1, vocals: 0.5 },
    seconds: 30,
    style: 'blend',
    targetBpm: 128,
    ...over,
});

/** A buffer outgoing that started at context time 100 from 10 s of itself. */
const outgoing = { kind: 'buffer' as const, offsetSec: 10, startedAtContextTime: 100 };

/** The mix starts when the outgoing reaches 150 s: 100 + (150 − 10) = 240. */
const MIX_START = 240;

const LATENCY = 0.12;

const book = (over: Partial<Parameters<typeof planMixBooking>[0]> = {}): MixBooking => {
    const result = planMixBooking({
        incomingDurationSec: 240,
        now: MIX_START - LATENCY - 1,
        outgoing,
        plan: plan(),
        stretchLatencySec: LATENCY,
        ...over,
    });
    if (result.kind !== 'mix') throw new Error(`no mix: ${result.reason}`);
    return result.booking;
};

/**
 * The smallest model of an `AudioParam` that can answer "what is the value at
 * time t": a step for `set`, a straight line for `linear`, a geometric line
 * for `exponential`, each from wherever the previous event left the value.
 */
const valueAt = (events: AutomationEvent[], target: AutomationTarget, t: number): number => {
    const own = events.filter((event) => event.target === target);
    let value = Number.NaN;
    let since = Number.NEGATIVE_INFINITY;
    for (const event of own) {
        if (event.time > t) {
            if (event.shape === 'set' || !Number.isFinite(value)) return value;
            const fraction = (t - since) / (event.time - since);
            if (event.shape === 'linear') return value + (event.value - value) * fraction;
            return value * (event.value / value) ** fraction;
        }
        value = event.value;
        since = event.time;
    }
    return value;
};

const db = (gain: number): number => 20 * Math.log10(gain);

describe('the deck’s constants', () => {
    it('sets the high-pass to Butterworth in Web Audio’s decibel Q', () => {
        expect(HIGH_PASS_Q_DB).toBeCloseTo(-3.0103, 3);
    });

    it('undoes a rate change in semitones', () => {
        expect(semitonesFor(1)).toBe(0);
        expect(semitonesFor(2)).toBeCloseTo(-12, 12);
        expect(semitonesFor(0.5)).toBeCloseTo(12, 12);
        // The phone's example: 170 bent down to 164 is 62 cents.
        expect(semitonesFor(164 / 170)).toBeCloseTo(0.6216, 3);
        expect(semitonesFor(0)).toBe(0);
        expect(semitonesFor(Number.NaN)).toBe(0);
    });

    it('plans further ahead than it books', () => {
        expect(PLAN_LEAD_SECONDS).toBeGreaterThan(SCHEDULE_WINDOW_SECONDS);
    });
});

describe('booking a mix on the context clock', () => {
    it('starts the mix when the outgoing record reaches the planned bar', () => {
        const booking = book();
        expect(booking.startAtContextTime).toBe(MIX_START);
        expect(booking.endAtContextTime).toBe(MIX_START + 30);
        expect(booking.restoreEndsAt).toBe(MIX_START + 38);
        expect(booking.offsetSec).toBe(15);
        expect(booking.stretchLatencySec).toBe(LATENCY);
    });

    // The whole reason the latency is a number here rather than a shrug.
    it('starts the incoming source early by the stretch’s latency', () => {
        expect(book().sourceStartAtContextTime).toBeCloseTo(MIX_START - LATENCY, 12);
        expect(book({ stretchLatencySec: 0 }).sourceStartAtContextTime).toBe(MIX_START);
    });

    it('is early until the source start is inside the window, and late once it is past the lead', () => {
        const sourceStart = MIX_START - LATENCY;
        const early = planMixBooking({
            incomingDurationSec: 240,
            now: sourceStart - SCHEDULE_WINDOW_SECONDS - 0.001,
            outgoing,
            plan: plan(),
            stretchLatencySec: LATENCY,
        });
        expect(early).toEqual({ kind: 'no-mix', reason: 'early' });
        const inWindow = planMixBooking({
            incomingDurationSec: 240,
            now: sourceStart - SCHEDULE_WINDOW_SECONDS,
            outgoing,
            plan: plan(),
            stretchLatencySec: LATENCY,
        });
        expect(inWindow.kind).toBe('mix');
        const late = planMixBooking({
            incomingDurationSec: 240,
            now: sourceStart - SCHEDULE_LEAD_SECONDS + 0.001,
            outgoing,
            plan: plan(),
            stretchLatencySec: LATENCY,
        });
        expect(late).toEqual({ kind: 'no-mix', reason: 'late' });
    });

    it('can book from an element outgoing, on its sampled clock', () => {
        const booking = book({
            outgoing: { kind: 'element', positionSec: 140, sampledAtContextTime: 230 },
        });
        expect(booking.startAtContextTime).toBe(240);
    });

    it('refuses what it cannot book', () => {
        const refuse = (over: Partial<Parameters<typeof planMixBooking>[0]>) =>
            planMixBooking({
                incomingDurationSec: 240,
                now: MIX_START - 1,
                outgoing,
                plan: plan(),
                stretchLatencySec: LATENCY,
                ...over,
            });
        expect(refuse({ now: Number.NaN })).toEqual({ kind: 'no-mix', reason: 'unusable' });
        expect(refuse({ stretchLatencySec: -1 })).toEqual({ kind: 'no-mix', reason: 'unusable' });
        expect(refuse({ stretchLatencySec: Number.NaN }).kind).toBe('no-mix');
        expect(refuse({ incomingDurationSec: 0 })).toEqual({ kind: 'no-mix', reason: 'unusable' });
        expect(refuse({ leadSec: -1 })).toEqual({ kind: 'no-mix', reason: 'unusable' });
        // The window must hold the lead and the latency.
        expect(refuse({ windowSec: SCHEDULE_LEAD_SECONDS + LATENCY - 0.001 })).toEqual({
            kind: 'no-mix',
            reason: 'unusable',
        });
        expect(refuse({ plan: plan({ seconds: 0 }) })).toEqual({
            kind: 'no-mix',
            reason: 'unusable',
        });
        expect(refuse({ plan: plan({ incomingRate: 0 }) })).toEqual({
            kind: 'no-mix',
            reason: 'unusable',
        });
        expect(refuse({ plan: plan({ incomingStartMs: -1 }) })).toEqual({
            kind: 'no-mix',
            reason: 'unusable',
        });
        expect(
            refuse({
                outgoing: { kind: 'buffer', offsetSec: Number.NaN, startedAtContextTime: 1 },
            }),
        ).toEqual({ kind: 'no-mix', reason: 'unusable' });
    });

    // A bent record is eaten faster than the clock: thirty seconds at 1.02
    // from 15 s in needs 45.6 s of buffer.
    it('refuses an incoming buffer the bent mix would run off the end of', () => {
        expect(
            planMixBooking({
                incomingDurationSec: 45.59,
                now: MIX_START - 1,
                outgoing,
                plan: plan(),
                stretchLatencySec: LATENCY,
            }),
        ).toEqual({ kind: 'no-mix', reason: 'unusable' });
        expect(
            planMixBooking({
                incomingDurationSec: 45.6,
                now: MIX_START - 1,
                outgoing,
                plan: plan(),
                stretchLatencySec: LATENCY,
            }).kind,
        ).toBe('mix');
    });
});

describe('what a mix does, as AudioParam events', () => {
    const booking = book();
    const events = mixAutomation(booking);
    const start = booking.startAtContextTime;
    const end = booking.endAtContextTime;
    const at = (progress: number) => start + progress * 30;

    it('keeps each target’s events in time order, which AudioParam requires', () => {
        const targets = new Set(events.map((event) => event.target));
        expect(targets.size).toBe(6);
        for (const target of targets) {
            const times = events.filter((event) => event.target === target).map((e) => e.time);
            for (let index = 1; index < times.length; index += 1) {
                expect(times[index]).toBeGreaterThanOrEqual(times[index - 1]);
            }
        }
    });

    it('holds the outgoing fader until the swap and follows the phone’s curve after it', () => {
        expect(valueAt(events, 'outgoingGain', start)).toBe(1);
        expect(valueAt(events, 'outgoingGain', at(0.49))).toBe(1);
        expect(valueAt(events, 'outgoingGain', at(0.5))).toBe(1);
        expect(valueAt(events, 'outgoingGain', at(0.75))).toBeCloseTo(Math.SQRT1_2, 2);
        expect(valueAt(events, 'outgoingGain', end)).toBeLessThan(1e-9);
        // Thirty-two straight segments follow the cosine within three
        // thousandths of a decibel wherever the curve is above −20 dB.
        for (let step = 0; step <= 400; step += 1) {
            const progress = 0.5 + (step / 400) * 0.5;
            const wanted = outgoingGain(progress);
            if (db(wanted) < -20) continue;
            const got = valueAt(events, 'outgoingGain', at(progress));
            expect(Math.abs(db(got) - db(wanted))).toBeLessThan(0.003);
        }
    });

    it('raises the incoming fader over the first half and holds it', () => {
        expect(valueAt(events, 'incomingGain', start)).toBe(0);
        expect(valueAt(events, 'incomingGain', at(0.25))).toBeCloseTo(Math.SQRT1_2, 2);
        expect(valueAt(events, 'incomingGain', at(0.5))).toBe(1);
        expect(valueAt(events, 'incomingGain', end)).toBe(1);
        for (let step = 0; step <= 400; step += 1) {
            const progress = (step / 400) * 0.5;
            const wanted = incomingGain(progress);
            if (db(wanted) < -20) continue;
            const got = valueAt(events, 'incomingGain', at(progress));
            expect(Math.abs(db(got) - db(wanted))).toBeLessThan(0.003);
        }
        expect(events.filter((e) => e.target === 'incomingGain')).toHaveLength(RAMP_STEPS + 1);
    });

    it('sweeps the outgoing bass out across the swap on a log scale, and the incoming in', () => {
        expect(valueAt(events, 'outgoingHz', start)).toBe(BASS_OPEN_HZ);
        expect(valueAt(events, 'outgoingHz', at(0.46))).toBe(BASS_OPEN_HZ);
        // Halfway through the swap the corner is at the geometric mean, 66 Hz.
        expect(valueAt(events, 'outgoingHz', at(0.5))).toBeCloseTo(Math.sqrt(20 * 220), 6);
        expect(valueAt(events, 'outgoingHz', at(0.54))).toBeCloseTo(BASS_CUT_HZ, 9);
        expect(valueAt(events, 'outgoingHz', end)).toBeCloseTo(BASS_CUT_HZ, 9);

        expect(valueAt(events, 'incomingHz', start)).toBe(BASS_CUT_HZ);
        expect(valueAt(events, 'incomingHz', at(0.46))).toBe(BASS_CUT_HZ);
        expect(valueAt(events, 'incomingHz', at(0.5))).toBeCloseTo(Math.sqrt(20 * 220), 6);
        expect(valueAt(events, 'incomingHz', at(0.54))).toBeCloseTo(BASS_OPEN_HZ, 9);
        // An exponential ramp, never a linear one: 120 Hz halfway would be the
        // hole in the low end the phone measured.
        expect(
            events.filter((e) => e.target === 'outgoingHz' && e.shape === 'linear'),
        ).toHaveLength(0);
        expect(
            events.filter((e) => e.target === 'incomingHz' && e.shape === 'linear'),
        ).toHaveLength(0);
    });

    it('a filter fade sweeps the outgoing corner to 1.5 kHz by the swap and holds it', () => {
        const fade = mixAutomation(book({ plan: plan({ style: 'filterFade' }) }));
        expect(valueAt(fade, 'outgoingHz', start)).toBe(BASS_OPEN_HZ);
        expect(valueAt(fade, 'outgoingHz', at(0.25))).toBeCloseTo(Math.sqrt(20 * 1500), 6);
        expect(valueAt(fade, 'outgoingHz', at(0.5))).toBeCloseTo(FILTER_FADE_HZ, 9);
        expect(valueAt(fade, 'outgoingHz', at(0.9))).toBeCloseTo(FILTER_FADE_HZ, 9);
        // The incoming side is the same either way.
        expect(valueAt(fade, 'incomingHz', at(0.54))).toBeCloseTo(BASS_OPEN_HZ, 9);
    });

    it('bends the incoming source from before it is audible and eases it back on its own clock', () => {
        const sourceEnd = end - LATENCY;
        expect(valueAt(events, 'incomingRate', 0)).toBe(1.02);
        expect(valueAt(events, 'incomingRate', start)).toBe(1.02);
        expect(valueAt(events, 'incomingRate', sourceEnd)).toBe(1.02);
        expect(valueAt(events, 'incomingRate', sourceEnd + 4)).toBeCloseTo(1.01, 12);
        expect(valueAt(events, 'incomingRate', sourceEnd + 8)).toBe(1);
        expect(valueAt(events, 'incomingRate', sourceEnd + 9)).toBe(1);
    });

    it('holds the pitch: the correction follows the bend to within two cents', () => {
        // 62 cents on the phone's example; here two per cent is 34 cents.
        expect(valueAt(events, 'incomingSemitones', start)).toBeCloseTo(semitonesFor(1.02), 12);
        expect(valueAt(events, 'incomingSemitones', end + 8)).toBeCloseTo(0, 12);
        expect(events.filter((e) => e.target === 'incomingSemitones')).toHaveLength(
            SEMITONE_STEPS + 1,
        );
        // At every instant of the restore, the stepped correction and the
        // ramped rate disagree by less than a step: the pitch the listener
        // hears is rate × correction, and it stays within two cents of the
        // record's own for the widest bend allowed.
        const wide = mixAutomation(book({ plan: plan({ incomingRate: 1.06 }) }));
        for (let step = 0; step <= 800; step += 1) {
            const t = end + (step / 800) * 8;
            const rate = valueAt(wide, 'incomingRate', t - LATENCY);
            const correction = valueAt(wide, 'incomingSemitones', t);
            const heardCents = 1200 * Math.log2(rate) + correction * 100;
            expect(Math.abs(heardCents)).toBeLessThan(2);
        }
        // And exactly on the record's own pitch at every step.
        for (let step = 0; step <= SEMITONE_STEPS; step += 1) {
            const fraction = step / SEMITONE_STEPS;
            const t = end + fraction * 8;
            expect(valueAt(wide, 'incomingSemitones', t)).toBeCloseTo(
                semitonesFor(restoreRate(1.06, fraction)),
                12,
            );
        }
    });
});

describe('a plain crossfade on the deck', () => {
    it('is equal power across the overlap', () => {
        const events = blendAutomation(100, 8, true);
        for (let step = 0; step <= 80; step += 1) {
            const t = 100 + (step / 80) * 8;
            const out = valueAt(events, 'outgoingGain', t);
            const into = valueAt(events, 'incomingGain', t);
            expect(out * out + into * into).toBeCloseTo(1, 2);
        }
        expect(valueAt(events, 'outgoingGain', 100)).toBe(1);
        expect(valueAt(events, 'incomingGain', 100)).toBe(0);
        expect(valueAt(events, 'outgoingGain', 108)).toBeLessThan(1e-9);
        expect(valueAt(events, 'incomingGain', 108)).toBe(1);
    });

    it('leaves the outgoing fader alone when the outgoing record is an element', () => {
        const events = blendAutomation(100, 8, false);
        expect(events.some((e) => e.target === 'outgoingGain')).toBe(false);
        expect(events.filter((e) => e.target === 'incomingGain')).toHaveLength(RAMP_STEPS + 1);
    });

    it('is nothing for a fade with no length', () => {
        expect(blendAutomation(100, 0, true)).toEqual([]);
        expect(blendAutomation(100, -1, true)).toEqual([]);
        expect(blendAutomation(Number.NaN, 8, true)).toEqual([]);
    });
});

describe('where a bent voice has got to', () => {
    const ratePlan = { mixEndAt: 270, rate: 1.02, restoreSeconds: 8 };

    it('advances in real time when it was never bent', () => {
        expect(voicePositionAt(15, 240, null, 250)).toBe(25);
        expect(voicePositionAt(15, 240, { ...ratePlan, rate: 1 }, 250)).toBe(25);
    });

    it('advances at the bent rate through the mix', () => {
        expect(voicePositionAt(15, 240, ratePlan, 240)).toBe(15);
        expect(voicePositionAt(15, 240, ratePlan, 250)).toBeCloseTo(15 + 10.2, 12);
        expect(voicePositionAt(15, 240, ratePlan, 270)).toBeCloseTo(15 + 30.6, 12);
    });

    it('integrates the ease back, and is continuous at both ends of it', () => {
        const atEnd = voicePositionAt(15, 240, ratePlan, 270);
        expect(voicePositionAt(15, 240, ratePlan, 270.0001)).toBeCloseTo(atEnd, 3);
        // Halfway through the restore the average rate so far is 1.015.
        expect(voicePositionAt(15, 240, ratePlan, 274)).toBeCloseTo(atEnd + 4 * 1.015, 12);
        // The whole restore covers (rate + 1)/2 × restore seconds of record.
        const settled = atEnd + 1.01 * 8;
        expect(voicePositionAt(15, 240, ratePlan, 278)).toBeCloseTo(settled, 12);
        expect(voicePositionAt(15, 240, ratePlan, 277.9999)).toBeCloseTo(settled, 3);
        // And real time after that.
        expect(voicePositionAt(15, 240, ratePlan, 288)).toBeCloseTo(settled + 10, 12);
    });

    it('with no restore the rate snaps back at the mix end', () => {
        const snap = { ...ratePlan, restoreSeconds: 0 };
        expect(voicePositionAt(15, 240, snap, 280)).toBeCloseTo(15 + 30.6 + 10, 12);
    });

    it('has no (when, offset) pair while the rate is still moving', () => {
        expect(settledPlayback(15, 240, ratePlan, 277.999)).toBeNull();
        expect(settledPlayback(15, 240, null, 100)).toEqual({
            offsetSec: 15,
            startedAtContextTime: 240,
        });
        const pair = settledPlayback(15, 240, ratePlan, 300);
        expect(pair).toEqual({
            offsetSec: voicePositionAt(15, 240, ratePlan, 278),
            startedAtContextTime: 278,
        });
        // The pair advances in real time to the same place the integral does.
        expect(pair!.offsetSec + (300 - pair!.startedAtContextTime)).toBeCloseTo(
            voicePositionAt(15, 240, ratePlan, 300),
            12,
        );
    });
});

describe('the indicator’s progress', () => {
    const booking = { bookedAt: 200, endAtContextTime: 270, startAtContextTime: 240 };

    it('counts down the wait, then counts through the mix', () => {
        expect(mixProgress(booking, 200)).toEqual({ phase: 'ready', progress: 0 });
        expect(mixProgress(booking, 220)).toEqual({ phase: 'ready', progress: 0.5 });
        expect(mixProgress(booking, 239.999)?.phase).toBe('ready');
        expect(mixProgress(booking, 240)).toEqual({ phase: 'mixing', progress: 0 });
        expect(mixProgress(booking, 255)).toEqual({ phase: 'mixing', progress: 0.5 });
        expect(mixProgress(booking, 270)).toBeNull();
        expect(mixProgress(booking, 300)).toBeNull();
    });

    it('stays inside the bar', () => {
        expect(mixProgress(booking, 190)).toEqual({ phase: 'ready', progress: 0 });
        expect(mixProgress({ ...booking, bookedAt: 240 }, 235)).toEqual({
            phase: 'ready',
            progress: 1,
        });
        expect(mixProgress(booking, Number.NaN)).toBeNull();
    });
});
