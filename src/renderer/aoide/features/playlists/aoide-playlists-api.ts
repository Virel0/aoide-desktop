import type {
    CreatePlaylistOptions,
    MoveTarget,
    PlaylistSummary,
    PlaylistTrack,
    TrackInput,
} from '/@/main/features/aoide/playlists';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { aoidePlaylists, isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { toast } from '/@/shared/components/toast/toast';

/**
 * Every read and write the Aoide playlist screens make, as react-query.
 *
 * The keys are rooted at `['aoide']` and share nothing with `queryKeys` in
 * `src/renderer/api/query-keys.ts`: these rows come from a local database rather
 * than from a server, so they neither belong to a `serverId` nor should be
 * cleared when somebody switches servers. Keeping the two trees apart is what
 * stops a server switch wiping a list that has nothing to do with the server.
 *
 * Writes are coarse on purpose — one IPC call per user action, never one per
 * row. `moveItem` is the sharpest example and is treated as such below.
 */

export const aoidePlaylistKeys = {
    all: ['aoide', 'playlists'] as const,
    detail: (playlistId: string) => ['aoide', 'playlists', 'detail', playlistId] as const,
    items: (playlistId: string) => ['aoide', 'playlists', 'items', playlistId] as const,
    list: () => ['aoide', 'playlists', 'list'] as const,
};

/**
 * Order a playlist the way the store does: `position`, then `id`.
 *
 * Compared with `<` rather than `localeCompare`, because SQLite orders these
 * with BINARY collation and `localeCompare` does not — it ignores case and
 * punctuation under most locales, so a client-side re-sort would disagree with
 * the very query it is meant to be reproducing, and the disagreement would only
 * show up on the two rows a user had just dragged past each other.
 */
export const compareByPosition = (a: PlaylistTrack, b: PlaylistTrack): number => {
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Say what actually failed.
 *
 * The message crossing IPC is the store's own — `No playlist item <id>`,
 * `Positions are out of order: …` — wrapped by Electron in its channel name.
 * It is kept whole. Three faults in this project were diagnosed only by reading
 * the real words, and a screen that replaces them with "Something went wrong"
 * is a screen that costs somebody an afternoon.
 */
export const notifyAoideError = (error: unknown, title: string): void => {
    toast.error({ message: error instanceof Error ? error.message : String(error), title });
};

export const useAddAoideTracks = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: ({ playlistId, tracks }: { playlistId: string; tracks: TrackInput[] }) =>
            aoidePlaylists().addTracks(playlistId, tracks),
        onSuccess: (_added, { playlistId }) => invalidate(playlistId),
    });
};

export const useAoidePlaylist = (playlistId: string) =>
    useQuery({
        enabled: isAoideAvailable(),
        queryFn: () => aoidePlaylists().get(playlistId),
        queryKey: aoidePlaylistKeys.detail(playlistId),
    });

export const useAoidePlaylistItems = (playlistId: string) =>
    useQuery({
        enabled: isAoideAvailable(),
        queryFn: () => aoidePlaylists().items(playlistId),
        queryKey: aoidePlaylistKeys.items(playlistId),
    });

export const useAoidePlaylistList = () =>
    useQuery({
        enabled: isAoideAvailable(),
        queryFn: () => aoidePlaylists().list(),
        queryKey: aoidePlaylistKeys.list(),
    });

export const useCreateAoidePlaylist = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: ({ name, options }: { name: string; options?: CreatePlaylistOptions }) =>
            aoidePlaylists().create(name, options),
        onSuccess: (created) => invalidate(created.id),
    });
};

/**
 * Soft-deletes the playlist and every entry in it.
 *
 * "Soft" is not a detail the screen can hide: the rows stay so that the delete
 * can be told to the other devices, and a playlist deleted here disappears from
 * the phone too. The confirmation says so.
 */
export const useDeleteAoidePlaylist = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: (playlistId: string) => aoidePlaylists().remove(playlistId),
        onSuccess: (_void, playlistId) => invalidate(playlistId),
    });
};

/**
 * Drag-to-reorder, which writes **exactly one row**.
 *
 * The store hands back the single entry that moved, and the cache is patched
 * with it rather than refetched. That is not a micro-optimisation: refetching
 * would quietly make a reorder cost a whole playlist over IPC, which is the
 * expense the fractional index was chosen to avoid, and nothing on the screen
 * would look any different while it happened.
 */
export const useMoveAoideItem = () => {
    const client = useQueryClient();

    return useMutation({
        mutationFn: ({
            itemId,
            target,
        }: {
            itemId: string;
            playlistId: string;
            target: MoveTarget;
        }) => aoidePlaylists().moveItem(itemId, target),
        onError: (_error, { playlistId }) => {
            // The one row was not written, so whatever the screen is showing is
            // a guess. Re-read rather than leave it.
            void client.invalidateQueries({ queryKey: aoidePlaylistKeys.items(playlistId) });
        },
        onSuccess: (moved, { playlistId }) => {
            client.setQueryData<PlaylistTrack[]>(aoidePlaylistKeys.items(playlistId), (previous) =>
                previous
                    ? [...previous.map((item) => (item.id === moved.id ? moved : item))].sort(
                          compareByPosition,
                      )
                    : previous,
            );
        },
    });
};

export const useRemoveAoideItem = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: ({ itemId }: { itemId: string; playlistId: string }) =>
            aoidePlaylists().removeItem(itemId),
        onSuccess: (_void, { playlistId }) => invalidate(playlistId),
    });
};

export const useRenameAoidePlaylist = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: ({ name, playlistId }: { name: string; playlistId: string }) =>
            aoidePlaylists().rename(playlistId, name),
        onSuccess: (renamed) => invalidate(renamed.id),
    });
};

export const useSetAoideNotes = () => {
    const invalidate = useInvalidateAoidePlaylist();

    return useMutation({
        mutationFn: ({ notes, playlistId }: { notes: null | string; playlistId: string }) =>
            aoidePlaylists().setNotes(playlistId, notes),
        onSuccess: (updated) => invalidate(updated.id),
    });
};

export type { PlaylistSummary, PlaylistTrack, TrackInput };

/**
 * Refresh the list and one playlist's own two queries.
 *
 * The list is always invalidated because it carries `trackCount`, so adding a
 * track to a playlist changes a number on a screen that was not the one being
 * edited — most visibly the sidebar, which is on screen the whole time.
 */
const useInvalidateAoidePlaylist = () => {
    const client = useQueryClient();

    return useCallback(
        (playlistId?: string) => {
            void client.invalidateQueries({ queryKey: aoidePlaylistKeys.list() });
            if (!playlistId) return;
            void client.invalidateQueries({ queryKey: aoidePlaylistKeys.detail(playlistId) });
            void client.invalidateQueries({ queryKey: aoidePlaylistKeys.items(playlistId) });
        },
        [client],
    );
};
