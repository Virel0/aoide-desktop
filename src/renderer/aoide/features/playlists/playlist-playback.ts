import type { PlaylistTrack } from '/@/main/features/aoide/playlists';
import type { Song } from '/@/shared/types/domain-types';

/**
 * Turning a stored playlist into something the player will accept.
 *
 * The store's rows are `PlaylistTrack` — an item id, a fractional index and
 * whatever metadata this device happens to have indexed. The player's queue is
 * made of Feishin `Song`s, which carry the stream URL, so the two have to be
 * bridged somewhere. Here, rather than in the screen, because the bridge is the
 * only part with rules worth testing and the screen is not testable in this
 * repo's runner.
 *
 * A `Song` is never hand-built from a row: half its fields decide how playback
 * behaves and a plausible-looking literal would be wrong in ways that only show
 * up mid-track. The library is asked for the real item instead.
 */

export interface PlaylistPlayback {
    /**
     * Entries the library would not hand back.
     *
     * Not an error on its own: a playlist synced from the phone can name a track
     * this Jellyfin server no longer has, and the rest of it is still perfectly
     * playable. It is counted so the screen can say so rather than quietly
     * playing a shorter playlist than the one on the page.
     */
    missing: number;
    /**
     * Which song to start on, by library id. Undefined means the top.
     *
     * The whole playlist is queued either way — this only names where the needle
     * drops, which is what keeps Previous able to reach the tracks above the one
     * that was double-clicked.
     */
    playSongId?: string;
    /** In playlist order, with the unfetchable entries left out. */
    songs: Song[];
}

/**
 * Fetch one library song by its Jellyfin id, or reject.
 *
 * Passed in rather than imported so this module stays free of the API layer —
 * which reaches for axios and the renderer's server store, neither of which
 * exists under the test runner.
 */
export type SongFetcher = (jellyfinId: string) => Promise<Song | undefined>;

/**
 * Resolve a playlist into a queue, starting at `fromItemId` when one is named.
 *
 * Every track is fetched, never a slice from the clicked row: a queue that
 * begins at the clicked track has thrown away everything above it, and Previous
 * then stops at whatever the user happened to double-click.
 *
 * Requests go out together. That looks like a burst for a thousand-track
 * playlist, but Chromium caps connections per origin at six, so the pool is
 * already there and imposing a second one would only make the common case — a
 * playlist of a few dozen, all of them warm in the query cache — slower for no
 * gain.
 */
export const resolvePlaylistPlayback = async (
    tracks: readonly PlaylistTrack[],
    fromItemId: string | undefined,
    fetchSong: SongFetcher,
): Promise<PlaylistPlayback> => {
    // The item id identifies the row; the library only knows the Jellyfin id.
    // Resolved before the fetches so a start row whose song turns out to be
    // missing still leaves the rest of the playlist queued.
    const playSongId = fromItemId
        ? tracks.find((track) => track.id === fromItemId)?.jellyfinId
        : undefined;

    const settled = await Promise.allSettled(tracks.map((track) => fetchSong(track.jellyfinId)));

    // `allSettled` keeps input order, which is the playlist's fractional-index
    // order, so nothing has to sort the results back afterwards.
    const songs = settled.flatMap((outcome) =>
        outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : [],
    );

    return {
        missing: tracks.length - songs.length,
        // Naming a song that is not in the queue makes the player fall back to
        // the top of it, so a start row the library could not return is dropped
        // here instead — the queue is still whole, it merely begins at track one.
        playSongId: songs.some((song) => song.id === playSongId) ? playSongId : undefined,
        songs,
    };
};
