import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useCoverRepair } from '/@/renderer/aoide/features/playlists/use-cover-repair';
import { isFocusSyncDue } from '/@/renderer/aoide/features/sync/sync-schedule';
import { useAoideSync } from '/@/renderer/aoide/features/sync/use-aoide-sync';
import { queryKeys } from '/@/renderer/api/query-keys';
import { useCurrentServerId } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';

/**
 * Syncs without being asked: once when a signed-in server becomes usable, and
 * again whenever the window comes back into view.
 *
 * Until this existed the "Sync now" button was the only trigger, and it lives
 * on a page most sessions never open. An edit made on the phone therefore
 * reached this machine only when somebody remembered to go and fetch it, which
 * on a music player is never. Nothing in Feishin's own effects list does this
 * because nothing in Feishin has a second device to agree with.
 *
 * Renders nothing and says nothing. A sidecar that cannot be reached is logged
 * and otherwise ignored: a player that raises a toast every time the laptop
 * wakes up on a train is a player somebody turns the feature off on. The
 * playlists page still shows the last outcome in full, with the server's own
 * words, for anyone who wants to know.
 */
export const AoideSyncOnLaunchEffect = () => {
    const { canPushLocalEdits, sync } = useAoideSync();
    const { repairOnce } = useCoverRepair();
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();

    // When the previous run began, for the focus throttle. A ref rather than
    // state: nothing draws it, and a re-render per sync would be a re-render
    // for nothing.
    const lastStartedAt = useRef<number | undefined>(undefined);

    useEffect(() => {
        // `canPushLocalEdits` is false until the server's credential has been
        // read *and* this build has an op log to push. Its flip to true is the
        // transition this effect waits for; in the web build it never flips,
        // and a sync with nothing to push would only be a request per focus.
        if (!canPushLocalEdits) return;

        const run = async (reason: 'focus' | 'launch') => {
            lastStartedAt.current = Date.now();

            // `sync()` never rejects; every failure comes back on the state.
            const outcome = await sync();

            if (outcome.phase === 'error') {
                logger.warn(`Aoide background sync (${reason}) failed`, {
                    error: outcome.error,
                });
                return;
            }

            // The sidecar's export can create or rename playlists on Jellyfin
            // itself, and Feishin's list of them is cached by react-query. An
            // applied op is the signal that something changed server-side, so
            // that list is re-read — otherwise an imported playlist shows up in
            // the Aoide section and not in Jellyfin's until a restart.
            if (outcome.result && outcome.result.applied > 0 && serverId) {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.playlists.list(serverId),
                });
            }

            // The one-time cover repair, after the first sync that worked —
            // that is when the playlists the phone imported are all here to
            // be looked at. Its own catch, because a Jellyfin that will not
            // list its playlists is not a sync failure.
            try {
                const repaired = await repairOnce();
                if (repaired > 0) logger.info(`Aoide repaired ${repaired} playlist covers`);
            } catch (error) {
                logger.warn('Aoide cover repair failed', { error });
            }
        };

        void run('launch');

        const onFocus = () => {
            if (!isFocusSyncDue(lastStartedAt.current, Date.now())) return;
            void run('focus');
        };

        // Both events, because they fire in different situations: `focus`
        // when the window is clicked back into from another app, and
        // `visibilitychange` when it is unminimised or its workspace is
        // switched to — which on most window managers does not focus it.
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') onFocus();
        };

        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [canPushLocalEdits, queryClient, repairOnce, serverId, sync]);

    return null;
};
