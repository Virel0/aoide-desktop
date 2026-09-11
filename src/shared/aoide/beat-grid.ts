/**
 * Where the beats and the bars are, as the sidecar measured them.
 *
 * A port of `PlaybackKit/BeatGrid.swift`, rule for rule, pinned by
 * `beat-grid-parity.test.ts` and its twin `BeatGridParityTests.swift`. The
 * thing a tempo is not: `/aoide/audio-analysis` says how fast a track is, this
 * says *when* each beat happens, which is the difference between choosing a
 * crossfade's length and actually mixing two records together. See
 * `docs/beat-grid.md` in the iOS repo for the ask and the reasoning.
 *
 * Every field can be absent. A grid that could not be fitted, a meter that
 * could not be established and mix points that depend on that meter are all
 * normal answers about real music, and each means the same thing here: this is
 * not a track to mix, so crossfade it instead.
 */

export interface BeatGrid {
    /**
     * 4 for nearly everything, 3 for a waltz, null when the meter could not be
     * established — in which case nothing bar-aligned may be offered.
     */
    beatsPerBar: null | number;
    /**
     * Which beat of a segment starts a bar. The server promises 0 whenever the
     * meter is known; the field exists because the contract has it.
     */
    downbeatIndex: null | number;
    /**
     * Camelot: `8A` is A minor, `8B` is C major. Used to *prefer* a pair, never
     * to refuse one — the estimator is weakest between a key and its relative
     * major or minor, which is exactly the pair a listener would forgive.
     */
    key: null | string;
    keyConfidence: null | number;
    /** Where a blend may bring this track in. A downbeat, and null with the meter. */
    mixInMs: null | number;
    /** Where a blend may take this track out. A downbeat, and null with the meter. */
    mixOutMs: null | number;
    segments: BeatGridSegment[];
}

/** `GET /aoide/beat-grid`'s answer, as the client keeps it. */
export interface BeatGridReply {
    /** Measured tracks: a grid, or null for "measured, no grid worth having". */
    grids: Record<string, BeatGrid | null>;
    /** Asked for and not measured yet. Ask again later. */
    pending: string[];
}

/**
 * A stretch of the track at one steady tempo. Contiguous, covering the track
 * end to end, so "which segment holds this moment" always has an answer.
 */
export interface BeatGridSegment {
    /** The position of beat zero, which the server puts on a downbeat. */
    anchorMs: number;
    beats: number;
    bpm: number;
    endMs: number;
    /**
     * RMS distance between the fitted beats and the ones actually detected.
     * The field that decides whether anything may lock to this.
     */
    residualMs: number;
    startMs: number;
}

export const beatMs = (segment: BeatGridSegment): number => 60_000 / segment.bpm;

/** `beat(n) = anchor + n × 60000 / bpm`, within a segment. */
export const beatAt = (segment: BeatGridSegment, n: number): number =>
    segment.anchorMs + n * beatMs(segment);

/** The number of the last beat at or before `ms`. */
export const beatIndexAt = (segment: BeatGridSegment, ms: number): number =>
    Math.floor((ms - segment.anchorMs) / beatMs(segment));

/**
 * The segment holding a moment, or the nearest one if the moment falls
 * outside every segment.
 */
export const segmentAt = (grid: BeatGrid, ms: number): BeatGridSegment | null => {
    const holding = grid.segments.find((segment) => ms >= segment.startMs && ms < segment.endMs);
    if (holding) return holding;
    for (let index = grid.segments.length - 1; index >= 0; index -= 1) {
        if (grid.segments[index].startMs <= ms) return grid.segments[index];
    }
    return grid.segments[0] ?? null;
};

/** The length of one bar at a moment, when the meter is known. */
export const barMsAt = (grid: BeatGrid, ms: number): null | number => {
    const segment = segmentAt(grid, ms);
    if (grid.beatsPerBar === null || !segment) return null;
    return beatMs(segment) * grid.beatsPerBar;
};

/**
 * The downbeat at or before `ms`, when the meter is known.
 *
 * Every segment's beat zero is a downbeat, so this is arithmetic within one
 * segment and needs no phase carried across a tempo change.
 */
export const downbeatAtOrBefore = (grid: BeatGrid, ms: number): null | number => {
    const segment = segmentAt(grid, ms);
    if (grid.beatsPerBar === null || !segment) return null;
    const bar = beatMs(segment) * grid.beatsPerBar;
    const bars = Math.floor((ms - segment.anchorMs) / bar);
    return segment.anchorMs + bars * bar;
};

/**
 * How far off its own grid a track may sit and still be worth locking to,
 * for a blend of this many seconds.
 *
 * Sixteen bars at 128 BPM is thirty seconds, and holding a twentieth of a
 * beat across that wants a grid good to about 20 ms — the number the spec was
 * written around. A shorter blend forgives proportionally more, because there
 * is less of it for an error to accumulate across, and the tolerance is capped
 * so that a two-bar blend does not accept a grid that is nonsense.
 */
export const maximumResidualMs = (blendSeconds: number): number => {
    if (!(blendSeconds > 0)) return 0;
    return Math.min(40, 20 * (30 / blendSeconds));
};

/** Whether a blend of this length may be locked to this grid at this moment. */
export const canLock = (grid: BeatGrid, ms: number, blendSeconds: number): boolean => {
    const segment = segmentAt(grid, ms);
    if (grid.beatsPerBar === null || !segment) return false;
    if (segment.residualMs > maximumResidualMs(blendSeconds)) return false;
    // The blend must finish inside the segment it started in: crossing a
    // boundary is crossing a tempo change, and a grid fitted either side of
    // one describes neither half of the blend.
    return ms + blendSeconds * 1000 <= segment.endMs;
};

/**
 * The Camelot wheel, as far as anything here needs it.
 *
 * Only ever used to prefer one pair over another. Never to refuse a pair: the
 * estimator is weakest between a key and its relative major or minor, which
 * share all seven notes and which a listener would not have objected to anyway.
 */
export interface CamelotKey {
    isMinor: boolean;
    number: number;
}

/** A key as its number (1…12) and letter (A minor, B major). */
export const parseCamelot = (key: null | string | undefined): CamelotKey | null => {
    if (!key || key.length < 2) return null;
    const letter = key.slice(-1).toUpperCase();
    if (letter !== 'A' && letter !== 'B') return null;
    // Swift's `Int(_:)` takes an optional sign and nothing else.
    const digits = key.slice(0, -1);
    if (!/^[+-]?\d+$/.test(digits)) return null;
    const number = Number(digits);
    if (number < 1 || number > 12) return null;
    return { isMinor: letter === 'A', number };
};

/**
 * The compatible moves: the same key, one step either way around the wheel,
 * or the same number in the other letter.
 */
export const camelotCompatible = (
    a: null | string | undefined,
    b: null | string | undefined,
): boolean => {
    const first = parseCamelot(a);
    const second = parseCamelot(b);
    if (!first || !second) return false;
    if (first.number === second.number) return true;
    const distance = Math.abs(first.number - second.number);
    const around = Math.min(distance, 12 - distance);
    return around === 1 && first.isMinor === second.isMinor;
};
