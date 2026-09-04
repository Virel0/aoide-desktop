/**
 * The last things you were *in*, so Home can resume any of them in one tap.
 *
 * A context is a thing playback started from: an album, a playlist of either
 * kind, a mix, a station. Not a song — a song is what you heard, a context is
 * where you were, and "where I was" is what somebody sitting back down wants.
 * Recorded when playback starts from that thing's own page, never from a
 * shuffle-all or a search result, because a grid of six that fills up with
 * accidents is a grid nobody looks at.
 *
 * Pure: the store persists a list per server and the grid reads six, and both
 * of those are one line each. Everything worth a test — one entry per thing,
 * newest first, a cap — is here.
 */

export interface RecentContext {
    /**
     * A picture that is not a Jellyfin item's own. Left unset for anything
     * Jellyfin holds — the tile rebuilds those from `id` at draw time, so a
     * server whose address changed does not leave a grid of broken images.
     */
    artworkUrl?: string;
    /** The thing's own id: a Jellyfin item, an Aoide playlist, a mix's description. */
    id: string;
    kind: RecentContextKind;
    /** Milliseconds since the epoch, the writer's clock. Only ever compared on this device. */
    lastOpened: number;
    name: string;
    /** Only for a station: which kind of thing seeded it. */
    seed?: StationSeed;
    /** Only for an Aoide playlist: whether its contents are rules rather than a list. */
    smart?: boolean;
    subtitle?: string;
}

export type RecentContextKind = 'album' | 'aoidePlaylist' | 'jellyfinPlaylist' | 'mix' | 'station';

/** What seeded a station: Jellyfin's instant mix from an album or an artist. */
export type StationSeed = 'album' | 'artist';

/**
 * How many are kept. More than the grid shows, so the sixth tile has
 * something to be replaced by when a newer context arrives and one of the
 * six was played from another page since.
 */
export const RECENT_CONTEXT_CAP = 24;

/** The grid shows six: two rows of three, and the phone's "last six things". */
export const RESUME_GRID_LIMIT = 6;

export const contextKey = (context: Pick<RecentContext, 'id' | 'kind'>): string =>
    `${context.kind}:${context.id}`;

/**
 * Record a context: one entry per kind+id, the newest first, capped.
 *
 * Re-opening something already in the list moves it to the front rather than
 * adding a second copy, so the same album played every evening is one tile
 * and not six.
 */
export const remember = (
    contexts: readonly RecentContext[],
    context: RecentContext,
): RecentContext[] => {
    const key = contextKey(context);
    const others = contexts.filter((candidate) => contextKey(candidate) !== key);

    return [context, ...others]
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .slice(0, RECENT_CONTEXT_CAP);
};

/** The newest `limit`, newest first. */
export const list = (contexts: readonly RecentContext[], limit: number): RecentContext[] =>
    [...contexts].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, Math.max(0, limit));

export interface HandoffSummary {
    /** How long ago the other device wrote its queue, on the server's clock. */
    ageSeconds: number;
    deviceName: string;
}

export type ResumeTile =
    | { context: RecentContext; kind: 'context' }
    | { deviceName: string; kind: 'handoff' };

/**
 * The tiles the grid draws: up to `limit`, and another device's queue first
 * when it was played more recently than anything here.
 *
 * "More recently" compares the handoff's age — a duration, from the server —
 * against this device's own timestamps and clock. That is the only comparison
 * available that never trusts the other device's clock, which the shared
 * queue was built not to do.
 */
export const resumeTiles = (
    contexts: readonly RecentContext[],
    handoff: HandoffSummary | null,
    now: number,
    limit: number = RESUME_GRID_LIMIT,
): ResumeTile[] => {
    const recent = list(contexts, limit);
    const tiles: ResumeTile[] = recent.map((context) => ({ context, kind: 'context' }));

    if (!handoff) return tiles;

    const handoffAt = now - handoff.ageSeconds * 1000;
    const newestHere = recent[0]?.lastOpened ?? Number.NEGATIVE_INFINITY;

    if (handoffAt <= newestHere) return tiles;

    const lead: ResumeTile = { deviceName: handoff.deviceName, kind: 'handoff' };
    return [lead, ...tiles].slice(0, limit);
};
