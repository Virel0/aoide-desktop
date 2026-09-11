import { describe, expect, it } from 'vitest';

import { Arrangement, ArrangementSection, SectionKind } from './arrangement';
import { BeatGrid } from './beat-grid';
import { DJStyle, planMix } from './dj-planner';
import { scoreTotal } from './mix-score';

/**
 * The same thirty-nine pairs the iOS app plans, with the same thirty-nine
 * plans.
 *
 * "Both apps mix the same way" is a claim, and this table is the only thing
 * that makes it one: it is duplicated verbatim in `DJPlannerParityTests` in
 * Packages/PlaybackKit, so either side changing a constant, a threshold, a
 * snapping rule or an ordering breaks its own copy. Starts and entries are
 * exact milliseconds and the score is the exact double, because two planners
 * a bar apart are still two planners.
 */

const bar = (60_000 / 128) * 4;

/**
 * A four-minute record at `bpm`, gridded from `anchor`, mixable from its first
 * downbeat to two bars before the end.
 */
const record = (
    bpm: number,
    over: {
        anchorMs?: number;
        beatsPerBar?: null | number;
        key?: null | string;
        lengthMs?: number;
        mixInMs?: number;
        mixOutMs?: number;
        residualMs?: number;
    } = {},
): BeatGrid => {
    const { anchorMs = 0, beatsPerBar = 4, key = null, lengthMs = 240_000, residualMs = 5 } = over;
    const barMs = (60_000 / bpm) * 4;
    return {
        beatsPerBar,
        downbeatIndex: beatsPerBar === null ? null : 0,
        key,
        keyConfidence: key === null ? null : 0.8,
        mixInMs: beatsPerBar === null ? null : (over.mixInMs ?? anchorMs),
        mixOutMs:
            beatsPerBar === null
                ? null
                : (over.mixOutMs ?? anchorMs + (lengthMs - anchorMs - barMs * 2)),
        segments: [
            {
                anchorMs,
                beats: Math.floor(lengthMs / (60_000 / bpm)),
                bpm,
                endMs: lengthMs,
                residualMs,
                startMs: 0,
            },
        ],
    };
};

/** A four-minute record at 128, mixable from bar 8 to sixteen bars before the end. */
const grid = (over: { key?: string; mixInMs?: number; mixOutMs?: number } = {}): BeatGrid =>
    record(128, {
        key: over.key ?? null,
        mixInMs: over.mixInMs ?? bar * 8,
        mixOutMs: over.mixOutMs ?? bar * 112,
    });

/** Sections in bars, laid end to end. */
const arrangement = (
    parts: Array<[SectionKind, number, number]>,
    options: { phraseBars?: null | number; vocals?: Arrangement['vocals'] } = {},
): Arrangement => {
    const sections: ArrangementSection[] = [];
    let at = 0;
    for (const [kind, bars, energy] of parts) {
        sections.push({ endMs: at + bar * bars, energy, kind, startMs: at });
        at += bar * bars;
    }
    const phraseBars = options.phraseBars === undefined ? 16 : options.phraseBars;
    return {
        phraseAnchorMs: phraseBars === null ? null : 0,
        phraseBars,
        sections,
        vocals: options.vocals === undefined ? [] : options.vocals,
    };
};

const plain = arrangement([
    ['intro', 16, 0.2],
    ['drop', 96, 0.9],
    ['outro', 16, 0.2],
]);
const dropOut = arrangement([
    ['intro', 16, 0.2],
    ['drop', 112, 0.9],
]);
const dropIn = arrangement([['drop', 128, 0.9]]);
const buildIn = arrangement([
    ['build', 32, 0.4],
    ['drop', 96, 0.9],
]);
const withBuild = arrangement([
    ['intro', 16, 0.2],
    ['build', 16, 0.5],
    ['drop', 80, 0.95],
    ['outro', 16, 0.2],
]);
const midEnergy = arrangement([
    ['intro', 16, 0.2],
    ['drop', 96, 0.55],
    ['outro', 16, 0.2],
]);
const breakdownOut = arrangement([
    ['intro', 16, 0.2],
    ['drop', 80, 0.9],
    ['breakdown', 16, 0.5],
    ['outro', 16, 0.2],
]);
const singingOut = arrangement([['drop', 128, 0.9]], {
    vocals: [{ endMs: bar * 128, startMs: bar * 90 }],
});
const singingIn = arrangement([['drop', 128, 0.9]], { vocals: [{ endMs: bar * 40, startMs: 0 }] });
const singsLater = arrangement([['drop', 128, 0.9]], {
    vocals: [{ endMs: bar * 80, startMs: bar * 40 }],
});
const cannotTell = arrangement([['drop', 128, 0.9]], { vocals: null });
const instrumental = arrangement([['drop', 128, 0.9]]);
const noPhrases = arrangement([['unknown', 128, 0.5]], { phraseBars: null });
const buildThenDrop = arrangement([
    ['build', 32, 0.4],
    ['drop', 96, 0.9],
]);
const singingThroughout = arrangement(
    [
        ['build', 32, 0.4],
        ['drop', 96, 0.9],
    ],
    {
        vocals: [{ endMs: bar * 128, startMs: 0 }],
    },
);

