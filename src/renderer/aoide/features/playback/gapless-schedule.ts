/**
 * When the next track has to start, on the clock that can actually hit it.
 *
 * The web player's gapless handover was a guess: start the next `<audio>`
 * element 116 ms early — 65 ms for FLAC — and hope the overlap and the ragged
 * end of the outgoing element cancelled out. They do not. An album side that
 * segues gets a smear of two tracks at once; a track that stops dead gets a
 * stutter. Both are audible, and no constant fixes both, because the error is
 * not a constant.
 *
 * `AudioBufferSourceNode.start(when)` is the one thing in a browser that is
 * sample-accurate: `when` is a time on `AudioContext.currentTime`, and the
 * source begins on the sample that time falls on. So the join stops being a
 * guess and becomes arithmetic — and arithmetic is a thing that can be tested
 * without a listener. That is the whole reason this module exists apart from
 * the Web Audio glue that uses it: everything here is a number in and a number
 * out.
 *
 * The arithmetic is one idea repeated. A track that is playing has a *known
 * position at a known moment on the context clock*, and it advances in real
 * time from there, so it reaches any later position at
 * `reference + (position - positionAtReference)`. For a buffer source that pair
 * is exact — it is the `when` and the `offset` that were handed to `start()`.
 * For an element it is a sample: `element.currentTime` and
 * `context.currentTime` read one after the other. That is the difference
 * between the first join and every join after it, and it is why the first one
 * is only as good as the element's own clock while the rest are exact.
 */

/**
 * An outgoing track that is itself a scheduled buffer. Its end is not sampled,
 * it is known: `start()` was told both numbers.
 */
export interface BufferPlayback {
    kind: 'buffer';
    /** The `offset` handed to `start()`. */
    offsetSec: number;
    /** The `when` handed to `start()`, on the context clock. */
    startedAtContextTime: number;
}

/**
 * An outgoing track playing through an `<audio>` element, as a pair of readings
 * taken together: where the element was, and what the context clock said at
 * that moment. Read them back to back — a gap between the two reads is an error
 * in the join of exactly that length.
 */
export interface ElementPlayback {
    kind: 'element';
    /** `element.currentTime`. */
    positionSec: number;
    /** `context.currentTime`, read alongside it. */
    sampledAtContextTime: number;
}

/**
 * The answer, or why there isn't one.
 *
 * `early` is not a refusal: the boundary is further off than the scheduler
 * wants to commit to, and the caller should ask again on its next tick. `late`
 * and `unusable` are refusals — this boundary will not be joined, and whatever
 * the player does without a deck is what happens.
 */
export type Join =
    | { kind: 'join'; offsetSec: number; startAtContextTime: number }
    | { kind: 'no-join'; reason: 'early' | 'late' | 'unusable' };

export interface JoinRequest {
    /** Where the outgoing track stops. `outgoingEndSec` resolves this. */
    endSec: number;
    /** The decoded length of the incoming buffer. */
    incomingDurationSec: number;
    /** Where the incoming track's sound starts: `trimFor`'s `startSec`, or 0. */
    incomingStartSec: number;
    /** Overrides `SCHEDULE_LEAD_SECONDS`. */
    leadSec?: number;
    /** `context.currentTime`. */
    now: number;
    outgoing: OutgoingPlayback;
    /** Overrides `SCHEDULE_WINDOW_SECONDS`. */
    windowSec?: number;
}

export type OutgoingPlayback = BufferPlayback | ElementPlayback;

/**
 * What a decoded track costs, in bytes.
 *
 * `decodeAudioData` hands back de-interleaved 32-bit floats at the context's
 * own sample rate, whatever the file was: a four-minute stereo track at 44.1 kHz
 * is about 85 MB, and the same track into a context running at 96 kHz is about
 * 185 MB. Two of those is the deck's whole appetite, so the estimate is what
 * decides whether a track is allowed to become a buffer at all.
 */
export const BYTES_PER_SAMPLE = 4;

/**
 * Assume stereo before decoding, because the channel count is not known until
 * the decode is done. Mono is charged double and fits anyway; anything wider
 * than stereo is charged too little, which is why the cap below has room under
 * it rather than sitting at the edge of what is tolerable.
 */
export const CHANNELS_ASSUMED = 2;

/**
 * How far ahead of the boundary the next track is fetched and decoded.
 *
 * Long enough that a slow server, a large FLAC and a decode all fit inside it,
 * short enough that the buffer is not held for most of a track it is not
 * playing yet. Nothing is decoded outside this window, which is what keeps the
 * deck to two tracks.
 */
export const DECODE_LEAD_SECONDS = 30;

/**
 * The most one decoded track may weigh, 192 MiB — nine and a half minutes of
 * stereo at 44.1 kHz, eight and three quarters at 48, four and a third at 96.
 *
 * A cap rather than a promise: a track over it is played the way it always was,
 * and its boundary is not exact. Refusing the long ones is cheap — they are
 * rare, and a twenty-minute side would otherwise be four hundred megabytes of
 * float sitting in a music player.
 */
export const MAX_TRACK_BYTES = 192 * 1024 * 1024;

