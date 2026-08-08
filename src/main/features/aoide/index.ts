import { app, ipcMain } from 'electron';
import { join } from 'path';

import type { CreatePlaylistOptions, ImportRequest, MoveTarget, TrackInput } from './playlists';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { Playlists } from './playlists';

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

    opened = { database, playlists: new Playlists(database, store), store };
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

handle('aoide:playlists-create', ({ playlists }, name: string, options?: CreatePlaylistOptions) =>
    playlists.create(name, options),
);

handle('aoide:playlists-rename', ({ playlists }, playlistId: string, name: string) =>
    playlists.rename(playlistId, name),
);

handle('aoide:playlists-set-notes', ({ playlists }, playlistId: string, notes: null | string) =>
    playlists.setNotes(playlistId, notes),
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

// Opened at startup rather than waiting for the first screen, so a schema this
// build cannot understand — the one thing `migrate` refuses outright — is a line
// in the log at launch instead of a broken playlist screen ten minutes later.
app.whenReady()
    .then(() => curation())
    .catch((error) => log.error('Aoide curation store failed to open', error));

app.on('before-quit', closeCuration);
