import type { AudioAnalysis, AudioAnalysisReply } from '/@/shared/aoide/loudness';
import type { ImportedTrack } from '/@/shared/aoide/playlist-import';
import type { SoundBounds, SoundBoundsReply } from '/@/shared/aoide/trim-plan';

import { SyncError, syncErrorFromReply } from './errors';

import {
    isSyncEntity,
    OrphanImage,
    PlaylistShare,
    PruneResult,
    PullResponse,
    PushRequest,
    PushResponse,
    QueueEntry,
    ReclaimResult,
    RetentionReport,
    ServerReply,
    ShareRequest,
    SyncOp,
    SyncStatus,
} from '/@/shared/aoide/sync-types';

export interface SidecarClientOptions {
    /** The Jellyfin server's base URL. The sidecar lives on the same host. */
    baseUrl: string;
    /** Identifies this device in every push. Reuses Feishin's own device id. */
    deviceId: string;
    /** Injected so tests need no network, and so Electron's fetch is not assumed. */
    fetchImpl?: typeof fetch;
    /** The user's Jellyfin access token. The sidecar has no account system of its own. */
    token: string;
}

/** How many ops a single pull asks for. The contract's own default. */
export const PULL_LIMIT = 500;

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The optional `olderThanDays` query, or nothing at all.
 *
 * Omitted rather than defaulted, so the server's own grace stays the single
 * definition of it. A default written here would be a second copy of a number
 * the server already owns, and the two would drift the first time either moved.
 */
const daysQuery = (olderThanDays?: number): string =>
    olderThanDays === undefined
        ? ''
        : `?olderThanDays=${encodeURIComponent(String(olderThanDays))}`;

/**
 * Pull a list out of a reply that may or may not have wrapped it.
 *
 * The five endpoints added in 1.7.0.0 are informational — a queue offer, a share
 * list, a housekeeping report — and none of them sits in the path of a user's
 * edit. Being liberal about whether the array arrived bare or under a key costs
 * one function and removes a whole class of "the report is empty and nothing
 * says why", which is the failure that would actually happen here.
 */
