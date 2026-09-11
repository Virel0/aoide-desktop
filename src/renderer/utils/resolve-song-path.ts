/**
 * A song's path on the server, as the server reports it.
 *
 * There was a prefix rewrite here: a stored find/replace pair for anyone whose
 * library sat at a different root on this machine than on the server. Both
 * halves shipped empty and there was no screen left to fill them in, so the
 * rewrite never fired.
 */
export const resolveSongPath = (path: null | string | undefined): null | string => path || null;

export const useResolvedSongPath = (path: null | string | undefined): null | string =>
    resolveSongPath(path);
