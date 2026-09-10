import type { FinishCounts } from '/@/shared/aoide/finish-rate';
import type { TasteCandidate, TasteProfile } from '/@/shared/aoide/taste-ranking';
import type { Song } from '/@/shared/types/domain-types';

import { emptyFinishCounts, totalFinishCounts } from '/@/shared/aoide/finish-rate';
import { isTasteProfileEmpty, rankByTaste } from '/@/shared/aoide/taste-ranking';

/**
 * Infinity's half of the choosing.
 *
 * What the strategies collect is a **pool**, not an answer. Jellyfin knows what
 * is *like* the song playing and the library knows what exists; only the local
 * history knows which genres and artists get listened to all the way through,
 * which tracks get skipped every time, and what has been on in the last hour.
 * So the strategies gather several times what is wanted and `taste-ranking.ts`
 * — the phone's arithmetic, held to it by a shared table — picks from that.
 *
 * With nothing to read, every function here hands back the pool's own order.
 * That is exactly what Auto DJ did before this existed, and a new install must
 * not get worse for a feature it has no data to feed.
 */

/**
 * How many times the setting's item count to collect before ranking.
 *
 * Wide enough that the ranking has something to reject — picking five out of
 * five is not picking — and narrow enough that each strategy stays the same
 * shape of request it already made. The phone asks for a hundred to keep
 * twenty, which is this.
 */
export const INFINITY_POOL_MULTIPLIER = 5;

/**
 * The albums to queue, best first, judged by the tracks on them.
 *
 * An album is not a long song, so it is not scored as one. Its genres are its
 * tracks' genres — the ranking already takes the best match, which over a whole
 * record means the record is judged on its strongest reason to be there — its
 * finish counts are its tracks' counts summed, which is `finish-rate.ts`'s own
 * rule for a collection, and it counts as recently heard when any track on it
 * was. That last one is what the penalty means for a record: the album you had
 * on this afternoon is not the one to put on again this evening, however well
 * it fits.
 *
 * `tracks` is whatever tracklists were fetched for the pool. One album missing
 * from them still gets a candidate — dropping it would let a gap in the fetch
 * quietly shorten the queue — but *no* tracks at all means the fetch failed,
 * and then the pool's own order stands. Ranking records nothing is known about
 * would sort the queue by album id, which is not an order anybody chose.
 */
export const chooseAlbumsByTaste = (
    albumIds: readonly string[],
    tracks: readonly Song[],
    profile: TasteProfile,
    trackFinish: Readonly<Record<string, FinishCounts>>,
    limit: number,
): string[] => {
    if (tracks.length === 0 || isTasteProfileEmpty(profile)) {
        return albumIds.slice(0, Math.max(limit, 0));
    }

    const wanted = new Set(albumIds);
    const byAlbum = new Map<string, Song[]>();
    for (const track of tracks) {
        if (!wanted.has(track.albumId)) continue;

        const held = byAlbum.get(track.albumId);
        if (held) {
            held.push(track);
        } else {
            byAlbum.set(track.albumId, [track]);
        }
    }

    const candidates: TasteCandidate[] = [];
    const finish: Record<string, FinishCounts> = {};
    const recent = new Set<string>();

    for (const albumId of albumIds) {
        const albumTracks = byAlbum.get(albumId) ?? [];

        candidates.push({
            artist: albumTracks.map(tasteArtist).find((name) => name.length > 0) ?? '',
            genres: [...new Set(albumTracks.flatMap(tasteGenres))],
            id: albumId,
        });

        finish[albumId] = totalFinishCounts(
            albumTracks.map((track) => countsFor(trackFinish, track.id)),
        );

        if (albumTracks.some((track) => profile.recent.has(track.id))) recent.add(albumId);
    }

    return rankByTaste(candidates, { ...profile, recent }, finish, limit).map(
        (candidate) => candidate.id,
    );
};

/**
 * The songs to queue, best first.
 *
 * The pool may hold one song twice — "allow duplicates" is a setting, and with
 * it on the strategies can gather the same track from two sources — and both
 * copies are ranked and both can survive, so a listener who asked for five
 * still gets five.
 */
export const chooseSongsByTaste = (
    pool: readonly Song[],
    profile: TasteProfile,
    finish: Readonly<Record<string, FinishCounts>>,
    limit: number,
): Song[] => {
    if (isTasteProfileEmpty(profile)) return pool.slice(0, Math.max(limit, 0));

    const byId = new Map<string, Song>();
    for (const song of pool) {
        if (!byId.has(song.id)) byId.set(song.id, song);
    }

    return rankByTaste(pool.map(songTasteCandidate), profile, finish, limit)
        .map((candidate) => byId.get(candidate.id))
        .filter((song) => song !== undefined);
};

/** How many to collect so that there is something to reject. */
export const infinityPoolCount = (itemCount: number): number =>
    Math.max(itemCount, 1) * INFINITY_POOL_MULTIPLIER;

/**
 * One song as the ranking sees it.
 *
 * The artist is the album artist where there is one, because that is the name
 * the profile's weights are keyed on: the history coalesces the two, so a guest
 * appearance on a compilation counts towards the artist whose record it is.
 */
export const songTasteCandidate = (song: Song): TasteCandidate => ({
    artist: tasteArtist(song),
    genres: tasteGenres(song),
    id: song.id,
});

const countsFor = (finish: Readonly<Record<string, FinishCounts>>, id: string): FinishCounts =>
    Object.hasOwn(finish, id) ? finish[id] : emptyFinishCounts();

const tasteArtist = (song: Song): string => song.albumArtistName || song.artistName || '';

const tasteGenres = (song: Song): string[] => song.genres?.map((genre) => genre.name) ?? [];
