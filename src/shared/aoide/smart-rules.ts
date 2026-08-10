/**
 * Smart playlist rules, in the phone's own format.
 *
 * A mix is a rule set. That is the whole design: describing a mood produces
 * *rules*, the library and the listening history select the tracks, and the
 * result can be kept as a smart playlist that syncs and evaluates identically on
 * both apps — because this is byte-for-byte the JSON `playlist.smartRules`
 * already holds.
 *
 * Transcribed from `CurationKit/SmartPlaylist.swift`, including the thing that
 * file is most careful about: **an illegal field/operator pair must be refused,
 * never quietly accepted.** Most spellable pairs are nonsense — a duration
 * cannot begin with something, a title is not in the last six months — and the
 * cheap implementation of "unsupported" is a predicate matching nothing. That is
 * the worst failure available here, because a smart playlist that is silently
 * empty looks exactly like one whose rules simply have no hits, and nobody can
 * tell which they are looking at.
 */

export type RuleField =
    | 'album'
    | 'album_artist'
    | 'artist'
    | 'duration_ms'
    | 'first_played'
    | 'genre'
    | 'last_played'
    | 'liked'
    | 'play_count'
    | 'skip_count'
    | 'title'
    | 'year';

export type RuleOperator =
    | 'after'
    | 'before'
    | 'beginsWith'
    | 'contains'
    | 'doesNotContain'
    | 'greaterThan'
    | 'inTheLast'
    | 'is'
    | 'isNot'
    | 'lessThan'
    | 'notInTheLast';

type FieldKind = 'date' | 'flag' | 'number' | 'text';

/** What kind of value a field holds, which is the whole of what decides its operators. */
const FIELD_KINDS: Record<RuleField, FieldKind> = {
    album: 'text',
    album_artist: 'text',
    artist: 'text',
    duration_ms: 'number',
    first_played: 'date',
    genre: 'text',
    last_played: 'date',
    liked: 'flag',
    play_count: 'number',
    skip_count: 'number',
    title: 'text',
    year: 'number',
};

const OPERATORS_BY_KIND: Record<FieldKind, readonly RuleOperator[]> = {
    date: ['before', 'after', 'inTheLast', 'notInTheLast'],
    flag: ['is', 'isNot'],
    number: ['is', 'isNot', 'greaterThan', 'lessThan'],
    text: ['is', 'isNot', 'contains', 'doesNotContain', 'beginsWith'],
};

/**
 * The phone accepts camelCase inbound as well as the document's snake_case.
 * Emitting snake_case only, because that is what the sidecar is written against.
 */
const FIELD_ALIASES: Record<string, RuleField> = {
    albumArtist: 'album_artist',
    durationMs: 'duration_ms',
    firstPlayed: 'first_played',
    lastPlayed: 'last_played',
    playCount: 'play_count',
    skipCount: 'skip_count',
};

export interface SmartRule {
    field: RuleField;
    op: RuleOperator;
    value: boolean | number | string;
}

export interface SmartRules {
    limit?: number;
    match: 'all' | 'any';
    rules: SmartRule[];
    sort?: { dir: 'asc' | 'desc'; field: RuleField };
}

/** A relative span, as `inTheLast` and friends take it: `-30d`, `6m`, `2y`. */
const RELATIVE = /^-?\d+[dwmy]$/;

/**
 * Whether a rule is one both apps can evaluate.
 *
 * Returns a reason rather than a boolean so a refusal can say what was wrong —
 * a model that produced `duration_ms beginsWith "3"` should be told, not
 * silently trimmed to nothing.
 */
