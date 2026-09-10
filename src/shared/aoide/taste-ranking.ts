import type { FinishCounts } from './finish-rate';

import { finishRate } from './finish-rate';

/**
 * What this listener has actually been listening to, as numbers something can
 * sort by.
 *
 * Built from the local history rather than from anything the server knows: the
 * server counts a play the moment audio starts, so its idea of a favourite
 * includes everything ever skipped past. This counts listens that finished.
 *
 * The arithmetic is the phone's, spelled the same. `TasteProfile.swift` in
 * Packages/CurationKit carries the identical weights and the identical
 * tie-break, and `taste-ranking-parity.test.ts` holds the two to one table of
 * answers — the same table, verbatim, as `TasteRankingParityTests` on that
 * side. Two apps that both claim to know your taste and disagree about it are
 * worse than one app that does, because the listener has no way to tell which
 * of them is lying.
 *
 * Deliberately pure and deliberately ignorant of any database, so every rule
 * below can be exercised against a profile written by hand.
 */

/** One thing being considered, described by the little that matters here. */
export interface TasteCandidate {
    /** Keyed the way the history keys it: the album artist where there is one. */
    artist: string;
    genres: readonly string[];
    id: string;
}

export interface TasteProfile {
    /** Lower-cased artist to how strongly it figures, 0…1 with the strongest at 1. */
    artists: Readonly<Record<string, number>>;
    /** The same for genres. */
    genres: Readonly<Record<string, number>>;
    /** Heard recently enough that hearing it again would feel like a repeat. */
    recent: ReadonlySet<string>;
}

/**
 * The profile as it crosses the process boundary.
 *
 * A `Set` does not survive structured cloning as a `Set` worth having on the
 * far side of every serialiser this app has, so the wire form is an array and
 * `parseTasteProfile` is where it becomes a set again. That parse is not
 * ceremony: the main process is a different program, the renderer is the one
 * that has to keep working when it answers something unexpected, and an
 * Infinity that throws is an Infinity that stops the music.
 */
export interface TasteProfileWire {
    artists: Record<string, number>;
    genres: Record<string, number>;
    recent: string[];
}

/**
 * What a familiar artist is worth. Less than genre, on purpose: a queue that
 * keeps going should widen out from what is playing rather than stay on the
 * same four artists all evening.
 */
export const TASTE_ARTIST_WEIGHT = 0.3;

/** How far a track's own finish rate can pull it either way. */
export const TASTE_FINISH_WEIGHT = 0.3;

/** How much of the score a familiar genre is worth. */
export const TASTE_GENRE_WEIGHT = 0.45;

/**
 * What it costs to have been heard recently.
 *
 * Wider than the whole of the rest of the scale, which puts *everything* heard
 * lately below *everything* that has not been. Deliberately absolute: a queue
 * that keeps going has to keep going somewhere new, and a song that fits
 * perfectly is exactly the song that would otherwise come round every twenty
 * minutes.
 */
export const TASTE_RECENT_PENALTY = 1.4;

/** A listener nothing is known about. What a new install ranks with. */
export const emptyTasteProfile = (): TasteProfile => ({
    artists: {},
    genres: {},
    recent: new Set(),
});

/**
 * Whether there is anything here to rank by.
 *
 * Recency alone is not a taste — it says what to avoid and nothing about what
 * to prefer — so a profile holding only recents is empty, and its caller leaves
 * the pool in the order it arrived. That is what the phone does, and it is what
 * this did before there was a profile at all.
 */
export const isTasteProfileEmpty = (profile: TasteProfile): boolean =>
    Object.keys(profile.genres).length === 0 && Object.keys(profile.artists).length === 0;

/**
 * A profile from whatever the bridge handed over, or an empty one.
 *
 * Empty rather than a throw, for the same reason `parseActivity` returns null:
 * the caller is a queue that has to keep playing, and a missing profile only
 * means the pool's own order stands. Weights that are not finite numbers are
 * dropped individually rather than taken as evidence the whole answer is
 * rubbish — one unreadable genre is not a reason to forget an artist.
 */
