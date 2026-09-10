import { ipcMain } from 'electron';

import { mpvGainOptions } from '/@/shared/aoide/loudness';

/**
 * Loudness normalisation for the mpv backend: a per-file `af=volume=…dB` on
 * `loadfile`, alongside the `start=` and `end=` that silence trimming already
 * puts there.
 *
 * The same mechanism as `mpv-trim.ts` and for the same reason: mpv's playlist
 * carries options per entry and applies them when that entry begins, which is
 * what Feishin's two-item queue needs — the next track is appended long before
 * it plays, and its gain is its own. Setting `volume` as a global property
 * instead would apply whatever value was current when the next file happened
 * to start, and would also fight the person's own volume slider, which is that
 * same property.
 *
 * mpv's own `replaygain` property already handles files that carry tags, which
 * is why the renderer never sends a gain for one — the two would attenuate the
 * same file twice. A per-file `af` does replace a global `--af` somebody put in
 * their own mpv parameters, for that file only; nothing in Feishin sets one, so
 * the only way to meet that is to have asked for it.
 *
 * Kept in its own map rather than folded into the trim plans because the two
 * have separate settings: somebody with trimming off and normalisation on must
 * get the gain, and a single payload gated by one switch could not do that.
 * The two maps meet exactly once, where the options for a load are assembled.
 */

const gains = new Map<string, number>();

/**
 * Learn or forget gains, in dB, by Jellyfin id.
 *
 * `null` forgets: a track measured as needing no correction has no gain, and a
 * stale one for it would attenuate a track that was measured as already right.
 */
export const rememberGains = (update: Record<string, null | number>): void => {
    for (const [id, db] of Object.entries(update)) {
        if (typeof db === 'number' && Number.isFinite(db)) gains.set(id, db);
        else gains.delete(id);
    }
};

/** The setting was turned off: nothing is normalised from now on. */
export const forgetGains = (): void => gains.clear();

/** For tests and diagnostics. */
export const knownGains = (): ReadonlyMap<string, number> => gains;

/**
 * The options for a stream URL, or an empty object.
 *
 * Matched by id as a path segment, exactly as the trim plans are: both of
 * Feishin's Jellyfin stream shapes — `/Items/{id}/Download` and
 * `/audio/{id}/universal` — carry the id between slashes.
 */
export const gainOptionsForUrl = (url: string): Record<string, string> => {
    for (const [id, db] of gains) {
        if (url.includes(`/${id}/`)) return mpvGainOptions(db);
    }
    return {};
};

export const registerGainHandlers = (): void => {
    ipcMain.on('aoide:gain-remember', (_event, update: Record<string, null | number>) =>
        rememberGains(update),
    );
    ipcMain.on('aoide:gain-forget', () => forgetGains());
};
