import type { NextFactors, NextMode } from './next-chooser';

/**
 * The rule the sidecar follows to choose what plays next — `docs/infinity.md`
 * in the iOS repo, as arithmetic — written out here so the rule has a
 * reference on this client and the shared fixture can be checked against it.
 *
 * Not what the app runs: the app asks the server. This is what the server is
 * *held to*: `next-ranking-fixture.test.ts` runs it over the hand-written
 * library and history in `next-ranking-fixture.json` and compares every score
 * and factor to the file the sidecar and the phone also read. The phone's
 * `NextRanking`, line for line.
 *
 * Nothing here reads a database, asks a server, or looks at a clock: `now` is
 * an input, so "the last ninety days" means the same thing every run.
 */

export type NextLibrary = {
    notInterested: ReadonlySet<string>;
    /** The clock, in milliseconds since 1970. */
    now: number;
    plays: readonly NextPlay[];
    records: readonly NextRecord[];
};

/** One decided listen. A play neither completed nor skipped is still in progress. */
export type NextPlay = { completed: boolean; id: string; skipped: boolean; startedAt: number };

export type NextQuery = {
    limit: number;
    mode: NextMode;
    queue: readonly string[];
    /** Newest first, as the request sends it. */
    recent: readonly string[];
    seed: string;
};

export type NextRecord = {
    /** The same string the history is keyed on: album artist, or the first artist, or "Unknown Artist". */
    artist: string;
    bpm: null | number;
    /** Null holds: a tempo without a stability figure is taken as steady. */
    bpmStability: null | number;
    genres: string[];
    id: string;
    key: null | string;
    /** Null is "no arrangement": the record is unread. */
    sections: NextSection[] | null;
};

export type NextResult = { factors: NextFactors; id: string; score: number };

export type NextSection = { endMs: number; energy: number; startMs: number };

// The constants, as the contract states them.
export const NEXT_TASTE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const NEXT_TASTE_DEPTH = 200;
export const NEXT_RECENT_DEPTH = 40;
export const NEXT_QUEUE_ARTIST_DEPTH = 3;
export const NEXT_MINIMUM_FINISH_SAMPLE = 3;

export const NEXT_GENRE_WEIGHT = 0.45;
export const NEXT_ARTIST_WEIGHT = 0.3;
export const NEXT_FINISH_WEIGHT = 0.3;
export const NEXT_RECENT_PENALTY = 1.4;
export const NEXT_SAME_ARTIST_PENALTY = 0.4;
export const NEXT_SIMILARITY_WEIGHT = 0.4;
export const NEXT_MIXABILITY_WEIGHT = 0.6;
export const NEXT_ARC_WEIGHT = 0.2;

export const NEXT_EASY_BEND = 0.02;
export const NEXT_MAXIMUM_BEND = 0.06;
export const NEXT_STEADY_ENOUGH = 0.5;

export const NEXT_BREATHER_DROP = 0.25;
export const NEXT_COMEBACK_RISE = 0.2;

/** Energy over the whole record, each section weighted by its length. */
export const meanEnergy = (record: NextRecord): null | number => {
    if (!record.sections || record.sections.length === 0) return null;
    let length = 0;
    let weighted = 0;
    for (const section of record.sections) {
        const span = Math.max(0, section.endMs - section.startMs);
        length += span;
        weighted += section.energy * span;
    }
    return length > 0 ? weighted / length : null;
};

type Profile = { artists: Map<string, number>; events: number; genres: Map<string, number> };

const normalised = (counts: Map<string, number>): Map<string, number> => {
    let top = 0;
    for (const value of counts.values()) top = Math.max(top, value);
    if (top <= 0) return new Map();
    return new Map([...counts].map(([key, value]) => [key, value / top]));
};

/** The latest 200 finished plays within 90 days, counted by genre and by artist, each normalised against its strongest. */
export const tasteProfile = (library: NextLibrary): Profile => {
    const byId = new Map(library.records.map((record) => [record.id, record]));
    const since = library.now - NEXT_TASTE_WINDOW_MS;
    const finished = library.plays
        .filter((play) => play.completed && play.startedAt >= since)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, NEXT_TASTE_DEPTH);

    const genres = new Map<string, number>();
    const artists = new Map<string, number>();
    for (const play of finished) {
        const record = byId.get(play.id);
        if (!record) continue;
        if (record.artist.length > 0) {
            const artist = record.artist.toLowerCase();
            artists.set(artist, (artists.get(artist) ?? 0) + 1);
        }
        for (const raw of record.genres) {
            if (raw.length === 0) continue;
            const genre = raw.toLowerCase();
            genres.set(genre, (genres.get(genre) ?? 0) + 1);
        }
    }
    return { artists: normalised(artists), events: finished.length, genres: normalised(genres) };
};

