import { describe, expect, it } from 'vitest';

import { SyncError } from './errors';
import { SidecarClient } from './sidecar-client';
import { SyncOp } from './types';

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
