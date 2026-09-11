import type { SectionKind } from './arrangement';

import { camelotCompatible } from './beat-grid';

/**
 * How well two records suit each other, as one number and the five it is
 * made of — and, from that, how long they should run together.
 *
 * A port of `PlaybackKit/MixScore.swift`, pinned by the parity tables. The
 * planner used to refuse on one criterion at a time: a key clash meant eight
 * bars, a tempo gap meant no, and nothing in between was expressible. Real
 * compatibility is graded, and a weighted score says how much.
 *
 * A few things stay as hard rules, because a score can be outvoted and some
 * mistakes should not be: two records singing at once is refused, a drop
 * dropped onto a drop is capped at eight bars, and the grid rules in
 * `beat-grid.ts` still decide whether anything may lock at all.
 */
export interface MixScore {
    /**
     * 1 when the outgoing record's exit and the incoming's entry are at the
     * same energy, falling to 0 as they diverge. 0.5 unknown.
     */
    energy: number;
    /**
     * 1 for the same key, a neighbour or the relative; 0 for a clash; 0.5 when
     * either key is unknown, which is most of a library.
     */
    key: number;
    /**
     * How well the two sections suit a hand-over: coming in on a build or an
     * intro is what a DJ does; going out on an outro or a breakdown likewise.
     * A drop at either end is the worst answer. 0.5 unknown.
     */
    sections: number;
    /**
     * 1 up to a two per cent bend — "close BPM is easy" — falling to 0 at the
     * six per cent limit, where a record starts to sound like something was
     * done to it.
     */
    tempo: number;
    /**
     * 1 when neither sings across the overlap, 0.6 when one does, 0.5 when
     * nothing is known. Both singing is not a low score; it is a refusal.
     */
    vocals: number;
}

export const MIX_SCORE_WEIGHTS = {
    energy: 0.2,
    key: 0.2,
    sections: 0.25,
    tempo: 0.2,
    vocals: 0.15,
} as const;

/** Where a bend stops being free. */
export const EASY_BEND = 0.02;

/**
 * How far a record may be bent to meet another.
 *
 * Six per cent is about the range of a turntable's pitch fader, and it is also
 * about where a listener starts to hear that something has been done to the
 * record rather than to the mix.
 */
export const MAXIMUM_STRETCH = 0.06;

/** Summed in the Swift's order, so the two totals are the same double. */
export const scoreTotal = (score: MixScore): number =>
    score.tempo * MIX_SCORE_WEIGHTS.tempo +
    score.key * MIX_SCORE_WEIGHTS.key +
    score.vocals * MIX_SCORE_WEIGHTS.vocals +
    score.energy * MIX_SCORE_WEIGHTS.energy +
    score.sections * MIX_SCORE_WEIGHTS.sections;

/**
 * How long the pair should run together, from the score alone. The planner
 * still has to find room for it and may settle for less.
 */
export const scoreBars = (score: MixScore): null | number => {
    const total = scoreTotal(score);
    if (total >= 0.75) return 32;
    if (total >= 0.55) return 16;
    if (total >= 0.35) return 8;
    return null;
};

export const tempoFactor = (rate: number): number => {
    const bend = Math.abs(rate - 1);
    if (!(bend > EASY_BEND + 1e-9)) return 1;
    return Math.max(0, 1 - (bend - EASY_BEND) / (MAXIMUM_STRETCH - EASY_BEND));
};

export const keyFactor = (a: null | string, b: null | string): number => {
    if (a === null || b === null) return 0.5;
    return camelotCompatible(a, b) ? 1 : 0;
};

export const vocalsFactor = (
    outgoingSings: boolean | null,
    incomingSings: boolean | null,
): number => {
    if (outgoingSings === null || incomingSings === null) return 0.5;
    if (!outgoingSings && !incomingSings) return 1;
    return 0.6;
};

export const energyFactor = (exit: null | number, entry: null | number): number => {
    if (exit === null || entry === null) return 0.5;
    return Math.max(0, 1 - Math.abs(exit - entry));
};

const EXIT_SCORES: Record<SectionKind, number> = {
    breakdown: 1,
    build: 0.7,
    chorus: 0.7,
    drop: 0.4,
    intro: 0.7,
    outro: 1,
    unknown: 0.6,
    verse: 0.7,
};

const ENTRY_SCORES: Record<SectionKind, number> = {
    breakdown: 1,
    build: 1,
    chorus: 0.7,
    drop: 0.2,
    intro: 1,
    outro: 0.7,
    unknown: 0.6,
    verse: 0.7,
};

export const sectionsFactor = (exit: null | SectionKind, entry: null | SectionKind): number => {
    if (exit === null || entry === null) return 0.5;
    return (EXIT_SCORES[exit] + ENTRY_SCORES[entry]) / 2;
};
