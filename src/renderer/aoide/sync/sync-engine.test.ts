import { beforeEach, describe, expect, it } from 'vitest';

import { classifyRejection, partitionRejections, SyncError } from './errors';
import {
    handoffTarget,
    MAX_PULL_PAGES,
    OutboundImage,
    SHARE_RECHECK_MS,
    SyncEngine,
    SyncEngineOptions,
    syncFailed,
    SyncStore,
    SyncTransport,
} from './sync-engine';

import {
    imageHashesInOp,
    PlaylistShare,
    PullResponse,
    QueueEntry,
    SyncOp,
} from '/@/shared/aoide/sync-types';

/**
 * Every rule tested here is one somebody will later look at and think could be
 * simplified. Each cost something to learn once already:
 *
 * - blobs upload before the push that names them;
 * - the push response's cursor is never stored as the pull cursor;
 * - a batch's cursor is stored only after the batch has applied;
 * - a 5xx is bisected to one op rather than retried;
 * - a refusal is quarantined, except the one that a restored share would fix;
 * - a pull happens even when there was nothing to push.
 */

const REVOKED = "Playlist 'p1' belongs to another user and is not shared with you for editing.";

const op = (overrides: Partial<SyncOp> = {}): SyncOp => ({
    createdAt: 1,
    entity: 'playlists',
    entityId: 'playlist-1',
    operation: 'upsert',
    opId: 'op-1',
    payload: {},
    ...overrides,
});

const page = (overrides: Partial<PullResponse> = {}): PullResponse => ({
    cursor: 0,
    hasMore: false,
    ops: [],
    ...overrides,
});

interface Harness {
    /** Every call, in the order it happened. The ordering rules are assertions on this. */
    log: string[];
    pullPages: PullResponse[];
    pushHandler: (ops: SyncOp[]) => {
        accepted: string[];
        cursor: number;
        rejected?: RejectedLike[];
    };
    serverHas: Set<string>;
    shares: PlaylistShare[];
    sharesFail: boolean;
    state: StoreState;
    store: SyncStore;
    transport: SyncTransport;
    /** Hashes whose PUT throws, standing in for a cover that will not upload. */
    uploadFails: Set<string>;
}

interface RejectedLike {
    opId: string;
    reason?: string;
}

interface StoreState {
    applied: Array<{ opId: string; receivedAt: number | undefined }>;
    /** Op ids `applyRemote` should throw on, to interrupt a batch part way. */
    applyThrowsOn: Set<string>;
    cursor: number;
    cursorWrites: number[];
    images: OutboundImage[];
    markedUploaded: string[];
    pending: SyncOp[];
    quarantined: Array<{ opId: string; reason: string }>;
    synced: string[];
}

const harness = (): Harness => {
    const log: string[] = [];

    const state: StoreState = {
        applied: [],
        applyThrowsOn: new Set(),
        cursor: 0,
        cursorWrites: [],
        images: [],
        markedUploaded: [],
        pending: [],
        quarantined: [],
        synced: [],
    };

    const rig: Harness = {
        log,
        pullPages: [],
        pushHandler: (ops) => ({ accepted: ops.map((each) => each.opId), cursor: 999 }),
        serverHas: new Set<string>(),
        shares: [],
        sharesFail: false,
        state,
        store: {
            applyRemote(remote, receivedAt) {
                log.push(`apply:${remote.opId}`);
                if (state.applyThrowsOn.has(remote.opId)) {
                    throw new Error(`the store refused ${remote.opId}`);
                }
                state.applied.push({ opId: remote.opId, receivedAt });
                return 'applied';
            },
            cursor: () => state.cursor,
            // Faithful to the real store: only blobs these ops actually name,
            // and only ones the server has not been told about.
            imagesToUpload(ops) {
                log.push('imagesToUpload');
                const named = new Set(ops.flatMap(imageHashesInOp));
                return state.images.filter(
                    (image) =>
                        named.has(image.sha256) && !state.markedUploaded.includes(image.sha256),
                );
            },
            markSynced(opIds) {
                log.push(`markSynced:${opIds.join(',')}`);
                state.synced.push(...opIds);
            },
            markUploaded(sha256) {
                state.markedUploaded.push(sha256);
            },
            // Faithful to the real store, which applies a LIMIT in SQL: the
            // caller gets a page, not the log. Ignoring the limit here would
            // hide anything that only goes wrong when the page is full.
            pendingOps(limit = 500) {
                log.push(`pendingOps:${limit}`);
                return state.pending.slice(0, limit);
            },
            quarantine(opId, reason) {
                log.push(`quarantine:${opId}`);
                state.quarantined.push({ opId, reason });
            },
            setCursor(cursor) {
                log.push(`setCursor:${cursor}`);
                state.cursor = cursor;
                state.cursorWrites.push(cursor);
            },
        },
        transport: {
            async hasImage(sha256) {
                log.push(`head:${sha256}`);
                return rig.serverHas.has(sha256);
            },
            async listShares() {
                log.push('listShares');
                if (rig.sharesFail) throw new SyncError('transient', 'shares unreachable');
                return rig.shares;
            },
            async pull(since) {
                log.push(`pull:${since}`);
                return rig.pullPages.shift() ?? page({ cursor: since });
            },
            async push(ops) {
                log.push(`push:${ops.map((each) => each.opId).join(',')}`);
                const response = rig.pushHandler(ops);
                return { ...response, rejected: response.rejected ?? [] };
            },
            async putImage(sha256) {
                log.push(`put:${sha256}`);
                if (rig.uploadFails.has(sha256)) {
                    throw new SyncError('transient', `${sha256} would not upload`);
                }
            },
        },
        uploadFails: new Set<string>(),
    };

    return rig;
};

