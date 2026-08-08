import { partitionRejections, QuarantineOutcome, ShareRevokedOutcome, SyncError } from './errors';

import {
    imageHashesInOp,
    PlaylistShare,
    PullResponse,
    PushResponse,
    QueueEntry,
    SyncOp,
} from '/@/shared/aoide/sync-types';

/**
 * The sync loop, and nothing else.
 *
 * It owns no transport and no database: both arrive as interfaces, because the
 * store lives in the main process behind IPC and the server lives on the far
 * side of a network, and neither belongs in a test of the *order* things happen
 * in. Every rule below cost something to learn, and each is one somebody will
 * later look at and think could be simplified:
 *
 * 1. **Upload a blob before pushing the op that names it.** An op naming a hash
 *    the server does not hold leaves every other device with a cover it can
 *    never fetch, and nothing notices — the row is perfectly valid, the image
 *    simply is not there.
 * 2. **Push before pull**, so this device's own ops come back with a sequence
 *    number, which is how it learns they were durably accepted.
 * 3. **The push response's cursor is the server's HEAD and is not a pull
 *    cursor.** Ops from other devices sit below it that this one has never seen;
 *    storing it as the pull cursor skips them permanently.
 * 4. **Store the pull cursor only after a whole batch has applied**, so an
 *    interrupted sync replays rather than skips.
 * 5. **Always complete a pull, even with nothing to push.** Since sidecar
 *    1.7.0.0 the server's pruning is bounded by the lowest cursor among devices
 *    seen recently, and it learns those cursors from `GET /pull`. A device that
 *    only ever pushes is invisible to that guard and its own history can be
 *    pruned out from under it.
 * 6. **A 5xx is bisected**, not retried. Retrying the same bytes forever wedges
 *    every innocent change behind one the server cannot swallow.
 */

/**
 * How many pages one `sync()` will pull before stopping.
 *
 * A server that never stops saying `hasMore` must not be able to keep this loop
 * running for the life of the application. Stopping costs nothing at all: the
 * cursor is stored per batch, so the next sync resumes exactly where this one
 * left off.
 */
export const MAX_PULL_PAGES = 1000;

/**
 * How long a share refusal is believed before the list is read again.
 *
 * A blocked edit is not re-pushed, so the refusal that blocked it cannot happen
 * a second time and nothing else would ever ask. Without a periodic re-read the
 * only way back for an edit whose share was restored is restarting the
 * application, and the person's change sits in the log meanwhile with nothing
 * trying. Five minutes is well under the patience of somebody who has just been
 * re-added to a playlist and far above the cost of one extra request.
 */
export const SHARE_RECHECK_MS = 5 * 60_000;

export type MaybePromise<T> = Promise<T> | T;

/** Bytes on their way to the server, as the store hands them over. */
export interface OutboundImage {
    bytes: Uint8Array;
    mime: string;
    sha256: string;
}

/**
 * An edit refused because a playlist's share was revoked while it sat queued.
 *
 * **Not quarantined and not dropped.** It is the one refusal that a later sync
 * could see accepted, so the op stays in the log; but it is also not retried
 * blindly, because a share that really is gone would refuse it again on every
 * sync forever. It is blocked and reported here, so something can tell the
 * person their change has not gone anywhere — on this run and on every run
 * afterwards, through `SyncResult.blocked`, until a re-read of the share list
 * lets it go.
 */
export interface RevokedEdit {
    opId: string;
    playlistId: null | string;
    reason: string;
    /**
     * Whether `/aoide/shares` lists that playlist as editable by this user.
     *
     * `null` means the question was not answered on this run — the list could
     * not be read, or it had already been read before the push that produced
     * this refusal and re-reading it is the next run's job. Unknown is not the
     * same as gone, and nothing downstream should decide an edit is lost on the
     * strength of a request that failed or was not made.
     */
    stillShared: boolean | null;
}

