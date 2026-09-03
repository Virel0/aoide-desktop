import type { Candidate } from '/@/shared/aoide/playlist-import';
import type { Song } from '/@/shared/types/domain-types';

/**
 * A library song as the matcher judges it: title, every credited name, length.
 *
 * Album artists are included alongside track artists — a compilation tags the
 * performer on the track and "Various Artists" on the album, a solo record
 * often tags only the album — so the imported side's artist has both to match.
 * Feishin's `duration` is already milliseconds for Jellyfin.
 */
export const candidateFromSong = (song: Song): Candidate => {
    const names = [...(song.artists ?? []), ...(song.albumArtists ?? [])]
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return {
        artists: [...new Set(names)],
        durationMs: song.duration ?? null,
        title: song.name ?? '',
    };
};