const engineFor = (h: Harness, userId?: string, extra: Partial<SyncEngineOptions> = {}) =>
    new SyncEngine({ store: h.store, transport: h.transport, userId, ...extra });

/**
 * Where something first happened, so ordering can be asserted without exact logs.
 *
 * It throws rather than returning -1, and that is the whole point of it. Every
 * caller compares two of these with `toBeLessThan`, and -1 is less than every
 * index there is — so a missing step read as a step that happened early, and the
 * ordering rule that matters most here would have passed with no upload at all.
 */
const at = (log: string[], prefix: string): number => {
    const index = log.findIndex((entry) => entry.startsWith(prefix));
    if (index === -1) throw new Error(`nothing in the log starts with ${prefix}: ${log.join(' ')}`);
    return index;
};

/** A promise something else resolves, for holding a run open mid-flight. */
const gate = () => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open: () => open(), opened };
};

describe('SyncEngine', () => {
    let h: Harness;

    beforeEach(() => {
        h = harness();
    });

    describe('the order of the loop', () => {
        it('uploads a cover before pushing the op that names it, and pulls after both', async () => {
            h.state.pending = [op({ payload: { imageHash: 'aa11' } })];
            h.state.images = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', sha256: 'aa11' }];

            await engineFor(h).sync();

            // That the upload *happened* is half the rule and the half an
            // ordering assertion cannot state: a run that never uploaded at all
            // satisfies every "before" there is.
            expect(h.log).toContain('put:aa11');
            expect(h.state.markedUploaded).toEqual(['aa11']);

            // An op naming a hash the server does not hold leaves every other
            // device with a cover it can never fetch, and nothing notices.
            expect(at(h.log, 'put:')).toBeLessThan(at(h.log, 'push:'));
            expect(at(h.log, 'push:')).toBeLessThan(at(h.log, 'pull:'));
        });

        it('joins a run already in flight rather than starting a second one', async () => {
            const held = gate();
            h.pullPages = [page({ cursor: 42 })];
            const pull = h.transport.pull.bind(h.transport);
            h.transport.pull = async (since, limit) => {
                await held.opened;
                return pull(since, limit);
            };

            const engine = engineFor(h);
            const first = engine.sync();
            const second = engine.sync();
            held.open();
            const [a, b] = await Promise.all([first, second]);

            // Two runs would push the same ops twice, which is harmless, and
            // interleave their cursor writes, which is not: the slower one's
            // setCursor drags the cursor back over batches the faster one has
            // already applied, and the next sync re-applies them.
            expect(a).toBe(b);
            expect(h.log.filter((entry) => entry.startsWith('pull:'))).toEqual(['pull:0']);
            expect(h.state.cursorWrites).toEqual([42]);
        });

        it('starts a fresh run once the one in flight has finished', async () => {
            const engine = engineFor(h);
            const first = await engine.sync();
            const second = await engine.sync();

            // Joining is for callers that overlap. A sync after one finished is
            // a new sync, or the loop would answer with a stale run forever.
            expect(second).not.toBe(first);
            expect(h.log.filter((entry) => entry.startsWith('pull:'))).toHaveLength(2);
        });

        it('asks whether the server already holds a cover before sending one', async () => {
            h.state.pending = [op({ payload: { imageHash: 'aa11' } })];
            h.state.images = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', sha256: 'aa11' }];
            h.serverHas.add('aa11');

            await engineFor(h).sync();

            // Content addressing means another device may have given the server
            // these exact bytes already.
            expect(h.log).toContain('head:aa11');
            expect(h.log.some((entry) => entry.startsWith('put:'))).toBe(false);
            expect(h.state.markedUploaded).toEqual(['aa11']);
        });

        it('pulls even when there is nothing at all to push', async () => {
            const result = await engineFor(h).sync();

            // The server prunes no further back than the lowest cursor among
            // devices seen recently, and it learns those from GET /pull. A device
            // that only pushes is invisible to that guard.
            expect(h.log.some((entry) => entry.startsWith('push:'))).toBe(false);
            expect(h.log).toContain('pull:0');
            expect(syncFailed(result)).toBe(false);
        });

        it('resolves rather than throwing when the store itself is unreachable', async () => {
            h.store.pendingOps = () => {
                throw new Error('the bridge is not up');
            };
            h.store.cursor = () => {
                throw new Error('the bridge is not up');
            };

            const result = await engineFor(h).sync();

            // A caller running this on a timer should never have to choose
            // between catching and losing the rest of the report.
            expect(result.pushError).toBeDefined();
            expect(result.pullError).toBeDefined();
            expect(syncFailed(result)).toBe(true);
        });

        it('pulls even when the push failed outright', async () => {
            h.state.pending = [op()];
            h.pushHandler = () => {
                throw new SyncError('auth', 'token expired');
            };

            const result = await engineFor(h).sync();

            expect(result.pushError?.kind).toBe('auth');
            expect(h.log).toContain('pull:0');
        });
    });

    describe('cursors', () => {
        it('never stores the cursor a push returned', async () => {
            h.state.pending = [op()];
            h.pushHandler = (ops) => ({ accepted: ops.map((each) => each.opId), cursor: 999 });
            h.pullPages = [page({ cursor: 42, ops: [op({ opId: 'inbound' })] })];

            await engineFor(h).sync();

            // 999 is the server's head. Ops from other devices sit below it that
            // this device has never seen; storing it skips them permanently.
            expect(h.state.cursorWrites).toEqual([42]);
        });

        it('stores a batch cursor only after the whole batch has applied', async () => {
            h.pullPages = [page({ cursor: 42, ops: [op({ opId: 'a' }), op({ opId: 'b' })] })];

            await engineFor(h).sync();

            expect(at(h.log, 'setCursor:')).toBeGreaterThan(at(h.log, 'apply:b'));
        });

        it('leaves the cursor where it was when a batch fails half way through', async () => {
            h.state.applyThrowsOn.add('b');
            h.pullPages = [page({ cursor: 42, ops: [op({ opId: 'a' }), op({ opId: 'b' })] })];

            const result = await engineFor(h).sync();

            // An interrupted sync has to replay rather than skip.
            expect(h.state.cursorWrites).toEqual([]);
            expect(result.pullError).toBeDefined();
        });

        it('stores each page as it applies, not one cursor at the end', async () => {
            h.pullPages = [
                page({ cursor: 10, hasMore: true, ops: [op({ opId: 'a' })] }),
                page({ cursor: 20, ops: [op({ opId: 'b' })] }),
            ];

            await engineFor(h).sync();

            expect(h.state.cursorWrites).toEqual([10, 20]);
            expect(h.log.filter((entry) => entry.startsWith('pull:'))).toEqual([
                'pull:0',
                'pull:10',
            ]);
        });

        it('stops rather than spins when hasMore comes back with a cursor that did not move', async () => {
            h.pullPages = Array.from({ length: 5 }, () => page({ cursor: 0, hasMore: true }));

            await engineFor(h).sync();

            expect(h.log.filter((entry) => entry.startsWith('pull:'))).toEqual(['pull:0']);
        });

        it('bounds a server that says hasMore forever', async () => {
            h.pullPages = Array.from({ length: MAX_PULL_PAGES + 10 }, (_, index) =>
                page({ cursor: index + 1, hasMore: true }),
            );

            await engineFor(h).sync();

            expect(h.log.filter((entry) => entry.startsWith('pull:'))).toHaveLength(MAX_PULL_PAGES);
        });
    });

    describe('a 5xx is bisected, not retried', () => {
        const failsWhenItContains = (bad: string) => (ops: SyncOp[]) => {
            if (ops.some((each) => each.opId === bad)) {
                throw new SyncError('serverFault', 'Error processing request', {
                    body: 'Error processing request',
                    status: 500,
                });
            }
            return { accepted: ops.map((each) => each.opId), cursor: 1 };
        };

        it('isolates the one offending op and pushes the innocent halves on the way past', async () => {
            h.state.pending = ['a', 'bad', 'c', 'd'].map((opId) => op({ opId }));
            h.pushHandler = failsWhenItContains('bad');

            const result = await engineFor(h).sync();

            expect(h.state.quarantined.map((entry) => entry.opId)).toEqual(['bad']);
            expect(h.state.synced.sort()).toEqual(['a', 'c', 'd']);
            expect(result.pushed).toBe(3);
        });

        it('blames nothing when the fault stops reproducing once an op is alone', async () => {
            h.state.pending = ['a', 'b'].map((opId) => op({ opId }));
            h.pushHandler = (ops) => {
                if (ops.length > 1) {
                    throw new SyncError('serverFault', 'Error processing request');
                }
                return { accepted: ops.map((each) => each.opId), cursor: 1 };
            };

            await engineFor(h).sync();

            expect(h.state.quarantined).toEqual([]);
            expect(h.state.synced.sort()).toEqual(['a', 'b']);
        });

        it('does not bisect a refusal, which is about the request and not any op in it', async () => {
            h.state.pending = ['a', 'b'].map((opId) => op({ opId }));
            let attempts = 0;
            h.pushHandler = () => {
                attempts += 1;
                throw new SyncError('permanent', 'malformed request');
            };

            const result = await engineFor(h).sync();

            expect(attempts).toBe(1);
            expect(h.state.quarantined).toEqual([]);
            expect(result.pushError?.kind).toBe('permanent');
        });
    });

    describe('refusals', () => {
        it('quarantines a refused op rather than retrying it forever', async () => {
            h.state.pending = [op()];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: 'unknown entity' }],
            });

            const result = await engineFor(h).sync();

            expect(h.state.quarantined.map((entry) => entry.opId)).toEqual(['op-1']);
            expect(result.revoked).toEqual([]);
        });

        it('does not quarantine the one refusal a restored share would fix', async () => {
            h.state.pending = [op()];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const result = await engineFor(h).sync();

            // Quarantine is forever, and this one can become valid again.
            expect(h.state.quarantined).toEqual([]);
            expect(h.state.synced).toEqual([]);
            expect(result.revoked).toEqual([
                { opId: 'op-1', playlistId: 'playlist-1', reason: REVOKED, stillShared: false },
            ]);
        });

        it('re-reads the share list once, however many edits were refused', async () => {
            h.state.pending = [op({ opId: 'a' }), op({ opId: 'b' })];
            h.pushHandler = (ops) => ({
                accepted: [],
                cursor: 1,
                rejected: ops.map((each) => ({ opId: each.opId, reason: REVOKED })),
            });

            await engineFor(h).sync();

            expect(h.log.filter((entry) => entry === 'listShares')).toHaveLength(1);
        });

        it('leaves stillShared unknown when the share list cannot be read', async () => {
            h.state.pending = [op()];
            h.sharesFail = true;
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const result = await engineFor(h).sync();

            // Unknown is not the same as gone.
            expect(result.revoked[0].stillShared).toBeNull();
            expect(result.shareError?.kind).toBe('transient');
        });

        it('stops re-pushing a revoked edit but keeps it in the log', async () => {
            h.state.pending = [op()];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h);
            await engine.sync();
            h.log.length = 0;
            const second = await engine.sync();

            expect(h.log.some((entry) => entry.startsWith('push:'))).toBe(false);
            expect(h.state.quarantined).toEqual([]);
            expect(second.revoked).toEqual([]);
        });

        it('sends the edit again once the share is back', async () => {
            h.state.pending = [op()];
            h.shares = [{ canEdit: true, granteeUserId: 'u2', playlistId: 'playlist-1' }];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h);
            const first = await engine.sync();
            expect(first.revoked[0].stillShared).toBe(true);

            h.log.length = 0;
            h.pushHandler = (ops) => ({ accepted: ops.map((each) => each.opId), cursor: 2 });
            await engine.sync();

            expect(h.log).toContain('push:op-1');
        });

        it('keeps reporting a blocked edit long after the run that was refused', async () => {
            h.state.pending = [op()];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h);
            await engine.sync();
            const second = await engine.sync();

            // `revoked` is what happened on a run, and after the first one
            // nothing happens: the op is not pushed, so it cannot be refused
            // again. An edit named once and then absent from every report is an
            // edit the person has lost with nothing on screen saying so.
            expect(second.revoked).toEqual([]);
            expect(second.blocked).toEqual([
                { opId: 'op-1', playlistId: 'playlist-1', reason: REVOKED, stillShared: false },
            ]);
            expect(engine.blockedEdits).toEqual(second.blocked);
        });

        it('asks about the share again on a later sync and sends the edit once it is back', async () => {
            let clock = 0;
            h.state.pending = [op()];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h, undefined, { now: () => clock });
            await engine.sync();

            h.log.length = 0;
            await engine.sync();

            // Not on every sync: a share that really is gone would have this
            // device asking the same question at whatever rate the timer runs.
            expect(h.log).not.toContain('listShares');

            h.shares = [{ canEdit: true, granteeUserId: 'u2', playlistId: 'playlist-1' }];
            h.pushHandler = (ops) => ({ accepted: ops.map((each) => each.opId), cursor: 2 });
            clock += SHARE_RECHECK_MS;
            h.log.length = 0;
            const third = await engine.sync();

            // The refusal cannot happen a second time, so nothing but this
            // re-read would ever ask again and the edit would sit in the log
            // until the application was restarted.
            expect(h.log).toContain('listShares');
            expect(h.log).toContain('push:op-1');
            expect(h.state.synced).toEqual(['op-1']);
            expect(third.blocked).toEqual([]);
        });

        it('does not unblock an edit on a share granted to somebody else', async () => {
            h.state.pending = [op()];
            h.shares = [
                {
                    canEdit: true,
                    granteeUserId: 'someone-else',
                    ownerUserId: 'the-owner',
                    playlistId: 'playlist-1',
                },
            ];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h, 'me');
            const first = await engine.sync();

            h.log.length = 0;
            await engine.sync();

            // The playlist is shared and editable — by a third party. Reading
            // `canEdit` without asking who it was granted to unblocks this
            // user's op on somebody else's access, and the server refuses it
            // again on every sync.
            expect(first.revoked[0].stillShared).toBe(false);
            expect(h.log.some((entry) => entry.startsWith('push:'))).toBe(false);
        });

        it('unblocks on a share granted to this user', async () => {
            h.state.pending = [op()];
            h.shares = [
                {
                    canEdit: true,
                    granteeUserId: 'me',
                    ownerUserId: 'the-owner',
                    playlistId: 'playlist-1',
                },
            ];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const engine = engineFor(h, 'me');
            const first = await engine.sync();

            h.log.length = 0;
            h.pushHandler = (ops) => ({ accepted: ops.map((each) => each.opId), cursor: 2 });
            await engine.sync();

            expect(first.revoked[0].stillShared).toBe(true);
            expect(h.log).toContain('push:op-1');
        });

        it('does not let blocked ops at the head of the log starve the ops behind them', async () => {
            h.state.pending = [op({ opId: 'blocked' }), op({ opId: 'later' })];
            h.pushHandler = (ops) => ({
                accepted: ops.filter((each) => each.opId !== 'blocked').map((each) => each.opId),
                cursor: 1,
                rejected: ops
                    .filter((each) => each.opId === 'blocked')
                    .map((each) => ({ opId: each.opId, reason: REVOKED })),
            });

            const engine = engineFor(h, undefined, { pushLimit: 1 });
            await engine.sync();

            h.log.length = 0;
            await engine.sync();

            // Blocked ops are the oldest unsynced rows, so they fill the head of
            // every page the store's LIMIT returns. Removing them after the
            // limit leaves an empty push and every later edit stuck behind a
            // share that is gone — a device that has quietly stopped syncing.
            expect(h.log).toContain('push:later');
            expect(h.state.synced).toEqual(['later']);
        });

        it('takes the playlist id from a playlist item’s payload, not from the message', async () => {
            h.state.pending = [
                op({
                    entity: 'playlist_items',
                    entityId: 'item-9',
                    payload: { playlistId: 'pl-7' },
                }),
            ];
            h.pushHandler = () => ({
                accepted: [],
                cursor: 1,
                rejected: [{ opId: 'op-1', reason: REVOKED }],
            });

            const result = await engineFor(h).sync();

            // The message says 'p1'; the op says pl-7, and the op is structured.
            expect(result.revoked[0].playlistId).toBe('pl-7');
        });
    });

    describe('covers that will not upload', () => {
        it('holds back only the op naming the cover and pushes the rest', async () => {
            h.state.pending = [
                op({ opId: 'with-cover', payload: { imageHash: 'aa11' } }),
                op({ opId: 'plain' }),
            ];
            h.state.images = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', sha256: 'aa11' }];
            h.uploadFails.add('aa11');

            const result = await engineFor(h).sync();

            expect(h.log).toContain('push:plain');
            expect(result.heldBack).toEqual(['with-cover']);
            expect(result.imageErrors).toHaveLength(1);
            // Not fatal: a playlist arriving without its picture a few minutes
            // late is much smaller than a device that stops syncing.
            expect(syncFailed(result)).toBe(false);
            expect(h.log).toContain('pull:0');
        });

        it('holds back every op naming a cover when the store cannot say which are needed', async () => {
            h.state.pending = [
                op({ opId: 'with-cover', payload: { imageHash: 'aa11' } }),
                op({ opId: 'plain' }),
            ];
            h.store.imagesToUpload = () => {
                throw new Error('the bridge is not up');
            };

            const result = await engineFor(h).sync();

            // Pushing on the assumption that nothing was needed is the failure
            // the ordering rule exists to prevent, and nothing reports it.
            expect(result.heldBack).toEqual(['with-cover']);
            expect(h.log).toContain('push:plain');
        });

        it('never holds back a delete, which names no cover anybody will draw', async () => {
            h.state.pending = [
                op({ operation: 'delete', opId: 'gone', payload: { imageHash: 'aa11' } }),
            ];
            h.state.images = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', sha256: 'aa11' }];
            h.uploadFails.add('aa11');

            const result = await engineFor(h).sync();

            expect(result.heldBack).toEqual([]);
            expect(h.log).toContain('push:gone');
        });
    });

    describe('1.7.0.0 fields', () => {
        it('judges skew against the receipt of the push that carried each op', async () => {
            h.pullPages = [
                page({
                    cursor: 9,
                    ops: [
                        op({ opId: 'a', receivedAt: 100 }),
                        op({ opId: 'b', receivedAt: 100 }),
                        op({ opId: 'c', receivedAt: 500 }),
                    ],
                }),
            ];

            await engineFor(h).sync();

            // One pulled page routinely carries several devices' pushes. Ops
            // pushed together share a receipt; ops from different pushes must
            // never borrow each other's.
            expect(h.state.applied).toEqual([
                { opId: 'a', receivedAt: 100 },
                { opId: 'b', receivedAt: 100 },
                { opId: 'c', receivedAt: 500 },
            ]);
        });

        it('corrects nothing for an op the server sent no receipt for', async () => {
            h.pullPages = [page({ cursor: 9, ops: [op({ opId: 'a' })] })];

            await engineFor(h).sync();

            // One reference cannot tell a fast writer from a slow server.
            expect(h.state.applied).toEqual([{ opId: 'a', receivedAt: undefined }]);
        });

        it('records a collaborator’s edits without claiming them', async () => {
            h.pullPages = [
                page({
                    cursor: 9,
                    ops: [
                        op({ authorUserId: 'me', opId: 'mine' }),
                        op({ authorUserId: 'them', opId: 'theirs' }),
                        op({ authorUserId: 'them', opId: 'theirs-2' }),
                    ],
                }),
            ];

            const result = await engineFor(h, 'me').sync();

            expect(result.foreignAuthors).toEqual(['them']);
        });

        it('never marks a pending op synced because it came back on a pull', async () => {
            h.state.pending = [op({ opId: 'op-1' })];
            h.pushHandler = () => ({ accepted: [], cursor: 5 });
            h.pullPages = [page({ cursor: 9, ops: [op({ authorUserId: 'them', opId: 'op-1' })] })];

            await engineFor(h, 'me').sync();

            // Only the ids a push named back are evidence of acceptance.
            expect(h.state.synced).toEqual([]);
        });
    });

    describe('handoff', () => {
        const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
            ageSeconds: 0,
            deviceId: 'device',
            isCurrentDevice: false,
            receivedAt: 0,
            ...overrides,
        });

        /** A server that sends no age at all. The type says it always does; JSON does not. */
        const withoutAge = (source: QueueEntry): QueueEntry => {
            const copy: Partial<QueueEntry> = { ...source };
            delete copy.ageSeconds;
            return copy as QueueEntry;
        };

        it('ignores a device that claims to be in the future', () => {
            const target = handoffTarget([
                entry({ ageSeconds: 5, deviceId: 'this-one', isCurrentDevice: true }),
                entry({ ageSeconds: 3000, deviceId: 'stale', updatedAt: 9_000_000_000_000 }),
                entry({ ageSeconds: 10, deviceId: 'recent', updatedAt: 2 }),
            ]);

            // updatedAt is the writing device's clock; a machine set to next year
            // would otherwise win every handover forever.
            expect(target?.deviceId).toBe('recent');
        });

        it('falls back to the server’s receipt time, still never to updatedAt', () => {
            const target = handoffTarget([
                withoutAge(
                    entry({ deviceId: 'older', receivedAt: 500, updatedAt: 9_000_000_000_000 }),
                ),
                withoutAge(entry({ deviceId: 'newer', receivedAt: 900 })),
            ]);

            expect(target?.deviceId).toBe('newer');
        });

        it('ranks the whole list by one criterion rather than each entry by its own', () => {
            const target = handoffTarget([
                entry({ ageSeconds: 5, deviceId: 'age-only', receivedAt: 100 }),
                withoutAge(entry({ deviceId: 'receipt-only', receivedAt: 900 })),
                entry({ ageSeconds: 50, deviceId: 'also-aged', receivedAt: 200 }),
            ]);

            // Seconds and milliseconds are both numbers and neither sorts
            // against the other. Choosing the criterion per entry — anything
            // that ranks by age as soon as *some* entry carries one — compares
            // an age of 5 against a receipt of 900 and hands the queue to
            // whichever device happened to be listed first.
            expect(target?.deviceId).toBe('receipt-only');
        });

        it('offers nothing when this is the only device', () => {
            expect(handoffTarget([entry({ isCurrentDevice: true })])).toBeUndefined();
        });
    });
});