export interface SyncEngineOptions {
    /**
     * The clock, injectable only so a test can pass `SHARE_RECHECK_MS` without
     * waiting five real minutes for it.
     */
    now?: () => number;
    /** Ops per pull page. Left to the client's own default when absent. */
    pullLimit?: number;
    /** Ops per push. Left to the store's own default when absent. */
    pushLimit?: number;
    store: SyncStore;
    transport: SyncTransport;
    /**
     * This user's Jellyfin id, used only to tell a collaborator's op from this
     * user's own. Optional, and its absence is safe in the right direction: an
     * engine that does not know whose it is treats every attributed op as
     * somebody else's rather than claiming it.
     */
    userId?: string;
}

/**
 * What one `sync()` did, and everything that went wrong while it did it.
 *
 * Failures are returned rather than thrown because the loop deliberately
 * continues past most of them — a cover that will not upload must not stop the
 * push, and a push that fails must not stop the pull, since the pull is what
 * keeps this device visible to the server's retention guard.
 */
export interface SyncResult {
    /** Inbound ops that changed a stored row. The rest were already known. */
    applied: number;
    /**
     * Every edit currently held back for want of a share, not only the ones
     * refused on this run.
     *
     * `revoked` is a report of what happened here and is therefore empty on
     * every run after the one that saw the refusal — the op is no longer pushed,
     * so it can never be refused again. An edit that is only ever named once and
     * then disappears from every report is an edit the person has lost with
     * nothing on screen saying so, which is why this list is unconditional.
     */
    blocked: RevokedEdit[];
    /** The pull cursor as stored when this run finished. */
    cursor: number;
    /**
     * Distinct `authorUserId`s seen in the pull that are not this user — the
     * collaborators whose edits arrived. With no `userId` configured every named
     * author lands here, because an engine that was never told whose it is
     * cannot claim anybody's op as its own.
     */
    foreignAuthors: string[];
    /** Ops kept back because a cover they name is not on the server yet. */
    heldBack: string[];
    /** Covers that would not upload. Never fatal; the op naming one simply waits. */
    imageErrors: SyncError[];
    /** Inbound ops received, including ones that merged to no change. */
    pulled: number;
    pullError?: SyncError;
    /** Ops the server accepted and this device marked synced. */
    pushed: number;
    pushError?: SyncError;
    quarantined: QuarantineOutcome[];
    revoked: RevokedEdit[];
    /** Set when `revoked` is non-empty and the share list could not be re-read. */
    shareError?: SyncError;
    /** The share list as re-read after a revoked edit, when it could be read. */
    shares?: PlaylistShare[];
    uploaded: string[];
}

/**
 * The local store, as the loop needs it.
 *
 * Deliberately small, and deliberately not `CurationStore`: that class lives in
 * the main process and holds a `node:sqlite` handle, so an engine typed against
 * it could not run in the renderer and could not be tested without a database.
 * Everything may return a promise because the real implementation is an IPC
 * bridge, and may return a plain value so a same-process adapter needs no
 * wrapping.
 */
export interface SyncStore {
    /**
     * Apply an inbound op, writing the row and **appending no op of its own**.
     * `receivedAt` is the server's clock reading for the push that carried it.
     */
    applyRemote(op: SyncOp, receivedAt?: number): MaybePromise<'applied' | 'ignored'>;
    /** Where the last completed pull left off. `0` on a device that has never synced. */
    cursor(): MaybePromise<number>;
    /**
     * Blobs these ops name that this device holds and the server has not been
     * given. The hashes are read out of the ops themselves, so an op and its
     * blob requirement cannot drift apart.
     */
    imagesToUpload(ops: SyncOp[]): MaybePromise<OutboundImage[]>;
    markSynced(opIds: string[]): MaybePromise<void>;
    markUploaded(sha256: string): MaybePromise<void>;
    /** Oldest first. Order matters: the server assigns sequence numbers as it receives them. */
    pendingOps(limit?: number): MaybePromise<SyncOp[]>;
    quarantine(opId: string, reason: string): MaybePromise<void>;
    setCursor(cursor: number): MaybePromise<void>;
}

