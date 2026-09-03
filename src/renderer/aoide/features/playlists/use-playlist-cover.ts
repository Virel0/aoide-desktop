import type { CoverTrack } from '/@/main/features/aoide/playlists';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { trackArtworkUrl } from '/@/renderer/aoide/features/playlists/track-artwork';
import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';
import { useCurrentServer } from '/@/renderer/store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';

/**
 * A playlist's cover, wherever it happens to be.
 *
 * The playlist row carries `imageHash` and `imageMime` — a few dozen bytes — and
 * the picture itself lives outside the op log entirely. That is the whole reason
 * a full history sync stays small: every device replays every op, and covers
 * inside them would make the log grow without bound.
 *
 * So the bytes are looked for in three places, in order of what they cost: this
 * device's blob store, then the sidecar, then nowhere. Fetched **lazily, when
 * something is about to draw one, never during sync** — a device joining an
 * account would otherwise download every cover in the library before it finished
 * syncing, most of which it will never show.
 *
 * Cached by hash and never invalidated, because it cannot go stale: bytes behind
 * a SHA-256 are the same bytes forever. That is the third thing content
 * addressing buys, after "re-uploading is a no-op" and "two playlists sharing a
 * cover store one copy".
 */
export const usePlaylistCover = (playlist: CoverSource): null | string => {
    const { artworkItemId, imageHash, imageMime, sourceJellyfinId } = playlist;
    const transport = useSidecarTransport();
    const server = useCurrentServer();

    const { data } = useQuery({
        enabled: Boolean(imageHash) && isAoideAvailable(),
        // No refetch interval, no stale time, no invalidation anywhere: the key
        // *is* the content.
        gcTime: Infinity,
        queryFn: async () => {
            const hash = imageHash as string;

            const held = await window.api.aoide.images.get(hash);
            if (held) return held;

            if (!transport) return null;

            const bytes = await transport.getImage(hash);
            if (!bytes) return null;

            // Kept, so the next draw — and the next launch — needs no network.
            // The mime the playlist row claims, since the sidecar serves bytes
            // and the row is what said what they are.
            const mime = imageMime ?? 'image/jpeg';
            await window.api.aoide.images.store(bytes, mime);

            return { bytes, mime };
        },
        queryKey: ['aoide', 'cover', imageHash],
        // A cover that will not fetch is not worth three attempts on every
        // render of every row; it will be there on the next sync or it will not.
        retry: false,
        staleTime: Infinity,
    });

    // Held per component rather than in the query cache, so the URL's lifetime
    // is the lifetime of the thing drawing it. An object URL that outlives its
    // <img> is a leak nothing ever reports.
    const url = useMemo(() => {
        if (!data) return null;
        return URL.createObjectURL(new Blob([data.bytes as BlobPart], { type: data.mime }));
    }, [data]);

    useEffect(() => {
        if (!url) return;
        return () => URL.revokeObjectURL(url);
    }, [url]);

    // The blob wins when there is one. Otherwise the cover is an *item* on
    // Jellyfin, which is how a playlist imported from there keeps the picture it
    // already had — `artworkItemId` when somebody chose one, and the source
    // playlist itself when nobody did.
    const jellyfinItem = artworkItemId ?? sourceJellyfinId;
    const base = server ? getServerUrl(server) : null;

    if (url) return url;
    if (!jellyfinItem || !base) return null;

    return `${base}/Items/${jellyfinItem}/Images/Primary?quality=96&width=${COVER_WIDTH}`;
};

/**
 * Where a playlist's cover can come from, in the phone's order of precedence.
 *
 * `PlaylistArtwork.swift` reads `artworkItemId ?? sourceJellyfinId`, with the
 * hash beating both — and the third of those is the one that matters in
 * practice, because a playlist imported from Jellyfin has no blob and no chosen
 * artwork, only the picture Jellyfin already holds for it. Looking at the hash
 * alone left every imported playlist blank.
 */
export interface CoverSource {
    artworkItemId: null | string;
    imageHash: null | string;
    imageMime: null | string;
    sourceJellyfinId: null | string;
}

/** Big enough for the detail hero; a thumbnail scales down without a second fetch. */
const COVER_WIDTH = 600;

/**
 * A cover, or failing that the first track's album art.
 *
 * Every playlist the phone imported arrived with no cover at all — no blob, no
 * chosen item, no source — and drew a grey icon, which reads as broken rather
 * than as "no cover". The stand-in is the same picture the first row of the
 * playlist already shows, at whatever size the caller draws; Jellyfin serves
 * it and the browser caches it. Nothing is written: the repair that *fixes*
 * the cover is `use-cover-repair.ts`, and this is what is drawn until it has.
 */
export const usePlaylistCoverOrFirstTrack = (
    playlist: CoverSource & { firstTrack?: CoverTrack | null },
    width: number,
): null | string => {
    const cover = usePlaylistCover(playlist);
    const server = useCurrentServer();

    if (cover) return cover;
    if (!playlist.firstTrack) return null;

    return trackArtworkUrl(playlist.firstTrack, server, width);
};
