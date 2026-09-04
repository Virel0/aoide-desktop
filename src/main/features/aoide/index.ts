import type { SmartRules } from '/@/shared/aoide/smart-rules';
import type { SyncOp } from '/@/shared/aoide/sync-types';

import { app, ipcMain } from 'electron';
import { join } from 'path';

import type { FinishPlayInput, PlaySource } from './play-history';
import type { CreatePlaylistOptions, ImportRequest, MoveTarget, TrackInput } from './playlists';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { ImageBlobStore } from './image-blobs';
import { Mix } from './mix';
import { registerTrimHandlers } from './mpv-trim';
import { PlayHistory } from './play-history';
import { registerPlaylistImportHandlers } from './playlist-import';
import { contentKeyFor, Playlists } from './playlists';
import { registerSmartSearchHandlers } from './smart-search';
import { TrackFlags } from './track-flags';

import log from '/@/main/logger';

/**
 * The curation store's one owner, and the renderer's way in.
 *
 * **The database lives in the main process.** One owner means no cross-process
 * locking to get wrong, and it means sync keeps working regardless of which
 * window is alive — a store opened per renderer would stop syncing the moment
 * somebody closed a window, and would do it silently.
 *
 * The renderer therefore talks to it over IPC, and the surface is deliberately
 * coarse: one call per user action, never one per row. A channel that a list
 * screen calls once per playlist is how this becomes slow, and the slowness
 * arrives with the user's library rather than with ours.
 */
export interface Curation {
    database: CurationDatabase;
    flags: TrackFlags;
    history: PlayHistory;
    images: ImageBlobStore;
    mix: Mix;
    playlists: Playlists;
    store: CurationStore;
}

/**
 * Obviously Aoide's, and obviously not Feishin's.
 *
 * This fork shares a machine with upstream Feishin — that is why it was renamed
 * before anything was built — so anything it writes under userData says whose it
 * is. WAL leaves `-wal` and `-shm` siblings next to it.
 */
export const CURATION_DATABASE_FILE = 'aoide-curation.db';

/**
 * Close the store, once, on the way out. Safe to call when it was never opened.
 *
 * Not every exit route reaches this — `app.exit()`, which the quit hotkey takes,
 * skips `before-quit` entirely — and that is survivable rather than ignored:
 * every write here commits synchronously inside `record`, so an unclosed
 * database leaves nothing but a WAL file that SQLite recovers on the next open.
 */
export const closeCuration = (): void => {
    if (!opened) return;

    opened.database.close();
    opened = null;
    log.info('Aoide curation store closed');
};

/**
 * The store, opened on first use.
 *
 * Lazily, and that is not merely tidiness: `app.getPath('userData')` is only
 * correct after `src/main/index.ts` has had the chance to redirect it to the
 * `-dev` suffixed copy, and that line runs *after* the imports which reach this
 * module. Reading the path at import time would put a development build's
 * playlists in the release build's library, where they would sync.
 */
export const curation = (): Curation => {
    if (opened) return opened;

    const path = join(app.getPath('userData'), CURATION_DATABASE_FILE);
    const database = openCurationDatabase(path);
    const store = new CurationStore(database);

    opened = {
        database,
        flags: new TrackFlags(database, store),
        history: new PlayHistory(database, store),
        images: new ImageBlobStore(database),
        mix: new Mix(database),
        playlists: new Playlists(database, store),
        store,
    };
    log.info('Aoide curation store opened', { device: store.device, path });

    return opened;
};

let opened: Curation | null = null;

/**
 * Report what actually went wrong, then hand it on.
 *
 * `ipcMain.handle` turns a throw into a rejected promise in the renderer and
 * loses nothing, but the main process is where the SQLite message is legible —
 * and three faults on this project were diagnosed only after somebody read the
 * server's own words instead of a summary of them. The renderer still gets the
 * error; this only makes sure it is written down too.
 */
const handle = <T extends unknown[], R>(
    channel: string,
    work: (curation: Curation, ...args: T) => R,
): void => {
    ipcMain.handle(channel, (_event, ...args: T) => {
        try {
            return work(curation(), ...args);
        } catch (error) {
            log.error(`Aoide ${channel} failed`, error);
            throw error;
        }
    });
};

handle('aoide:playlists-list', ({ playlists }) => playlists.list());

handle('aoide:playlists-get', ({ playlists }, playlistId: string) => playlists.get(playlistId));

handle('aoide:playlists-items', ({ playlists }, playlistId: string) => playlists.items(playlistId));

handle('aoide:playlists-cache-tracks', ({ playlists }, tracks: TrackInput[]) =>
    playlists.cacheTracks(tracks),
);

handle('aoide:playlists-create', ({ playlists }, name: string, options?: CreatePlaylistOptions) =>
    playlists.create(name, options),
);

handle('aoide:playlists-rename', ({ playlists }, playlistId: string, name: string) =>
    playlists.rename(playlistId, name),
);

