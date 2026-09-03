import type { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'node:crypto';

import type { CurationRow } from './curation-store';
import type { CurationDatabase } from './database';

import { CurationStore } from './curation-store';

import { positionBetween, positionsAfter } from '/@/shared/aoide/fractional-index';

/**
 * What a playlist screen can do, expressed once.
 *
 * Reads go straight to SQLite; every write goes through `CurationStore.record`,
 * which writes the row and its op in one transaction. There is deliberately no
 * other path — a row that changed without an op is a change that silently never
 * leaves this device, and nothing afterwards can detect that it happened.
 *
 * The one table written directly is `tracks`, and only because it is the one
 * table that does not sync: it is a per-device cache rebuilt from that device's
 * own Jellyfin connection, absent from `SyncEntity` entirely, so `record` could
 * not take it even if it wanted to.
 *
 * Every mutation reads the whole row, changes what it means to change, and hands
 * the whole thing back. That looks wasteful and is load-bearing — see `update`.
 */

/** What a stand-in cover is built from: the album's picture if known, else the track's. */
export type CoverTrack = Pick<PlaylistTrack, 'albumId' | 'jellyfinId'>;

export interface CreatePlaylistOptions {
    folderId?: null | string;
    notes?: null | string;
}

export interface ImportRequest {
    /** Used only when creating. A refresh leaves the local name alone — see `importFromJellyfin`. */
    name: string;
    sourceJellyfinId: string;
    tracks: readonly TrackInput[];
}

export interface ImportResult {
    added: number;
    /** False when an existing import was refreshed rather than a new playlist made. */
    created: boolean;
    playlistId: string;
    removed: number;
}

/** Where an item should end up, named by the neighbours it lands between. */
export interface MoveTarget {
    /** The item it should follow, or null for the top of the list. */
    afterId: null | string;
    /** The item it should precede, or null for the bottom. */
    beforeId: null | string;
}

/** A playlist as a list screen needs it: the row, plus what it costs to count. */
export interface PlaylistSummary {
    artworkItemId: null | string;
    /**
     * The first live entry, for a cover when the playlist has none of its own.
     * Read in the one summary query rather than by a second call per card: a
     * grid of forty playlists must not cost forty round trips to find out
     * which ones need a stand-in picture.
     */
    firstTrack: CoverTrack | null;
    folderId: null | string;
    id: string;
    imageHash: null | string;
    imageMime: null | string;
    /** True/false rather than 1/0. SQLite has no booleans and a renderer should not have to know. */
    isSmart: boolean;
    name: string;
    notes: null | string;
    smartRules: null | string;
    sortIndex: string;
    /** The Jellyfin playlist this was imported from, and the only thing a re-import matches on. */
    sourceJellyfinId: null | string;
    /** Live items only. Counted in SQLite, for every playlist, in the one query. */
    trackCount: number;
    updatedAt: number;
}

/**
 * One entry of a playlist, joined to whatever the track cache knows about it.
 *
 * The metadata is nullable because the join is a LEFT one: an item that arrived
 * from the phone names a track this device has never indexed, and dropping those
 * rows would make a synced playlist look empty rather than look unresolved.
 */
export interface PlaylistTrack {
    album: null | string;
    albumArtist: null | string;
    albumId: null | string;
    artist: null | string;
    contentKey: string;
    durationMs: null | number;
    genres: string[];
    /** The item's own id — what `removeItem` and `moveItem` take, never the track's. */
    id: string;
    jellyfinId: string;
    playlistId: string;
    /** A fractional index. Sortable as a string, and the only thing that defines order. */
    position: string;
    title: null | string;
    year: null | number;
}

/**
 * A track being added to a playlist.
 *
 * Carries the metadata as well as the ids because adding is when this device
 * learns the track exists: the entry needs `jellyfinId` and `contentKey`, and
 * the cache needs the rest so the playlist can be drawn without asking Jellyfin
 * again — offline, or while the server is down.
 */
export interface TrackInput {
    album: string;
    albumArtist?: null | string;
    albumId?: null | string;
    artist: string;
    /**
     * The fingerprint that survives a rescan. Computed from the metadata when
     * absent, which is almost always the right thing — see `contentKeyFor`.
     */
    contentKey?: string;
    durationMs?: null | number;
    genres?: readonly string[];
    jellyfinId: string;
    musicbrainzId?: null | string;
    title: string;
    year?: null | number;
}

/**
 * The fingerprint a track keeps when its Jellyfin id does not.
 *
 * Jellyfin ids are derived per file, so moving files or re-adding a library
 * mints new ones and every playlist entry pointing at the old id dangles. This
 * is what a later relink pass matches on instead.
 *
 * **Transcribed from `CurationKit.ContentKey.make`, not from `sync-design.md`.**
 * The design document describes a SHA-256; the phone ships a joined normalised
 * string, and the phone is what the other half of every relink is comparing
 * against. Normalisation is deliberately aggressive — the question is "is this
 * the same recording", not "is this the same file" — and the duration is rounded
 * to the second so a re-encode that shifts it by milliseconds still matches.
 */
export const contentKeyFor = (track: {
    album: string;
    artist: string;
    durationMs?: null | number;
    title: string;
}): string => {
    const seconds =
        track.durationMs === null || track.durationMs === undefined
            ? 0
            : Math.trunc((track.durationMs + 500) / 1000);

    return [
        normaliseForKey(track.artist),
        normaliseForKey(track.album),
        normaliseForKey(track.title),
        String(seconds),
    ].join('|');
};

export class Playlists {
    private readonly db: DatabaseSync;

    private readonly store: CurationStore;

    /**
     * Takes the store as well as the database rather than making its own: the
     * store holds this device's id and is what the sync engine writes through
     * too, and two of them would be two op logs' worth of confusion for nothing.
     */
    constructor(database: CurationDatabase, store: CurationStore) {
        this.db = database.db;
        this.store = store;
    }

    /**
     * Appends tracks to the end of a playlist, in the order given.
     *
     * One call to `positionsAfter` rather than one walk of the list per track:
     * importing six hundred tracks otherwise reads the playlist six hundred
     * times, and each read gets longer as the import goes on.
     *
     * A track already in the playlist is added again rather than skipped. Apple
     * Music allows it and it is genuinely wanted — a set list that plays the same
     * song twice — and deduplicating would also have to pick which copy a later
     * relink repairs, which has no right answer.
     *
     * Returns the new entries only. A move or an add is proportional to what
     * changed; sending the whole playlist back after every drag is how a screen
     * with a long playlist on it becomes slow.
     */
    addTracks(playlistId: string, tracks: readonly TrackInput[]): PlaylistTrack[] {
        this.requireLivePlaylist(playlistId);
        if (tracks.length === 0) return [];

        this.cacheTracks(tracks);

        const positions = positionsAfter(this.lastPosition(playlistId), tracks.length);
        const added = new Set<string>();

        tracks.forEach((track, index) => {
            const id = randomUUID();
            this.store.record('playlist_items', {
                contentKey: track.contentKey ?? contentKeyFor(track),
                id,
                jellyfinId: track.jellyfinId,
                playlistId,
                position: positions[index],
            });
            added.add(id);
        });

        return this.items(playlistId).filter((item) => added.has(item.id));
    }

    /**
     * Remember what a track is, so a playlist can be drawn without Jellyfin.
     *
     * Written straight to SQLite rather than through `record`, and that is the
     * one place in this file where that is correct: `tracks` is not a syncable
     * entity. Each device rebuilds it from its own connection, and keeping it out
     * of the op log is what keeps a full history sync small.
     *
     * One transaction for the batch. Safe to open here only because nothing
     * inside it goes through `record`, which opens its own and cannot nest.
     */
    /**
     * Teach this device about tracks it has only ever seen an id for.
     *
     * A playlist that arrived from the phone carries `jellyfinId` and a content
     * key and nothing else — the `tracks` cache is deliberately per-device and
     * never synced, so a freshly synced playlist is a list of identifiers with
     * no titles, no artists and no artwork. The renderer resolves them against
     * Jellyfin, which it can already reach, and hands them back here so the next
     * open is instant and the one after that works offline.
     */
    cacheTracks(tracks: readonly TrackInput[]): void {
        const statement = this.db.prepare(
            `INSERT INTO tracks
                 (jellyfinId, contentKey, musicbrainzId, title, artist, album,
                  albumArtist, albumId, durationMs, year, genres, lastSeenAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(jellyfinId) DO UPDATE SET
                 contentKey = excluded.contentKey,
                 musicbrainzId = excluded.musicbrainzId,
                 title = excluded.title,
                 artist = excluded.artist,
                 album = excluded.album,
                 albumArtist = excluded.albumArtist,
                 albumId = excluded.albumId,
                 durationMs = excluded.durationMs,
                 year = excluded.year,
                 genres = excluded.genres,
                 lastSeenAt = excluded.lastSeenAt`,
        );

        const seenAt = Date.now();

        this.db.exec('BEGIN');
        try {
            for (const track of tracks) {
                statement.run(
                    track.jellyfinId,
                    track.contentKey ?? contentKeyFor(track),
                    track.musicbrainzId ?? null,
                    track.title,
                    track.artist,
                    track.album,
                    track.albumArtist ?? null,
                    track.albumId ?? null,
                    track.durationMs ?? null,
                    track.year ?? null,
                    JSON.stringify(track.genres ?? []),
                    seenAt,
                );
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /** A new playlist, appended after the last one. */
    create(name: string, options: CreatePlaylistOptions = {}): PlaylistSummary {
        const id = this.insertPlaylist({
            folderId: options.folderId ?? null,
            name,
            notes: options.notes ?? null,
            sourceJellyfinId: null,
        });

        return this.requireSummary(id);
    }

    /** One playlist, or undefined when it does not exist or has been deleted. */
    get(playlistId: string): PlaylistSummary | undefined {
        const row = this.db
            .prepare(`${SUMMARY_QUERY} WHERE p.deleted = 0 AND p.id = ? GROUP BY p.id`)
            .get(playlistId) as SummaryRow | undefined;

        return row ? toSummary(row) : undefined;
    }

    /**
     * Copies a Jellyfin playlist into a local one, or refreshes the copy that
     * already exists.
     *
     * **The match is on `sourceJellyfinId` and nothing else.** Matching on the
     * name instead turned two playlists into four on the sidecar's first
     * re-import, and it would have been ambiguous on exactly the pairs that
     * mattered: two servers' "Favourites", a playlist renamed here after being
     * imported, two imports that happen to agree on a name. The source id is the
     * only thing that answers "is this the same playlist" without guessing.
     *
     * A refresh replaces the contents outright, matching the phone. The server's
     * order is the answer, and merging the two lists would mean guessing which
     * side meant to remove a track. The *name* is not replaced: a local rename
     * after an import is a deliberate act, and losing it silently on a refresh
     * would be worse than a stale name nobody asked to change.
     *
     * The old entries are soft-deleted one at a time rather than wiped, because
     * every removal is an op the other devices have to be told about. A bulk
     * delete would leave the phone holding the old contents forever.
     */
    importFromJellyfin(request: ImportRequest): ImportResult {
        const existing = this.importedPlaylist(request.sourceJellyfinId);

        let removed = 0;
        let playlistId: string;

        if (existing) {
            playlistId = String(existing.id);
            for (const item of this.items(playlistId)) {
                this.removeItem(item.id);
                removed += 1;
            }
        } else {
            playlistId = this.insertPlaylist({
                folderId: null,
                name: request.name,
                notes: null,
                sourceJellyfinId: request.sourceJellyfinId,
            });
        }

        const added = this.addTracks(playlistId, request.tracks);

        return { added: added.length, created: !existing, playlistId, removed };
    }

    /**
     * A playlist's live entries, in order.
     *
     * The id breaks ties in the ordering. Two entries cannot hold the same
     * position unless they were written concurrently on two devices, at which
     * point SQLite promises nothing about their order and a list that permutes
     * between two identical refreshes reads as a bug.
     */
    items(playlistId: string): PlaylistTrack[] {
        const rows = this.db
            .prepare(
                `${ITEM_QUERY} WHERE i.playlistId = ? AND i.deleted = 0 ORDER BY i.position, i.id`,
            )
            .all(playlistId) as ItemRow[];

        return rows.map(toTrack);
    }

    /**
     * Every live playlist, in order, with the number of entries in each.
     *
     * Counted in SQLite in the same query rather than by calling `items` per row:
     * a library screen shows a count beside every playlist, and fetching each
     * one's entries to print a number is the difference between one query and
     * hundreds.
     */
    list(): PlaylistSummary[] {
        const rows = this.db
            .prepare(
                `${SUMMARY_QUERY} WHERE p.deleted = 0 GROUP BY p.id ORDER BY p.sortIndex, p.id`,
            )
            .all() as SummaryRow[];

        return rows.map(toSummary);
    }

    /**
     * Drag-to-reorder. **Writes exactly one row**, which is the entire reason
     * `position` is a fractional index rather than an integer.
     *
     * Both neighbours are named because that is what a drop knows: the entry
     * landed between these two rows. Either may be null for an end of the list.
     */
    moveItem(itemId: string, target: MoveTarget): PlaylistTrack {
        const item = this.requireLiveItem(itemId);
        const playlistId = String(item.playlistId);

        // An omitted neighbour and an explicitly null one mean the same thing —
        // that end of the list — and the types stop being enforced the moment
        // this is called across IPC.
        const afterId = target.afterId ?? null;
        const beforeId = target.beforeId ?? null;

        if (afterId === itemId || beforeId === itemId) {
            throw new Error('An item cannot be moved relative to itself');
        }

        const lower =
            afterId === null ? null : String(this.requireLiveItemIn(afterId, playlistId).position);
        const upper =
            beforeId === null
                ? null
                : String(this.requireLiveItemIn(beforeId, playlistId).position);

        // A drag that lands back where it started must not manufacture an op that
        // every other device then has to merge. Two nulls land here too, which is
        // the right answer: "between nothing and nothing" is where it already is.
        const position = String(item.position);
        const alreadyAfter = lower === null || lower < position;
        const alreadyBefore = upper === null || position < upper;

        if (!(alreadyAfter && alreadyBefore)) {
            // One row, and only one. Renumbering the neighbours would hand back
            // exactly what the fractional index was chosen to buy.
            this.store.record('playlist_items', {
                ...item,
                position: positionBetween(lower, upper),
            });
        }

        return this.requireTrackView(itemId);
    }

    /**
     * Soft-deletes a playlist **and its entries**.
     *
     * The entries are not optional collateral: rows left behind still match on
     * content key, so a later relink pass would rewrite them, and a device that
     * merges the delete late would find the playlist whole again. They go first,
     * so a crash half way through leaves a shortened playlist — recoverable by
     * repeating the delete — rather than entries nothing points at.
     */
    remove(playlistId: string): void {
        const row = this.playlistRow(playlistId);
        if (!row) throw new Error(`No playlist ${playlistId}`);
        // Deleting twice must not mint a second op; the first already carries the
        // whole story, and the second would be a pointless conflict elsewhere.
        if (Number(row.deleted) !== 0) return;

        for (const item of this.items(playlistId)) this.removeItem(item.id);
        this.store.record('playlists', row, 'delete');
    }

    /** Soft-deletes one entry. The row stays; only `deleted` changes. */
    removeItem(itemId: string): void {
        const row = this.itemRow(itemId);
        if (!row) throw new Error(`No playlist item ${itemId}`);
        if (Number(row.deleted) !== 0) return;

        this.store.record('playlist_items', row, 'delete');
    }

    rename(playlistId: string, name: string): PlaylistSummary {
        return this.update(playlistId, { name });
    }

    /**
     * Name a Jellyfin item whose picture this playlist wears.
     *
     * Artwork and nothing else. `sourceJellyfinId` is provenance — the key a
     * re-import dedupes on — and this method cannot reach it, so a cover
     * chosen by a guess can never masquerade as where the playlist came from.
     */
    setArtwork(playlistId: string, artworkItemId: null | string): PlaylistSummary {
        return this.update(playlistId, { artworkItemId });
    }

    setNotes(playlistId: string, notes: null | string): PlaylistSummary {
        return this.update(playlistId, { notes });
    }

    /**
     * Store a rule set on a playlist, making it smart.
     *
     * The rules and not the tracks: a mix frozen to the songs it happened to
     * pick today stops being the thing that was described. Stored as the phone's
     * own JSON, so the phone evaluates it without knowing this app exists.
     */
    setSmartRules(playlistId: string, smartRules: null | string): PlaylistSummary {
        return this.update(playlistId, { isSmart: smartRules !== null, smartRules });
    }

    /** The local copy of a Jellyfin playlist, if one has been imported. */
    private importedPlaylist(sourceJellyfinId: string): CurationRow | undefined {
        // Ordered by id so that a library which already holds duplicates — the
        // bug this lookup exists to stop happening again — resolves to the same
        // copy on every device. Which copy is arbitrary; that they agree is not.
        return this.db
            .prepare(
                'SELECT * FROM playlists WHERE sourceJellyfinId = ? AND deleted = 0 ORDER BY id LIMIT 1',
            )
            .get(sourceJellyfinId) as CurationRow | undefined;
    }

    /**
     * Writes a new playlist row, complete.
     *
     * Every column is named even where SQLite has a DEFAULT for it, so the op's
     * payload — which `record` builds by reading the row back — carries the whole
     * playlist. The phone's `Playlist` declares `isSmart` non-optional, and a
     * payload missing it fails to decode there and is quarantined forever while
     * this side reports a perfectly successful push.
     */
    private insertPlaylist(values: {
        folderId: null | string;
        name: string;
        notes: null | string;
        sourceJellyfinId: null | string;
    }): string {
        if (values.folderId !== null) this.requireLiveFolder(values.folderId);

        const id = randomUUID();

        this.store.record('playlists', {
            artworkItemId: null,
            folderId: values.folderId,
            id,
            imageHash: null,
            imageMime: null,
            isSmart: 0,
            name: values.name,
            notes: values.notes,
            smartRules: null,
            sortIndex: positionBetween(this.lastSortIndex(), null),
            sourceJellyfinId: values.sourceJellyfinId,
        });

        return id;
    }

    private itemRow(itemId: string): CurationRow | undefined {
        return this.db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(itemId) as
            | CurationRow
            | undefined;
    }

    /** The position of the last live entry, or null in an empty playlist. */
    private lastPosition(playlistId: string): null | string {
        const row = this.db
            .prepare(
                'SELECT position FROM playlist_items WHERE playlistId = ? AND deleted = 0 ORDER BY position DESC LIMIT 1',
            )
            .get(playlistId) as undefined | { position: string };

        return row ? row.position : null;
    }

    /**
     * The largest sort key among live playlists.
     *
     * Deleted ones are excluded deliberately: a tombstone holding the largest key
     * would push every new playlist's key one step further out forever, for a row
     * nobody can see.
     */
    private lastSortIndex(): null | string {
        const row = this.db
            .prepare(
                'SELECT sortIndex FROM playlists WHERE deleted = 0 ORDER BY sortIndex DESC LIMIT 1',
            )
            .get() as undefined | { sortIndex: string };

        return row ? row.sortIndex : null;
    }

    private playlistRow(playlistId: string): CurationRow | undefined {
        return this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
            | CurationRow
            | undefined;
    }

    private requireLiveFolder(folderId: string): void {
        const row = this.db
            .prepare('SELECT id FROM folders WHERE id = ? AND deleted = 0')
            .get(folderId);

        // Checked rather than trusted because a playlist filed under a folder that
        // does not exist appears in no folder listing at all — present in the
        // database, invisible on every screen.
        if (!row) throw new Error(`No folder ${folderId}`);
    }

    private requireLiveItem(itemId: string): CurationRow {
        const row = this.itemRow(itemId);
        if (!row || Number(row.deleted) !== 0) throw new Error(`No playlist item ${itemId}`);
        return row;
    }

    private requireLiveItemIn(itemId: string, playlistId: string): CurationRow {
        const row = this.requireLiveItem(itemId);
        if (String(row.playlistId) !== playlistId) {
            throw new Error(`Item ${itemId} is not in playlist ${playlistId}`);
        }
        return row;
    }

    private requireLivePlaylist(playlistId: string): CurationRow {
        const row = this.playlistRow(playlistId);
        if (!row || Number(row.deleted) !== 0) throw new Error(`No playlist ${playlistId}`);
        return row;
    }

    private requireSummary(playlistId: string): PlaylistSummary {
        const summary = this.get(playlistId);
        if (!summary) throw new Error(`Playlist ${playlistId} vanished between write and read`);
        return summary;
    }

    private requireTrackView(itemId: string): PlaylistTrack {
        const row = this.db.prepare(`${ITEM_QUERY} WHERE i.id = ?`).get(itemId) as
            | ItemRow
            | undefined;

        if (!row) throw new Error(`Playlist item ${itemId} vanished between write and read`);
        return toTrack(row);
    }

    /**
     * Change some fields of a playlist and record the whole row.
     *
     * **The whole row, never just the changed fields**, and this is the reason:
     * `record` stamps each field it is handed, then stores the stamp map only if
     * it says something the row's own `updatedAt` does not. Handed `{ id, name }`
     * it produces a map reading `{ name: now }`, which says nothing — so no map
     * is written, and the receiving device falls back to `updatedAt` for *every*
     * field and lets this rename win the notes as well. Handed the whole row it
     * keeps the untouched fields' older stamps, the map becomes informative, and
     * a device that edited the notes at the same time keeps its edit.
     *
     * Nothing about that failure is visible from this side: the rename works, the
     * push succeeds, and someone else's note quietly disappears.
     */
    private update(playlistId: string, changes: CurationRow): PlaylistSummary {
        const row = this.requireLivePlaylist(playlistId);
        this.store.record('playlists', { ...row, ...changes });
        return this.requireSummary(playlistId);
    }
}

/**
 * Entries with whatever the cache knows about their tracks.
 *
 * A LEFT join, not an inner one: an entry synced from the phone names a track
 * this device has not indexed yet, and an inner join would silently shorten the
 * playlist instead of showing a row with nothing filled in.
 */
const ITEM_QUERY = `
    SELECT i.id AS id,
           i.playlistId AS playlistId,
           i.jellyfinId AS jellyfinId,
           i.contentKey AS contentKey,
           i.position AS position,
           t.title AS title,
           t.artist AS artist,
           t.album AS album,
           t.albumArtist AS albumArtist,
           t.albumId AS albumId,
           t.durationMs AS durationMs,
           t.year AS year,
           t.genres AS genres
    FROM playlist_items i
    LEFT JOIN tracks t ON t.jellyfinId = i.jellyfinId
`;

/** Playlists with their live entry counts. Grouped and filtered by the caller. */
const SUMMARY_QUERY = `
    SELECT p.id AS id,
           p.name AS name,
           p.notes AS notes,
           p.folderId AS folderId,
           p.isSmart AS isSmart,
           p.smartRules AS smartRules,
           p.sortIndex AS sortIndex,
           p.imageHash AS imageHash,
           p.imageMime AS imageMime,
           p.sourceJellyfinId AS sourceJellyfinId,
           p.artworkItemId AS artworkItemId,
           p.updatedAt AS updatedAt,
           COUNT(i.id) AS trackCount,
           (SELECT f.jellyfinId FROM playlist_items f
             WHERE f.playlistId = p.id AND f.deleted = 0
             ORDER BY f.position, f.id LIMIT 1) AS firstJellyfinId,
           (SELECT t.albumId FROM playlist_items f
             LEFT JOIN tracks t ON t.jellyfinId = f.jellyfinId
             WHERE f.playlistId = p.id AND f.deleted = 0
             ORDER BY f.position, f.id LIMIT 1) AS firstAlbumId
    FROM playlists p
    LEFT JOIN playlist_items i ON i.playlistId = p.id AND i.deleted = 0
`;

/**
 * The two row shapes below are `type` rather than `interface` on purpose.
 *
 * `node:sqlite` hands back `Record<string, SQLOutputValue>`, and only a type
 * alias gets the implicit index signature that makes casting a whole array of
 * them legal. Declared as interfaces the same cast is an error saying the two
 * types do not overlap, which reads like the shape is wrong when it is not.
 */
type ItemRow = {
    album: null | string;
    albumArtist: null | string;
    albumId: null | string;
    artist: null | string;
    contentKey: string;
    durationMs: null | number;
    genres: null | string;
    id: string;
    jellyfinId: string;
    playlistId: string;
    position: string;
    title: null | string;
    year: null | number;
};

type SummaryRow = {
    artworkItemId: null | string;
    firstAlbumId: null | string;
    firstJellyfinId: null | string;
    folderId: null | string;
    id: string;
    imageHash: null | string;
    imageMime: null | string;
    isSmart: number;
    name: string;
    notes: null | string;
    smartRules: null | string;
    sortIndex: string;
    sourceJellyfinId: null | string;
    trackCount: number;
    updatedAt: number;
};

/** Genres are stored as JSON text, and a row that will not parse is not worth a crash. */
const parseGenres = (raw: null | string): string[] => {
    if (typeof raw !== 'string' || raw.length === 0) return [];

    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((genre) => typeof genre === 'string') : [];
    } catch {
        return [];
    }
};

/**
 * The phone's `ContentKey.normalise`, in JavaScript.
 *
 * Diacritics stripped and case folded so "Björk" and "bjork" are one artist,
 * then trimmed, then doubled spaces collapsed — in that order, because trimming
 * before folding would leave whitespace the folding introduced. The collapse
 * replaces exactly two spaces at a time rather than any run of whitespace, which
 * is what `replacingOccurrences(of: "  ", with: " ")` does; matching a `\s+`
 * collapse here would give a different key for a track with three spaces in its
 * title, on a device that would never see the difference locally.
 */
/**
 * Characters Foundation folds that Unicode normalisation alone does not.
 *
 * The phone's key is built with
 * `folding(options: [.diacriticInsensitive, .caseInsensitive])`, which is ICU's
 * fold rather than NFKD: it turns ß into ss and resolves a handful of
 * compatibility characters, while leaving Œ, Æ, Đ, Ĳ, fullwidth forms and the
 * *spacing* diacritics (´ ¨ ¯ ¸ ·) exactly where they are. Every entry here was
 * observed by running the phone's own code, not inferred — see the golden
 * corpus in `content-key.test.ts` and the note there on regenerating it.
 */
const FOUNDATION_FOLDS: ReadonlyMap<string, string> = new Map(
    Object.entries({
        '\u200c': '',
        '\u200d': '',
        ﬀ: 'ff',
        ﬃ: 'ffi',
        ﬄ: 'ffl',
        ﬁ: 'fi',
        ﬂ: 'fl',
        ſ: 's',
        ß: 'ss',
        ẞ: 'ss',
        ﬆ: 'st',
        ﬅ: 'st',
        ŉ: 'ʼn',
        µ: 'μ',
    }),
);

/**
 * A combining mark, but only where it follows a European base.
 *
 * Foundation strips marks from Latin, Greek and Cyrillic and leaves them alone
 * everywhere else — measured, across Japanese, Korean, Thai, Devanagari, Arabic
 * and Hebrew. Stripping indiscriminately would fold が to か and 한 to 한,
 * turning distinct recordings into one key: two different songs would then look
 * like the same recording after a rescan and relink to each other.
 */
const EUROPEAN_BASE_WITH_MARKS = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{Mn}+/gu;

const normaliseForKey = (text: string): string => {
    const stripped = text
        .normalize('NFD')
        .replace(EUROPEAN_BASE_WITH_MARKS, '$1')
        // Recomposed before folding so a decomposed ẛ arrives as ſ, which the
        // table above knows about, rather than as a sequence it does not.
        .normalize('NFC');

    let folded = '';
    for (const character of stripped) folded += FOUNDATION_FOLDS.get(character) ?? character;

    // `.replaceAll('  ', ' ')` and not a `\s+` collapse: the phone replaces the
    // literal two-space sequence, so three spaces become two on both sides. A
    // tidier collapse here would produce a different key for the same track.
    return folded.toLowerCase().trim().replaceAll('  ', ' ');
};

const toSummary = (row: SummaryRow): PlaylistSummary => ({
    artworkItemId: row.artworkItemId,
    firstTrack:
        row.firstJellyfinId === null
            ? null
            : { albumId: row.firstAlbumId, jellyfinId: row.firstJellyfinId },
    folderId: row.folderId,
    id: row.id,
    imageHash: row.imageHash,
    imageMime: row.imageMime,
    isSmart: Number(row.isSmart) !== 0,
    name: row.name,
    notes: row.notes,
    smartRules: row.smartRules,
    sortIndex: row.sortIndex,
    sourceJellyfinId: row.sourceJellyfinId,
    trackCount: Number(row.trackCount),
    updatedAt: Number(row.updatedAt),
});

const toTrack = (row: ItemRow): PlaylistTrack => ({
    album: row.album,
    albumArtist: row.albumArtist,
    albumId: row.albumId,
    artist: row.artist,
    contentKey: row.contentKey,
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    genres: parseGenres(row.genres),
    id: row.id,
    jellyfinId: row.jellyfinId,
    playlistId: row.playlistId,
    position: row.position,
    title: row.title,
    year: row.year === null ? null : Number(row.year),
});
