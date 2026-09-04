import type { Handoff } from '/@/renderer/aoide/features/queue/use-queue-handoff';
import type { PlayerContext } from '/@/renderer/features/player/context/player-context';

import { QueryClient } from '@tanstack/react-query';

import { getSongById } from '/@/renderer/features/player/utils';
import { Play } from '/@/shared/types/types';

/**
 * Pick up another device's queue: the one action, shared by the sync panel
 * and the Home grid so the two cannot drift.
 *
 * The starting track is named rather than the list sliced, so everything
 * before it stays in the queue and Previous still reaches the beginning of
 * what they were listening to. A track this server cannot return is left
 * out and the rest still plays.
 */
export const pickUp = async (
    handoff: Handoff,
    deps: {
        player: Pick<PlayerContext, 'addToQueueByData'>;
        queryClient: QueryClient;
        serverId: string;
    },
): Promise<void> => {
    const { player, queryClient, serverId } = deps;

    const songs = (
        await Promise.allSettled(
            handoff.trackIds.map((id) => getSongById({ id, queryClient, serverId })),
        )
    ).flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []));

    if (songs.length === 0) return;

    const start = songs[Math.min(handoff.position, songs.length - 1)];
    player.addToQueueByData(songs, Play.NOW, start?.id);
};