/** Decided listens per track, all time. */
const finishCounts = (
    plays: readonly NextPlay[],
): Map<string, { completed: number; starts: number }> => {
    const counts = new Map<string, { completed: number; starts: number }>();
    for (const play of plays) {
        if (!play.completed && !play.skipped) continue;
        const entry = counts.get(play.id) ?? { completed: 0, starts: 0 };
        entry.starts += 1;
        if (play.completed) entry.completed += 1;
        counts.set(play.id, entry);
    }
    return counts;
};

const taste = (
    record: NextRecord,
    profile: Profile,
    finish: undefined | { completed: number; starts: number },
): number => {
    let genre = 0;
    for (const raw of record.genres)
        genre = Math.max(genre, profile.genres.get(raw.toLowerCase()) ?? 0);
    const artist = profile.artists.get(record.artist.toLowerCase()) ?? 0;
    let bias = 0;
    if (finish && finish.starts >= NEXT_MINIMUM_FINISH_SAMPLE) {
        bias = (finish.completed / finish.starts - 0.5) * 2 * NEXT_FINISH_WEIGHT;
    }
    return genre * NEXT_GENRE_WEIGHT + artist * NEXT_ARTIST_WEIGHT + bias;
};

/** In the request's `recent`, or among the last 40 distinct tracks started on any device, finished or not. */
const heardLately = (query: NextQuery, plays: readonly NextPlay[]): Set<string> => {
    const latest = new Map<string, number>();
    for (const play of plays)
        latest.set(play.id, Math.max(latest.get(play.id) ?? -Infinity, play.startedAt));
    const lastStarted = [...latest]
        .sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, NEXT_RECENT_DEPTH)
        .map(([id]) => id);
    return new Set([...lastStarted, ...query.recent]);
};

const artistsHeardLately = (
    heard: ReadonlySet<string>,
    query: NextQuery,
    byId: ReadonlyMap<string, NextRecord>,
): Set<string> => {
    const ids = new Set([...heard, ...query.queue.slice(-NEXT_QUEUE_ARTIST_DEPTH)]);
    const artists = new Set<string>();
    for (const id of ids) {
        const artist = byId.get(id)?.artist.toLowerCase();
        if (artist) artists.add(artist);
    }
    return artists;
};

const steadyTempo = (record: NextRecord): null | number => {
    if (record.bpm === null || record.bpm <= 0) return null;
    if (record.bpmStability !== null && record.bpmStability < NEXT_STEADY_ENOUGH) return null;
    return record.bpm;
};

/** Free to 2%, gone at 6% — `MixScore.tempo`'s curve. */
export const tempoPart = (rate: number): number => {
    const bend = Math.abs(rate - 1);
    if (bend <= NEXT_EASY_BEND + 1e-9) return 1;
    return Math.max(0, 1 - (bend - NEXT_EASY_BEND) / (NEXT_MAXIMUM_BEND - NEXT_EASY_BEND));
};

/** `CamelotKey.parse`, kept here so this module stands alone; the fixture pins the two to each other. */
const camelot = (key: null | string): null | { isMinor: boolean; number: number } => {
    if (!key || key.length < 2) return null;
    const letter = key.slice(-1).toUpperCase();
    if (letter !== 'A' && letter !== 'B') return null;
    const number = Number(key.slice(0, -1));
    if (!Number.isInteger(number) || number < 1 || number > 12) return null;
    return { isMinor: letter === 'A', number };
};

export const keyPart = (a: null | string, b: null | string): number => {
    const first = camelot(a);
    const second = camelot(b);
    if (!first || !second) return 0.5;
    if (first.number === second.number) return 1;
    const distance = Math.abs(first.number - second.number);
    const around = Math.min(distance, 12 - distance);
    return around === 1 && first.isMinor === second.isMinor ? 1 : 0;
};

