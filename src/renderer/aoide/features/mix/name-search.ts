/**
 * What the library holds for a name.
 *
 * A description that names a band, an album or a game gets that name searched
 * for the way the search page would: songs called it, albums called it — every
 * song of each — and artists called it — their songs. The three lookups are
 * behind an interface so the collecting can be tested without Feishin's
 * controller; `use-mix.ts` supplies the Jellyfin-backed one.
 */

export interface LibrarySearch {
    /** Feishin's search: ids of the songs, albums and album artists a term finds. */
    search(term: string): Promise<{ albumIds: string[]; artistIds: string[]; songIds: string[] }>;
    /** Every song of the albums, at most `limit`. */
    songsOfAlbums(albumIds: readonly string[], limit: number): Promise<string[]>;
    /** Songs by an artist, at most `limit`. */
    songsOfArtist(artistId: string, limit: number): Promise<string[]>;
}

export interface NameSearchResult {
    /** Song ids, in the order found: per name, songs then albums then artists. Each once. */
    ids: string[];
    /** Names the library had nothing for, in the order asked. */
    missed: string[];
}

/**
 * Per lookup, not per name: a name that is a band with a long back catalogue
 * gets fifty of its songs, and its albums get fifty between them, so one name
 * cannot be the whole mix.
 */
export const SONGS_PER_LOOKUP = 50;

export const searchNames = async (
    names: readonly string[],
    library: LibrarySearch,
): Promise<NameSearchResult> => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const missed: string[] = [];

    const take = (found: readonly string[]) => {
        for (const id of found) {
            if (seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
    };

    for (const name of names) {
        const before = ids.length;
        const hits = await library.search(name);

        take(hits.songIds.slice(0, SONGS_PER_LOOKUP));
        if (hits.albumIds.length > 0) {
            take(await library.songsOfAlbums(hits.albumIds, SONGS_PER_LOOKUP));
        }
        for (const artistId of hits.artistIds) {
            take(await library.songsOfArtist(artistId, SONGS_PER_LOOKUP));
        }

        // Found nothing new: either the library has nothing for it, or an
        // earlier name found everything it would have. The first is what a
        // person needs told; the second is rare enough to be told the same way.
        if (ids.length === before) missed.push(name);
    }

    return { ids, missed };
};
