import type { SyncEntity } from '/@/shared/aoide/sync-types';

import type { CurationRow } from './curation-store';

/**
 * Conflict resolution.
 *
 * Last-writer-wins on `updatedAt`, with `originDevice` as a deterministic
 * tiebreak when two clocks agree. **Which side wins is arbitrary; that every
 * device independently reaches the same answer is not.** Two devices resolving
 * one conflict differently diverge permanently, and nothing afterwards notices.
 *
 * Everything here is a pure function of its inputs for that reason — no clock
 * reads, no database, nothing a second device could see differently.
 */

/**
 * Where per-field stamps live locally (a column) and on the wire (a payload
 * key).
 *
 * The two strings are equal, and both names are kept anyway. The wire key is
 * fixed by the phone and by every op already in a log; the column name is this
 * client's own and equals it only because the whole schema was brought to the
 * phone's spelling. They are also not the same *shape* — the column holds JSON
 * text, the payload key holds an object — so the conversion between them stays
 * real work even now that it no longer renames anything. Collapsing them into
 * one constant would make a future column rename silently rewrite the wire.
 */
export const FIELD_STAMPS_COLUMN = 'fieldUpdatedAt';
export const FIELD_STAMPS_KEY = 'fieldUpdatedAt';

/**
 * Entities merged field by field rather than row by row.
 *
 * Nothing else needs it. `playlist_items` and `likes` have one mutable field
 * each, so per-row already *is* per-field. `play_events` is append-only and
 * cannot conflict.
 *
 * `queue_state` is excluded **deliberately, not by omission**: merging a queue
 * field by field could pair one device's playback position with another
 * device's track list — a state that existed on neither device and describes
 * nothing.
 *
 * `track_flags` is in, and is why it is not two columns on `likes`: "not
 * interested" set on one device and "don't count" set on another at the same
 * moment must both survive, and a whole-row merge keeps one.
 */
export const PER_FIELD_ENTITIES: ReadonlySet<SyncEntity> = new Set([
    'folders',
    'playlists',
    'track_flags',
]);

/**
 * Entities that hold one row per track, keyed by `jellyfinId` beneath the id.
 *
 * Two devices that each minted a row for the same track before seeing the
 * other's have two ids for one fact. `applyRemote` keeps the newer `(updatedAt,
 * originDevice)` row and deletes the other — the phone's `mergeLike` and
 * `mergeTrackFlags` — so every device ends on the same single row.
 */
export const ONE_ROW_PER_TRACK: ReadonlySet<SyncEntity> = new Set(['likes', 'track_flags']);

/** Columns that carry the merge rather than being merged. */
// The phone's `FieldStamped.metadataColumns`, exactly: id, updatedAt, deleted,
// originDevice, fieldUpdatedAt. `deleted` belongs here and not among the merged
// fields — it describes the write rather than any one field, so the row-level
// comparison decides it. Merging it per field instead makes a delete racing a
// rename resolve one way here and the other way on the phone, and the two then
// disagree about whether a playlist exists, permanently. `deviceId` is this
// client's addition, the primary key of a table that never merges per field.
export const METADATA_COLUMNS: ReadonlySet<string> = new Set([
    'deleted',
    'deviceId',
    FIELD_STAMPS_COLUMN,
    'id',
    'originDevice',
    'updatedAt',
]);

export interface MergeInput {
    entity: SyncEntity;
    existing: CurationRow;
    existingStamps: Stamps;
    /** Already skew-corrected — see `correctForSkew`. */
    incoming: CurationRow;
    incomingStamps: Stamps;
}

export interface MergeResult {
    /** False when the merge produced exactly what was already stored. */
    changed: boolean;
    row: CurationRow;
    /** Null when the stamps carry no information beyond the row's own `updatedAt`. */
    stamps: null | Stamps;
}

export type Stamps = Record<string, number>;

/**
 * Decide whether a timestamp should be believed.
 *
 * **Both references have to disagree with it before it is disbelieved:** the
 * writer must be ahead of the server *and* ahead of this device's own clock.
 * Testing against the server alone cannot tell a fast client from a slow
 * server, and a Jellyfin box on a NAS with no real-time clock *is* a slow
 * server — every device then looks "ahead", every inbound row is dragged below
 * the local copy, and every device rejects every other device's edits,
 * permanently and silently.
 *
 * When the server supplied no receipt time there is only one reference, so
 * nothing is corrected. Correcting against the local clock alone is precisely
 * the failure above, and a client inventing the missing half is worse than a
 * client that leaves a rare skew uncorrected.
 */
export const correctForSkew = (
    timestamp: number,
    receivedAt: number | undefined,
    now: number,
): number => {
    if (receivedAt === undefined) return timestamp;
    if (timestamp <= receivedAt || timestamp <= now) return timestamp;
    return Math.min(receivedAt, now);
};

/** Apply `correctForSkew` to a whole stamp map. */
export const correctStamps = (
    stamps: Stamps,
    receivedAt: number | undefined,
    now: number,
): Stamps => {
    const corrected: Stamps = {};
    for (const [field, timestamp] of Object.entries(stamps)) {
        corrected[field] = correctForSkew(timestamp, receivedAt, now);
    }
    return corrected;
};

