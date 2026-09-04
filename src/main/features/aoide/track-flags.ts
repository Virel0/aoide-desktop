import type { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'node:crypto';

import type { CurationStore } from './curation-store';
import type { CurationDatabase } from './database';

import { MAX_PARAMETERS } from './play-history';

/**
 * Taste flags: the two things a listener can say about a track that are not
 * "I like it".
 *
 * `notInterested` keeps a track out of mixes, stations, shuffle and every
 * smart-playlist result. It stays playable and stays in ordinary playlists —
 * the flag is about what the app *offers*, never about what the person asks
 * for. `dontCount` stops new plays being recorded: a lullaby on repeat, a
 * track a child plays, anything that would otherwise write a listening history
 * that is not the listener's. Existing history is untouched, including plays
 * another device recorded before it saw the flag, so evaluation reads the flag
 * and never assumes the events do not exist.
 *
 * One row per track, the phone's `TrackFlags` on the same wire. Both flags on
 * one row rather than one row per flag, merged per field like a playlist so
 * that each flag keeps its own latest write; a row on which neither is set is
 * recorded as a delete rather than kept — a row that says nothing is not
 * worth syncing — and a flag set again later reuses the row's id, so the
 * other devices see one row change rather than a delete and a stranger.
 */

/** A flagged track as the settings list shows it: the flags, and what the cache knows. */
export interface FlaggedTrack extends TrackFlagRow {
    /** Null when this device has never cached the track. */
    album: null | string;
    artist: null | string;
    title: null | string;
}

export interface TrackFlagRow {
    contentKey: string;
    dontCount: boolean;
    id: string;
    jellyfinId: string;
    notInterested: boolean;
    updatedAt: number;
}

export class TrackFlags {
    private readonly db: DatabaseSync;

    private readonly store: CurationStore;

    constructor(database: CurationDatabase, store: CurationStore) {
        this.db = database.db;
        this.store = store;
    }

    /**
     * Take both flags off a track in one write.
     *
     * One op rather than two: the row ends deleted either way, and the settings
     * list that offers this shows one track with one button.
     */
    clear(jellyfinId: string): void {
        const row = this.rowFor(jellyfinId);
        if (!row || Number(row.deleted) !== 0) return;
        this.write(row, { dontCount: false, notInterested: false });
    }

    /**
     * Every live flagged row, newest first, with what the track cache knows.
     *
     * A track flagged on the phone that this device has never cached comes
     * back with null title and artist rather than being left out — it is still
     * hidden here, and the list is where a flag is found again.
     */
    flagged(): FlaggedTrack[] {
        const rows = this.db
            .prepare(
                `SELECT f.*, t.title AS title, t.artist AS artist, t.album AS album
                 FROM track_flags f
                 LEFT JOIN tracks t ON t.jellyfinId = f.jellyfinId
                 WHERE f.deleted = 0
                 ORDER BY f.updatedAt DESC, f.id`,
            )
            .all() as Array<Record<string, null | number | string>>;

        return rows.map((row) => ({
            ...toRow(row),
            album: row.album === null ? null : String(row.album),
            artist: row.artist === null ? null : String(row.artist),
            title: row.title === null ? null : String(row.title),
        }));
    }

    /** The flags on a track, or undefined when nothing has been said about it. */
    flags(jellyfinId: string): TrackFlagRow | undefined {
        const row = this.rowFor(jellyfinId);
        return row && Number(row.deleted) === 0 ? toRow(row) : undefined;
    }

    /** Which of these tracks are marked not interested. */
    notInterestedAmong(jellyfinIds: readonly string[]): Set<string> {
        return notInterestedAmong(this.db, jellyfinIds);
    }

    setDontCount(jellyfinId: string, contentKey: string, value: boolean): TrackFlagRow | undefined {
        return this.setFlag('dontCount', jellyfinId, contentKey, value);
    }

    setNotInterested(
        jellyfinId: string,
        contentKey: string,
        value: boolean,
    ): TrackFlagRow | undefined {
        return this.setFlag('notInterested', jellyfinId, contentKey, value);
    }

    /** The row for a track, deleted or not. Deleted, so a flag set again reuses its id. */
    private rowFor(jellyfinId: string): Record<string, null | number | string> | undefined {
        return this.db.prepare('SELECT * FROM track_flags WHERE jellyfinId = ?').get(jellyfinId) as
            | Record<string, null | number | string>
            | undefined;
    }

    /**
     * Set one flag, minting the row if the track has none and deleting it when
     * both flags end up off.
     *
     * The phone's `setFlag`, including the reuse of a deleted row's id and the
     * content key: the key the row already carries is kept over the caller's,
     * because it was computed from the same metadata and a row whose key
     * changes under it looks like an edit to every other device.
     */
    private setFlag(
        field: 'dontCount' | 'notInterested',
        jellyfinId: string,
        contentKey: string,
        value: boolean,
    ): TrackFlagRow | undefined {
        const existing = this.rowFor(jellyfinId) ?? {
            contentKey,
            dontCount: 0,
            id: randomUUID(),
            jellyfinId,
            notInterested: 0,
        };

        return this.write(existing, {
            dontCount: field === 'dontCount' ? value : Number(existing.dontCount) !== 0,
            notInterested: field === 'notInterested' ? value : Number(existing.notInterested) !== 0,
        });
    }

    private write(
        existing: Record<string, null | number | string>,
        flags: { dontCount: boolean; notInterested: boolean },
    ): TrackFlagRow | undefined {
        const values = {
            contentKey: String(existing.contentKey),
            dontCount: flags.dontCount,
            id: String(existing.id),
            jellyfinId: String(existing.jellyfinId),
            notInterested: flags.notInterested,
        };

        // A row with neither flag set is a row with nothing to say. It goes as
        // a delete — the same id, so the next flag set on this track revives
        // it rather than minting a stranger — instead of being kept empty.
        const empty = !flags.dontCount && !flags.notInterested;
        const { row } = this.store.record('track_flags', values, empty ? 'delete' : 'upsert');

        return empty ? undefined : toRow(row as Record<string, null | number | string>);
    }
}

/**
 * Which of `jellyfinIds` are marked not interested, straight off the table.
 *
 * A function rather than only a method so `Mix.narrow`, which holds the
 * database and not the store, can ask the same question of the same rows.
 * Chunked at the parameter ceiling the history queries use: a station or a mix
 * offers more candidates than SQLite takes host parameters for, and a query
 * that silently answered for the first chunk would let the tail through.
 */
export const notInterestedAmong = (
    db: DatabaseSync,
    jellyfinIds: readonly string[],
): Set<string> => {
    const found = new Set<string>();

    for (let start = 0; start < jellyfinIds.length; start += MAX_PARAMETERS) {
        const chunk = jellyfinIds.slice(start, start + MAX_PARAMETERS);
        const placeholders = chunk.map(() => '?').join(', ');

        const rows = db
            .prepare(
                `SELECT jellyfinId FROM track_flags
                 WHERE deleted = 0 AND notInterested = 1 AND jellyfinId IN (${placeholders})`,
            )
            .all(...chunk) as Array<{ jellyfinId: string }>;

        for (const row of rows) found.add(row.jellyfinId);
    }

    return found;
};

const toRow = (row: Record<string, boolean | null | number | string>): TrackFlagRow => ({
    contentKey: String(row.contentKey),
    dontCount: Number(row.dontCount) !== 0,
    id: String(row.id),
    jellyfinId: String(row.jellyfinId),
    notInterested: Number(row.notInterested) !== 0,
    updatedAt: Number(row.updatedAt),
});
