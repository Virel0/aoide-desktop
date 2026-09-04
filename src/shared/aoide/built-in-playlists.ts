import type { SmartRules } from '/@/shared/aoide/smart-rules';

/**
 * Smart playlists every library gets, with names a listener can form a habit
 * around.
 *
 * Mirrors the phone's `BuiltInPlaylist` exactly — same fixed ids, same rules —
 * so whichever device runs first creates the row and the other merges into it
 * rather than making a twin. The rules below are the JSON pinned by the phone's
 * `BuiltInPlaylistTests`; change them there and here together.
 */
export interface BuiltInPlaylist {
    id: string;
    name: string;
    notes: string;
    rules: SmartRules;
}

export const BUILT_IN_PLAYLISTS: readonly BuiltInPlaylist[] = [
    {
        id: 'builtin:rediscover',
        name: 'Rediscover Mix',
        notes: "Songs you played a lot and haven't heard in six months. Changes as you listen.",
        rules: {
            limit: 40,
            match: 'all',
            rules: [
                { field: 'last_played', op: 'notInTheLast', value: '-6m' },
                { field: 'play_count', op: 'greaterThan', value: 2 },
            ],
            sort: { dir: 'desc', field: 'play_count' },
        },
    },
    {
        id: 'builtin:heavy-rotation',
        name: 'Heavy Rotation',
        notes: "What you've played most this month.",
        rules: {
            limit: 25,
            match: 'all',
            rules: [
                { field: 'last_played', op: 'inTheLast', value: '-1m' },
                { field: 'play_count', op: 'greaterThan', value: 1 },
            ],
            sort: { dir: 'desc', field: 'play_count' },
        },
    },
];
