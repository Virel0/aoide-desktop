import { describe, expect, it } from 'vitest';

import { contentKeyFor } from './playlists';

/**
 * The content key is a **synced column**. Two devices that normalise differently
 * produce different keys for the same recording, and the relink that is supposed
 * to rescue a playlist after a Jellyfin rescan then matches nothing — silently,
 * because a key that finds no row is indistinguishable from a track that is
 * genuinely gone.
 *
 * So this is not a test of what seems reasonable. Every expectation below was
 * produced by running the phone's own code:
 *
 *     // ck.swift
 *     import Foundation
 *     let f = input.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
 *         .trimmingCharacters(in: .whitespacesAndNewlines)
 *         .replacingOccurrences(of: "  ", with: " ")
 *
 *     $ swift ck.swift
 *
 * Regenerate it the same way if `CurationKit.ContentKey` ever changes. Do not
 * edit an expectation to make a test pass — that is the divergence itself.
 *
 * What the corpus pins, and why each is a real song somewhere: German ß folds to
 * ss; typographic ligatures and the long s fold; the micro sign becomes a Greek
 * mu; Œ, Æ, Đ and Ĳ do NOT decompose; fullwidth forms stay fullwidth; the
 * spacing diacritics are left alone; and combining marks are stripped for Latin,
 * Greek and Cyrillic but preserved for Japanese, Korean, Thai, Devanagari,
 * Arabic and Hebrew.
 */
const PHONE_OUTPUT: ReadonlyArray<readonly [string, string]> = [
    ['Björk', 'bjork'],
    ['  bjork ', 'bjork'],
    ['Sigur Rós', 'sigur ros'],
    ['Motörhead', 'motorhead'],
    ['BEYONCÉ', 'beyonce'],
    ['Straße', 'strasse'],
    ['STRASSE', 'strasse'],
    ['ﬁnal', 'final'],
    ['ﬂow', 'flow'],
    ['ſoft', 'soft'],
    ['µsic', 'μsic'],
    ['ŉ', 'ʼn'],
    ['Café  del  Mar', 'cafe del mar'],
    ['naïve', 'naive'],
    ['Œuvre', 'œuvre'],
    ['Ægis', 'ægis'],
    ['ĐJ', 'đj'],
    ['Ĳsland', 'ĳsland'],
    ['x´y', 'x´y'],
    ['a¨b', 'a¨b'],
    ['Ⅻ', 'ⅻ'],
    ['½', '½'],
    ['が', 'が'],
    ['ｶﾞ', 'ｶﾞ'],
    ['Ｆｕｌｌ', 'ｆｕｌｌ'],
    ['Þór', 'þor'],
    ['ø', 'ø'],
    ['Å', 'a'],
    ['ĥ', 'h'],
    ['ǅ', 'ǆ'],
    ['ǰ', 'j'],
    ['ﬅ', 'st'],
    ['ﬆ', 'st'],
    ['ﬃ', 'ffi'],
    ['ﬄ', 'ffl'],
    ['ﬀ', 'ff'],
    ['İstanbul', 'istanbul'],
    ['ı', 'ı'],
    ['ẞ', 'ss'],
    ['Ǆ', 'ǆ'],
    ['Ǳ', 'ǳ'],
    ['ぱ', 'ぱ'],
    ['ヴ', 'ヴ'],
    ['한국', '한국'],
    ['조선', '조선'],
    ['ก้', 'ก้'],
    ['ข่', 'ข่'],
    ['हिन्दी', 'हिन्दी'],
    ['क़', 'क़'],
    ['العربية', 'العربية'],
    ['عَرَبِيّ', 'عَرَبِيّ'],
    ['עִבְרִית', 'עִבְרִית'],
    ['שׁ', 'שׁ'],
    ['Tiếng Việt', 'tieng viet'],
    ['Đà Nẵng', 'đa nang'],
    ['Ελληνικά', 'ελληνικα'],
    ['ά', 'α'],
    ['Русский', 'русскии'],
    ['й', 'и'],
    ['Ё', 'е'],
    ['ñ', 'n'],
    ['ç', 'c'],
    ['Ǻ', 'a'],
    ['ẛ', 's'],
    ['ǽ', 'æ'],
];

/** The key is `artist|album|title|seconds`, so the artist field alone isolates normalisation. */
const normalisedArtist = (artist: string): string =>
    contentKeyFor({ album: '', artist, durationMs: 0, title: '' }).split('|')[0];

describe('content key normalisation', () => {
    it.each(PHONE_OUTPUT)('folds %j the way the phone does', (input, expected) => {
        expect(normalisedArtist(input)).toBe(expected);
    });

    it('rounds the duration to the nearest second, so a re-encode still matches', () => {
        const key = (durationMs: number) =>
            contentKeyFor({ album: 'A', artist: 'B', durationMs, title: 'C' });

        expect(key(235_400)).toBe(key(235_000));
        expect(key(235_600)).not.toBe(key(235_000));
    });

    it('treats an unknown duration as zero rather than inventing one', () => {
        expect(contentKeyFor({ album: 'A', artist: 'B', title: 'C' }).endsWith('|0')).toBe(true);
    });

    it('joins the four parts with a pipe, in the phone order', () => {
        expect(
            contentKeyFor({ album: 'Album', artist: 'Artist', durationMs: 1000, title: 'Title' }),
        ).toBe('artist|album|title|1');
    });
});