export const parseTasteProfile = (value: unknown): TasteProfile => {
    if (typeof value !== 'object' || value === null) return emptyTasteProfile();

    const wire = value as Partial<TasteProfileWire>;

    return {
        artists: parseWeights(wire.artists),
        genres: parseWeights(wire.genres),
        recent: new Set(
            Array.isArray(wire.recent) ? wire.recent.filter((id) => typeof id === 'string') : [],
        ),
    };
};

/**
 * The best `limit` candidates, best first.
 *
 * Ties break on id so that the same library and the same history produce the
 * same queue twice — a list that reshuffles itself between two runs is one
 * nobody can debug, and it would differ from the phone's for no reason anyone
 * could see.
 *
 * Ids may repeat: with "allow duplicates" on, the pool can hold one song twice,
 * and both copies are ranked and both survive, so the caller still gets the
 * number of items it asked for.
 */
export const rankByTaste = (
    candidates: readonly TasteCandidate[],
    profile: TasteProfile,
    finish: Readonly<Record<string, FinishCounts>>,
    limit: number,
): TasteCandidate[] => {
    if (limit <= 0) return [];

    const scored = candidates.map((candidate) => ({
        candidate,
        score: tasteScore(candidate, profile, counts(finish, candidate.id)),
    }));

    scored.sort((left, right) =>
        left.score === right.score
            ? compareIds(left.candidate.id, right.candidate.id)
            : right.score - left.score,
    );

    return scored.slice(0, limit).map((entry) => entry.candidate);
};

/**
 * One candidate's score. Arithmetic over what the history already says, which
 * means every position it produces can be explained in one sentence — and when
 * it is wrong, it is wrong in a way somebody can point at.
 */
export const tasteScore = (
    candidate: TasteCandidate,
    profile: TasteProfile,
    finish?: FinishCounts,
): number => {
    // The best-matching genre rather than the sum of all of them: a track
    // tagged with six genres is not six times as relevant as one tagged with
    // the right one.
    let genre = 0;
    for (const name of candidate.genres) {
        const weight = weightOf(profile.genres, name);
        if (weight !== undefined && weight > genre) genre = weight;
    }

    const artist = weightOf(profile.artists, candidate.artist) ?? 0;

    // A track with too little history is neither promoted nor punished; the
    // sample rule in `finish-rate.ts` is what decides "too little", and it is
    // asked rather than restated.
    const finishBias = (finish === undefined ? undefined : finishRate(finish)) ?? 0.5;

    const score =
        genre * TASTE_GENRE_WEIGHT +
        artist * TASTE_ARTIST_WEIGHT +
        (finishBias - 0.5) * 2 * TASTE_FINISH_WEIGHT;

    return profile.recent.has(candidate.id) ? score - TASTE_RECENT_PENALTY : score;
};

/** The phone sorts ids with `<`; over the ids either app deals in, so does this. */
const compareIds = (left: string, right: string): number => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
};

const counts = (
    finish: Readonly<Record<string, FinishCounts>>,
    id: string,
): FinishCounts | undefined => (Object.hasOwn(finish, id) ? finish[id] : undefined);

const parseWeights = (weights: unknown): Record<string, number> => {
    if (typeof weights !== 'object' || weights === null) return {};

    const parsed: Record<string, number> = {};
    for (const [key, weight] of Object.entries(weights)) {
        if (typeof weight === 'number' && Number.isFinite(weight)) parsed[key] = weight;
    }

    return parsed;
};

/**
 * A weight by name, lower-cased — matching however the tag was capitalised,
 * which is the only normalisation either app does.
 *
 * `Object.hasOwn` rather than a plain lookup because the profile is an ordinary
 * object: a genre tagged "constructor" would otherwise answer with a function,
 * and the arithmetic below would quietly produce NaN for every track carrying
 * it.
 */
const weightOf = (weights: Readonly<Record<string, number>>, name: string): number | undefined => {
    const key = name.toLowerCase();
    if (!Object.hasOwn(weights, key)) return undefined;

    const weight = weights[key];
    return typeof weight === 'number' ? weight : undefined;
};
