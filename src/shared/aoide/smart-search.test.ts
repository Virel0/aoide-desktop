import { describe, expect, it } from 'vitest';

import {
    buildPrompt,
    isEmptyQuery,
    looksLikeAPhrase,
    MINIMUM_PHRASE_WORDS,
    parseQuery,
} from './smart-search';

const GENRES = ['Rock', 'Jazz', 'Electronic', 'Hip-Hop', 'Classical'];

const reply = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        favoritesOnly: false,
        fromYear: null,
        genres: [],
        ordering: 'byName',
        searchTerm: null,
        toYear: null,
        ...over,
    });

describe('when to ask a model at all', () => {
    it('leaves one or two words to the plain search', () => {
        expect(looksLikeAPhrase('Radiohead')).toBe(false);
        expect(looksLikeAPhrase('kid a')).toBe(false);
        expect(MINIMUM_PHRASE_WORDS).toBe(3);
    });

    it('offers to translate a real phrase', () => {
        expect(looksLikeAPhrase('upbeat rock from the nineties')).toBe(true);
    });

    it('is not fooled by spacing', () => {
        expect(looksLikeAPhrase('   jazz   ')).toBe(false);
        expect(looksLikeAPhrase('  quiet   jazz   for   evening ')).toBe(true);
    });
});

describe('the prompt', () => {
    // The single biggest quality lever: without the real vocabulary a model
    // invents "Chill" and "Workout", which match nothing and read as breakage.
    it('carries the library’s own genres', () => {
        const prompt = buildPrompt('something upbeat', GENRES);
        for (const genre of GENRES) expect(prompt).toContain(genre);
    });

    it('says so when the library reports no genres, rather than inviting invention', () => {
        expect(buildPrompt('something upbeat', [])).toContain('leave genres empty');
    });

    // The genre list is the only thing about the library that leaves the machine,
    // and this is the assertion that keeps it that way. Stated as a difference
    // rather than as a word search: the earlier version grepped the prompt for
    // "artist name" and matched its own instructions, which proves nothing about
    // what data travels.
    it('varies with the vocabulary and with nothing else about the library', () => {
        const phrase = 'quiet music for reading';
        const small = buildPrompt(phrase, ['Jazz']);
        const large = buildPrompt(phrase, ['Jazz', 'Ambient', 'Classical']);

        expect(small).toContain(phrase);
        // Everything before the vocabulary line is identical, so no part of the
        // prompt is derived from the library beyond the genres themselves.
        const upTo = (prompt: string) => prompt.slice(0, prompt.indexOf('genres: '));
        expect(upTo(small)).toBe(upTo(large));

        // And the difference between the two is exactly the added genres.
        expect(large.replace('Jazz, Ambient, Classical', 'Jazz')).toBe(small);
    });
});

describe('reading the reply', () => {
    it('keeps a genre the library actually has', () => {
        expect(parseQuery(reply({ genres: ['Jazz'] }), GENRES)?.genres).toEqual(['Jazz']);
    });

    // Invented genres are the failure mode this whole design guards against.
    it('discards a genre the library does not have', () => {
        expect(parseQuery(reply({ genres: ['Chill', 'Workout'] }), GENRES)?.genres).toEqual([]);
    });

    it('matches case-insensitively but answers in the library’s spelling', () => {
        expect(parseQuery(reply({ genres: ['jazz', 'HIP-HOP'] }), GENRES)?.genres).toEqual([
            'Jazz',
            'Hip-Hop',
        ]);
    });

    it('does not repeat a genre named twice', () => {
        expect(parseQuery(reply({ genres: ['Jazz', 'jazz'] }), GENRES)?.genres).toEqual(['Jazz']);
    });

    it('reads a year returned as a string', () => {
        const query = parseQuery(reply({ fromYear: '1990', toYear: '1999' }), GENRES);
        expect(query?.fromYear).toBe(1990);
        expect(query?.toYear).toBe(1999);
    });

    it('rights a range the model filled backwards', () => {
        const query = parseQuery(reply({ fromYear: 1999, toYear: 1990 }), GENRES);
        expect([query?.fromYear, query?.toYear]).toEqual([1990, 1999]);
    });

    it('rejects a year that cannot be a release date', () => {
        expect(parseQuery(reply({ fromYear: 3050 }), GENRES)?.fromYear).toBeNull();
        expect(parseQuery(reply({ fromYear: 1200 }), GENRES)?.fromYear).toBeNull();
    });

    it('falls back to byName for an ordering it does not recognise', () => {
        expect(parseQuery(reply({ ordering: 'vibes' }), GENRES)?.ordering).toBe('byName');
    });

    it('treats favouritesOnly as false unless it is exactly true', () => {
        expect(parseQuery(reply({ favoritesOnly: 'yes' }), GENRES)?.favoritesOnly).toBe(false);
        expect(parseQuery(reply({ favoritesOnly: true }), GENRES)?.favoritesOnly).toBe(true);
    });

    it('ignores an empty search term rather than searching for nothing', () => {
        expect(parseQuery(reply({ searchTerm: '   ' }), GENRES)?.searchTerm).toBeNull();
    });

    describe('replies that are not only JSON', () => {
        // Models wrap answers in prose or a fence however firmly they are asked
        // not to. A reply that is 95% right should not be lost to its packaging.
        it('finds JSON inside a fenced block', () => {
            const wrapped = '```json\n' + reply({ genres: ['Rock'] }) + '\n```';
            expect(parseQuery(wrapped, GENRES)?.genres).toEqual(['Rock']);
        });

        it('finds JSON after a sentence', () => {
            const chatty = `Sure! Here are the filters:\n${reply({ genres: ['Rock'] })}`;
            expect(parseQuery(chatty, GENRES)?.genres).toEqual(['Rock']);
        });

        it('gives up rather than guessing when there is no JSON', () => {
            expect(parseQuery('I am afraid I cannot help with that.', GENRES)).toBeNull();
        });

        it('gives up on a JSON array, which is not a query', () => {
            expect(parseQuery('["Rock"]', GENRES)).toBeNull();
        });

        it('survives a reply with every field missing', () => {
            const query = parseQuery('{}', GENRES);
            expect(query).not.toBeNull();
            expect(query?.genres).toEqual([]);
            expect(query?.ordering).toBe('byName');
        });
    });
});

describe('isEmptyQuery', () => {
    // A translation that filters nothing is worse than no translation: it looks
    // like a considered answer and returns the whole library.
    it('recognises a query that would filter nothing', () => {
        expect(isEmptyQuery(parseQuery('{}', GENRES)!)).toBe(true);
    });

    it('does not call a genre-only query empty', () => {
        expect(isEmptyQuery(parseQuery(reply({ genres: ['Jazz'] }), GENRES)!)).toBe(false);
    });

    it('does not call a favourites-only query empty', () => {
        expect(isEmptyQuery(parseQuery(reply({ favoritesOnly: true }), GENRES)!)).toBe(false);
    });
});
