import type { Song } from '/@/shared/types/domain-types';

import { describe, expect, it, vi } from 'vitest';

import {
    filterPlaylistsByName,
    PLAYLIST_SEARCH_THRESHOLD,
    resolveSongsForSelection,
    SongFetchers,
} from '/@/renderer/aoide/features/playlists/song-resolution';
import { LibraryItem } from '/@/shared/types/domain-types';

const song = (id: string): Song => ({ id, name: id }) as Song;

/** Every fetcher answers with songs named after what it was asked for. */
const fetchers = (): SongFetchers => ({
    byAlbum: vi.fn(async (id: string) => [song(`${id}/1`), song(`${id}/2`)]),
    byArtist: vi.fn(async (id: string) => [song(`${id}/a`)]),
    byFolder: vi.fn(async (id: string) => [song(`${id}/f`)]),
    byGenres: vi.fn(async (ids: string[]) => ids.map((id) => song(`${id}/g`))),
    byPlaylist: vi.fn(async (id: string) => [song(`${id}/p`)]),
    bySong: vi.fn(async (id: string) => [song(id)]),
});

describe('resolveSongsForSelection', () => {
    it('expands each album in the order it was selected', async () => {
        const f = fetchers();
        const songs = await resolveSongsForSelection(LibraryItem.ALBUM, ['al2', 'al1'], f);

        expect(songs.map((s) => s.id)).toEqual(['al2/1', 'al2/2', 'al1/1', 'al1/2']);
        expect(f.byAlbum).toHaveBeenCalledTimes(2);
        expect(f.byGenres).not.toHaveBeenCalled();
    });

    it('treats album artists and artists alike', async () => {
        const f = fetchers();
        expect(
            (await resolveSongsForSelection(LibraryItem.ALBUM_ARTIST, ['x'], f)).map((s) => s.id),
        ).toEqual(['x/a']);
        expect(
            (await resolveSongsForSelection(LibraryItem.ARTIST, ['y'], f)).map((s) => s.id),
        ).toEqual(['y/a']);
    });

    // Feishin's genre lookup takes every id in one call; asking per genre would
    // be a request per row for the same answer.
    it('asks for all genres at once', async () => {
        const f = fetchers();
        const songs = await resolveSongsForSelection(LibraryItem.GENRE, ['g1', 'g2'], f);

        expect(songs.map((s) => s.id)).toEqual(['g1/g', 'g2/g']);
        expect(f.byGenres).toHaveBeenCalledTimes(1);
        expect(f.byGenres).toHaveBeenCalledWith(['g1', 'g2']);
    });

    it('fetches nothing for an empty genre selection', async () => {
        const f = fetchers();
        expect(await resolveSongsForSelection(LibraryItem.GENRE, [], f)).toEqual([]);
        expect(f.byGenres).not.toHaveBeenCalled();
    });

    it('walks folders and Jellyfin playlists', async () => {
        const f = fetchers();
        expect(
            (await resolveSongsForSelection(LibraryItem.FOLDER, ['d'], f)).map((s) => s.id),
        ).toEqual(['d/f']);
        expect(
            (await resolveSongsForSelection(LibraryItem.PLAYLIST, ['pl'], f)).map((s) => s.id),
        ).toEqual(['pl/p']);
    });

    it('looks a bare song id up rather than inventing a song from it', async () => {
        const f = fetchers();
        for (const type of [LibraryItem.SONG, LibraryItem.PLAYLIST_SONG, LibraryItem.QUEUE_SONG]) {
            expect((await resolveSongsForSelection(type, ['s1'], f)).map((s) => s.id)).toEqual([
                's1',
            ]);
        }
        expect(f.bySong).toHaveBeenCalledTimes(3);
    });

    // Guessing is how an empty array was once queued over whatever was playing.
    it('resolves a kind it has no rule for to nothing, and fetches nothing', async () => {
        const f = fetchers();
        expect(await resolveSongsForSelection(LibraryItem.RADIO_STATION, ['r'], f)).toEqual([]);
        for (const fetcher of Object.values(f)) expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('filterPlaylistsByName', () => {
    const playlists = [{ name: 'Driving' }, { name: 'Late night' }, { name: 'Night drive' }];

    it('returns everything for an empty or blank term', () => {
        expect(filterPlaylistsByName(playlists, '')).toEqual(playlists);
        expect(filterPlaylistsByName(playlists, '   ')).toEqual(playlists);
    });

    it('matches a substring without caring about case', () => {
        expect(filterPlaylistsByName(playlists, 'NIGHT').map((p) => p.name)).toEqual([
            'Late night',
            'Night drive',
        ]);
    });

    it('trims what was typed', () => {
        expect(filterPlaylistsByName(playlists, ' driv ').map((p) => p.name)).toEqual([
            'Driving',
            'Night drive',
        ]);
    });

    it('offers a search box only once the list is worth searching', () => {
        expect(PLAYLIST_SEARCH_THRESHOLD).toBeGreaterThanOrEqual(8);
    });
});
