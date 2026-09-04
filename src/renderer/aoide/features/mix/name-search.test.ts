import { describe, expect, it, vi } from 'vitest';

import { LibrarySearch, searchNames, SONGS_PER_LOOKUP } from './name-search';

const library = (over: Partial<LibrarySearch> = {}): LibrarySearch => ({
    search: vi.fn(async () => ({ albumIds: [], artistIds: [], songIds: [] })),
    songsOfAlbums: vi.fn(async () => []),
    songsOfArtist: vi.fn(async () => []),
    ...over,
});

describe('searchNames', () => {
    it('collects the songs found, then every song of each album, then each artist’s', async () => {
        const lib = library({
            search: vi.fn(async () => ({
                albumIds: ['album-1'],
                artistIds: ['artist-1'],
                songIds: ['s1'],
            })),
            songsOfAlbums: vi.fn(async () => ['a1', 'a2']),
            songsOfArtist: vi.fn(async () => ['r1']),
        });

        const result = await searchNames(['Muse'], lib);

        expect(result.ids).toEqual(['s1', 'a1', 'a2', 'r1']);
        expect(result.missed).toEqual([]);
        expect(lib.songsOfAlbums).toHaveBeenCalledWith(['album-1'], SONGS_PER_LOOKUP);
        expect(lib.songsOfArtist).toHaveBeenCalledWith('artist-1', SONGS_PER_LOOKUP);
    });

    it('names what the library had nothing for', async () => {
        const lib = library({
            search: vi.fn(async (term: string) => ({
                albumIds: [],
                artistIds: [],
                songIds: term === 'Muse' ? ['s1'] : [],
            })),
        });

        const result = await searchNames(['Helldivers 2', 'Muse', 'Nobody'], lib);

        expect(result.ids).toEqual(['s1']);
        expect(result.missed).toEqual(['Helldivers 2', 'Nobody']);
    });

    it('caps the songs taken from one search', async () => {
        const many = Array.from({ length: SONGS_PER_LOOKUP + 20 }, (_, i) => `s${i}`);
        const lib = library({
            search: vi.fn(async () => ({ albumIds: [], artistIds: [], songIds: many })),
        });

        const result = await searchNames(['Muse'], lib);
        expect(result.ids).toHaveLength(SONGS_PER_LOOKUP);
    });

    it('keeps each song once across names and lookups', async () => {
        const lib = library({
            search: vi.fn(async () => ({ albumIds: ['album-1'], artistIds: [], songIds: ['s1'] })),
            songsOfAlbums: vi.fn(async () => ['s1', 's2']),
        });

        const result = await searchNames(['Muse', 'Muse (band)'], lib);
        expect(result.ids).toEqual(['s1', 's2']);
    });

    it('asks nothing of the library for no names', async () => {
        const lib = library();
        expect(await searchNames([], lib)).toEqual({ ids: [], missed: [] });
        expect(lib.search).not.toHaveBeenCalled();
    });

    it('does not look up albums when none were found', async () => {
        const lib = library({
            search: vi.fn(async () => ({ albumIds: [], artistIds: [], songIds: ['s1'] })),
        });
        await searchNames(['Muse'], lib);
        expect(lib.songsOfAlbums).not.toHaveBeenCalled();
    });
});
