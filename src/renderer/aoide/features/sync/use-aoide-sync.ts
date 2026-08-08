import type { AoideSyncState } from '/@/renderer/aoide/features/sync/sync-report';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { aoidePlaylistKeys } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { aoideSyncStore } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { describeSyncError, syncMessages } from '/@/renderer/aoide/features/sync/sync-report';
import { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';
import { SyncEngine, syncFailed } from '/@/renderer/aoide/sync/sync-engine';
import { useAuthStore, useCurrentServerWithCredential } from '/@/renderer/store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';

/**
 * Running a sync, and knowing what it did.
 *
 * The transport is built from the server Feishin is already signed in to —
 * same host, same `MediaBrowser Token`, same device id the Jellyfin client
 * sends. Configuring a second server for the sidecar would mean a second thing
 * to get wrong and a second thing to keep signed in.
 */

export const useAoideSync = () => {
    const server = useCurrentServerWithCredential();
    const deviceId = useAuthStore((state) => state.deviceId);
    const queryClient = useQueryClient();
    const [state, setState] = useState<AoideSyncState>({ phase: 'idle' });

    // Read out before the memo rather than inside it. The React compiler infers
    // `server.credential` as the dependency and rejects a hook whose written
    // deps say `server?.credential` instead — the two are the same value and not
    // the same expression, and it will not guess which was meant.
    const baseUrl = getServerUrl(server);
    const credential = server?.credential;

    const transport = useMemo(() => {
        if (!baseUrl || !credential) return undefined;
        return new SidecarClient({ baseUrl, deviceId, token: credential });
    }, [baseUrl, credential, deviceId]);

    /*
     * The op log, if the preload bridge exposes one.
     *
     * Read once per mount rather than per render: it is a property of the build,
     * not of any state, and re-reading it would rebuild the engine — which holds
     * the revoked-share block list — on every keystroke elsewhere on the page.
     */

    const store = useMemo(() => aoideSyncStore(), []);

    const engine = useMemo(() => {
        if (!transport || !store) return undefined;
        return new SyncEngine({ store, transport, userId: server?.userId ?? undefined });
    }, [server?.userId, store, transport]);

    const sync = useCallback(async () => {
        if (!transport) {
            setState({ error: 'No server is signed in', finishedAt: Date.now(), phase: 'error' });
            return;
        }

        setState((previous) => ({ ...previous, phase: 'running' }));

        // `sync()` never rejects — every failure comes back on the result, so
        // that a push that failed does not hide a pull that worked.
        if (engine) {
            const result = await engine.sync();

            // An applied op wrote rows in the main process, and no screen here
            // was told. Without this the sidebar and every open playlist keep
            // showing what they read before the sync, and the only clue is a
            // count that does not add up.
            if (result.applied > 0) {
                void queryClient.invalidateQueries({ queryKey: aoidePlaylistKeys.all });
            }

            setState({
                ...syncMessages(result),
                finishedAt: Date.now(),
                phase: syncFailed(result) ? 'error' : 'success',
                result,
            });
            return;
        }

        /*
         * No op log to push, so the honest thing is the half that can be done:
         * ask the sidecar where it is. It proves the host, the token and the
         * plugin in one request, and it is the same call that shows a device
         * falling behind the server's retention guard.
         *
         * It leaves `result` unset on purpose, and that absence is the whole
         * evidence the panel has that nothing was actually synced: `finishedAt`
         * is set on every path, so a status line keyed off it says "Last synced"
         * after a run that moved not one op.
         */
        try {
            setState({
                finishedAt: Date.now(),
                phase: 'success',
                status: await transport.status(),
            });
        } catch (error) {
            setState({
                error: describeSyncError(error),
                finishedAt: Date.now(),
                phase: 'error',
            });
        }
    }, [engine, queryClient, transport]);

    return {
        /** False while the preload bridge exposes no op log — see `aoideSyncStore`. */
        canPushLocalEdits: Boolean(engine),
        hasServer: Boolean(transport),
        state,
        sync,
    };
};
