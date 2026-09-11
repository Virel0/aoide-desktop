import { describe, expect, it } from 'vitest';

import { Arrangement, ArrangementSection, SectionKind } from './arrangement';
import { BeatGrid } from './beat-grid';
import {
    bendableRate,
    DJTransition,
    MINIMUM_BARS,
    planMix,
    PREFERRED_BARS,
    RESTORE_SECONDS,
} from './dj-planner';

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

const bar = (60_000 / 128) * 4;

/** A four-minute record at 128, mixable from bar 8 to sixteen bars before the end. */
const grid = (over: { anchorMs?: number; mixInMs?: number; mixOutMs?: number } = {}): BeatGrid => {
    const anchorMs = over.anchorMs ?? 0;
    return {
        beatsPerBar: 4,
        downbeatIndex: 0,
        key: null,
        keyConfidence: null,
        mixInMs: over.mixInMs ?? anchorMs + bar * 8,
        mixOutMs: over.mixOutMs ?? anchorMs + bar * 112,
        segments: [{ anchorMs, beats: 512, bpm: 128, endMs: 240_000, residualMs: 4, startMs: 0 }],
    };
};

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

/**
 * A record that has been read and found unremarkable: one section nobody
 * could name, instrumental, no phrase grid. The planner refuses a record that
 * has not been read at all, so every pair below is handed one of these. The
 * two energies differ so that a pair with nothing else going for it lands on
 * sixteen bars rather than being flattered into thirty-two.
 */
const read = (energy: number): Arrangement => ({
    phraseAnchorMs: null,
    phraseBars: null,
    sections: [{ endMs: 600_000, energy, kind: 'unknown', startMs: 0 }],
    vocals: [],
});

const planned = (args: {
    incoming: BeatGrid;
    notBeforeMs?: number;
    outgoing: BeatGrid;
}): DJTransition | null =>
    planMix({
        ...args,
        incomingArrangement: read(0.2),
        outgoingArrangement: read(0.8),
    });