const listFrom = <T>(body: unknown, ...keys: string[]): T[] => {
    if (Array.isArray(body)) return body as T[];
    if (!body || typeof body !== 'object') return [];

    for (const key of keys) {
        const value = (body as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value as T[];
    }
    return [];
};

/**
 * Discard a receipt time that is not a usable number.
 *
 * `correctForSkew` compares this against a row's own timestamp, and a string
 * that slipped through would compare as text: `'1786065442334' > 999` is false,
 * so a genuinely skewed row would sail past the one check written to catch it.
 * Absent is the honest answer for anything that is not a finite number, and
 * absent means "correct nothing", which is the safe direction.
 */
const finiteOrUndefined = (value: unknown): number | undefined => {
    const number = Number(value);
    return typeof value === 'number' && Number.isFinite(number) ? number : undefined;
};

/**
 * Transport for the two sync endpoints, the three image ones, and the five
 * added in sidecar 1.7.0.0.
 *
 * Deliberately only transport: one request in, one parsed reply out. Retry,
 * bisection, cursor bookkeeping and quarantine are policy and live in the sync
 * engine, which needs the local op log to do any of it. Keeping them apart is
 * what lets this be tested without a database.
 */
/** The sidecar refuses more than this many rows in one call. */
export const MATCH_ROWS_PER_REQUEST = 5000;

/** A library track the sidecar chose for an imported one, with its reasons. */
export interface SidecarMatch {
    album?: null | string;
    artists?: null | string[];
    artistScore: number;
    confidence: number;
    durationMs?: null | number;
    durationScore: number;
    jellyfinId: string;
    title?: null | string;
    titleScore: number;
}

/** `GET /aoide/sound-bounds` takes at most this many ids in one call. */
export const SOUND_BOUNDS_IDS_PER_REQUEST = 200;

/**
 * The sidecar's answer about where tracks' sound starts and stops, plus
 * whether it could answer at all.
 *
 * `absent` is a 404: the endpoint is newer than this sidecar. Read as "no
 * bounds for anyone", never as an error — the feature simply waits for the
 * upgrade, and nothing about playback changes.
 */
export interface SoundBoundsAnswer extends SoundBoundsReply {
    absent: boolean;
}

const NO_BOUNDS: SoundBoundsAnswer = { absent: false, bounds: {}, pending: [] };

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/**
 * One track's bounds off the wire, or undefined for a row that is not one.
 * Null is kept: it is the server's "measured, nothing to trim".
 */
const readBounds = (value: unknown): null | SoundBounds | undefined => {
    if (value === null) return null;
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    if (!isFiniteNumber(row.soundStartMs) || !isFiniteNumber(row.soundEndMs)) return undefined;
    return { soundEndMs: row.soundEndMs, soundStartMs: row.soundStartMs };
};

/** `GET /aoide/audio-analysis` takes at most this many ids in one call. */
export const AUDIO_ANALYSIS_IDS_PER_REQUEST = 200;

/**
 * The sidecar's loudness and tempo measurements, plus whether it could answer
 * at all.
 *
 * `absent` is a 404, read exactly as `SoundBoundsAnswer`'s is: the endpoint is
 * newer than this sidecar, so the answer is "normalise nothing" and never an
 * error. Today that is the normal case — the endpoint does not exist on any
 * sidecar yet.
 */
export interface AudioAnalysisAnswer extends AudioAnalysisReply {
    absent: boolean;
}

const NO_ANALYSIS: AudioAnalysisAnswer = { absent: false, analysis: {}, pending: [] };

/** A field the spec allows to be null on its own; anything unreadable is null too. */
const numberOrNull = (value: unknown): null | number => (isFiniteNumber(value) ? value : null);

/**
 * One track's measurements off the wire, or undefined for a row that is not
 * one. Null is kept: it is the server's "measured, nothing to report".
 *
 * Every field is independently nullable per the spec, so a row is read field by
 * field rather than rejected whole — a track with a usable loudness and no
 * usable tempo is the common case and must not lose its loudness. A row with
 * neither is the same statement as `null` and is stored as one, so the cache
 * has a single shape for "nothing here".
 */
const readAnalysis = (value: unknown): AudioAnalysis | null | undefined => {
    if (value === null) return null;
    if (!value || typeof value !== 'object') return undefined;

    const row = value as Record<string, unknown>;
    const analysis: AudioAnalysis = {
        bpm: numberOrNull(row.bpm),
        bpmConfidence: numberOrNull(row.bpmConfidence),
        loudnessLufs: numberOrNull(row.loudnessLufs),
        truePeakDbfs: numberOrNull(row.truePeakDbfs),
    };

    return analysis.bpm === null && analysis.loudnessLufs === null ? null : analysis;
};

/** The wire form of an imported track, spelled the way the sidecar reads it. */
export const matchRequestBody = (tracks: ImportedTrack[]) =>
    tracks.map((track) => ({
        album: track.album ?? null,
        artists: track.artists,
        durationMs: track.durationMs ?? null,
        isrc: track.isrc ?? null,
        title: track.title,
    }));

export class SidecarClient {
    private readonly baseUrl: string;

    private readonly deviceId: string;

    private readonly fetchImpl: typeof fetch;

    private readonly token: string;

    constructor(options: SidecarClientOptions) {
        this.baseUrl = trimTrailingSlash(options.baseUrl);
        this.deviceId = options.deviceId;
        this.token = options.token;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    /**
     * `GET /aoide/audio-analysis?ids=…`: how loud each track is and how fast,
     * as the sidecar measured it. See `docs/audio-analysis.md`.
     *
     * The same decode as `/aoide/sound-bounds` and deliberately the same shape,
     * so this is the same call with a different noun: chunked at the server's
     * ceiling, a 404 ending it at once with `absent`, any other failure
     * thrown. A caller that gets `absent` normalises nothing, which is what
     * every track did before this existed — the endpoint is not built yet, so
     * that is the state this ships in.
     */
    async audioAnalysis(ids: readonly string[]): Promise<AudioAnalysisAnswer> {
        if (ids.length === 0) return NO_ANALYSIS;

        const analysis: Record<string, AudioAnalysis | null> = {};
        const pending: string[] = [];

        for (let at = 0; at < ids.length; at += AUDIO_ANALYSIS_IDS_PER_REQUEST) {
            const chunk = ids.slice(at, at + AUDIO_ANALYSIS_IDS_PER_REQUEST);
            const response = await this.send(
                `/aoide/audio-analysis?ids=${encodeURIComponent(chunk.join(','))}`,
                { method: 'GET' },
            );

            if (response.status === 404) return { absent: true, analysis: {}, pending: [] };
            if (!response.ok) {
                throw syncErrorFromReply('aoide/audio-analysis', await this.readReply(response));
            }

            const body = await this.readJson<{ analysis?: unknown; pending?: unknown }>(
                response,
                'aoide/audio-analysis',
            );

            if (body.analysis && typeof body.analysis === 'object') {
                for (const [id, value] of Object.entries(body.analysis)) {
                    const row = readAnalysis(value);
                    if (row !== undefined) analysis[id] = row;
                }
            }
            for (const id of listFrom<unknown>(body.pending)) {
                if (typeof id === 'string') pending.push(id);
            }
        }

        return { absent: false, analysis, pending };
    }

    /**
     * Fetch a cover by hash.
     *
     * Callers should do this lazily, when something is about to draw one, never
     * during sync — a device joining an account would otherwise download every
     * cover in the library before it finished syncing, most of which it will
     * never show.
     */
    async getImage(sha256: string): Promise<null | Uint8Array> {
        const response = await this.send(`/aoide/images/${sha256}`, { method: 'GET' });

        if (response.status === 404) return null;
        if (!response.ok) {
            throw syncErrorFromReply('Fetching a cover', await this.readReply(response));
        }

        return new Uint8Array(await response.arrayBuffer());
    }

    /** A cheap "do I need to upload this?". */
    async hasImage(sha256: string): Promise<boolean> {
        const response = await this.send(`/aoide/images/${sha256}`, { method: 'HEAD' });

        if (response.status === 404) return false;
        if (!response.ok) {
            throw syncErrorFromReply('Checking for a cover', await this.readReply(response));
        }

        return true;
    }

    /**
     * Which playlists are shared, in either direction.
     *
     * The sync engine re-reads this after a "not shared with you for editing"
     * refusal, because that refusal is the one that can become an acceptance.
     * A playlist that has left this list has left this account: drop it locally
     * rather than keeping a copy nobody can reach.
     */
    async listShares(): Promise<PlaylistShare[]> {
        const response = await this.send('/aoide/shares', { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/shares', await this.readReply(response));
        }

        return listFrom<PlaylistShare>(
            await this.readJson<unknown>(response, 'aoide/shares'),
            'shares',
        );
    }

    /**
     * Every device's queue, most recently updated first.
     *
     * "Resume across devices" offers the first entry that is **not**
     * `isCurrentDevice`, and judges how recent it is on `ageSeconds` or
     * `receivedAt` — never on `updatedAt`. The first two are the server's clock;
     * `updatedAt` is the writing device's, so a machine whose clock is set wrong
     * would otherwise claim to be the most recent one and win every handover.
     */
    /**
     * `POST /aoide/match`: the sidecar's answer for each imported track, or null
     * where the library has nothing for it.
     *
     * One request instead of several per track. The sidecar carries the same
     * matching rules as `playlist-import.ts` and is checked against the same
     * table of cases, so it answers as this device would — only from inside the
     * library, where a thousand rows is a lookup rather than a thousand round
     * trips. Throws when the sidecar is absent or fails; the caller matches
     * locally then.
     */
    async match(tracks: ImportedTrack[]): Promise<Array<null | SidecarMatch>> {
        const results: Array<null | SidecarMatch> = [];
        for (let at = 0; at < tracks.length; at += MATCH_ROWS_PER_REQUEST) {
            const response = await this.send('/aoide/match', {
                body: JSON.stringify(
                    matchRequestBody(tracks.slice(at, at + MATCH_ROWS_PER_REQUEST)),
                ),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            });
            if (!response.ok) {
                throw syncErrorFromReply('aoide/match', await this.readReply(response));
            }
            const body = await this.readJson<{ results?: unknown }>(response, 'aoide/match');
            if (!Array.isArray(body.results)) {
                throw new SyncError('permanent', 'aoide/match answered without results');
            }
            results.push(...(body.results as Array<null | SidecarMatch>));
        }
        return results;
    }

    /**
     * Blobs the server holds that no playlist names.
     *
     * Also the cheapest answer to "did my upload arrive?" — a blob pushed
     * moments ago shows up here with `ageDays` 0, because nothing references it
     * until the op naming it lands.
     */
    async orphanedImages(): Promise<OrphanImage[]> {
        const response = await this.send('/aoide/images/orphans', { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/images/orphans', await this.readReply(response));
        }

        return listFrom<OrphanImage>(
            await this.readJson<unknown>(response, 'aoide/images/orphans'),
            'images',
            'orphans',
        );
    }

    /**
     * Delete play history older than `olderThanDays`. Only `play_events` is
     * prunable — everything else is small, or is not the kind of thing a
     * retention policy should be deciding about.
     *
     * Omitting the argument leaves the cutoff to the server, which is the
     * authority on its own default. Naming 90 here would be a second copy of a
     * number that lives elsewhere, and the two would eventually disagree.
     */
    async pruneRetention(olderThanDays?: number): Promise<PruneResult> {
        const response = await this.send(`/aoide/retention/prune${daysQuery(olderThanDays)}`, {
            method: 'POST',
        });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/retention/prune', await this.readReply(response));
        }

        const body = await this.readJson<Partial<PruneResult>>(response, 'aoide/retention/prune');
        return { pruned: Number(body.pruned ?? 0) };
    }

    /**
     * Read ops from `since` forward.
     *
     * `since` is always sent, as `0` on a device that has never synced, rather
     * than omitted — omitting it is defensible and also the client being clever
     * at the server's expense.
     *
     * The caller must store the returned cursor **only after applying the whole
     * batch**, so an interrupted sync replays rather than skips.
     */
    async pull(since: number, limit: number = PULL_LIMIT): Promise<PullResponse> {
        const url = `/aoide/sync/pull?since=${encodeURIComponent(String(since))}&limit=${encodeURIComponent(String(limit))}`;
        const response = await this.send(url, { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/sync/pull', await this.readReply(response));
        }

        const body = await this.readJson<PullResponse>(response, 'aoide/sync/pull');

        return {
            cursor: body.cursor,
            hasMore: Boolean(body.hasMore),
            // A batch containing one op this client cannot represent must not
            // discard the rest of the batch, and must not stop the cursor from
            // advancing past it — that would wedge the sync permanently on an
            // entity a newer build introduced.
            ops: (body.ops ?? [])
                .filter((op) => isSyncEntity(op.entity))
                // Everything else on the op travels untouched, including fields
                // this build has never heard of. Only the two the merge does
                // arithmetic on are checked, and only for being numbers.
                .map((op) => ({
                    ...op,
                    receivedAt: finiteOrUndefined(op.receivedAt),
                    seq: finiteOrUndefined(op.seq),
                })),
        };
    }

    /**
     * Send ops the server has not accepted yet.
     *
     * Push before pull: this device's own ops come back with a sequence number,
     * which is how it learns they were durably accepted.
     */
    async push(ops: SyncOp[]): Promise<PushResponse> {
        const request: PushRequest = { deviceId: this.deviceId, ops };
        const response = await this.send('/aoide/sync/push', {
            body: JSON.stringify(request),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/sync/push', await this.readReply(response));
        }

        const body = await this.readJson<PushResponse>(response, 'aoide/sync/push');

        return {
            accepted: body.accepted ?? [],
            cursor: body.cursor,
            rejected: body.rejected ?? [],
        };
    }

    /**
     * Upload a cover, addressed by its own SHA-256.
     *
     * **This must happen before pushing the op that names the hash.** An op
     * naming a hash the server does not hold leaves every other device with a
     * playlist whose cover can never be fetched, and nothing afterwards
     * notices — the row is perfectly valid, the image simply is not there.
     */
    async putImage(sha256: string, bytes: Uint8Array, mime: string): Promise<void> {
        const response = await this.send(`/aoide/images/${sha256}`, {
            // Content addressing makes this idempotent: re-uploading the same
            // bytes is a no-op rather than a conflict.
            body: bytes as unknown as BodyInit,
            headers: { 'Content-Type': mime },
            method: 'PUT',
        });

        if (!response.ok) {
            throw syncErrorFromReply('Uploading a cover', await this.readReply(response));
        }
    }

    async queues(): Promise<QueueEntry[]> {
        const response = await this.send('/aoide/queue', { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/queue', await this.readReply(response));
        }

        return listFrom<QueueEntry>(
            await this.readJson<unknown>(response, 'aoide/queue'),
            'entries',
            'queues',
        );
    }

    /**
     * Sweep unreferenced blobs.
     *
     * `olderThanDays` can only make the sweep **more** cautious — the server
     * clamps it up to its own thirty-day grace. That direction is the whole
     * safety property: a blob nothing references here may still be named by a
     * playlist on a phone that has been in a drawer for three weeks.
     */
    async reclaimImages(olderThanDays?: number): Promise<ReclaimResult> {
        const response = await this.send(
            `/aoide/images/orphans/reclaim${daysQuery(olderThanDays)}`,
            { method: 'POST' },
        );

        if (!response.ok) {
            throw syncErrorFromReply(
                'aoide/images/orphans/reclaim',
                await this.readReply(response),
            );
        }

        const body = await this.readJson<Partial<ReclaimResult>>(
            response,
            'aoide/images/orphans/reclaim',
        );
        return { reclaimed: Number(body.reclaimed ?? 0), sha256: body.sha256 };
    }

    /** How much play history the server is holding, and how far back it goes. */
    async retention(): Promise<RetentionReport> {
        const response = await this.send('/aoide/retention', { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/retention', await this.readReply(response));
        }

        return this.readJson<RetentionReport>(response, 'aoide/retention');
    }

    /** Grant another Jellyfin user access to a playlist. */
    async share(request: ShareRequest): Promise<void> {
        const response = await this.send('/aoide/shares', {
            body: JSON.stringify(request),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/shares', await this.readReply(response));
        }
    }

    /**
     * `GET /aoide/sound-bounds?ids=…`: where each track's sound starts and
     * stops, as the sidecar measured it. See `docs/sound-bounds.md`.
     *
     * Chunked at the server's ceiling. A 404 ends the call at once with
     * `absent` — the sidecar predates the endpoint, and asking it two hundred
     * more times would not change that. Any other failure throws, and the
     * caller plays the track whole. A row that is not a pair of finite numbers
     * is left out rather than trusted; the track then reads as unknown and is
     * asked about again, which is the honest state for a row nobody can read.
     */
    async soundBounds(ids: readonly string[]): Promise<SoundBoundsAnswer> {
        if (ids.length === 0) return NO_BOUNDS;

        const bounds: Record<string, null | SoundBounds> = {};
        const pending: string[] = [];

        for (let at = 0; at < ids.length; at += SOUND_BOUNDS_IDS_PER_REQUEST) {
            const chunk = ids.slice(at, at + SOUND_BOUNDS_IDS_PER_REQUEST);
            const response = await this.send(
                `/aoide/sound-bounds?ids=${encodeURIComponent(chunk.join(','))}`,
                { method: 'GET' },
            );

            if (response.status === 404) return { absent: true, bounds: {}, pending: [] };
            if (!response.ok) {
                throw syncErrorFromReply('aoide/sound-bounds', await this.readReply(response));
            }

            const body = await this.readJson<{ bounds?: unknown; pending?: unknown }>(
                response,
                'aoide/sound-bounds',
            );

            if (body.bounds && typeof body.bounds === 'object') {
                for (const [id, value] of Object.entries(body.bounds)) {
                    const row = readBounds(value);
                    if (row !== undefined) bounds[id] = row;
                }
            }
            for (const id of listFrom<unknown>(body.pending)) {
                if (typeof id === 'string') pending.push(id);
            }
        }

        return { absent: false, bounds, pending };
    }

    /**
     * The server's view of who has pulled how far.
     *
     * Worth surfacing: since 1.7.0.0 the server prunes no further than the
     * lowest cursor among devices seen recently, and a device that pushes but
     * never pulls is invisible to that guard. This is where a device falling
     * behind can be seen before its history is gone.
     */
    async status(): Promise<SyncStatus> {
        const response = await this.send('/aoide/sync/status', { method: 'GET' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/sync/status', await this.readReply(response));
        }

        return this.readJson<SyncStatus>(response, 'aoide/sync/status');
    }

    /**
     * Revoke a user's access to a playlist.
     *
     * **Not retroactive.** Ops that user already pushed stay in the log and stay
     * applied; this only stops the next one. An op of theirs still queued on
     * their own device comes back refused, which is the refusal
     * `classifyRejection` singles out.
     */
    async unshare(playlistId: string, granteeUserId: string): Promise<void> {
        const path = `/aoide/shares/${encodeURIComponent(playlistId)}/${encodeURIComponent(granteeUserId)}`;
        const response = await this.send(path, { method: 'DELETE' });

        if (!response.ok) {
            throw syncErrorFromReply('aoide/shares (delete)', await this.readReply(response));
        }
    }

    private authHeader(): string {
        return `MediaBrowser Token="${this.token}"`;
    }

    private async readJson<T>(response: Response, context: string): Promise<T> {
        const text = await response.text();

        try {
            return JSON.parse(text) as T;
        } catch {
            // A 200 that is not JSON is usually a proxy or a login page standing
            // where the sidecar should be. Say so with the body attached, since
            // the body is the only thing that identifies which.
            throw new SyncError('permanent', `${context} returned a reply that is not JSON`, {
                body: text,
                status: response.status,
            });
        }
    }

    private async readReply(response: Response): Promise<ServerReply> {
        let body = '';
        try {
            body = await response.text();
        } catch {
            // A body that cannot be read is not worth failing over; the status
            // still classifies the error.
        }
        return { body, status: response.status };
    }

    private async send(path: string, init: RequestInit): Promise<Response> {
        try {
            return await this.fetchImpl(`${this.baseUrl}${path}`, {
                ...init,
                headers: { ...init.headers, Authorization: this.authHeader() },
            });
        } catch (cause) {
            // fetch rejects only for transport failures — DNS, refused
            // connection, TLS, abort. None of those say anything about the data,
            // so all of them are worth retrying.
            throw new SyncError(
                'transient',
                `Could not reach the server: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }
}
