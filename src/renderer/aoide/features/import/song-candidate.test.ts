import type { Song } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import { candidateFromSong } from './song-candidate';

// Only the fields the matcher reads; the rest of `Song` is irrelevant here.
const song = (overrides: Record<string, unknown>): Song =>
    ({
        albumArtists: [{ id: 'aa', name: 'Various Artists' }],
        artists: [{ id: 'a', name: 'Radiohead' }],
        duration: 264_000,
        name: 'Karma Police',
        ...overrides,
    }) as unknown as Song;

describe('candidateFromSong', () => {
    it('offers track and album artists together, once each', () => {
        expect(candidateFromSong(song({}))).toEqual({
            artists: ['Radiohead', 'Various Artists'],
            durationMs: 264_000,
            title: 'Karma Police',
        });
        expect(
            candidateFromSong(song({ albumArtists: [{ id: 'a', name: 'Radiohead' }] })).artists,
        ).toEqual(['Radiohead']);
    });

    it('drops empty names and copes with nothing tagged at all', () => {
        expect(
            candidateFromSong(song({ albumArtists: [], artists: [{ id: 'x', name: '' }] })).artists,
        ).toEqual([]);
        expect(candidateFromSong(song({ duration: null })).durationMs).toBeNull();
    });
});
