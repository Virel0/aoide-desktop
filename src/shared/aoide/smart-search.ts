/**
 * Turning a phrase like "upbeat rock from the nineties" into filters.
 *
 * **The model translates; it never chooses tracks.** That split is carried over
 * from the iOS app, where it is not a stylistic preference but a measurement:
 * asked to pick songs for a named genre, the on-device model was right 2–5 times
 * out of 8 — worse than useless when the server can answer the same question
 * exactly. Mapping a phrase onto a genre and a year range is the part a model is
 * reliably good at. Jellyfin does the selecting afterwards.
 *
 * Everything here is pure. The network call and the API key live in the main
 * process; this is the part that decides what to ask and what to believe of the
 * answer, and it is the part worth testing.
 */

export type SearchOrdering = 'byName' | 'mostPlayed' | 'newestFirst' | 'random' | 'recentlyPlayed';

const ORDERINGS: readonly SearchOrdering[] = [
    'byName',
    'mostPlayed',
    'newestFirst',
    'random',
    'recentlyPlayed',
];

/** What a phrase becomes. Every field is a filter the server understands. */
export interface MusicQuery {
    favoritesOnly: boolean;
    fromYear: null | number;
    /** Always a subset of the library's own genres. Never the model's invention. */
    genres: string[];
    ordering: SearchOrdering;
    searchTerm: null | string;
    toYear: null | number;
}

/**
 * Below this, a phrase is a name.
 *
 * One or two words is almost always something the plain search already handles
 * better than any interpretation of it would — and every call to a hosted model
 * costs money, so the cheap path should be the default rather than the fallback.
 */
export const MINIMUM_PHRASE_WORDS = 3;

export const looksLikeAPhrase = (text: string): boolean =>
    text.trim().split(/\s+/).filter(Boolean).length >= MINIMUM_PHRASE_WORDS;

/**
 * The instructions, including the library's own genre vocabulary.
 *
 * **The vocabulary is the single biggest quality lever.** Left to itself a model
 * invents plausible genres — "Chill", "Workout", "Study" — that match nothing on
 * the server, and the search returns an empty list that reads as a broken
 * feature rather than as a miss. Handing it the real words turns an open-ended
 * guess into a choice from a closed set.
 *
 * The genre list is the only thing about the library that leaves the machine.
 * Track titles, artists and listening history are never sent: translation needs
 * the vocabulary, not the contents.
 */
export const buildPrompt = (phrase: string, libraryGenres: readonly string[]): string => {
    const vocabulary = libraryGenres.length
        ? libraryGenres.join(', ')
        : '(this library reports no genres — leave genres empty)';

    return [
        'You translate a listener’s description of music into search filters.',
        'You never choose songs. You only produce filters; the music server selects.',
        '',
        'Reply with JSON only, matching exactly this shape:',
        '{"searchTerm": string|null, "genres": string[], "fromYear": number|null,',
        ' "toYear": number|null, "favoritesOnly": boolean,',
        ` "ordering": ${ORDERINGS.map((value) => `"${value}"`).join('|')}}`,
        '',
        'Rules:',
        '- genres MUST be chosen from this library’s genres, spelled exactly as given.',
        '  If none apply, return an empty array. Never invent a genre.',
        '- fromYear/toYear express a period: "the nineties" is 1990 to 1999.',
        '- searchTerm is a song, album or artist name if the description names one.',
        '- favoritesOnly is true only for favourites, loved or starred music.',
        '- ordering is byName unless the listener asked for something else.',
        '',
        `This library’s genres: ${vocabulary}`,
        '',
        `Description: ${phrase}`,
    ].join('\n');
};

/**
 * Read a model's reply, keeping only what can be believed.
 *
 * Written to survive a bad answer rather than to trust a good one. A hosted
 * model returns prose around its JSON, invents fields, returns a year as a
 * string, or names a genre that does not exist — none of which should surface as
 * an error, because the caller can always fall back to a plain search. Anything
 * unusable is dropped and the rest is kept.
 */
export const parseQuery = (reply: string, libraryGenres: readonly string[]): MusicQuery | null => {
    const parsed = extractJson(reply);
    if (!parsed) return null;

    // Matched case-insensitively but returned in the library's own spelling,
    // because that is what the server will match against.
    const byLowercase = new Map(libraryGenres.map((genre) => [genre.toLowerCase(), genre]));
    const genres = asArray(parsed.genres)
        .map((genre) => (typeof genre === 'string' ? byLowercase.get(genre.toLowerCase()) : null))
        .filter((genre): genre is string => Boolean(genre));

    const fromYear = asYear(parsed.fromYear);
    const toYear = asYear(parsed.toYear);

    return {
        favoritesOnly: parsed.favoritesOnly === true,
        // A reversed range describes nothing, and the likeliest reading is that
        // the model filled the two fields the wrong way round.
        fromYear: fromYear !== null && toYear !== null ? Math.min(fromYear, toYear) : fromYear,
        genres: [...new Set(genres)],
        ordering: ORDERINGS.includes(parsed.ordering as SearchOrdering)
            ? (parsed.ordering as SearchOrdering)
            : 'byName',
        searchTerm: asTerm(parsed.searchTerm),
        toYear: fromYear !== null && toYear !== null ? Math.max(fromYear, toYear) : toYear,
    };
};

/** True when a query would filter nothing, and a plain search is the better answer. */
export const isEmptyQuery = (query: MusicQuery): boolean =>
    query.genres.length === 0 &&
    query.fromYear === null &&
    query.toYear === null &&
    query.searchTerm === null &&
    !query.favoritesOnly;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asTerm = (value: unknown): null | string => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

/** A year, from a number or the string a model often returns instead. */
const asYear = (value: unknown): null | number => {
    const year = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    if (typeof year !== 'number' || !Number.isFinite(year)) return null;
    // Recorded music does not predate this, and a year beyond next year is a
    // hallucination rather than a release date.
    return year >= 1860 && year <= new Date().getFullYear() + 1 ? Math.trunc(year) : null;
};

/**
 * The JSON inside a reply that may not be only JSON.
 *
 * Models wrap answers in prose or a fenced code block however firmly they are
 * asked not to, and a reply that is 95% correct should not be discarded over its
 * packaging.
 */
const extractJson = (reply: string): null | Record<string, unknown> => {
    const candidates = [reply, reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)];

    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Try the next reading of the reply.
        }
    }

    return null;
};