/**
 * A record that has been read and found unremarkable: one section nobody
 * could name, instrumental, no phrase grid. The planner refuses a record that
 * has not been read at all, so the grid-only rows are handed one of these.
 * The two energies differ so that a pair with nothing else going for it lands
 * on sixteen bars rather than being flattered into thirty-two.
 */
const read = (energy: number): Arrangement => ({
    phraseAnchorMs: null,
    phraseBars: null,
    sections: [{ endMs: 600_000, energy, kind: 'unknown', startMs: 0 }],
    vocals: [],
});

/** Both records read and unremarkable. */
const unremarkable = (args: {
    incoming: BeatGrid;
    notBeforeMs?: number;
    outgoing: BeatGrid;
}): Parameters<typeof planMix>[0] => ({
    ...args,
    incomingArrangement: read(0.2),
    outgoingArrangement: read(0.8),
});

/** The slower record in "bend eats record": 128 over 1.01, mixable from bar 50. */
const slowBpm = 128 / 1.01;
const slowMixIn = (60_000 / slowBpm) * 4 * 50;

interface ParityCase {
    bars: null | number;
    incomingRate?: number;
    incomingStartMs?: number;
    outgoingStartMs?: number;
    plan: Parameters<typeof planMix>[0];
    style?: DJStyle;
    total?: number;
    why: string;
}

