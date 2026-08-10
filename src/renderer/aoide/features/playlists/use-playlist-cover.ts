import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { useSidecarTransport } from '/@/renderer/aoide/features/sync/use-sidecar-transport';

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
export const usePlaylistCover = (
    imageHash: null | string,
    imageMime: null | string,
): null | string => {
    const transport = useSidecarTransport();

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

    return url;
};
