/**
 * What a record is made of, section by section, as the sidecar measured it.
 *
 * A port of `PlaybackKit/Arrangement.swift`, pinned by
 * `arrangement-parity.test.ts` and `ArrangementParityTests.swift`. The beat
 * grid says *when*; this says *what*: where the intro is, where the drop is,
 * how loud each part is relative to the rest, how the track counts its
 * phrases, and where somebody is singing. See `docs/arrangement.md` in the iOS
 * repo for the ask and the reasoning.
 *
 * Every part of it is a measurement of the file, not a judgement about the
 * song. `verse` and `chorus` are in the contract and never returned, because
 * telling one from the other is a judgement, and `unknown` is a real and
 * frequent answer.
 */

export type SectionKind =
    | 'breakdown'
    | 'build'
    | 'chorus'
    | 'drop'
    | 'intro'
    | 'outro'
    | 'unknown'
    | 'verse';

export const SECTION_KINDS: readonly SectionKind[] = [
    'intro',
    'build',
    'drop',
    'breakdown',
    'outro',
    'verse',
    'chorus',
    'unknown',
];

export interface Arrangement {
    /** A downbeat that begins a phrase. */
    phraseAnchorMs: null | number;
    /** 8, 16 or 32; null where the structure would not commit. */
    phraseBars: null | number;
    /** Contiguous, covering the track end to end. */
    sections: ArrangementSection[];
    /**
     * Three states and they are not interchangeable: spans where singing was
     * found; empty, meaning looked and found none; **null, meaning it could
     * not be told** — which is not an instrumental, and is treated as "may be
     * singing throughout".
     */
    vocals: ArrangementSpan[] | null;
}

/** `GET /aoide/arrangement`'s answer, as the client keeps it. */
export interface ArrangementReply {
    arrangements: Record<string, Arrangement | null>;
    pending: string[];
}

export interface ArrangementSection {
    endMs: number;
    /**
     * Level and onset density together, normalised within the track so a
     * quiet record's loudest part still reads as 1. Ordering is trustworthy;
     * the figures only mean anything within one track.
     */
    energy: number;
    kind: SectionKind;
    startMs: number;
}

export interface ArrangementSpan {
    endMs: number;
    startMs: number;
}

export const sectionAt = (arrangement: Arrangement, ms: number): ArrangementSection | null => {
    const holding = arrangement.sections.find(
        (section) => ms >= section.startMs && ms < section.endMs,
    );
    if (holding) return holding;
    for (let index = arrangement.sections.length - 1; index >= 0; index -= 1) {
        if (arrangement.sections[index].startMs <= ms) return arrangement.sections[index];
    }
    return null;
};

/**
 * Whether anybody might be singing anywhere in this stretch.
 *
 * Biased towards yes, deliberately: a false positive costs a mix, and a false
 * negative — two voices over each other — is the exact mistake this exists to
 * prevent. Unknown is therefore yes.
 */
export const maySing = (arrangement: Arrangement, from: number, to: number): boolean => {
    if (arrangement.vocals === null) return true;
    return arrangement.vocals.some((span) => span.startMs < to && span.endMs > from);
};

/**
 * How far a moment may be moved to sit on a phrase line: two bars, the
 * server's own rule for its section boundaries. Further than that and the
 * line is not where the music changes — a section boundary five bars past a
 * phrase line is on a bar line for a reason, and dragging it back seven bars
 * puts the exit inside the hook it was meant to end.
 */
export const PHRASE_REACH_BARS = 2;

/** The phrase line at or before `ms` if one is within reach, else null. For moments that must not move later: an exit. */
export const phraseLineAtOrBefore = (
    arrangement: Arrangement,
    ms: number,
    barMs: number,
): null | number => {
    const line = phraseStartAtOrBefore(arrangement, ms, barMs);
    if (line === null) return null;
    return ms - line <= PHRASE_REACH_BARS * barMs + 0.5 ? line : null;
};

/** The nearest phrase line to `ms`, either side, if one is within reach; else null. For moments that may move either way: an entry. */
export const phraseLineNear = (
    arrangement: Arrangement,
    ms: number,
    barMs: number,
): null | number => {
    const { phraseBars } = arrangement;
    const before = phraseStartAtOrBefore(arrangement, ms, barMs);
    if (phraseBars === null || !(barMs > 0) || before === null) return null;
    const after = before + barMs * phraseBars;
    const nearest = ms - before <= after - ms ? before : after;
    return Math.abs(ms - nearest) <= PHRASE_REACH_BARS * barMs + 0.5 ? nearest : null;
};

/** The phrase boundary at or before `ms`, when the track counts phrases. */
export const phraseStartAtOrBefore = (
    arrangement: Arrangement,
    ms: number,
    barMs: number,
): null | number => {
    const { phraseAnchorMs, phraseBars } = arrangement;
    if (phraseBars === null || phraseAnchorMs === null || !(barMs > 0)) return null;
    const phraseMs = barMs * phraseBars;
    const phrases = Math.floor((ms - phraseAnchorMs) / phraseMs);
    return phraseAnchorMs + phrases * phraseMs;
};
