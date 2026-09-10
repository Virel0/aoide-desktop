/**
 * How one song is handed over to the next when Crossfade is on.
 *
 * A port of `PlaybackKit/MixTransition.swift` in the iOS repo, rule for rule
 * and constant for constant — `mix-transition-parity.test.ts` and its twin in
 * `MixTransitionParityTests.swift` answer the same table, so a change to
 * either side breaks its own copy. Pure arithmetic over numbers the library
 * already holds: where the sound is, how long the file is, and the tempo the
 * sidecar measured. Nothing here touches a player.
 *
 * **This is not beat-matching, and deliberately so.** Beat-matching needs the
 * position of the beats, not just how many of them there are per minute: two
 * tracks locked to the same tempo but a quarter-beat apart sound worse than
 * two tracks that were never locked at all. The measurement is a single BPM
 * figure good to about a beat per minute, with no downbeat and no grid, and
 * `docs/audio-analysis.md` says not to match on it. So tempo does one job here
 * — deciding whether a long blend is worth attempting — and the crossfade
 * itself is honest about being a crossfade.
 */

/** What the planner needs to know about one track. */
export interface MixTrack {
    /** The album's name, empty when the track has none. */
    album: string;
    /** Beats per minute, null when the measurement was not confident enough. */
    bpm: null | number;
    /**
     * How much of the track that one number describes: the fraction of
     * twenty-second windows that agreed with it. Null from a server too old to
     * report it, or a track too short to measure.
     */
    bpmStability: null | number;
    /** The file's whole length, null when the library does not say. */
    durationSeconds: null | number;
    /** Where the sound is, when it has been measured. */
    sound: null | { soundEndSeconds: number; soundStartSeconds: number };
    trackNumber: null | number;
}

/**
 * The handover.
 *
 * `gapless` is straight into the next track with nothing between them: what an
 * album run gets, because the silence between two tracks of one record is part
 * of the record and a segue written to run continuously must not be faded
 * across. `cut` is the outgoing track finishing and the next one starting,
 * which is the player's ordinary behaviour. `blend` is the two overlapping,
 * the outgoing one fading down as the incoming one fades up.
 *
 * `overlapSeconds` is zero for the two transitions that have none, so a caller
 * can read it unconditionally.
 */
export interface MixTransition {
    kind: 'blend' | 'cut' | 'gapless';
    overlapSeconds: number;
}

/**
 * A blend when both tempi agree. Long enough to be a transition rather than a
 * stumble, short enough that neither track is buried under the other for a
 * verse.
 */
export const MATCHED_BLEND_SECONDS = 8;

/**
 * A blend when they do not agree, or when nothing was measured. Short, because
 * an overlap between two unrelated grooves stops sounding like a transition and
 * starts sounding like two songs at once.
 */
export const UNMATCHED_BLEND_SECONDS = 4;

/**
 * No more than this share of either track may be spent overlapping. A
 * ninety-second interlude blended for eight seconds either side has lost a
 * sixth of itself to the mix.
 */
const MAXIMUM_SHARE_OF_TRACK = 0.25;

/**
 * Below this there is not enough song to fade. Two seconds of overlap on a
 * twenty-second sound clip is not a transition.
 */
const MINIMUM_BLEND_SECONDS = 2;

/**
 * Six per cent — about 7 BPM at 120. Wide enough to survive a measurement good
 * to a beat per minute either way, narrow enough that the two tracks are
 * recognisably the same speed.
 */
const TEMPO_TOLERANCE = 0.06;

/**
 * Below this, the number is an average of a track that was never at it.
 *
 * Half the windows agreeing is already generous: the sidecar's own figures put
 * a 120→122 ramp at 0.62 and a 120→125 ramp at 0.31, and the second of those is
 * a track a listener would call unsteady.
 */
export const MINIMUM_STABILITY = 0.5;

const CUT: MixTransition = { kind: 'cut', overlapSeconds: 0 };
const GAPLESS: MixTransition = { kind: 'gapless', overlapSeconds: 0 };

/**
 * How much of a track is actually sound, in seconds, or null when nothing says.
 *
 * The measured sound where there is a measurement, the whole file otherwise. A
 * length that is not a finite number is no length at all: the web player
 * reports `Infinity` for a stream whose duration the server never sent, and a
 * fade planned as a share of infinity is a fade planned over a guess.
 */