/**
 * Which row wins, considered whole.
 *
 * The tiebreak compares device ids as strings. Arbitrary, and identical on
 * every device, which is the only property that matters.
 */
export const rowWinner = (
    incoming: CurationRow,
    existing: CurationRow,
): 'existing' | 'incoming' => {
    const incomingAt = Number(incoming.updatedAt ?? 0);
    const existingAt = Number(existing.updatedAt ?? 0);

    if (incomingAt !== existingAt) return incomingAt > existingAt ? 'incoming' : 'existing';

    const incomingDevice = String(incoming.originDevice ?? '');
    const existingDevice = String(existing.originDevice ?? '');

    // Same clock, same device: this is the same write arriving again. Keeping
    // what is stored is what makes replaying an op a no-op.
    if (incomingDevice === existingDevice) return 'existing';

    return incomingDevice > existingDevice ? 'incoming' : 'existing';
};

/** Read a stamp map off a wire payload, tolerating its absence and its junk. */
export const stampsFromPayload = (payload: Record<string, unknown>): Stamps => {
    const raw = payload[FIELD_STAMPS_KEY];
    if (!raw || typeof raw !== 'object') return {};

    const stamps: Stamps = {};
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) stamps[field] = value;
    }
    return stamps;
};

/** Read a stamp map off a stored row. */
export const stampsFromRow = (row: CurationRow): Stamps => {
    const raw = row[FIELD_STAMPS_COLUMN];
    if (typeof raw !== 'string' || raw.length === 0) return {};

    try {
        return stampsFromPayload({ [FIELD_STAMPS_KEY]: JSON.parse(raw) });
    } catch {
        // A stamp map that will not parse is not worth failing a sync over. The
        // row still has its own `updatedAt`, which is exactly what a row
        // written before per-field merging falls back to.
        return {};
    }
};

export const mergeRows = ({
    entity,
    existing,
    existingStamps,
    incoming,
    incomingStamps,
}: MergeInput): MergeResult => {
    const winner = rowWinner(incoming, existing);

    if (!PER_FIELD_ENTITIES.has(entity)) {
        return winner === 'incoming'
            ? { changed: true, row: incoming, stamps: null }
            : { changed: false, row: existing, stamps: null };
    }

    const incomingAt = Number(incoming.updatedAt ?? 0);
    const existingAt = Number(existing.updatedAt ?? 0);
    const fields = new Set(
        [...Object.keys(existing), ...Object.keys(incoming)].filter(
            (column) => !METADATA_COLUMNS.has(column),
        ),
    );

    const row: CurationRow = { ...existing };
    const stamps: Stamps = {};

    for (const field of fields) {
        // A row without the map falls back to its own `updatedAt` for every
        // field, so ops already in the log and devices on older builds keep
        // working with no migration.
        const incomingStamp = incomingStamps[field] ?? incomingAt;
        const existingStamp = existingStamps[field] ?? existingAt;

        // An older build that has never heard of a column must not erase it.
        // Absent is not the same as null, and treating it as null is how a
        // cover disappears when an older device renames a playlist.
        if (!(field in incoming)) {
            stamps[field] = existingStamp;
            continue;
        }
        if (!(field in existing)) {
            row[field] = incoming[field];
            stamps[field] = incomingStamp;
            continue;
        }

        if (incomingStamp > existingStamp) {
            row[field] = incoming[field];
        } else if (existingStamp > incomingStamp) {
            row[field] = existing[field];
        } else {
            // A tie takes the *row winner's* value, not the stored one.
            // Preferring what is already here looks harmless and is not: two
            // devices each keep their own value, both believe they have merged,
            // and they never converge again.
            row[field] = (winner === 'incoming' ? incoming : existing)[field];
        }

        stamps[field] = Math.max(incomingStamp, existingStamp);
    }

    // The metadata all follows the row-level winner together. Taking `deleted`
    // from one side and `originDevice` from the other would describe a write
    // that never happened.
    const metadataFrom = winner === 'incoming' ? incoming : existing;
    row.updatedAt = Math.max(incomingAt, existingAt);
    row.originDevice = metadataFrom.originDevice;
    if ('deleted' in metadataFrom) row.deleted = metadataFrom.deleted;

    // A map that says nothing beyond the row's own timestamp is stored as
    // nothing. Synthesising one out of two unstamped rows makes applying the
    // same op twice produce a different row the second time, which breaks the
    // idempotency the whole retry story rests on.
    const informative = Object.values(stamps).some((stamp) => stamp !== row.updatedAt);

    return {
        changed: !sameRow(row, existing),
        row,
        stamps: informative ? stamps : null,
    };
};

const sameRow = (a: CurationRow, b: CurationRow): boolean => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        if (key === FIELD_STAMPS_COLUMN) continue;
        if (a[key] !== b[key]) return false;
    }
    return true;
};