/**
 * The least notice `start()` is given.
 *
 * A `when` already behind `currentTime` plays immediately, which is the one
 * outcome worse than not joining at all: the incoming track would start in the
 * middle of the outgoing one. Fifty milliseconds is several render quanta of
 * headroom against a main thread that was busy when the tick fired.
 */
export const SCHEDULE_LEAD_SECONDS = 0.05;

/**
 * How close the boundary must be before the join is committed.
 *
 * Not for `start()`'s sake — it takes a `when` an hour out as happily as one a
 * second out — but for the element's. The element's position and the context
 * clock are two clocks, and the longer the gap between reading them and the
 * moment they are used, the further they have drifted apart. Two seconds keeps
 * that under a sample or so while still leaving several ticks to get it done.
 */
export const SCHEDULE_WINDOW_SECONDS = 2;

/**
 * When the outgoing track reaches `endSec`, on the context clock. Null when the
 * numbers cannot say.
 *
 * The two kinds of playback differ only in where the reference pair comes from,
 * which is the point: once a buffer is playing, the same formula stops being an
 * estimate.
 */
export const endsAt = (outgoing: OutgoingPlayback, endSec: number): null | number => {
    if (!Number.isFinite(endSec) || endSec <= 0) return null;

    const reference =
        outgoing.kind === 'buffer' ? outgoing.startedAtContextTime : outgoing.sampledAtContextTime;
    const positionAtReference =
        outgoing.kind === 'buffer' ? outgoing.offsetSec : outgoing.positionSec;

    if (!Number.isFinite(reference)) return null;
    if (!Number.isFinite(positionAtReference) || positionAtReference < 0) return null;

    return reference + (endSec - positionAtReference);
};

/**
 * What a track will weigh once decoded, or infinity when the question is
 * malformed — a duration the library never sent, a context that has been
 * closed. Infinity fails the cap, which is the answer that costs nothing.
 */
export const estimateDecodedBytes = (
    durationSec: number,
    sampleRateHz: number,
    channels: number = CHANNELS_ASSUMED,
): number => {
    const sane = (value: number) => Number.isFinite(value) && value > 0;
    if (!sane(durationSec) || !sane(sampleRateHz) || !sane(channels)) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.ceil(durationSec * sampleRateHz) * channels * BYTES_PER_SAMPLE;
};

/** Whether a track is small enough to be worth holding as a buffer. */
export const fitsInMemory = (
    durationSec: number,
    sampleRateHz: number,
    channels: number = CHANNELS_ASSUMED,
): boolean => estimateDecodedBytes(durationSec, sampleRateHz, channels) <= MAX_TRACK_BYTES;

/**
 * Where the outgoing track actually stops.
 *
 * The trimmed end when silence trimming has measured one, the file's own length
 * otherwise. A trimmed end past the end of the file is a file that was replaced
 * since it was measured, and playing it whole is the safe reading of that —
 * the same reading `trimFor` takes.
 */
export const outgoingEndSec = (
    trimmedEndSec: null | number,
    durationSec: number,
): null | number => {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    if (trimmedEndSec === null || !Number.isFinite(trimmedEndSec)) return durationSec;
    if (trimmedEndSec <= 0 || trimmedEndSec > durationSec) return durationSec;
    return trimmedEndSec;
};

/**
 * The context time the incoming source must be started at, and the offset into
 * it to start from.
 *
 * A start that does not fit inside the buffer is treated as no trim rather than
 * as a refusal: bounds that fall outside the file do not describe the file, and
 * playing it whole loses a fraction of a second where refusing loses the join.
 */
export const planJoin = (request: JoinRequest): Join => {
    const {
        endSec,
        incomingDurationSec,
        incomingStartSec,
        leadSec = SCHEDULE_LEAD_SECONDS,
        now,
        outgoing,
        windowSec = SCHEDULE_WINDOW_SECONDS,
    } = request;

    if (!Number.isFinite(now)) return UNUSABLE;
    if (!Number.isFinite(incomingDurationSec) || incomingDurationSec <= 0) return UNUSABLE;
    if (!Number.isFinite(leadSec) || leadSec < 0) return UNUSABLE;
    if (!Number.isFinite(windowSec) || windowSec < leadSec) return UNUSABLE;

    const startAtContextTime = endsAt(outgoing, endSec);
    if (startAtContextTime === null) return UNUSABLE;

    const until = startAtContextTime - now;
    if (until < leadSec) return LATE;
    if (until > windowSec) return EARLY;

    const usableStart =
        Number.isFinite(incomingStartSec) &&
        incomingStartSec > 0 &&
        incomingStartSec < incomingDurationSec;

    return { kind: 'join', offsetSec: usableStart ? incomingStartSec : 0, startAtContextTime };
};

/**
 * Whether the boundary is close enough to be worth decoding for. A boundary
 * that cannot be located at all is not close.
 */
export const shouldDecode = (
    secondsUntilEnd: number,
    leadSec: number = DECODE_LEAD_SECONDS,
): boolean => Number.isFinite(secondsUntilEnd) && secondsUntilEnd <= leadSec;

const EARLY: Join = { kind: 'no-join', reason: 'early' };
const LATE: Join = { kind: 'no-join', reason: 'late' };
const UNUSABLE: Join = { kind: 'no-join', reason: 'unusable' };
