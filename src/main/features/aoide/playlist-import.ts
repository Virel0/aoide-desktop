import type { ImportedPlaylist } from '/@/shared/aoide/playlist-import';

import { ipcMain } from 'electron';

import {
    parseSpotifyEmbed,
    SpotifyEmbedError,
    spotifyEmbedUrl,
    spotifyPlaylistId,
} from '/@/shared/aoide/playlist-import';

export type PageFetcher = (url: string, headers: Record<string, string>) => Promise<PageResponse>;

export interface PageResponse {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}

/**
 * What came of asking Spotify for a playlist.
 *
 * A reason rather than a thrown error, because every one of these is something
 * the screen has to say in words — and "network" versus "Spotify changed its
 * page" call for different words.
 */
export type SpotifyFetchOutcome =
    | { detail?: string; reason: 'network' | 'notALink' | 'pageChanged' | 'unavailable' }
    | { playlist: ImportedPlaylist };

/**
 * The page is served to browsers and says nothing to anything else, so the
 * request introduces itself as one.
 */
export const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const defaultFetcher: PageFetcher = (url, headers) => fetch(url, { headers });

/**
 * Reads a playlist off Spotify's embed page.
 *
 * Done in the main process because the renderer cannot fetch a third-party
 * page — and should not be able to. No account and no key: Spotify's API stopped
 * answering for playlists a developer does not own in early 2026, and the embed
 * page is what is left.
 */
export const fetchSpotifyPlaylist = async (
    link: string,
    fetchPage: PageFetcher = defaultFetcher,
): Promise<SpotifyFetchOutcome> => {
    const id = spotifyPlaylistId(link);
    if (!id) return { reason: 'notALink' };

    let html: string;
    try {
        const response = await fetchPage(spotifyEmbedUrl(id), { 'User-Agent': BROWSER_USER_AGENT });
        if (!response.ok) return { detail: String(response.status), reason: 'unavailable' };
        html = await response.text();
    } catch (error) {
        return {
            detail: error instanceof Error ? error.message : String(error),
            reason: 'network',
        };
    }

    try {
        return { playlist: parseSpotifyEmbed(html) };
    } catch (error) {
        if (error instanceof SpotifyEmbedError) {
            return { detail: error.message, reason: 'pageChanged' };
        }
        throw error;
    }
};

export const registerPlaylistImportHandlers = (): void => {
    ipcMain.handle('aoide:import-spotify', (_event, link: string) => fetchSpotifyPlaylist(link));
};
