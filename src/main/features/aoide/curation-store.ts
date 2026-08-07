import type { SyncEntity, SyncOp, SyncOperation } from '/@/shared/aoide/sync-types';
import type { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'node:crypto';

import { CurationDatabase, SERVER_CURSOR_KEY } from './database';

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

        const now = Date.now();
        const row: CurationRow = {
            ...values,
            origin_device: this.deviceId,
            // Every writer stamps its own clock. Whose clock to believe is the
            // merge's problem, not the writer's.
            updated_at: now,
            ...(softDeletes ? { deleted: operation === 'delete' ? 1 : 0 } : {}),
        };

        const op: SyncOp = {
            createdAt: now,
            entity,
            entityId: id,
            operation,
            // The idempotency key. Applying the same op twice must be a no-op,
            // which is what makes retry-after-timeout safe — and a client will
            // retry after a timeout.
            opId: randomUUID(),
            payload: row as Record<string, unknown>,
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

/** SQLite takes no booleans; everything else passes through untouched. */
const normalise = (value: boolean | null | number | string): null | number | string =>
    typeof value === 'boolean' ? Number(value) : value;
