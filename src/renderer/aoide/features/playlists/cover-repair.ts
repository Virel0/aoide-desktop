/**
 * Finding a cover for a playlist that has none, by name — carefully.
 *
 * Measured on the real database rather than guessed: every Aoide playlist the
 * phone imported from Jellyfin has `imageHash`, `artworkItemId` and
 * `sourceJellyfinId` all NULL. The phone's importer never wrote down where
 * they came from, so no client has anything to draw. The same missing column
 * is why a re-import produced duplicates — one cause, two symptoms — and the
 * real fix is in the phone's importer. This is the repair for what already
 * exists.
 *
 * The one rule that matters: **a name match writes `artworkItemId`, never
 * `sourceJellyfinId`.** A name cannot prove provenance, and provenance is what
 * deduping keys on; a guess written there would make the next import a
 * silent merge of two unrelated playlists. Artwork is a picture and nothing
 * depends on it. So the plan this produces has exactly one writable field.
 */

/** The three ways a playlist can already have a cover. All must be absent. */
export interface CoverlessCandidate {
    artworkItemId: null | string;
    id: string;
    imageHash: null | string;
    name: string;
    sourceJellyfinId: null | string;
}

/** One write. `artworkItemId` is the only field, by design — see above. */
export interface CoverRepair {
    artworkItemId: string;
    playlistId: string;
}

export interface NamedJellyfinPlaylist {
    id: string;
    name: string;
}

/** Nothing at all to draw from: no blob, no chosen item, no source playlist. */
export const isCoverless = (playlist: CoverlessCandidate): boolean =>
    playlist.artworkItemId === null &&
    playlist.imageHash === null &&
    playlist.sourceJellyfinId === null;

/**
 * Which coverless playlists can borrow a Jellyfin playlist's picture.
 *
 * Exact after trimming, case-sensitive. "Driving" and "driving" are two
 * playlists until somebody says otherwise, and a repair that guesses wrong
 * puts the wrong picture on the phone too — this syncs. Zero matches and two
 * or more matches are both skipped, silently: there is nothing to say that
 * would help, and the next run will look again.
 */
export const planCoverRepairs = (
    aoidePlaylists: readonly CoverlessCandidate[],
    jellyfinPlaylists: readonly NamedJellyfinPlaylist[],
): CoverRepair[] => {
    const byName = new Map<string, NamedJellyfinPlaylist[]>();
    for (const playlist of jellyfinPlaylists) {
        const name = playlist.name.trim();
        byName.set(name, [...(byName.get(name) ?? []), playlist]);
    }

    const repairs: CoverRepair[] = [];
    for (const playlist of aoidePlaylists) {
        if (!isCoverless(playlist)) continue;

        const matches = byName.get(playlist.name.trim()) ?? [];
        if (matches.length !== 1) continue;

        repairs.push({ artworkItemId: matches[0].id, playlistId: playlist.id });
    }

    return repairs;
};