/**
 * The server, as the loop needs it.
 *
 * `SidecarClient` satisfies this structurally. Taking the interface rather than
 * the class is what lets the ordering rules be tested with a stub that records
 * calls and no network at all.
 */
export interface SyncTransport {
    hasImage(sha256: string): Promise<boolean>;
    listShares(): Promise<PlaylistShare[]>;
    pull(since: number, limit?: number): Promise<PullResponse>;
    push(ops: SyncOp[]): Promise<PushResponse>;
    putImage(sha256: string, bytes: Uint8Array, mime: string): Promise<void>;
}

/**
 * Which of the other devices to offer a queue from.
 *
 * **Freshness is judged on the server's clock — `ageSeconds`, or `receivedAt` —
 * and never on `updatedAt`.** `updatedAt` comes from the writing device, so a
 * machine whose clock is set to next year would claim to be the most recent one
 * forever and win every handover, and the user would be offered a queue from
 * whichever of their machines is most wrong about the time rather than the one
 * they were last listening on.
 *
 * The server already sorts these, and re-deriving the order here cannot disagree
 * with it while trusting array position would silently inherit whatever the
 * server sorted by.
 */
export const handoffTarget = (entries: QueueEntry[]): QueueEntry | undefined => {
    const others = entries.filter((entry) => !entry.isCurrentDevice);
    if (others.length === 0) return undefined;

    // One criterion for the whole list, chosen once. Ranking each entry by
    // whichever field it happens to carry would compare seconds against
    // milliseconds, and an entry with only a receipt time would beat every entry
    // measured in age no matter how stale it was.
    const byAge = others.every((entry) => Number.isFinite(entry.ageSeconds));

    return [...others].sort((a, b) =>
        byAge ? a.ageSeconds - b.ageSeconds : (b.receivedAt ?? 0) - (a.receivedAt ?? 0),
    )[0];
};

/** True when either half of the loop failed outright. */
export const syncFailed = (result: SyncResult): boolean =>
    result.pullError !== undefined || result.pushError !== undefined;

/** True when the failure was the token rather than the data, so retrying cannot help. */
export const syncNeedsSignIn = (result: SyncResult): boolean =>
    result.pullError?.kind === 'auth' || result.pushError?.kind === 'auth';

export class SyncEngine {
    /**
     * The edits held back for want of a share, for a screen that wants to show
     * them between syncs. Copies: nothing outside may edit what the engine is
     * still deciding about.
     */
    get blockedEdits(): RevokedEdit[] {
        return [...this.blocked.values()].map(copyEdit);
    }

    /**
     * Ops refused because a share was revoked, by op id.
     *
     * In memory on purpose. Persisting it would need a schema change and would
     * make a refusal survive the restart that is the cheapest way to re-ask the
     * server whether access came back. Restarting costs one refused push per
     * affected playlist, which is not a loop; leaving them unblocked would cost
     * one on every sync forever, which is.
     *
     * The whole edit is kept rather than the id alone, because the way out of
     * this map is a re-read of the share list and that needs each entry's
     * playlist — and because a screen showing the person what has not gone
     * anywhere needs the reason too.
     */
    private readonly blocked = new Map<string, RevokedEdit>();

    private readonly now: () => number;

    private readonly pullLimit?: number;

    private readonly pushLimit?: number;

    /**
     * The run in flight, if any.
     *
     * Two syncs at once would push the same ops twice — harmless, ops are
     * idempotent — and interleave their cursor writes, which is not: the slower
     * run's `setCursor` can drag the cursor back over batches the faster one
     * already applied. Replaying is safe but pointless work, and joining the
     * existing run is simpler than reasoning about when it is not.
     */
    private running: null | Promise<SyncResult> = null;

