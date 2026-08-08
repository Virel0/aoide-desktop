import { describe, expect, it } from 'vitest';

import { SyncError } from './errors';
import { SidecarClient } from './sidecar-client';
import { SyncTransport } from './sync-engine';

import { SyncOp } from '/@/shared/aoide/sync-types';

interface Recorded {
    body?: BodyInit | null;
    headers: Record<string, string>;
    method: string;
    url: string;
}

/** A fetch that records what it was asked and replies with what the test says. */
const stubFetch = (replies: Array<() => Response>) => {
    const calls: Recorded[] = [];
    let index = 0;

    const impl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({
            body: init?.body ?? null,
            headers: (init?.headers ?? {}) as Record<string, string>,
            method: init?.method ?? 'GET',
            url: String(url),
        });
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return reply();
    }) as unknown as typeof fetch;

    return { calls, impl };
};

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status });

const client = (fetchImpl: typeof fetch) =>
    new SidecarClient({
        baseUrl: 'https://example.invalid/',
        deviceId: 'device-1',
        fetchImpl,
        token: 'secret-token',
    });

/**
 * Await a call that must fail, and hand back the SyncError.
 *
 * `.catch((e) => e as SyncError)` types as `Response | SyncError` and does not
 * narrow, so every property access on it is a type error — and worse, a call
 * that *succeeds* would sail through with `undefined` where the kind should be.
 * This fails loudly instead.
 */
const expectSyncError = async (call: Promise<unknown>): Promise<SyncError> => {
    try {
        await call;
    } catch (error) {
        if (error instanceof SyncError) return error;
        throw error;
    }
    throw new Error('expected the call to fail with a SyncError, but it succeeded');
};

const op = (overrides: Partial<SyncOp> = {}): SyncOp => ({
    createdAt: 1754500000000,
    entity: 'playlists',
    entityId: 'playlist-1',
    operation: 'upsert',
    opId: 'op-1',
    payload: { name: 'Driving' },
    ...overrides,
});

