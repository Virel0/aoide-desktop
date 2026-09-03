/**
 * When a sync that nobody asked for is allowed to run.
 *
 * The button on the playlists page was, until this existed, the only thing that
 * ever synced — so an edit made on the phone reached this machine only when
 * somebody opened that page and pressed it. A music player is not a thing
 * people press buttons on; it is left open for days. So the app syncs by itself
 * on launch and whenever its window comes back into view, and this file is the
 * one rule that keeps the second of those from becoming a request per
 * alt-tab.
 *
 * Kept apart from the effect because the effect cannot be rendered under the
 * test runner and the rule is the part worth proving.
 */

/**
 * The least time between two focus-triggered syncs, measured from when the
 * previous one *started* — the engine already joins a caller onto a run in
 * flight, so a sync that is still going costs a second caller nothing.
 */
export const FOCUS_SYNC_MIN_INTERVAL_MS = 60_000;

/**
 * Whether a sync prompted by the window regaining focus should run now.
 *
 * `lastStartedAt` is undefined until the first run of the session, and the
 * first run is never held back: a window that has just been given focus for
 * the first time is a window that has just been opened.
 */
export const isFocusSyncDue = (
    lastStartedAt: number | undefined,
    now: number,
    minIntervalMs: number = FOCUS_SYNC_MIN_INTERVAL_MS,
): boolean => {
    if (lastStartedAt === undefined) return true;
    return now - lastStartedAt >= minIntervalMs;
};
