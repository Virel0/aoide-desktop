import type { Arrangement, SectionKind } from './arrangement';
import type { BeatGrid } from './beat-grid';
import type { MixScore } from './mix-score';

import { maySing, phraseStartAtOrBefore, sectionAt } from './arrangement';
import { barMsAt, camelotCompatible, canLock, downbeatAtOrBefore, segmentAt } from './beat-grid';
import {
    energyFactor,
    keyFactor,
    MAXIMUM_STRETCH,
    scoreBars,
    scoreTotal,
    sectionsFactor,
    tempoFactor,
    vocalsFactor,
} from './mix-score';

/**
 * Two ways out.
 *
 * `blend` is the standard one: the outgoing record keeps its whole voice until
 * the swap, gives up its bass, and fades. For pairs that agree. `filterFade`
 * sweeps the outgoing record's low end *and* its middle away across the first
 * half — melody, chords and the body of a voice go, hats and snare stay — so
 * by the time the incoming record has its bass, the old one is rhythm and air.
 * For pairs that clash in key, or where one of them is singing: the two never
 * have their notes on top of each other, which is the whole point of it.
 */
export type DJStyle = 'blend' | 'filterFade';

/**
 * A mix: two records beat-matched, bar-aligned and handed over on a downbeat.
 *
 * A port of `PlaybackKit/DJTransition.swift`'s planner, pinned by
 * `dj-planner-parity.test.ts` and `DJPlannerParityTests.swift`. Everything
 * here is arithmetic over the sidecar's beat grid and arrangement; no audio,
 * so the rules can be argued with directly.
 *
 * **It refuses far more often than it fires**, and that is the design rather
 * than a limitation. Anything without a grid, a meter, mix points, a tempo
 * close enough to bend, or room to run falls back to Crossfade, which is
 * already built and already good.
 */
export interface DJTransition {
    /** How many bars the two run together. */
    bars: number;
    /** What the incoming deck runs at to meet the outgoing tempo — the bend. */
    incomingRate: number;
    /** Where the incoming track begins playing. A phrase or bar line. */
    incomingStartMs: number;
    /**
     * Whether the two keys are neighbours on the Camelot wheel. Never a reason
     * to refuse a mix, but worth knowing.
     */
    isKeyCompatible: boolean;
    /**
     * Always 1: the record already playing is the one the listener is already
     * hearing, and bending it under them is the one thing a mix must not do.
     */
    outgoingRate: number;
    /** Where the mix begins in the outgoing track, on its own clock. A downbeat. */
    outgoingStartMs: number;
    /**
     * How long, after the mix, the incoming track takes to ease back to its own
     * tempo. Left bent forever, every record after the first would play at the
     * speed of whatever preceded it.
     */
    restoreSeconds: number;
    /** How the pair scored, and why. */
    score: MixScore;
    /** How long the mix is in seconds, at the tempo the mix runs at. */
    seconds: number;
    /** How the outgoing record leaves. */
    style: DJStyle;
    /** The tempo both decks run at while they are together. */
    targetBpm: number;
}

/** What a pair with nothing known against it gets: sixteen bars. */
export const PREFERRED_BARS = 16;

/** The shortest a mix is; anything less is a crossfade. */
export const MINIMUM_BARS = 8;

/**
 * How long the incoming record takes to find its own tempo again once the mix
 * is over. Long enough not to be a lurch, short enough to be finished before
 * anybody is listening for it.
 */
export const RESTORE_SECONDS = 8;

/** The longest a pair may run together, and the lengths tried in turn. */
export const MIX_LENGTHS: readonly number[] = [32, 16, 8];

export interface PlanMixArgs {
    /** The grid of the one that follows. */
    incoming: BeatGrid;
    incomingArrangement?: Arrangement | null;
    /**
     * The earliest point in the outgoing track the mix may start. The engine's
     * answer to "how much warning do I need".
     */
    notBeforeMs?: number;
    /** The grid of the record playing now. */
    outgoing: BeatGrid;
    outgoingArrangement?: Arrangement | null;
}

/**
 * The rate the incoming deck runs at to sit on the outgoing tempo, or null if
 * that is further than a record may be bent.
 *
 * Folded into one octave first, because 85 against 170 is one groove counted
 * two ways — and note what that means for the rate it returns: a double-time
 * record is **not** slowed to half speed. It is played at its own speed, where
 * its beats already coincide with every other beat of the other record.
 */
