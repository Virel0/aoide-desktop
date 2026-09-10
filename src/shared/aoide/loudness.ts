/**
 * How loud a track is, and what a player should do about it.
 *
 * The measurement is the sidecar's (`docs/audio-analysis.md` in the iOS repo):
 * EBU R128 integrated loudness over the whole track in LUFS, and true peak in
 * dBFS, both as `ffmpeg -af loudnorm=print_format=json` prints them. Neither
 * client can compute either for a file it does not hold, so both ask for the
 * same numbers and — because this module is the only thing that turns them
 * into a gain — both apply the same correction.
 *
 * This module decides *what* to do with a measurement. The player consults it
 * and does not restate it: it multiplies the number into its per-slot gain
 * node and computes nothing itself. The target lives here once, for the same
 * reason the phone reads it from here: two copies of a reference level are two
 * apps that end up at different volumes.
 */

/** The sidecar's row for one track. Any field may be null on its own. */
export interface AudioAnalysis {
    bpm: null | number;
    bpmConfidence: null | number;
    /**
     * The fraction of twenty-second windows whose own tempo agreed with `bpm`
     * — what confidence cannot say, since a track ramping 105 to 145 reports a
     * confident 135. Null from a sidecar older than 1.12.0.0, or a track too
     * short to measure. Only the mixer reads it; see `mix-transition.ts`.
     */
    bpmStability: null | number;
    loudnessLufs: null | number;
    truePeakDbfs: null | number;
}

/** `GET /aoide/audio-analysis` — see the spec. */
export interface AudioAnalysisReply {
    /** Measured tracks: their numbers, or null for "measured, nothing to report". */
    analysis: Record<string, AudioAnalysis | null>;
    /** Asked for and not measured yet. Play unmodified this time; ask again later. */
    pending: string[];
}

/**
 * The reference level, in LUFS. ReplayGain 2.0's, so a file with tags and a
 * file measured by the sidecar land on the same loudness.
 *
 * **The only definition of it in this codebase.** `wiring.test.ts` greps for a
 * second one, because the failure a second copy causes — two halves of the app
 * normalising to different levels — is silent and sounds like nothing at all
 * being wrong until two tracks play back to back.
 */
export const TARGET_LUFS = -18;

/**
 * Below this much correction, leave the file alone.
 *
 * A hundredth of a decibel is inaudible. Rounding to two places and treating
 * the result as nothing keeps a gain node from being written for a correction
 * nobody can hear.
 */
const round = (db: number): number => Math.round(db * 100) / 100;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/**
 * The correction for a measured track, in dB, or null when there is none to
 * make.
 *
 * Three rules, in order:
 *
 * 1. `TARGET_LUFS − loudnessLufs`, the ReplayGain 2.0 calculation.
 * 2. **Attenuate only.** A track at or below the reference is left alone
 *    entirely rather than amplified: boosting it would push its own true peak
 *    up, and a quiet master is usually quiet on purpose. This is an early
 *    return, not a clamp to zero — a track this leaves alone is a track this
 *    has no opinion about at all, including about its peaks.
 * 3. **Never past 0 dBFS.** Rule 2 means the only thing that can put a peak
 *    over full scale is an attenuation this function just chose, which sounds
 *    impossible and is not: a file can already peak above full scale — a lossy
 *    encode of a loud master genuinely can — and be attenuated by less than it
 *    is over. The gain is then reduced until the peak lands exactly on 0.
 *
 * Null for a missing or unusable loudness: nothing measured means nothing
 * applied, which is what the track did before this feature existed. A true peak
 * that is missing is not a reason to refuse the gain — it only removes rule 3.
 */
export const gainDb = (
    loudnessLufs: null | number | undefined,
    truePeakDbfs?: null | number,
): null | number => {
    if (!isFiniteNumber(loudnessLufs)) return null;

    let gain = TARGET_LUFS - loudnessLufs;
    if (gain >= 0) return null;

    if (isFiniteNumber(truePeakDbfs) && truePeakDbfs + gain > 0) {
        gain = -truePeakDbfs;
    }

    const rounded = round(gain);
    return rounded < 0 ? rounded : null;
};

/**
 * Whether the file carries its own ReplayGain, in which case this does
 * nothing.
 *
 * The player already honours tags through `calculateReplayGain`, and Jellyfin
 * synthesises a track gain from its own LUFS scan where it has one. Adding a
 * second correction on top of the first would attenuate twice.
 */
export const hasReplayGain = (
    gain: null | undefined | { album?: null | number; track?: null | number },
): boolean => isFiniteNumber(gain?.track) || isFiniteNumber(gain?.album);

/**
 * The gain for a track as a player sees it: its measurement, its own tags, and
 * whether the setting is on.
 *
 * The whole decision in one call, so no caller can implement half of it.
 * The tag check arrives already made — `hasReplayGain(song.gain)` — because a
 * boolean is a stable React dependency and the song's `gain` object is a fresh
 * one on every render.
 */
export const normalisationGainDb = (args: {
    analysis: AudioAnalysis | null | undefined;
    enabled: boolean;
    hasOwnReplayGain: boolean;
}): null | number => {
    if (!args.enabled) return null;
    if (args.hasOwnReplayGain) return null;
    return gainDb(args.analysis?.loudnessLufs, args.analysis?.truePeakDbfs);
};

/**
 * A gain in dB as a linear amplitude factor, for the web player's gain node.
 *
 * `1` for no gain, so a caller can multiply unconditionally.
 */
export const linearGain = (db: null | number): number => (db === null ? 1 : 10 ** (db / 20));
