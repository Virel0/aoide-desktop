import { LibraryItem, Song } from '/@/shared/types/domain-types';

/**
 * Turning a right-click on *anything* into the songs it stands for.
 *
 * Feishin's own "Add to playlist" entry appears on albums, artists, genres,
 * folders, playlists and queue rows as well as on songs, and for a while the
 * Aoide entry appeared on songs only — so on the desktop an album could be
 * added to a Jellyfin playlist and not to an Aoide one. This is the part of
 * fixing that which can be tested: given a kind of thing and its ids, which
 * fetches to make and how to put the answers together. The fetches themselves
 * are handed in, because they are react-query calls against Jellyfin and the
 * rule about how to use them is the only thing worth proving here.
 *
 * Resolved when the entry is *chosen*, never when the menu opens. Opening a
 * context menu on a discography must not fetch the discography.
 */

/** What each kind of id can be resolved through. Every one answers with songs. */
export interface SongFetchers {
    byAlbum(albumId: string): Promise<Song[]>;
    byArtist(artistId: string): Promise<Song[]>;
    byFolder(folderId: string): Promise<Song[]>;
    /** All at once, which is how Feishin's own genre lookup works. */
    byGenres(genreIds: string[]): Promise<Song[]>;
    byPlaylist(playlistId: string): Promise<Song[]>;
    bySong(songId: string): Promise<Song[]>;
}

/**
 * The songs a selection stands for, in the order the selection was made.
 *
 * Sequential rather than `Promise.all` on purpose: the ids arrive in the order
 * the rows were selected, and a playlist built from three albums should list
 * them in that order rather than in whichever order the server happened to
 * answer.
 *
 * A kind of thing this has no rule for resolves to nothing, and the caller
 * says so, rather than guessing. Guessing is how the playlist screen once
 * queued an empty array over the thing that was playing.
 */
export const resolveSongsForSelection = async (
    itemType: LibraryItem,
    ids: readonly string[],
    fetchers: SongFetchers,
): Promise<Song[]> => {
    const songs: Song[] = [];

    switch (itemType) {
        case LibraryItem.ALBUM:
            for (const id of ids) songs.push(...(await fetchers.byAlbum(id)));
            return songs;
        case LibraryItem.ALBUM_ARTIST:
        case LibraryItem.ARTIST:
            for (const id of ids) songs.push(...(await fetchers.byArtist(id)));
            return songs;
        case LibraryItem.FOLDER:
            for (const id of ids) songs.push(...(await fetchers.byFolder(id)));
            return songs;
        case LibraryItem.GENRE:
            return ids.length > 0 ? fetchers.byGenres([...ids]) : songs;
        case LibraryItem.PLAYLIST:
            for (const id of ids) songs.push(...(await fetchers.byPlaylist(id)));
            return songs;
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.QUEUE_SONG:
        case LibraryItem.SONG:
            for (const id of ids) songs.push(...(await fetchers.bySong(id)));
            return songs;
        default:
            return songs;
    }
};

/**
 * How many playlists a submenu lists before it grows a search box.
 *
 * Eight fit on a screen and are read faster than they are typed for; past
 * that, scrolling a submenu is the slower way to find a name.
 */
export const PLAYLIST_SEARCH_THRESHOLD = 8;

/**
 * The playlists whose names contain what was typed.
 *
 * A plain substring, case-folded, rather than a fuzzy match. The list is the
 * person's own playlists — a few dozen at most, named by them — and a fuzzy
 * match that ranks "Driving" under "d r" is cleverer than a person expects
 * from a box they typed two letters into.
 */
export const filterPlaylistsByName = <T extends { name: string }>(
    playlists: readonly T[],
    term: string,
): T[] => {
    const needle = term.trim().toLocaleLowerCase();
    if (needle.length === 0) return [...playlists];
    return playlists.filter((playlist) => playlist.name.toLocaleLowerCase().includes(needle));
};