describe('SidecarClient', () => {
    // A build-time assertion wearing a test's clothes. The engine takes
    // `SyncTransport` rather than this class so the ordering rules can be tested
    // without a network, and nothing else forces the two to keep agreeing —
    // renaming a method here would otherwise be found by whoever wires them
    // together, at runtime.
    it('satisfies the interface the sync engine takes', () => {
        const transport: SyncTransport = client((async () => new Response()) as typeof fetch);

        expect(typeof transport.push).toBe('function');
    });

    it('authenticates with the Jellyfin token and no account system of its own', async () => {
        const { calls, impl } = stubFetch([() => json(200, { accepted: [], cursor: 1 })]);
        await client(impl).push([]);

        expect(calls[0].headers.Authorization).toBe('MediaBrowser Token="secret-token"');
    });

    it('does not double the slash when the server URL has a trailing one', async () => {
        const { calls, impl } = stubFetch([() => json(200, { accepted: [], cursor: 1 })]);
        await client(impl).push([]);

        expect(calls[0].url).toBe('https://example.invalid/aoide/sync/push');
    });

    it('sends the device id with every push', async () => {
        const { calls, impl } = stubFetch([() => json(200, { accepted: ['op-1'], cursor: 9 })]);
        await client(impl).push([op()]);

        expect(JSON.parse(String(calls[0].body))).toMatchObject({
            deviceId: 'device-1',
            ops: [{ entity: 'playlists', opId: 'op-1' }],
        });
    });

    it('defaults rejected to a list so callers need not test for undefined', async () => {
        const { impl } = stubFetch([() => json(200, { accepted: ['op-1'], cursor: 9 })]);
        const result = await client(impl).push([op()]);

        expect(result.rejected).toEqual([]);
        expect(result.accepted).toEqual(['op-1']);
    });

    it('surfaces per-op rejections rather than failing the batch', async () => {
        const { impl } = stubFetch([
            () =>
                json(200, {
                    accepted: ['op-1'],
                    cursor: 9,
                    rejected: [{ opId: 'op-2', reason: 'unknown entity' }],
                }),
        ]);
        const result = await client(impl).push([op(), op({ opId: 'op-2' })]);

        expect(result.accepted).toEqual(['op-1']);
        expect(result.rejected).toEqual([{ opId: 'op-2', reason: 'unknown entity' }]);
    });

    // `since` is always sent, as 0 on a device that has never synced.
    it('always sends since, including zero', async () => {
        const { calls, impl } = stubFetch([
            () => json(200, { cursor: 0, hasMore: false, ops: [] }),
        ]);
        await client(impl).pull(0);

        expect(calls[0].url).toContain('since=0');
        expect(calls[0].url).toContain('limit=500');
    });

    it('drops ops for entities it cannot represent without losing the rest of the batch', async () => {
        const { impl } = stubFetch([
            () =>
                json(200, {
                    cursor: 40,
                    hasMore: false,
                    ops: [
                        op({ entity: 'playlists', opId: 'a' }),
                        // A newer build's entity, or `tracks`, which never syncs.
                        { ...op({ opId: 'b' }), entity: 'something_new' },
                        op({ entity: 'play_events', opId: 'c' }),
                    ],
                }),
        ]);
        const result = await client(impl).pull(0);

        expect(result.ops.map((o) => o.opId)).toEqual(['a', 'c']);
        // The cursor still advances past the op it could not use, or sync wedges
        // permanently on an entity this build has never heard of.
        expect(result.cursor).toBe(40);
    });

    describe('failure classification', () => {
        it('treats 401 as auth, which retrying cannot fix', async () => {
            const { impl } = stubFetch([() => new Response('no', { status: 401 })]);
            const error = await expectSyncError(client(impl).pull(0));

            expect(error.kind).toBe('auth');
            expect(error.isRetryable).toBe(false);
        });

        it('treats 500 as a server fault, which is retryable and triggers bisection', async () => {
            const { impl } = stubFetch([
                () => new Response('Error processing request', { status: 500 }),
            ]);
            const error = await expectSyncError(client(impl).push([op()]));

            expect(error.kind).toBe('serverFault');
            expect(error.isRetryable).toBe(true);
        });

        it('keeps the server’s own words, which is how three faults were found', async () => {
            const { impl } = stubFetch([
                () => new Response('Error processing request', { status: 500 }),
            ]);
            const error = await expectSyncError(client(impl).push([op()]));

            expect(error.reply?.body).toBe('Error processing request');
            expect(error.displayMessage).toContain('Error processing request');
        });

        it('treats 429 as transient rather than a refusal', async () => {
            const { impl } = stubFetch([() => new Response('slow down', { status: 429 })]);
            const error = await expectSyncError(client(impl).pull(0));

            expect(error.kind).toBe('transient');
        });

        it('treats a 400 as permanent, so whatever caused it gets quarantined', async () => {
            const { impl } = stubFetch([() => new Response('bad op', { status: 400 })]);
            const error = await expectSyncError(client(impl).push([op()]));

            expect(error.kind).toBe('permanent');
            expect(error.isRetryable).toBe(false);
        });

        it('treats an unreachable server as transient, not as bad data', async () => {
            const impl = (async () => {
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch;
            const error = await expectSyncError(client(impl).pull(0));

            expect(error.kind).toBe('transient');
            expect(error.message).toContain('fetch failed');
        });

        // A login page standing where the sidecar should be is the likely cause,
        // and only the body distinguishes it from a working server.
        it('does not treat a non-JSON 200 as success', async () => {
            const { impl } = stubFetch([
                () => new Response('<!doctype html><title>Sign in</title>', { status: 200 }),
            ]);
            const error = await expectSyncError(client(impl).pull(0));

            expect(error.kind).toBe('permanent');
            expect(error.reply?.body).toContain('Sign in');
        });
    });

    describe('the 1.7.0.0 fields on a pulled op', () => {
        it('carries the server’s receipt time and the author through untouched', async () => {
            const { impl } = stubFetch([
                () =>
                    json(200, {
                        cursor: 3,
                        hasMore: false,
                        ops: [
                            {
                                ...op(),
                                authorUserId: 'user-2',
                                createdAt: 1786052177201,
                                receivedAt: 1786065442334,
                                seq: 1,
                            },
                        ],
                    }),
            ]);
            const result = await client(impl).pull(0);

            expect(result.ops[0].authorUserId).toBe('user-2');
            expect(result.ops[0].receivedAt).toBe(1786065442334);
            expect(result.ops[0].seq).toBe(1);
        });

        // `correctForSkew` compares this against a row's own timestamp, and a
        // string would compare as text — so a genuinely skewed row would sail
        // past the one check written to catch it. Absent means "correct
        // nothing", which is the safe direction.
        it('drops a receipt time that is not a number rather than comparing text', async () => {
            const { impl } = stubFetch([
                () =>
                    json(200, {
                        cursor: 3,
                        hasMore: false,
                        ops: [{ ...op(), receivedAt: '1786065442334' }],
                    }),
            ]);
            const result = await client(impl).pull(0);

            expect(result.ops[0].receivedAt).toBeUndefined();
        });
    });

    describe('queue handover', () => {
        it('reports every device’s queue with the server’s own freshness fields', async () => {
            const { calls, impl } = stubFetch([
                () =>
                    json(200, {
                        entries: [
                            {
                                ageSeconds: 12,
                                deviceId: 'phone',
                                isCurrentDevice: false,
                                receivedAt: 1786065442334,
                                updatedAt: 9_000_000_000_000,
                            },
                        ],
                    }),
            ]);
            const entries = await client(impl).queues();

            expect(calls[0].url).toBe('https://example.invalid/aoide/queue');
            expect(entries[0].ageSeconds).toBe(12);
            expect(entries[0].receivedAt).toBe(1786065442334);
        });

        it('takes a bare array too, so an empty report is never a silent one', async () => {
            const { impl } = stubFetch([
                () => json(200, [{ ageSeconds: 1, deviceId: 'a', isCurrentDevice: true }]),
            ]);

            expect(await client(impl).queues()).toHaveLength(1);
        });
    });

    describe('shares', () => {
        it('lists what is shared', async () => {
            const { calls, impl } = stubFetch([
                () => json(200, [{ canEdit: true, granteeUserId: 'u2', playlistId: 'p1' }]),
            ]);
            const shares = await client(impl).listShares();

            expect(calls[0].url).toBe('https://example.invalid/aoide/shares');
            expect(shares).toEqual([{ canEdit: true, granteeUserId: 'u2', playlistId: 'p1' }]);
        });

        it('grants access with the whole request in the body', async () => {
            const { calls, impl } = stubFetch([() => new Response(null, { status: 204 })]);
            await client(impl).share({ canEdit: true, granteeUserId: 'u2', playlistId: 'p1' });

            expect(calls[0].method).toBe('POST');
            expect(JSON.parse(String(calls[0].body))).toEqual({
                canEdit: true,
                granteeUserId: 'u2',
                playlistId: 'p1',
            });
        });

        it('escapes the ids it puts in the path', async () => {
            const { calls, impl } = stubFetch([() => new Response(null, { status: 204 })]);
            await client(impl).unshare('p 1/x', 'u#2');

            expect(calls[0].method).toBe('DELETE');
            expect(calls[0].url).toBe('https://example.invalid/aoide/shares/p%201%2Fx/u%232');
        });
    });

    describe('housekeeping', () => {
        it('reports orphaned blobs, which doubles as “did my upload arrive?”', async () => {
            const { calls, impl } = stubFetch([
                () => json(200, { images: [{ ageDays: 0, sha256: 'aa11' }] }),
            ]);
            const orphans = await client(impl).orphanedImages();

            expect(calls[0].url).toBe('https://example.invalid/aoide/images/orphans');
            // A blob pushed moments ago appears with ageDays 0, because nothing
            // references it until the op naming it lands.
            expect(orphans[0].ageDays).toBe(0);
        });

        // The server owns the grace period and clamps anything shorter up to it.
        // A default written here would be a second copy of that number, and the
        // two would drift the first time either moved.
        it('leaves the grace to the server unless a caller names one', async () => {
            const { calls, impl } = stubFetch([() => json(200, { reclaimed: 3 })]);
            const cl = client(impl);

            await cl.reclaimImages();
            await cl.reclaimImages(90);

            expect(calls[0].url).toBe('https://example.invalid/aoide/images/orphans/reclaim');
            expect(calls[1].url).toContain('olderThanDays=90');
            expect(calls[1].method).toBe('POST');
        });

        it('prunes play history and reports how much went', async () => {
            const { calls, impl } = stubFetch([() => json(200, { pruned: 41 })]);
            const result = await client(impl).pruneRetention(180);

            expect(calls[0].url).toContain('/aoide/retention/prune?olderThanDays=180');
            expect(result.pruned).toBe(41);
        });

        it('reads the retention report and the sync status', async () => {
            const { calls, impl } = stubFetch([
                () => json(200, { eventCount: 900, oldestAt: 1 }),
                () => json(200, { cursor: 88, lowestCursor: 12 }),
            ]);
            const cl = client(impl);

            expect((await cl.retention()).eventCount).toBe(900);
            // The lowest cursor among devices seen recently is what bounds
            // pruning, so a device falling behind is visible here first.
            expect((await cl.status()).lowestCursor).toBe(12);
            expect(calls.map((call) => call.url)).toEqual([
                'https://example.invalid/aoide/retention',
                'https://example.invalid/aoide/sync/status',
            ]);
        });

        it('classifies a failure on a housekeeping endpoint like any other', async () => {
            const { impl } = stubFetch([() => new Response('nope', { status: 401 })]);
            const error = await expectSyncError(client(impl).listShares());

            expect(error.kind).toBe('auth');
        });
    });

    describe('images', () => {
        it('reports a missing blob as absent rather than as an error', async () => {
            const { impl } = stubFetch([() => new Response(null, { status: 404 })]);
            expect(await client(impl).hasImage('abc')).toBe(false);
        });

        it('reports a present blob without downloading it', async () => {
            const { calls, impl } = stubFetch([() => new Response(null, { status: 200 })]);
            expect(await client(impl).hasImage('abc')).toBe(true);
            expect(calls[0].method).toBe('HEAD');
        });

        it('returns null for a cover the server does not hold', async () => {
            const { impl } = stubFetch([() => new Response(null, { status: 404 })]);
            expect(await client(impl).getImage('abc')).toBeNull();
        });

        it('sends the declared mime type when uploading', async () => {
            const { calls, impl } = stubFetch([() => new Response(null, { status: 204 })]);
            await client(impl).putImage('abc', new Uint8Array([1, 2, 3]), 'image/jpeg');

            expect(calls[0].method).toBe('PUT');
            expect(calls[0].url).toBe('https://example.invalid/aoide/images/abc');
            expect(calls[0].headers['Content-Type']).toBe('image/jpeg');
        });
    });
});