describe('planning a mix', () => {
    it('two records at one tempo get sixteen bars', () => {
        const plan = planned({ incoming: record(128), outgoing: record(128) });
        expect(plan?.bars).toBe(16);
        // Sixteen bars at 128 is thirty seconds.
        expect(plan?.seconds).toBeCloseTo(30, 2);
        expect(plan?.outgoingRate).toBe(1);
        expect(plan?.incomingRate).toBe(1);
        expect(plan?.targetBpm).toBe(128);
        expect(plan?.restoreSeconds).toBe(RESTORE_SECONDS);
    });

    it('the mix ends where the outgoing record stops being mixable', () => {
        const plan = planned({
            incoming: record(128),
            outgoing: record(128, { mixOutMs: 180_000 }),
        });
        expect(plan!.outgoingStartMs + plan!.seconds * 1000).toBeCloseTo(180_000, 2);
    });

    it('starts on a downbeat, a whole number of bars from the anchor', () => {
        const outgoing = record(128, { anchorMs: 431.2, mixOutMs: 431.2 + 1875 * 64 });
        const plan = planned({ incoming: record(128), outgoing });
        const bars = (plan!.outgoingStartMs - 431.2) / 1875;
        expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
    });

    it('the incoming record is the one that bends, and only so far', () => {
        // 126 into 128 is a sixteenth of a semitone; well inside the fader.
        const plan = planned({ incoming: record(126), outgoing: record(128) });
        expect(plan?.outgoingRate).toBe(1);
        expect(plan?.incomingRate).toBeCloseTo(128 / 126, 9);
        // 100 into 128 is not a bend, it is a different record.
        expect(planned({ incoming: record(100), outgoing: record(128) })).toBeNull();
    });

    it('double time counts, and is not slowed down to prove it', () => {
        const plan = planned({ incoming: record(170), outgoing: record(85) });
        expect(plan?.incomingRate).toBeCloseTo(1, 9);
        const reversed = planned({ incoming: record(85), outgoing: record(170) });
        expect(reversed?.incomingRate).toBeCloseTo(1, 9);
    });

    it('six per cent is the limit either way', () => {
        expect(bendableRate(128, 128 * 1.06)).not.toBeNull();
        expect(bendableRate(128, 128 * 1.07)).toBeNull();
        expect(bendableRate(128, 128 / 1.06)).not.toBeNull();
        expect(bendableRate(128, 128 / 1.07)).toBeNull();
        expect(bendableRate(0, 128)).toBeNull();
        expect(bendableRate(128, 0)).toBeNull();
        expect(bendableRate(Number.POSITIVE_INFINITY, 128)).toBeNull();
        expect(bendableRate(128, Number.NaN)).toBeNull();
        // Folded: four octaves down is still one groove.
        expect(bendableRate(32, 128)).toBeCloseTo(1, 12);
        expect(bendableRate(128, 32)).toBeCloseTo(1, 12);
        // The fold boundary: 1.5 is not folded, a hair over is.
        expect(bendableRate(100, 150)).toBeNull();
        expect(bendableRate(100, 200)).toBeCloseTo(1, 12);
    });

    it('eight bars when sixteen will not fit, and nothing when eight will not', () => {
        // Only twenty seconds of mixable record left: sixteen bars is thirty.
        const cramped = record(128, { mixOutMs: 20_000 });
        expect(planned({ incoming: record(128), outgoing: cramped })?.bars).toBe(8);
        const tooCramped = record(128, { mixOutMs: 10_000 });
        expect(planned({ incoming: record(128), outgoing: tooCramped })).toBeNull();
    });

    it('a mix cannot start before the engine could have got ready', () => {
        const outgoing = record(128, { mixOutMs: 180_000 });
        // The mix would start at 150s; being told nothing may start before
        // 160s rules out sixteen bars, and eight bars starts at 165s.
        expect(planned({ incoming: record(128), notBeforeMs: 160_000, outgoing })?.bars).toBe(8);
        expect(planned({ incoming: record(128), notBeforeMs: 165_000, outgoing })?.bars).toBe(8);
        expect(planned({ incoming: record(128), notBeforeMs: 165_001, outgoing })).toBeNull();
        expect(planned({ incoming: record(128), notBeforeMs: 179_000, outgoing })).toBeNull();
    });

    it('no meter, no mix', () => {
        expect(
            planned({ incoming: record(128), outgoing: record(128, { beatsPerBar: null }) }),
        ).toBeNull();
        expect(
            planned({ incoming: record(128, { beatsPerBar: null }), outgoing: record(128) }),
        ).toBeNull();
    });

    it('no mix points, no mix', () => {
        expect(
            planned({ incoming: record(128), outgoing: { ...record(128), mixOutMs: null } }),
        ).toBeNull();
        expect(
            planned({ incoming: { ...record(128), mixInMs: null }, outgoing: record(128) }),
        ).toBeNull();
    });

    it('no segments, no mix', () => {
        expect(
            planned({ incoming: record(128), outgoing: { ...record(128), segments: [] } }),
        ).toBeNull();
        expect(
            planned({ incoming: { ...record(128), segments: [] }, outgoing: record(128) }),
        ).toBeNull();
    });

    it('a grid its own record does not sit on is not one to mix to', () => {
        const sloppy = record(128, { residualMs: 60 });
        expect(planned({ incoming: record(128), outgoing: sloppy })).toBeNull();
        expect(planned({ incoming: sloppy, outgoing: record(128) })).toBeNull();
    });

    it('the incoming record must have the bars to give', () => {
        // Mixable from 100s, but the record stops at 110s: ten seconds is not
        // sixteen bars, and not eight either.
        const stub = record(128, { lengthMs: 110_000, mixInMs: 100_000, mixOutMs: 105_000 });
        expect(planned({ incoming: stub, outgoing: record(128) })).toBeNull();
    });

    it('a bent record is consumed faster than the clock, and must have that much', () => {
        const bpm = 128 / 1.01;
        const mixIn = (60_000 / bpm) * 4 * 50;
        const short = record(bpm, { lengthMs: mixIn + 30_100, mixInMs: mixIn, mixOutMs: 120_000 });
        expect(planned({ incoming: short, outgoing: record(128) })?.bars).toBe(8);
        const longer = record(bpm, { lengthMs: mixIn + 30_600, mixInMs: mixIn, mixOutMs: 120_000 });
        expect(planned({ incoming: longer, outgoing: record(128) })?.bars).toBe(16);
    });

    it('records that clash get the short mix, not the long one', () => {
        const clashing = planned({
            incoming: record(128, { key: '10B' }),
            outgoing: record(128, { key: '3B' }),
        });
        expect(clashing?.bars).toBe(MINIMUM_BARS);
        expect(clashing?.isKeyCompatible).toBe(false);
        const related = planned({
            incoming: record(128, { key: '9A' }),
            outgoing: record(128, { key: '8A' }),
        });
        // Neighbours are not capped: with a record this unremarkable in every
        // other way, the score alone decides, and it decides on longer.
        expect(related!.bars).toBeGreaterThan(clashing!.bars);
        expect(related?.isKeyCompatible).toBe(true);
        expect(related?.style).toBe('blend');
        expect(clashing?.style).toBe('filterFade');
        // An unmeasured key is not a clash — most of a library has no key at
        // all, and shortening every mix on that basis would be shortening every
        // mix.
        const unmeasured = planned({ incoming: record(128), outgoing: record(128) });
        expect(unmeasured?.bars).toBe(PREFERRED_BARS);
        expect(unmeasured?.isKeyCompatible).toBe(false);
        expect(unmeasured?.style).toBe('blend');
    });

    it('both ends are put on the grid, whatever the mix points say', () => {
        const crooked = record(128, { anchorMs: 0, mixOutMs: 200_000 + 234 });
        const incoming = record(128, { anchorMs: 100, mixInMs: 40_000 + 51 });
        const plan = planned({ incoming, outgoing: crooked });
        const outBars = plan!.outgoingStartMs / 1875;
        expect(Math.abs(outBars - Math.round(outBars))).toBeLessThan(1e-6);
        const inBars = (plan!.incomingStartMs - 100) / 1875;
        expect(Math.abs(inBars - Math.round(inBars))).toBeLessThan(1e-6);
        // Snapped back, never forward.
        expect(plan!.incomingStartMs).toBeLessThanOrEqual(40_051);
        expect(plan!.outgoingStartMs + plan!.seconds * 1000).toBeLessThanOrEqual(200_234);
    });
});

