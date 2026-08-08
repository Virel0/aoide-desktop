import type { PlaylistTrack } from '/@/main/features/aoide/playlists';
import type { Song } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import { resolvePlaylistPlayback } from '/@/renderer/aoide/features/playlists/playlist-playback';

const track = (id: string, jellyfinId: string): PlaylistTrack =>
    ({ id, jellyfinId, playlistId: 'p1' }) as PlaylistTrack;

const song = (id: string): Song => ({ id, name: id }) as Song;

const library = (available: string[]) => async (jellyfinId: string) => {
    if (!available.includes(jellyfinId)) throw new Error('Song not found');
    return song(jellyfinId);
};

describe('resolvePlaylistPlayback', () => {
    it('queues the whole playlist in order when nothing is named', async () => {
        const tracks = [track('i1', 'j1'), track('i2', 'j2'), track('i3', 'j3')];

        const playback = await resolvePlaylistPlayback(
            tracks,
            undefined,
            library(['j1', 'j2', 'j3']),
        );

        expect(playback.songs.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3']);
        expect(playback.playSongId).toBeUndefined();
        expect(playback.missing).toBe(0);
    });

    /*
     * The bug this replaced sliced the list from the clicked row, so Previous
     * could never reach the tracks above it. Starting in the middle must still
     * queue the tracks before it.
     */
    it('keeps the tracks above the starting row in the queue', async () => {
        const tracks = [track('i1', 'j1'), track('i2', 'j2'), track('i3', 'j3')];

        const playback = await resolvePlaylistPlayback(tracks, 'i3', library(['j1', 'j2', 'j3']));

        expect(playback.songs.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3']);
        expect(playback.playSongId).toBe('j3');
    });

    it('resolves the starting row by item id, not by library id', async () => {
        // The two ids are deliberately crossed: an implementation matching
        // `fromItemId` against `jellyfinId` would find the wrong row.
        const tracks = [track('j2', 'j1'), track('j1', 'j2')];

        const playback = await resolvePlaylistPlayback(tracks, 'j1', library(['j1', 'j2']));

        expect(playback.playSongId).toBe('j2');
    });

    it('leaves out entries the library will not return, and counts them', async () => {
        const tracks = [track('i1', 'j1'), track('i2', 'gone'), track('i3', 'j3')];

        const playback = await resolvePlaylistPlayback(tracks, undefined, library(['j1', 'j3']));

        expect(playback.songs.map((entry) => entry.id)).toEqual(['j1', 'j3']);
        expect(playback.missing).toBe(1);
    });

    it('counts an entry the library answers for with nothing', async () => {
        const tracks = [track('i1', 'j1')];

        const playback = await resolvePlaylistPlayback(tracks, undefined, async () => undefined);

        expect(playback.songs).toEqual([]);
        expect(playback.missing).toBe(1);
    });

    // Naming a song outside the queue makes the player start at the top anyway,
    // so it is dropped rather than passed on as a lie about where playback began.
    it('drops a starting row the library could not return', async () => {
        const tracks = [track('i1', 'j1'), track('i2', 'gone')];

        const playback = await resolvePlaylistPlayback(tracks, 'i2', library(['j1']));

        expect(playback.playSongId).toBeUndefined();
        expect(playback.songs.map((entry) => entry.id)).toEqual(['j1']);
    });
});
