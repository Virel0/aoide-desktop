import type {
    FinishPlayInput,
    FinishPlayOutcome,
    PlaySource,
    Recap,
} from '/@/main/features/aoide/play-history';
import type { CapturedCsv, SpotifyFetchOutcome } from '/@/main/features/aoide/playlist-import';
import type {
    CreatePlaylistOptions,
    ImportRequest,
    ImportResult,
    MoveTarget,
    PlaylistSummary,
    PlaylistTrack,
    TrackInput,
} from '/@/main/features/aoide/playlists';
import type {
    MixOutcome,
    OpenRouterModel,
    SmartSearchOutcome,
} from '/@/main/features/aoide/smart-search';
import type { FlaggedTrack, TrackFlagRow } from '/@/main/features/aoide/track-flags';
import type { FinishCounts } from '/@/shared/aoide/finish-rate';
import type { SmartRules } from '/@/shared/aoide/smart-rules';
import type { SyncOp } from '/@/shared/aoide/sync-types';
import type { TrimPlan } from '/@/shared/aoide/trim-plan';

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
    /**
     * Taste flags — "not interested" and "don't count plays" — per track.
     * Written as ops, so they reach the phone; read here for menus, for the
     * settings list, and to drop hidden tracks from a station before it plays.
     */
    flags: {
        /** Both flags off, as one write. */
        clear: (jellyfinId: string): Promise<void> =>
            ipcRenderer.invoke('aoide:flags-clear', jellyfinId),

        /** Every flagged track, newest first, with what the cache knows of it. */
        flagged: (): Promise<FlaggedTrack[]> => ipcRenderer.invoke('aoide:flags-flagged'),

        /** Undefined when nothing has been said about the track. */
        get: (jellyfinId: string): Promise<TrackFlagRow | undefined> =>
            ipcRenderer.invoke('aoide:flags-get', jellyfinId),

        /** Which of these ids are marked not interested. One call for the whole list. */
        notInterestedAmong: (jellyfinIds: string[]): Promise<string[]> =>
            ipcRenderer.invoke('aoide:flags-not-interested-among', jellyfinIds),

        /** The whole track: it is cached on the way, and its content key is computed there. */
        setDontCount: (track: TrackInput, value: boolean): Promise<TrackFlagRow | undefined> =>
            ipcRenderer.invoke('aoide:flags-set-dont-count', track, value),

        setNotInterested: (track: TrackInput, value: boolean): Promise<TrackFlagRow | undefined> =>
            ipcRenderer.invoke('aoide:flags-set-not-interested', track, value),
    },

    /** Listening history: recorded and aggregated in the main process where the events live. */
    history: {
        /**
         * A track has started. Resolves to the event id, which `finishPlay`
         * takes back; the track is cached on the way so the play has an artist
         * and album to be filed under. Null for a track flagged "don't count":
         * nothing was opened, so there is nothing to finish.
         */
        beginPlay: (
            track: TrackInput,
            source: PlaySource,
            startedAt: number,
        ): Promise<null | string> =>
            ipcRenderer.invoke('aoide:history-begin-play', track, source, startedAt),

        /** The track ended or was left. Finishing twice is a no-op. */
        finishPlay: (eventId: string, input: FinishPlayInput): Promise<FinishPlayOutcome> =>
            ipcRenderer.invoke('aoide:history-finish-play', eventId, input),

        /**
         * Everything by one artist, as one pair of counts. Answered from the
         * local track cache by name, because an artist page holds albums rather
         * than track ids.
         */
        finishRateForArtist: (artist: string): Promise<FinishCounts> =>
            ipcRenderer.invoke('aoide:history-finish-rate-artist', artist),

        /**
         * Starts and finishes per track — raw counts, so a page holding a whole
         * album can add them up itself instead of asking twice. One call for the
         * whole list; `finish-rate.ts` turns the counts into the figure.
         */
        finishRates: (jellyfinIds: string[]): Promise<Record<string, FinishCounts>> =>
            ipcRenderer.invoke('aoide:history-finish-rates', jellyfinIds),

        /** Plays over `[from, to)`, as the Replay screen shows them. */
        recap: (from: number, to: number): Promise<Recap> =>
            ipcRenderer.invoke('aoide:history-recap', from, to),
    },

    images: {
        get: (sha256: string): Promise<undefined | { bytes: Uint8Array; mime: string }> =>
            ipcRenderer.invoke('aoide:images-get', sha256),

        store: (bytes: Uint8Array, mime: string): Promise<string> =>
            ipcRenderer.invoke('aoide:images-store', bytes, mime),
    },

    /**
     * A playlist from somewhere else. Only the Spotify page needs the main
     * process — a CSV export is a file the renderer can read itself.
     */
    import: {
        /** A CSV that Exportify, opened by `openExportify`, has just saved. */
        onCsv: (cb: (file: CapturedCsv) => void): (() => void) => {
            const listener = (_event: Electron.IpcRendererEvent, file: CapturedCsv) => cb(file);
            ipcRenderer.on('aoide:import-csv', listener);
            return () => ipcRenderer.removeListener('aoide:import-csv', listener);
        },

        openExportify: (): Promise<void> => ipcRenderer.invoke('aoide:import-open-exportify'),

        spotify: (link: string): Promise<SpotifyFetchOutcome> =>
            ipcRenderer.invoke('aoide:import-spotify', link),
    },

    mix: {
        describe: (description: string, genres: string[]): Promise<MixOutcome> =>
            ipcRenderer.invoke('aoide:mix-describe', description, genres),

        narrow: (candidateIds: string[], rules: SmartRules): Promise<string[]> =>
            ipcRenderer.invoke('aoide:mix-narrow', candidateIds, rules),
    },

    playlists: {
        /** Appends tracks. Returns the new entries only, not the whole playlist. */
        addTracks: (playlistId: string, tracks: TrackInput[]): Promise<PlaylistTrack[]> =>
            ipcRenderer.invoke('aoide:playlists-add-tracks', playlistId, tracks),

        cacheTracks: (tracks: TrackInput[]): Promise<void> =>
            ipcRenderer.invoke('aoide:playlists-cache-tracks', tracks),

        create: (name: string, options?: CreatePlaylistOptions): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-create', name, options),

        /**
         * Create whichever built-in playlists have never existed here. Main
         * does this at startup; resolves to the ids created by this call.
         */
        ensureBuiltIns: (): Promise<string[]> =>
            ipcRenderer.invoke('aoide:playlists-ensure-built-ins'),

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

        /** Artwork only — never provenance. See `Playlists.setArtwork`. */
        setArtwork: (playlistId: string, artworkItemId: null | string): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-set-artwork', playlistId, artworkItemId),

        setNotes: (playlistId: string, notes: null | string): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-set-notes', playlistId, notes),

        setSmartRules: (playlistId: string, smartRules: null | string): Promise<PlaylistSummary> =>
            ipcRenderer.invoke('aoide:playlists-set-smart-rules', playlistId, smartRules),
    },

    queue: {
        others: (): Promise<Array<Record<string, unknown>>> =>
            ipcRenderer.invoke('aoide:queue-others'),

        save: (
            deviceName: string,
            trackIds: string[],
            position: number,
            elapsedMs: number,
        ): Promise<void> =>
            ipcRenderer.invoke('aoide:queue-save', deviceName, trackIds, position, elapsedMs),
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

        /** `holding` names entities to leave out of the page — see `SyncStore`. */
        pendingOps: (limit?: number, holding?: string[]): Promise<SyncOp[]> =>
            ipcRenderer.invoke('aoide:sync-pending-ops', limit, holding),

        quarantine: (opId: string, reason: string): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-quarantine', opId, reason),

        setCursor: (cursor: number): Promise<void> =>
            ipcRenderer.invoke('aoide:sync-set-cursor', cursor),
    },

    /**
     * Silence trimming for the mpv backend, which loads files in the main
     * process and so has to be told each track's plan before the load. Fire
     * and forget: a plan that arrives late is a plan for next time.
     */
    trim: {
        /** Every known plan is dropped; the next load is untrimmed. */
        forget: (): void => ipcRenderer.send('aoide:trim-forget'),

        /** Plans by Jellyfin id. `null` forgets one — "measured, nothing to trim". */
        remember: (plans: Record<string, null | TrimPlan>): void =>
            ipcRenderer.send('aoide:trim-remember', plans),
    },
};

export type AoideApi = typeof aoide;