describe('what a mix can see, now that it can see the music', () => {
    it('a mix starts on a phrase when one is close, and on the bar when it is not', () => {
        // Mix-out at bar 115; thirty-two back is bar 83 — three bars past the
        // phrase line, further than the two the server itself allows a
        // boundary to move — so the start stays on bar 83 and the mix ends
        // where the record's mix-out says, not seven bars into it.
        const crooked = { ...grid(), mixOutMs: bar * 115 };
        const plan = planMix({
            incoming: grid(),
            incomingArrangement: plain,
            outgoing: crooked,
            outgoingArrangement: plain,
        });
        expect(plan?.bars).toBe(32);
        expect(plan?.outgoingStartMs).toBeCloseTo(bar * 83, 2);

        // Two bars past a phrase line, the start does move onto it.
        const nearly = { ...grid(), mixOutMs: bar * 114 };
        const snapped = planMix({
            incoming: grid(),
            incomingArrangement: plain,
            outgoing: nearly,
            outgoingArrangement: plain,
        });
        expect(snapped?.outgoingStartMs).toBeCloseTo(bar * 80, 2);

        // Mix-in at bar 11 would come in three bars into a phrase, so it comes
        // in at 0.
        const lateEntry = grid({ mixInMs: bar * 11 });
        const entered = planMix({
            incoming: lateEntry,
            incomingArrangement: plain,
            outgoing: grid(),
            outgoingArrangement: plain,
        });
        expect(entered?.incomingStartMs).toBeCloseTo(0, 2);

        // Without a phrase grid, a bar line is the best there is.
        const noPhrases = arrangement([['unknown', 128, 0.5]], { phraseBars: null });
        const barred = planMix({
            incoming: lateEntry,
            incomingArrangement: noPhrases,
            outgoing: crooked,
            outgoingArrangement: noPhrases,
        });
        expect(barred?.outgoingStartMs).toBeCloseTo(bar * (115 - barred!.bars), 2);
        expect(barred?.incomingStartMs).toBeCloseTo(bar * 11, 2);
    });

    it('two records singing at once is not a mix', () => {
        const singingOut = arrangement([['drop', 128, 0.9]], {
            vocals: [{ endMs: bar * 128, startMs: bar * 90 }],
        });
        const singingIn = arrangement([['drop', 128, 0.9]], {
            vocals: [{ endMs: bar * 40, startMs: 0 }],
        });
        expect(
            planMix({
                incoming: grid(),
                incomingArrangement: singingIn,
                outgoing: grid(),
                outgoingArrangement: singingOut,
            }),
        ).toBeNull();

        // One voice is fine: the incoming record's singing starts after the
        // mix would be over.
        const singsLater = arrangement([['drop', 128, 0.9]], {
            vocals: [{ endMs: bar * 80, startMs: bar * 40 }],
        });
        expect(
            planMix({
                incoming: grid(),
                incomingArrangement: singsLater,
                outgoing: grid(),
                outgoingArrangement: singingOut,
            }),
        ).not.toBeNull();
    });

    it('not being able to tell counts as singing', () => {
        const cannotTell = arrangement([['drop', 128, 0.9]], { vocals: null });
        const sings = arrangement([['drop', 128, 0.9]], {
            vocals: [{ endMs: bar * 128, startMs: 0 }],
        });
        expect(
            planMix({
                incoming: grid(),
                incomingArrangement: sings,
                outgoing: grid(),
                outgoingArrangement: cannotTell,
            }),
        ).toBeNull();
        // Looked and found none is not the same as could not tell.
        const instrumental = arrangement([['drop', 128, 0.9]], { vocals: [] });
        expect(
            planMix({
                incoming: grid(),
                incomingArrangement: instrumental,
                outgoing: grid(),
                outgoingArrangement: cannotTell,
            }),
        ).not.toBeNull();
    });

    it('a drop onto a drop gets eight bars, not sixteen', () => {
        const dropOut = arrangement([
            ['intro', 16, 0.2],
            ['drop', 112, 0.9],
        ]);
        const dropIn = arrangement([['drop', 128, 0.9]]);
        const plan = planMix({
            incoming: grid(),
            incomingArrangement: dropIn,
            outgoing: grid(),
            outgoingArrangement: dropOut,
        });
        expect(plan?.bars).toBe(8);

        // Coming in on a build is what a DJ does, and keeps the sixteen.
        const buildIn = arrangement([
            ['build', 32, 0.4],
            ['drop', 96, 0.9],
        ]);
        const long = planMix({
            incoming: grid(),
            incomingArrangement: buildIn,
            outgoing: grid(),
            outgoingArrangement: dropOut,
        });
        expect(long?.bars).toBe(16);
    });

    it('a record that has not been read is not mixed', () => {
        // Matching tempo is not a substitute for knowing the arrangement.
        expect(planMix({ incoming: grid(), outgoing: grid() })).toBeNull();
        expect(
            planMix({ incoming: grid(), outgoing: grid(), outgoingArrangement: plain }),
        ).toBeNull();
        expect(
            planMix({ incoming: grid(), incomingArrangement: plain, outgoing: grid() }),
        ).toBeNull();
    });

    it('something to hide gets the filter fade; nothing to hide gets the blend', () => {
        const instrumental = arrangement([
            ['build', 32, 0.4],
            ['drop', 96, 0.9],
        ]);
        const agree = planMix({
            incoming: { ...grid(), key: '9A' },
            incomingArrangement: instrumental,
            outgoing: { ...grid(), key: '8A' },
            outgoingArrangement: instrumental,
        });
        expect(agree?.style).toBe('blend');
        expect(agree?.isKeyCompatible).toBe(true);

        // Clashing keys: the outgoing record's melody has to be gone before
        // the two overlap in earnest, and the pair is capped at eight.
        const clash = planMix({
            incoming: { ...grid(), key: '10B' },
            incomingArrangement: instrumental,
            outgoing: { ...grid(), key: '3B' },
            outgoingArrangement: instrumental,
        });
        expect(clash?.style).toBe('filterFade');
        expect(clash?.bars).toBe(MINIMUM_BARS);

        // One of them singing, keys fine: also the filter fade — the voice is
        // the thing to keep out from under the other record — but not capped.
        const singing = arrangement(
            [
                ['build', 32, 0.4],
                ['drop', 96, 0.9],
            ],
            {
                vocals: [{ endMs: bar * 128, startMs: 0 }],
            },
        );
        const voice = planMix({
            incoming: { ...grid(), key: '9A' },
            incomingArrangement: instrumental,
            outgoing: { ...grid(), key: '8A' },
            outgoingArrangement: singing,
        });
        expect(voice?.style).toBe('filterFade');
        expect(voice!.bars).toBeGreaterThan(MINIMUM_BARS);
        // And the same the other way round.
        const incomingVoice = planMix({
            incoming: { ...grid(), key: '9A' },
            incomingArrangement: singing,
            outgoing: { ...grid(), key: '8A' },
            outgoingArrangement: instrumental,
        });
        expect(incomingVoice?.style).toBe('filterFade');
    });

    it('a record comes in on its build when it has one', () => {
        const withBuild = arrangement([
            ['intro', 16, 0.2],
            ['build', 16, 0.5],
            ['drop', 80, 0.95],
            ['outro', 16, 0.2],
        ]);
        const outgoingSide = arrangement([
            ['intro', 16, 0.2],
            ['drop', 96, 0.55],
            ['outro', 16, 0.2],
        ]);
        const plan = planMix({
            incoming: grid(),
            incomingArrangement: withBuild,
            outgoing: grid(),
            outgoingArrangement: outgoingSide,
        });
        expect(plan?.incomingStartMs).toBeCloseTo(bar * 16, 2);
        expect(plan?.score.sections).toBe(1);
    });

    // Two entries scoring the same: the earlier wins, being the thinner one.
    it('on a tie the earlier entry wins', () => {
        const twoBuilds = arrangement([
            ['build', 16, 0.5],
            ['drop', 32, 0.9],
            ['build', 16, 0.5],
            ['drop', 64, 0.9],
        ]);
        const outgoingSide = arrangement([
            ['intro', 16, 0.2],
            ['drop', 96, 0.5],
            ['outro', 16, 0.2],
        ]);
        const plan = planMix({
            incoming: grid(),
            incomingArrangement: twoBuilds,
            outgoing: grid(),
            outgoingArrangement: outgoingSide,
        });
        expect(plan?.incomingStartMs).toBeCloseTo(0, 2);
    });

    // The phone's planner gives up on an entry the moment a length scores
    // nothing, rather than trying the shorter lengths — and the score can
    // change with the length, because the singing check covers exactly the
    // stretch that would overlap. Here the outgoing record sings between
    // bars 80 and 90: a thirty-two-bar overlap from bar 80 hears it and,
    // with a clash, a strained bend and a bad energy match, scores 0.315;
    // sixteen from bar 96 would not hear it and would score 0.375, eight
    // bars. The phone refuses; so does this.
    it('a score refused at one length refuses the entry outright', () => {
        const singsAtEighty: Arrangement = {
            phraseAnchorMs: 0,
            phraseBars: 16,
            sections: [{ endMs: bar * 128, energy: 1, kind: 'drop', startMs: 0 }],
            vocals: [{ endMs: bar * 90, startMs: bar * 80 }],
        };
        const quietDrop: Arrangement = {
            phraseAnchorMs: 0,
            phraseBars: 16,
            sections: [{ endMs: bar * 128, energy: 0, kind: 'drop', startMs: 0 }],
            vocals: [],
        };
        const refused = planMix({
            incoming: {
                ...grid(),
                key: '10B',
                segments: [{ ...grid().segments[0], bpm: 128 / 1.03 }],
            },
            incomingArrangement: quietDrop,
            outgoing: { ...grid(), key: '3B' },
            outgoingArrangement: singsAtEighty,
        });
        expect(refused).toBeNull();
        // The same pair with the singing after the mix-out point is the
        // eight bars the shorter length would have earned.
        const singsAfter: Arrangement = {
            ...singsAtEighty,
            vocals: [{ endMs: bar * 128, startMs: bar * 120 }],
        };
        const allowed = planMix({
            incoming: {
                ...grid(),
                key: '10B',
                segments: [{ ...grid().segments[0], bpm: 128 / 1.03 }],
            },
            incomingArrangement: quietDrop,
            outgoing: { ...grid(), key: '3B' },
            outgoingArrangement: singsAfter,
        });
        expect(allowed?.bars).toBe(8);
    });

    // A score that earns nothing at one entry does not stop another entry
    // being tried.
    it('an entry the score refuses does not refuse the record', () => {
        // Entry at the drop (mix-in) scores 0.41 with a clashing key and a
        // strained tempo; the breakdown entry later scores 0.65 and is chosen,
        // though the clash caps both at eight. The incoming record is slower,
        // so its arrangement is laid out in its own bar.
        const inBar = (60_000 / (128 / 1.05)) * 4;
        const breakdownLater: Arrangement = {
            phraseAnchorMs: 0,
            phraseBars: 16,
            sections: [
                { endMs: inBar * 64, energy: 1, kind: 'drop', startMs: 0 },
                { endMs: inBar * 80, energy: 0.3, kind: 'breakdown', startMs: inBar * 64 },
                { endMs: inBar * 128, energy: 1, kind: 'drop', startMs: inBar * 80 },
            ],
            vocals: [],
        };
        const outgoingSide = arrangement([
            ['intro', 16, 0.2],
            ['drop', 96, 0.3],
            ['outro', 16, 0.2],
        ]);
        const plan = planMix({
            incoming: {
                ...grid({ mixInMs: 0 }),
                key: '10B',
                segments: [{ ...grid().segments[0], bpm: 128 / 1.05 }],
            },
            incomingArrangement: breakdownLater,
            outgoing: { ...grid(), key: '3B' },
            outgoingArrangement: outgoingSide,
        });
        expect(plan?.incomingStartMs).toBeCloseTo(inBar * 64, 2);
        expect(plan?.bars).toBe(8);
        expect(plan?.style).toBe('filterFade');
        // And the same pair with only the drop to come in on comes in there.
        const dropOnly: Arrangement = { ...breakdownLater, sections: [breakdownLater.sections[0]] };
        const short = planMix({
            incoming: {
                ...grid({ mixInMs: 0 }),
                key: '10B',
                segments: [{ ...grid().segments[0], bpm: 128 / 1.05 }],
            },
            incomingArrangement: dropOnly,
            outgoing: { ...grid(), key: '3B' },
            outgoingArrangement: outgoingSide,
        });
        expect(short?.bars).toBe(8);
        expect(short?.incomingStartMs).toBe(0);
    });
});
