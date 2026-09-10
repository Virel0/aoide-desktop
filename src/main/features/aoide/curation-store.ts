import type { SyncEntity, SyncOp, SyncOperation } from '/@/shared/aoide/sync-types';
import type { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'node:crypto';

import { CurationDatabase, SERVER_CURSOR_KEY } from './database';
import {
    correctForSkew,
    correctStamps,
    FIELD_STAMPS_COLUMN,
    FIELD_STAMPS_KEY,
    mergeRows,
    METADATA_COLUMNS,
    ONE_ROW_PER_TRACK,
    PER_FIELD_ENTITIES,
    rowWinner,
    Stamps,
    stampsFromPayload,
    stampsFromRow,
} from './merge';

import { parseActivity } from '/@/shared/aoide/activity';

/**
 * Which table each syncable entity lives in, and what identifies a row.
 *
 * The table names *are* the wire names. iOS translates at the wire boundary
 * because its tables predate the server's allow-list; nothing here predates
 * anything, so spelling them the server's way removes a whole class of bug —
 * a mistranslated entity name is every op of that kind refused forever.
 *
 * The **column** names go the other way and are the phone's, because a payload
 * is the row: `record` writes the row's own keys into the payload and
 * `applyRemote` writes a payload's keys back into columns of the same name. The
 * key here is `deviceId` rather than `device_id` for exactly that reason — it
 * is what a `queue_state` payload from either client is keyed by.
 */
const ENTITIES: Record<SyncEntity, { key: string; softDeletes: boolean }> = {
    folders: { key: 'id', softDeletes: true },
    likes: { key: 'id', softDeletes: true },
    // Append-only. There is no such thing as a conflicting append, and no such
    // thing as deleting one.
    play_events: { key: 'id', softDeletes: false },
    playlist_items: { key: 'id', softDeletes: true },
    playlists: { key: 'id', softDeletes: true },
    // One row per device, replaced wholesale. A queue is not something you
    // delete; you replace it or you leave it alone.
    queue_state: { key: 'deviceId', softDeletes: false },
    // One row per track, like `likes`, and a soft delete is what "neither flag
    // set" is stored as — see `TrackFlags.setFlag`.
    track_flags: { key: 'id', softDeletes: true },
};

/**
 * Columns the phone decodes into a Swift `Bool`.
 *
 * SQLite has no boolean type and hands these back as 0 and 1, but Swift encodes
 * `Bool` as JSON `true`/`false` and `JSONDecoder` refuses a number where it
 * wants one. A payload carrying `"isSmart": 0` therefore fails to decode on the
 * phone and the op is quarantined — permanently, because a rejected op is never
 * retried. The failure is silent on this side: the push is accepted, the row is
 * perfectly valid here, and the change simply never appears on the phone.
 *
 * Listed explicitly rather than sniffed from the column's declared type,
 * because SQLite's declared types are advisory and `INTEGER` is what these
 * actually are. This list is the contract, so it is asserted against the phone's
 * own record definitions in the tests.
 */
const BOOLEAN_COLUMNS: Record<SyncEntity, readonly string[]> = {
    folders: ['deleted'],
    likes: ['deleted', 'liked'],
    play_events: ['completed', 'skipped'],
    playlist_items: ['deleted'],
    playlists: ['deleted', 'isSmart'],
    queue_state: [],
    track_flags: ['deleted', 'dontCount', 'notInterested'],
};

export type CurationRow = Record<string, boolean | null | number | string>;

export interface RecordedChange {
    entity: SyncEntity;
    op: SyncOp;
    row: CurationRow;
}

/**
 * The local store, and the only way to write to it.
 *
 * Every method that changes a syncable row goes through `record`, which writes
 * the row and its op in one transaction. That is not a convention to follow —
 * the table writes are private, so there is no other path. A row that changed
 * without an op is a change that silently never syncs, and no amount of later
 * reconciliation finds it, because nothing recorded that it happened.
 */
export class CurationStore {
    /** Where the last completed pull left off. `0` on a device that has never synced. */
    get cursor(): number {
        const row = this.db
            .prepare('SELECT value FROM sync_state WHERE key = ?')
            .get(SERVER_CURSOR_KEY) as undefined | { value: string };
        return row ? Number(row.value) : 0;
    }

    get device(): string {
        return this.deviceId;
    }

    private readonly db: DatabaseSync;

    private readonly deviceId: string;

    constructor(database: CurationDatabase) {
        this.db = database.db;
        this.deviceId = database.deviceId;
    }

    /**
     * Apply an op that came from another device.
     *
     * **Writes the row and appends nothing to the op log.** That asymmetry is
     * the point: an inbound change that produced an outbound op would echo back
     * to the server, arrive at every other device, and echo again. The op log
     * is for changes *this* device made.
     *
     * `receivedAt` is the server's own clock reading for this op, used to
     * detect skew. The contract does not currently carry it — when it is
     * absent nothing is corrected, because a single reference cannot tell a
     * fast writer from a slow server.
     */
    applyRemote(op: SyncOp, receivedAt?: number): 'applied' | 'ignored' {
        const { key, softDeletes } = ENTITIES[op.entity];
        const now = Date.now();

        const incoming = fromPayload(op.payload);
        const id = incoming[key];
        if (typeof id !== 'string' || id.length === 0) return 'ignored';

        incoming.updatedAt = correctForSkew(Number(incoming.updatedAt ?? 0), receivedAt, now);
        if (softDeletes && op.operation === 'delete') incoming.deleted = 1;

        // Append-only, but not write-once. The phone records a long listen
        // twice under one id — an open row the moment playback starts, carrying
        // `msPlayed: 0` and no outcome, then the finished row when it ends —
        // because a listen interrupted by iOS killing a backgrounded app would
        // otherwise leave no trace at all. Ignoring the second copy, as this
        // did, kept the 0 ms version of every long play from the phone forever:
        // no error, no conflict, just a listening history that says nothing was
        // ever listened to.
        if (op.entity === 'play_events') {
            // The tag is a closed set both clients agree on, and this is where
            // somebody else's spelling of it arrives. A value this build does
            // not know — a fifth activity added by a newer one — is dropped to
            // null rather than stored: the listen is real and is kept, but a tag
            // nothing here can query or show would sit in an append-only table
            // forever, and would come back out of it on the next push.
            incoming.activity = parseActivity(incoming.activity);

            const existingEvent = this.db
                .prepare('SELECT endedAt FROM play_events WHERE id = ?')
                .get(id) as undefined | { endedAt: null | number };

            if (existingEvent && !isMoreFinished(incoming, existingEvent)) return 'ignored';

            this.inTransaction(() => this.upsertRow(op.entity, incoming));
            return 'applied';
        }

        const existing = this.row(op.entity, id);

        if (!existing) {
            // A first sighting keeps the sender's stamp map rather than
            // starting the row unstamped. Without it every field falls back to
            // this row's `updatedAt`, and the next op to arrive — an older edit
            // to one field, which is the exact case the map exists to let
            // through — loses to a timestamp the map says it should beat.
            const first = { ...incoming };
            if (PER_FIELD_ENTITIES.has(op.entity)) {
                const stamps = correctStamps(stampsFromPayload(op.payload), receivedAt, now);
                first[FIELD_STAMPS_COLUMN] = informative(stamps, Number(incoming.updatedAt ?? 0))
                    ? JSON.stringify(stamps)
                    : null;
            }

            return this.writeDeduped(op.entity, first);
        }

        const merged = mergeRows({
            entity: op.entity,
            existing,
            existingStamps: stampsFromRow(existing),
            incoming,
            incomingStamps: correctStamps(stampsFromPayload(op.payload), receivedAt, now),
        });

        if (!merged.changed) return 'ignored';

        const row = { ...merged.row };
        if (PER_FIELD_ENTITIES.has(op.entity)) {
            row[FIELD_STAMPS_COLUMN] = merged.stamps ? JSON.stringify(merged.stamps) : null;
        }

        return this.writeDeduped(op.entity, row);
    }

    /** Rows of a table that have not been soft-deleted. */
    live(entity: SyncEntity): CurationRow[] {
        const { softDeletes } = ENTITIES[entity];
        const where = softDeletes ? 'WHERE deleted = 0' : '';
        return this.db.prepare(`SELECT * FROM ${entity} ${where}`).all() as CurationRow[];
    }

    /**
     * Mark ops the server accepted.
     *
     * Accepting an id the server never saw would lose the op silently, so this
     * only ever acts on ids the server named back.
     */
    markSynced(opIds: string[]): void {
        if (opIds.length === 0) return;

        const statement = this.db.prepare('UPDATE ops SET synced = 1 WHERE op_id = ?');
        this.inTransaction(() => {
            for (const opId of opIds) statement.run(opId);
        });
    }

    /**
     * Ops the server has not accepted yet, oldest first.
     *
     * Order matters: the server assigns sequence numbers in the order it
     * receives them, and a later edit arriving before the earlier one it
     * supersedes would leave every other device on the wrong version.
     */
    pendingOps(limit = 500, holding: readonly string[] = []): SyncOp[] {
        // Held entities are excluded in the query rather than filtered after
        // it, so a log whose oldest rows are all held still fills the page
        // with what can go. Filtering a full page afterwards would hand the
        // engine nothing, forever, for as long as the server stayed old.
        const excluded = holding.map(() => '?').join(', ');
        const where = holding.length > 0 ? `AND entity NOT IN (${excluded})` : '';
        const rows = this.db
            .prepare(
                `SELECT * FROM ops WHERE synced = 0 ${where} ORDER BY created_at, rowid LIMIT ?`,
            )
            .all(...holding, limit) as Array<{
            created_at: number;
            entity: string;
            entity_id: string;
            op_id: string;
            operation: string;
            payload: string;
        }>;

        return rows.map((row) => ({
            createdAt: row.created_at,
            entity: row.entity as SyncEntity,
            entityId: row.entity_id,
            operation: row.operation as SyncOperation,
            opId: row.op_id,
            payload: JSON.parse(row.payload) as Record<string, unknown>,
        }));
    }

    /**
     * Set an op aside instead of retrying it forever.
     *
     * Used for a server refusal, and for an op isolated by bisection as the
     * cause of a 5xx. Kept rather than deleted: an op that vanishes takes with
     * it the only evidence of what went wrong, and these are exactly the ones
     * worth being able to look at afterwards.
     */
    quarantine(opId: string, reason: string): void {
        this.inTransaction(() => {
            const op = this.db.prepare('SELECT * FROM ops WHERE op_id = ?').get(opId) as
                | undefined
                | {
                      created_at: number;
                      entity: string;
                      entity_id: string;
                      operation: string;
                      payload: string;
                  };

            if (!op) return;

            this.db
                .prepare(
                    `INSERT OR REPLACE INTO quarantined_ops
                     (op_id, entity, entity_id, operation, payload, created_at, reason, quarantined_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    opId,
                    op.entity,
                    op.entity_id,
                    op.operation,
                    op.payload,
                    op.created_at,
                    reason,
                    Date.now(),
                );
            this.db.prepare('DELETE FROM ops WHERE op_id = ?').run(opId);
        });
    }

    /**
     * Write a row and its op, atomically.
     *
     * The payload is the full row *after* the change, because the server stores
     * payloads verbatim and never parses them: a receiving device has to be
     * able to reconstruct the row from the op alone, without having seen any
     * op before it.
     */
    record(
        entity: SyncEntity,
        values: CurationRow,
        operation: SyncOperation = 'upsert',
    ): RecordedChange {
        const { key, softDeletes } = ENTITIES[entity];
        const id = values[key];

        if (typeof id !== 'string' || id.length === 0) {
            throw new Error(`A ${entity} row needs a ${key} before it can be recorded`);
        }
        if (operation === 'delete' && !softDeletes) {
            throw new Error(`${entity} rows are append-only and cannot be deleted`);
        }

        // Per-row monotonic, not simply Date.now(). Two edits to one row inside
        // the same millisecond otherwise carry the same `updatedAt`, and the
        // second is then indistinguishable from the first: every other device
        // sees a tie, keeps what it has, and drops the newer write silently.
        // A delete issued straight after a create disappears exactly this way.
        //
        // Scoped to the row rather than the device on purpose. A global
        // monotonic clock would run ahead of real time during a bulk import —
        // a thousand rows, a thousand milliseconds — and a device that believes
        // it is in the future starts having its own writes skew-corrected.
        const previous = this.row(entity, id);
        const now = Math.max(Date.now(), Number(previous?.updatedAt ?? 0) + 1);
        const row: CurationRow = {
            ...values,
            originDevice: this.deviceId,
            // Every writer stamps its own clock. Whose clock to believe is the
            // merge's problem, not the writer's.
            updatedAt: now,
            ...(softDeletes ? { deleted: operation === 'delete' ? 1 : 0 } : {}),
        };

        // Only the fields this edit actually changed get today's stamp. Stamping
        // every field on every save would make the last person to touch a
        // playlist win its notes too, which is the whole thing per-field
        // merging exists to prevent.
        const stamps = PER_FIELD_ENTITIES.has(entity)
            ? restampChangedFields(previous, row, now)
            : null;
        if (PER_FIELD_ENTITIES.has(entity)) {
            row[FIELD_STAMPS_COLUMN] = stamps ? JSON.stringify(stamps) : null;
        }

        // Built inside the transaction from the row as SQLite actually stored
        // it, never from `values` as the caller passed them.
        //
        // A caller that omits a column with a DEFAULT — `isSmart`, say — gets a
        // complete row in the database and, before this, an *incomplete*
        // payload. The phone's `Playlist` declares `isSmart` non-optional, so
        // decoding fails and the op is quarantined forever, while this device
        // shows a perfectly good playlist and reports a successful push. The
        // contract is that the payload is the full row after the change, and
        // reading it back is the only way to be sure it is.
        let op!: SyncOp;

        this.inTransaction(() => {
            this.upsertRow(entity, row);

            const stored = this.row(entity, id);
            if (!stored) {
                // Unreachable: the upsert above is in this transaction and would
                // have thrown. Checked anyway because the alternative is pushing
                // an empty payload, which the server would accept.
                throw new Error(`${entity} row ${id} vanished between write and read`);
            }

            op = {
                createdAt: now,
                entity,
                entityId: id,
                operation,
                // The idempotency key. Applying the same op twice must be a
                // no-op, which is what makes retry-after-timeout safe — and a
                // client will retry after a timeout.
                opId: randomUUID(),
                payload: toPayload(entity, stored, stamps),
            };
            this.appendOp(op);
        });

        return { entity, op, row };
    }

    /**
     * Advance the pull cursor.
     *
     * Callers must do this **only after applying a whole batch**, so an
     * interrupted sync replays rather than skips — and must never store the
     * cursor a *push* returned, which is the server's head sequence and may sit
     * above ops from other devices this one has never seen.
     */
    setCursor(cursor: number): void {
        this.db
            .prepare(
                'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            )
            .run(SERVER_CURSOR_KEY, String(cursor));
    }

    private appendOp(op: SyncOp): void {
        this.db
            .prepare(
                `INSERT INTO ops (op_id, entity, entity_id, operation, payload, created_at, synced)
                 VALUES (?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
                op.opId,
                op.entity,
                op.entityId,
                op.operation,
                JSON.stringify(op.payload),
                op.createdAt,
            );
    }

    /**
     * Run `work` in a transaction, rolling back everything if any part throws.
     *
     * Not nestable, deliberately: SQLite has no nested transactions, and
     * emulating them with savepoints would make a failure deep inside a call
     * chain roll back less than the caller believes it did.
     */
    private inTransaction<T>(work: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private row(entity: SyncEntity, id: string): CurationRow | undefined {
        const { key } = ENTITIES[entity];
        return this.db.prepare(`SELECT * FROM ${entity} WHERE ${key} = ?`).get(id) as
            | CurationRow
            | undefined;
    }

    private upsertRow(entity: SyncEntity, row: CurationRow): void {
        const { key } = ENTITIES[entity];
        // Column names come from the table itself, never from the row, so a
        // stray key in a caller's object cannot reach the SQL.
        const columns = (
            this.db.prepare(`PRAGMA table_info(${entity})`).all() as Array<{ name: string }>
        ).map((column) => column.name);

        const present = columns.filter((column) => row[column] !== undefined);
        const placeholders = present.map(() => '?').join(', ');
        const assignments = present
            .filter((column) => column !== key)
            .map((column) => `${column} = excluded.${column}`)
            .join(', ');

        this.db
            .prepare(
                `INSERT INTO ${entity} (${present.join(', ')}) VALUES (${placeholders})
                 ON CONFLICT(${key}) DO UPDATE SET ${assignments}`,
            )
            .run(...present.map((column) => normalise(row[column])));
    }

    /**
     * Write an inbound row, retiring any other row that claims the same track.
     *
     * `likes` and `track_flags` hold one row per track, and two devices that
     * each minted one for the same track before seeing the other's have two ids
     * for one fact — which the unique index on `jellyfinId` would otherwise turn
     * into a constraint failure on the second to arrive. The phone's
     * `mergeLike` and `mergeTrackFlags`, exactly: the newer `(updatedAt,
     * originDevice)` row wins and the other is deleted outright — hard, not
     * soft, because a row that lost to its twin is a duplicate to forget rather
     * than a delete to sync — and a row that loses to the twin already here is
     * ignored whole; nothing of it is written.
     */
    private writeDeduped(entity: SyncEntity, row: CurationRow): 'applied' | 'ignored' {
        const clash = ONE_ROW_PER_TRACK.has(entity)
            ? (this.db
                  .prepare(`SELECT * FROM ${entity} WHERE jellyfinId = ? AND id != ?`)
                  .get(String(row.jellyfinId), String(row.id)) as CurationRow | undefined)
            : undefined;

        if (clash && rowWinner(row, clash) !== 'incoming') return 'ignored';

        this.inTransaction(() => {
            if (clash) {
                this.db.prepare(`DELETE FROM ${entity} WHERE id = ?`).run(String(clash.id));
            }
            this.upsertRow(entity, row);
        });
        return 'applied';
    }
}

/**
 * Whether a stamp map says anything its row's own `updatedAt` does not.
 *
 * One that does not is stored as nothing, the same rule `mergeRows` applies:
 * a map every field of which equals the row timestamp is what a row *without*
 * one already means, and writing it out would make applying the same op twice
 * produce a different row the second time.
 */
const informative = (stamps: Stamps, updatedAt: number): boolean =>
    Object.values(stamps).some((stamp) => stamp !== updatedAt);

/**
 * Stamp only the fields whose value actually changed.
 *
 * Fields that did not change keep the stamp they had, falling back to the row's
 * previous `updatedAt` for a row written before any stamps existed. Stamping
 * every field on every save would make the last person to touch a playlist win
 * its notes too, which is the whole thing per-field merging prevents.
 */
const restampChangedFields = (
    previous: CurationRow | undefined,
    row: CurationRow,
    now: number,
): null | Stamps => {
    const previousStamps = previous ? stampsFromRow(previous) : {};
    const previousAt = Number(previous?.updatedAt ?? 0);

    const stamps: Stamps = {};
    for (const [field, value] of Object.entries(row)) {
        if (METADATA_COLUMNS.has(field)) continue;
        // Compared as SQLite stores them. The row read back holds 0 and 1
        // where the caller wrote true and false, and a boolean that merely
        // changed *type* on the way through is not an edit — stamping it as
        // one would restamp both taste flags on every write of either, which
        // is the whole-row merge per-field stamping exists to prevent.
        const unchanged = previous !== undefined && normalise(previous[field]) === normalise(value);
        stamps[field] = unchanged ? (previousStamps[field] ?? previousAt) : now;
    }

    // Nothing to say beyond the row's own timestamp — a brand new row, or an
    // edit that touched everything. Storing a map here would make applying the
    // same op twice produce a different row the second time.
    return Object.values(stamps).some((stamp) => stamp !== now) ? stamps : null;
};

/**
 * A stored row as it travels.
 *
 * Every other column travels under its own name — the payload *is* the row,
 * which is why the schema spells its columns the phone's way. The stamps are
 * the one exception, and the exception is about shape rather than spelling:
 * the *column* holds JSON text, the *key* holds the object, and a map that says
 * nothing beyond the row's own `updatedAt` is omitted rather than sent empty.
 *
 * `FIELD_STAMPS_COLUMN` and `FIELD_STAMPS_KEY` are the same string today and
 * both are still named, so which side of the boundary each line is on stays
 * readable — the delete removes the *column's* text, the assignment adds the
 * *wire's* object.
 */
const toPayload = (
    entity: SyncEntity,
    row: CurationRow,
    stamps: null | Stamps,
): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...row };
    delete payload[FIELD_STAMPS_COLUMN];
    if (stamps) payload[FIELD_STAMPS_KEY] = stamps;

    // SQLite gives 0 and 1 back; the phone needs true and false. Null stays
    // null — an absent optional is not the same as false, and the phone's
    // optionals decode it as such.
    for (const column of BOOLEAN_COLUMNS[entity]) {
        const value = payload[column];
        if (typeof value === 'number') payload[column] = value !== 0;
    }

    return payload;
};

/**
 * The reverse: a wire payload as a row, with the stamp key stripped back off.
 *
 * Stripped, not carried: the stamps reach the store through `stampsFromPayload`
 * and are written back as text by whoever decides what the merged map is. An
 * object left in here would be handed to SQLite as a bind parameter it cannot
 * take.
 */
const fromPayload = (payload: Record<string, unknown>): CurationRow => {
    const row = { ...payload } as CurationRow;
    delete row[FIELD_STAMPS_KEY];
    return row;
};

/**
 * Whether an inbound event is a later stage of the same listen than the stored one.
 *
 * Mirrors `SyncMerge.isMoreFinished` on the phone, including its strictness on
 * the equal case: two copies that ended at the same instant are the same copy,
 * and treating that as an update would make every replayed batch report work it
 * did not do.
 */
const isMoreFinished = (incoming: CurationRow, existing: { endedAt: null | number }): boolean => {
    const incomingEnd = incoming.endedAt;
    if (incomingEnd === null || incomingEnd === undefined) return false;
    if (existing.endedAt === null || existing.endedAt === undefined) return true;
    return Number(incomingEnd) > Number(existing.endedAt);
};

/** SQLite takes no booleans; everything else passes through untouched. */
const normalise = (value: boolean | null | number | string): null | number | string =>
    typeof value === 'boolean' ? Number(value) : value;