const TABLE: ParityCase[] = [
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 206_250,
        plan: unremarkable({ incoming: record(128), outgoing: record(128) }),
        style: 'blend',
        total: 0.68,
        why: 'two records at one tempo get sixteen bars',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: unremarkable({ incoming: record(128), outgoing: record(128, { mixOutMs: 180_000 }) }),
        style: 'blend',
        total: 0.68,
        why: 'the mix ends where the outgoing record stops being mixable',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 90_431.2,
        plan: unremarkable({
            incoming: record(128),
            outgoing: record(128, { anchorMs: 431.2, mixOutMs: 431.2 + 1875 * 64 }),
        }),
        style: 'blend',
        total: 0.68,
        why: 'an anchor off zero keeps the start on its own downbeats',
    },
    {
        bars: 16,
        incomingRate: 1.0158730158730158,
        incomingStartMs: 0,
        outgoingStartMs: 206_250,
        plan: unremarkable({ incoming: record(126), outgoing: record(128) }),
        style: 'blend',
        total: 0.68,
        why: '126 into 128 bends the incoming record up',
    },
    {
        bars: 16,
        incomingRate: 0.9846153846153847,
        incomingStartMs: 0,
        outgoingStartMs: 206_250,
        plan: unremarkable({ incoming: record(130), outgoing: record(128) }),
        style: 'blend',
        total: 0.68,
        why: '130 into 128 bends it down',
    },
    {
        bars: null,
        plan: unremarkable({ incoming: record(100), outgoing: record(128) }),
        why: '100 into 128 is not a bend, it is a different record',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 189_176.4705882353,
        plan: unremarkable({ incoming: record(170), outgoing: record(85) }),
        style: 'blend',
        total: 0.68,
        why: 'double time is played at its own speed',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 214_588.23529411765,
        plan: unremarkable({ incoming: record(85), outgoing: record(170) }),
        style: 'blend',
        total: 0.68,
        why: 'and so is half time',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 3_750,
        plan: unremarkable({ incoming: record(128), outgoing: record(128, { mixOutMs: 20_000 }) }),
        style: 'blend',
        total: 0.68,
        why: 'eight bars when sixteen will not fit',
    },
    {
        bars: null,
        plan: unremarkable({ incoming: record(128), outgoing: record(128, { mixOutMs: 10_000 }) }),
        why: 'and nothing when eight will not',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 165_000,
        plan: unremarkable({
            incoming: record(128),
            notBeforeMs: 160_000,
            outgoing: record(128, { mixOutMs: 180_000 }),
        }),
        style: 'blend',
        total: 0.68,
        why: 'a mix cannot start before the engine could have got ready',
    },
    {
        bars: null,
        plan: unremarkable({
            incoming: record(128),
            notBeforeMs: 179_000,
            outgoing: record(128, { mixOutMs: 180_000 }),
        }),
        why: 'and too late is a crossfade',
    },
    {
        bars: null,
        plan: unremarkable({ incoming: record(128), outgoing: record(128, { beatsPerBar: null }) }),
        why: 'no meter behind, no mix',
    },
    {
        bars: null,
        plan: unremarkable({ incoming: record(128, { beatsPerBar: null }), outgoing: record(128) }),
        why: 'no meter ahead, no mix',
    },
    {
        bars: null,
        plan: unremarkable({ incoming: record(128, { residualMs: 60 }), outgoing: record(128) }),
        why: 'a grid its own record does not sit on is not one to mix to',
    },
    {
        bars: null,
        plan: unremarkable({
            incoming: record(128, { lengthMs: 110_000, mixInMs: 100_000, mixOutMs: 105_000 }),
            outgoing: record(128),
        }),
        why: 'the incoming record must have the bars to give',
    },
    {
        bars: 8,
        incomingRate: 1.01,
        incomingStartMs: 94_687.5,
        outgoingStartMs: 221_250,
        plan: unremarkable({
            incoming: record(slowBpm, {
                lengthMs: slowMixIn + 30_100,
                mixInMs: slowMixIn,
                mixOutMs: 120_000,
            }),
            outgoing: record(128),
        }),
        style: 'blend',
        total: 0.68,
        why: 'a bent record is consumed faster than the clock: thirty seconds is not enough',
    },
    {
        bars: 16,
        incomingRate: 1.01,
        incomingStartMs: 94_687.5,
        outgoingStartMs: 206_250,
        plan: unremarkable({
            incoming: record(slowBpm, {
                lengthMs: slowMixIn + 30_600,
                mixInMs: slowMixIn,
                mixOutMs: 120_000,
            }),
            outgoing: record(128),
        }),
        style: 'blend',
        total: 0.68,
        why: 'half a second more record and it gets the sixteen',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 221_250,
        plan: unremarkable({
            incoming: record(128, { key: '10B' }),
            outgoing: record(128, { key: '3B' }),
        }),
        style: 'filterFade',
        total: 0.58,
        why: 'records that clash are capped at eight and get the filter fade',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 176_250,
        plan: unremarkable({
            incoming: record(128, { key: '9A' }),
            outgoing: record(128, { key: '8A' }),
        }),
        style: 'blend',
        total: 0.78,
        why: 'neighbours are not capped, and the score decides on longer',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 39_475,
        outgoingStartMs: 168_750,
        plan: unremarkable({
            incoming: record(128, { anchorMs: 100, mixInMs: 40_051 }),
            outgoing: record(128, { mixOutMs: 200_234 }),
        }),
        style: 'blend',
        total: 0.68,
        why: 'both ends are put on the grid, whatever the mix points say',
    },
    {
        bars: null,
        plan: { incoming: grid(), incomingArrangement: plain, outgoing: grid() },
        why: 'an outgoing record that has not been read is not mixed',
    },
    {
        bars: null,
        plan: { incoming: grid(), outgoing: grid(), outgoingArrangement: plain },
        why: 'nor is an incoming one',
    },
    {
        bars: null,
        plan: { incoming: grid(), outgoing: grid() },
        why: 'matching tempo is not a substitute for knowing the arrangement',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid(),
            incomingArrangement: plain,
            outgoing: grid({ mixOutMs: bar * 115 }),
            outgoingArrangement: plain,
        },
        style: 'blend',
        total: 0.7600000000000001,
        why: 'a mix starts on a phrase, not merely on a bar',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid({ mixInMs: bar * 11 }),
            incomingArrangement: plain,
            outgoing: grid(),
            outgoingArrangement: plain,
        },
        style: 'blend',
        total: 0.7600000000000001,
        why: 'and comes in on one',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 20_625,
        outgoingStartMs: 155_625,
        plan: {
            incoming: grid({ mixInMs: bar * 11 }),
            incomingArrangement: noPhrases,
            outgoing: grid({ mixOutMs: bar * 115 }),
            outgoingArrangement: noPhrases,
        },
        style: 'blend',
        total: 0.8000000000000002,
        why: 'without a phrase grid, a bar line is the best there is',
    },
    {
        bars: null,
        plan: {
            incoming: grid(),
            incomingArrangement: singingIn,
            outgoing: grid(),
            outgoingArrangement: singingOut,
        },
        why: 'two records singing at once is not a mix',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 180_000,
        plan: {
            incoming: grid(),
            incomingArrangement: singsLater,
            outgoing: grid(),
            outgoingArrangement: singingOut,
        },
        style: 'filterFade',
        total: 0.665,
        why: 'one voice is fine, and gets the filter fade',
    },
    {
        bars: null,
        plan: {
            incoming: grid(),
            incomingArrangement: singingIn,
            outgoing: grid(),
            outgoingArrangement: cannotTell,
        },
        why: 'not being able to tell counts as singing',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 180_000,
        plan: {
            incoming: grid(),
            incomingArrangement: instrumental,
            outgoing: grid(),
            outgoingArrangement: cannotTell,
        },
        style: 'filterFade',
        total: 0.665,
        why: 'looked and found none is not the same as could not tell',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 180_000,
        plan: {
            incoming: grid(),
            incomingArrangement: dropIn,
            outgoing: grid(),
            outgoingArrangement: dropOut,
        },
        style: 'blend',
        total: 0.7250000000000001,
        why: 'a drop onto a drop gets eight bars, not sixteen',
    },
    {
        bars: 16,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 180_000,
        plan: {
            incoming: grid(),
            incomingArrangement: buildIn,
            outgoing: grid(),
            outgoingArrangement: dropOut,
        },
        style: 'blend',
        total: 0.7250000000000001,
        why: 'coming in on a build keeps the sixteen',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 30_000,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid(),
            incomingArrangement: withBuild,
            outgoing: grid(),
            outgoingArrangement: midEnergy,
        },
        style: 'blend',
        total: 0.8900000000000001,
        why: 'a record comes in on its build when it has one',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 30_000,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid({ key: '8A' }),
            incomingArrangement: withBuild,
            outgoing: grid({ key: '9A' }),
            outgoingArrangement: breakdownOut,
        },
        style: 'blend',
        total: 0.92,
        why: 'everything right earns thirty-two',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid({ key: '9A' }),
            incomingArrangement: buildThenDrop,
            outgoing: grid({ key: '8A' }),
            outgoingArrangement: buildThenDrop,
        },
        style: 'blend',
        total: 0.825,
        why: 'compatible keys and nobody singing is a blend',
    },
    {
        bars: 8,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 180_000,
        plan: {
            incoming: grid({ key: '10B' }),
            incomingArrangement: buildThenDrop,
            outgoing: grid({ key: '3B' }),
            outgoingArrangement: buildThenDrop,
        },
        style: 'filterFade',
        total: 0.625,
        why: 'clashing keys are a capped filter fade',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid({ key: '9A' }),
            incomingArrangement: buildThenDrop,
            outgoing: grid({ key: '8A' }),
            outgoingArrangement: singingThroughout,
        },
        style: 'filterFade',
        total: 0.7649999999999999,
        why: 'the outgoing record singing is a filter fade, uncapped',
    },
    {
        bars: 32,
        incomingRate: 1,
        incomingStartMs: 0,
        outgoingStartMs: 150_000,
        plan: {
            incoming: grid({ key: '9A' }),
            incomingArrangement: singingThroughout,
            outgoing: grid({ key: '8A' }),
            outgoingArrangement: buildThenDrop,
        },
        style: 'filterFade',
        total: 0.7649999999999999,
        why: 'and so is the incoming one',
    },
];

describe('DJ planner parity', () => {
    it.each(TABLE)('$why', (row) => {
        const plan = planMix(row.plan);
        if (row.bars === null) {
            expect(plan).toBeNull();
            return;
        }
        expect(plan).not.toBeNull();
        expect(plan!.bars).toBe(row.bars);
        expect(Math.abs(plan!.outgoingStartMs - row.outgoingStartMs!)).toBeLessThan(1e-9);
        expect(Math.abs(plan!.incomingStartMs - row.incomingStartMs!)).toBeLessThan(1e-9);
        expect(Math.abs(plan!.incomingRate - row.incomingRate!)).toBeLessThan(1e-12);
        expect(Math.abs(scoreTotal(plan!.score) - row.total!)).toBeLessThan(1e-12);
        expect(plan!.style).toBe(row.style);
        expect(plan!.outgoingRate).toBe(1);
        expect(plan!.restoreSeconds).toBe(8);
    });

    it('answers every case in the table', () => {
        expect(TABLE).toHaveLength(39);
    });
});
