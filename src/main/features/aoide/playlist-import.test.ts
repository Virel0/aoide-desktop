import { describe, expect, it, vi } from 'vitest';

import {
    BROWSER_USER_AGENT,
    fetchSpotifyPlaylist,
    isPlaylistCsvDownload,
    playlistNameFromFilename,
    registerPlaylistImportHandlers,
} from './playlist-import';

const handle = vi.fn();
vi.mock('electron', () => ({
    app: { getPath: () => '/tmp' },
    BrowserWindow: vi.fn(),
    ipcMain: { handle: (...args: unknown[]) => handle(...args) },
    shell: { openExternal: vi.fn() },
}));

describe('catching what Exportify saves', () => {
    it('takes only the CSV; the zip from "export all" keeps the ordinary dialog', () => {
        expect(isPlaylistCsvDownload('Road_Trip.csv')).toBe(true);
        expect(isPlaylistCsvDownload('ROAD.CSV')).toBe(true);
        expect(isPlaylistCsvDownload('spotify_playlists.zip')).toBe(false);
    });

    it('turns the file name back into the playlist name', () => {
        expect(playlistNameFromFilename('Road_Trip.csv')).toBe('Road Trip');
        expect(playlistNameFromFilename('Liked_Songs.csv')).toBe('Liked Songs');
    });

    it('registers both channels the preload invokes', () => {
        registerPlaylistImportHandlers();
        const channels = handle.mock.calls.map((call) => call[0]);
        expect(channels).toEqual(['aoide:import-spotify', 'aoide:import-open-exportify']);
    });
});

const page = (tracks: string) =>
    `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"title":"Road Trip","trackList":[${tracks}]}}}}}}</script>`;

const respond = (status: number, body: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
});

describe('fetchSpotifyPlaylist', () => {
    it('reads the playlist off the embed page, introducing itself as a browser', async () => {
        const fetchPage = vi.fn(async () =>
            respond(200, page('{"title":"Karma Police","subtitle":"Radiohead","duration":264000}')),
        );

        const outcome = await fetchSpotifyPlaylist(
            'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x',
            fetchPage,
        );

        expect(outcome).toEqual({
            playlist: {
                isTruncated: false,
                name: 'Road Trip',
                tracks: [{ artists: ['Radiohead'], durationMs: 264_000, title: 'Karma Police' }],
            },
        });
        expect(fetchPage).toHaveBeenCalledWith(
            'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
            { 'User-Agent': BROWSER_USER_AGENT },
        );
    });

    it('does not ask at all for something that is not a playlist link', async () => {
        const fetchPage = vi.fn();
        expect(await fetchSpotifyPlaylist('hello', fetchPage)).toEqual({ reason: 'notALink' });
        expect(fetchPage).not.toHaveBeenCalled();
    });

    it('distinguishes a refused page from a changed one from no network', async () => {
        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () =>
                respond(404, ''),
            ),
        ).toEqual({ detail: '404', reason: 'unavailable' });

        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () =>
                respond(200, '<html>no state</html>'),
            ),
        ).toMatchObject({ reason: 'pageChanged' });

        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () => {
                throw new Error('offline');
            }),
        ).toEqual({ detail: 'offline', reason: 'network' });
    });
});