const soundSeconds = (track: MixTrack): null | number => {
    const seconds = track.sound
        ? Math.max(0, track.sound.soundEndSeconds - track.sound.soundStartSeconds)
        : track.durationSeconds;

    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
};

/**
 * Two tracks of the same album, in order.
 *
 * Both parts matter: an album played on shuffle is not a run, and neither is
 * track 1 of a record following track 9 of the same one.
 */
export const isAlbumRun = (outgoing: MixTrack, incoming: MixTrack): boolean => {
    if (outgoing.album === '' || outgoing.album !== incoming.album) return false;
    if (outgoing.trackNumber === null || incoming.trackNumber === null) return false;
    return incoming.trackNumber === outgoing.trackNumber + 1;
};

/**
 * Whether two tempi are near enough for a long blend.
 *
 * Compared as a ratio folded into one octave, because 85 and 170 are the same
 * groove counted differently — and half-or-double is the *expected* failure of
 * the measurement, so a planner that treated them as unrelated would refuse the
 * very pairs that fit best.
 */
export const tempiAgree = (a: null | number | undefined, b: null | number | undefined): boolean => {
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return false;

    let ratio = a / b;
    while (ratio > 1.5) ratio /= 2;
    while (ratio < 1 / 1.5) ratio *= 2;
    return Math.abs(ratio - 1) <= TEMPO_TOLERANCE;
};

/**
 * Whether a measured tempo describes its track well enough to compare.
 *
 * A stability of null is not held against a track: it means a server that never
 * measured it, and refusing every long blend on those grounds would turn an
 * upgrade into a regression for everyone who has not done one. A number that is
 * not a number is not that case and does not get the benefit of it — the
 * comparison below rejects it, exactly as the same comparison does in Swift.
 */
export const tempoHolds = (stability: null | number | undefined): boolean => {
    if (typeof stability !== 'number') return true;
    return stability >= MINIMUM_STABILITY;
};

/**
 * Whether two tracks are near enough in tempo for a long blend.
 *
 * A single BPM figure only describes a track whose tempo holds. One that ramps
 * from 105 to 145 still reports a confident 135, and two such tracks
 * "agreeing" at 135 would earn eight seconds of overlap between passages that
 * are not at 135 at all. So a track whose measured stability says the number
 * does not describe it is not a track anything can be matched to.
 */
const tracksAgree = (outgoing: MixTrack, incoming: MixTrack): boolean => {
    if (!tempoHolds(outgoing.bpmStability) || !tempoHolds(incoming.bpmStability)) return false;
    return tempiAgree(outgoing.bpm, incoming.bpm);
};

/**
 * Plans the handover from `outgoing` to `incoming`.
 *
 * `automix` is the toggle, off by default: off means the player behaves as it
 * always has. `albumLock` keeps album runs intact — on, two consecutive tracks
 * of one album hand over gaplessly whatever Crossfade says, which is what makes
 * album lock the mixer's off-switch for the records that need one rather than
 * a second mixer.
 */
export const planTransition = (args: {
    albumLock: boolean;
    automix: boolean;
    incoming: MixTrack;
    outgoing: MixTrack;
}): MixTransition => {
    const { albumLock, automix, incoming, outgoing } = args;

    if (albumLock && isAlbumRun(outgoing, incoming)) return GAPLESS;
    if (!automix) return CUT;

    const wanted = tracksAgree(outgoing, incoming)
        ? MATCHED_BLEND_SECONDS
        : UNMATCHED_BLEND_SECONDS;

    // Neither track may give up more than its share, and a track whose length
    // is unknown gives up nothing — better a cut than a fade over a guess.
    const outgoingSeconds = soundSeconds(outgoing);
    const incomingSeconds = soundSeconds(incoming);
    if (outgoingSeconds === null || incomingSeconds === null) return CUT;

    const allowed = Math.min(outgoingSeconds, incomingSeconds) * MAXIMUM_SHARE_OF_TRACK;
    const overlapSeconds = Math.min(wanted, allowed);
    if (!(overlapSeconds >= MINIMUM_BLEND_SECONDS)) return CUT;
    return { kind: 'blend', overlapSeconds };
};
