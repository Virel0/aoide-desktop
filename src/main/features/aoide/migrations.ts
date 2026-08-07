import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order and recorded in SQLite's `user_version`.
 *
 * Append only. A migration that has shipped has run on a real database
 * somewhere; editing it in place means two devices disagree about what version
 * 3 was, and nothing afterwards notices.
 */
export const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
    // v1 — the curation store.
    (db) => {
        db.exec(`
            -- Local cache of what Jellyfin holds, rebuilt per device from that
            -- device's own connection. Deliberately NOT synced: keeping it out
            -- of the payload is what keeps a full history sync small.
            CREATE TABLE tracks (
                jellyfin_id    TEXT PRIMARY KEY,
                content_key    TEXT NOT NULL,
                musicbrainz_id TEXT,
                title          TEXT NOT NULL,
                artist         TEXT NOT NULL,
                album          TEXT NOT NULL,
                album_artist   TEXT,
                duration_ms    INTEGER,
                year           INTEGER,
                genres         TEXT,
                last_seen_at   INTEGER NOT NULL
            );
            CREATE INDEX idx_tracks_content_key ON tracks(content_key);
            CREATE INDEX idx_tracks_mbid ON tracks(musicbrainz_id);

            CREATE TABLE playlists (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                description   TEXT,
                folder_id     TEXT,
                is_smart      INTEGER NOT NULL DEFAULT 0,
                smart_rules   TEXT,
                sort_index    TEXT NOT NULL,
                image_hash    TEXT,
                image_mime    TEXT,
                updated_at    INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                origin_device TEXT NOT NULL
            );

            CREATE TABLE playlist_items (
                id            TEXT PRIMARY KEY,
                playlist_id   TEXT NOT NULL,
                jellyfin_id   TEXT NOT NULL,
                content_key   TEXT NOT NULL,
                -- A fractional index, not an integer. With integers, inserting
                -- at row 3 renumbers everything below it, so two devices
                -- inserting concurrently produce dozens of conflicting updates
                -- and last-writer-wins silently drops one of the inserts.
                position      TEXT NOT NULL,
                updated_at    INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                origin_device TEXT NOT NULL
            );
            CREATE INDEX idx_items_playlist ON playlist_items(playlist_id, position);

            CREATE TABLE folders (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                parent_id     TEXT,
                sort_index    TEXT NOT NULL,
                updated_at    INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                origin_device TEXT NOT NULL
            );

            CREATE TABLE likes (
                id            TEXT PRIMARY KEY,
                jellyfin_id   TEXT NOT NULL,
                content_key   TEXT NOT NULL,
                liked         INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                origin_device TEXT NOT NULL
            );
            CREATE UNIQUE INDEX idx_likes_item ON likes(jellyfin_id);

            -- Append-only. Never edited after insert, which makes it the
            -- easiest thing here to sync: there is no conflicting append.
            CREATE TABLE play_events (
                id            TEXT PRIMARY KEY,
                jellyfin_id   TEXT NOT NULL,
                content_key   TEXT NOT NULL,
                started_at    INTEGER NOT NULL,
                ended_at      INTEGER,
                ms_played     INTEGER NOT NULL,
                completed     INTEGER NOT NULL DEFAULT 0,
                skipped       INTEGER NOT NULL DEFAULT 0,
                source        TEXT,
                origin_device TEXT NOT NULL
            );
            CREATE INDEX idx_events_track ON play_events(jellyfin_id);
            CREATE INDEX idx_events_time ON play_events(started_at);

            -- One row per device. "Resume across devices" reads the most
            -- recently updated row belonging to a *different* device.
            CREATE TABLE queue_state (
                device_id     TEXT PRIMARY KEY,
                device_name   TEXT NOT NULL,
                track_ids     TEXT NOT NULL,
                position      INTEGER NOT NULL,
                elapsed_ms    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                origin_device TEXT NOT NULL
            );

            -- The outbound log. Every local mutation writes its table AND
            -- appends here, in one transaction.
            CREATE TABLE ops (
                op_id      TEXT PRIMARY KEY,
                entity     TEXT NOT NULL,
                entity_id  TEXT NOT NULL,
                operation  TEXT NOT NULL,
                payload    TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                synced     INTEGER NOT NULL DEFAULT 0
            );
            -- The pending-ops query is the hottest path in sync; it reads
            -- unsynced rows oldest first and nothing else.
            CREATE INDEX idx_ops_pending ON ops(synced, created_at);

            -- Ops the server refused, or that were isolated as the cause of a
            -- 5xx. Kept rather than deleted: an op that vanishes takes with it
            -- the only evidence of what went wrong.
            CREATE TABLE quarantined_ops (
                op_id      TEXT PRIMARY KEY,
                entity     TEXT NOT NULL,
                entity_id  TEXT NOT NULL,
                operation  TEXT NOT NULL,
                payload    TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                reason     TEXT,
                quarantined_at INTEGER NOT NULL
            );

            -- Which cover blobs this device holds, and whether the server has
            -- them. The ordering rule everything depends on — upload before
            -- pushing the op that names the hash — is enforced against this.
            CREATE TABLE image_blobs (
                sha256      TEXT PRIMARY KEY,
                mime        TEXT NOT NULL,
                bytes       BLOB NOT NULL,
                uploaded    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );

            CREATE TABLE sync_state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring a database up to `SCHEMA_VERSION`, running only what it has not seen. */
export const migrate = (db: DatabaseSync): number => {
    const current = Number(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );

    if (current > SCHEMA_VERSION) {
        // An older build opening a newer store. Refusing is the only safe move:
        // writing to a schema this build does not understand corrupts data the
        // newer build owns, and it would do so silently.
        throw new Error(
            `This library was written by a newer version of Aoide (schema ${current}, this build understands ${SCHEMA_VERSION}).`,
        );
    }

    for (let version = current; version < SCHEMA_VERSION; version += 1) {
        // Each migration is its own transaction, so a failure half way through
        // a chain leaves the database at the last version that fully applied
        // rather than somewhere between two.
        db.exec('BEGIN');
        try {
            MIGRATIONS[version](db);
            db.exec(`PRAGMA user_version = ${version + 1}`);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    return SCHEMA_VERSION;
};
