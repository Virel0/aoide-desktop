import { describe, expect, it, vi } from 'vitest';

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

describe('soundBounds', () => {
    it('asks by id and keeps bounds, "nothing to trim" and "pending" apart', async () => {
        const { calls, impl } = stubFetch([
            () =>
                json(200, {
                    bounds: { a: { soundEndMs: 5200, soundStartMs: 1940 }, b: null },
                    pending: ['c'],
                }),
        ]);

        const answer = await client(impl).soundBounds(['a', 'b', 'c']);

        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toBe(
            'https://example.invalid/aoide/sound-bounds?ids=' + encodeURIComponent('a,b,c'),
        );
        expect(calls[0].headers.Authorization).toBe('MediaBrowser Token="secret-token"');
        expect(answer).toEqual({
            absent: false,
            bounds: { a: { soundEndMs: 5200, soundStartMs: 1940 }, b: null },
            pending: ['c'],
        });
    });

    it('sends at most two hundred ids per request', async () => {
        const ids = Array.from({ length: 401 }, (_, i) => `t${i}`);
        const { calls, impl } = stubFetch([() => json(200, { bounds: {}, pending: [] })]);

        await client(impl).soundBounds(ids);

        expect(calls).toHaveLength(3);
        const sent = calls.map(
            (call) => decodeURIComponent(call.url.split('ids=')[1]).split(',').length,
        );
        expect(sent).toEqual([200, 200, 1]);
    });

    it('gathers the answers across chunks', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
        const { impl } = stubFetch([
            () => json(200, { bounds: { t0: null }, pending: ['t1'] }),
            () => json(200, { bounds: { t200: { soundEndMs: 2000, soundStartMs: 500 } } }),
        ]);

        const answer = await client(impl).soundBounds(ids);

        expect(answer.bounds).toEqual({ t0: null, t200: { soundEndMs: 2000, soundStartMs: 500 } });
        expect(answer.pending).toEqual(['t1']);
    });

    // The endpoint is newer than most sidecars. That is not an error.
    it('reads a 404 as "no bounds for anyone", at once, without throwing', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => `t${i}`);
        const { calls, impl } = stubFetch([() => new Response('Not Found', { status: 404 })]);

        const answer = await client(impl).soundBounds(ids);

        expect(answer).toEqual({ absent: true, bounds: {}, pending: [] });
        expect(calls).toHaveLength(1);
    });

    it('throws for any other failure, so the caller plays whole', async () => {
        const { impl } = stubFetch([() => new Response('down', { status: 503 })]);
        const error = await expectSyncError(client(impl).soundBounds(['a']));
        expect(error.kind).toBe('serverFault');
    });

    it('leaves out a row that is not a pair of numbers, rather than trusting it', async () => {
        const { impl } = stubFetch([
            () =>
                json(200, {
                    bounds: {
                        bad: { soundEndMs: 'soon', soundStartMs: 1 },
                        good: { soundEndMs: 2, soundStartMs: 1 },
                        half: { soundStartMs: 1 },
                    },
                    pending: [7, 'p'],
                }),
        ]);

        const answer = await client(impl).soundBounds(['bad', 'good', 'half', 'p']);

        expect(answer.bounds).toEqual({ good: { soundEndMs: 2, soundStartMs: 1 } });
        expect(answer.pending).toEqual(['p']);
    });

    it('asks nothing for no ids', async () => {
        const { calls, impl } = stubFetch([() => json(200, {})]);
        expect(await client(impl).soundBounds([])).toEqual({
            absent: false,
            bounds: {},
            pending: [],
        });
        expect(calls).toHaveLength(0);
    });
});