export const ruleProblem = (rule: SmartRule): null | string => {
    const kind = FIELD_KINDS[rule.field];
    if (!kind) return `Unknown field ${rule.field}`;

    if (!OPERATORS_BY_KIND[kind].includes(rule.op)) {
        return `${rule.op} does not apply to ${rule.field}`;
    }

    if (kind === 'text' && typeof rule.value !== 'string') return `${rule.field} needs text`;
    if (kind === 'number' && !Number.isInteger(rule.value)) {
        // Integers only: every numeric field counts something or is a
        // millisecond, and accepting 2.5 would mean deciding on somebody's
        // behalf which way to round a bound.
        return `${rule.field} needs a whole number`;
    }
    if (kind === 'flag' && typeof rule.value !== 'boolean')
        return `${rule.field} needs true or false`;

    if (kind === 'date') {
        // `before`/`after` name an instant, which may be relative or an absolute
        // epoch millisecond. `inTheLast` names a span, and a bare number would be
        // a span in unstated units.
        const spansOnly = rule.op === 'inTheLast' || rule.op === 'notInTheLast';
        if (typeof rule.value === 'string') {
            return RELATIVE.test(rule.value) ? null : `${rule.value} is not a span like -30d`;
        }
        if (spansOnly) return `${rule.op} needs a span like -30d`;
        if (!Number.isInteger(rule.value)) return `${rule.field} needs a time`;
    }

    return null;
};

export interface ParsedRules {
    /** Rules that were dropped, and why. Shown rather than swallowed. */
    rejected: string[];
    rules: null | SmartRules;
}

/**
 * Read a model's reply into rules, keeping only what both apps can evaluate.
 *
 * `any` of nothing can only ever be empty, and an always-empty playlist is
 * indistinguishable from a broken one, so it is refused rather than shipped —
 * the phone refuses it too. `all` of nothing is every track, which is a real
 * playlist: "everything, by play count, top 25".
 */
export const parseRules = (reply: string): ParsedRules => {
    const parsed = extractJson(reply);
    if (!parsed) return { rejected: ['The model did not return rules.'], rules: null };

    const rejected: string[] = [];
    const rules: SmartRule[] = [];

    for (const candidate of Array.isArray(parsed.rules) ? parsed.rules : []) {
        const raw = candidate as Record<string, unknown>;
        const field = normaliseField(raw.field);

        if (!field) {
            rejected.push(`Unknown field ${String(raw.field)}`);
            continue;
        }

        const rule: SmartRule = {
            field,
            op: raw.op as RuleOperator,
            value: raw.value as boolean | number | string,
        };
        const problem = ruleProblem(rule);

        if (problem) rejected.push(problem);
        else rules.push(rule);
    }

    const match = parsed.match === 'any' ? 'any' : 'all';
    if (match === 'any' && rules.length === 0) {
        return { rejected: [...rejected, 'No usable rules.'], rules: null };
    }

    const limit =
        Number.isInteger(parsed.limit) && (parsed.limit as number) > 0
            ? (parsed.limit as number)
            : undefined;

    return { rejected, rules: { limit, match, rules } };
};

const normaliseField = (value: unknown): null | RuleField => {
    if (typeof value !== 'string') return null;
    if (value in FIELD_KINDS) return value as RuleField;
    return FIELD_ALIASES[value] ?? null;
};

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

/**
 * The instructions for turning a mood into rules.
 *
 * The library's genres go in for the same reason they do in search: without the
 * real vocabulary a model invents "Chill" and "Workout", the rules match
 * nothing, and an empty mix reads as a broken feature rather than as a miss.
 */
export const buildMixPrompt = (description: string, libraryGenres: readonly string[]): string =>
    [
        'You turn a description of a mood into smart playlist rules.',
        'You never choose songs. The rules select them.',
        '',
        'Reply with JSON only:',
        '{"match":"all"|"any","limit":number,"rules":[{"field":…,"op":…,"value":…}]}',
        '',
        'Fields and the operators each accepts:',
        '  text  — title, artist, album, album_artist, genre',
        '          is, isNot, contains, doesNotContain, beginsWith',
        '  number — year, duration_ms, play_count, skip_count',
        '          is, isNot, greaterThan, lessThan',
        '  date  — last_played, first_played',
        '          before, after, inTheLast, notInTheLast; value is a span like "-30d"',
        '  flag  — liked; is, isNot; value is true or false',
        '',
        'Use the listening history — play_count, skip_count, last_played — to express',
        'mood: "something I have not heard in ages" is last_played notInTheLast "-6m";',
        '"my favourites" is liked is true or play_count greaterThan a few.',
        '',
        'genre values MUST come from this library, spelled exactly as given.',
        'Set limit to a sensible mix length, usually 25 to 50.',
        '',
        `This library's genres: ${libraryGenres.join(', ') || '(none reported)'}`,
        '',
        `Mood: ${description}`,
    ].join('\n');