handle(
    'aoide:playlists-set-smart-rules',
    ({ playlists }, playlistId: string, smartRules: null | string) =>
        playlists.setSmartRules(playlistId, smartRules),
);

handle('aoide:playlists-set-notes', ({ playlists }, playlistId: string, notes: null | string) =>
    playlists.setNotes(playlistId, notes),
);

handle(
    'aoide:playlists-set-artwork',
    ({ playlists }, playlistId: string, artworkItemId: null | string) =>
        playlists.setArtwork(playlistId, artworkItemId),
);

handle('aoide:playlists-remove', ({ playlists }, playlistId: string) => {
    playlists.remove(playlistId);
});

handle('aoide:playlists-add-tracks', ({ playlists }, playlistId: string, tracks: TrackInput[]) =>
    playlists.addTracks(playlistId, tracks),
);

handle('aoide:playlists-remove-item', ({ playlists }, itemId: string) => {
    playlists.removeItem(itemId);
});

handle('aoide:playlists-move-item', ({ playlists }, itemId: string, target: MoveTarget) =>
    playlists.moveItem(itemId, target),
);

handle('aoide:playlists-import', ({ playlists }, request: ImportRequest) =>
    playlists.importFromJellyfin(request),
);

/**
 * The built-in playlists, on demand. Startup below already does this once the
 * store is open; the channel exists so a renderer that has reason to ask again
 * — a sign-in, a screen that lists them — can, at the cost of nothing when the
 * rows are already there.
 */
handle('aoide:playlists-ensure-built-ins', ({ playlists }) => playlists.ensureBuiltIns());

// Opened at startup rather than waiting for the first screen, so a schema this
// build cannot understand — the one thing `migrate` refuses outright — is a line
// in the log at launch instead of a broken playlist screen ten minutes later.
//
// The built-ins are made right after, in the same chain: the store is one per
// machine rather than per account, so nothing about the user has to be known
// first — only that the database opened. A store that failed to open never
// reaches this line, and the catch below says why.
app.whenReady()
    .then(() => curation())
    .then(({ playlists }) => {
        const created = playlists.ensureBuiltIns();
        if (created.length > 0) log.info('Aoide built-in playlists created', { created });
    })
    .catch((error) => log.error('Aoide curation store failed to open or seed', error));

app.on('before-quit', closeCuration);

/*
 * The op log, published so the renderer's sync engine has something to push.
 *
 * Without these the engine cannot be built at all: `aoideSyncStore` looks for
 * `window.api.aoide.sync` and finds nothing, so "Sync Now" falls back to a bare
 * reachability check and the panel says so. Every local edit sits in the log
 * unpushed and nothing from any other device arrives.
 *
 * Coarse on purpose — one call per step of the loop, never per row. The engine
 * makes a handful of these per sync, not one per playlist.
 */

handle('aoide:sync-device-id', ({ store }) => store.device);

handle('aoide:sync-pending-ops', ({ store }, limit?: number, holding?: string[]) =>
    store.pendingOps(limit, holding),
);

handle('aoide:sync-mark-synced', ({ store }, opIds: string[]) => store.markSynced(opIds));

handle('aoide:sync-quarantine', ({ store }, opId: string, reason: string) =>
    store.quarantine(opId, reason),
);

handle('aoide:sync-cursor', ({ store }) => store.cursor);

/**
 * Apply one inbound op. The renderer advances the cursor separately, after the
 * whole batch, which is what the contract asks for.
 *
 * Per op rather than per batch, because that is the shape `SyncStore` declares
 * and an adapter that buffered ops in the renderer to fake a batch call would be
 * a second place where the ordering rule lives. Interruption is already safe:
 * the cursor moves only after a batch applies, and applying an op twice is a
 * no-op, so a sync that dies half way replays rather than skips.
 */
handle('aoide:sync-apply-remote', ({ store }, op: SyncOp, receivedAt?: number) =>
    store.applyRemote(op, receivedAt),
);

handle('aoide:sync-set-cursor', ({ store }, cursor: number) => store.setCursor(cursor));

/*
 * Cover bytes, by hash.
 *
 * Content-addressed, so a hash that resolves here is the right picture forever
 * and the renderer can cache it without any invalidation story at all. Missing
 * is an ordinary answer rather than an error: a cover chosen on the phone lives
 * on the sidecar until this device has reason to fetch it, and "reason" means
 * something is about to draw it.
 */
handle('aoide:images-get', ({ images }, sha256: string) => images.get(sha256));

/** Keep bytes fetched from the sidecar, so the next draw needs no network. */
handle('aoide:images-store', ({ images }, bytes: Uint8Array, mime: string) =>
    images.store(bytes, mime),
);

handle('aoide:sync-images-to-upload', ({ images }, ops: SyncOp[]) =>
    images
        .imagesNeededBeforePush(ops)
        .map((blob) => {
            const held = images.get(blob.sha256);
            return held ? { bytes: held.bytes, mime: held.mime, sha256: blob.sha256 } : undefined;
        })
        // A hash the log names and this device does not hold cannot be uploaded
        // from here. Dropping it lets the rest of the push proceed; the op
        // naming it waits, which is what the contract asks for.
        .filter((image) => image !== undefined),
);

