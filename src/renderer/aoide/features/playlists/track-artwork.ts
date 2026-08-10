import type { PlaylistTrack } from '/@/main/features/aoide/playlists';
import type { ServerListItem } from '/@/shared/types/domain-types';

import { getServerUrl } from '/@/renderer/utils/normalize-server-url';

/**
 * Cover art for a row the curation store owns.
 *
 * The store keeps identifiers, not pictures: a `playlist_item` is a Jellyfin id
 * and a content key, and the cover for it lives on the same Jellyfin the app is
 * already signed in to. So this builds the URL rather than fetching or caching
 * anything — Jellyfin serves it, the browser caches it, and a playlist of five
 * hundred rows costs five hundred image requests that the viewport throttles
 * rather than five hundred lookups this app has to manage.
 *
 * The album's cover, not the track's, whenever there is one. Jellyfin will serve
 * a Primary image for a track id, but most libraries only have art on the album,
 * and asking for the track's first gives a broken image on every row of an album
 * that has a perfectly good cover.
 */
export const trackArtworkUrl = (
    track: Pick<PlaylistTrack, 'albumId' | 'jellyfinId'>,
    server: null | ServerListItem,
    width: number,
): null | string => {
    if (!server) return null;

    const base = getServerUrl(server);
    if (!base) return null;

    const id = track.albumId ?? track.jellyfinId;

    // `quality=96` and an explicit width, matching what Feishin asks for
    // elsewhere: a thumbnail drawn at 40 points has no use for a 1400px JPEG,
    // and over a home connection that difference is the whole scroll.
    return `${base}/Items/${id}/Images/Primary?quality=96&width=${width}`;
};

/** What a list row draws. Doubled for the sake of a high-density screen. */
export const ROW_ARTWORK_WIDTH = 80;

/** What the header draws behind the playlist's name. */
export const HEADER_ARTWORK_WIDTH = 600;