    /** When the share list was last read. `0` means never, and never is not stale. */
    private sharesCheckedAt = 0;

    private readonly store: SyncStore;

    private readonly transport: SyncTransport;

    private readonly userId?: string;

    constructor(options: SyncEngineOptions) {
        this.store = options.store;
        this.transport = options.transport;
        this.pullLimit = options.pullLimit;
        this.pushLimit = options.pushLimit;
        this.userId = options.userId;
        this.now = options.now ?? Date.now;
    }

    /** Run the loop once. Concurrent callers join the run already in flight. */
    async sync(): Promise<SyncResult> {
        this.running ??= this.run().finally(() => {
            this.running = null;
        });

        return this.running;
    }

    private async applyBatch(batch: PullResponse, result: SyncResult, authors: Set<string>) {
        for (const op of batch.ops) {
            result.pulled += 1;

            // An op carries the Jellyfin user who wrote it, and on a shared
            // playlist that is somebody else. It is recorded, never claimed:
            // nothing here may treat a pulled op as evidence that something this
            // device queued was accepted. Only the ids a *push* named back reach
            // `markSynced`, which is why a pulled op that happens to share an
            // opId with a pending local op still leaves that op pending.
            if (op.authorUserId !== undefined && op.authorUserId !== this.userId) {
                authors.add(op.authorUserId);
            }

            // Skew is judged against the receipt of the push that carried this
            // op, which is what `op.receivedAt` is: ops pushed together share
            // one. That makes the correction a judgement about the writing
            // device's clock at the moment it pushed, applied uniformly across
            // everything in that push — there is nothing per-op to infer from a
            // number every op in the batch shares.
            //
            // It is also why no receipt is ever borrowed from a neighbouring op.
            // One pulled page routinely carries several devices' pushes, so the
            // op above this one is quite likely a different device's; lending it
            // that receipt would invent evidence about a clock nobody measured,
            // and `correctForSkew` would then drag a perfectly good row's
            // timestamp backwards on the strength of it.
            if ((await this.store.applyRemote(op, op.receivedAt)) === 'applied') {
                result.applied += 1;
            }
        }
    }

    /**
     * Whether a share row is evidence that **this** user may edit that playlist.
     *
     * A share names the person it was granted to, and `/aoide/shares` lists more
     * than this user's own grants. Taking `canEdit` alone therefore unblocks an
     * edit on the strength of somebody else's access: the playlist was re-shared
     * with a third party, this user is still locked out, and the op goes back to
     * being refused on every sync — the loop the block list exists to prevent.
     *
     * An absent `ownerUserId` means the playlist is this user's own, in which
     * case the grantee is whoever *they* shared it with and their own right to
     * edit was never in question.
     *
     * With no `userId` configured a named grant cannot be told from a stranger's,
     * and the safe direction is the same one the engine takes with op authorship:
     * assume somebody else's. A wrong "not mine" leaves the edit blocked and
     * visible in `blocked`; a wrong "mine" is a refused push every sync forever.
     */
    private grantsEditToThisUser(share: PlaylistShare): boolean {
        if (!share.canEdit) return false;
        if (share.ownerUserId === undefined) return true;
        return share.ownerUserId === this.userId || share.granteeUserId === this.userId;
    }

    /**
     * Pending ops with the share-blocked ones taken out, widening the store's
     * page until something pushable is in it.
     *
     * Blocked ops are the oldest unsynced rows in the log — they were pushed and
     * refused, and everything newer queued behind them — so they arrive at the
     * head of every page the store hands back. Filtering them out *after* a
     * LIMIT they fill entirely leaves nothing to push and starves every later
     * edit for as long as the share stays gone, which turns a few skipped ops
     * into a device that has silently stopped syncing.
     *
     * The store's own default limit is unknowable from here, so the page that
     * came back is what a wider request is measured against: ask again only when
     * the whole page was blocked, and stop as soon as a request returns no more
     * rows than the last one, which is the log ending rather than the limit
     * biting.
     */
    private async pendingUnblocked(): Promise<SyncOp[]> {
        let limit = this.pushLimit;
        let widest = 0;

        for (;;) {
            const page = await this.store.pendingOps(limit);
            const pushable = page.filter((op) => !this.blocked.has(op.opId));

            if (pushable.length > 0 || page.length <= widest) return pushable;

            widest = page.length;
            limit = page.length + this.blocked.size;
        }
    }

