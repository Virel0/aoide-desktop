import { useMemo } from 'react';

import { SidecarClient } from '/@/renderer/aoide/sync/sidecar-client';
import { useAuthStore, useCurrentServerWithCredential } from '/@/renderer/store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';

/**
 * The sidecar, built from the server this app is already signed in to.
 *
 * Split out of `use-aoide-sync` because fetching a cover needs the transport and
 * nothing else — not the engine, not the op log, not the sync state. A screen
 * drawing a playlist picture should not have to construct a sync engine to do
 * it, and building one per row would give every row its own revoked-share block
 * list.
 *
 * `undefined` before sign-in, which is a normal state and not an error: the
 * sidecar authenticates with the Jellyfin token, so there is nothing to talk to
 * until there is a server.
 */
export const useSidecarTransport = (): SidecarClient | undefined => {
    const server = useCurrentServerWithCredential();
    const deviceId = useAuthStore((state) => state.deviceId);

    // Read into locals first. The exhaustive-deps rule wants the exact
    // expression it sees in the dependency list, and `server?.credential` is the
    // same value as a destructured `credential` without being the same
    // expression — it will not guess which was meant.
    const baseUrl = getServerUrl(server);
    const credential = server?.credential;

    return useMemo(() => {
        if (!baseUrl || !credential) return undefined;
        return new SidecarClient({ baseUrl, deviceId, token: credential });
    }, [baseUrl, credential, deviceId]);
};