export const bendableRate = (bpm: number, target: number): null | number => {
    if (!(bpm > 0) || !(target > 0) || !Number.isFinite(bpm) || !Number.isFinite(target)) {
        return null;
    }
    let ratio = target / bpm;
    while (ratio > 1.5) ratio /= 2;
    while (ratio < 1 / 1.5) ratio *= 2;
    // A hair of slack, because the limit is a musical judgement rather than an
    // exact quantity and 128 × 1.06 does not divide back to exactly 1.06.
    if (Math.abs(ratio - 1) > MAXIMUM_STRETCH + 1e-9) return null;
    return ratio;
};

/**
 * A candidate entry, put on the phrase line it sits in when the record counts
 * phrases and on the bar line otherwise. A record brought in three bars into a
 * phrase is a record brought in at the wrong moment however exactly its beats
 * land.
 */
const entryPoint = (
    ms: number,
    grid: BeatGrid,
    arrangement: Arrangement | null | undefined,
    barMs: number,
): number =>
    (arrangement ? phraseStartAtOrBefore(arrangement, ms, barMs) : null) ??
    downbeatAtOrBefore(grid, ms) ??
    ms;

/** Plans a mix, or returns null — which means Crossfade. */
export const planMix = (args: PlanMixArgs): DJTransition | null => {
    const {
        incoming,
        incomingArrangement = null,
        notBeforeMs = 0,
        outgoing,
        outgoingArrangement = null,
    } = args;

    // Both records have to be gridded, metered, and have somewhere to mix —
    // and both have to have been *read*. Matching tempo is not a substitute
    // for knowing the arrangement: without it, two pop records with clashing
    // keys and a voice on each were scoring eight bars together, and eight
    // bars of two singers in two keys is not a mix by any definition. A record
    // the server has not read yet crossfades, which is fine.
    if (!outgoingArrangement || !incomingArrangement) return null;
    const outMixOut = outgoing.mixOutMs;
    const inMixIn = incoming.mixInMs;
    if (outMixOut === null || inMixIn === null) return null;
    const outSegment = segmentAt(outgoing, outMixOut);
    if (!outSegment) return null;
    if (outgoing.beatsPerBar === null || incoming.beatsPerBar === null) return null;
    const outBar = barMsAt(outgoing, outMixOut);
    const inBar = barMsAt(incoming, inMixIn);
    if (outBar === null || inBar === null) return null;

    // The bend, folded into one octave: 85 against 170 is one groove counted
    // two ways, and the incoming deck can play the double-time record at half
    // speed to sit inside it.
    const rate = bendableRate(segmentAt(incoming, inMixIn)?.bpm ?? 0, outSegment.bpm);
    if (rate === null) return null;

    // Where the incoming record could come in. Its mix-in point always; and
    // with an arrangement, the start of every build, intro and breakdown as
    // well — because coming in on a build is what a DJ does, and the mix-in
    // point is only where the groove starts.
    const entries = [entryPoint(inMixIn, incoming, incomingArrangement, inBar)];
    for (const section of incomingArrangement?.sections ?? []) {
        if (section.kind === 'build' || section.kind === 'intro' || section.kind === 'breakdown') {
            entries.push(entryPoint(section.startMs, incoming, incomingArrangement, inBar));
        }
    }

    // Best score wins; on a tie, the earlier entry, which is the thinner one.
    let best: DJTransition | null = null;
    for (const entry of [...new Set(entries)].sort((a, b) => a - b)) {
        const candidate = planEntry({
            entry,
            inBar,
            incoming,
            incomingArrangement,
            notBeforeMs,
            outBar,
            outgoing,
            outgoingArrangement,
            outMixOut,
            outSegmentBpm: outSegment.bpm,
            rate,
        });
        if (!candidate) continue;
        if (best === null || scoreTotal(candidate.score) > scoreTotal(best.score)) {
            best = candidate;
        }
    }
    return best;
};

