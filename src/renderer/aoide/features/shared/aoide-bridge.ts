import type { SyncStore } from '/@/renderer/aoide/sync/sync-engine';

import isElectron from 'is-electron';

/**
 * The renderer's side of the curation store, and an honest answer when there
 * isn't one.
 *
 * The store is a SQLite database in the main process, so every screen reaches it
 * through `window.api.aoide`. That object does not exist in the web and remote
 * builds — they are the same renderer served over HTTP with no preload — and a
 * screen that assumes it does fails with `Cannot read properties of undefined`,
 * which says nothing about why. Asking here once means the sidebar can simply
 * not offer the section rather than offering one that throws.
 */

/** True when this build has a main process to talk to at all. */
export const isAoideAvailable = (): boolean => isElectron() && Boolean(window.api?.aoide);

/**
 * The playlist bridge, or a throw naming what is missing.
 *
 * Every caller is inside a react-query `queryFn` or a mutation, so the throw
 * surfaces as a query error on the screen that asked rather than as a blank
 * page.
 */
export const aoidePlaylists = () => {
    const bridge = isAoideAvailable() ? window.api.aoide.playlists : undefined;

    if (!bridge) {
        throw new Error(
            'Aoide playlists need the desktop app — the web build has no curation store',
        );
    }

    return bridge;
};

/**
 * The op log, if this build exposes one yet.
 *
 * **It does not, at the time of writing.** `SyncEngine` needs `pendingOps`,
 * `applyRemote`, the cursor pair and the two image calls, and the preload bridge
 * only carries playlists — the agents who own `src/preload` and `src/main` have
 * not published a sync channel. This screen therefore cannot push a local edit,
 * and it says so instead of pretending.
 *
 * The lookup is written against `SyncStore` rather than some shape of its own
 * because `SyncStore` is already the contract: it is what the engine consumes,
 * every member already allows a promise precisely so an IPC bridge can satisfy
 * it, and a second definition here would be the "two sets that must agree" that
 * this project has paid for twice. The cast goes through `unknown` because the
 * declared preload type genuinely does not have the member yet — that is the
 * fact being tested, not a type to be argued with.
 */
export const aoideSyncStore = (): SyncStore | undefined => {
    if (!isAoideAvailable()) return undefined;

    const bridge = window.api.aoide as unknown as { sync?: SyncStore };
    return typeof bridge.sync?.pendingOps === 'function' ? bridge.sync : undefined;
};