    /**
     * Read everything from the stored cursor forward.
     *
     * Runs even when there was nothing to push and even when the push failed.
     * The server learns each device's cursor from this request and prunes no
     * further back than the lowest one among devices seen recently, so a device
     * that only ever pushes is invisible to that guard and can have its own
     * history pruned away.
     */
    private async pullAll(result: SyncResult): Promise<void> {
        const authors = new Set<string>();
        let cursor = 0;

        try {
            // Inside the try with everything else, so that `sync()` resolves
            // whatever happens. A caller scheduling this on a timer should never
            // have to decide between catching and losing the rest of the report.
            cursor = await this.store.cursor();
            result.cursor = cursor;

            for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
                const batch = await this.transport.pull(cursor, this.pullLimit);
                await this.applyBatch(batch, result, authors);

                // Only now, and only for this batch. Storing it before applying
                // would turn an interruption into a permanent skip; storing the
                // last page's cursor for all of them would do the same to every
                // page that did not finish.
                if (batch.cursor > cursor) {
                    cursor = batch.cursor;
                    await this.store.setCursor(cursor);
                    result.cursor = cursor;
                } else if (batch.hasMore) {
                    // `hasMore` with a cursor that did not move is a loop with no
                    // exit. Stopping leaves the cursor where it was, so the next
                    // sync tries the same page again rather than skipping it.
                    break;
                }

                if (!batch.hasMore) break;
            }
        } catch (error) {
            result.pullError = asSyncError(error);
        }

