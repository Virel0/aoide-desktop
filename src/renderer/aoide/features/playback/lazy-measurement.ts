/**
 * When to ask the sidecar again about something it measures lazily.
 *
 * Two features ask the sidecar to decode a file it holds — sound bounds and
 * audio analysis — and the spec says outright that they are the same decode.
 * The policy is therefore one policy, and lives here once rather than in each
 * cache, where the two would drift and one feature would quietly poll a server
 * twice as hard as the other for no reason anybody wrote down.
 */

/** The sidecar measures lazily; a minute is long enough for a track and short enough to notice. */
export const PENDING_RETRY_MS = 60_000;

/** A request that has not answered in this long is presumed lost. */
export const ASKED_TIMEOUT_MS = 30_000;

/**
 * How long to leave a sidecar alone after it answered 404.
 *
 * These endpoints are newer than most installs. Asking once per track change
 * would be a 404 every few minutes forever; asking once per ten minutes
 * notices an upgrade the same day and costs nothing anyone sees.
 */
export const ABSENT_RETRY_MS = 10 * 60_000;
