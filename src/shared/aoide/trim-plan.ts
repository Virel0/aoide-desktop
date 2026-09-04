/**
 * Where a track's sound starts and stops, and what a player should do about it.
 *
 * The measurement is the phone's (`SilenceBounds.swift`, and
 * `docs/sound-bounds.md` in the iOS repo): a sample is sound above −55 dBFS,
 * the start is the first such sample less 60 ms, the end the last plus 200 ms,
 * and a file with under 300 ms to trim at both ends reports no bounds at all.
 * The sidecar serves the same numbers for streamed tracks, since neither the
 * desktop nor a phone playing a stream holds the file to measure.
 *
 * This module decides *what* to do with a pair of bounds. Both players consult
 * it and neither restates it: the web player seeks and advances early, mpv
 * takes per-file `start=` and `end=`, and the numbers they act on come from
 * here.
 */

/** The sidecar's row for one track. Milliseconds from the start of the file. */
export interface SoundBounds {
    soundEndMs: number;
    soundStartMs: number;
}

/** `GET /aoide/sound-bounds` — see the spec. */
export interface SoundBoundsReply {
    /** Measured tracks: bounds, or null for "measured, nothing to trim". */
    bounds: Record<string, null | SoundBounds>;
    /** Asked for and not measured yet. Play whole this time; ask again later. */
    pending: string[];
}

/**
 * What a player does with a track: start here, stop there.
 *
 * `startSec` is 0 when there is nothing to skip at the front. `endSec` is null
 * when the track plays to its own end. Never both, because that is not a plan
 * — `trimFor` returns null instead.
 */
export interface TrimPlan {
    endSec: null | number;
    startSec: number;
}

/**
 * Under this, a trim is not worth a seek.
 *
 * The phone's rule, applied per end: a seek on the web player is a stall of
 * its own, and cutting 200 ms of tail costs more than it saves. The server
 * already withholds bounds when *both* ends are under this; a track with a
 * long lead-in and a tight ending still gets its lead-in skipped and its
 * ending left alone.
 */
export const MIN_TRIM_MS = 300;

const toSeconds = (ms: number): number => Math.round(ms) / 1000;

/**
 * The plan for a track, or null when there is nothing to do.
 *
 * `bounds` null is the sidecar's "measured, nothing to trim"; undefined is
 * "not known yet" — both play whole. `durationMs` is the track's length as
 * the library reports it, used only to refuse an end past the end: a bound
 * beyond the file would be a file that was replaced since it was measured,
 * and cutting nothing is the safe reading of that.
 */
export const trimFor = (
    bounds: null | SoundBounds | undefined,
    durationMs?: null | number,
): null | TrimPlan => {
    if (!bounds) return null;

    const { soundEndMs, soundStartMs } = bounds;
    if (!Number.isFinite(soundStartMs) || !Number.isFinite(soundEndMs)) return null;
    if (soundEndMs <= soundStartMs) return null;

    const startSec = soundStartMs >= MIN_TRIM_MS ? toSeconds(soundStartMs) : 0;

    const known = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0;
    const trimsEnd = known
        ? durationMs - soundEndMs >= MIN_TRIM_MS
        : // Without a length there is nothing to compare against; the server's
          // own 300 ms rule already said this end was worth reporting.
          true;
    const endSec = trimsEnd ? toSeconds(soundEndMs) : null;

    if (startSec === 0 && endSec === null) return null;
    return { endSec, startSec };
};

/**
 * Whether the player has reached the end of the sound.
 *
 * `>=` rather than `>`: progress arrives in samples a quarter-second apart,
 * and the one that lands exactly on the bound is the last worth hearing.
 */
export const shouldAdvance = (currentSec: number, endSec: null | number): boolean =>
    endSec !== null && Number.isFinite(currentSec) && currentSec >= endSec;

/**
 * The plan as mpv's per-file options: `start=<s>` and `end=<s>`, values as
 * strings, because mpv's `loadfile` takes its option values as strings and
 * nothing else. Only the ends that trim are named; an absent option leaves
 * mpv's own default, which is the file's own edge.
 */
export const mpvFileOptions = (plan: TrimPlan): Record<string, string> => {
    const options: Record<string, string> = {};
    if (plan.startSec > 0) options.start = String(plan.startSec);
    if (plan.endSec !== null) options.end = String(plan.endSec);
    return options;
};
