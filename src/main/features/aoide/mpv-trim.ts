import type { TrimPlan } from '/@/shared/aoide/trim-plan';

import { ipcMain } from 'electron';

import log from '/@/main/logger';
import { mpvFileOptions } from '/@/shared/aoide/trim-plan';

/**
 * Silence trimming for the mpv backend: per-file `start=` and `end=` on
 * `loadfile`.
 *
 * mpv's playlist carries options per entry and applies them when that entry
 * begins, which is exactly the shape Feishin's two-item queue needs: the next
 * track is appended long before it plays, with bounds that are its own.
 * Setting `start`/`end` as global properties instead would apply whatever
 * values were current when the next file happened to start.
 *
 * The renderer tells this process the plan for each track it knows bounds
 * for, keyed by Jellyfin id; the stream URL Feishin hands `loadfile` carries
 * that id as a path segment, so the lookup is by URL and Feishin's own player
 * code changes by one call per load.
 *
 * **The `loadfile` argument order changed in mpv 0.38.0.** Before, the options
 * were the third positional argument; since, the third is an insertion index
 * and the options are fourth, with `-1` in the index slot when the options are
 * wanted (DOCS/man/input.rst, "loadfile"). node-mpv 2.0.0-beta.3's own
 * `load(file, mode, options)` sends the options third and is therefore wrong
 * on every mpv from 0.38 on, which is why the command is built here and sent
 * through `command()` rather than through the wrapper's `load()`.
 */

const plans = new Map<string, TrimPlan>();

/**
 * Learn or forget plans. `null` forgets: a track measured as "nothing to trim"
 * has no plan, and a stale plan for it would trim what was measured as sound.
 */
export const rememberTrimPlans = (update: Record<string, null | TrimPlan>): void => {
    for (const [id, plan] of Object.entries(update)) {
        if (plan) plans.set(id, plan);
        else plans.delete(id);
    }
};

/** The setting was turned off: nothing is trimmed from now on. */
export const forgetTrimPlans = (): void => plans.clear();

/** For tests and diagnostics. */
export const knownTrimPlans = (): ReadonlyMap<string, TrimPlan> => plans;

/**
 * The options for a stream URL, or nothing.
 *
 * Both of Feishin's Jellyfin stream shapes — `/Items/{id}/Download` and
 * `/audio/{id}/universal` — carry the id between slashes, and a Jellyfin id
 * is 32 hex characters, so a segment match cannot hit another track.
 */
export const trimOptionsForUrl = (url: string): Record<string, string> | undefined => {
    for (const [id, plan] of plans) {
        if (url.includes(`/${id}/`)) {
            const options = mpvFileOptions(plan);
            return Object.keys(options).length > 0 ? options : undefined;
        }
    }
    return undefined;
};

/** `mpv 0.40.0-dirty` → `[0, 40]`; anything unreadable → null. */
export const parseMpvVersion = (text: unknown): [number, number] | null => {
    if (typeof text !== 'string') return null;
    const match = /(\d+)\.(\d+)/.exec(text);
    return match ? [Number(match[1]), Number(match[2])] : null;
};

/**
 * Whether `loadfile` takes an index as its third argument.
 *
 * True from 0.38.0. Unknown is read as current: the Arch package pulls in
 * whatever mpv is current, and a version string this cannot read is far
 * likelier a new format than a build from 2023.
 */
export const takesIndexArgument = (version: [number, number] | null): boolean =>
    version === null || version[0] > 0 || version[1] >= 38;

/** The argument list for `loadfile`, in the order this mpv wants it. */
export const loadfileArgs = (
    version: [number, number] | null,
    url: string,
    mode: 'append' | 'replace',
    options?: Record<string, string>,
): Array<-1 | Record<string, string> | string> => {
    if (!options) return [url, mode];
    return takesIndexArgument(version) ? [url, mode, -1, options] : [url, mode, options];
};

/** The part of node-mpv this needs. Narrow so a test can hand in a stub. */
export interface MpvLike {
    command(command: string, args: unknown[]): Promise<unknown>;
    getProperty(property: string): Promise<unknown>;
    load(file: string, mode: 'append' | 'replace'): Promise<unknown>;
}

const versions = new WeakMap<MpvLike, Promise<[number, number] | null>>();

const versionOf = (mpv: MpvLike): Promise<[number, number] | null> => {
    let known = versions.get(mpv);
    if (!known) {
        known = mpv
            .getProperty('mpv-version')
            .then(parseMpvVersion)
            .catch((error: unknown) => {
                log.warn('Could not read the mpv version; assuming a current one', error);
                return null;
            });
        versions.set(mpv, known);
    }
    return known;
};

/**
 * Load a file into mpv, with its trim if one is known.
 *
 * Without a plan this is exactly Feishin's own `load(url, mode)`, wait-for-
 * `file-loaded` and all. With one, the command goes out directly — the
 * wrapper's promise resolves on mpv's reply, and mpv runs commands in the
 * order they arrive, so a `replace` followed by an `append` still lands in
 * that order. A null player is a no-op, as `getMpvInstance()?.load` was.
 */
export const loadWithTrim = async (
    mpv: MpvLike | null | undefined,
    url: string,
    mode: 'append' | 'replace',
): Promise<void> => {
    if (!mpv) return;

    const options = trimOptionsForUrl(url);
    if (!options) {
        await mpv.load(url, mode);
        return;
    }

    await mpv.command('loadfile', loadfileArgs(await versionOf(mpv), url, mode, options));
};

export const registerTrimHandlers = (): void => {
    ipcMain.on('aoide:trim-remember', (_event, update: Record<string, null | TrimPlan>) =>
        rememberTrimPlans(update),
    );
    ipcMain.on('aoide:trim-forget', () => forgetTrimPlans());
};
