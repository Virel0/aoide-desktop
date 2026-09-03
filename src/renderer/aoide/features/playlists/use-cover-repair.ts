import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { aoidePlaylistKeys } from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { planCoverRepairs } from '/@/renderer/aoide/features/playlists/cover-repair';
import { aoidePlaylists, isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { playlistsQueries } from '/@/renderer/features/playlists/api/playlists-api';
import { useCurrentServerId } from '/@/renderer/store';
import { PlaylistListSort, SortOrder } from '/@/shared/types/domain-types';

/**
 * Running the cover repair: read both lists, plan, write through the store.
 *
 * Every write goes through `setArtwork` on the bridge, so it lands in the op
 * log like any other edit and the phone gets the cover on its next sync. That
 * is the point of doing this here rather than in a SQL statement: a row that
 * changed without an op silently never syncs.
 *
 * Once per launch, after the first sync that succeeds — the sync is what
 * brings in playlists the phone imported, and the repair is only ever for
 * those. A flag at module level rather than in a ref, because the effect that
 * calls it is remounted whenever the server changes and "once per launch" is
 * about the process, not the component.
 */
let repairedThisLaunch = false;

export const useCoverRepair = () => {
    const queryClient = useQueryClient();
    const serverId = useCurrentServerId();

    /** Repairs what it can and resolves to how many covers it set. */
    const repair = useCallback(async (): Promise<number> => {
        if (!isAoideAvailable() || !serverId) return 0;

        const [local, remote] = await Promise.all([
            aoidePlaylists().list(),
            queryClient.fetchQuery(
                playlistsQueries.list({
                    query: {
                        sortBy: PlaylistListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex: 0,
                    },
                    serverId,
                }),
            ),
        ]);

        const plan = planCoverRepairs(local, remote?.items ?? []);

        for (const step of plan) {
            await aoidePlaylists().setArtwork(step.playlistId, step.artworkItemId);
        }

        if (plan.length > 0) {
            void queryClient.invalidateQueries({ queryKey: aoidePlaylistKeys.all });
        }

        return plan.length;
    }, [queryClient, serverId]);

    const repairOnce = useCallback(async (): Promise<number> => {
        if (repairedThisLaunch) return 0;
        // Set before the run, not after: a Jellyfin that will not answer is
        // not a reason to ask it again on every focus.
        repairedThisLaunch = true;
        return repair();
    }, [repair]);

    return { repair, repairOnce };
};