        result.foreignAuthors = [...authors];
    }

    /**
     * Send `ops`, and on a 5xx find the one the server cannot swallow.
     *
     * Halves that succeed are pushed on the way past, so bisecting costs the
     * innocent ops nothing but a little latency. An op that still 5xxs when it
     * is the only thing in the request is quarantined alone; a fault that stops
     * reproducing once ops are sent singly blames nothing at all, which is the
     * transient case and the reason this does not simply quarantine the last op
     * standing.
     *
     * Only `serverFault` is bisected. A whole-request `permanent` refusal is
     * about the request rather than about any op inside it — the server has
     * `rejected` for per-op refusals and uses it — so bisecting one would
     * quarantine an innocent op and lose a real edit.
     */
    private async pushBisecting(ops: SyncOp[], result: SyncResult): Promise<void> {
        if (ops.length === 0) return;

        let response: PushResponse;

        try {
            response = await this.transport.push(ops);
        } catch (error) {
            if (!(error instanceof SyncError) || error.kind !== 'serverFault') throw error;

            if (ops.length === 1) {
                const reason = `The server failed on this op alone: ${error.displayMessage}`;
                await this.store.quarantine(ops[0].opId, reason);
                result.quarantined.push({ kind: 'quarantine', opId: ops[0].opId, reason });
                return;
            }

            const middle = Math.floor(ops.length / 2);
            await this.pushBisecting(ops.slice(0, middle), result);
            await this.pushBisecting(ops.slice(middle), result);
            return;
        }

        // Only the ids the server named back. Marking anything else synced loses
        // it silently — and the cursor in this response is the server's head,
        // not a pull cursor, so it is not stored anywhere.
        if (response.accepted.length > 0) {
            await this.store.markSynced(response.accepted);
            result.pushed += response.accepted.length;
        }

        const sent = new Map(ops.map((op) => [op.opId, op]));
        const { quarantine, shareRevoked } = partitionRejections(response.rejected ?? [], sent);

        for (const outcome of quarantine) {
            await this.store.quarantine(outcome.opId, outcome.reason || 'Refused by the server');
            result.quarantined.push(outcome);
        }

        for (const outcome of shareRevoked) {
            // One object in both places, so `refreshShares` filling in
            // `stillShared` later in this run fills it in for the report too.
            // `run` copies them on the way out, so a later run's re-check
            // cannot reach into a result somebody already stored.
            const edit = toRevokedEdit(outcome);
            this.blocked.set(outcome.opId, edit);
            result.revoked.push(edit);
        }
    }

    /**
     * Re-read the share list and let go of every edit it says is editable again.
     *
     * Once for the whole run, however many edits are blocked: it is the same
     * question each time, and asking it per op would hammer the endpoint exactly
     * when a collaborative playlist has just been un-shared from several devices
     * at once.
     *
     * Every blocked edit is re-judged, not only the ones this run's push
     * refused, because after that first run there are no refusals left to react
     * to — the op is not pushed any more — and an edit nothing ever re-asks
     * about is an edit the person has lost.
     */
    private async refreshShares(result: SyncResult): Promise<void> {
        let shares: PlaylistShare[];

        // Stamped whichever way it goes. A device with no route to the server
        // must back off exactly like one that got an answer, or every sync for
        // the whole outage spends a request re-asking a question that cannot be
        // answered.
        this.sharesCheckedAt = this.now();

        try {
            shares = await this.transport.listShares();
        } catch (error) {
            // Unknown is not gone. `stillShared` stays null and the edit is still
            // surfaced; what must not happen is anything downstream concluding
            // the playlist is lost because one request failed.
            result.shareError = asSyncError(error);
            return;
        }

        const editable = new Set(
            shares
                .filter((share) => this.grantsEditToThisUser(share))
                .map((share) => share.playlistId),
        );
        result.shares = shares;

        for (const edit of this.blocked.values()) {
            if (edit.playlistId === null) continue;
            edit.stillShared = editable.has(edit.playlistId);

            // Access came back, so the refusal is stale. Unblocking puts the op
            // back in front of the very next push rather than leaving it stuck
            // behind a condition that has passed.
            if (edit.stillShared) this.blocked.delete(edit.opId);
        }
    }

    private async run(): Promise<SyncResult> {
        const result: SyncResult = {
            applied: 0,
            blocked: [],
            cursor: 0,
            foreignAuthors: [],
            heldBack: [],
            imageErrors: [],
            pulled: 0,
            pushed: 0,
            quarantined: [],
            revoked: [],
            uploaded: [],
        };

        // 0. Ask again whether a blocked edit may go out, before deciding what
        //    is pushable. Nothing else will ask: a blocked op is not pushed, so
        //    it cannot be refused a second time, and the refusal is the only
        //    other thing that reads the share list. Without this the person's
        //    edit waits for an application restart with nothing trying.
        let sharesRead = false;
        if (this.blocked.size > 0 && this.now() - this.sharesCheckedAt >= SHARE_RECHECK_MS) {
            await this.refreshShares(result);
            sharesRead = true;
        }

        let pending: SyncOp[] = [];

        try {
            pending = await this.pendingUnblocked();
        } catch (error) {
            // A store that cannot be read has nothing to push, which is not the
            // same as having nothing to push. Recorded and carried on with,
            // because the pull below is what keeps this device visible to the
            // server's retention guard and is worth attempting either way.
            result.pushError = asSyncError(error);
        }

        // 1. Blobs first, always. An op naming a hash the server does not hold
        //    leaves every other device with a cover it can never fetch, and
        //    nothing afterwards reports it: the row is perfectly valid.
        const withheld = await this.uploadImages(pending, result);

        const pushable = pending.filter((op) => {
            if (!imageHashesInOp(op).some((hash) => withheld.has(hash))) return true;
            // A cover that will not upload does not fail the sync. Everything
            // else still pushes and this op waits — a playlist arriving without
            // its picture a few minutes late is much smaller than a device that
            // stops syncing because one image would not go.
            result.heldBack.push(op.opId);
            return false;
        });

        // 2-4. Push, mark accepted, deal with refusals.
        if (pushable.length > 0) {
            try {
                await this.pushBisecting(pushable, result);
            } catch (error) {
                // Recorded rather than thrown, because the pull below still has
                // to happen: it is what keeps this device visible to the
                // server's retention guard.
                result.pushError = asSyncError(error);
            }
        }

        if (!sharesRead && result.revoked.length > 0) await this.refreshShares(result);

        // 5-6. Pull, apply, then store each batch's cursor. Unconditionally.
        await this.pullAll(result);

        // Copies, both of them. The entries are the engine's own and a later
        // run's re-check writes `stillShared` on them; handing the live objects
        // out would let a result somebody stored and rendered change underneath
        // them long after the run that produced it finished.
        result.revoked = result.revoked.map(copyEdit);
        result.blocked = this.blockedEdits;

        return result;
    }

    /**
     * Give the server every cover a pending op names and it does not hold.
     *
     * Returns the hashes that did not make it, so the ops naming them can be
     * held back. A failure here is never fatal: everything not waiting on a
     * cover still pushes, and the retry finds the blob again next time.
     */
    private async uploadImages(ops: SyncOp[], result: SyncResult): Promise<Set<string>> {
        const withheld = new Set<string>();
        let images: OutboundImage[];

        try {
            images = await this.store.imagesToUpload(ops);
        } catch (error) {
            // Which covers the server is missing is now unanswerable, so every
            // op that names one waits. Pushing them on the assumption that
            // nothing was needed is exactly the failure the ordering rule
            // exists to prevent, and it is the failure nothing afterwards
            // reports. Ops naming no cover are unaffected and still go.
            result.imageErrors.push(asSyncError(error));
            for (const op of ops) {
                for (const hash of imageHashesInOp(op)) withheld.add(hash);
            }
            return withheld;
        }

        for (const image of images) {
            try {
                // Ask before sending. Content addressing means another device
                // may have given the server these exact bytes already — two
                // playlists sharing a cover, or a cover that came from the phone
                // — and a HEAD is a great deal cheaper than a picture.
                if (!(await this.transport.hasImage(image.sha256))) {
                    await this.transport.putImage(image.sha256, image.bytes, image.mime);
                }

                // Only after the server really has them. Marking optimistically
                // would unblock the push of an op naming a cover that never
                // arrived, which is the one failure this ordering exists to make
                // impossible.
                await this.store.markUploaded(image.sha256);
                result.uploaded.push(image.sha256);
            } catch (error) {
                withheld.add(image.sha256);
                result.imageErrors.push(asSyncError(error));
            }
        }

        return withheld;
    }
}

/**
 * Anything thrown, as a `SyncError`.
 *
 * An exception that is not one already came from the store or the IPC bridge
 * rather than from the server, and `transient` is the right guess for those: a
 * bridge that was not ready is the common case and it recovers on its own. It is
 * still reported whole, because a summarised error has been useless three times
 * in this system already.
 */
const asSyncError = (error: unknown): SyncError =>
    error instanceof SyncError
        ? error
        : new SyncError('transient', error instanceof Error ? error.message : String(error));

const copyEdit = (edit: RevokedEdit): RevokedEdit => ({ ...edit });

const toRevokedEdit = (outcome: ShareRevokedOutcome): RevokedEdit => ({
    opId: outcome.opId,
    playlistId: outcome.playlistId,
    reason: outcome.reason,
    // Filled in by `refreshShares`. Null until then, and null forever if the
    // share list could not be read.
    stillShared: null,
});
