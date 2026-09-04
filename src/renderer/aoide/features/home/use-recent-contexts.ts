import type { PlaylistSummary } from '/@/main/features/aoide/playlists';
import type { Album, Playlist, RelatedArtist } from '/@/shared/types/domain-types';

import { persist } from 'zustand/middleware';
import { createWithEqualityFn } from 'zustand/traditional';

import {
    list,
    RecentContext,
    remember,
    RESUME_GRID_LIMIT,
    StationSeed,
} from '/@/renderer/aoide/features/home/recent-contexts';

interface RecentContextsState {
    /** Per server, because an album id means nothing on another server. */
    byServer: Record<string, RecentContext[]>;
    remember: (serverId: string, context: RecentContext) => void;
}

/**
 * The recent contexts, persisted the way the rest of the renderer's state
 * is: a Zustand store under a name of its own in localStorage, so it
 * survives a restart and never touches Feishin's stores.
 */
export const useRecentContextsStore = createWithEqualityFn<RecentContextsState>()(
    persist(
        (set) => ({
            byServer: {},
            remember: (serverId, context) =>
                set((state) => ({
                    byServer: {
                        ...state.byServer,
                        [serverId]: remember(state.byServer[serverId] ?? [], context),
                    },
                })),
        }),
        { name: 'aoide-recent-contexts', version: 1 },
    ),
);

const EMPTY: RecentContext[] = [];

/** The newest `limit` contexts for a server, newest first. */
export const useRecentContexts = (
    serverId: string,
    limit: number = RESUME_GRID_LIMIT,
): RecentContext[] => {
    const contexts = useRecentContextsStore((state) => state.byServer[serverId] ?? EMPTY);
    return list(contexts, limit);
};

/**
 * Record that playback started from a context, stamped now.
 *
 * Plain functions rather than a hook, because the callers are the play
 * handlers of five different screens and each of those is one line: the
 * upstream files stay minimally touched, and none of them has to learn what
 * a context is.
 */
export const rememberContext = (
    serverId: string | undefined,
    context: Omit<RecentContext, 'lastOpened'>,
): void => {
    if (!serverId || !context.id || !context.name) return;
    useRecentContextsStore.getState().remember(serverId, { ...context, lastOpened: Date.now() });
};

const joinArtists = (artists: RelatedArtist[] | undefined): string | undefined => {
    const names = artists?.map((artist) => artist.name).filter(Boolean) ?? [];
    return names.length > 0 ? names.join(', ') : undefined;
};

export const rememberAlbum = (
    serverId: string | undefined,
    album: Pick<Album, 'albumArtists' | 'id' | 'name'> | undefined,
): void => {
    if (!album) return;
    rememberContext(serverId, {
        id: album.id,
        kind: 'album',
        name: album.name,
        subtitle: joinArtists(album.albumArtists),
    });
};

export const rememberJellyfinPlaylist = (
    serverId: string | undefined,
    playlist: Pick<Playlist, 'id' | 'name'> | undefined,
): void => {
    if (!playlist) return;
    rememberContext(serverId, { id: playlist.id, kind: 'jellyfinPlaylist', name: playlist.name });
};

export const rememberAoidePlaylist = (
    serverId: string | undefined,
    playlist: Pick<PlaylistSummary, 'id' | 'isSmart' | 'name'> | undefined,
): void => {
    if (!playlist) return;
    rememberContext(serverId, {
        id: playlist.id,
        kind: 'aoidePlaylist',
        name: playlist.name,
        // The play recorder files a listen started here as `smart` or
        // `playlist`, which is the phone's distinction.
        smart: playlist.isSmart,
    });
};

/**
 * A mix is its description: that is what was typed, what the tile says, and
 * what the mix page is handed back to make it again.
 */
export const rememberMix = (serverId: string | undefined, description: string): void => {
    const name = description.trim();
    rememberContext(serverId, { id: name, kind: 'mix', name });
};

export const rememberStation = (
    serverId: string | undefined,
    seed: StationSeed,
    item: undefined | { id: string; name: string },
): void => {
    if (!item) return;
    rememberContext(serverId, { id: item.id, kind: 'station', name: item.name, seed });
};
