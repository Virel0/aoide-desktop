import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './migrations';

/**
 * `node:sqlite`, not `better-sqlite3`.
 *
 * Electron 41 ships Node 24.15, which has SQLite built in (verified, not
 * assumed). That removes a native dependency that would otherwise have to be
 * rebuilt against Electron's ABI for every version and architecture — an extra
 * step in the PKGBUILD, in the AppImage, and in anyone else's checkout, in
 * exchange for nothing this store needs.
 */
export interface CurationDatabase {
    close: () => void;
    db: DatabaseSync;
    deviceId: string;
}

export const DEVICE_ID_KEY = 'device_id';
export const SERVER_CURSOR_KEY = 'server_cursor';

/**
 * Open (or create) the store and bring its schema up to date.
 *
 * `path` is a file path, or `:memory:` in tests.
 */
export const openCurationDatabase = (path: string): CurationDatabase => {
    const db = new DatabaseSync(path);

    // WAL so a long read cannot block a write. Sync happens while somebody is
    // looking at a playlist, and a store that stutters during sync would be
    // blamed on playback.
    if (path !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL');
    }
    // NORMAL rather than FULL: with WAL this is durable across application
    // crashes, and only risks the last transactions in an OS-level crash. For
    // listening history that trade is obviously right.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    // A write should wait for a concurrent one rather than failing the caller.
    db.exec('PRAGMA busy_timeout = 5000');

    migrate(db);

    return { close: () => db.close(), db, deviceId: ensureDeviceId(db) };
};

/**
 * This device's identity, minted once and never changed.
 *
 * It is the tiebreak when two clocks agree, so it has to be stable: a device
 * that re-mints its id looks like a new device to every conflict resolution
 * that has already happened, and can lose to its own past self.
 */
const ensureDeviceId = (db: DatabaseSync): string => {
    const existing = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(DEVICE_ID_KEY) as
        | undefined
        | { value: string };

    if (existing?.value) return existing.value;

    const deviceId = randomUUID();
    db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(DEVICE_ID_KEY, deviceId);
    return deviceId;
};
