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
    PER_FIELD_ENTITIES,
    Stamps,
    stampsFromPayload,
    stampsFromRow,
} from './merge';

/**
 * Which table each syncable entity lives in, and what identifies a row.
 *
 * The table names *are* the wire names. iOS translates at the wire boundary
 * because its tables predate the server's allow-list; nothing here predates
 * anything, so spelling them the server's way removes a whole class of bug —
 * a mistranslated entity name is every op of that kind refused forever.
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
    queue_state: { key: 'device_id', softDeletes: false },
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

        incoming.updated_at = correctForSkew(Number(incoming.updated_at ?? 0), receivedAt, now);
        if (softDeletes && op.operation === 'delete') incoming.deleted = 1;

        // Append-only, so there is nothing to merge and nothing to overwrite.
        // Re-applying the same event must not double-count a play.
        if (op.entity === 'play_events') {
            const already = this.db.prepare('SELECT 1 FROM play_events WHERE id = ?').get(id) as
                | undefined
                | { 1: number };
            if (already) return 'ignored';
            this.inTransaction(() => this.upsertRow(op.entity, incoming));
            return 'applied';
        }

        const existing = this.row(op.entity, id);

        if (!existing) {
            this.inTransaction(() => this.upsertRow(op.entity, incoming));
            return 'applied';
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

        this.inTransaction(() => this.upsertRow(op.entity, row));
        return 'applied';
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
    pendingOps(limit = 500): SyncOp[] {
        const rows = this.db
            .prepare('SELECT * FROM ops WHERE synced = 0 ORDER BY created_at, rowid LIMIT ?')
            .all(limit) as Array<{
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
        // the same millisecond otherwise carry the same `updated_at`, and the
        // second is then indistinguishable from the first: every other device
        // sees a tie, keeps what it has, and drops the newer write silently.
        // A delete issued straight after a create disappears exactly this way.
        //
        // Scoped to the row rather than the device on purpose. A global
        // monotonic clock would run ahead of real time during a bulk import —
        // a thousand rows, a thousand milliseconds — and a device that believes
        // it is in the future starts having its own writes skew-corrected.
        const previous = this.row(entity, id);
        const now = Math.max(Date.now(), Number(previous?.updated_at ?? 0) + 1);
        const row: CurationRow = {
            ...values,
            origin_device: this.deviceId,
            // Every writer stamps its own clock. Whose clock to believe is the
            // merge's problem, not the writer's.
            updated_at: now,
            ...(softDeletes ? { deleted: operation === 'delete' ? 1 : 0 } : {}),
        };

        // Only the fields this edit actually changed get today's stamp. Stamping
        // every field on every save would make the last person to touch a
        // playlist win its description too, which is the whole thing per-field
        // merging exists to prevent.
        const stamps = PER_FIELD_ENTITIES.has(entity)
            ? restampChangedFields(previous, row, now)
            : null;
        if (PER_FIELD_ENTITIES.has(entity)) {
            row[FIELD_STAMPS_COLUMN] = stamps ? JSON.stringify(stamps) : null;
        }

        const op: SyncOp = {
            createdAt: now,
            entity,
            entityId: id,
            operation,
            // The idempotency key. Applying the same op twice must be a no-op,
            // which is what makes retry-after-timeout safe — and a client will
            // retry after a timeout.
            opId: randomUUID(),
            payload: toPayload(row, stamps),
        };

        this.inTransaction(() => {
            this.upsertRow(entity, row);
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
}

const STRUCTURAL_COLUMNS = new Set([
    'device_id',
    FIELD_STAMPS_COLUMN,
    'id',
    'origin_device',
    'updated_at',
]);

/**
 * Stamp only the fields whose value actually changed.
 *
 * Fields that did not change keep the stamp they had, falling back to the row's
 * previous `updated_at` for a row written before any stamps existed. Stamping
 * every field on every save would make the last person to touch a playlist win
 * its description too, which is the whole thing per-field merging prevents.
 */
const restampChangedFields = (
    previous: CurationRow | undefined,
    row: CurationRow,
    now: number,
): null | Stamps => {
    const previousStamps = previous ? stampsFromRow(previous) : {};
    const previousAt = Number(previous?.updated_at ?? 0);

    const stamps: Stamps = {};
    for (const [field, value] of Object.entries(row)) {
        if (STRUCTURAL_COLUMNS.has(field)) continue;
        const unchanged = previous !== undefined && previous[field] === value;
        stamps[field] = unchanged ? (previousStamps[field] ?? previousAt) : now;
    }

    // Nothing to say beyond the row's own timestamp — a brand new row, or an
    // edit that touched everything. Storing a map here would make applying the
    // same op twice produce a different row the second time.
    return Object.values(stamps).some((stamp) => stamp !== now) ? stamps : null;
};

/**
 * A stored row as it travels: the local stamp *column* becomes the wire's
 * `fieldUpdatedAt` *key*, and is omitted entirely when it says nothing.
 */
const toPayload = (row: CurationRow, stamps: null | Stamps): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...row };
    delete payload[FIELD_STAMPS_COLUMN];
    if (stamps) payload[FIELD_STAMPS_KEY] = stamps;
    return payload;
};

/** The reverse: a wire payload as a row, with the stamp key stripped back off. */
const fromPayload = (payload: Record<string, unknown>): CurationRow => {
    const row = { ...payload } as CurationRow;
    delete row[FIELD_STAMPS_KEY];
    return row;
};

/** SQLite takes no booleans; everything else passes through untouched. */
const normalise = (value: boolean | null | number | string): null | number | string =>
    typeof value === 'boolean' ? Number(value) : value;
