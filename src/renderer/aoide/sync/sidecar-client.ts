import { SyncError, syncErrorFromReply } from './errors';

import {
    isSyncEntity,
    PullResponse,
    PushRequest,
    PushResponse,
    ServerReply,
    SyncOp,
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
 * Transport for the two sync endpoints and the three image ones.
 *
 * Deliberately only transport: one request in, one parsed reply out. Retry,
 * bisection, cursor bookkeeping and quarantine are policy and live in the sync
 * engine, which needs the local op log to do any of it. Keeping them apart is
 * what lets this be tested without a database.
 */
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
            ops: (body.ops ?? []).filter((op) => isSyncEntity(op.entity)),
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
