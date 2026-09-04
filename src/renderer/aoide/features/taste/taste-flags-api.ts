import type { TrackInput } from '/@/main/features/aoide/playlists';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';

/**
 * Taste flags as react-query.
 *
 * Rooted at `['aoide']` like the playlist keys, and for the same reason: these
 * rows come from the local store, belong to no `serverId`, and must not be
 * cleared by a server switch. Every write invalidates the whole subtree — a
 * flag changes the menu it was set from, the settings list, and nothing else
 * this cache holds, so one key covers it.
 */
export const tasteFlagKeys = {
    all: ['aoide', 'flags'] as const,
    flagged: () => ['aoide', 'flags', 'flagged'] as const,
    track: (jellyfinId: string) => ['aoide', 'flags', 'track', jellyfinId] as const,
};

export const useTrackFlags = (jellyfinId: string | undefined) =>
    useQuery({
        enabled: isAoideAvailable() && Boolean(jellyfinId),
        queryFn: () => window.api.aoide.flags.get(jellyfinId ?? ''),
        queryKey: tasteFlagKeys.track(jellyfinId ?? ''),
    });

export const useFlaggedTracks = () =>
    useQuery({
        enabled: isAoideAvailable(),
        queryFn: () => window.api.aoide.flags.flagged(),
        queryKey: tasteFlagKeys.flagged(),
    });

export interface SetTrackFlag {
    flag: 'dontCount' | 'notInterested';
    track: TrackInput;
    value: boolean;
}

export const useSetTrackFlag = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ flag, track, value }: SetTrackFlag) =>
            flag === 'notInterested'
                ? window.api.aoide.flags.setNotInterested(track, value)
                : window.api.aoide.flags.setDontCount(track, value),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: tasteFlagKeys.all }),
    });
};

export const useClearTrackFlags = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (jellyfinId: string) => window.api.aoide.flags.clear(jellyfinId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: tasteFlagKeys.all }),
    });
};
