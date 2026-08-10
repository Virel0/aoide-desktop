import type {
    CreatePlaylistOptions,
    ImportRequest,
    ImportResult,
    MoveTarget,
    PlaylistSummary,
    PlaylistTrack,
    TrackInput,
} from '/@/main/features/aoide/playlists';
import type { OpenRouterModel, SmartSearchOutcome } from '/@/main/features/aoide/smart-search';
import type { SyncOp } from '/@/shared/aoide/sync-types';

import { ipcRenderer } from 'electron';

/** Mirrors `SyncEngine`'s `OutboundImage`, which the renderer cannot import here. */
interface OutboundImage {
    bytes: Uint8Array;
    mime: string;
    sha256: string;
}

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
    images: {
        get: (sha256: string): Promise<undefined | { bytes: Uint8Array; mime: string }> =>
            ipcRenderer.invoke('aoide:images-get', sha256),

        store: (bytes: Uint8Array, mime: string): Promise<string> =>
            ipcRenderer.invoke('aoide:images-store', bytes, mime),
    },

    playlists: {
        /** Appends tracks. Returns the new entries only, not the whole playlist. */
        addTracks: (playlistId: string, tracks: TrackInput[]): Promise<PlaylistTrack[]> =>
            ipcRenderer.invoke('aoide:playlists-add-tracks', playlistId, tracks),

        cacheTracks: (tracks: TrackInput[]): Promise<void> =>
            ipcRenderer.invoke('aoide:playlists-cache-tracks', tracks),

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

    /**
     * Natural-language search.
     *
     * There is no `getKey`, and that is the point: the OpenRouter key stays in
     * the main process, so nothing running in the renderer — including anything
     * that gets there by accident — can read it. `isConfigured` answers whether
     * one is set, because a settings screen has to say.
     */
    smartSearch: {
        isConfigured: (): Promise<boolean> => ipcRenderer.invoke('aoide:smart-search-configured'),

        listModels: (): Promise<OpenRouterModel[]> =>
            ipcRenderer.invoke('aoide:smart-search-list-models'),

        model: (): Promise<string> => ipcRenderer.invoke('aoide:smart-search-model'),

        setKey: (key: string): Promise<boolean> =>
            ipcRenderer.invoke('aoide:smart-search-set-key', key),

        setModel: (model: string): Promise<void> =>
            ipcRenderer.invoke('aoide:smart-search-set-model', model),

        translate: (phrase: string, genres: string[]): Promise<SmartSearchOutcome> =>
            ipcRenderer.invoke('aoide:smart-search-translate', phrase, genres),
    },

    /**
     * The op log, as `SyncEngine`'s `SyncStore` wants it.
     *
     * Written against that interface deliberately rather than given a shape of
     * its own: `SyncStore` is already the contract the engine consumes, every
     * member of it allows a promise precisely so an IPC bridge can satisfy it,
     * and a second definition here would be another pair of sets that must
     * agree — which this project has paid for twice already.
     */
    sync: {
        applyRemote: (op: SyncOp, receivedAt?: number): Promise<'applied' | 'ignored'> =>
            ipcRenderer.invoke('aoide:sync-apply-remote', op, receivedAt),

        cursor: (): Promise<number> => ipcRenderer.invoke('aoide:sync-cursor'),

        deviceId: (): Promise<string> => ipcRenderer.invoke('aoide:sync-device-id'),

        imagesToUpload: (ops: SyncOp[]): Promise<OutboundImage[]> =>
            ipcRenderer.invoke('aoide:sync-images-to-upload', ops),

        markSynced: (opIds: string[]): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-mark-synced', opIds),

        markUploaded: (sha256: string): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-mark-uploaded', sha256),

        pendingOps: (limit?: number): Promise<SyncOp[]> =>
            ipcRenderer.invoke('aoide:sync-pending-ops', limit),

        quarantine: (opId: string, reason: string): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-quarantine', opId, reason),

        setCursor: (cursor: number): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-set-cursor', cursor),
    },
};

export type AoideApi = typeof aoide;
