import type {
    CreatePlaylistOptions,
    ImportRequest,
    ImportResult,
    MoveTarget,
    PlaylistSummary,
    PlaylistTrack,
    TrackInput,
} from '/@/main/features/aoide/playlists';

import { ipcRenderer } from 'electron';

/**
 * The renderer's way into the curation store, which lives in the main process.
 *
 * Types are imported from the main-side module rather than restated here. Two
 * sets that must agree will drift — that has already cost this project a merge
 * that stamped a field it no longer merged — and a bridge that disagrees with
 * the store it fronts fails at the far end of an IPC call, where the type error
 * would have said so at build time.
 *
 * One call per user action. The store is a database and the renderer is a
 * separate process; a screen that calls across this boundary per row pays for
 * the crossing per row.
 */
export const aoide = {
    playlists: {
        /** Appends tracks. Returns the new entries only, not the whole playlist. */
        addTracks: (playlistId: string, tracks: TrackInput[]): Promise<PlaylistTrack[]> =>
            ipcRenderer.invoke('aoide:playlists-add-tracks', playlistId, tracks),

        create: (name: string, options?: CreatePlaylistOptions): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-create', name, options),

        /** Undefined when the playlist does not exist or has been deleted. */
        get: (playlistId: string): Promise<PlaylistSummary | undefined> =>
            ipcRenderer.invoke('aoide:playlists-get', playlistId),

        /**
         * Copies a Jellyfin playlist in, or refreshes the copy already here.
         * Matched on `sourceJellyfinId`; a name is never enough to match on.
         */
        importFromJellyfin: (request: ImportRequest): Promise<ImportResult> =>
            ipcRenderer.invoke('aoide:playlists-import', request),

        /** Live entries in order, joined to whatever this device has cached about each track. */
        items: (playlistId: string): Promise<PlaylistTrack[]> =>
            ipcRenderer.invoke('aoide:playlists-items', playlistId),

        list: (): Promise<PlaylistSummary[]> => ipcRenderer.invoke('aoide:playlists-list'),

        /**
         * Drag-to-reorder. Returns the one entry that moved — a reorder writes
         * exactly one row, and sending a long playlist back after every drag
         * would undo the point of that.
         */
        moveItem: (itemId: string, target: MoveTarget): Promise<PlaylistTrack> =>
            ipcRenderer.invoke('aoide:playlists-move-item', itemId, target),

        /** Soft-deletes the playlist and its entries. The rows stay; they have to. */
        remove: (playlistId: string): Promise<void> =>
            ipcRenderer.invoke('aoide:playlists-remove', playlistId),

        removeItem: (itemId: string): Promise<void> =>
            ipcRenderer.invoke('aoide:playlists-remove-item', itemId),

        rename: (playlistId: string, name: string): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-rename', playlistId, name),

        setNotes: (playlistId: string, notes: null | string): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-set-notes', playlistId, notes),
    },
};

export type AoideApi = typeof aoide;
