import { z } from 'zod';

/**
 * Which playlists the sidebar shows: Jellyfin's, Aoide's, or both.
 *
 * Two sections that look alike and behave differently — one lives on the
 * server, one in a local store that syncs with the phone — sat one above the
 * other for everybody. Someone who imported their Jellyfin playlists into Aoide
 * and now edits only those was looking at a second copy of every list forever.
 *
 * A preference rather than a removal, and `both` by default, so an install that
 * exists today looks exactly as it did. Whichever kind is hidden stays a route
 * and stays a setting: hidden from the sidebar is not gone.
 *
 * Lives here rather than in `settings.store.ts` because the store cannot be
 * imported under the test runner — it pulls in i18n and half the renderer —
 * and the one fact worth pinning is the default.
 */
export const AoidePlaylistSurfaceSchema = z.enum(['both', 'aoide', 'jellyfin']);

export type AoidePlaylistSurface = z.infer<typeof AoidePlaylistSurfaceSchema>;

/** `both`, so that nobody who already has the app sees anything change. */
export const DEFAULT_AOIDE_PLAYLIST_SURFACE: AoidePlaylistSurface = 'both';

export const showsAoidePlaylists = (surface: AoidePlaylistSurface): boolean =>
    surface !== 'jellyfin';

export const showsJellyfinPlaylists = (surface: AoidePlaylistSurface): boolean =>
    surface !== 'aoide';
