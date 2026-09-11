/**
 * The sidecar's answer to "what should play after this?" — see
 * `docs/infinity.md` in the iOS repo for what was asked and why.
 *
 * The server scores the whole library against the record playing: taste from
 * the finished plays of every device, freshness, similarity, how well each
 * could be mixed in, and where the set's energy has been. It returns the best
 * few, in order, each with the figures that put it there. The client enqueues
 * them as given; the figures are for the queue to show.
 *
 * The phone's `NextChooser`, line for line: the ceilings, the wire shape, and
 * the summary's wording are the same on both, so the two queues read alike.
 */

export type NextCandidate = {
    factors: NextFactors;
    id: string;
    score: number;
};

/**
 * Why a record was chosen, each in 0…1. `mixability` is null outside Auto DJ
 * and for a pair the server could not read. `kinship` — whether the record
 * is of the seed's kind — is null from a server older than 1.17.0.0, which
 * folded it into `similarity`.
 */
export type NextFactors = {
    arc: number;
    freshness: number;
    kinship: null | number;
    mixability: null | number;
    similarity: number;
    taste: number;
};

export type NextMode = 'autodj' | 'infinity';

/** How much history the taste term stood on. With no finished plays at all, taste is 0 for everything. */
export type NextProfile = {
    events: number;
    since: number;
};

export type NextRequest = {
    limit: number;
    mode: NextMode;
    /** What is already queued after the seed, in order. */
    queue: string[];
    /** What this device heard lately, newest first. */
    recent: string[];
    seed: string;
};

export type NextResponse = {
    candidates: NextCandidate[];
    profile: NextProfile;
};

/**
 * The contract's ceilings. Anything past them is dropped from the far end —
 * the oldest of the recent, the furthest of the queue — rather than refused,
 * so a long queue never stops the music.
 */
export const NEXT_MAX_QUEUE = 1000;
export const NEXT_MAX_RECENT = 40;

export const buildNextRequest = (args: {
    limit: number;
    mode: NextMode;
    queue: readonly string[];
    recent: readonly string[];
    seed: string;
}): NextRequest => ({
    limit: args.limit,
    mode: args.mode,
    queue: args.queue.slice(0, NEXT_MAX_QUEUE),
    recent: args.recent.slice(0, NEXT_MAX_RECENT),
    seed: args.seed,
});

const finite = (value: unknown): null | number =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const readFactors = (value: unknown): NextFactors | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const taste = finite(raw.taste);
    const freshness = finite(raw.freshness);
    const similarity = finite(raw.similarity);
    const arc = finite(raw.arc);
    if (taste === null || freshness === null || similarity === null || arc === null) {
        return undefined;
    }
    return {
        arc,
        freshness,
        kinship: finite(raw.kinship),
        mixability: finite(raw.mixability),
        similarity,
        taste,
    };
};

/**
 * The answer, read strictly: a candidate missing a figure is dropped rather
 * than guessed at, and a body without the shape at all is `undefined`, which
 * the caller treats as the server having failed to choose.
 */
export const parseNextResponse = (body: unknown): NextResponse | undefined => {
    if (!body || typeof body !== 'object') return undefined;
    const raw = body as Record<string, unknown>;
    if (!Array.isArray(raw.candidates)) return undefined;

    const candidates: NextCandidate[] = [];
    for (const entry of raw.candidates) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const score = finite(row.score);
        const factors = readFactors(row.factors);
        if (typeof row.id !== 'string' || score === null || !factors) continue;
        candidates.push({ factors, id: row.id, score });
    }

    const profile =
        raw.profile && typeof raw.profile === 'object'
            ? (raw.profile as Record<string, unknown>)
            : {};

    return {
        candidates,
        profile: { events: finite(profile.events) ?? 0, since: finite(profile.since) ?? 0 },
    };
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * One line for a queue row: the figures that put the record there, as
 * percentages, and a word when freshness cost it something.
 *
 * Freshness is left out at 1: the server never returns a record it has just
 * heard, so nearly every row would read "fresh", which says nothing.
 */
export const summariseNextFactors = (factors: NextFactors): string => {
    const parts = [`Taste ${percent(factors.taste)}`];
    if (factors.kinship !== null) parts.push(`Kin ${percent(factors.kinship)}`);
    parts.push(`Fits ${percent(factors.similarity)}`);
    if (factors.mixability !== null) parts.push(`Mixes ${percent(factors.mixability)}`);
    parts.push(`Arc ${percent(factors.arc)}`);
    if (factors.freshness < 0.25) {
        parts.push('heard lately');
    } else if (factors.freshness < 0.75) {
        parts.push('same artist lately');
    }
    return parts.join(' · ');
};