describe('classifyRejection', () => {
    it('quarantines anything that is not the shared-playlist refusal', () => {
        expect(classifyRejection({ opId: 'x', reason: 'unknown entity' }).kind).toBe('quarantine');
        expect(classifyRejection({ opId: 'x' }).kind).toBe('quarantine');
    });

    it('recognises the refusal a restored share would fix', () => {
        const outcome = classifyRejection({ opId: 'x', reason: REVOKED });

        expect(outcome.kind).toBe('shareRevoked');
        expect(outcome.kind === 'shareRevoked' && outcome.playlistId).toBe('p1');
    });

    it('matches the clause rather than the whole sentence', () => {
        // The quoted id and the full stop are formatting. Requiring them would
        // mean a cosmetic reword quietly turns a recoverable refusal into a
        // permanent one, and the symptom is a user's edit vanishing.
        const reworded =
            'Rejected: it belongs to another user and is not shared with you for editing';

        expect(classifyRejection({ opId: 'x', reason: reworded }).kind).toBe('shareRevoked');
    });

    it('partitions so the quarantine list cannot be reached without the split', () => {
        const { quarantine, shareRevoked } = partitionRejections([
            { opId: 'a', reason: 'unknown entity' },
            { opId: 'b', reason: REVOKED },
        ]);

        expect(quarantine.map((entry) => entry.opId)).toEqual(['a']);
        expect(shareRevoked.map((entry) => entry.opId)).toEqual(['b']);
    });
});
