import type { TrackInput } from '/@/main/features/aoide/playlists';

import { Song } from '/@/shared/types/domain-types';

/**
 * A library track as the curation store wants it.
 *
 * Adding a track is the one moment this device learns what the track *is* —
 * nothing else populates the `tracks` cache yet — so the metadata travels with
 * the id rather than being fetched again later. A playlist can then be drawn
 * with the server down, which is most of the point of keeping a local copy.
 *
 * **`album`, `artist` and `title` decide the content key**, which is what a
 * relink matches on when Jellyfin mints new ids for the same files. They are
 * therefore normalised to a string rather than left null: the phone's
 * `ContentKey.make` joins four fields unconditionally, and a desktop key built
 * by omitting an absent album would not be the same string for the same
 * recording, so the two clients would relink to different tracks and neither
 * would report anything wrong.
 *
 * `duration` is milliseconds on this side of the app — Feishin divides
 * `RunTimeTicks` by 10,000 when it normalises a Jellyfin item — and
 * `durationMs` is milliseconds in the store, so it passes through untouched.
 * Rounding it to seconds is the store's job and happens inside the key.
 */
export const trackInputFromSong = (song: Song): TrackInput => ({
    album: song.album ?? '',
    albumArtist: song.albumArtistName || null,
    albumId: song.albumId || null,
    artist: song.artistName ?? '',
    durationMs: song.duration ?? null,
    genres: song.genres?.map((genre) => genre.name) ?? [],
    jellyfinId: song.id,
    // Either MusicBrainz id is better than none for a future relink, and the
    // recording id is the one that survives a re-release; the track id names a
    // particular pressing.
    musicbrainzId: song.mbzRecordingId ?? song.mbzTrackId ?? null,
    title: song.name ?? '',
    year: song.year ?? song.releaseYear ?? null,
});
