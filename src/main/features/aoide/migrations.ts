import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order and recorded in SQLite's `user_version`.
 *
 * Append only. A migration that has shipped has run on a real database
 * somewhere; editing it in place means two devices disagree about what version
 * 3 was, and nothing afterwards notices.
 *
 * ---
 *
 * **Table names are local. Column names travel.** That asymmetry decides every
 * spelling below and is not a style choice.
 *
 * A payload is the row: both clients build an op's payload by encoding the
 * record they just wrote, so the payload's *keys are its column names*, and a
 * receiver writes those keys straight back into columns of the same name. Two
 * clients whose columns disagree therefore cannot exchange a single row — the
 * fields simply do not land, and the ones that are NOT NULL take the write down
 * with them. So the columns here are the phone's, verbatim: camelCase, matching
 * `CurationKit/Schema.swift` migrations v1 through v7.
 *
 * The table names are not the phone's, and deliberately: they are plural
 * snake_case here to match the sidecar's entity allow-list, which is matched
 * strictly and rejects anything else. iOS goes the other way — singular
 * camelCase tables translated at the wire boundary — because its tables predate
 * that allow-list. Both are correct. A table name never appears in a payload,
 * so nothing forces the two schemas to agree on one.
 *
 * The four tables at the bottom — `ops`, `quarantined_ops`, `image_blobs`,
 * `sync_state` — keep snake_case for the same reason, read the other way: their
 * rows are never encoded into a payload and never leave this device, so no
 * other client ever sees these names and there is nothing to agree with.
 */
export const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
    // v1 — the curation store.
    (db) => {
        db.exec(`
            -- Local cache of what Jellyfin holds, rebuilt per device from that
            -- device's own connection. Deliberately NOT synced: keeping it out
            -- of the payload is what keeps a full history sync small.
            --
            -- Its columns match the phone anyway, unlike the local tables below,
            -- because the shared play/skip SQL in play-definition.ts is
            -- interpolated against them character for character on both clients.
            CREATE TABLE tracks (
                jellyfinId     TEXT PRIMARY KEY,
                contentKey     TEXT NOT NULL,
                musicbrainzId  TEXT,
                title          TEXT NOT NULL,
                artist         TEXT NOT NULL,
                album          TEXT NOT NULL,
                albumArtist    TEXT,
                durationMs     INTEGER,
                year           INTEGER,
                genres         TEXT NOT NULL DEFAULT '[]',
                lastSeenAt     INTEGER NOT NULL,
                -- The album a cached track belongs to, so a playlist with no
                -- cover of its own can be drawn from the albums it holds. Null
                -- means "not seen since this column existed" and fills in on
                -- the next index; the cache is rebuilt from Jellyfin anyway.
                albumId        TEXT
            );
            CREATE INDEX idx_tracks_content_key ON tracks(contentKey);
            CREATE INDEX idx_tracks_mbid ON tracks(musicbrainzId);

            CREATE TABLE playlists (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                -- The prose field is 'notes', not 'description'. It is what the
                -- phone calls it, and the phone's name is the one that travels.
                notes         TEXT,
                folderId      TEXT,
                isSmart       INTEGER NOT NULL DEFAULT 0,
                smartRules    TEXT,
                sortIndex     TEXT NOT NULL,
                imageHash     TEXT,
                imageMime     TEXT,
                -- Which Jellyfin playlist this was imported from, if any. Kept
                -- so a second import refreshes the same local playlist instead
                -- of silently making a duplicate, and so a server listing can
                -- say which of its playlists are already here.
                sourceJellyfinId TEXT,
                -- A Jellyfin item id whose Primary image is this playlist's
                -- cover — never image bytes. The op log replays in full onto
                -- every fresh device and payloads cap at 256 KB, so a cover
                -- stored as data would be the largest thing in the system and
                -- would be copied forever. An id resolves against a server both
                -- devices already talk to.
                artworkItemId TEXT,
                updatedAt     INTEGER NOT NULL,
                -- Per-field last-writer-wins stamps, JSON, null when they say
                -- nothing beyond updatedAt. Two devices editing the name and
                -- the notes of one playlist must both win.
                fieldUpdatedAt TEXT,
                deleted       INTEGER NOT NULL DEFAULT 0,
                originDevice  TEXT NOT NULL
            );
            CREATE INDEX idx_playlists_folder ON playlists(folderId);
            CREATE INDEX idx_playlists_source ON playlists(sourceJellyfinId);

            CREATE TABLE playlist_items (
                id            TEXT PRIMARY KEY,
                playlistId    TEXT NOT NULL,
                jellyfinId    TEXT NOT NULL,
                contentKey    TEXT NOT NULL,
                -- A fractional index, not an integer. With integers, inserting
                -- at row 3 renumbers everything below it, so two devices
                -- inserting concurrently produce dozens of conflicting updates
                -- and last-writer-wins silently drops one of the inserts.
                position      TEXT NOT NULL,
                updatedAt     INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                originDevice  TEXT NOT NULL
            );
            CREATE INDEX idx_items_playlist ON playlist_items(playlistId, position);

            CREATE TABLE folders (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                parentId      TEXT,
                sortIndex     TEXT NOT NULL,
                updatedAt     INTEGER NOT NULL,
                fieldUpdatedAt TEXT,
                deleted       INTEGER NOT NULL DEFAULT 0,
                originDevice  TEXT NOT NULL
            );
            CREATE INDEX idx_folders_parent ON folders(parentId);

            CREATE TABLE likes (
                id            TEXT PRIMARY KEY,
                jellyfinId    TEXT NOT NULL,
                contentKey    TEXT NOT NULL,
                liked         INTEGER NOT NULL,
                updatedAt     INTEGER NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                originDevice  TEXT NOT NULL
            );
            CREATE UNIQUE INDEX idx_likes_item ON likes(jellyfinId);

            -- Append-only. Never edited after insert, which makes it the
            -- easiest thing here to sync: there is no conflicting append.
            CREATE TABLE play_events (
                id            TEXT PRIMARY KEY,
                jellyfinId    TEXT NOT NULL,
                contentKey    TEXT NOT NULL,
                startedAt     INTEGER NOT NULL,
                endedAt       INTEGER,
                msPlayed      INTEGER NOT NULL,
                completed     INTEGER NOT NULL DEFAULT 0,
                skipped       INTEGER NOT NULL DEFAULT 0,
                source        TEXT,
                originDevice  TEXT NOT NULL
            );
            CREATE INDEX idx_events_track ON play_events(jellyfinId);
            CREATE INDEX idx_events_time ON play_events(startedAt);

            -- One row per device. "Resume across devices" reads the most
            -- recently updated row belonging to a *different* device.
            CREATE TABLE queue_state (
                deviceId      TEXT PRIMARY KEY,
                deviceName    TEXT NOT NULL,
                trackIds      TEXT NOT NULL,
                position      INTEGER NOT NULL,
                elapsedMs     INTEGER NOT NULL,
                updatedAt     INTEGER NOT NULL,
                originDevice  TEXT NOT NULL
            );

            -- Everything below this line is local infrastructure, and stays
            -- snake_case for a reason rather than by oversight: none of these
            -- rows is ever encoded into a payload, so no other client ever sees
            -- these names and there is no second schema to agree with. The
            -- payload column here holds somebody else's row; it is opaque text
            -- to this table.

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