/** The mean of the parts that can be answered. */
export const similarity = (seed: NextRecord, candidate: NextRecord): number => {
    const parts: number[] = [];

    if (seed.genres.length > 0 && candidate.genres.length > 0) {
        const mine = new Set(seed.genres.map((genre) => genre.toLowerCase()));
        parts.push(candidate.genres.some((genre) => mine.has(genre.toLowerCase())) ? 1 : 0);
    }

    const a = steadyTempo(seed);
    const b = steadyTempo(candidate);
    if (a !== null && b !== null) {
        let ratio = b / a;
        while (ratio < 0.7) ratio *= 2;
        while (ratio > 1.4) ratio /= 2;
        parts.push(tempoPart(ratio));
    }

    parts.push(keyPart(seed.key, candidate.key));

    const seedEnergy = meanEnergy(seed);
    const candidateEnergy = meanEnergy(candidate);
    if (seedEnergy !== null && candidateEnergy !== null) {
        parts.push(1 - Math.abs(seedEnergy - candidateEnergy));
    }

    return parts.reduce((sum, part) => sum + part, 0) / parts.length;
};

/** Where the set's energy should go next, or null when nothing before the candidate has an arrangement to read. */
export const arcTarget = (
    query: NextQuery,
    byId: ReadonlyMap<string, NextRecord>,
): null | number => {
    const sequence = [...[...query.recent].reverse(), query.seed, ...query.queue];
    const energies: number[] = [];
    for (const id of sequence.slice(-4)) {
        const record = byId.get(id);
        const energy = record ? meanEnergy(record) : null;
        if (energy !== null) energies.push(energy);
    }
    if (energies.length === 0) return null;
    const reference = energies[energies.length - 1];

    const rose =
        energies.length >= 4 && energies.every((value, i) => i === 0 || energies[i - 1] < value);
    const lastThree = energies.slice(-3);
    const fell =
        energies.length >= 3 && lastThree.every((value, i) => i === 0 || lastThree[i - 1] > value);
    if (rose) return reference - NEXT_BREATHER_DROP;
    if (fell) return reference + NEXT_COMEBACK_RISE;
    return reference;
};

const arc = (candidate: NextRecord, target: null | number): number => {
    const energy = meanEnergy(candidate);
    if (target === null || energy === null) return 0.5;
    return Math.min(1, Math.max(0, 1 - Math.abs(energy - target)));
};

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The best `limit` records to follow the seed, best first, and how many finished plays the taste term stood on. */
export const rankNext = (
    query: NextQuery,
    library: NextLibrary,
): { events: number; results: NextResult[] } => {
    const byId = new Map(library.records.map((record) => [record.id, record]));
    const seed = byId.get(query.seed);
    if (!seed) return { events: 0, results: [] };

    const profile = tasteProfile(library);
    const finish = finishCounts(library.plays);
    const heard = heardLately(query, library.plays);
    const heardArtists = artistsHeardLately(heard, query, byId);
    const target = arcTarget(query, byId);

    const excluded = new Set([query.seed, ...query.queue, ...query.recent]);
    const results: NextResult[] = [];
    for (const record of library.records) {
        if (excluded.has(record.id) || library.notInterested.has(record.id)) continue;

        const tasteRaw = taste(record, profile, finish.get(record.id));
        const fit = similarity(seed, record);
        // No grids in the fixture; mixability is pinned by the planner's own table.
        const mixability: null | number = null;
        const shape = arc(record, target);
        const wasHeard = heard.has(record.id);
        const sameArtist = heardArtists.has(record.artist.toLowerCase());

        let score = tasteRaw + fit * NEXT_SIMILARITY_WEIGHT + shape * NEXT_ARC_WEIGHT;
        if (query.mode === 'autodj' && mixability !== null)
            score += mixability * NEXT_MIXABILITY_WEIGHT;
        if (wasHeard) score -= NEXT_RECENT_PENALTY;
        if (sameArtist) score -= NEXT_SAME_ARTIST_PENALTY;

        results.push({
            factors: {
                arc: shape,
                freshness: wasHeard ? 0 : sameArtist ? 0.5 : 1,
                mixability,
                similarity: fit,
                taste: Math.min(1, Math.max(0, tasteRaw)),
            },
            id: record.id,
            score,
        });
    }

    results.sort((a, b) => (a.score !== b.score ? b.score - a.score : ordinal(a.id, b.id)));
    return { events: profile.events, results: results.slice(0, Math.max(0, query.limit)) };
};
