import { describe, expect, it } from 'vitest';

import {
    describedGenres,
    describePlan,
    matchGenres,
    missedNamesMessage,
    namesFirst,
    orderCandidates,
    wantsRuleCandidates,
} from './mix-plan';

import { SmartRules } from '/@/shared/aoide/smart-rules';

const LIBRARY = [
    'Alternative Rock',
    'Ambient',
    'Hard Rock',
    'Lo-Fi',
    'Metal',
    'Rock',
    'Rockabilly',
    'Video Game Soundtrack',
];

describe('matchGenres', () => {
    it('matches exactly, ignoring case', () => {
        expect(matchGenres(['metal'], LIBRARY)).toEqual(['Metal']);
        expect(matchGenres(['METAL'], LIBRARY)).toEqual(['Metal']);
    });

    // The model says "rock"; the library says it three ways.
    it('takes every library genre containing the described one as a whole word', () => {
        expect(matchGenres(['rock'], LIBRARY)).toEqual(['Alternative Rock', 'Hard Rock', 'Rock']);
    });

    // The other direction: the model was more specific than the library.
    it('takes a library genre whose words are all in the described one', () => {
        expect(matchGenres(['alternative rock'], LIBRARY)).toEqual(['Alternative Rock', 'Rock']);
    });

    it('takes "Video Game Soundtrack" for "soundtrack"', () => {
        expect(matchGenres(['soundtrack'], LIBRARY)).toEqual(['Video Game Soundtrack']);
    });

    // The rule is whole words, not substrings. "rock" is not a word of
    // "Rockabilly", so a driving mix does not fill up with rockabilly.
    it('does not take "Rockabilly" for "rock"', () => {
        expect(matchGenres(['rock'], LIBRARY)).not.toContain('Rockabilly');
    });

    it('ignores punctuation: "lo fi" and "lofi" differ, "lo-fi" and "Lo-Fi" do not', () => {
        expect(matchGenres(['lo-fi'], LIBRARY)).toEqual(['Lo-Fi']);
        expect(matchGenres(['lo fi'], LIBRARY)).toEqual(['Lo-Fi']);
        expect(matchGenres(['lofi'], LIBRARY)).toEqual([]);
    });

    it('returns each library genre once, in the library’s order', () => {
        expect(matchGenres(['rock', 'hard rock'], LIBRARY)).toEqual([
            'Alternative Rock',
            'Hard Rock',
            'Rock',
        ]);
    });

    it('matches nothing for an invented genre, rather than everything', () => {
        expect(matchGenres(['Chill'], LIBRARY)).toEqual([]);
    });

    it('matches nothing for nothing', () => {
        expect(matchGenres([], LIBRARY)).toEqual([]);
        expect(matchGenres([''], LIBRARY)).toEqual([]);
        expect(matchGenres(['rock'], [])).toEqual([]);
    });
});

describe('describedGenres', () => {
    it('reads the genre rules, as the model spelled them', () => {
        const rules: SmartRules = {
            match: 'all',
            rules: [
                { field: 'genre', op: 'is', value: 'rock' },
                { field: 'genre', op: 'contains', value: 'metal' },
                { field: 'year', op: 'greaterThan', value: 1990 },
            ],
        };
        expect(describedGenres(rules)).toEqual(['rock', 'metal']);
        expect(describedGenres(null)).toEqual([]);
    });
});

describe('orderCandidates', () => {
    it('puts the name hits first and drops repeats', () => {
        expect(orderCandidates(['a', 'b'], ['c', 'a', 'd', 'b'])).toEqual(['a', 'b', 'c', 'd']);
    });

    it('keeps a name hit once even when named twice', () => {
        expect(orderCandidates(['a', 'a'], [])).toEqual(['a']);
    });
});

describe('namesFirst', () => {
    it('moves the name hits to the front, keeping each half’s order', () => {
        expect(namesFirst(['c', 'a', 'd', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('changes nothing without names', () => {
        expect(namesFirst(['c', 'a'], new Set())).toEqual(['c', 'a']);
    });
});

describe('wantsRuleCandidates', () => {
    const empty: SmartRules = { match: 'all', rules: [] };
    const genre: SmartRules = {
        match: 'all',
        rules: [{ field: 'genre', op: 'is', value: 'Rock' }],
    };

    it('asks the library when there are rules to ask with', () => {
        expect(wantsRuleCandidates(genre, [])).toBe(true);
        expect(wantsRuleCandidates(genre, ['Helldivers 2'])).toBe(true);
    });

    // "All of nothing" is the whole library: a mix when it is all there is.
    it('asks for the whole library only when nothing was named', () => {
        expect(wantsRuleCandidates(empty, [])).toBe(true);
        expect(wantsRuleCandidates(empty, ['Helldivers 2'])).toBe(false);
    });

    it('asks nothing without rules', () => {
        expect(wantsRuleCandidates(null, [])).toBe(false);
        expect(wantsRuleCandidates(null, ['Helldivers 2'])).toBe(false);
    });
});

describe('describePlan', () => {
    it('says the names, the library genres, the rules in words, and the length', () => {
        expect(
            describePlan({
                genres: ['Rock', 'Metal', 'Electronic'],
                names: ['Helldivers 2'],
                rules: {
                    limit: 40,
                    match: 'all',
                    rules: [
                        { field: 'genre', op: 'is', value: 'rock' },
                        { field: 'last_played', op: 'notInTheLast', value: '-6m' },
                    ],
                },
            }),
        ).toBe('Helldivers 2 · Rock, Metal, Electronic · not played in 6 months · 40 tracks');
    });

    // The model's "rock" is not on the line; the library's three genres are.
    it('says genres the library’s way, never the model’s spelling', () => {
        const line = describePlan({
            genres: ['Hard Rock'],
            names: [],
            rules: { match: 'all', rules: [{ field: 'genre', op: 'is', value: 'rock' }] },
        });
        expect(line).toBe('Hard Rock');
    });

    it('puts the rest of the rules into words', () => {
        const line = describePlan({
            genres: [],
            names: [],
            rules: {
                match: 'all',
                rules: [
                    { field: 'play_count', op: 'is', value: 0 },
                    { field: 'liked', op: 'is', value: true },
                    { field: 'year', op: 'greaterThan', value: 1989 },
                    { field: 'year', op: 'lessThan', value: 2000 },
                    { field: 'last_played', op: 'notInTheLast', value: '-1y' },
                    { field: 'artist', op: 'contains', value: 'Muse' },
                ],
            },
        });
        expect(line).toBe(
            'never played · favourites · after 1989 · before 2000 · not played in a year · artist contains Muse',
        );
    });

    it('says "anything" when nothing was understood', () => {
        expect(describePlan({ genres: [], names: [], rules: null })).toBe('anything');
        expect(describePlan({ genres: [], names: [], rules: { match: 'all', rules: [] } })).toBe(
            'anything',
        );
    });

    it('describes names alone', () => {
        expect(describePlan({ genres: [], names: ['Muse', 'Deftones'], rules: null })).toBe(
            'Muse, Deftones',
        );
    });
});

describe('missedNamesMessage', () => {
    it('names what the library had nothing for', () => {
        expect(missedNamesMessage(['Helldivers 2', 'Muse'])).toBe(
            'Nothing in your library mentions Helldivers 2, Muse.',
        );
    });
});
