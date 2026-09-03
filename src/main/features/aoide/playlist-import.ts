import type { ImportedPlaylist } from '/@/shared/aoide/playlist-import';

import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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

/**
 * Exportify, the open-source exporter (MIT, exportify.net), opened inside the
 * app so its file lands here instead of in Downloads.
 *
 * It cannot be folded in any further than this. It talks to Spotify through its
 * own registered application, whose sign-in redirect is pinned to its own
 * domain, and Spotify no longer grants new applications what that one was
 * granted years ago — so it has to *be* that page. What the app adds is the
 * catching: the CSV it saves is read here and handed straight to the import,
 * and Spotify's sign-in is remembered between visits.
 */
export const EXPORTIFY_URL = 'https://exportify.net';

export const isPlaylistCsvDownload = (filename: string): boolean => /\.csv$/i.test(filename);

/** Exportify saves "Road_Trip.csv" for a playlist called "Road Trip". */
export const playlistNameFromFilename = (filename: string): string =>
    filename
        .replace(/\.csv$/i, '')
        .replace(/_/g, ' ')
        .trim();

export interface CapturedCsv {
    name: string;
    text: string;
}

const openExportify = (askedBy: WebContents): void => {
    const window = new BrowserWindow({
        autoHideMenuBar: true,
        height: 760,
        title: 'Exportify',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            // Its own cookie jar, kept: the Spotify sign-in survives between
            // visits, and nothing of the app's session is exposed to the page.
            partition: 'persist:aoide-exportify',
            sandbox: true,
        },
        width: 1000,
    });

    // Spotify's sign-in page is happier not knowing this is Electron.
    window.webContents.setUserAgent(
        window.webContents.getUserAgent().replace(/ ?(Electron|aoide)\/\S+/gi, ''),
    );

    // Anything that wants a new window — a "learn more" link — goes to the real
    // browser. Sign-in navigates in place and needs no popup.
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    const session = window.webContents.session;
    const onDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
        const filename = item.getFilename();
        // "Export all" saves a zip; that one takes the ordinary save dialog.
        if (!isPlaylistCsvDownload(filename)) return;

        const path = join(app.getPath('temp'), `aoide-import-${Date.now()}-${filename}`);
        item.setSavePath(path);
        item.once('done', (_done, state) => {
            if (state !== 'completed') return;
            void (async () => {
                try {
                    const text = await readFile(path, 'utf8');
                    if (askedBy.isDestroyed()) return;
                    const file: CapturedCsv = { name: playlistNameFromFilename(filename), text };
                    askedBy.send('aoide:import-csv', file);
                    BrowserWindow.fromWebContents(askedBy)?.focus();
                } finally {
                    await unlink(path).catch(() => undefined);
                }
            })();
        });
    };

    session.on('will-download', onDownload);
    window.on('closed', () => session.removeListener('will-download', onDownload));
    void window.loadURL(EXPORTIFY_URL);
};

export const registerPlaylistImportHandlers = (): void => {
    ipcMain.handle('aoide:import-spotify', (_event, link: string) => fetchSpotifyPlaylist(link));
    ipcMain.handle('aoide:import-open-exportify', (event) => openExportify(event.sender));
};