handle('aoide:sync-mark-uploaded', ({ images }, sha256: string) => images.markUploaded(sha256));

registerSmartSearchHandlers();
registerPlaylistImportHandlers();
registerTrimHandlers();

/**
 * Narrow a mix's candidates by what has actually been listened to.
 *
 * The renderer brings candidates from Jellyfin, which answers the library half
 * of a rule set exactly. This answers the half only the curation store knows —
 * and knows honestly, because Jellyfin counts a four-second skip as a play.
 */
/*
 * This device's queue, written as an op so it reaches the others.
 *
 * One row per device, replaced whole — the sidecar compacts superseded rows on
 * push, so saving often costs nothing and the log does not grow. Saving *rarely*
 * is what costs: a handover offers whatever was last written, so a queue saved
 * only on quit is a queue that is wrong every time somebody actually reaches for
 * their other machine.
 */
handle(
    'aoide:queue-save',
    ({ store }, deviceName: string, trackIds: string[], position: number, elapsedMs: number) => {
        store.record('queue_state', {
            deviceId: store.device,
            deviceName,
            elapsedMs: Math.max(0, Math.trunc(elapsedMs)),
            position: Math.max(0, Math.trunc(position)),
            // Capped for the same reason the phone caps it: a queue is a thing
            // somebody is listening to, not an export of their library, and a
            // payload has a ceiling.
            trackIds: JSON.stringify(trackIds.slice(0, MAX_QUEUE_TRACKS)),
        });
    },
);

/**
 * Other devices' queues as this device last saw them.
 *
 * The fallback for when the sidecar cannot be reached: these rows arrived
 * through the ordinary op log, so a handover still works offline — just with
 * whatever the last sync brought, and ordered by the writing device's clock
 * rather than the server's.
 */
handle('aoide:queue-others', ({ store }) =>
    store
        .live('queue_state')
        .filter((row) => row.deviceId !== store.device)
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)),
);

handle('aoide:mix-narrow', ({ mix }, candidateIds: string[], rules: SmartRules) =>
    mix.narrow(candidateIds, rules),
);

/**
 * Listening over a window, summarised for the Replay screen. One query set per
 * period change, never per row — the leaderboards come back whole.
 */
handle('aoide:history-recap', ({ history }, from: number, to: number) => history.recap(from, to));

/**
 * A listen starting at this desk. The track goes into the cache first, so the
 * Replay page can file the play under its artist and album rather than
 * reporting it unattributed — this is the one moment the desktop knows for
 * certain what it is playing.
 */
handle(
    'aoide:history-begin-play',
    ({ history, playlists }, track: TrackInput, source: PlaySource, startedAt: number) => {
        playlists.cacheTracks([track]);
        return history.beginPlay({
            album: track.album,
            artist: track.artist,
            durationMs: track.durationMs ?? null,
            jellyfinId: track.jellyfinId,
            source,
            startedAt,
            title: track.title,
        });
    },
);

handle('aoide:history-finish-play', ({ history }, eventId: string, input: FinishPlayInput) =>
    history.finishPlay(eventId, input),
);

/*
 * Taste flags. One call per user action; the one list call — which of these
 * candidates are hidden — takes the whole candidate list at once, because a
 * station asks it about a hundred tracks and must not cross the bridge a
 * hundred times to find out.
 */
handle('aoide:flags-get', ({ flags }, jellyfinId: string) => flags.flags(jellyfinId));

// The whole track rather than an id and a key: the row's content key is
// computed here from the same metadata the phone computes it from, and the
// track goes into the cache on the way so the settings list can name it.
handle(
    'aoide:flags-set-not-interested',
    ({ flags, playlists }, track: TrackInput, value: boolean) => {
        playlists.cacheTracks([track]);
        return flags.setNotInterested(
            track.jellyfinId,
            track.contentKey ?? contentKeyFor(track),
            value,
        );
    },
);

handle('aoide:flags-set-dont-count', ({ flags, playlists }, track: TrackInput, value: boolean) => {
    playlists.cacheTracks([track]);
    return flags.setDontCount(track.jellyfinId, track.contentKey ?? contentKeyFor(track), value);
});

handle('aoide:flags-clear', ({ flags }, jellyfinId: string) => flags.clear(jellyfinId));

handle('aoide:flags-flagged', ({ flags }) => flags.flagged());

// An array over the wire rather than the Set the class answers with: a plain
// list is what the renderer filters against, and it survives every serialiser.
handle('aoide:flags-not-interested-among', ({ flags }, jellyfinIds: string[]) => [
    ...flags.notInterestedAmong(jellyfinIds),
]);

/** The phone keeps 500; matching it keeps a handover the same size on both. */
const MAX_QUEUE_TRACKS = 500;