describe('audioAnalysis', () => {
    const ROW = {
        bpm: 128,
        bpmConfidence: 0.82,
        bpmStability: 0.94,
        loudnessLufs: -9.7,
        truePeakDbfs: -0.3,
    };

    it('asks by id and keeps measurements, "nothing to report" and "pending" apart', async () => {
        const { calls, impl } = stubFetch([
            () => json(200, { analysis: { a: ROW, b: null }, pending: ['c'] }),
        ]);

        const answer = await client(impl).audioAnalysis(['a', 'b', 'c']);

        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toBe(
            'https://example.invalid/aoide/audio-analysis?ids=' + encodeURIComponent('a,b,c'),
        );
        expect(calls[0].headers.Authorization).toBe('MediaBrowser Token="secret-token"');
        expect(answer).toEqual({
            absent: false,
            analysis: { a: ROW, b: null },
            pending: ['c'],
        });
    });

    it('sends at most two hundred ids per request', async () => {
        const ids = Array.from({ length: 401 }, (_, i) => `t${i}`);
        const { calls, impl } = stubFetch([() => json(200, { analysis: {}, pending: [] })]);

        await client(impl).audioAnalysis(ids);

        expect(calls).toHaveLength(3);
        const sent = calls.map(
            (call) => decodeURIComponent(call.url.split('ids=')[1]).split(',').length,
        );
        expect(sent).toEqual([200, 200, 1]);
    });

    it('gathers the answers across chunks', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
        const { impl } = stubFetch([
            () => json(200, { analysis: { t0: null }, pending: ['t1'] }),
            () => json(200, { analysis: { t200: ROW } }),
        ]);

        const answer = await client(impl).audioAnalysis(ids);

        expect(answer.analysis).toEqual({ t0: null, t200: ROW });
        expect(answer.pending).toEqual(['t1']);
    });

    // The endpoint does not exist on any sidecar yet. That is not an error, and
    // it must never become a toast: it means "normalise nothing".
    it('reads a 404 as "no measurements for anyone", at once, without throwing', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => `t${i}`);
        const { calls, impl } = stubFetch([() => new Response('Not Found', { status: 404 })]);

        const answer = await client(impl).audioAnalysis(ids);

        expect(answer).toEqual({ absent: true, analysis: {}, pending: [] });
        expect(calls).toHaveLength(1);
    });

    it('throws for any other failure, so the caller plays unmodified', async () => {
        const { impl } = stubFetch([() => new Response('down', { status: 503 })]);
        const error = await expectSyncError(client(impl).audioAnalysis(['a']));
        expect(error.kind).toBe('serverFault');
    });

    // Every field is nullable on its own, so a row is read field by field. A
    // track with a loudness and no usable tempo must not lose its loudness.
    it('keeps the fields it can read and nulls the ones it cannot', async () => {
        const { impl } = stubFetch([
            () =>
                json(200, {
                    analysis: {
                        loudOnly: { bpm: null, bpmConfidence: null, loudnessLufs: -12.5 },
                        tempoOnly: { bpm: 96, bpmConfidence: 0.6 },
                        text: { bpm: 'fast', loudnessLufs: 'loud' },
                    },
                    pending: [7, 'p'],
                }),
        ]);

        const answer = await client(impl).audioAnalysis(['loudOnly', 'tempoOnly', 'text', 'p']);

        expect(answer.analysis).toEqual({
            loudOnly: {
                bpm: null,
                bpmConfidence: null,
                bpmStability: null,
                loudnessLufs: -12.5,
                truePeakDbfs: null,
            },
            // A sidecar older than 1.12.0.0 reports no stability at all, which
            // is not the same as an unsteady track and must not read as one.
            tempoOnly: {
                bpm: 96,
                bpmConfidence: 0.6,
                bpmStability: null,
                loudnessLufs: null,
                truePeakDbfs: null,
            },
            // Nothing readable in the row says the same thing as null.
            text: null,
        });
        expect(answer.pending).toEqual(['p']);
    });

    it('leaves out a row that is not a row at all, rather than trusting it', async () => {
        const { impl } = stubFetch([
            () => json(200, { analysis: { bad: 'measured', good: { loudnessLufs: -8 } } }),
        ]);

        const answer = await client(impl).audioAnalysis(['bad', 'good']);

        expect(answer.analysis).toEqual({
            good: {
                bpm: null,
                bpmConfidence: null,
                bpmStability: null,
                loudnessLufs: -8,
                truePeakDbfs: null,
            },
        });
    });

    it('asks nothing for no ids', async () => {
        const { calls, impl } = stubFetch([() => json(200, {})]);
        expect(await client(impl).audioAnalysis([])).toEqual({
            absent: false,
            analysis: {},
            pending: [],
        });
        expect(calls).toHaveLength(0);
    });
});

describe('match', () => {
    it('posts the imported rows as the sidecar reads them and returns its answers, nulls kept', async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            const rows = JSON.parse(String(init?.body));
            expect(rows).toEqual([
                {
                    album: null,
                    artists: ['Radiohead'],
                    durationMs: 264_000,
                    isrc: null,
                    title: 'Karma Police',
                },
            ]);
            return new Response(
                JSON.stringify({
                    librarySize: 10,
                    matched: 1,
                    results: [
                        {
                            artistScore: 1,
                            confidence: 0.97,
                            durationScore: 0.8,
                            jellyfinId: 'j1',
                            titleScore: 1,
                        },
                    ],
                }),
                { headers: { 'Content-Type': 'application/json' }, status: 200 },
            );
        });

        const answers = await client(fetchImpl as unknown as typeof fetch).match([
            { artists: ['Radiohead'], durationMs: 264_000, title: 'Karma Police' },
        ]);

        expect(answers).toEqual([
            {
                artistScore: 1,
                confidence: 0.97,
                durationScore: 0.8,
                jellyfinId: 'j1',
                titleScore: 1,
            },
        ]);
        expect(fetchImpl.mock.calls[0][0]).toMatch(/\/aoide\/match$/);
    });

    it('asks nothing for an empty import', async () => {
        const fetchImpl = vi.fn();
        expect(await client(fetchImpl as unknown as typeof fetch).match([])).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('audioAnalysis against the sidecar’s own documented payload', () => {
    // Pasted from the sidecar's client-integration contract. Parsing is where a
    // client and a server quietly disagree, and the entry that is literally
    // `null` is the one most likely to be dropped on the floor.
    const PAYLOAD = {
        analysis: {
            '3b1c': {
                bpm: 128.0,
                bpmConfidence: 0.82,
                bpmStability: 0.82,
                loudnessLufs: -9.7,
                truePeakDbfs: -0.3,
            },
            a71f: { bpm: null, bpmConfidence: null, loudnessLufs: -14.2, truePeakDbfs: -1.1 },
            c904: null,
        },
        pending: ['9c0e'],
    };

    it('keeps the measured-with-nothing-to-report entry rather than dropping it', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify(PAYLOAD), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 200,
                }),
        );

        const answer = await client(fetchImpl as unknown as typeof fetch).audioAnalysis([
            '3b1c',
            'a71f',
            'c904',
            '9c0e',
        ]);

        expect(answer.analysis['3b1c']).toMatchObject({
            bpm: 128,
            bpmStability: 0.82,
            loudnessLufs: -9.7,
        });
        // Loudness without a usable tempo: the common case for ambient.
        expect(answer.analysis.a71f).toMatchObject({
            bpm: null,
            bpmStability: null,
            loudnessLufs: -14.2,
        });
        // Present as a key, null as a value. If this vanishes the client asks
        // about the track forever.
        expect('c904' in answer.analysis).toBe(true);
        expect(answer.analysis.c904).toBeNull();
        expect(answer.pending).toEqual(['9c0e']);
    });
});
