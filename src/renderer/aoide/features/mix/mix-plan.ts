import type { SmartRule, SmartRules } from '/@/shared/aoide/smart-rules';

/**
 * The rules behind a mix that are not the model's and not Jellyfin's.
 *
 * Kept apart from `use-mix.ts` so they can be tested without a query client
 * or a bridge: which library genres a described genre means, which candidates
 * go first, whether the library as a whole is worth asking, and the one line
 * that says what was understood. That line is the diagnostic. A mix that
 * comes back empty is explained by it or by nothing.
 */

/** The words of a name: lower-cased, split on anything that is not a letter or digit. */
const words = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 0);

/**
 * Library genres that mean what a described genre means.
 *
 * Word-boundary containment, either way, lower-cased, punctuation ignored:
 * every word of one side must be a whole word of the other. So a model's
 * "rock" takes "Rock", "Hard Rock" and "Alternative Rock" but not
 * "Rockabilly" — "rockabilly" is one word and "rock" is not it — and
 * "alternative rock" takes "Rock", because the library's one word is among
 * the model's two. "soundtrack" takes "Video Game Soundtrack". The phone's
 * `MixComposer.libraryGenres(matching:in:)` is the same rule, so a description
 * resolves to the same library genres on both.
 *
 * Returned in the library's order, each genre once, however many described
 * genres reached it.
 */
export const matchGenres = (described: readonly string[], library: readonly string[]): string[] => {
    const wanted = described.map(words).filter((list) => list.length > 0);
    if (wanted.length === 0) return [];

    return library.filter((candidate) => {
        const have = words(candidate);
        if (have.length === 0) return false;
        return wanted.some(
            (want) =>
                want.every((word) => have.includes(word)) ||
                have.every((word) => want.includes(word)),
        );
    });
};

/** The genre names a rule set asks for, as the model spelled them. */
export const describedGenres = (rules: null | SmartRules): string[] =>
    (rules?.rules ?? [])
        .filter((rule) => rule.field === 'genre' && (rule.op === 'is' || rule.op === 'contains'))
        .map((rule) => String(rule.value));

/**
 * Name hits first, then the rule candidates, each id once.
 *
 * A name is the most specific thing a description says. The limit is counted
 * from the front, so putting the name hits first is what keeps them in a mix
 * that also asked for five hundred candidates by genre.
 */
export const orderCandidates = (
    nameIds: readonly string[],
    ruleIds: readonly string[],
): string[] => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of [...nameIds, ...ruleIds]) {
        if (seen.has(id)) continue;
        seen.add(id);
        ordered.push(id);
    }
    return ordered;
};

/**
 * Put the name hits back in front after the store has narrowed.
 *
 * `Mix.narrow` sorts by last played when there are history rules, which is
 * the right order for a mood and the wrong one for a name: the band that was
 * asked for should open the mix, not sit wherever its plays fell. Relative
 * order within each half is kept.
 */
export const namesFirst = (chosen: readonly string[], nameIds: ReadonlySet<string>): string[] => [
    ...chosen.filter((id) => nameIds.has(id)),
    ...chosen.filter((id) => !nameIds.has(id)),
];

/**
 * Whether to ask Jellyfin for candidates by the rules at all.
 *
 * "All of nothing" is the whole library, which is a real mix when the
 * description said nothing more specific — "something, anything, I have not
 * heard in ages". Beside a name it is noise: "Helldivers 2" with no rules
 * would be the game's soundtrack followed by five hundred random tracks. So
 * the library is asked when there are rules to ask it with, or when there is
 * nothing else to go on.
 */
export const wantsRuleCandidates = (rules: null | SmartRules, names: readonly string[]): boolean =>
    rules !== null && (rules.rules.length > 0 || names.length === 0);

export interface MixPlan {
    /** The library genres the description resolved to, spelled the library's way. */
    genres: readonly string[];
    names: readonly string[];
    rules: null | SmartRules;
}

const SPAN_UNITS: Record<string, [string, string]> = {
    d: ['day', 'days'],
    m: ['month', 'months'],
    w: ['week', 'weeks'],
    y: ['year', 'years'],
};

/** `-6m` as "6 months"; anything else as itself. */
const spanWords = (value: SmartRule['value']): string => {
    const match = /^-?(\d+)([dwmy])$/.exec(String(value));
    if (!match) return String(value);
    const amount = Number(match[1]);
    const [one, many] = SPAN_UNITS[match[2]];
    return amount === 1 ? `a ${one}` : `${amount} ${many}`;
};

/** One rule as a person would say it, or nothing for a rule the line already covers. */
const rulePhrase = (rule: SmartRule): null | string => {
    switch (rule.field) {
        case 'duration_ms':
            return null;
        case 'first_played':
            if (rule.op === 'inTheLast') return `new in the last ${spanWords(rule.value)}`;
            return null;
        case 'genre':
            // Said through the library's own genres, not the model's spelling.
            return null;
        case 'last_played':
            if (rule.op === 'notInTheLast') return `not played in ${spanWords(rule.value)}`;
            if (rule.op === 'inTheLast') return `played in the last ${spanWords(rule.value)}`;
            return null;
        case 'liked':
            return rule.value === true ? 'favourites' : 'not favourites';
        case 'play_count':
            if (rule.op === 'is' && rule.value === 0) return 'never played';
            if (rule.op === 'greaterThan') return `played more than ${rule.value} times`;
            if (rule.op === 'lessThan') return `played fewer than ${rule.value} times`;
            return null;
        case 'skip_count':
            if (rule.op === 'is' && rule.value === 0) return 'never skipped';
            return null;
        case 'year':
            if (rule.op === 'greaterThan') return `after ${rule.value}`;
            if (rule.op === 'lessThan') return `before ${rule.value}`;
            if (rule.op === 'is') return `from ${rule.value}`;
            return null;
        default:
            // title, artist, album, album_artist: "artist contains Muse".
            return `${rule.field.replace('_', ' ')} ${rule.op} ${String(rule.value)}`;
    }
};

/**
 * What the model understood, as one line: the things named, the library
 * genres they resolved to, the rest of the rules in words, and the length.
 *
 *   Helldivers 2 · Rock, Metal, Electronic · not played in 6 months · 40 tracks
 *
 * Shown under the input after every build, because an empty mix with no
 * account of what was looked for is indistinguishable from a broken feature,
 * and the account is what lets a person rephrase.
 */
export const describePlan = (plan: MixPlan): string => {
    const parts: string[] = [];

    if (plan.names.length > 0) parts.push(plan.names.join(', '));
    if (plan.genres.length > 0) parts.push(plan.genres.join(', '));

    for (const rule of plan.rules?.rules ?? []) {
        const phrase = rulePhrase(rule);
        if (phrase && !parts.includes(phrase)) parts.push(phrase);
    }

    if (plan.rules?.limit) parts.push(`${plan.rules.limit} tracks`);

    return parts.length === 0 ? 'anything' : parts.join(' · ');
};

/** The sentence for names the library has nothing for. */
export const missedNamesMessage = (missed: readonly string[]): string =>
    `Nothing in your library mentions ${missed.join(', ')}.`;