/** One entry point, scored and fitted. */
const planEntry = (args: {
    entry: number;
    inBar: number;
    incoming: BeatGrid;
    incomingArrangement: Arrangement | null;
    notBeforeMs: number;
    outBar: number;
    outgoing: BeatGrid;
    outgoingArrangement: Arrangement | null;
    outMixOut: number;
    outSegmentBpm: number;
    rate: number;
}): DJTransition | null => {
    const {
        entry,
        incoming,
        incomingArrangement,
        notBeforeMs,
        outBar,
        outgoing,
        outgoingArrangement,
        outMixOut,
        outSegmentBpm,
        rate,
    } = args;

    const inSegment = segmentAt(incoming, entry);
    if (!inSegment) return null;

    const exitKind: null | SectionKind = outgoingArrangement
        ? (sectionAt(outgoingArrangement, outMixOut)?.kind ?? null)
        : null;
    const entryKind: null | SectionKind = incomingArrangement
        ? (sectionAt(incomingArrangement, entry)?.kind ?? null)
        : null;

    // Two drops on top of each other is the mistake every DJ names first — a
    // new chorus dropped onto somebody else's. Whatever the rest of the score
    // says, that pair does not get long together. Nor do two records whose
    // keys are known to clash: the filter fade takes the melody out of the
    // outgoing one, but progressively, and the shorter the overlap the less of
    // it there is to hear. A key nobody measured is not a clash; most of a
    // library has none.
    const dropOnDrop = exitKind === 'drop' && entryKind === 'drop';
    const compatible = camelotCompatible(outgoing.key, incoming.key);
    const keysClash = outgoing.key !== null && incoming.key !== null && !compatible;
    const capped = dropOnDrop || keysClash;

    for (const bars of MIX_LENGTHS) {
        const seconds = (outBar * bars) / 1000;
        // Back from the mix-out point a whole number of bars, then onto the
        // phrase line if the record has them. The mix may end a little before
        // the mix-out point as a result; it will not start mid-phrase.
        const counted = outMixOut - outBar * bars;
        const startMs =
            (outgoingArrangement
                ? phraseStartAtOrBefore(outgoingArrangement, counted, outBar)
                : null) ?? counted;

        if (startMs < notBeforeMs) continue;
        if (!canLock(outgoing, startMs, seconds)) continue;
        if (!canLock(incoming, entry, seconds)) continue;
        // A bent record is eaten faster than the clock — thirty seconds at 1.05
        // is thirty-one and a half of source — so it has to have that much of
        // itself left rather than that much wall time.
        if (entry + seconds * 1000 * rate > inSegment.endMs) continue;

        // Singing, across exactly the stretch that would overlap.
        const outgoingSings = outgoingArrangement
            ? maySing(outgoingArrangement, startMs, startMs + seconds * 1000)
            : null;
        const incomingSings = incomingArrangement
            ? maySing(incomingArrangement, entry, entry + seconds * 1000 * rate)
            : null;
        // Two records singing at once is the other thing on every list of what
        // not to do, and not something a client can hear for itself. Unknown
        // counts as singing: a false positive costs a mix, and a false
        // negative is the exact mistake this exists to prevent.
        if (outgoingSings === true && incomingSings === true) continue;

        const score: MixScore = {
            energy: energyFactor(
                outgoingArrangement
                    ? (sectionAt(outgoingArrangement, startMs)?.energy ?? null)
                    : null,
                incomingArrangement
                    ? (sectionAt(incomingArrangement, entry)?.energy ?? null)
                    : null,
            ),
            key: keyFactor(outgoing.key, incoming.key),
            sections: sectionsFactor(exitKind, entryKind),
            tempo: tempoFactor(rate),
            vocals: vocalsFactor(outgoingSings, incomingSings),
        };
        const earned = scoreBars(score);
        if (earned === null) return null;
        const allowed = capped ? Math.min(earned, MINIMUM_BARS) : earned;
        if (bars > allowed) continue;

        // The outgoing side snapped to the grid rather than trusted. The
        // contract says `mixOutMs` is a downbeat and the sidecar keeps that
        // promise — but the arithmetic inherits whatever phase it carries, so a
        // mix point half a beat out would produce a mix half a beat out,
        // silently and for every pair. Snapping costs a bar at most and makes
        // the alignment true of the grid rather than of the promise. (The
        // incoming side was snapped when `entry` was chosen.)
        const start = downbeatAtOrBefore(outgoing, startMs) ?? startMs;

        // Something to hide — a key that is *known* to clash, or one record
        // singing — gets the filter fade. Nothing to hide gets the blend.
        const anyoneSings = outgoingSings === true || incomingSings === true;
        const style: DJStyle = keysClash || anyoneSings ? 'filterFade' : 'blend';

        return {
            bars,
            incomingRate: rate,
            incomingStartMs: entry,
            isKeyCompatible: compatible,
            outgoingRate: 1,
            outgoingStartMs: start,
            restoreSeconds: RESTORE_SECONDS,
            score,
            seconds,
            style,
            targetBpm: outSegmentBpm,
        };
    }
    return null;
};
